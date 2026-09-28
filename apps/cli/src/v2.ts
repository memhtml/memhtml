import { join } from "node:path"

import type { HeadView, OverlayOp } from "@memhtml/contracts"
import {
  DirtyTree,
  InvalidMemory,
  type ModelUnavailable,
  StorageFailure
} from "@memhtml/contracts/errors"
import { isValidMemoryPath, memoryPathFor } from "@memhtml/contracts/paths"
import { filenameFor, slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import {
  type HeadVersion,
  recordFrom,
  type SearchHit,
  searchHead,
  vectorTextOf,
  withOverlay
} from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import {
  appendOps,
  type CommitOutcome,
  commitSession,
  DEFAULT_REF,
  LOG_MOVED,
  makePlumbing,
  rebaseSession,
  resumeSession,
  type Session,
  saveSession,
  startSession,
  touchedPaths,
  type Violation,
  validateOps
} from "@memhtml/session"
import { readSnapshot, snapshotPathFor } from "@memhtml/snapshot"
import { type GitFailure, isoSecond, makeGit, type WriteInput } from "@memhtml/store"
import { Effect } from "effect"
import type { EmbedderShape } from "./api-layer.js"
import type { SessionPutOp } from "./apply.js"
import type { ResponseType } from "./envelope.js"
import type { ExecLang } from "./exec-lang.js"
import {
  type HeadSource,
  loadVersion,
  type SnapshotWritten,
  snapshotAfterCommit,
  writeHeadSnapshot
} from "./head-cache.js"
import { ANSWER_TIMEOUT_MS, askHead, askHeadFor } from "./head-client.js"
import {
  type GateFailure,
  type GateOutcome,
  type GateReport,
  gateReportOf,
  headGate
} from "./head-gate.js"
import {
  EXEC_QUEUE_WAIT_MS,
  ExecAnswer,
  type ExecBase,
  type ExecOutcome,
  execRequestOf,
  type HeadServerStatus,
  HeadServerStatus as HeadServerStatusSchema,
  NeighborsAnswer,
  SearchAnswer,
  type SearchRequest,
  type ServedHead
} from "./head-protocol.js"
import {
  type CacheRead,
  embedHead,
  loadForSearch,
  type VectorUse,
  vectorsForPuts,
  vectorsForQuery
} from "./head-vectors.js"
import { toWriteInput } from "./operations.js"
import {
  commitSubjectOf,
  mergeBase,
  type Reconstruction,
  readCurateDelta,
  reconstructOps
} from "./replay.js"
import {
  effectiveTimeoutMs,
  runDeadlineMs,
  runSessionExec,
  type SessionExecRuntime
} from "./session-exec.js"

export type { GateReport } from "./head-gate.js"

/**
 * The v2 proof-of-concept commands (`docs/v2-poc.md`, "CLI commands"): `session start|put|exec|
 * commit|rebase|status`, `head status|search|snapshot|embed`, and the curation door `curate merge`.
 *
 * ## No app layer
 *
 * Every arm here resolves a repo root and reads git; none opens `index.db`. They are answered in
 * `run.ts` before the app layer is built, on the same path `exec` and `serve mcp` take, because
 * building `layerApp` would open and migrate a SQLite database no arm queries, on exactly the path an
 * agent reaches for while `memhtml serve mcp` holds that database. `DispatchServices` is the app
 * layer's service set, so nothing here can be reached through `dispatch`.
 *
 * ## Where the head comes from
 *
 * `head status`, `head search`, and `session put` ask the head server first (`head-server.ts`, over
 * `.memhtml/head.sock`), which holds the version loaded and follows its ref, and load locally when no
 * server answers or `--no-server` is set. Every other arm, and every local fallback, builds the
 * version it needs: from `.memhtml/snapshots/<sha>.arrow` when a snapshot exists for that commit,
 * else from the newest snapshot of an ancestor commit advanced over the changed paths, else from git,
 * and every payload that reports a head says which ({@link HeadStats}, `source: "server"` for the
 * first). `session commit` and the curate arms always load locally: they must judge the exact version
 * they commit against, and a commit's cost is not a lookup's. Every commit that moves a ref writes the
 * snapshot for the new sha (`head-cache.ts`), so the next call hits the cache. A session command loads the
 * head at the SESSION's base sha, not at the ref's tip, because a session sees exactly one version
 * plus its own deltas: `session commit` validates against that base and reports `rebase-needed`
 * whenever the ref has moved past it, and `session rebase` is the one arm that reloads at the ref's
 * tip and moves the base. Dedup and frame-key checks are judged at the base, so a commit lands only
 * when the ref still IS that base; the rebase-and-retry loop is what makes them fresh.
 */

/** Where a payload's head came from: one of the local load paths, or the head server. */
export type HeadStatsSource = HeadSource | "server"

/** What every head-loading payload reports about the version it built. */
export interface HeadStats {
  readonly sha: string
  readonly records: number
  /**
   * Files the git load skipped because they failed the parser. `null` when the head came from a
   * snapshot (exact or advanced), which holds records only and cannot say what the original load
   * left out.
   */
  readonly skipped: number | null
  /** The load's wall time, or under `server` the round trip to the server. */
  readonly loadMs: number
  /**
   * `snapshot` (this sha's own file), `snapshot+advance` (an ancestor's, advanced), `git`, or
   * `server` (the head server answered; nothing was loaded in this process).
   */
  readonly source: HeadStatsSource
  /** The snapshot file the head was read from (its own or the ancestor's), or `null` from git. */
  readonly snapshotPath: string | null
  /** Under `snapshot+advance`, the commit whose snapshot was advanced; otherwise `null`. */
  readonly ancestorSha: string | null
  /** Under `snapshot+advance`, the memory paths re-parsed to reach `sha`; otherwise `null`. */
  readonly reparsed: number | null
}

/** A loaded version plus what loading it cost. */
export interface LoadedHead extends HeadStats {
  readonly view: HeadVersion
  /** Always one of the local paths: a loaded head was loaded here. */
  readonly source: HeadSource
}

/** The `HeadStats` half of a loaded head, for a payload. */
export const headStats = (loaded: LoadedHead): HeadStats => ({
  sha: loaded.sha,
  records: loaded.records,
  skipped: loaded.skipped,
  loadMs: loaded.loadMs,
  source: loaded.source,
  snapshotPath: loaded.snapshotPath,
  ancestorSha: loaded.ancestorSha,
  reparsed: loaded.reparsed
})

/**
 * The `HeadStats` of an answer the head server gave: the version it answered over, and the round
 * trip as `loadMs`. The three snapshot fields are `null` because nothing was loaded here.
 */
export const servedStats = (head: ServedHead, ms: number): HeadStats => ({
  sha: head.sha,
  records: head.records,
  skipped: head.skipped,
  loadMs: ms,
  source: "server",
  snapshotPath: null,
  ancestorSha: null,
  reparsed: null
})

/**
 * Load the version at `sha` the cheapest way that exists (`head-cache.ts` `loadVersion`): its own
 * snapshot, else an ancestor's snapshot advanced over the changed paths, else git. `source: "git"`
 * forces the tree read.
 */
export const loadHeadAt = (
  root: string,
  sha: string,
  source: "auto" | "git" = "auto"
): Effect.Effect<LoadedHead, GitFailure | InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const started = Date.now()
    const loaded = yield* loadVersion(root, sha, source)
    return {
      view: loaded.version,
      sha,
      records: loaded.version.size,
      skipped: loaded.source === "git" ? loaded.version.skipped : null,
      loadMs: Date.now() - started,
      source: loaded.source,
      snapshotPath: loaded.snapshotPath,
      ancestorSha: loaded.ancestorSha,
      reparsed: loaded.reparsed
    }
  })

/** The commit a ref resolves to, or `null` when it does not. A repo with no such ref is an answer. */
export const revParse = (root: string, ref: string): Effect.Effect<string | null, GitFailure> =>
  makeGit(root)
    .run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    .pipe(
      Effect.map((out) => {
        const sha = out.trim()
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null
      }),
      // `--verify --quiet` exits 1 for a ref that does not resolve; that is "none", not a failure.
      Effect.catchTag("GitFailure", (failure) =>
        failure.exitCode === 1 ? Effect.succeed(null) : Effect.fail(failure)
      )
    )

/**
 * The commit a session starts from or rebases onto: the ref's tip when it resolves, else `HEAD`.
 *
 * A curator's `refs/heads/curate/<date>` does not exist until its first commit, and a session on it
 * still needs a base to see, so an unresolved ref falls back to the repository's `HEAD`. An unborn
 * repository has no version to build and is refused.
 */
const baseShaFor = (root: string, ref: string): Effect.Effect<string, GitFailure | InvalidMemory> =>
  Effect.gen(function* () {
    const sha = (yield* revParse(root, ref)) ?? (yield* makeGit(root).revParseHead())
    if (sha === null) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `${root} has no commit: a session needs a version to see, so an unborn HEAD cannot start one`
        })
      )
    }
    return sha
  })

/**
 * A branch name as a full ref: `curate/2026-09-23` becomes `refs/heads/curate/2026-09-23`, and a
 * name already under `refs/` is kept. Every v2 arm that takes a ref from the command line spells it
 * this way, so `session start --ref curate/x` and `curate merge curate/x` name the same branch.
 */
export const qualifyRef = (name: string): string => {
  const trimmed = name.trim()
  return trimmed.startsWith("refs/") ? trimmed : `refs/heads/${trimmed}`
}

/** `HEAD`'s commit, or the refusal an unborn repository earns. */
const headSha = (root: string): Effect.Effect<string, GitFailure | InvalidMemory> =>
  Effect.gen(function* () {
    const sha = yield* makeGit(root).revParseHead()
    if (sha === null) {
      return yield* Effect.fail(
        InvalidMemory.make({ reason: `${root} has no commit to build a head from` })
      )
    }
    return sha
  })

/**
 * The path a `put` lands at: the path the store would choose for the same write.
 *
 * `memoryPathFor` decides the directory and the filename. An explicit valid `path` is authoritative
 * and gets no collision suffix, exactly as the store treats one: a session's validator then reports
 * `claim-edit` or `duplicate` at commit if it is occupied, which is the session's spelling of the
 * store's `WriteConflict`. A derived path that the view or an earlier put in this batch already holds
 * takes the store's ordinal suffix (`-2`, `-3`, ...) so two ops sharing a title in one call cannot
 * silently become one file.
 */
const putPathFor = (
  view: HeadView,
  input: WriteInput,
  claimed: ReadonlySet<string>
): Effect.Effect<string, StorageFailure> => {
  const at = new Date(input.at)
  const first = memoryPathFor({ ...input, at })
  if (input.path !== undefined && isValidMemoryPath(input.path)) return Effect.succeed(first)
  const free = (candidate: string): boolean =>
    !claimed.has(candidate) && view.get(candidate) === undefined
  if (free(first)) return Effect.succeed(first)
  const directory = first.slice(0, first.lastIndexOf("/"))
  const base = slugify(input.title)
  const episodic = input.memoryType === "episodic"
  for (let ordinal = 2; ordinal <= 1000; ordinal += 1) {
    const candidate = `${directory}/${filenameFor({
      slug: withCollisionOrdinal(base, ordinal),
      episodic,
      at
    })}`
    if (free(candidate)) return Effect.succeed(candidate)
  }
  return Effect.fail(StorageFailure.make({ operation: "session.put.pathExhausted" }))
}

/** How many existing records `session put` reports beside each put, nearest first. */
const PUT_NEIGHBORS = 3

/** The violation kinds that make a put unlandable regardless of what the ref does next. */
const BLOCKING_VIOLATIONS: ReadonlySet<Violation["kind"]> = new Set([
  "format",
  "reserved-path",
  "batch-cap",
  "write-bar"
])

const describeViolation = (violation: Violation): string => {
  switch (violation.kind) {
    case "format":
      return `${violation.path}: ${violation.reasons.join("; ")}`
    case "reserved-path":
      return `${violation.path}: reserved path`
    case "batch-cap":
      return `${violation.count} ops exceeds the cap of ${violation.cap}`
    case "duplicate":
      return `${violation.path}: duplicate of ${violation.existing}`
    case "claim-edit":
      return `${violation.path}: claim edit`
    case "write-bar":
      return `${violation.path}: below the write bar: ${violation.reasons.join("; ")}`
  }
}

const opSummary = (op: OverlayOp) =>
  op.kind === "archive"
    ? { kind: op.kind, path: op.path, to: op.to }
    : { kind: op.kind, path: op.path }

/**
 * `session start`: a new session on the ref's tip (or `HEAD`), its index seeded from that tree. An
 * id that already has a log is refused (`session.exists`) unless `force` is set, so a retried start
 * cannot discard an overlay in progress; `session status` reads the existing one.
 */
export const sessionStart = (input: {
  readonly root: string
  readonly id: string
  readonly ref?: string | undefined
  readonly force?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const ref =
      input.ref === undefined || input.ref.trim() === "" ? DEFAULT_REF : qualifyRef(input.ref)
    const sha = yield* baseShaFor(input.root, ref)
    const head = yield* loadHeadAt(input.root, sha)
    const session = yield* startSession({
      root: input.root,
      id: input.id,
      base: head.view,
      ref,
      force: input.force
    })
    return {
      id: session.id,
      baseSha: session.baseSha,
      ref: session.ref,
      ops: session.ops.length,
      head: headStats(head)
    }
  })

/** What `session put` computes over a session's view before it appends. */
export interface PreparedPuts {
  /** Every op the call would append, in file order: the puts and the `label` and `unlabel` edits. */
  readonly appended: ReadonlyArray<OverlayOp>
  /** The puts alone, rendered the way the store would write them and placed at the paths it would choose. */
  readonly puts: ReadonlyArray<Extract<OverlayOp, { readonly kind: "put" }>>
  /** Per put, the records the view already holds nearest it; empty when the call is blocked. */
  readonly neighbors: ReadonlyArray<{
    readonly path: string
    readonly hits: ReadonlyArray<SearchHit>
  }>
  /** Every violation over the session's ops plus the new ones, judged against the base. */
  readonly violations: ReadonlyArray<Violation>
  /** The violations that refuse the call: a blocking kind at a path this call's ops touch. */
  readonly blocking: ReadonlyArray<Violation>
  /** The vector arm's report for the neighbors, or `null` when the call is blocked and ranked nothing. */
  readonly vector: VectorUse | null
}

/**
 * The head-dependent half of `session put`: place and render each write over the session's view
 * (`base` plus `sessionOps`), keep each `label` and `unlabel` line in file order beside the puts,
 * judge the whole log against `base` the way `commitSession` will, and, when nothing blocks, find
 * each put's nearest records with the vector arm when `cache` and `embedder` allow it. Pure over its
 * inputs, so the head server computes the same answer from the version at the session's base and
 * the cache it holds as a local load does from the cache file (`head-server.ts`).
 */
export const preparePuts = (input: {
  readonly base: HeadView
  readonly sessionOps: ReadonlyArray<OverlayOp>
  readonly lines: ReadonlyArray<SessionPutOp>
  readonly at: string
  /** The vector cache as this caller finds it: the file's for a CLI call, the held one for the server. */
  readonly cache: Effect.Effect<CacheRead>
  readonly embedder: EmbedderShape
}): Effect.Effect<PreparedPuts, InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const view = yield* withOverlay(input.base, input.sessionOps)
    const claimed = new Set<string>()
    /** Every path this call's ops touch, so only their violations can block the call. */
    const touched = new Set<string>()
    const appended: Array<OverlayOp> = []
    const puts: Array<Extract<OverlayOp, { readonly kind: "put" }>> = []
    const queries: Array<string> = []
    for (const line of input.lines) {
      if (line.op !== "write") {
        appended.push({ kind: line.op, path: line.path, entity: line.entity })
        touched.add(line.path)
        continue
      }
      const write = yield* toWriteInput(line.params, input.at)
      const path = yield* putPathFor(view, write, claimed)
      claimed.add(path)
      touched.add(path)
      const put = { kind: "put", path, html: renderTemplate(write) } as const
      puts.push(put)
      appended.push(put)
      queries.push(`${write.title} ${write.claim}`)
    }
    // Judged the way `commitSession` will judge them: every op of the session against the base.
    const violations = validateOps(input.base, [...input.sessionOps, ...appended])
    const blocking = violations.filter(
      (violation) =>
        BLOCKING_VIOLATIONS.has(violation.kind) &&
        (violation.kind === "batch-cap" || touched.has(violation.path))
    )
    // A blocked call appends nothing, so it pays for no embed.
    if (blocking.length > 0) {
      return { appended, puts, neighbors: [], violations, blocking, vector: null }
    }
    // Read before write: the records the view already holds nearest each put, so the writer can see
    // a near-duplicate it should skip or the records it should link to before it commits. The vector
    // arm joins when a cache and an embedder exist, with each put's own text embedded as a document.
    const records = yield* Effect.forEach(puts, (put) => recordFrom(put))
    const arm = yield* vectorsForPuts({
      cache: input.cache,
      view,
      texts: records.map(vectorTextOf),
      embedder: input.embedder
    })
    const neighbors = puts.map((put, index) => {
      const queryVector = arm.perPut?.[index]
      return {
        path: put.path,
        hits: searchHead(view, {
          query: queries[index] ?? "",
          limit: PUT_NEIGHBORS,
          ...(arm.vectors === null || queryVector === undefined
            ? {}
            : { vectors: arm.vectors, queryVector })
        })
      }
    })
    return { appended, puts, neighbors, violations, blocking, vector: arm.use }
  })

/**
 * `session put`: render each `write` op the way the store would, and append the puts, with every
 * `label` and `unlabel` line in the order the file gave them, to the log.
 *
 * The head server computes the ops, their neighbors, and the violations over the version at the
 * session's base when one answers ({@link preparePuts} on its side, with the vector cache it holds
 * and the embedder it bound); otherwise the base is loaded here and the cache read from its file.
 * Either way the append happens in this process, under the session's lock.
 *
 * Refused as a whole, appending nothing, when a new op carries a violation no rebase can cure
 * ({@link BLOCKING_VIOLATIONS}): a malformed file, a reserved path, a label that is not a
 * well-formed entity or is already carried, an unlabel of one the record lacks, or an unlabel that
 * leaves a record unanchored would make every later commit of this session `refused`, and the log
 * has no removal op. `duplicate` and `claim-edit` are reported, not refused, because they are
 * judged against the base the session currently sees and a rebase can change the answer either way.
 */
export const sessionPut = (input: {
  readonly root: string
  readonly id: string
  readonly ops: ReadonlyArray<SessionPutOp>
  readonly embedder: EmbedderShape
  readonly server?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const at = isoSecond(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const answered =
      input.server === false
        ? null
        : yield* askHead({
            root: input.root,
            route: "neighbors",
            schema: NeighborsAnswer,
            body: { sha: session.baseSha, ops: session.ops, lines: input.ops, at }
          })
    let prepared: PreparedPuts
    let head: HeadStats
    if (answered !== null) {
      prepared = answered.data
      head = servedStats(answered.data.head, answered.ms)
    } else {
      const loaded = yield* loadHeadAt(input.root, session.baseSha)
      prepared = yield* preparePuts({
        base: loaded.view,
        sessionOps: session.ops,
        lines: input.ops,
        at,
        cache: loadForSearch(input.root),
        embedder: input.embedder
      })
      head = headStats(loaded)
    }
    const { appended, puts, neighbors, violations, blocking } = prepared
    if (blocking.length > 0) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `session put refused, nothing appended: ${blocking.map(describeViolation).join(" | ")}`
        })
      )
    }
    const next = yield* appendOps(session, appended)
    return {
      id: session.id,
      baseSha: session.baseSha,
      /** Every op this call appended: the puts and the entity edits. */
      appended: appended.length,
      ops: next.ops.length,
      /** The paths the puts landed at, in input order. */
      paths: puts.map((put) => put.path),
      /** The `label` and `unlabel` ops this call appended, in input order. */
      labels: appended.flatMap((op) =>
        op.kind === "label" || op.kind === "unlabel"
          ? [{ kind: op.kind, path: op.path, entity: op.entity }]
          : []
      ),
      neighbors,
      vector: prepared.vector,
      violations,
      head
    }
  })

/** Why a clean harvest was not appended: another writer holds the session, or changed its log. */
const appendRefusal = (operation: string): string | null =>
  operation === LOG_MOVED
    ? "session log: another put, exec, commit, or rebase changed this session's log while the script ran, so the harvest (computed over the log as it was) was not appended; run the script again"
    : operation === "session.locked"
      ? "session log: another writer held this session's lock when the harvest was to be appended, so it was not; run the script again"
      : null

/**
 * The half of `session exec` that follows the head: overlay the session's ops on `base`, run the
 * script over that view, harvest, judge the log plus the harvest against `base`, and append the
 * harvest when it is clean. The CLI calls it with the version it loaded and the head server with the
 * version it holds (`head-server.ts`, `/v1/exec`), so the two answer with one function and cannot
 * drift; `runtime` is the only difference, and it changes where the script runs, never what the run
 * means.
 *
 * The harvest is appended only when the script exited 0 AND no harvested op carries a violation no
 * rebase can cure ({@link BLOCKING_VIOLATIONS}), judged the way `session put` judges its puts. A
 * script that threw halfway has left a tree it did not mean to leave, and one that wrote a malformed
 * file beside forty good ones has too; the log has no removal op, so appending either would poison
 * every later commit of the session. The harvest and its violations are still reported, so the
 * caller can see what a clean run would have taken.
 *
 * The append takes the session's lock and writes only over the log `session` was read from
 * (`appendOps`), so a put, exec, or commit that wrote the log while the script ran is never
 * overwritten: the harvest is left out instead and `blocking` says why.
 */
export const execOverHead = (input: {
  readonly session: Session
  readonly base: HeadView & { readonly sha: string }
  readonly script: string
  readonly lang: ExecLang
  readonly timeoutMs?: number | undefined
  readonly runtime?: SessionExecRuntime | undefined
}): Effect.Effect<ExecOutcome, InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const { session } = input
    const view = yield* withOverlay(input.base, session.ops)
    const report = yield* runSessionExec({
      view,
      script: input.script,
      lang: input.lang,
      timeoutMs: input.timeoutMs,
      ...input.runtime
    })
    const harvested = new Set(report.ops.flatMap(touchedPaths))
    const violations = validateOps(input.base, [...session.ops, ...report.ops])
    const blocking = violations.filter(
      (violation) =>
        BLOCKING_VIOLATIONS.has(violation.kind) &&
        (violation.kind === "batch-cap" || harvested.has(violation.path))
    )
    const clean = report.exitCode === 0 && blocking.length === 0
    const blocked = blocking.map(describeViolation)
    let next: Session = session
    let appended = 0
    if (clean && report.ops.length > 0) {
      const outcome = yield* appendOps(session, report.ops).pipe(
        Effect.map((written) => ({ written, refusal: null })),
        Effect.catchTag("StorageFailure", (failure) => {
          const refusal = appendRefusal(failure.operation)
          return refusal === null
            ? Effect.fail(failure)
            : Effect.succeed({ written: null, refusal })
        })
      )
      if (outcome.written !== null) {
        next = outcome.written
        appended = report.ops.length
      } else {
        blocked.push(outcome.refusal)
      }
    }
    return {
      id: session.id,
      baseSha: session.baseSha,
      /** The language the script ran as: `bash` unless `--lang js`. */
      lang: report.lang,
      corpusMount: report.corpusMount,
      sha: report.sha,
      exitCode: report.exitCode,
      stdout: report.stdout,
      stderr: report.stderr,
      durationMs: report.durationMs,
      timeoutMs: report.timeoutMs,
      timedOut: report.timedOut,
      /** Ops the harvester produced from the tree the script left. */
      ops: report.ops.length,
      /**
       * How many of those were appended to the log: all of them on exit 0 with no blocking
       * violation and a log nobody else changed meanwhile, none otherwise.
       */
      appended,
      /** The log's length after this call. */
      opsTotal: next.ops.length,
      harvested: report.ops.map(opSummary),
      rejected: report.rejected,
      /** Every violation over the session's ops plus the harvest, judged against the base. */
      violations,
      /** Why the harvest stayed out of the log: its blocking violations, described, or the log's refusal. */
      blocking: blocked
    }
  })

/**
 * Whether the head server ran a `session exec`: `used` with the version it ran over (`tip`, or an
 * `ancestor` it built from the tip), else why the exec ran here: `disabled` (`--no-server`),
 * `no-server` (no socket, nobody listening, no accept in time), `refused` (the server answered
 * another status, an older server without the route included), or the server's own `base-unservable`
 * or `busy`, with the detail.
 */
export interface ExecServerUse {
  readonly used: boolean
  readonly base: ExecBase | null
  readonly reason: "disabled" | "no-server" | "refused" | "base-unservable" | "busy" | null
  readonly detail: string | null
}

/**
 * How long `session exec` waits for the server's answer: the waits the server allows itself for the
 * session's earlier exec and for a worker ({@link EXEC_QUEUE_WAIT_MS} each), the run's own deadline,
 * and the lookup margin for loading the base and harvesting. The server answers within it or has
 * stopped answering at all, and only then does the client call the answer lost.
 */
export const execAnswerTimeoutMs = (lang: ExecLang, timeoutMs: number | undefined): number =>
  2 * EXEC_QUEUE_WAIT_MS + runDeadlineMs(lang, effectiveTimeoutMs(timeoutMs)) + ANSWER_TIMEOUT_MS

/**
 * `session exec`: run a script over head plus overlay and append what it wrote.
 *
 * The head server runs it when one answers (`/v1/exec`: the server reads the log, builds the version
 * at the session's base, runs the script in a worker, and appends), and the CLI runs it here when the
 * server did not take it: `--no-server`, no server, a refusal, or the server declining because the
 * base is neither its tip nor an ancestor of it, or because it stayed busy. Either way the payload is
 * {@link execOverHead}'s, with `head` saying where the version came from (`source: "server"` when the
 * server ran it) and `server` saying whether and why ({@link ExecServerUse}).
 *
 * One case is not a fallback. When the server took the request and no usable answer came back (the
 * answer timeout, a reset connection, a 200 this client cannot read), the server may have appended
 * the harvest, and running the script again here could append it twice, so the call fails naming
 * `session status` instead.
 */
export const sessionExec = (input: {
  readonly root: string
  readonly id: string
  readonly script: string
  readonly lang: ExecLang
  readonly timeoutMs?: number | undefined
  readonly server?: boolean | undefined
}) =>
  Effect.gen(function* () {
    let server: ExecServerUse = { used: false, base: null, reason: "disabled", detail: null }
    if (input.server !== false) {
      const asked = yield* askHeadFor({
        root: input.root,
        route: "exec",
        schema: ExecAnswer,
        body: execRequestOf(input),
        answerTimeoutMs: execAnswerTimeoutMs(input.lang, input.timeoutMs)
      })
      switch (asked.kind) {
        case "answered": {
          const answer = asked.data
          if (answer.served) {
            return {
              ...answer.outcome,
              head: servedStats(answer.head, asked.ms),
              server: { used: true, base: answer.base, reason: null, detail: null }
            }
          }
          server = { used: false, base: null, reason: answer.reason, detail: answer.detail }
          break
        }
        case "no-server":
          server = { used: false, base: null, reason: "no-server", detail: asked.detail }
          break
        case "refused":
          server = {
            used: false,
            base: null,
            reason: "refused",
            detail: `${String(asked.status)}: ${asked.body.slice(0, 300)}`
          }
          break
        case "lost":
          return yield* Effect.fail(
            StorageFailure.make({
              operation: `session exec: the head server took the script and gave no usable answer (${asked.detail.slice(0, 200)}); it may have appended the harvest, so the script was not run again here; read \`memhtml session status --id ${input.id}\` before running it again`
            })
          )
      }
    }
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const head = yield* loadHeadAt(input.root, session.baseSha)
    const outcome = yield* execOverHead({
      session,
      base: head.view,
      script: input.script,
      lang: input.lang,
      timeoutMs: input.timeoutMs
    })
    return { ...outcome, head: headStats(head), server }
  })

/**
 * `session commit`: the commit algorithm against the session's base. `rebase-needed` is returned,
 * not retried: the caller decides whether to `session rebase` and try again, because a rebase can
 * turn the outcome into `refused` and that is a decision, not a retry. When `HEAD` is the session's
 * ref, the shared index and working tree follow the commit (`worktreeSynced`), or the commit is
 * `worktree-dirty` and nothing moves. A `committed` outcome also writes the snapshot for the new
 * commit (`snapshot`, `null` when that best-effort write failed), so the next load hits the cache.
 */
export const sessionCommit = (input: {
  readonly root: string
  readonly id: string
  readonly message: string
}) =>
  Effect.gen(function* () {
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const head = yield* loadHeadAt(input.root, session.baseSha)
    const outcome: CommitOutcome = yield* commitSession({
      session,
      head: head.view,
      message: input.message
    })
    const snapshot: SnapshotWritten | null =
      outcome.kind === "committed"
        ? yield* snapshotAfterCommit(input.root, outcome.sha, head.view)
        : null
    return { id: session.id, ref: session.ref, baseSha: session.baseSha, ...outcome, snapshot }
  })

/** `session rebase`: move the base to the ref's tip, keeping every op. Validation is the next commit's. */
export const sessionRebase = (input: { readonly root: string; readonly id: string }) =>
  Effect.gen(function* () {
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const sha = yield* baseShaFor(input.root, session.ref)
    const head = yield* loadHeadAt(input.root, sha)
    const rebased = rebaseSession(session, head.view)
    yield* saveSession(rebased)
    return {
      id: session.id,
      ref: session.ref,
      from: session.baseSha,
      baseSha: rebased.baseSha,
      moved: rebased.baseSha !== session.baseSha,
      ops: rebased.ops.length,
      head: headStats(head)
    }
  })

/** `session status`: the log as persisted, plus where the ref is relative to the base. */
export const sessionStatus = (input: { readonly root: string; readonly id: string }) =>
  Effect.gen(function* () {
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const refSha = yield* revParse(input.root, session.ref)
    const count = (kind: OverlayOp["kind"]): number =>
      session.ops.filter((op) => op.kind === kind).length
    return {
      id: session.id,
      ref: session.ref,
      baseSha: session.baseSha,
      /** The ref's current commit, or `null` when it does not exist yet. */
      refSha,
      /** True when the ref has moved past the base, so a commit may need a rebase. */
      behind: refSha !== null && refSha !== session.baseSha,
      ops: session.ops.length,
      puts: count("put"),
      archives: count("archive"),
      links: count("link"),
      unlinks: count("unlink"),
      labels: count("label"),
      unlabels: count("unlabel"),
      paths: [...new Set(session.ops.flatMap(touchedPaths))].sort(),
      /** A commit built and possibly landed by a call that was killed; the next commit settles it. */
      pending: session.pending ?? null
    }
  })

/**
 * `head status`: the head server's status when one answers (its version, ref, load, advances, and
 * vector cache under `server`), else build the version at `HEAD` here and report what that cost and
 * where it came from, with `server: null`.
 */
export const headStatus = (input: {
  readonly root: string
  readonly server?: boolean | undefined
}): Effect.Effect<
  HeadStats & { readonly server: HeadServerStatus | null },
  GitFailure | InvalidMemory | StorageFailure
> =>
  Effect.gen(function* () {
    if (input.server !== false) {
      const answered = yield* askHead({
        root: input.root,
        route: "status",
        schema: HeadServerStatusSchema
      })
      if (answered !== null) {
        const status = answered.data
        return {
          ...servedStats(
            { sha: status.sha, ref: status.ref, records: status.records, skipped: status.skipped },
            answered.ms
          ),
          server: status
        }
      }
    }
    const sha = yield* headSha(input.root)
    return { ...headStats(yield* loadHeadAt(input.root, sha)), server: null }
  })

/**
 * `head search`: RRF over the version at `HEAD`, lexical plus recency, plus the vector arm when the
 * store has a vector cache and an embedder is configured. The query is embedded with `embedQuery`;
 * when the arm cannot run (`MEMHTML_EMBED=off`, no cache, an unreadable cache, a failed query embed)
 * the search runs on the other two and `vector` says why, never failing the call.
 *
 * The head server answers when one runs, over its version of its ref, with the cache it holds and
 * the embedder it bound, and the payload has the same fields either way; only `head.source` says
 * which path answered. The search input goes to the server as one object, the same object
 * `searchHead` takes, so an option it gains later travels without a protocol change.
 */
export const headSearch = (input: {
  readonly root: string
  readonly query: string
  readonly limit?: number | undefined
  readonly embedder: EmbedderShape
  readonly server?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const search: SearchRequest = {
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }
    if (input.server !== false) {
      const answered = yield* askHead({
        root: input.root,
        route: "search",
        schema: SearchAnswer,
        body: search
      })
      if (answered !== null) {
        const { vector, searchMs } = answered.data
        const hits: ReadonlyArray<SearchHit> = answered.data.hits
        return {
          query: input.query,
          hits,
          vector,
          searchMs,
          head: servedStats(answered.data.head, answered.ms)
        }
      }
    }
    const sha = yield* headSha(input.root)
    const head = yield* loadHeadAt(input.root, sha)
    const arm = yield* vectorsForQuery({
      cache: loadForSearch(input.root),
      view: head.view,
      query: input.query,
      embedder: input.embedder
    })
    const started = performance.now()
    const hits: ReadonlyArray<SearchHit> = searchHead(head.view, { ...search, ...arm.search })
    // Hundredths: the fold takes a few milliseconds, so whole milliseconds would read as 0 to 12.
    const searchMs = Math.round((performance.now() - started) * 100) / 100
    return { query: input.query, hits, vector: arm.use, searchMs, head: headStats(head) }
  })

/**
 * `head embed`: fill `.memhtml/vectors/<model>@<dim>.arrow` for the version at `HEAD`, embedding
 * only the active records whose content hash the cache lacks.
 */
export const headEmbed = (input: { readonly root: string; readonly embedder: EmbedderShape }) =>
  Effect.gen(function* () {
    const sha = yield* headSha(input.root)
    const head = yield* loadHeadAt(input.root, sha)
    const embedded = yield* embedHead({
      root: input.root,
      view: head.view,
      embedder: input.embedder
    })
    return { sha, ...embedded, head: headStats(head) }
  })

/**
 * `head snapshot`: `--write` builds the version at `HEAD` from git (never from a snapshot, so a
 * stale file cannot re-cache itself) and writes `.memhtml/snapshots/<sha>.arrow`; `--read` opens
 * that file and reports its row count and the sha its metadata names.
 */
export const headSnapshot = (input: { readonly root: string; readonly mode: "write" | "read" }) =>
  Effect.gen(function* () {
    const sha = yield* headSha(input.root)
    const path = snapshotPathFor(input.root, sha)
    if (input.mode === "write") {
      const head = yield* loadHeadAt(input.root, sha, "git")
      const written = yield* writeHeadSnapshot(input.root, head.view)
      return {
        mode: "write" as const,
        sha,
        path,
        bytes: written.bytes,
        rows: written.rows,
        ms: written.ms,
        pruned: written.pruned
      }
    }
    const snapshot = yield* readSnapshot(path)
    return { mode: "read" as const, sha: snapshot.sha, path, rows: snapshot.records.length }
  })

/** What `curate merge` reports about a landing that was not a fast-forward. */
export interface ReplayReport {
  /** The merge base of the curate ref and the target: the version the curator's ops were minted on. */
  readonly base: string
  /** The reconstructed log by kind. */
  readonly ops: {
    readonly put: number
    readonly archive: number
    readonly link: number
    readonly unlink: number
    readonly label: number
    readonly unlabel: number
  }
  /** How many `commitSession` calls the landing took; more than one means the target moved meanwhile. */
  readonly attempts: number
  /** The curate ref's commit before the landing moved it to the landed one. */
  readonly originalTip: string
}

/** What `curate merge` answers when the target moved. */
export interface CurateMerged {
  readonly ref: string
  readonly into: string
  /** The target's commit before the landing. */
  readonly from: string
  /**
   * The target's commit after the landing: the curator branch's tip on a fast-forward, the replayed
   * commit otherwise (and the curate ref is moved to it).
   */
  readonly to: string
  /** False when `from` already equaled `to`: nothing to land, nothing moved. */
  readonly moved: boolean
  readonly gate: GateReport
  /** True when HEAD is `into` and the shared index and working tree followed the ref. */
  readonly worktreeSynced: boolean
  /** `null` on a fast-forward; the replay's account when the target had moved past the curator's base. */
  readonly replayed: ReplayReport | null
  /** The snapshot written for `to` after the landing, or `null` when nothing moved or the write failed. */
  readonly snapshot: SnapshotWritten | null
}

/**
 * The index file the merge's plumbing is built with. A fast-forward never reads or writes a session
 * index (it moves a ref between two commits that already exist), so the file is never created; the
 * plumbing wants a path because a session's commit path does. A replay stages through its own
 * session's index, not this one.
 */
const MERGE_INDEX_FILE = "curate-merge.idx"

/** How many `rebase-needed` answers a replay tolerates before it gives up; `curate-run.ts` uses the same bound. */
export const MERGE_ATTEMPTS = 8

/** The scope a replay validates and commits under: the curator's, so arcs and people paths land. */
const MERGE_SCOPE = "curate" as const

const shortSha = (sha: string): string => sha.slice(0, 7)

/** The reconstructed log for a curate ref, or the refusal a hand-written change on it earns. */
const replayPlan = (input: {
  readonly root: string
  readonly ref: string
  readonly into: string
  readonly from: string
  readonly to: string
}): Effect.Effect<
  { readonly base: string; readonly reconstruction: Reconstruction },
  GitFailure | InvalidMemory
> =>
  Effect.gen(function* () {
    const base = yield* mergeBase(input.root, input.from, input.to)
    if (base === null) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${input.ref} (${input.to}) and ${input.into} (${input.from}) share no history, so there is no base to replay from`
        })
      )
    }
    const delta = yield* readCurateDelta(input.root, base, input.to)
    const reconstruction = reconstructOps({
      before: delta.before,
      after: delta.after,
      scope: MERGE_SCOPE
    })
    const rejected = [...delta.unsupported, ...reconstruction.rejected]
    if (rejected.length > 0) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${input.ref} carries a change since its base ${shortSha(base)} that is not a session operation, so it cannot be replayed onto ${input.into}; nothing moved: ${rejected.map((entry) => `${entry.path}: ${entry.reason}`).join(" | ")}`
        })
      )
    }
    return { base, reconstruction }
  })

/**
 * `curate merge`: land a curator branch on its target (`docs/v2-poc.md`, "Curation door").
 *
 * The order is refusals first, gate second, movement last, so a call that fails leaves the
 * repository exactly as it found it:
 *
 * 1. Both refs must resolve. When `ref` is a descendant of `into` (`merge-base --is-ancestor`) the
 *    landing is a fast-forward. When it is not, because `into` moved past the curator's base, the
 *    landing is a REPLAY: the curator's log is rebuilt from the trees at the merge base and at the
 *    ref's tip ({@link reconstructOps}), a fresh session is started on `into` at its tip with those
 *    ops, and `validateOps` judges them under the `curate` scope against that tip. A change on the
 *    ref that is not an operation (an article edited in place, a file deleted with no archive twin,
 *    a title or a meta other than an entity changed) refuses the merge naming the path, and so
 *    does any violation (a `duplicate` or `claim-edit` because `into` gained the same fact
 *    meanwhile, a link whose target is gone), with nothing moved.
 * 2. The head gate (`head-gate.ts`): the version at `into`'s tip and the version at `ref`'s tip
 *    are loaded and `gateHeads` scores the same probes at both, so the gate measures the corpus
 *    being landed and nothing else, with no network call and no credential. A failing gate fails
 *    this effect with the gate's numbers, and nothing has moved yet. `skipGate` is a logged
 *    override, and the report says the gate did not run.
 * 3. Fast-forward: when HEAD is `into`, the checkout follows BEFORE the ref moves, the way
 *    `commitSession` does it: a dirty path among those the landing changes is `DirtyTree` and
 *    nothing moves; otherwise `read-tree -m -u from to` brings the shared index and working tree to
 *    the new tree. Then `update-ref into to from` as a compare-and-swap; a `raced` answer means
 *    another writer advanced `into` between step 1 and now, the checkout is rolled back, and the
 *    call refuses.
 * 4. Replay: `commitSession` under the `curate` scope, with the subject
 *    `memhtml(curate): <the ref's tip subject> (replayed onto <short sha>)`, through a
 *    rebase-and-retry loop bounded at {@link MERGE_ATTEMPTS}: `rebase-needed` reloads the head at
 *    the new tip and tries again, `refused` after a rebase surfaces the violations, `worktree-dirty`
 *    is `DirtyTree`. The commit path does the compare-and-swap and syncs the checkout when HEAD is
 *    `into`. Once landed, the curate ref is moved to the landed commit (compare-and-swap against
 *    its old tip), so the ref now descends from `into` and a re-run answers `moved: false`.
 *
 * `gate` is injectable so a test can drive a failing gate without an eval corpus that fails; the
 * default is the real one.
 */
export const curateMerge = (input: {
  readonly root: string
  readonly ref: string
  readonly into?: string | undefined
  readonly skipGate?: boolean | undefined
  readonly gate?: Effect.Effect<GateOutcome, GateFailure> | undefined
}): Effect.Effect<
  CurateMerged,
  GitFailure | InvalidMemory | StorageFailure | DirtyTree | GateFailure
> =>
  Effect.gen(function* () {
    const ref = qualifyRef(input.ref)
    const into = qualifyRef(input.into ?? "main")
    const git = makePlumbing({
      root: input.root,
      indexFile: join(input.root, ".memhtml", "sessions", MERGE_INDEX_FILE)
    })

    const to = yield* git.revParse(ref)
    if (to === null) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${ref} does not exist, so there is nothing to land`
        })
      )
    }
    const from = yield* git.revParse(into)
    if (from === null) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${into} does not exist, so there is no branch to fast-forward`
        })
      )
    }
    const fastForward = yield* git.isAncestor(from, to)

    // A replay's refusals come before the gate: the log is rebuilt and judged against `into`'s tip
    // here, so a hand-written change or a collision costs no gate run and moves nothing.
    let replay: { readonly base: string; readonly reconstruction: Reconstruction } | null = null
    let session: Session | null = null
    let head: LoadedHead | null = null
    if (!fastForward) {
      replay = yield* replayPlan({ root: input.root, ref, into, from, to })
      head = yield* loadHeadAt(input.root, from)
      session = yield* startSession({
        root: input.root,
        id: `merge-${shortSha(to)}`,
        base: head.view,
        ref: into,
        force: true
      })
      session = yield* appendOps(session, replay.reconstruction.ops)
      const violations = validateOps(head.view, session.ops, { scope: MERGE_SCOPE })
      if (violations.length > 0) {
        return yield* Effect.fail(
          InvalidMemory.make({
            reason: `curate merge: replaying ${ref} onto ${into} (${shortSha(from)}) was refused, nothing moved: ${violations.map(describeViolation).join(" | ")}`
          })
        )
      }
    }

    let gate: GateReport = { ran: false, passed: null }
    if (input.skipGate === true) {
      yield* Effect.logWarning(
        `curate merge --skip-gate: landing ${ref} on ${into} without running discrimination`
      )
    } else {
      const outcome = yield* input.gate ??
        headGate({ root: input.root, from, to, load: loadHeadAt })
      gate = gateReportOf(outcome)
    }

    if (replay !== null && session !== null && head !== null) {
      return yield* landReplay({
        root: input.root,
        ref,
        into,
        to,
        gate,
        session,
        head,
        base: replay.base,
        reconstruction: replay.reconstruction
      })
    }

    if (from === to) {
      return {
        ref,
        into,
        from,
        to,
        moved: false,
        gate,
        worktreeSynced: false,
        replayed: null,
        snapshot: null
      }
    }

    const checkedOut = (yield* git.headRef()) === into
    if (checkedOut) {
      const paths = yield* git.diffTreePaths(from, to)
      const dirty = yield* git.dirtyPaths(paths)
      if (dirty.length > 0) return yield* Effect.fail(DirtyTree.make({ paths: dirty }))
      yield* git.readTreeIntoWorktree(from, to)
    }

    const swapped = yield* git.updateRef(into, to, from)
    if (swapped === "raced") {
      if (checkedOut) {
        yield* git
          .readTreeIntoWorktree(to, from)
          .pipe(Effect.catch(() => Effect.logWarning("curate merge: checkout not rolled back")))
      }
      const moved = yield* git.revParse(into)
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${into} moved from ${from} to ${moved ?? "an unresolved commit"} while the gate ran; nothing was landed, re-run to judge ${ref} against the new tip`
        })
      )
    }

    // The landing moved `into` to `to`: cache that version so the next load of main hits it.
    const snapshot = yield* snapshotAfterCommit(input.root, to)
    return {
      ref,
      into,
      from,
      to,
      moved: true,
      gate,
      worktreeSynced: checkedOut,
      replayed: null,
      snapshot
    }
  })

/**
 * Step 4 of {@link curateMerge}: land the replay session through `commitSession`, rebasing on
 * `rebase-needed` up to {@link MERGE_ATTEMPTS} times, then move the curate ref to the landed commit.
 */
const landReplay = (input: {
  readonly root: string
  readonly ref: string
  readonly into: string
  readonly to: string
  readonly gate: GateReport
  readonly session: Session
  readonly head: LoadedHead
  readonly base: string
  readonly reconstruction: Reconstruction
}): Effect.Effect<CurateMerged, GitFailure | InvalidMemory | StorageFailure | DirtyTree> =>
  Effect.gen(function* () {
    const subject = yield* commitSubjectOf(input.root, input.to)
    const archivedAt = input.reconstruction.archivedAt ?? undefined
    let session = input.session
    let head = input.head
    for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt += 1) {
      const outcome: CommitOutcome = yield* commitSession({
        session,
        head: head.view,
        message: `${subject} (replayed onto ${shortSha(head.sha)})`,
        archivedAt,
        scope: MERGE_SCOPE
      })
      switch (outcome.kind) {
        case "committed": {
          const git = makePlumbing({
            root: input.root,
            indexFile: join(input.root, ".memhtml", "sessions", MERGE_INDEX_FILE)
          })
          // The curate ref follows the landing so it descends from `into` again. A `raced` answer
          // means the curator committed again meanwhile; the landing stands, and the new tip is a
          // fresh curation to judge on its own.
          const followed = yield* git.updateRef(input.ref, outcome.sha, input.to)
          if (followed === "raced") {
            yield* Effect.logWarning(
              `curate merge: ${input.ref} moved past ${input.to} while its replay landed as ${outcome.sha}; the ref was left where its writer put it`
            )
          }
          // The landing moved `into` to the replayed commit: cache that version, best-effort, the
          // way the fast-forward path does.
          const snapshot = yield* snapshotAfterCommit(input.root, outcome.sha, head.view)
          return {
            ref: input.ref,
            into: input.into,
            from: head.sha,
            to: outcome.sha,
            moved: true,
            gate: input.gate,
            worktreeSynced: outcome.worktreeSynced,
            replayed: {
              base: input.base,
              ops: input.reconstruction.counts,
              attempts: attempt,
              originalTip: input.to
            },
            snapshot
          }
        }
        case "rebase-needed": {
          head = yield* loadHeadAt(input.root, outcome.mainSha)
          session = rebaseSession(session, head.view)
          yield* saveSession(session)
          break
        }
        case "refused":
          return yield* Effect.fail(
            InvalidMemory.make({
              reason: `curate merge: replaying ${input.ref} onto ${input.into} (${shortSha(head.sha)}) was refused after ${input.into} moved, nothing moved: ${outcome.violations.map(describeViolation).join(" | ")}`
            })
          )
        case "worktree-dirty":
          return yield* Effect.fail(DirtyTree.make({ paths: outcome.paths }))
      }
    }
    return yield* Effect.fail(
      InvalidMemory.make({
        reason: `curate merge: ${input.into} moved ${String(MERGE_ATTEMPTS)} times while ${input.ref} was replayed onto it; nothing landed, re-run to try again`
      })
    )
  })

/** What `run.ts` hands each arm, already decoded from argv. */
export interface V2Input {
  readonly root: string
  readonly id: string
  readonly ref?: string | undefined
  readonly force: boolean
  readonly message: string
  readonly script: string
  /** `session exec`'s `--lang`, `bash` when the flag is absent. */
  readonly lang: ExecLang
  readonly timeoutMs?: number | undefined
  readonly query: string
  readonly limit?: number | undefined
  readonly snapshotMode: "write" | "read"
  readonly ops: ReadonlyArray<SessionPutOp>
  /** `curate merge`'s positional: the curator branch. */
  readonly target: string
  readonly into?: string | undefined
  readonly skipGate: boolean
  /** The embedder `head search`, `head embed`, and `session put` use; both ports absent when off. */
  readonly embedder: EmbedderShape
  /** False under `--no-server`: `head status`, `head search`, and `session put` load locally. */
  readonly server: boolean
}

/** One arm per command, each returning its response type beside its payload. */
export const runV2 = (
  command: string,
  input: V2Input
): Effect.Effect<
  readonly [ResponseType, unknown],
  GitFailure | InvalidMemory | StorageFailure | DirtyTree | GateFailure | ModelUnavailable
> => {
  switch (command) {
    case "session start":
      return sessionStart(input).pipe(Effect.map((data) => ["session.started", data] as const))
    case "session put":
      return sessionPut(input).pipe(Effect.map((data) => ["session.appended", data] as const))
    case "session exec":
      return sessionExec(input).pipe(Effect.map((data) => ["session.exec.report", data] as const))
    case "session commit":
      return sessionCommit(input).pipe(Effect.map((data) => ["session.committed", data] as const))
    case "session rebase":
      return sessionRebase(input).pipe(Effect.map((data) => ["session.rebased", data] as const))
    case "session status":
      return sessionStatus(input).pipe(Effect.map((data) => ["session.status", data] as const))
    case "head status":
      return headStatus(input).pipe(Effect.map((data) => ["head.status", data] as const))
    case "head search":
      return headSearch(input).pipe(Effect.map((data) => ["head.search", data] as const))
    case "head embed":
      return headEmbed(input).pipe(Effect.map((data) => ["head.embedded", data] as const))
    case "head snapshot":
      return headSnapshot({ root: input.root, mode: input.snapshotMode }).pipe(
        Effect.map((data) => ["head.snapshot", data] as const)
      )
    case "curate merge":
      return curateMerge({
        root: input.root,
        ref: input.target,
        into: input.into,
        skipGate: input.skipGate
      }).pipe(Effect.map((data) => ["curate.merged", data] as const))
    default:
      return Effect.fail(InvalidMemory.make({ reason: `no v2 arm for ${command}` }))
  }
}

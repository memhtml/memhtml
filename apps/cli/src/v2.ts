import { access, appendFile } from "node:fs/promises"
import { join } from "node:path"

import type { HeadView, OverlayOp, WriteBarPolicy } from "@memhtml/contracts"
import {
  DirtyTree,
  InvalidMemory,
  type ModelUnavailable,
  StorageFailure,
  type StoreConfigInvalid
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
  type CommitScope,
  commitSession,
  DEFAULT_REF,
  LOG_MOVED,
  landOnRef,
  makePlumbing,
  pruneSessions,
  rebaseSession,
  replaceOps,
  resumeSession,
  SESSIONS_DIR,
  type Session,
  saveSession,
  sessionStateFile,
  startSession,
  touchedPaths,
  type Violation,
  validateOps,
  withRepoints
} from "@memhtml/session"
import { readSnapshot, snapshotPathFor } from "@memhtml/snapshot"
import { type GitFailure, isoSecond, makeGit, type WriteInput } from "@memhtml/store"
import { Effect } from "effect"
import ms from "ms"
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
import { ANSWER_TIMEOUT_MS, type Asked, askHead, askHeadFor } from "./head-client.js"
import {
  type GateFailure,
  type GateOutcome,
  type GateReport,
  gateReportOf,
  headGate
} from "./head-gate.js"
import {
  COMMIT_DEADLINE_DEFAULT_MS,
  COMMIT_DEADLINE_VAR,
  CommitAnswer,
  type CommitBase,
  type CommitDeclined,
  type CommitResult,
  commitRequestOf,
  EMBED_DEADLINE_DEFAULT_MS,
  EXEC_QUEUE_WAIT_MS,
  ExecAnswer,
  type ExecBase,
  type ExecOutcome,
  execRequestOf,
  type HeadServerStatus,
  HeadServerStatus as HeadServerStatusSchema,
  NeighborsAnswer,
  RebaseAnswer,
  type RebaseResult,
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
import { loadStorePolicy, type PolicySource, policySourceOf } from "./store-config.js"

export type { GateReport } from "./head-gate.js"

/**
 * The v2 commands (`docs/design.md` §15, "The command families"): `session start|put|exec|
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
 * `head status`, `head search`, `session put`, `session exec`, `session commit`, and `session rebase`
 * ask the head server first (`head-server.ts`, over `.memhtml/head.sock`), which holds the version
 * loaded and follows its ref, and load locally when no server answers or `--no-server` is set. Every
 * other arm, and every local fallback, builds the version it needs: from
 * `.memhtml/snapshots/<sha>.arrow` when a snapshot exists for that commit, else from the newest
 * snapshot of an ancestor commit advanced over the changed paths, else from git, and every payload
 * that reports a head says which ({@link HeadStats}, `source: "server"` for the first). A commit
 * through the server runs the same function a local one runs ({@link commitOverHead}) over the
 * version the server judged it against, so the commit path's compare-and-swap covers exactly that
 * version either way. The curate arms always load locally. Every commit that moves a ref writes the
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

/**
 * What blocks a put or an exec in a run-bound session (its id from `MEMHTML_SESSION`): the kinds
 * above plus `duplicate` and `claim-edit`. Outside a run those two are reported and left to the
 * caller, because a rebase can change the answer either way. Inside a run the caller is an agent
 * whose session is committed for it once the run ends, and one such op in the log refused the whole
 * commit (2026-09-28): every record the run wrote was lost for one repeated fact. So the op is
 * refused while the agent can still read why, judged against the session's base like every other
 * kind, and the run's log only ever holds ops that landed clean when they were written.
 */
const RUN_BOUND_BLOCKING_VIOLATIONS: ReadonlySet<Violation["kind"]> = new Set([
  ...BLOCKING_VIOLATIONS,
  "duplicate",
  "claim-edit"
])

const blockingKinds = (runBound: boolean | undefined): ReadonlySet<Violation["kind"]> =>
  runBound === true ? RUN_BOUND_BLOCKING_VIOLATIONS : BLOCKING_VIOLATIONS

const describeViolation = (violation: Violation): string => {
  switch (violation.kind) {
    case "format":
      return `${violation.path}: ${violation.reasons.join("; ")}`
    case "reserved-path":
      return `${violation.path}: reserved path`
    case "batch-cap":
      return `${violation.count} ops exceeds the cap of ${violation.cap}`
    case "duplicate":
      return `${violation.path}: duplicate of ${violation.existing}, which already holds this article; search before writing and skip it, or link to ${violation.existing}`
    case "claim-edit":
      return `${violation.path}: an active record already holds this path with a different article; a record's claim is never edited in place, so write the new fact under its own title (and link it with memhtml-supersedes when it replaces the old one)`
    case "write-bar":
      return `${violation.path}: below the write bar: ${violation.reasons.join("; ")}`
  }
}

const opSummary = (op: OverlayOp) =>
  op.kind === "archive" || op.kind === "move"
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

/** How long a first use waits for a concurrent first use of the same id to finish starting it. */
const IMPLICIT_START_WAIT_MS = 5_000
const IMPLICIT_START_POLL_MS = 25

const logExists = (root: string, id: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(sessionStateFile(root, id)).then(
      () => true,
      () => false
    )
  )

/**
 * The implicit start behind `MEMHTML_SESSION`: when `session put` or `session exec` takes its id
 * from the variable and the session has no log yet, start it on `refs/heads/main`'s tip (or `HEAD`
 * when there is no main), exactly as `session start --id <id>` would, and answer whether this call
 * started it. A log that exists is left alone, so every later use in the run resumes it.
 *
 * Cheap on purpose: `startSession` reads only the base's sha, so this is one `rev-parse` and one
 * `read-tree` into the session's index file, with no head load. An agent runtime can hand every
 * subprocess of a run the variable and open nothing up front, and a run that never writes leaves
 * no session behind.
 *
 * Two first uses at once (two subagents of one run) both find no log. One takes the session's lock
 * and writes it; the other fails with `session.locked` or, a moment later, `session.exists`, and both
 * mean the session is being started or is started. That caller waits for the log to appear (up to
 * {@link IMPLICIT_START_WAIT_MS}) and goes on with it, so neither call fails and neither log is
 * replaced.
 */
export const ensureSession = (input: { readonly root: string; readonly id: string }) =>
  Effect.gen(function* () {
    if (yield* logExists(input.root, input.id)) return false
    const sha = yield* baseShaFor(input.root, DEFAULT_REF)
    const started = yield* startSession({
      root: input.root,
      id: input.id,
      base: { sha },
      ref: DEFAULT_REF
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error): error is StorageFailure =>
          error._tag === "StorageFailure" &&
          (error.operation === "session.exists" || error.operation === "session.locked"),
        () => Effect.succeed(false)
      )
    )
    if (started) return true
    const deadline = Date.now() + IMPLICIT_START_WAIT_MS
    while (!(yield* logExists(input.root, input.id))) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(StorageFailure.make({ operation: "session.locked" }))
      }
      yield* Effect.sleep(IMPLICIT_START_POLL_MS)
    }
    return false
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
 * The scope a session's ops are judged and committed under, from the ref it lands on.
 *
 * A session on `refs/heads/curate/<...>` is the curation door (`docs/design.md` §23,
 * "The curation door": a curator is a session on a curate branch working through `session put` and
 * `session exec`), so it is judged under the `curate` scope, the scope `curate run`, `curate
 * collapse`, and a `curate merge` replay use: `areas/arcs/` and `resources/people/` are writable and
 * head-only edits (`label`, `link`) on the records there are admitted. Every other ref, `main`
 * included, stays at `session`. Nothing reaches `main` from a curate ref but `curate merge`, which
 * runs the head gate and re-judges a replay under the same scope, so the reserved paths keep their
 * one door. Before this, a curate-branch session could not label an arc or a people record, or
 * archive one, because the three session arms always judged under `session`.
 */
export const sessionScopeOf = (ref: string): CommitScope =>
  ref.startsWith("refs/heads/curate/") ? "curate" : "session"

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
  /** The scope the session is judged under ({@link sessionScopeOf}); `session` when omitted. */
  readonly scope?: CommitScope | undefined
  /** A run-bound session: `duplicate` and `claim-edit` block too ({@link RUN_BOUND_BLOCKING_VIOLATIONS}). */
  readonly runBound?: boolean | undefined
  /**
   * The store's write bar (`memhtml.config.json`), read by the caller at the store root: the CLI
   * for a local put, the head server per request. The library default when omitted.
   */
  readonly writeBar?: WriteBarPolicy | undefined
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
    const violations = validateOps(input.base, [...input.sessionOps, ...appended], {
      scope: input.scope ?? "session",
      writeBar: input.writeBar
    })
    const kinds = blockingKinds(input.runBound)
    const blocking = violations.filter(
      (violation) =>
        kinds.has(violation.kind) && (violation.kind === "batch-cap" || touched.has(violation.path))
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
  /** The id came from `MEMHTML_SESSION`: start the session first when it has no log ({@link ensureSession}). */
  readonly implicitStart?: boolean | undefined
  /** The id is `MEMHTML_SESSION`'s: `duplicate` and `claim-edit` block too. */
  readonly runBound?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const started =
      input.implicitStart === true
        ? yield* ensureSession({ root: input.root, id: input.id })
        : false
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const scope = sessionScopeOf(session.ref)
    const at = isoSecond(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    // A curate-scope session judges locally, as the curate commands do: the head server's
    // neighbors route judges under `session`.
    const answered =
      input.server === false || scope === "curate"
        ? null
        : yield* askHead({
            root: input.root,
            route: "neighbors",
            schema: NeighborsAnswer,
            body: {
              sha: session.baseSha,
              ops: session.ops,
              lines: input.ops,
              at,
              // Sent only when true, so a call outside a run stays readable by an older server.
              ...(input.runBound === true ? { runBound: true } : {})
            }
          })
    let prepared: PreparedPuts
    let head: HeadStats
    if (answered !== null) {
      prepared = answered.data
      head = servedStats(answered.data.head, answered.ms)
    } else {
      const policy = yield* loadStorePolicy(input.root)
      const loaded = yield* loadHeadAt(input.root, session.baseSha)
      prepared = yield* preparePuts({
        base: loaded.view,
        sessionOps: session.ops,
        lines: input.ops,
        at,
        cache: loadForSearch(input.root),
        embedder: input.embedder,
        scope,
        runBound: input.runBound,
        writeBar: policy.policy.writeBar
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
      /** True when this call started the session (the id came from `MEMHTML_SESSION` and had no log). */
      started,
      /**
       * The session's base after the append: the base the puts were judged at, unless the log carried
       * a `pending` commit that had landed, which the append settled first (`appendOps`), moving the
       * session onto it.
       */
      baseSha: next.baseSha,
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
 * script over that view, harvest, complete the harvest's archives and moves with the edge repoints
 * they need ({@link withRepoints}), judge the log plus the harvest against `base`, and append the
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
  /** A run-bound session: `duplicate` and `claim-edit` block the harvest too. */
  readonly runBound?: boolean | undefined
  /** The store's write bar, read by the caller at the store root; the library default when omitted. */
  readonly writeBar?: WriteBarPolicy | undefined
}): Effect.Effect<ExecOutcome, InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const { session } = input
    const scope = sessionScopeOf(session.ref)
    const view = yield* withOverlay(input.base, session.ops)
    const report = yield* runSessionExec({
      view,
      script: input.script,
      lang: input.lang,
      timeoutMs: input.timeoutMs,
      scope,
      ...input.runtime
    })
    // A file the script archived or moved has left its path, so every edge a live record still
    // carries to that path is repointed to where the record went, as the curator's `exec` completes
    // its own harvest; an edge the script repointed itself stays as it wrote it.
    const ops = withRepoints(view, report.ops, scope)
    const harvested = new Set(ops.flatMap(touchedPaths))
    const violations = validateOps(input.base, [...session.ops, ...ops], {
      scope,
      writeBar: input.writeBar
    })
    const kinds = blockingKinds(input.runBound)
    const blocking = violations.filter(
      (violation) =>
        kinds.has(violation.kind) &&
        (violation.kind === "batch-cap" || harvested.has(violation.path))
    )
    const clean = report.exitCode === 0 && blocking.length === 0
    const blocked = blocking.map(describeViolation)
    let next: Session = session
    let appended = 0
    if (clean && ops.length > 0) {
      const outcome = yield* appendOps(session, ops).pipe(
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
        appended = ops.length
      } else {
        blocked.push(outcome.refusal)
      }
    }
    return {
      id: session.id,
      /**
       * The session's base after this call: the base the script ran over, unless the append settled a
       * `pending` commit that had landed (`appendOps`), which moves the session onto that commit.
       */
      baseSha: next.baseSha,
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
      /**
       * Ops the harvest carries: what the harvester made of the tree the script left, plus an
       * `unlink` and a `link` for each edge a live record carries to a path an archive or a move
       * vacated ({@link withRepoints}).
       */
      ops: ops.length,
      /**
       * How many of those were appended to the log: all of them on exit 0 with no blocking
       * violation and a log nobody else changed meanwhile, none otherwise.
       */
      appended,
      /** The log's length after this call. */
      opsTotal: next.ops.length,
      harvested: ops.map(opSummary),
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
  /**
   * The id came from `MEMHTML_SESSION`: start the session first when it has no log
   * ({@link ensureSession}). Done here, before the server is asked, because the server reads the
   * session's log itself and starts nothing.
   */
  readonly implicitStart?: boolean | undefined
  /** The id is `MEMHTML_SESSION`'s: `duplicate` and `claim-edit` block too. */
  readonly runBound?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const started =
      input.implicitStart === true
        ? yield* ensureSession({ root: input.root, id: input.id })
        : false
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
              started,
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
    const policy = yield* loadStorePolicy(input.root)
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const head = yield* loadHeadAt(input.root, session.baseSha)
    const outcome = yield* execOverHead({
      session,
      base: head.view,
      script: input.script,
      lang: input.lang,
      timeoutMs: input.timeoutMs,
      runBound: input.runBound,
      writeBar: policy.policy.writeBar
    })
    return { ...outcome, started, head: headStats(head), server }
  })

/**
 * The half of `session commit` that follows the head: the commit algorithm against `base`, the
 * version at the session's base, with `--drop-refused`'s rounds, and the new commit's snapshot. The
 * CLI calls it with the version it loaded and the head server with the version it holds
 * (`head-server.ts`, `/v1/commit`), so the two answer with one function and cannot drift.
 * `afterCommit` is the only difference: it writes the snapshot of a `committed` outcome, which the CLI
 * builds from `base` by delta ({@link snapshotAfterCommit}, the default) and the server builds from
 * the same version while it moves the version it holds to the commit. Neither can fail the call:
 * `null` is a write that did not happen.
 *
 * `rebase-needed` is returned, not retried: the caller decides whether to `session rebase` and try
 * again, because a rebase can turn the outcome into `refused` and that is a decision, not a retry.
 *
 * A log with no ops and no `pending` commit to settle has nothing to land: it is answered `refused`
 * with no violations and nothing dropped, and nothing is touched (no commit, no log write, no
 * snapshot). `committed` always names a commit that was made, here or by an earlier call this one
 * recovered; the `--drop-refused` rounds stop at an empty log the same way.
 */
export const commitOverHead = (input: {
  readonly session: Session
  readonly base: HeadVersion
  readonly message: string
  /** `--drop-refused`: take the ops a refusal names out of the log and commit the rest. */
  readonly dropRefused?: boolean | undefined
  /** The store's write bar (`memhtml.config.json`); the library default when omitted. */
  readonly writeBar?: WriteBarPolicy | undefined
  readonly afterCommit?: ((sha: string) => Effect.Effect<SnapshotWritten | null>) | undefined
}): Effect.Effect<CommitResult, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    let session = input.session
    const scope = sessionScopeOf(session.ref)
    const dropped: Array<DroppedOp> = []
    let outcome: CommitOutcome =
      session.ops.length === 0 && session.pending === undefined
        ? { kind: "refused", violations: [] }
        : yield* commitSession({
            session,
            head: input.base,
            message: input.message,
            scope,
            writeBar: input.writeBar
          })
    // Each round drops what the refusal names and commits again. An op that only failed because
    // an op it depended on was dropped (a link from a dropped put) is named by the next round, so
    // the loop ends at a clean log, an empty one, or a refusal no op carries (the batch cap).
    while (input.dropRefused === true && outcome.kind === "refused") {
      const round = opsToDrop(session.ops, outcome.violations)
      if (round.drop.length === 0) break
      dropped.push(...round.drop)
      session = yield* replaceOps(session, round.keep)
      yield* recordDropped(session.root, session.id, round.drop)
      if (session.ops.length === 0) break
      outcome = yield* commitSession({
        session,
        head: input.base,
        message: input.message,
        scope,
        writeBar: input.writeBar
      })
    }
    const afterCommit =
      input.afterCommit ?? ((sha: string) => snapshotAfterCommit(session.root, sha, input.base))
    const snapshot: SnapshotWritten | null =
      outcome.kind === "committed" ? yield* afterCommit(outcome.sha) : null
    return {
      id: session.id,
      ref: session.ref,
      baseSha: session.baseSha,
      ...outcome,
      snapshot,
      /** The ops `--drop-refused` took out of the log, each with the reasons its violations gave. */
      dropped
    }
  })

/**
 * Whether the head server committed or rebased a session: `used` with the version it judged against
 * (`base`, always `tip` for a rebase), else why this process did: `disabled` (`--no-server`),
 * `no-server` (no socket, nobody listening, no accept in time), `refused` (the server answered a
 * 4xx, which it does before anything runs: an older server without the route, or a body it refused),
 * or the server's own decline (`other-ref`, `session-unreadable`, `base-unservable`, `busy`), with
 * the detail.
 */
export interface CommitServerUse {
  readonly used: boolean
  readonly base: CommitBase | null
  readonly reason: "disabled" | "no-server" | "refused" | CommitDeclined | null
  readonly detail: string | null
}

const SERVER_DISABLED: CommitServerUse = {
  used: false,
  base: null,
  reason: "disabled",
  detail: null
}

/** How long `session commit` and `session rebase` wait for the server: `0` is no bound. */
export const commitAnswerTimeoutMs = (deadlineMs: number | undefined): number => {
  const ms = deadlineMs ?? COMMIT_DEADLINE_DEFAULT_MS
  return ms === 0 ? Number.POSITIVE_INFINITY : ms
}

/** The `code` and `error` of a failure envelope the server answered with, as one line. */
const envelopeLine = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { readonly code?: unknown; readonly error?: unknown }
    if (typeof parsed.code === "string") {
      return `${parsed.code}: ${typeof parsed.error === "string" ? parsed.error : ""}`.slice(0, 300)
    }
  } catch {
    // Not an envelope; the body itself says what there is to say.
  }
  return body.slice(0, 300)
}

/**
 * A commit or rebase the server did not answer with a payload: why this process does it instead, or
 * the failure when it must not. Nothing ran on the server when the request never reached one
 * (`no-server`) or when it answered a 4xx, which it does only before it reads the log. But a request
 * it took and then answered 5xx, or never answered within the deadline (`lost`), may have moved the
 * ref or the log, so doing it again here could commit the same ops twice or race the server's own
 * commit: the call fails naming `session status` instead.
 */
const unanswered = (
  verb: "commit" | "rebase",
  id: string,
  deadlineMs: number,
  asked: Exclude<Asked<unknown>, { readonly kind: "answered" }>
): Effect.Effect<CommitServerUse, StorageFailure> => {
  switch (asked.kind) {
    case "no-server":
      return Effect.succeed({ used: false, base: null, reason: "no-server", detail: asked.detail })
    case "refused":
      if (asked.status < 500) {
        return Effect.succeed({
          used: false,
          base: null,
          reason: "refused",
          detail: `${String(asked.status)}: ${asked.body.slice(0, 300)}`
        })
      }
      return Effect.fail(
        StorageFailure.make({
          operation: `session ${verb}: the head server took the ${verb} and failed (${String(asked.status)} ${envelopeLine(asked.body)}); it may have moved the ref, so the ${verb} was not tried again here; read \`memhtml session status --id ${id}\` before running it again`
        })
      )
    case "lost":
      return Effect.fail(
        StorageFailure.make({
          operation: `session ${verb}: the head server took the ${verb} and gave no usable answer${Number.isFinite(deadlineMs) ? ` within ${String(deadlineMs)} ms (${COMMIT_DEADLINE_VAR})` : ""} (${asked.detail.slice(0, 200)}); it may have moved the ref, so the ${verb} was not tried again here; read \`memhtml session status --id ${id}\` before running it again`
        })
      )
  }
}

/**
 * What `session commit` prints: the outcome, how many rebases the server made before it
 * (`rebased`, only through the server with `--drop-refused`, `0` otherwise), which path committed,
 * and why when it was this one.
 */
export type SessionCommitted = CommitResult & {
  readonly rebased: number
  readonly via: "server" | "local"
  readonly server: CommitServerUse
}

/**
 * `session commit`: the commit algorithm against the session's base ({@link commitOverHead}). When
 * `HEAD` is the session's ref, the shared index and working tree follow the commit
 * (`worktreeSynced`), or the commit is `worktree-dirty` and nothing moves. A `committed` outcome also
 * writes the snapshot for the new commit (`snapshot`, `null` when that best-effort write failed), so
 * the next load hits the cache.
 *
 * The head server commits when one answers (`/v1/commit`: it reads the log, takes the version at the
 * session's base from what it holds, commits one session at a time, moves its held version to the
 * commit, and writes the snapshot), and this process commits when the server did not take it:
 * `--no-server`, no server, a 4xx, or a decline. The payload is the same either way, with `via`
 * naming the path and `server` saying why ({@link CommitServerUse}). A commit the server took and
 * did not answer is not committed again here ({@link unanswered}).
 */
export const sessionCommit = (input: {
  readonly root: string
  readonly id: string
  readonly message: string
  /** `--drop-refused`: take the ops a refusal names out of the log and commit the rest. */
  readonly dropRefused?: boolean | undefined
  /** False under `--no-server`: commit here without asking. */
  readonly server?: boolean | undefined
  /** How long to wait for the server's answer, `0` for no bound ({@link COMMIT_DEADLINE_DEFAULT_MS}). */
  readonly commitDeadlineMs?: number | undefined
}): Effect.Effect<
  SessionCommitted,
  GitFailure | InvalidMemory | StorageFailure | StoreConfigInvalid
> =>
  Effect.gen(function* () {
    // Read before the server is asked, so a store whose `memhtml.config.json` does not decode
    // refuses here with ERR_STORE_CONFIG rather than as a server error the CLI may not retry.
    const { writeBar } = (yield* loadStorePolicy(input.root)).policy
    let server = SERVER_DISABLED
    if (input.server !== false) {
      const deadlineMs = commitAnswerTimeoutMs(input.commitDeadlineMs)
      const asked = yield* askHeadFor({
        root: input.root,
        route: "commit",
        schema: CommitAnswer,
        body: commitRequestOf(input),
        answerTimeoutMs: deadlineMs
      })
      if (asked.kind === "answered") {
        const answer = asked.data
        if (answer.served) {
          return {
            ...answer.outcome,
            rebased: answer.rebased ?? 0,
            via: "server" as const,
            server: { used: true, base: answer.base, reason: null, detail: null }
          }
        }
        server = { used: false, base: null, reason: answer.reason, detail: answer.detail }
      } else {
        server = yield* unanswered("commit", input.id, deadlineMs, asked)
      }
    }
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const head = yield* loadHeadAt(input.root, session.baseSha)
    const outcome = yield* commitOverHead({
      session,
      base: head.view,
      message: input.message,
      dropRefused: input.dropRefused,
      writeBar
    })
    return { ...outcome, rebased: 0, via: "local" as const, server }
  })

/** One op `session commit --drop-refused` took out of the log, and why. */
export interface DroppedOp {
  readonly kind: OverlayOp["kind"]
  readonly path: string
  readonly reasons: ReadonlyArray<string>
}

/**
 * The ops a refusal names, and the ops it leaves: every op that touches a path a violation names
 * (a put, and the head ops and archives on that path), described with the violations' reasons. A
 * violation that names no path (the batch cap) drops nothing, so the refusal stands.
 */
const opsToDrop = (
  ops: ReadonlyArray<OverlayOp>,
  violations: ReadonlyArray<Violation>
): { readonly drop: ReadonlyArray<DroppedOp>; readonly keep: ReadonlyArray<OverlayOp> } => {
  const reasons = new Map<string, Array<string>>()
  for (const violation of violations) {
    if (violation.kind === "batch-cap") continue
    const list = reasons.get(violation.path) ?? []
    list.push(describeViolation(violation))
    reasons.set(violation.path, list)
  }
  const drop: Array<DroppedOp> = []
  const keep: Array<OverlayOp> = []
  for (const op of ops) {
    const hit = touchedPaths(op).find((path) => reasons.has(path))
    if (hit === undefined) keep.push(op)
    else drop.push({ kind: op.kind, path: op.path, reasons: reasons.get(hit) ?? [] })
  }
  return { drop, keep }
}

/**
 * Keep what `--drop-refused` took out beside the log, one JSON line per op with the instant, in
 * `.memhtml/sessions/<id>.dropped.jsonl`, so a refused record stays inspectable after the rest of
 * the session lands. Best-effort: the payload's `dropped` is the answer, this file is the trail.
 */
const recordDropped = (root: string, id: string, drop: ReadonlyArray<DroppedOp>) =>
  Effect.promise(() => {
    const at = new Date().toISOString()
    const lines = drop.map((op) => `${JSON.stringify({ at, ...op })}\n`).join("")
    return appendFile(join(root, SESSIONS_DIR, `${id}.dropped.jsonl`), lines, "utf8").catch(
      () => undefined
    )
  })

/**
 * The half of `session rebase` after the version at the ref's tip is in hand: move the session's base
 * to `onto`, keeping every op, and save the log. The CLI calls it with the version it loaded and the
 * head server with the tip it holds (`/v1/rebase`). Validation is the next commit's.
 */
export const rebaseOver = (
  session: Session,
  onto: HeadView & { readonly sha: string }
): Effect.Effect<RebaseResult, StorageFailure> =>
  Effect.gen(function* () {
    const rebased = rebaseSession(session, onto)
    yield* saveSession(rebased)
    return {
      id: session.id,
      ref: session.ref,
      from: session.baseSha,
      baseSha: rebased.baseSha,
      moved: rebased.baseSha !== session.baseSha,
      ops: rebased.ops.length
    }
  })

/**
 * `session rebase`: move the base to the ref's tip, keeping every op. The head server rebases when one
 * answers (`/v1/rebase`, onto the tip it holds after the same advance check every answer makes), and
 * this process loads the tip and rebases when it did not, by the rules `session commit` follows:
 * `head.source` is `server` and `via` names the path, `server` says why, and a rebase the server took
 * and did not answer is not repeated here.
 */
export const sessionRebase = (input: {
  readonly root: string
  readonly id: string
  /** False under `--no-server`: rebase here without asking. */
  readonly server?: boolean | undefined
  /** How long to wait for the server's answer, `0` for no bound ({@link COMMIT_DEADLINE_DEFAULT_MS}). */
  readonly commitDeadlineMs?: number | undefined
}) =>
  Effect.gen(function* () {
    let server = SERVER_DISABLED
    if (input.server !== false) {
      const deadlineMs = commitAnswerTimeoutMs(input.commitDeadlineMs)
      const asked = yield* askHeadFor({
        root: input.root,
        route: "rebase",
        schema: RebaseAnswer,
        body: { id: input.id },
        answerTimeoutMs: deadlineMs
      })
      if (asked.kind === "answered") {
        const answer = asked.data
        if (answer.served) {
          const used: CommitServerUse = { used: true, base: "tip", reason: null, detail: null }
          return {
            ...answer.outcome,
            head: servedStats(answer.head, asked.ms),
            via: "server" as const,
            server: used
          }
        }
        server = { used: false, base: null, reason: answer.reason, detail: answer.detail }
      } else {
        server = yield* unanswered("rebase", input.id, deadlineMs, asked)
      }
    }
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const sha = yield* baseShaFor(input.root, session.ref)
    const head = yield* loadHeadAt(input.root, sha)
    const rebased = yield* rebaseOver(session, head.view)
    return { ...rebased, head: headStats(head), via: "local" as const, server }
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
      moves: count("move"),
      paths: [...new Set(session.ops.flatMap(touchedPaths))].sort(),
      /** A commit built and possibly landed by a call that was killed; the next commit settles it. */
      pending: session.pending ?? null
    }
  })

/**
 * `session prune --older-than`'s value as milliseconds, through `ms`: a number with a unit (`7d`,
 * `48h`, `90m`, `1.5h`, `2 weeks`). A bare number is refused rather than read as milliseconds, and so
 * is a negative one, because `--older-than 7` meaning seven milliseconds would prune every idle log.
 */
export const parseOlderThan = (
  value: string
): { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly reason: string } => {
  const trimmed = value.trim()
  // `ms` throws on an empty string and reads a bare number as milliseconds; both are refused first.
  const parsed =
    trimmed === "" || /^[0-9.]+$/.test(trimmed) ? undefined : ms(trimmed as ms.StringValue)
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return {
      ok: false,
      reason: `--older-than ${JSON.stringify(value)} is not a duration with a unit, such as 7d, 48h, or 90m`
    }
  }
  if (parsed < 0) {
    return { ok: false, reason: `--older-than ${JSON.stringify(value)} is negative` }
  }
  return { ok: true, ms: parsed }
}

/**
 * `session prune`: {@link pruneSessions} with the cutoff as given and each unlanded log's age in the
 * same units (`ms`'s short form). The ids, counts, and lists are the package's report unchanged.
 */
export const sessionPrune = (input: {
  readonly root: string
  readonly olderThan: string
  readonly dryRun: boolean
}) =>
  Effect.gen(function* () {
    const cutoff = parseOlderThan(input.olderThan)
    if (!cutoff.ok) return yield* Effect.fail(InvalidMemory.make({ reason: cutoff.reason }))
    const report = yield* pruneSessions({
      root: input.root,
      olderThanMs: cutoff.ms,
      dryRun: input.dryRun
    })
    return {
      ...report,
      olderThan: input.olderThan,
      unlanded: report.unlanded.map((entry) => ({ ...entry, age: ms(entry.ageMs) }))
    }
  })

/**
 * `head status`: the head server's status when one answers (its version, ref, load, advances, and
 * vector cache under `server`), else build the version at `HEAD` here and report what that cost and
 * where it came from, with `server: null`. Either way `policy` says where the store's policy comes
 * from ({@link PolicySource}: `file`, `defaults` when `memhtml.config.json` is absent, or
 * `invalid`), as the server read it when it answered with one, else as this process reads it.
 */
export const headStatus = (input: {
  readonly root: string
  readonly server?: boolean | undefined
}): Effect.Effect<
  HeadStats & { readonly server: HeadServerStatus | null; readonly policy: PolicySource },
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
          server: status,
          policy: status.policy ?? (yield* policySourceOf(input.root))
        }
      }
    }
    const sha = yield* headSha(input.root)
    return {
      ...headStats(yield* loadHeadAt(input.root, sha)),
      server: null,
      policy: yield* policySourceOf(input.root)
    }
  })

/**
 * `head search`: RRF over the version at `HEAD`, lexical plus the vector arm when the store has a
 * vector cache and an embedder is configured, with recency breaking exact ties. The query is
 * embedded with `embedQuery`; when the arm cannot run (`MEMHTML_EMBED=off`, no cache, an unreadable
 * cache, a failed query embed) the search runs on the lexical arm alone and `vector` says why, never
 * failing the call.
 *
 * The query embed has a deadline, `embedDeadlineMs` (`MEMHTML_EMBED_DEADLINE_MS`), else
 * {@link EMBED_DEADLINE_DEFAULT_MS}; past it the search answers on the lexical arm and `vector`
 * says `embed-timeout`. Locally the late embed is stopped, since the process exits after the answer.
 *
 * The head server answers when one runs, over its version of its ref, with the cache it holds and
 * the embedder it bound, and the payload has the same fields either way; only `head.source` says
 * which path answered. The search input goes to the server as one object, the same object
 * `searchHead` takes, so an option it gains later travels without a protocol change; a deadline set
 * here travels as its `embedDeadlineMs`, and without one the server applies its own.
 */
export const headSearch = (input: {
  readonly root: string
  readonly query: string
  readonly limit?: number | undefined
  readonly embedder: EmbedderShape
  readonly server?: boolean | undefined
  readonly embedDeadlineMs?: number | undefined
}) =>
  Effect.gen(function* () {
    const search: Omit<SearchRequest, "embedDeadlineMs"> = {
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }
    if (input.server !== false) {
      const answered = yield* askHead({
        root: input.root,
        route: "search",
        schema: SearchAnswer,
        body: {
          ...search,
          ...(input.embedDeadlineMs === undefined ? {} : { embedDeadlineMs: input.embedDeadlineMs })
        }
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
      embedder: input.embedder,
      deadlineMs: input.embedDeadlineMs ?? EMBED_DEADLINE_DEFAULT_MS
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
    readonly move: number
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

/** How many `rebase-needed` answers a replay tolerates before it gives up; `curate-run.ts` uses the same bound. */
export const MERGE_ATTEMPTS = 8

/** The scope a replay validates and commits under: the curator's, so arcs and people paths land. */
const MERGE_SCOPE = "curate" as const

/**
 * A replay's batch cap: none. Its ops are the union of the curate branch's commits, each of which
 * `commitSession` already held to `BATCH_CAP`, and a replay is one commit by design (a landing that
 * failed halfway would leave `main` holding half a curation). Capped, a branch past 200 ops could
 * only ever fast-forward, and `main` moves every few minutes on the live store.
 */
const MERGE_BATCH_CAP = Number.POSITIVE_INFINITY

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
 * `curate merge`: land a curator branch on its target (`docs/design.md` §23, "The curation door").
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
 * 3. Fast-forward through `landOnRef` (`@memhtml/session`), the section a session commit lands
 *    with, under the repository's checkout lock: `into` must still be at `from`; when HEAD is
 *    `into`, the checkout follows BEFORE the ref moves (a dirty path among those the landing changes
 *    is `DirtyTree` and nothing moves, else `read-tree -m -u from to`); then `update-ref into to
 *    from` as a compare-and-swap. A ref that moved, before or at the swap, means another writer
 *    advanced `into` between step 1 and now: the checkout is rolled back and the call refuses.
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
  GitFailure | InvalidMemory | StorageFailure | DirtyTree | GateFailure | StoreConfigInvalid
> =>
  Effect.gen(function* () {
    const { writeBar } = (yield* loadStorePolicy(input.root)).policy
    const ref = qualifyRef(input.ref)
    const into = qualifyRef(input.into ?? "main")
    const git = makePlumbing({ root: input.root })

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
      // A move on the branch repointed the edges its base held; `into` may have gained one to the
      // old path since, so the replay completes the repoints against the tip it lands on.
      session = yield* appendOps(
        session,
        withRepoints(head.view, replay.reconstruction.ops, MERGE_SCOPE)
      )
      const violations = validateOps(head.view, session.ops, {
        scope: MERGE_SCOPE,
        batchCap: MERGE_BATCH_CAP,
        writeBar
      })
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
        reconstruction: replay.reconstruction,
        writeBar
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

    // The checkout follows and the ref moves as one section under the checkout lock, exactly as a
    // session commit lands (`landOnRef`), so no v1 write commits the shared index in between.
    const landing = yield* landOnRef({
      root: input.root,
      git,
      ref: into,
      expected: from,
      from,
      to,
      paths: yield* git.diffTreePaths(from, to)
    })
    if (landing.kind === "worktree-dirty") {
      return yield* Effect.fail(DirtyTree.make({ paths: landing.paths }))
    }
    if (landing.kind === "raced") {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${into} moved from ${from} to ${landing.tip ?? "an unresolved commit"} while the gate ran; nothing was landed, re-run to judge ${ref} against the new tip`
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
      worktreeSynced: landing.worktreeSynced,
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
  /** The store's write bar, judged again on every attempt against the tip it lands on. */
  readonly writeBar: WriteBarPolicy
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
        scope: MERGE_SCOPE,
        batchCap: MERGE_BATCH_CAP,
        writeBar: input.writeBar
      })
      switch (outcome.kind) {
        case "committed": {
          const git = makePlumbing({ root: input.root })
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
  /**
   * False under `--no-server`: `head status`, `head search`, and `session put` load locally, and
   * `session exec`, `session commit`, and `session rebase` run here.
   */
  readonly server: boolean
  /**
   * How long `session commit` and `session rebase` wait for the head server's answer, from
   * `MEMHTML_COMMIT_DEADLINE_MS`, `0` for none; absent when the variable is unset, which is
   * {@link COMMIT_DEADLINE_DEFAULT_MS}.
   */
  readonly commitDeadlineMs?: number | undefined
  /**
   * The session id came from `MEMHTML_SESSION` rather than `--id`, so `session put` and `session
   * exec` start the session on first use. An id on the line keeps the explicit contract: it must name
   * a started session.
   */
  readonly implicitStart: boolean
  /**
   * `head search`'s query-embed deadline from `MEMHTML_EMBED_DEADLINE_MS`, `0` for none; absent when
   * the variable is unset, which is the local default and the server's own deadline.
   */
  readonly embedDeadlineMs?: number | undefined
  /**
   * The id is `MEMHTML_SESSION`'s, from the line or the variable: `session put` and `session exec`
   * block `duplicate` and `claim-edit` too ({@link RUN_BOUND_BLOCKING_VIOLATIONS}).
   */
  readonly runBound: boolean
  /** `session commit --drop-refused`. */
  readonly dropRefused: boolean
}

/** One arm per command, each returning its response type beside its payload. */
export const runV2 = (
  command: string,
  input: V2Input
): Effect.Effect<
  readonly [ResponseType, unknown],
  | GitFailure
  | InvalidMemory
  | StorageFailure
  | DirtyTree
  | GateFailure
  | ModelUnavailable
  | StoreConfigInvalid
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

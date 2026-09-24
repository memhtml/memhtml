import { join } from "node:path"

import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { DirtyTree, InvalidMemory, StorageFailure } from "@memhtml/contracts/errors"
import { isValidMemoryPath, memoryPathFor } from "@memhtml/contracts/paths"
import { filenameFor, slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import { type HeadVersion, type SearchHit, searchHead, withOverlay } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import {
  appendOps,
  type CommitOutcome,
  commitSession,
  DEFAULT_REF,
  makePlumbing,
  rebaseSession,
  resumeSession,
  saveSession,
  startSession,
  touchedPaths,
  type Violation,
  validateOps
} from "@memhtml/session"
import { readSnapshot, snapshotPathFor } from "@memhtml/snapshot"
import { type GitFailure, isoSecond, makeGit, type WriteInput } from "@memhtml/store"
import { Effect } from "effect"

import type { ResponseType } from "./envelope.js"
import {
  type HeadSource,
  loadVersion,
  type SnapshotWritten,
  snapshotAfterCommit,
  writeHeadSnapshot
} from "./head-cache.js"
import {
  type GateFailure,
  type GateOutcome,
  type GateReport,
  gateReportOf,
  headGate
} from "./head-gate.js"
import { toWriteInput, type WriteParams } from "./operations.js"
import { runSessionExec } from "./session-exec.js"

export type { GateReport } from "./head-gate.js"

/**
 * The v2 proof-of-concept commands (`docs/v2-poc.md`, "CLI commands"): `session start|put|exec|
 * commit|rebase|status`, `head status|search|snapshot`, and the curation door `curate merge`.
 *
 * ## No app layer
 *
 * Every arm here resolves a repo root and reads git; none opens `index.db`. They are answered in
 * `run.ts` before the app layer is built, on the same path `exec` and `serve mcp` take, because
 * building `layerApp` would open and migrate a SQLite database no arm queries, on exactly the path an
 * agent reaches for while `memhtml serve mcp` holds that database. `DispatchServices` is the app
 * layer's service set, so nothing here can be reached through `dispatch`.
 *
 * ## The head loads per invocation
 *
 * A long-lived head process is out of the proof of concept's scope. Each call builds the version it
 * needs: from `.memhtml/snapshots/<sha>.arrow` when a snapshot exists for that commit, else from the
 * newest snapshot of an ancestor commit advanced over the changed paths, else from git, and every
 * payload that loaded one says which ({@link HeadStats}). Every commit that moves a ref writes the
 * snapshot for the new sha (`head-cache.ts`), so the next call hits the cache. A session command loads the
 * head at the SESSION's base sha, not at the ref's tip, because a session sees exactly one version
 * plus its own deltas: `session commit` validates against that base and reports `rebase-needed`
 * whenever the ref has moved past it, and `session rebase` is the one arm that reloads at the ref's
 * tip and moves the base. Dedup and frame-key checks are judged at the base, so a commit lands only
 * when the ref still IS that base; the rebase-and-retry loop is what makes them fresh.
 */

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
  readonly loadMs: number
  /** `snapshot` (this sha's own file), `snapshot+advance` (an ancestor's, advanced), or `git`. */
  readonly source: HeadSource
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

/** The violation kinds that make a put unlandable regardless of what the ref does next. */
const BLOCKING_VIOLATIONS: ReadonlySet<Violation["kind"]> = new Set([
  "format",
  "reserved-path",
  "batch-cap"
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

/**
 * `session put`: render each `write` op the way the store would and append the puts to the log.
 *
 * Refused as a whole, appending nothing, when a new put carries a violation no rebase can cure
 * ({@link BLOCKING_VIOLATIONS}): a malformed file or a reserved path would make every later commit
 * of this session `refused`, and the log has no removal op. `duplicate` and `claim-edit` are
 * reported, not refused, because they are judged against the base the session currently sees and a
 * rebase can change the answer either way.
 */
export const sessionPut = (input: {
  readonly root: string
  readonly id: string
  readonly ops: ReadonlyArray<WriteParams>
}) =>
  Effect.gen(function* () {
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const head = yield* loadHeadAt(input.root, session.baseSha)
    const view = yield* withOverlay(head.view, session.ops)
    const at = isoSecond(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const claimed = new Set<string>()
    const puts: Array<OverlayOp> = []
    for (const params of input.ops) {
      const write = yield* toWriteInput(params, at)
      const path = yield* putPathFor(view, write, claimed)
      claimed.add(path)
      puts.push({ kind: "put", path, html: renderTemplate(write) })
    }
    // Judged the way `commitSession` will judge them: every op of the session against the base.
    const violations = validateOps(head.view, [...session.ops, ...puts])
    const blocking = violations.filter(
      (violation) =>
        BLOCKING_VIOLATIONS.has(violation.kind) &&
        (violation.kind === "batch-cap" || claimed.has(violation.path))
    )
    if (blocking.length > 0) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `session put refused, nothing appended: ${blocking.map(describeViolation).join(" | ")}`
        })
      )
    }
    const next = yield* appendOps(session, puts)
    return {
      id: session.id,
      baseSha: session.baseSha,
      appended: puts.length,
      ops: next.ops.length,
      paths: puts.map((op) => op.path),
      violations
    }
  })

/**
 * `session exec`: run a script over head plus overlay and append what it wrote.
 *
 * The harvest is appended only when the script exited 0 AND no harvested op carries a violation no
 * rebase can cure ({@link BLOCKING_VIOLATIONS}), judged the way `session put` judges its puts. A
 * script that threw halfway has left a tree it did not mean to leave, and one that wrote a malformed
 * file beside forty good ones has too; the log has no removal op, so appending either would poison
 * every later commit of the session. The harvest and its violations are still reported, so the
 * caller can see what a clean run would have taken.
 */
export const sessionExec = (input: {
  readonly root: string
  readonly id: string
  readonly script: string
  readonly timeoutMs?: number | undefined
}) =>
  Effect.gen(function* () {
    const session = yield* resumeSession({ root: input.root, id: input.id })
    const head = yield* loadHeadAt(input.root, session.baseSha)
    const view = yield* withOverlay(head.view, session.ops)
    const report = yield* runSessionExec({ view, script: input.script, timeoutMs: input.timeoutMs })
    const harvested = new Set(report.ops.flatMap(touchedPaths))
    const violations = validateOps(head.view, [...session.ops, ...report.ops])
    const blocking = violations.filter(
      (violation) =>
        BLOCKING_VIOLATIONS.has(violation.kind) &&
        (violation.kind === "batch-cap" || harvested.has(violation.path))
    )
    const clean = report.exitCode === 0 && blocking.length === 0
    const next = clean ? yield* appendOps(session, report.ops) : session
    return {
      id: session.id,
      baseSha: session.baseSha,
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
       * violation, none otherwise.
       */
      appended: clean ? report.ops.length : 0,
      /** The log's length after this call. */
      opsTotal: next.ops.length,
      harvested: report.ops.map(opSummary),
      rejected: report.rejected,
      /** Every violation over the session's ops plus the harvest, judged against the base. */
      violations,
      /** The violations that kept the harvest out of the log, described. */
      blocking: blocking.map(describeViolation)
    }
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
      paths: [...new Set(session.ops.flatMap(touchedPaths))].sort(),
      /** A commit built and possibly landed by a call that was killed; the next commit settles it. */
      pending: session.pending ?? null
    }
  })

/** `head status`: build the version at `HEAD` and report what that cost and where it came from. */
export const headStatus = (input: { readonly root: string }) =>
  Effect.gen(function* () {
    const sha = yield* headSha(input.root)
    return headStats(yield* loadHeadAt(input.root, sha))
  })

/** `head search`: two-arm RRF over the version at `HEAD`. */
export const headSearch = (input: {
  readonly root: string
  readonly query: string
  readonly limit?: number | undefined
}) =>
  Effect.gen(function* () {
    const sha = yield* headSha(input.root)
    const head = yield* loadHeadAt(input.root, sha)
    const hits: ReadonlyArray<SearchHit> = searchHead(head.view, {
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit })
    })
    return { query: input.query, hits, head: headStats(head) }
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

/** What `curate merge` answers when the target moved. */
export interface CurateMerged {
  readonly ref: string
  readonly into: string
  /** The target's commit before the landing. */
  readonly from: string
  /** The curator branch's commit, and the target's after the landing. */
  readonly to: string
  /** False when `from` already equaled `to`: nothing to land, nothing moved. */
  readonly moved: boolean
  readonly gate: GateReport
  /** True when HEAD is `into` and the shared index and working tree followed the ref. */
  readonly worktreeSynced: boolean
  /** The snapshot written for `to` after the landing, or `null` when nothing moved or the write failed. */
  readonly snapshot: SnapshotWritten | null
}

/**
 * The index file the merge's plumbing is built with. `curate merge` never reads or writes a session
 * index (it moves a ref between two commits that already exist), so the file is never created; the
 * plumbing wants a path because a session's commit path does.
 */
const MERGE_INDEX_FILE = "curate-merge.idx"

/**
 * `curate merge`: land a curator branch on its target (`docs/v2-poc.md`, "Curation door").
 *
 * The order is refusals first, gate second, movement last, so a call that fails leaves the
 * repository exactly as it found it:
 *
 * 1. Both refs must resolve, and `ref` must be a descendant of `into` (`merge-base --is-ancestor`),
 *    so the landing is a fast-forward and never a merge commit. A curator that started before `into`
 *    moved rebases its session and commits again; this command does not settle that for it.
 * 2. The head gate (`head-gate.ts`): the version at `into`'s tip and the version at `ref`'s tip
 *    are loaded and `gateHeads` scores the same probes at both, so the gate measures the corpus
 *    being landed and nothing else, with no network call and no credential. A failing gate fails
 *    this effect with the gate's numbers, and nothing has moved yet. `skipGate` is a logged
 *    override, and the report says the gate did not run.
 * 3. When HEAD is `into`, the checkout follows BEFORE the ref moves, the way `commitSession` does it:
 *    a dirty path among those the landing changes is `DirtyTree` and nothing moves; otherwise
 *    `read-tree -m -u from to` brings the shared index and working tree to the new tree.
 * 4. `update-ref into to from` as a compare-and-swap. A `raced` answer means another writer advanced
 *    `into` between step 1 and now; the checkout is rolled back and the call refuses.
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
    if (!(yield* git.isAncestor(from, to))) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate merge: ${ref} (${to}) is not a descendant of ${into} (${from}), so landing it is not a fast-forward; rebase the curator session onto ${into} and commit again`
        })
      )
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

    if (from === to) {
      return { ref, into, from, to, moved: false, gate, worktreeSynced: false, snapshot: null }
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
    return { ref, into, from, to, moved: true, gate, worktreeSynced: checkedOut, snapshot }
  })

/** What `run.ts` hands each arm, already decoded from argv. */
export interface V2Input {
  readonly root: string
  readonly id: string
  readonly ref?: string | undefined
  readonly force: boolean
  readonly message: string
  readonly script: string
  readonly timeoutMs?: number | undefined
  readonly query: string
  readonly limit?: number | undefined
  readonly snapshotMode: "write" | "read"
  readonly ops: ReadonlyArray<WriteParams>
  /** `curate merge`'s positional: the curator branch. */
  readonly target: string
  readonly into?: string | undefined
  readonly skipGate: boolean
}

/** One arm per command, each returning its response type beside its payload. */
export const runV2 = (
  command: string,
  input: V2Input
): Effect.Effect<
  readonly [ResponseType, unknown],
  GitFailure | InvalidMemory | StorageFailure | DirtyTree | GateFailure
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

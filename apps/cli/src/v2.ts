import { access } from "node:fs/promises"

import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { InvalidMemory, StorageFailure } from "@memhtml/contracts/errors"
import { isValidMemoryPath, memoryPathFor } from "@memhtml/contracts/paths"
import { filenameFor, slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import {
  emptyIndexes,
  insertRecord,
  loadHead,
  type SearchHit,
  searchHead,
  viewOf,
  withOverlay
} from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import {
  appendOps,
  type CommitOutcome,
  commitSession,
  DEFAULT_REF,
  rebaseSession,
  resumeSession,
  saveSession,
  startSession,
  touchedPaths,
  type Violation,
  validateOps
} from "@memhtml/session"
import { readSnapshot, snapshotPathFor, writeSnapshot } from "@memhtml/snapshot"
import { type GitFailure, isoSecond, makeGit, type WriteInput } from "@memhtml/store"
import { Effect } from "effect"

import type { ResponseType } from "./envelope.js"
import { toWriteInput, type WriteParams } from "./operations.js"
import { runSessionExec } from "./session-exec.js"

/**
 * The v2 proof-of-concept commands (`docs/v2-poc.md`, "CLI commands"): `session start|put|exec|
 * commit|rebase|status` and `head status|search|snapshot`.
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
 * needs: from `.memhtml/snapshots/<sha>.arrow` when a snapshot exists for that commit, else from
 * git, and every payload that loaded one says which ({@link HeadStats}). A session command loads the
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
   * snapshot, which holds records only and cannot say what the original load left out.
   */
  readonly skipped: number | null
  readonly loadMs: number
  readonly source: "snapshot" | "git"
  /** The snapshot file the head was read from, or `null` when it came from git. */
  readonly snapshotPath: string | null
}

/** A loaded version plus what loading it cost. */
export interface LoadedHead extends HeadStats {
  readonly view: HeadView & { readonly sha: string }
}

/** The `HeadStats` half of a loaded head, for a payload. */
export const headStats = (loaded: LoadedHead): HeadStats => ({
  sha: loaded.sha,
  records: loaded.records,
  skipped: loaded.skipped,
  loadMs: loaded.loadMs,
  source: loaded.source,
  snapshotPath: loaded.snapshotPath
})

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false
    )
  )

/**
 * Load the version at `sha`: from its snapshot when one exists and `source` allows it, else from git.
 *
 * A snapshot whose metadata names a different sha than its filename is refused rather than served,
 * because the filename is what the caller asked for and the metadata is what the rows describe; a
 * disagreement means the file is not the cache it claims to be.
 */
export const loadHeadAt = (
  root: string,
  sha: string,
  source: "auto" | "git" = "auto"
): Effect.Effect<LoadedHead, GitFailure | InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const started = Date.now()
    const snapshotPath = snapshotPathFor(root, sha)
    if (source === "auto" && (yield* exists(snapshotPath))) {
      const snapshot = yield* readSnapshot(snapshotPath)
      if (snapshot.sha !== sha) {
        yield* Effect.logError(
          `snapshot ${snapshotPath} names ${snapshot.sha} in its metadata, so it is not the cache of ${sha}`
        )
        return yield* Effect.fail(StorageFailure.make({ operation: "snapshot.sha-mismatch" }))
      }
      let indexes = emptyIndexes
      for (const record of snapshot.records) indexes = insertRecord(indexes, record)
      const view = { ...viewOf(indexes, sha), sha }
      return {
        view,
        sha,
        records: view.size,
        skipped: null,
        loadMs: Date.now() - started,
        source: "snapshot" as const,
        snapshotPath
      }
    }
    const version = yield* loadHead(makeGit(root), sha)
    return {
      view: version,
      sha,
      records: version.size,
      skipped: version.skipped,
      loadMs: Date.now() - started,
      source: "git" as const,
      snapshotPath: null
    }
  })

/** The commit a ref resolves to, or `null` when it does not. A repo with no such ref is an answer. */
const revParse = (root: string, ref: string): Effect.Effect<string | null, GitFailure> =>
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
    const ref = input.ref === undefined || input.ref.trim() === "" ? DEFAULT_REF : input.ref.trim()
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
 * `worktree-dirty` and nothing moves.
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
    return { id: session.id, ref: session.ref, baseSha: session.baseSha, ...outcome }
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
      const written = yield* writeSnapshot({ records: head.view.records(), sha, path })
      return { mode: "write" as const, sha, path, bytes: written.bytes, rows: written.rows }
    }
    const snapshot = yield* readSnapshot(path)
    return { mode: "read" as const, sha: snapshot.sha, path, rows: snapshot.records.length }
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
}

/** One arm per command, each returning its response type beside its payload. */
export const runV2 = (
  command: string,
  input: V2Input
): Effect.Effect<readonly [ResponseType, unknown], GitFailure | InvalidMemory | StorageFailure> => {
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
    default:
      return Effect.fail(InvalidMemory.make({ reason: `no v2 arm for ${command}` }))
  }
}

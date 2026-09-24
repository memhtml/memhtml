import type { HeadView, OverlayOp } from "@memhtml/contracts"
import type { InvalidMemory as InvalidMemoryType } from "@memhtml/contracts/errors"
import {
  DirtyTree,
  InvalidMemory,
  ModelUnavailable,
  type StorageFailure
} from "@memhtml/contracts/errors"
import {
  type Briefing,
  briefingFromView,
  type CuratorExecResult,
  type CuratorModelSpecInvalid,
  type CuratorProposeResult,
  type CuratorRecordView,
  type CuratorRun,
  type CuratorSearchHit,
  type CuratorSessionStatus,
  type CuratorTools,
  curatorModel,
  runCurator,
  type StoppedBy
} from "@memhtml/curator"
import { searchHead, withOverlay } from "@memhtml/head"
import {
  appendOps,
  type CommitScope,
  commitSession,
  rebaseSession,
  resumeSession,
  type Session,
  saveSession,
  startSession,
  touchedPaths,
  type Violation,
  validateOps
} from "@memhtml/session"
import { type GitFailure, makeGit } from "@memhtml/store"
import { Effect } from "effect"

import { type SnapshotWritten, snapshotAfterCommit } from "./head-cache.js"
import { runSessionExec } from "./session-exec.js"
import {
  type HeadStats,
  headStats,
  type LoadedHead,
  loadHeadAt,
  qualifyRef,
  revParse
} from "./v2.js"

/**
 * `memhtml curate run`: the binder between `@memhtml/curator` and this app (`docs/v2-poc.md`,
 * "Curator").
 *
 * The package owns the loop, the charter, the budget, and the model factory, and takes its tools as
 * an interface because the sandbox helper (`runSessionExec`) lives here and a package cannot import
 * an app. This module binds those five tools to the real head, the real session, and the real
 * sandbox, computes the briefing, runs the loop, and lands the session on its `curate/<date>` ref
 * through the same rebase-and-retry the other session arms hand back to the caller.
 *
 * ## What a run touches
 *
 * The ref must sit under `refs/heads/curate/` and must not be the branch `HEAD` points at: the
 * command's contract is that a run lands on its own branch and never on `main`, with `curate merge`
 * the only way back, and `commitSession` syncs the checkout of any ref `HEAD` names, so both are
 * refused here before a session opens (`run.ts` refuses the first at exit 2 from the argv alone).
 *
 * The head is loaded at the base (`main`'s tip, or the session's own base on `--resume`), the
 * session is started on the curator ref (refused with `session.exists` unless `--resume`), and every
 * tool judges its writes the way a curator's commit would, under the `curate` scope: an op carrying
 * any violation is refused with the violations handed back to the model, and a clean one is
 * appended. A link a script splices into a file's head in the sandbox is harvested as a `link` op,
 * and one it cuts as an `unlink` op, so an edge can be placed or dropped from code mode without a
 * `propose`. `exec` and `propose`
 * refuse alike, `duplicate` and `claim-edit` included, because a curator's own ref has no rebase
 * that cures them (the ref does not exist before the first commit), so an appended op the commit
 * refuses would poison the log for every `--resume` after it. A dry run keeps the same shape over an
 * in-memory overlay so the model's experience is identical, and writes no session, no ref, and no
 * commit; `--dry-run --resume` seeds that overlay from the session's log and leaves the log as it
 * was.
 *
 * ## The commit
 *
 * The session lands with `memhtml(curate): <first line of the report>`. `rebase-needed` is retried
 * up to {@link COMMIT_ATTEMPTS} times with the base moved to the ref's tip; `refused` fails the
 * command naming the violations (the log stays for `--resume`); `worktree-dirty` is `ERR_DIRTY_TREE`.
 * A run the model stopped (`modelError`) fails as `ERR_MODEL_UNAVAILABLE` without committing, and
 * the ops it appended stay in the session for a `--resume`.
 */

/** How many `rebase-needed` answers the landing tolerates before it gives up. */
export const COMMIT_ATTEMPTS = 8

/**
 * The scope every judgment in this module runs under: the harvester, `validateOps`, and
 * `commitSession` all see `curate`, so the arcs and people prefixes the charter asks the curator to
 * write (`areas/arcs/` syntheses, `resources/people/` identity records) are writable here and
 * nowhere else. `.memhtml/` and the generated filenames stay refused under every scope.
 */
export const CURATE_SCOPE: CommitScope = "curate"

export const CURATE_REF_PREFIX = "curate/"

/** The full prefix every curator ref lives under. */
export const CURATE_REF_ROOT = `refs/heads/${CURATE_REF_PREFIX}`

/**
 * Why `ref` cannot be a curator ref, or `undefined` when it can. The qualified form must be under
 * {@link CURATE_REF_ROOT} with a name after it; `main`, `refs/heads/main`, a feature branch, or a tag
 * under `refs/tags/curate/` are each refused. `run.ts` applies this at exit 2 and {@link curateRun}
 * again, so a caller that skips the CLI cannot land model output on the system of record.
 */
export const curateRefProblem = (ref: string): string | undefined => {
  const qualified = qualifyRef(ref)
  if (qualified === CURATE_REF_ROOT || !qualified.startsWith(CURATE_REF_ROOT)) {
    return `${qualified} is not under ${CURATE_REF_ROOT}: the curator commits to its own curate/<date> branch and never to main or any other ref, and curate merge is the only way back`
  }
  return undefined
}

/** `curate/<UTC date>` for `now`. */
export const defaultCurateRef = (now: Date): string =>
  `${CURATE_REF_PREFIX}${now.toISOString().slice(0, 10)}`

/**
 * The session id for a curator ref: the ref without `refs/heads/`, slashes as dashes, so
 * `refs/heads/curate/2026-09-23` is `curate-2026-09-23`, one path segment as `SESSION_ID` wants.
 */
export const curateSessionId = (ref: string): string =>
  qualifyRef(ref)
    .replace(/^refs\/heads\//, "")
    .replaceAll("/", "-")

export interface CurateRunInput {
  readonly root: string
  readonly ref?: string | undefined
  /** The model spec, already resolved by `run.ts` (`fake`, `bedrock:<id>`, `proxy:<model>`). */
  readonly model: string
  readonly maxSteps?: number | undefined
  readonly wallClockMs?: number | undefined
  readonly dryRun: boolean
  readonly resume: boolean
  /** The clock, injectable for a test that pins the ref's date and the archive year. */
  readonly now?: (() => Date) | undefined
}

export interface OpsByKind {
  readonly put: number
  readonly archive: number
  readonly link: number
  readonly unlink: number
}

export interface CurateRunReport {
  readonly ref: string
  readonly sessionId: string
  readonly baseSha: string
  readonly model: string
  readonly dryRun: boolean
  readonly resumed: boolean
  /** The landed commit, or `null` on a dry run, on zero ops, or when the model stopped the run. */
  readonly commit: string | null
  /** `committed`, `dry-run`, or `no-ops`. */
  readonly outcome: "committed" | "dry-run" | "no-ops"
  readonly steps: number
  readonly tokens: { readonly input: number; readonly output: number }
  readonly stoppedBy: StoppedBy
  /**
   * Ops in the session after the run (a dry run: the ops that would have been appended, on top of
   * a resumed session's own).
   */
  readonly ops: OpsByKind
  readonly report: string
  readonly toolCalls: ReadonlyArray<string>
  /** Rebase rounds the landing needed. */
  readonly rebases: number
  /** The snapshot written for the landed commit, `null` when nothing was committed or the write failed. */
  readonly snapshot: SnapshotWritten | null
  readonly head: HeadStats
  readonly briefing: Briefing
  /** The command that lands the branch on `main`. */
  readonly next: string
}

const opsByKind = (ops: ReadonlyArray<OverlayOp>): OpsByKind => ({
  put: ops.filter((op) => op.kind === "put").length,
  archive: ops.filter((op) => op.kind === "archive").length,
  link: ops.filter((op) => op.kind === "link").length,
  unlink: ops.filter((op) => op.kind === "unlink").length
})

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

/**
 * The newest `refs/heads/curate/*` other than `current`, with its commit date, or `null`.
 * `for-each-ref` sorted by committer date, newest first; a repo with no such ref answers nothing.
 */
const lastCurateRef = (
  root: string,
  current: string
): Effect.Effect<Briefing["lastCurate"], GitFailure> =>
  makeGit(root)
    .run([
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%09%(committerdate:iso-strict)",
      `refs/heads/${CURATE_REF_PREFIX}`
    ])
    .pipe(
      Effect.map((out) => {
        for (const line of out.split("\n")) {
          const [ref, date] = line.split("\t")
          if (ref === undefined || ref === "" || ref === current || date === undefined) continue
          return { ref, date }
        }
        return null
      })
    )

/** The branch `HEAD` points at as a full ref, or `null` when detached. */
const headRefOf = (root: string): Effect.Effect<string | null, GitFailure> =>
  makeGit(root)
    .run(["symbolic-ref", "-q", "HEAD"])
    .pipe(
      Effect.map((out) => (out.trim() === "" ? null : out.trim())),
      // `-q` exits 1 for a detached HEAD; that is "no branch", not a failure.
      Effect.catchTag("GitFailure", (failure) =>
        failure.exitCode === 1 ? Effect.succeed(null) : Effect.fail(failure)
      )
    )

/** A record as `read` shows it: every parsed field plus the bytes, minus the index-only ones. */
const recordView = (view: HeadView, path: string): CuratorRecordView | null => {
  const record = view.get(path)
  if (record === undefined) return null
  return {
    path: record.path,
    title: record.title,
    claim: record.claim,
    memoryType: record.memoryType,
    status: record.status,
    frameKey: record.frameKey,
    confidence: record.confidence,
    importance: record.importance,
    tags: record.tags,
    entities: record.entities,
    links: record.links,
    archived: record.archived,
    html: record.html
  }
}

/**
 * The overlay the tools append to: a real session on disk, or an in-memory list under `--dry-run`.
 * One shape for both so the tool bindings below do not branch on the mode. Exported for the binder's
 * own tests; nothing outside this app composes one.
 */
export interface Overlay {
  readonly ops: () => ReadonlyArray<OverlayOp>
  readonly append: (ops: ReadonlyArray<OverlayOp>) => Effect.Effect<void, StorageFailure>
  readonly session: () => Session | null
}

/** An in-memory overlay, seeded with `initial` (a resumed session's ops under `--dry-run`). */
export const memoryOverlay = (initial: ReadonlyArray<OverlayOp> = []): Overlay => {
  const ops: Array<OverlayOp> = [...initial]
  return {
    ops: () => ops,
    append: (more) =>
      Effect.sync(() => {
        ops.push(...more)
      }),
    session: () => null
  }
}

const sessionOverlay = (initial: Session): Overlay => {
  let session = initial
  return {
    ops: () => session.ops,
    append: (more) =>
      appendOps(session, more).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            session = next
          })
        ),
        Effect.asVoid
      ),
    session: () => session
  }
}

/**
 * Bind the five tools to a head, an overlay, and the sandbox. Exported so a test can drive `exec`
 * against a real sandbox and a hand-built head without a model.
 */
export const bindTools = (input: {
  readonly head: LoadedHead
  readonly overlay: Overlay
  readonly ref: string
}): CuratorTools => {
  const base = input.head.view
  const current = (): Effect.Effect<HeadView, InvalidMemoryType> =>
    withOverlay(base, input.overlay.ops())
  const promise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

  /**
   * Judge `ops` on top of what the overlay already holds. `violations` is everything `validateOps`
   * reports over the whole would-be batch; `blocking` is the subset the new ops are answerable for
   * (a path they touch, or the batch cap), and ANY of those refuses them. There is no non-blocking
   * kind here: `commitSession` refuses a session on any violation, and a curator's ref has no
   * rebase that cures `duplicate` or `claim-edit`, so an op appended with one would make the
   * session uncommittable for every `--resume` after it.
   */
  const judge = (
    ops: ReadonlyArray<OverlayOp>
  ): { violations: ReadonlyArray<Violation>; blocking: ReadonlyArray<Violation> } => {
    const touched = new Set(ops.flatMap(touchedPaths))
    const violations = validateOps(base, [...input.overlay.ops(), ...ops], { scope: CURATE_SCOPE })
    return {
      violations,
      blocking: violations.filter(
        (violation) => violation.kind === "batch-cap" || touched.has(violation.path)
      )
    }
  }

  return {
    search: (query, limit): Promise<ReadonlyArray<CuratorSearchHit>> =>
      promise(
        current().pipe(
          Effect.map((view) =>
            searchHead(view, { query, limit }).map((hit) => ({
              path: hit.path,
              score: hit.score,
              claim: hit.claim
            }))
          )
        )
      ),
    read: (path): Promise<CuratorRecordView | null> =>
      promise(current().pipe(Effect.map((view) => recordView(view, path)))),
    exec: (script): Promise<CuratorExecResult> =>
      promise(
        Effect.gen(function* () {
          const view = yield* current()
          const report = yield* runSessionExec({ view, script, scope: CURATE_SCOPE })
          const { violations, blocking } = judge(report.ops)
          const clean = report.exitCode === 0 && blocking.length === 0
          if (clean && report.ops.length > 0) yield* input.overlay.append(report.ops)
          return {
            exitCode: report.exitCode,
            stdout: report.stdout,
            stderr: report.stderr,
            durationMs: report.durationMs,
            timedOut: report.timedOut,
            ops: report.ops.map((op) =>
              op.kind === "archive"
                ? { kind: op.kind, path: op.path, to: op.to }
                : { kind: op.kind, path: op.path }
            ),
            appended: clean ? report.ops.length : 0,
            rejected: report.rejected,
            violations
          }
        })
      ),
    propose: (ops): Promise<CuratorProposeResult> =>
      promise(
        Effect.gen(function* () {
          // The same refusal `exec` applies: any violation the new ops are answerable for refuses
          // the proposal, and the model is the party that can change it.
          const violations = judge(ops).blocking
          if (violations.length > 0) return { appended: 0, violations }
          yield* input.overlay.append(ops)
          return { appended: ops.length, violations: [] }
        })
      ),
    status: (): Promise<CuratorSessionStatus> =>
      Promise.resolve({
        baseSha: input.head.sha,
        ref: input.ref,
        ops: opsByKind(input.overlay.ops())
      })
  }
}

/** Land the session: commit, rebase on `rebase-needed`, up to {@link COMMIT_ATTEMPTS} rounds. */
const land = (input: {
  readonly root: string
  readonly session: Session
  readonly head: LoadedHead
  readonly message: string
}): Effect.Effect<
  { readonly sha: string; readonly rebases: number; readonly head: LoadedHead },
  GitFailure | StorageFailure | InvalidMemory | DirtyTree
> =>
  Effect.gen(function* () {
    let session = input.session
    let head = input.head
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
      const outcome = yield* commitSession({
        session,
        head: head.view,
        message: input.message,
        scope: CURATE_SCOPE
      })
      switch (outcome.kind) {
        case "committed":
          return { sha: outcome.sha, rebases: attempt - 1, head }
        case "rebase-needed": {
          head = yield* loadHeadAt(input.root, outcome.mainSha)
          session = rebaseSession(session, head.view)
          yield* saveSession(session)
          break
        }
        case "refused":
          return yield* Effect.fail(
            InvalidMemory.make({
              reason: `curate run: the session's ops were refused at commit, so nothing landed and the log stays for --resume: ${outcome.violations.map(describeViolation).join(" | ")}`
            })
          )
        case "worktree-dirty":
          return yield* Effect.fail(DirtyTree.make({ paths: outcome.paths }))
      }
    }
    return yield* Effect.fail(
      InvalidMemory.make({
        reason: `curate run: ${session.ref} moved ${String(COMMIT_ATTEMPTS)} times while the session tried to land; nothing landed, and the log stays for --resume`
      })
    )
  })

/** The subject line: the report's first non-blank line, or a stated fallback. */
export const commitSummary = (report: string): string =>
  report
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "curator run"

export const curateRun = (
  input: CurateRunInput
): Effect.Effect<
  CurateRunReport,
  | GitFailure
  | StorageFailure
  | InvalidMemory
  | DirtyTree
  | ModelUnavailable
  | CuratorModelSpecInvalid
> =>
  Effect.gen(function* () {
    const now = input.now ?? (() => new Date())
    const ref = qualifyRef(
      input.ref === undefined || input.ref.trim() === "" ? defaultCurateRef(now()) : input.ref
    )
    const sessionId = curateSessionId(ref)

    // The ref is the whole safety story: refuse anything outside curate/ and anything checked out,
    // before a model is built or a session opens.
    const problem = curateRefProblem(ref)
    if (problem !== undefined) {
      return yield* Effect.fail(InvalidMemory.make({ reason: `curate run --ref: ${problem}` }))
    }
    const checkedOut = yield* headRefOf(input.root)
    if (checkedOut === ref) {
      return yield* Effect.fail(
        InvalidMemory.make({
          reason: `curate run --ref: ${ref} is checked out (HEAD names it), so a commit there would move the working tree; the curator writes only to a branch nobody has checked out`
        })
      )
    }

    const model = yield* curatorModel(input.model)

    // The base: the session's own on a resume, else main's tip, else HEAD (a repo with no `main`).
    // A dry run over a resumed session sees the session's ops through an in-memory overlay and never
    // touches the log, the ref, or a commit.
    let overlay: Overlay
    let head: LoadedHead
    if (input.resume) {
      const session = yield* resumeSession({ root: input.root, id: sessionId })
      head = yield* loadHeadAt(input.root, session.baseSha)
      overlay = input.dryRun ? memoryOverlay(session.ops) : sessionOverlay(session)
    } else {
      const mainSha =
        (yield* revParse(input.root, "refs/heads/main")) ??
        (yield* makeGit(input.root).revParseHead())
      if (mainSha === null) {
        return yield* Effect.fail(
          InvalidMemory.make({
            reason: `${input.root} has no commit: a curator needs a version to see`
          })
        )
      }
      head = yield* loadHeadAt(input.root, mainSha)
      overlay = input.dryRun
        ? memoryOverlay()
        : sessionOverlay(
            yield* startSession({ root: input.root, id: sessionId, base: head.view, ref })
          )
    }

    const startView = yield* withOverlay(head.view, overlay.ops())
    const briefing = briefingFromView(startView, yield* lastCurateRef(input.root, ref))
    const tools = bindTools({ head, overlay, ref })

    const run: CuratorRun = yield* runCurator({
      tools,
      model,
      briefing,
      budget: {
        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
        ...(input.wallClockMs === undefined ? {} : { wallClockMs: input.wallClockMs })
      },
      now
    })

    if (run.stoppedBy === "modelError") {
      return yield* Effect.fail(
        ModelUnavailable.make({
          modelId: input.model,
          reason: `${run.error ?? "the model call failed"}; ${String(overlay.ops().length)} op(s) stay in session ${sessionId} for --resume`
        })
      )
    }

    const base = {
      ref,
      sessionId,
      baseSha: head.sha,
      model: input.model,
      dryRun: input.dryRun,
      resumed: input.resume,
      steps: run.steps,
      tokens: { input: run.inputTokens, output: run.outputTokens },
      stoppedBy: run.stoppedBy,
      ops: opsByKind(overlay.ops()),
      report: run.report,
      toolCalls: run.toolCalls,
      head: headStats(head),
      briefing,
      next: `memhtml curate merge ${ref}`
    }

    const session = overlay.session()
    if (session === null) {
      return { ...base, commit: null, outcome: "dry-run", rebases: 0, snapshot: null }
    }
    if (session.ops.length === 0) {
      return { ...base, commit: null, outcome: "no-ops", rebases: 0, snapshot: null }
    }

    const landed = yield* land({
      root: input.root,
      session,
      head,
      message: commitSummary(run.report)
    })
    // The curator's ref moved: cache its version so `curate merge` loads both tips from snapshots.
    const snapshot = yield* snapshotAfterCommit(input.root, landed.sha, landed.head.view)
    return {
      ...base,
      commit: landed.sha,
      outcome: "committed",
      rebases: landed.rebases,
      snapshot
    }
  })

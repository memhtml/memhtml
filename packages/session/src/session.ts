import { access, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { StorageFailure } from "@memhtml/contracts"
import { Effect, Schema } from "effect"
import { lock } from "proper-lockfile"
import writeFileAtomic from "write-file-atomic"

import { GitFailure } from "./errors.js"
import { ensureExcludedQuietly } from "./exclude.js"
import { makePlumbing } from "./plumbing.js"
import { settlePending } from "./settle.js"

/**
 * A session: a pointer to a base version, an overlay log of its own operations, and nothing else.
 * Its durable twin on disk is one file, `<root>/.memhtml/sessions/<id>.json`, the log, under
 * `.memhtml/`, which the store's scaffold gitignores. A commit stages through a temporary index file
 * of its own that it removes on every outcome (`commit.ts`), so nothing else is kept between calls.
 *
 * One writer per id at a time. Every write to the log and the whole of a commit run under
 * {@link withSessionLock}, an exclusive lock at `<id>.lock` (proper-lockfile: an atomic `mkdir`,
 * its mtime refreshed while held so a lock left by a killed process goes stale and is reclaimed by
 * the next writer of the same id). A second writer does not wait: it fails with `session.locked`,
 * because a second commit of the same id would race the first for the log's `pending` and its ref.
 * A lock left by a killed process under an id nobody uses again (a run's) is never reclaimed by a
 * writer, which is why `pruneSessions` removes stale lock directories.
 *
 * Every write replaces the whole file, and a caller computes what it writes from the log it read
 * earlier, outside the lock (a `session exec` reads the log, runs a script for seconds, then
 * appends its harvest). So the lock alone would still lose an update: two execs that read the same
 * log each append to it, and the second write drops the first's ops. Every writer therefore re-reads
 * the log under the lock and writes only when the file still holds the ops the caller read
 * ({@link requireLogUnmoved}); a log whose ops changed is refused with {@link LOG_MOVED} and
 * nothing is written, so the caller reads it again and decides. The ops are what is compared, not
 * the base: {@link rebaseSession} is pure and a caller may commit or append over a rebased session
 * it has not saved, which moves the base on purpose.
 *
 * A log that carries `pending` (a commit killed after it wrote its intent) holds exactly the ops that
 * commit built, and the next commit clears them when it finds the commit landed. So no write adds
 * ops beside a `pending`: {@link appendOps} settles it first, and {@link replaceOps} refuses.
 */

export interface Session {
  /** The repository root. Not persisted: the log is found by root plus id, so it cannot disagree. */
  readonly root: string
  readonly id: string
  readonly baseSha: string
  /** `refs/heads/main` by default; `refs/heads/curate/<date>` for a curator. */
  readonly ref: string
  readonly ops: ReadonlyArray<OverlayOp>
  /**
   * The commit a `commitSession` built and was about to land when the log was last written, or
   * absent. Written before the ref moves and cleared after, so a process killed between the two
   * leaves a record: the next commit checks whether it reached the ref and answers `committed` for
   * it instead of refusing the same ops as duplicates of themselves. An append settles it the same
   * way before it adds an op ({@link appendOps}).
   */
  readonly pending?: string | undefined
}

export const DEFAULT_REF = "refs/heads/main"

/** The directory every session's state lives under, relative to the repo root. */
export const SESSIONS_DIR = ".memhtml/sessions"

/** A session id must be one path segment, so it cannot escape {@link SESSIONS_DIR}. */
/** A session id: one path segment, so it can never leave `.memhtml/sessions/`. Shared with the CLI's usage check. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const isSessionId = (id: string): boolean => SESSION_ID.test(id)

/** How long a lock may go without an mtime refresh before another writer may reclaim it. */
export const SESSION_LOCK_STALE_MS = 30_000

export const sessionStateFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.json`)

/** The lock proper-lockfile takes is `<this>.lock`, beside the log. */
const sessionLockTarget = (root: string, id: string): string => join(root, SESSIONS_DIR, id)

/**
 * The namespace a session commit once recorded provenance under (`refs/memhtml/sessions/<id>`). No
 * commit writes it: the `Memhtml-Session` trailer on every session commit names the id, and nothing
 * read the refs. `pruneSessions` removes the ones a store still carries.
 */
export const SESSION_REFS_PREFIX = "refs/memhtml/sessions/"

/**
 * One `OverlayOp` as JSON: the log's schema, and the head server's for every route that carries a
 * session's ops (`/v1/neighbors` in `apps/cli/src/head-protocol.ts`), so the log and the wire decode
 * the same kinds and a kind the log gains is one the wire reads.
 */
export const OverlayOpSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("put"), path: Schema.String, html: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("archive"),
    path: Schema.String,
    to: Schema.String,
    html: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("link"),
    path: Schema.String,
    rel: Schema.String,
    href: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("unlink"),
    path: Schema.String,
    rel: Schema.String,
    href: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("label"), path: Schema.String, entity: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unlabel"), path: Schema.String, entity: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("move"),
    path: Schema.String,
    to: Schema.String,
    html: Schema.String
  })
])

/**
 * Every `OverlayOp` kind has a branch above. A kind the contract gains and this union lacks is
 * written to the log by `appendOps` and refused by `resumeSession` with `session.decode`, so every
 * later call on the session fails; this makes the gap a type error at the line that should change.
 */
const everyKindDecodes: [
  Exclude<OverlayOp["kind"], (typeof OverlayOpSchema.Type)["kind"]>
] extends [never]
  ? true
  : never = true
void everyKindDecodes

const SessionState = Schema.Struct({
  id: Schema.String,
  baseSha: Schema.String,
  ref: Schema.String,
  ops: Schema.Array(OverlayOpSchema),
  pending: Schema.optional(Schema.String)
})

const decodeState = Schema.decodeUnknownEffect(SessionState, { onExcessProperty: "error" })

/** Wrap a filesystem call as a typed failure, logging the cause for an operator. */
const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`session.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation }))
  )

const checkId = (id: string): Effect.Effect<void, StorageFailure> =>
  SESSION_ID.test(id)
    ? Effect.void
    : Effect.logError(`session id rejected: ${JSON.stringify(id)}`).pipe(
        Effect.andThen(Effect.fail(StorageFailure.make({ operation: "session.id" })))
      )

const ensureDir = (root: string): Effect.Effect<void, StorageFailure> =>
  attemptIo("session.mkdir", () => mkdir(join(root, SESSIONS_DIR), { recursive: true }))

/** Test seams for {@link withSessionLock}. */
export interface SessionLockOptions {
  /**
   * How often the holder refreshes the lock's mtime, in milliseconds; proper-lockfile's default (half
   * of {@link SESSION_LOCK_STALE_MS}) unless a test shortens it to see a refresh happen.
   */
  readonly updateMs?: number | undefined
}

/**
 * Run `effect` holding the session's exclusive lock. A lock already held fails with
 * `session.locked` at once rather than waiting: the holder is another writer of the same id, and
 * the right answer for a double-submitted command is a refusal, not a second commit.
 *
 * A lock that is compromised while held (its directory removed, or its mtime moved by another
 * writer that judged it stale, because this holder missed its refreshes for
 * {@link SESSION_LOCK_STALE_MS}) is logged as a warning when the holder finishes, rather than
 * proper-lockfile's default of throwing from its refresh timer, which would kill the process
 * mid-commit: in `head serve` that is every request in flight. The effect runs to its end either
 * way, as it would have without the lock's loss being noticed; the release that follows touches
 * nothing another writer took.
 */
export const withSessionLock = <A, E, R>(
  root: string,
  id: string,
  effect: Effect.Effect<A, E, R>,
  options: SessionLockOptions = {}
): Effect.Effect<A, E | StorageFailure, R> =>
  Effect.gen(function* () {
    yield* checkId(id)
    yield* ensureDir(root)
    let compromised: string | null = null
    const acquire = Effect.tryPromise({
      try: () =>
        lock(sessionLockTarget(root, id), {
          realpath: false,
          retries: 0,
          stale: SESSION_LOCK_STALE_MS,
          ...(options.updateMs === undefined ? {} : { update: options.updateMs }),
          onCompromised: (error) => {
            compromised = error.message
          }
        }),
      catch: (cause) => cause
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logError(
          `session ${id} is locked by another writer: ${String((cause as Error)?.message ?? cause)}`
        )
      ),
      Effect.mapError(() => StorageFailure.make({ operation: "session.locked" }))
    )
    return yield* Effect.acquireUseRelease(
      acquire,
      () => effect,
      (release) =>
        Effect.promise(() => release().catch(() => undefined)).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              compromised === null
                ? Effect.void
                : Effect.logWarning(
                    `session ${id}: its lock ${sessionLockTarget(root, id)}.lock was compromised while held (${compromised}); another writer may have written the log meanwhile`
                  )
            )
          )
        )
    )
  })

/**
 * Persist the log. Written to a temp file and renamed into place, so a reader (`session status`,
 * `resumeSession`) never sees a half-written JSON; the writer side is serialized by the lock.
 */
const writeState = (session: Session): Effect.Effect<void, StorageFailure> =>
  attemptIo("session.write", async () => {
    const file = sessionStateFile(session.root, session.id)
    const state = {
      id: session.id,
      baseSha: session.baseSha,
      ref: session.ref,
      ops: session.ops,
      ...(session.pending === undefined ? {} : { pending: session.pending })
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" })
  })

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false
    )
  )

/**
 * Start a session on a base version. Creates the state directory, checks that the base names a
 * commit (`rev-parse`; a `GitFailure` when it does not), and writes an empty log. Fails when the id
 * is not a single path segment.
 *
 * An id that already has a log is refused with `session.exists` unless `force` is set: a retried
 * `session start` or two agents choosing one id would otherwise replace an in-progress overlay with
 * an empty one and report success. `resumeSession` is the way to reopen a log; `force` is the way to
 * discard one on purpose.
 *
 * Only the base's `sha` is read (for the check and the log), so a caller that has no head loaded
 * passes `{ sha }`: the implicit start of `session put` and `session exec` under `MEMHTML_SESSION`
 * costs a `rev-parse` rather than a head load. A `HeadView` with its sha still fits.
 */
export const startSession = (input: {
  readonly root: string
  readonly id: string
  readonly base: { readonly sha: string }
  readonly ref?: string | undefined
  readonly force?: boolean | undefined
}): Effect.Effect<Session, GitFailure | StorageFailure> =>
  withSessionLock(
    input.root,
    input.id,
    Effect.gen(function* () {
      const session: Session = {
        root: input.root,
        id: input.id,
        baseSha: input.base.sha,
        ref: input.ref ?? DEFAULT_REF,
        ops: []
      }
      if (input.force !== true && (yield* exists(sessionStateFile(input.root, input.id)))) {
        yield* Effect.logError(
          `session ${input.id} already has a log at ${sessionStateFile(input.root, input.id)}; resume it, or start with force to discard it`
        )
        return yield* Effect.fail(StorageFailure.make({ operation: "session.exists" }))
      }
      // The first write under `.memhtml/sessions/`: make sure the clone ignores it (an older store's
      // committed `.gitignore` does not), before the log and the index file land there.
      yield* ensureExcludedQuietly(input.root, [`${SESSIONS_DIR}/`])
      if ((yield* makePlumbing({ root: input.root }).revParse(input.base.sha)) === null) {
        yield* Effect.logError(`session ${input.id}: base ${input.base.sha} names no commit`)
        return yield* Effect.fail(GitFailure.make({ command: "rev-parse", exitCode: 1 }))
      }
      yield* writeState(session)
      return session
    })
  )

/**
 * A log's text as the session state it holds, for the session `id` it must name. Not JSON is
 * `session.parse`, not a log is `session.decode`, another id's log is `session.id-mismatch`.
 */
export const decodeLog = (
  raw: string,
  id: string
): Effect.Effect<Omit<Session, "root">, StorageFailure> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => StorageFailure.make({ operation: "session.parse" })
    })
    const state = yield* decodeState(parsed).pipe(
      Effect.mapError(() => StorageFailure.make({ operation: "session.decode" }))
    )
    if (state.id !== id) {
      return yield* Effect.fail(StorageFailure.make({ operation: "session.id-mismatch" }))
    }
    const { pending, ...rest } = state
    return { ...rest, ...(pending === undefined ? {} : { pending }) }
  })

/** Reopen a session from its log. A missing or malformed log is a `StorageFailure`. */
export const resumeSession = (input: {
  readonly root: string
  readonly id: string
}): Effect.Effect<Session, StorageFailure> =>
  Effect.gen(function* () {
    yield* checkId(input.id)
    const raw = yield* attemptIo("session.read", () =>
      readFile(sessionStateFile(input.root, input.id), "utf8")
    )
    const state = yield* decodeLog(raw, input.id)
    return { root: input.root, ...state }
  })

/** The failure a writer gets when the log changed between its read and its write. */
export const LOG_MOVED = "session.moved"

/**
 * The prefix of the failure {@link replaceOps} gets over a log that carries a `pending` commit: the
 * whole operation is `session.pending: <what to do>`, naming the `session commit` that settles it.
 */
export const SESSION_PENDING = "session.pending"

/**
 * Holding the session's lock: the log as stored, after failing with {@link LOG_MOVED} unless it still
 * holds the ops `expected` holds. The caller read `expected` before it took the lock, so ops another
 * writer appended or committed meanwhile are refused here rather than overwritten.
 */
const readUnmoved = (expected: Session): Effect.Effect<Session, StorageFailure> =>
  Effect.gen(function* () {
    const stored = yield* resumeSession({ root: expected.root, id: expected.id })
    if (JSON.stringify(stored.ops) === JSON.stringify(expected.ops)) return stored
    yield* Effect.logError(
      `session ${expected.id}: the log changed since this call read it (${String(expected.ops.length)} ops then, ${String(stored.ops.length)} now, base ${stored.baseSha}); another put, exec, commit, or rebase wrote it, so nothing was written`
    )
    return yield* Effect.fail(StorageFailure.make({ operation: LOG_MOVED }))
  })

/**
 * Holding the session's lock: fail with {@link LOG_MOVED} unless the log on disk still holds the
 * ops `expected` holds. The caller read `expected` before it took the lock, so ops another writer
 * appended or committed meanwhile are refused here rather than overwritten.
 */
export const requireLogUnmoved = (expected: Session): Effect.Effect<void, StorageFailure> =>
  Effect.asVoid(readUnmoved(expected))

/**
 * Holding the session's lock: `session` with the stored log's `pending` commit settled
 * (`settlePending`, the commit's own step 0, under the checkout lock). A log carries `pending` when a
 * commit was killed between writing it and clearing it, or failed to write the cleared log after its
 * ref moved; its ops are the ones that commit built. Landed: the session moves to that commit with
 * zero ops, since its ops are on the ref. Not landed: any checkout update it made is undone and the
 * ops stay. Either way `pending` is gone, so an append lands its ops on top of what is settled rather
 * than beside a `pending` the next commit would clear together with them.
 *
 * A git failure while settling is `session.settle`, with nothing written.
 */
const settleStored = (session: Session, stored: Session): Effect.Effect<Session, StorageFailure> =>
  Effect.gen(function* () {
    const pending = stored.pending
    if (pending === undefined) return { ...session, pending: undefined }
    const settled = yield* settlePending({
      root: session.root,
      git: makePlumbing({ root: session.root }),
      ref: stored.ref,
      pending
    }).pipe(
      Effect.catchTag("GitFailure", (failure) =>
        Effect.logError(
          `session ${session.id}: settling pending commit ${pending} failed (git ${failure.command}); nothing was written`
        ).pipe(Effect.andThen(Effect.fail(StorageFailure.make({ operation: "session.settle" }))))
      )
    )
    if (settled.landed) {
      yield* Effect.logWarning(
        `session ${session.id}: pending commit ${pending} had landed on ${stored.ref} (an earlier commit stopped before it cleared the log); its ${String(stored.ops.length)} ops are on the ref, and the session now sits on that commit`
      )
      return { ...session, baseSha: pending, ops: [], pending: undefined }
    }
    yield* Effect.logWarning(
      `session ${session.id}: pending commit ${pending} never reached ${stored.ref}; its checkout update, if any, was undone and its ${String(stored.ops.length)} ops stay in the log`
    )
    return { ...session, pending: undefined }
  })

/**
 * Append to the overlay log and persist it. The returned session is the one to keep using. Refused
 * with {@link LOG_MOVED} when the log is no longer the one `session` was read from.
 *
 * A log that carries a `pending` commit is settled first ({@link settleStored}): when that commit had
 * landed, the returned session sits on it (its `baseSha` is the landed commit) and holds only `ops`;
 * otherwise it keeps its ops and gains `ops`. So an op appended after a commit was killed past its
 * swap is committed by the next `session commit` rather than cleared with the landed ops.
 */
export const appendOps = (
  session: Session,
  ops: ReadonlyArray<OverlayOp>
): Effect.Effect<Session, StorageFailure> =>
  withSessionLock(
    session.root,
    session.id,
    Effect.gen(function* () {
      const settled = yield* settleStored(session, yield* readUnmoved(session))
      const next: Session = { ...settled, ops: [...settled.ops, ...ops] }
      yield* writeState(next)
      return next
    })
  )

/**
 * Move the session's base to a newer version, keeping its ops. Pure: the log on disk moves when the
 * caller next appends or commits, and validation of the kept ops happens at that commit.
 */
export const rebaseSession = (
  session: Session,
  onto: HeadView & { readonly sha: string }
): Session => ({ ...session, baseSha: onto.sha })

/**
 * Persist a rebased or otherwise changed session without appending. Takes the session's lock, and is
 * refused with {@link LOG_MOVED} when the log's ops are no longer `session`'s: a rebase keeps every
 * op it read, so an op appended since would otherwise be dropped.
 */
export const saveSession = (session: Session): Effect.Effect<void, StorageFailure> =>
  withSessionLock(
    session.root,
    session.id,
    requireLogUnmoved(session).pipe(Effect.andThen(writeState(session)))
  )

/**
 * Replace the overlay log's ops with `ops`, keeping the base and the ref. The one way ops leave a log
 * short of a commit: `session commit --drop-refused` takes out the ops a rebase revealed as
 * unlandable (a `duplicate` or a `claim-edit` against what `main` gained meanwhile) so the rest can
 * land, and writes back the kept ops with the repoints a drop took from them appended again
 * (`missingRepoints`). Short of this, ops are only ever appended. Refused with {@link LOG_MOVED},
 * like every other log write, when the log is no longer the one `session` was read from, so a put
 * or exec that landed meanwhile is never lost.
 *
 * Also refused, with `session.pending: ...` ({@link SESSION_PENDING}) and nothing written, when the
 * stored log carries a `pending` commit. `ops` was computed from ops that commit built, and when it
 * landed they are on the ref, so writing them back would commit them twice (or record them as
 * dropped); the commit that settles `pending` decides that, and the failure names it. A commit settles
 * `pending` before it refuses anything, so this is reached only when another commit of the same
 * session ran between the refusal and the replacement.
 */
export const replaceOps = (
  session: Session,
  ops: ReadonlyArray<OverlayOp>
): Effect.Effect<Session, StorageFailure> =>
  withSessionLock(
    session.root,
    session.id,
    Effect.gen(function* () {
      const stored = yield* readUnmoved(session)
      if (stored.pending !== undefined) {
        return yield* Effect.fail(
          StorageFailure.make({
            operation: `${SESSION_PENDING}: session ${session.id} carries pending commit ${stored.pending}, which an earlier commit built and may have landed, so its ops were not replaced; run \`memhtml session commit --id ${session.id}\` to settle it`
          })
        )
      }
      const next: Session = { ...session, ops: [...ops], pending: undefined }
      yield* writeState(next)
      return next
    })
  )

/** Persist under a lock the caller already holds. For `commitSession`, which holds it throughout. */
export const saveSessionLocked = (session: Session): Effect.Effect<void, StorageFailure> =>
  writeState(session)

import { access, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { StorageFailure } from "@memhtml/contracts"
import { Effect, Schema } from "effect"
import { lock } from "proper-lockfile"
import writeFileAtomic from "write-file-atomic"

import type { GitFailure } from "./errors.js"
import { makePlumbing, type Plumbing } from "./plumbing.js"

/**
 * A session: a pointer to a base version, an overlay log of its own operations, and nothing else.
 * Its durable twin on disk is two files under `<root>/.memhtml/sessions/`: `<id>.idx`, the git index
 * the commit path stages into, and `<id>.json`, the log. Both sit under `.memhtml/`, which the
 * store's scaffold gitignores.
 *
 * One writer per id at a time. Every write to the log and the whole of a commit run under
 * {@link withSessionLock}, an exclusive lock at `<id>.lock` (proper-lockfile: an atomic `mkdir`,
 * its mtime refreshed while held so a lock left by a killed process goes stale and is reclaimed). A
 * second writer does not wait: it fails with `session.locked`, because a second commit of the same
 * id would stage into the same `.idx` mid-flight and could win the ref with a tree missing its puts.
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
   * it instead of refusing the same ops as duplicates of themselves.
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
const LOCK_STALE_MS = 30_000

export const sessionIndexFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.idx`)

export const sessionStateFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.json`)

/** The lock proper-lockfile takes is `<this>.lock`, beside the log. */
const sessionLockTarget = (root: string, id: string): string => join(root, SESSIONS_DIR, id)

/** The provenance ref a committed session leaves behind. */
export const sessionRef = (id: string): string => `refs/memhtml/sessions/${id}`

const OverlayOpSchema = Schema.Union([
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
  })
])

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

/**
 * Run `effect` holding the session's exclusive lock. A lock already held fails with
 * `session.locked` at once rather than waiting: the holder is another writer of the same id, and
 * the right answer for a double-submitted command is a refusal, not a second commit.
 */
export const withSessionLock = <A, E, R>(
  root: string,
  id: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | StorageFailure, R> =>
  Effect.gen(function* () {
    yield* checkId(id)
    yield* ensureDir(root)
    const release = yield* Effect.tryPromise({
      try: () =>
        lock(sessionLockTarget(root, id), { realpath: false, retries: 0, stale: LOCK_STALE_MS }),
      catch: (cause) => cause
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logError(
          `session ${id} is locked by another writer: ${String((cause as Error)?.message ?? cause)}`
        )
      ),
      Effect.mapError(() => StorageFailure.make({ operation: "session.locked" }))
    )
    return yield* effect.pipe(
      Effect.ensuring(Effect.promise(() => release().catch(() => undefined)))
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

/** The plumbing bound to a session's own index file. */
export const plumbingFor = (root: string, id: string): Plumbing =>
  makePlumbing({ root, indexFile: sessionIndexFile(root, id) })

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false
    )
  )

/**
 * Start a session on a base version. Creates the state directory, reads the base tree into the
 * session's index file, and writes an empty log. Fails when the id is not a single path segment.
 *
 * An id that already has a log is refused with `session.exists` unless `force` is set: a retried
 * `session start` or two agents choosing one id would otherwise replace an in-progress overlay with
 * an empty one and report success. `resumeSession` is the way to reopen a log; `force` is the way to
 * discard one on purpose.
 */
export const startSession = (input: {
  readonly root: string
  readonly id: string
  readonly base: HeadView & { readonly sha: string }
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
      yield* plumbingFor(input.root, input.id).readTree(input.base.sha)
      yield* writeState(session)
      return session
    })
  )

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
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => StorageFailure.make({ operation: "session.parse" })
    })
    const state = yield* decodeState(parsed).pipe(
      Effect.mapError(() => StorageFailure.make({ operation: "session.decode" }))
    )
    if (state.id !== input.id) {
      return yield* Effect.fail(StorageFailure.make({ operation: "session.id-mismatch" }))
    }
    const { pending, ...rest } = state
    return { root: input.root, ...rest, ...(pending === undefined ? {} : { pending }) }
  })

/** Append to the overlay log and persist it. The returned session is the one to keep using. */
export const appendOps = (
  session: Session,
  ops: ReadonlyArray<OverlayOp>
): Effect.Effect<Session, StorageFailure> => {
  const next: Session = { ...session, ops: [...session.ops, ...ops] }
  return withSessionLock(session.root, session.id, writeState(next)).pipe(Effect.as(next))
}

/**
 * Move the session's base to a newer version, keeping its ops. Pure: the log on disk moves when the
 * caller next appends or commits, and validation of the kept ops happens at that commit.
 */
export const rebaseSession = (
  session: Session,
  onto: HeadView & { readonly sha: string }
): Session => ({ ...session, baseSha: onto.sha })

/** Persist a rebased or otherwise changed session without appending. Takes the session's lock. */
export const saveSession = (session: Session): Effect.Effect<void, StorageFailure> =>
  withSessionLock(session.root, session.id, writeState(session))

/** Persist under a lock the caller already holds. For `commitSession`, which holds it throughout. */
export const saveSessionLocked = (session: Session): Effect.Effect<void, StorageFailure> =>
  writeState(session)

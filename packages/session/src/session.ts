import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { HeadView, OverlayOp } from "@memhtml/contracts"
import { StorageFailure } from "@memhtml/contracts"
import { Effect, Schema } from "effect"

import type { GitFailure } from "./errors.js"
import { makePlumbing, type Plumbing } from "./plumbing.js"

/**
 * A session: a pointer to a base version, an overlay log of its own operations, and nothing else.
 * Its durable twin on disk is two files under `<root>/.memhtml/sessions/`: `<id>.idx`, the git index
 * the commit path stages into, and `<id>.json`, the log. Both sit under `.memhtml/`, which the
 * store's scaffold gitignores.
 */

export interface Session {
  /** The repository root. Not persisted: the log is found by root plus id, so it cannot disagree. */
  readonly root: string
  readonly id: string
  readonly baseSha: string
  /** `refs/heads/main` by default; `refs/heads/curate/<date>` for a curator. */
  readonly ref: string
  readonly ops: ReadonlyArray<OverlayOp>
}

export const DEFAULT_REF = "refs/heads/main"

/** The directory every session's state lives under, relative to the repo root. */
export const SESSIONS_DIR = ".memhtml/sessions"

/** A session id must be one path segment, so it cannot escape {@link SESSIONS_DIR}. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const sessionIndexFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.idx`)

export const sessionStateFile = (root: string, id: string): string =>
  join(root, SESSIONS_DIR, `${id}.json`)

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
  ops: Schema.Array(OverlayOpSchema)
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

/** Persist the log. The whole file is rewritten, which is atomic enough for one writer per id. */
const writeState = (session: Session): Effect.Effect<void, StorageFailure> =>
  attemptIo("session.write", async () => {
    const file = sessionStateFile(session.root, session.id)
    const state = { id: session.id, baseSha: session.baseSha, ref: session.ref, ops: session.ops }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  })

/** The plumbing bound to a session's own index file. */
export const plumbingFor = (root: string, id: string): Plumbing =>
  makePlumbing({ root, indexFile: sessionIndexFile(root, id) })

/**
 * Start a session on a base version. Creates the state directory, reads the base tree into the
 * session's index file, and writes an empty log. Fails when the id is not a single path segment.
 */
export const startSession = (input: {
  readonly root: string
  readonly id: string
  readonly base: HeadView & { readonly sha: string }
  readonly ref?: string | undefined
}): Effect.Effect<Session, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    yield* checkId(input.id)
    const session: Session = {
      root: input.root,
      id: input.id,
      baseSha: input.base.sha,
      ref: input.ref ?? DEFAULT_REF,
      ops: []
    }
    yield* attemptIo("session.mkdir", () =>
      mkdir(join(input.root, SESSIONS_DIR), { recursive: true })
    )
    yield* plumbingFor(input.root, input.id).readTree(input.base.sha)
    yield* writeState(session)
    return session
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
    return { root: input.root, ...state }
  })

/** Append to the overlay log and persist it. The returned session is the one to keep using. */
export const appendOps = (
  session: Session,
  ops: ReadonlyArray<OverlayOp>
): Effect.Effect<Session, StorageFailure> => {
  const next: Session = { ...session, ops: [...session.ops, ...ops] }
  return writeState(next).pipe(Effect.as(next))
}

/**
 * Move the session's base to a newer version, keeping its ops. Pure: the log on disk moves when the
 * caller next appends or commits, and validation of the kept ops happens at that commit.
 */
export const rebaseSession = (
  session: Session,
  onto: HeadView & { readonly sha: string }
): Session => ({ ...session, baseSha: onto.sha })

/** Persist a rebased or otherwise changed session without appending. */
export const saveSession = (session: Session): Effect.Effect<void, StorageFailure> =>
  writeState(session)

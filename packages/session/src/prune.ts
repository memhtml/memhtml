import type { Dirent } from "node:fs"
import { open, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { StorageFailure } from "@memhtml/contracts"
import { Effect } from "effect"

import type { GitFailure } from "./errors.js"
import { makePlumbing } from "./plumbing.js"
import {
  decodeLog,
  isSessionId,
  SESSION_LOCK_STALE_MS,
  SESSION_REFS_PREFIX,
  SESSIONS_DIR,
  sessionStateFile,
  withSessionLock
} from "./session.js"

/**
 * `pruneSessions`: remove the session state a store accumulates and nothing reads again.
 *
 * Measured on a live store on 2026-10-18: 1,686 `<id>.idx` files (2.5 GB, a whole git index each,
 * written by every session start before commits staged through a temporary index), 1,579 refs
 * under `refs/memhtml/sessions/` (provenance no reader consulted; the commit trailer carries the
 * id), and three `<id>.lock` directories. A lock left by a process killed while it held the session
 * is reclaimed only by the next writer of the SAME id, and a run's id is never written again, so
 * those three were never going to go away on their own.
 *
 * What goes, each only when older than the cutoff:
 * - `<id>.idx` files (by mtime);
 * - refs under {@link SESSION_REFS_PREFIX} (by the committer time of the commit each names);
 * - `<id>.lock` directories that are also stale (no refresh for {@link SESSION_LOCK_STALE_MS}, so
 *   no live holder);
 * - `<id>.json` logs that hold zero ops (by mtime): a session whose commit landed, or that never
 *   wrote.
 *
 * What never goes: a log that holds ops. Its run wrote something that has not landed, so it is
 * listed under `unlanded` (id, op count, `pending`, age) for an operator to commit, and kept. The
 * `<id>.dropped.jsonl` trail of a `--drop-refused` commit is kept too.
 *
 * Every id is handled under its session lock (`withSessionLock`, fail-fast), so a writer of that id
 * (a `put`, an `exec`, a commit, including one from an older build that still stages through
 * `<id>.idx`) is never pruned from under: an id whose lock is held is listed under `busy` and left
 * alone, and what was read before the lock is read again under it. A stale lock directory is what
 * proper-lockfile reclaims on that acquisition, so taking the lock is also how one is removed.
 * `dryRun` takes no lock and removes nothing; it reports what a real run would remove.
 */

/** What one category of state amounts to: removed, or under `dryRun`, would be. */
export interface PruneCount {
  readonly count: number
}

/** One log that still holds ops: never removed. */
export interface UnlandedSession {
  readonly id: string
  readonly ops: number
  /** A commit an earlier call built and may have landed; `session commit` settles it. */
  readonly pending: string | null
  /** The log's last write. */
  readonly modifiedAt: string
  readonly ageMs: number
}

export interface PruneReport {
  readonly dryRun: boolean
  /** Everything last written before this instant is a candidate. */
  readonly cutoff: string
  readonly olderThanMs: number
  readonly indexes: PruneCount & { readonly bytes: number }
  readonly refs: PruneCount
  readonly locks: PruneCount
  readonly logs: PruneCount
  /** Logs older than the cutoff that still hold ops, oldest first. Kept. */
  readonly unlanded: ReadonlyArray<UnlandedSession>
  /** Ids whose session lock a live writer held: nothing of theirs was read or removed. */
  readonly busy: ReadonlyArray<string>
  /** Logs that do not decode as a session log: kept, for an operator to read. */
  readonly unreadable: ReadonlyArray<string>
}

/** A file's or directory's mtime in ms and size, or `null` when it is gone. */
interface Stamp {
  readonly mtimeMs: number
  readonly size: number
}

const stampOf = async (path: string): Promise<Stamp | null> => {
  try {
    const found = await stat(path)
    return { mtimeMs: found.mtimeMs, size: found.size }
  } catch {
    return null
  }
}

/**
 * A log's mtime and decoded state from ONE open file handle, so the age and the ops describe the same
 * file. `null` when there is no log.
 */
const readLog = async (
  path: string
): Promise<{ readonly mtimeMs: number; readonly text: string } | null> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, "r")
  } catch {
    return null
  }
  try {
    const found = await handle.stat()
    return { mtimeMs: found.mtimeMs, text: await handle.readFile("utf8") }
  } finally {
    await handle.close()
  }
}

const removeQuietly = async (remove: () => Promise<void>): Promise<boolean> => {
  try {
    await remove()
    return true
  } catch {
    return false
  }
}

/** What one id contributed, before the counts are summed. */
interface IdOutcome {
  readonly index: { readonly bytes: number } | null
  readonly lock: boolean
  readonly log: boolean
  readonly unlanded: UnlandedSession | null
  readonly busy: boolean
  readonly unreadable: boolean
}

const NOTHING: IdOutcome = {
  index: null,
  lock: false,
  log: false,
  unlanded: null,
  busy: false,
  unreadable: false
}

/** Which ids have state under the sessions directory, and which of them have a lock directory. */
const idsUnder = async (
  directory: string
): Promise<{ readonly ids: ReadonlyArray<string>; readonly locked: ReadonlySet<string> }> => {
  let entries: ReadonlyArray<Dirent>
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return { ids: [], locked: new Set() }
  }
  const ids = new Set<string>()
  const locked = new Set<string>()
  for (const entry of entries) {
    const name = entry.name
    for (const suffix of [".json", ".idx", ".lock"] as const) {
      if (!name.endsWith(suffix)) continue
      const id = name.slice(0, -suffix.length)
      if (!isSessionId(id)) continue
      ids.add(id)
      if (suffix === ".lock" && entry.isDirectory()) locked.add(id)
    }
  }
  return { ids: [...ids].sort(), locked }
}

/** At most this many ids are handled at once. */
const PRUNE_CONCURRENCY = 16

export const pruneSessions = (input: {
  readonly root: string
  readonly olderThanMs: number
  readonly dryRun?: boolean | undefined
  /** The instant ages are measured from; now unless a test pins it. */
  readonly now?: number | undefined
}): Effect.Effect<PruneReport, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    const dryRun = input.dryRun === true
    const now = input.now ?? Date.now()
    const cutoff = now - input.olderThanMs
    // A lock directory goes only when no live holder could still be refreshing it.
    const lockCutoff = now - Math.max(input.olderThanMs, SESSION_LOCK_STALE_MS)
    const directory = join(input.root, SESSIONS_DIR)
    const { ids, locked } = yield* Effect.promise(() => idsUnder(directory))

    /** Read, and outside a dry run remove, one id's state. Runs under the id's lock unless dry. */
    const settle = (id: string, lockIsStale: boolean): Effect.Effect<IdOutcome> =>
      Effect.promise(async () => {
        const indexFile = join(directory, `${id}.idx`)
        const logFile = sessionStateFile(input.root, id)
        let index: { readonly bytes: number } | null = null
        const indexStamp = await stampOf(indexFile)
        if (indexStamp !== null && indexStamp.mtimeMs < cutoff) {
          if (dryRun || (await removeQuietly(() => unlink(indexFile)))) {
            index = { bytes: indexStamp.size }
          }
        }
        const log = await readLog(logFile)
        if (log === null || log.mtimeMs >= cutoff) {
          return { ...NOTHING, index, lock: lockIsStale }
        }
        const state = await Effect.runPromise(Effect.result(decodeLog(log.text, id)))
        if (state._tag === "Failure")
          return { ...NOTHING, index, lock: lockIsStale, unreadable: true }
        if (state.success.ops.length > 0) {
          return {
            ...NOTHING,
            index,
            lock: lockIsStale,
            unlanded: {
              id,
              ops: state.success.ops.length,
              pending: state.success.pending ?? null,
              modifiedAt: new Date(log.mtimeMs).toISOString(),
              ageMs: Math.max(0, now - log.mtimeMs)
            }
          }
        }
        const removed = dryRun || (await removeQuietly(() => unlink(logFile)))
        return { ...NOTHING, index, lock: lockIsStale, log: removed }
      })

    const outcomes = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const lockStamp = locked.has(id)
            ? yield* Effect.promise(() => stampOf(join(directory, `${id}.lock`)))
            : null
          // A lock refreshed since the cutoff (or within the stale window) may have a live holder:
          // the id is busy, and nothing of it is read or removed.
          if (lockStamp !== null && lockStamp.mtimeMs >= lockCutoff) {
            return { ...NOTHING, busy: true }
          }
          const lockIsStale = lockStamp !== null
          if (dryRun) return yield* settle(id, lockIsStale)
          // Taking the lock reclaims a stale lock directory (proper-lockfile removes it and makes
          // its own), and releasing it removes that one: the stale directory is gone either way.
          return yield* withSessionLock(input.root, id, settle(id, lockIsStale)).pipe(
            // `session.locked`: a writer took the id after the listing. Leave it to that writer.
            Effect.catch(() => Effect.succeed({ ...NOTHING, busy: true }))
          )
        }),
      { concurrency: PRUNE_CONCURRENCY }
    )

    const git = makePlumbing({ root: input.root })
    const refs = (yield* git.forEachRef(SESSION_REFS_PREFIX)).filter(
      (entry) => entry.committedAt !== null && entry.committedAt * 1000 < cutoff
    )
    if (!dryRun) yield* git.deleteRefs(refs.map((entry) => entry.ref))

    const sum = (pick: (outcome: IdOutcome) => boolean): number => outcomes.filter(pick).length
    const unlanded = outcomes
      .flatMap((outcome) => (outcome.unlanded === null ? [] : [outcome.unlanded]))
      .sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id))
    return {
      dryRun,
      cutoff: new Date(cutoff).toISOString(),
      olderThanMs: input.olderThanMs,
      indexes: {
        count: sum((outcome) => outcome.index !== null),
        bytes: outcomes.reduce((total, outcome) => total + (outcome.index?.bytes ?? 0), 0)
      },
      refs: { count: refs.length },
      locks: { count: sum((outcome) => outcome.lock) },
      logs: { count: sum((outcome) => outcome.log) },
      unlanded,
      busy: ids.filter((_, at) => outcomes[at]?.busy === true),
      unreadable: ids.filter((_, at) => outcomes[at]?.unreadable === true)
    } satisfies PruneReport
  }).pipe(Effect.withSpan("session.prune"))

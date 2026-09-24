import { readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

import { StorageFailure } from "@memhtml/contracts"
import { Effect } from "effect"

import { SNAPSHOTS_DIR } from "./snapshot.js"

/**
 * The snapshot directory as a set: which commits have a snapshot, and which to keep.
 *
 * Every commit that moves a ref writes a snapshot for the new sha, so the directory grows by one
 * file per landing, each the size of the corpus. {@link pruneSnapshots} keeps the newest few by
 * mtime, because the newest is the one the next invocation hits exactly and the next-newest are the
 * ancestors a load can advance from; anything older is a cache of a version nobody will ask for.
 */

/** How many snapshots {@link pruneSnapshots} keeps by default. */
export const SNAPSHOTS_KEPT = 4

const SNAPSHOT_FILE = /^([0-9a-f]{40})\.arrow$/

export interface SnapshotEntry {
  readonly sha: string
  readonly path: string
  /** Modification time, UTC millis. */
  readonly mtimeMs: number
}

const attemptIo = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.tapError((cause) =>
      Effect.logError(`snapshot.${operation} failed: ${String((cause as Error)?.message ?? cause)}`)
    ),
    Effect.mapError(() => StorageFailure.make({ operation: `snapshot.${operation}` }))
  )

/**
 * Every `<sha>.arrow` under `<root>/.memhtml/snapshots/`, newest first by mtime, then by sha so
 * two files written in the same millisecond order the same way twice. A staging file (`.tmp`) or
 * any other name is not a snapshot and is not listed. A missing directory is the empty list.
 */
export const listSnapshots = (
  root: string
): Effect.Effect<ReadonlyArray<SnapshotEntry>, StorageFailure> =>
  Effect.gen(function* () {
    const directory = join(root, SNAPSHOTS_DIR)
    const names = yield* attemptIo("list", () =>
      readdir(directory).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [] as Array<string>
        throw cause
      })
    )
    const entries: Array<SnapshotEntry> = []
    for (const name of names) {
      const match = SNAPSHOT_FILE.exec(name)
      if (match === null) continue
      const sha = match[1]
      if (sha === undefined) continue
      const path = join(directory, name)
      const info = yield* attemptIo("list.stat", () => stat(path))
      entries.push({ sha, path, mtimeMs: info.mtimeMs })
    }
    return entries.sort(
      (left, right) => right.mtimeMs - left.mtimeMs || (left.sha < right.sha ? -1 : 1)
    )
  })

/** Remove every snapshot past the newest `keep`; the shas removed, newest first. */
export const pruneSnapshots = (
  root: string,
  options: { readonly keep?: number | undefined } = {}
): Effect.Effect<ReadonlyArray<string>, StorageFailure> =>
  Effect.gen(function* () {
    const keep = Math.max(0, options.keep ?? SNAPSHOTS_KEPT)
    const entries = yield* listSnapshots(root)
    const stale = entries.slice(keep)
    for (const entry of stale) {
      yield* attemptIo("prune.unlink", () =>
        unlink(entry.path).catch((cause: NodeJS.ErrnoException) => {
          // Another writer pruned it first; the end state is the one this call wanted.
          if (cause.code !== "ENOENT") throw cause
        })
      )
    }
    return stale.map((entry) => entry.sha)
  })

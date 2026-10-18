import { readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

/**
 * Staging files the cache writers leave behind.
 *
 * Both writers stage through `write-file-atomic`, whose staging name is the target's plus a suffix
 * unique to the process, thread, and call (`<file>.<number>`), and which removes its staging file
 * when the process exits on a signal. A process killed outright (SIGKILL, a power cut) leaves the
 * staging file where it was, the size of a whole cache, and no later write reuses its name, so
 * the writers sweep the ones old enough that no write can still own them.
 */

/** A `Buffer` over `bytes` without a copy, the shape `write-file-atomic`'s types take. */
export const bufferOf = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * How old a staging file is before a sweep removes it. A snapshot of 8,245 records (43 MB) is
 * written in 338 ms (`docs/design.md` §20, "Loading from snapshots"), so an hour is no write in
 * flight.
 */
export const STAGING_ABANDONED_MS = 60 * 60 * 1000

/**
 * Remove every file in `directory` whose name `isStaging` accepts and whose mtime is more than
 * {@link STAGING_ABANDONED_MS} before `now`; the names removed. Never fails: a sweep is
 * housekeeping beside a write that already succeeded, so a directory it cannot read or a file it
 * cannot remove is a log line.
 */
export const sweepStaging = (
  directory: string,
  isStaging: (name: string) => boolean,
  now: number = Date.now()
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: async () => {
      const names = await readdir(directory).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [] as Array<string>
        throw cause
      })
      const removed: Array<string> = []
      for (const name of names) {
        if (!isStaging(name)) continue
        const path = join(directory, name)
        const info = await stat(path).catch(() => null)
        if (info === null || now - info.mtimeMs <= STAGING_ABANDONED_MS) continue
        await unlink(path).catch((cause: NodeJS.ErrnoException) => {
          // Another sweep took it first; the end state is the one this call wanted.
          if (cause.code !== "ENOENT") throw cause
        })
        removed.push(name)
      }
      return removed
    },
    catch: (cause) => cause
  }).pipe(
    Effect.tap((removed) =>
      removed.length === 0
        ? Effect.void
        : Effect.logWarning(
            `removed ${String(removed.length)} abandoned staging file(s) in ${directory}: ${removed.join(", ")}`
          )
    ),
    Effect.catch((cause) =>
      Effect.logWarning(
        `sweeping staging files in ${directory} failed: ${String((cause as Error)?.message ?? cause)}`
      ).pipe(Effect.as([] as ReadonlyArray<string>))
    )
  )

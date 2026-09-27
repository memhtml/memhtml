import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

import { StorageFailure } from "@memhtml/contracts"
import { Effect } from "effect"
import writeFileAtomic from "write-file-atomic"

import type { GitFailure } from "./errors.js"
import { gitPathOf } from "./plumbing.js"

/**
 * Keep v2 state out of `git status` in a store scaffolded before that state existed.
 *
 * A new store's `.gitignore` names `.memhtml/sessions/` and `.memhtml/snapshots/` (the store
 * package's `GITIGNORE`). An existing store's `.gitignore` is committed content: rewriting it would
 * dirty the working tree and put a change in the next commit nobody asked for. `.git/info/exclude`
 * is the file git keeps for exactly this, local to the clone and never tracked, so the first writer
 * of either directory appends the patterns it needs there, once.
 */

/**
 * The head server's Unix domain socket (`memhtml head serve`), as an ignore pattern. The server
 * passes it to {@link ensureExcludedQuietly} before it binds, the way a session start passes
 * `.memhtml/sessions/` and a snapshot write `.memhtml/snapshots/`, so a store whose `.gitignore`
 * predates the server keeps the socket out of `git status` too. The store package's
 * `V2_IGNORE_PATTERNS` names the same path for a new store's `.gitignore`.
 */
export const HEAD_SOCKET = ".memhtml/head.sock"

/** What one call did. */
export interface ExcludeResult {
  /** The exclude file, absolute. */
  readonly file: string
  /** The patterns this call appended; empty when every one was already present. */
  readonly added: ReadonlyArray<string>
}

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

/**
 * Append every pattern of `patterns` that `.git/info/exclude` does not already carry, as a line
 * each. Idempotent: a second call with the same patterns appends nothing. A pattern is matched as a
 * whole trimmed line, so `.memhtml/sessions/` present as a comment does not count as present.
 */
export const ensureExcluded = (
  root: string,
  patterns: ReadonlyArray<string>
): Effect.Effect<ExcludeResult, GitFailure | StorageFailure> =>
  Effect.gen(function* () {
    const file = yield* gitPathOf(root, "info/exclude")
    const existing = yield* attemptIo("exclude.read", () =>
      readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return ""
        throw cause
      })
    )
    const present = new Set(existing.split("\n").map((line) => line.trim()))
    const added = patterns.filter((pattern) => !present.has(pattern.trim()))
    if (added.length === 0) return { file, added }
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n"
    const next = `${existing}${separator}${added.join("\n")}\n`
    yield* attemptIo("exclude.write", async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomic(file, next, { encoding: "utf8" })
    })
    return { file, added }
  })

/**
 * {@link ensureExcluded} as a best effort: a failure is logged and the caller proceeds, because an
 * ignore rule that could not be written is a noisier `git status`, and the write it was guarding is
 * still the right write.
 */
export const ensureExcludedQuietly = (
  root: string,
  patterns: ReadonlyArray<string>
): Effect.Effect<ExcludeResult | null> =>
  ensureExcluded(root, patterns).pipe(
    Effect.catch((failure) =>
      Effect.logWarning(
        `could not add ${patterns.join(", ")} to .git/info/exclude (${failure._tag}); git status will list that state until it is ignored`
      ).pipe(Effect.as(null))
    )
  )

import type { MemoryRecord } from "@memhtml/contracts"
import type { InvalidMemory } from "@memhtml/contracts/errors"
import { MEMORY_EXTENSION } from "@memhtml/contracts/paths"
import { type GitFailure, type GitShape, parseNulPathList, type TreeEntry } from "@memhtml/store"
import { Effect, HashMap, Option, Result } from "effect"

import {
  emptyIndexes,
  INDEXES,
  type IndexedView,
  type Indexes,
  insertRecord,
  removeRecord,
  viewOf
} from "./indexes.js"
import { recordFrom } from "./record.js"

/**
 * One immutable version of the corpus, built from one commit.
 *
 * `loadHead` builds the first version from a full tree read; `advanceHead` builds every later one
 * from its parent plus the paths the two commits differ on, sharing every untouched record and
 * index node with the parent. `parent` is kept so a caller can walk back; it is a pointer, not a
 * copy, so a chain of versions costs the deltas and nothing more.
 */
export interface HeadVersion extends IndexedView {
  readonly sha: string
  readonly parent: HeadVersion | null
  /** Files that were candidates and failed `parseMemory`. Skipped, counted, never thrown. */
  readonly skipped: number
  readonly skippedFiles: ReadonlyArray<SkippedFile>
}

export interface SkippedFile {
  readonly path: string
  readonly reason: string
}

/**
 * Whether a tree path is a memory file the head should parse.
 *
 * The generated `index.html` is a corpus artifact and never a memory. Anything under `.memhtml/`
 * is state. Only `.html` blobs qualify, so `.gitkeep`, `.gitattributes`, and `sitemap.xml` are
 * neither records nor skips: a census over the head counts eligible paths, not tree entries.
 */
export const isCandidatePath = (path: string): boolean => {
  if (!path.endsWith(MEMORY_EXTENSION)) return false
  if (path.startsWith(".memhtml/")) return false
  const slash = path.lastIndexOf("/")
  const base = slash === -1 ? path : path.slice(slash + 1)
  return base !== "index.html"
}

const decoder = new TextDecoder("utf-8")

const makeVersion = (
  indexes: Indexes,
  sha: string,
  parent: HeadVersion | null,
  skippedFiles: ReadonlyArray<SkippedFile>
): HeadVersion => ({
  ...viewOf(indexes, sha),
  [INDEXES]: indexes,
  sha,
  parent,
  skipped: skippedFiles.length,
  skippedFiles
})

/**
 * Parse every candidate entry from one `catFileBatch` read. Failures are values here: a record or a
 * skip per entry, in the caller's order, so the fold below is deterministic.
 */
const parseEntries = (
  git: GitShape,
  entries: ReadonlyArray<TreeEntry>
): Effect.Effect<
  ReadonlyArray<Result.Result<MemoryRecord, SkippedFile>>,
  GitFailure | InvalidMemory
> =>
  Effect.gen(function* () {
    const shas = [...new Set(entries.map((entry) => entry.sha))]
    const blobs = yield* git.catFileBatch(shas)
    return yield* Effect.forEach(entries, (entry) => {
      const bytes = blobs.get(entry.sha)
      if (bytes === undefined) {
        return Effect.succeed(
          Result.fail<SkippedFile>({ path: entry.path, reason: "blob missing from cat-file batch" })
        )
      }
      return recordFrom({ path: entry.path, html: decoder.decode(bytes) }).pipe(
        Effect.result,
        Effect.map((result) =>
          Result.isSuccess(result)
            ? Result.succeed<MemoryRecord>(result.success)
            : Result.fail<SkippedFile>({ path: entry.path, reason: result.failure.reason })
        )
      )
    })
  })

const candidateBlobs = (entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry> =>
  entries.filter((entry) => entry.objectType === "blob" && isCandidatePath(entry.path))

/**
 * Build the version at `sha` from a full tree read: one `ls-tree`, one `cat-file --batch`.
 *
 * The bulk build folds `insertRecord` over the parsed records, the same writer `advanceHead` uses,
 * so a version built from scratch and one built by advancing agree node for node.
 */
export const loadHead = (
  git: GitShape,
  sha: string
): Effect.Effect<HeadVersion, GitFailure | InvalidMemory> =>
  Effect.gen(function* () {
    const entries = candidateBlobs(yield* git.lsTreeR(sha))
    const parsed = yield* parseEntries(git, entries)
    let indexes = emptyIndexes
    const skipped: Array<SkippedFile> = []
    for (const result of parsed) {
      if (Result.isSuccess(result)) indexes = insertRecord(indexes, result.success)
      else skipped.push(result.failure)
    }
    return makeVersion(indexes, sha, null, skipped)
  }).pipe(Effect.withSpan("head.load"))

/**
 * The paths whose blobs differ between two trees, in one subprocess. `diff-tree` on two tree-ish
 * arguments compares the trees directly, so a range of many commits costs the same as one. `-z`
 * framing and `--no-renames` for the reasons the store's `diffTreeNames` gives: a rename must
 * contribute both of its paths, and a non-ASCII path must arrive unquoted.
 */
const changedPaths = (
  git: GitShape,
  from: string,
  to: string
): Effect.Effect<ReadonlyArray<string>, GitFailure> =>
  git
    .run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to])
    .pipe(Effect.map(parseNulPathList))

/**
 * The version at `to`, built from `from` plus the paths the two trees differ on.
 *
 * Every changed path is removed from the parent's indexes and, when it still exists at `to` as a
 * candidate, re-parsed and re-inserted. A changed path whose blob sha equals the parent record's
 * (changed and changed back inside the range) keeps the parent's record object. Nothing else is
 * touched, which is the structural-sharing claim the tests check by reference.
 */
export const advanceHead = (
  git: GitShape,
  from: HeadVersion,
  to: string
): Effect.Effect<HeadVersion, GitFailure | InvalidMemory> =>
  Effect.gen(function* () {
    if (to === from.sha) return from
    const changed = (yield* changedPaths(git, from.sha, to)).filter(isCandidatePath)
    if (changed.length === 0) return makeVersion(from[INDEXES], to, from, from.skippedFiles)

    const present = candidateBlobs(yield* git.lsTreeR(to, changed))
    const presentByPath = new Map(present.map((entry) => [entry.path, entry] as const))

    // Entries to re-parse: present at `to` and not byte-identical to the parent's record.
    const toParse = present.filter((entry) => {
      const previous = Option.getOrUndefined(HashMap.get(from[INDEXES].records, entry.path))
      return previous === undefined || previous.blobSha !== entry.sha
    })
    const parsed = yield* parseEntries(git, toParse)

    // A changed path drops any skip it carried; re-parsing below decides whether it earns a new one.
    const skipped: Array<SkippedFile> = from.skippedFiles.filter(
      (skip) => !changed.includes(skip.path)
    )
    let indexes = from[INDEXES]
    for (const path of changed) {
      if (!presentByPath.has(path)) indexes = removeRecord(indexes, path)
    }
    for (const result of parsed) {
      if (Result.isSuccess(result)) indexes = insertRecord(indexes, result.success)
      else {
        indexes = removeRecord(indexes, result.failure.path)
        skipped.push(result.failure)
      }
    }
    return makeVersion(indexes, to, from, skipped)
  }).pipe(Effect.withSpan("head.advance"))

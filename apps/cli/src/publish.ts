import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseService, IndexStale, isIndexablePath, TREE_PREFIXES } from "@memhtml/index"
import {
  attemptIo,
  commitSubject,
  ensureConfig,
  type GitShape,
  literalPathspecs,
  MERGE_DIRECTORY_RENAMES,
  parseNulPathList,
  readFileOrNull,
  withCheckoutLock
} from "@memhtml/store"
import { Effect } from "effect"

import { Git } from "./api-layer.js"
import {
  type GeneratedFile,
  generateArtifacts,
  type PublishRow,
  publishRows,
  staleListings
} from "./artifacts.js"

/**
 * `memhtml publish`: regenerate the per-directory `index.html` listings and the root `sitemap.xml`,
 * remove the listings of directories that no longer hold a record, and commit whatever changed.
 *
 * **The generator is `./artifacts.ts` and is never re-derived.** `generateArtifacts` lives there because
 * a listing needs `files.title`/`gist`/`updated_at`, all of them index projections, and
 * `@memhtml/store` is SQL-free by design. Two generators would produce two byte sequences for one tree,
 * and these files are the design's one merge-conflict source. `.gitattributes` marks them
 * `merge=ours` and a conflict is resolved by regenerating, which only works if regeneration is
 * unambiguous. This command is the one regenerator.
 *
 * The output is deterministic to the byte: the rows arrive path-ordered from SQL, every string is
 * escaped, and no timestamp of generation appears anywhere. Two runs over an unchanged corpus write
 * nothing and commit nothing, which also makes the command safe to run after every merge.
 */

/** What a publish did. `written: 0` means the artifacts already matched the corpus. */
export interface PublishReport {
  readonly root: string
  /** Artifacts the generator produced: one listing per directory plus the sitemap. */
  readonly artifacts: number
  /** Artifacts whose bytes differed from what was on disk, and were therefore rewritten. */
  readonly written: number
  readonly paths: ReadonlyArray<string>
  /**
   * Tracked listings under a bucket that the generator no longer produces and whose directory holds
   * no tracked record at any depth. Removed with `git rm` in the same commit. Path-ordered.
   */
  readonly removed: ReadonlyArray<string>
  /** The commit, or `null` when nothing changed. */
  readonly commitSha: string | null
}

/** Write one artifact if its bytes differ. Returns true when the file was rewritten. */
const writeIfChanged = (root: string, artifact: GeneratedFile) =>
  Effect.gen(function* () {
    const absolute = join(root, artifact.path)
    const existing = yield* readFileOrNull(absolute)
    if (existing === artifact.html) return false
    yield* attemptIo(`publish.write:${artifact.path}`, async () => {
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, artifact.html, "utf8")
    })
    return true
  })

/**
 * Refuse to regenerate from an index that holds no file rows while HEAD carries memory files.
 *
 * The listings and the sitemap are projections of the `files` table, so an index with no rows
 * empties the sitemap and removes every listing under a bucket, and the commit that follows reads
 * as an ordinary regeneration. A fresh clone, where `index.db` is gitignored and absent, and a
 * rebuild that emptied the table are both that state. The tree is the system of record, so the
 * question is asked of HEAD with the indexer's own path rule: when HEAD holds no memory file
 * either, the store is genuinely empty and an empty listing is the correct output. The check runs
 * before any byte is written, so a refusal leaves the tree and the history untouched.
 */
const refuseEmptyIndex = (git: GitShape, rows: ReadonlyArray<PublishRow>) =>
  Effect.gen(function* () {
    if (rows.length > 0) return
    const head = yield* git.revParseHead()
    if (head === null) return
    const memories = (yield* git.lsTreeR(head, TREE_PREFIXES)).filter((entry) =>
      isIndexablePath(entry.path)
    ).length
    if (memories === 0) return
    return yield* Effect.fail(
      new IndexStale(
        `the index holds no memory rows while HEAD carries ${memories} memory ${memories === 1 ? "file" : "files"}, so publish would empty sitemap.xml and remove every listing; build the index with \`memhtml index rebuild\` and publish again`
      )
    )
  })

/**
 * Every path the git index tracks under the four buckets. The index rather than HEAD, because the
 * index is what `git rm` acts on: a listing that a failed commit left staged is tracked, and HEAD
 * does not hold it yet.
 */
const trackedPaths = (git: GitShape) =>
  git.run(["ls-files", "-z", "--", ...TREE_PREFIXES]).pipe(Effect.map(parseNulPathList))

/**
 * `git rm` the stale listings, each spelled as a `:(literal)` pathspec by {@link literalPathspecs},
 * which also refuses an empty path. `git rm` reads a bare argument as a pattern in which `*`, `?`
 * and `[` match, so a stale `resources/a[b]/index.html` would also match `resources/ab/index.html`,
 * a live listing this publish has just written and staged, and the commit would delete it. `-f`
 * because the filename is the generator's: without it `git rm` refuses a file whose working copy
 * was edited, and a listing edited by hand is removed exactly as {@link writeIfChanged} would
 * overwrite it, rather than failing the whole publish.
 */
const removeListings = (git: GitShape, paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? Effect.void
    : literalPathspecs("rm", paths).pipe(
        Effect.flatMap((pathspecs) => git.run(["rm", "-q", "-f", "--", ...pathspecs])),
        Effect.asVoid
      )

/** The commit subject, naming the removals only when there are some. */
const subjectFor = (artifacts: number, removed: number): string => {
  const regenerated = `regenerate ${artifacts} generated artifacts`
  if (removed === 0) return regenerated
  return `${regenerated}, remove ${removed} stale ${removed === 1 ? "listing" : "listings"}`
}

/**
 * Regenerate, remove the stale listings, and commit.
 *
 * The whole artifact set is staged rather than only the rewritten files, because a listing that was
 * hand-edited and then regenerated to its correct bytes is a change git already knows about. `commit`
 * no-ops on an index matching HEAD, so staging everything costs nothing when nothing moved.
 *
 * A tracked listing the generator no longer produces is removed in the same commit
 * (`staleListings`), so a published tree carries no page listing records that have gone. The set is
 * read from the git index under the checkout lock, and the removals are staged last, after every
 * artifact is written and staged. Every store write commits the whole shared index, so a removal
 * staged by a publish whose write or `git add` then failed would ride along in the next, unrelated
 * commit; staged last, a failure before the commit leaves no deletion behind.
 *
 * A removal can empty a directory, and in a clone without `merge.directoryRenames=false` the next
 * merge would read the archive moves out of it as a directory rename and carry another clone's
 * new record there into `archive/` (`MERGE_DIRECTORY_RENAMES`). `memhtml init` sets it, and
 * publish sets it too when the clone lacks it, so a clone whose init predates the setting gets it
 * on its next publish. The setting protects the clone that runs the merge, so this covers only a
 * clone that publishes; one that only writes and pulls gets it from running `memhtml init` again.
 */
export const publish = () =>
  Effect.gen(function* () {
    const git = yield* Git
    const db = yield* DatabaseService
    const rows = yield* publishRows(db)
    yield* refuseEmptyIndex(git, rows)
    const artifacts = generateArtifacts(rows)

    // Written, staged, removed, and committed under the checkout lock: the commit takes the whole
    // shared index, so it must not run while a session commit has its own file staged there.
    const written: Array<string> = []
    const { commit, removed } = yield* withCheckoutLock(
      git.root,
      Effect.gen(function* () {
        yield* ensureConfig(git, MERGE_DIRECTORY_RENAMES)
        const removed = staleListings(yield* trackedPaths(git), artifacts)
        for (const artifact of artifacts) {
          if (yield* writeIfChanged(git.root, artifact)) written.push(artifact.path)
        }
        yield* git.add(artifacts.map((artifact) => artifact.path))
        yield* removeListings(git, removed)
        const commit = yield* git.commit(
          commitSubject("publish", subjectFor(artifacts.length, removed.length))
        )
        return { commit, removed }
      })
    )

    return {
      root: git.root,
      artifacts: artifacts.length,
      written: written.length,
      paths: written,
      removed,
      commitSha: commit.sha
    } satisfies PublishReport
  })

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseService, IndexStale, isIndexablePath, TREE_PREFIXES } from "@memhtml/index"
import { attemptIo, commitSubject, type GitShape, readFileOrNull } from "@memhtml/store"
import { Effect } from "effect"

import { Git } from "./api-layer.js"
import { type GeneratedFile, generateArtifacts, type PublishRow, publishRows } from "./artifacts.js"

/**
 * `memhtml publish`: regenerate the per-directory `index.html` listings and the root `sitemap.xml`, and
 * commit whatever changed.
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
 * regenerates every one of them empty, and the commit that follows reads as an ordinary
 * regeneration. A fresh clone, where `index.db` is gitignored and absent, and a rebuild that
 * emptied the table are both that state. The tree is the system of record, so the question is
 * asked of HEAD with the indexer's own path rule: when HEAD holds no memory file either, the store
 * is genuinely empty and an empty listing is the correct output. The check runs before any byte is
 * written, so a refusal leaves the tree and the history untouched.
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
        `the index holds no memory rows while HEAD carries ${memories} memory ${memories === 1 ? "file" : "files"}, so publish would regenerate every listing and sitemap.xml empty; build the index with \`memhtml index rebuild\` and publish again`
      )
    )
  })

/**
 * Regenerate and commit.
 *
 * The whole artifact set is staged rather than only the rewritten files, because a listing that was
 * hand-edited and then regenerated to its correct bytes is a change git already knows about. `commit`
 * no-ops on an index matching HEAD, so staging everything costs nothing when nothing moved.
 */
export const publish = () =>
  Effect.gen(function* () {
    const git = yield* Git
    const db = yield* DatabaseService
    const rows = yield* publishRows(db)
    yield* refuseEmptyIndex(git, rows)
    const artifacts = generateArtifacts(rows)

    const written: Array<string> = []
    for (const artifact of artifacts) {
      if (yield* writeIfChanged(git.root, artifact)) written.push(artifact.path)
    }

    yield* git.add(artifacts.map((artifact) => artifact.path))
    const commit = yield* git.commit(
      commitSubject("publish", `regenerate ${artifacts.length} generated artifacts`)
    )

    return {
      root: git.root,
      artifacts: artifacts.length,
      written: written.length,
      paths: written,
      commitSha: commit.sha
    } satisfies PublishReport
  })

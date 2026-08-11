import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseService } from "@memhtml/index"
import { type GeneratedFile, generateArtifacts, publishRows } from "@memhtml/sleep"
import { attemptIo, commitSubject, readFileOrNull } from "@memhtml/store"
import { Effect } from "effect"

import { Git } from "./api-layer.js"

/**
 * `memhtml publish`: regenerate the per-directory `index.html` listings and the root `sitemap.xml`, and
 * commit whatever changed.
 *
 * **The generator is imported from `@memhtml/sleep`, never re-derived.** `generateArtifacts` lives there
 * because a listing needs `files.title`/`gist`/`updated_at` — all index projections — and
 * `@memhtml/store` is SQL-free by design. Two generators would produce two byte sequences for one tree,
 * and these files are the design's ONE merge-conflict source: `.gitattributes` marks them
 * `merge=ours` and a conflict is resolved by REGENERATING, which only works if regeneration is
 * unambiguous. So the sleep integrity phase and this command call the same function, and the only
 * difference between them is which commit the result lands in.
 *
 * Deterministic to the byte: the rows arrive path-ordered from SQL, every string is escaped, and no
 * timestamp of generation appears anywhere. Two runs over an unchanged corpus therefore write nothing
 * and commit nothing — which is also what makes the command safe to run after every merge.
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
 * Regenerate and commit.
 *
 * The whole artifact set is staged rather than only the rewritten files, because a listing that was
 * hand-edited and then regenerated to its correct bytes is a change git already knows about — and
 * `commit` no-ops on an index matching HEAD, so staging everything costs nothing when nothing moved.
 */
export const publish = () =>
  Effect.gen(function* () {
    const git = yield* Git
    const db = yield* DatabaseService
    const rows = yield* publishRows(db)
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

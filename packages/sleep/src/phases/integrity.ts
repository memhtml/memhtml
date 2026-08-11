import { type EdgeRel, isEdgeRel } from "@memhtml/contracts/edges"
import { archivePathFor, normalizePath } from "@memhtml/contracts/paths"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import {
  hrefFor,
  link,
  meta,
  readFileBytes,
  stampFile,
  unlink,
  writeFileBytes,
  yearOf
} from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { generateArtifacts } from "../publish.js"
import { allPaths, danglingEdges, publishRows } from "../sql.js"

/**
 * Phase 13 — integrity. Repair dangling `memhtml-*` hrefs and regenerate the artifacts. ONE commit.
 *
 * **A dangling href is repaired by rewriting it to the archive path when the target was archived, and
 * dropped with a warning otherwise.** Those are different facts: an archived target still exists and
 * the edge still says something true, so rewriting preserves it; a target that is simply gone means
 * the edge asserts a relationship to nothing, and leaving it would keep producing a dangling row on
 * every rebuild forever. The archive path is derived with `archivePathFor` rather than searched for,
 * because the mapping is injective and `originalPathFor` inverts it — no rename-similarity score is
 * consulted anywhere.
 *
 * The generated `index.html` files and `sitemap.xml` are the design's ONE merge-conflict source, and
 * they are regenerated only here and by `memhtml publish` — never on an ordinary write. Both call the same
 * `generateArtifacts`, and it is deterministic given the row set, so `.gitattributes`' `merge=ours`
 * plus a regeneration pass resolves a conflict without a human reading XML.
 */
export const integrity: PhaseBody = (env) =>
  Effect.gen(function* () {
    const dangling = yield* danglingEdges(env.deps.db)
    const known = new Set((yield* allPaths(env.deps.db)).map((row) => row.path))
    const rows = yield* publishRows(env.deps.db)
    const artifacts = generateArtifacts(rows)

    /**
     * Candidate repairs, resolved before any write. A target's archive path is looked for under EVERY
     * plausible year rather than only the run's, because a file archived in a previous January sits
     * under that year and the run date says nothing about it.
     */
    const repairs: Array<{
      readonly path: string
      readonly rel: EdgeRel
      readonly from: string
      readonly to: string | undefined
    }> = []
    for (const edge of dangling) {
      if (!isEdgeRel(edge.rel)) continue
      const target = normalizePath(edge.dst_path)
      const replacement = archivedFormOf(target, known, yearOf(env.date))
      repairs.push({ path: edge.src_path, rel: edge.rel, from: target, to: replacement })
    }

    const rewritable = repairs.filter((repair) => repair.to !== undefined)
    const droppable = repairs.filter((repair) => repair.to === undefined)
    const counts = {
      dangling: dangling.length,
      rewritten: rewritable.length,
      dropped: droppable.length,
      artifacts: artifacts.length
    }
    if (env.dryRun) return emptyOutcome(counts)

    let rewritten = 0
    for (const repair of rewritable) {
      const to = repair.to
      if (to === undefined) continue
      /**
       * Remove-then-add on the SAME file in one stamp, so a repair is one line replaced rather than a
       * line dropped and a line appended somewhere else in the head — and so a re-run is a no-op:
       * once the href points at the archive path, the removal matches nothing and the addition is
       * already present.
       */
      const changed = yield* stampFile(env, repair.path, [
        unlink(repair.rel, hrefFor(repair.from)),
        link(repair.rel, hrefFor(to)),
        meta("memhtml-updated", env.at)
      ])
      if (changed) rewritten += 1
    }

    let dropped = 0
    for (const repair of droppable) {
      yield* Effect.logWarning(
        `sleep.integrity dropped a dangling ${repair.rel} from ${repair.path}: target has no file`
      )
      const changed = yield* stampFile(env, repair.path, [
        unlink(repair.rel, hrefFor(repair.from)),
        meta("memhtml-updated", env.at)
      ])
      if (changed) dropped += 1
    }

    let regenerated = 0
    for (const artifact of artifacts) {
      const existing = yield* readFileBytes(env, artifact.path)
      if (existing === artifact.html) continue
      yield* writeFileBytes(env, artifact.path, artifact.html)
      yield* env.deps.git.add([artifact.path])
      regenerated += 1
    }

    const final = { ...counts, rewritten, dropped, regenerated }
    const commitSha = yield* commitPhase(
      env,
      "integrity",
      `repair ${rewritten + dropped} dangling links, regenerate ${regenerated} artifacts`,
      final
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })

/**
 * The archive path a missing target now lives at, or `undefined` when it is genuinely gone.
 *
 * Years are tried newest-first from the run's own year back over {@link ARCHIVE_LOOKBACK_YEARS}, so
 * the most recent archiving of a path that was archived more than once wins — which is the one a live
 * edge means, since an earlier archiving was superseded by a later restore.
 */
export const archivedFormOf = (
  target: string,
  known: ReadonlySet<string>,
  runYear: number
): string | undefined => {
  for (let back = 0; back <= ARCHIVE_LOOKBACK_YEARS; back += 1) {
    const candidate = archivePathFor(target, runYear - back)
    if (known.has(candidate)) return candidate
  }
  return undefined
}

/** How many year partitions back a dangling href is chased. Ten years of archive is the whole corpus. */
export const ARCHIVE_LOOKBACK_YEARS = 10

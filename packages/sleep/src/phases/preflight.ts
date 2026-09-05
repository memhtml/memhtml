import {
  formatCoverage,
  VECTOR_COVERAGE_FLOOR,
  VECTOR_COVERAGE_HARD_FLOOR,
  VECTOR_COVERAGE_REMEDY,
  VectorCoverageLow
} from "@memhtml/index"
import { Effect } from "effect"

import { emptyOutcome, type PhaseBody } from "../env.js"
import { corpusSnapshot } from "../sql.js"

/**
 * Phase 1, preflight. Refresh the index, snapshot the corpus, check the vector plane, commit nothing.
 *
 * The index update runs FIRST because every later phase reads the index and writes git. A phase
 * scoring retention over rows that predate last night's writes would evict a memory written
 * yesterday for looking unreferenced. `EmbedModelMismatch` and `IndexStale` travel out as a phase
 * failure instead of being swallowed. A half-migrated vector space degrades every cosine in the run
 * while each individual vector stays well-formed, so continuing would corrupt dedup, mining, and
 * conflict detection with a green report; a stale index is a corpus fragment every later phase would
 * read as the corpus.
 *
 * The coverage check runs AFTER the update, because the update is what embeds this run's new chunks.
 * A SPARSE plane is the same corruption as a mixed one, one step quieter (issue #141): with half the
 * chunks unembedded, dedup compares a sample against itself and calls the rest unique, mining finds no
 * neighbour for a memory that has one, and the report is green. Below `VECTOR_COVERAGE_HARD_FLOOR` the
 * phase fails with `VectorCoverageLow`, the same channel as the other two. Between that and the soft
 * floor it warns, names the counts and the remedy, records the ratio under `vectorCoverage`, and
 * continues, because a plane that is 90 percent there still says more true things than none.
 *
 * **The check applies only when the vector plane is IN USE**: some vector exists, or an embedder is
 * bound. A store with zero vectors and no embedder is the deliberate lexical-only configuration
 * (`MEMHTML_EMBED=off`), and dedup and mining already know to work without cosines there. Failing
 * that store would turn a supported configuration into a night that never runs. The same rule governs
 * `memhtml doctor`. A credential-free night under the default `MEMHTML_EMBED=on` is NOT exempt: the
 * embedder is bound, every embed call fails softly, the plane stays at zero, and the refusal names
 * `MEMHTML_EMBED=off` as the remedy, because a store that runs that way every night has chosen
 * lexical-only without saying so, and the night's cosine passes would otherwise run over nothing.
 *
 * This is why the phase is a HARD PREREQUISITE of all sixteen after it
 * (`HARD_PREREQUISITES` in `../contract.ts`): each of its four failures, a dirty tree, a mixed vector
 * space, a half-built index, a sparse vector plane, makes a later phase's commit wrong rather than
 * merely incomplete, and a dirty tree makes it the OPERATOR's bytes committed under sleep's trailers.
 *
 * A dry run still updates the index. The index is a projection of git, not part of the corpus, so
 * refreshing it changes nothing a reviewer would see and makes the dry run's counts describe the
 * tree the real run would act on. A dry run whose preflight fails skips the same sixteen phases, for
 * the same reason read one step further: counts computed over a corrupt vector space or a fragment of
 * the corpus are a preview of numbers nothing would reproduce.
 */
export const preflight: PhaseBody = (env) =>
  Effect.gen(function* () {
    yield* env.deps.store.requireCleanTree()
    const update = yield* env.deps.indexer.update({ embed: true })
    const snapshot = yield* corpusSnapshot(env.deps.db)

    const coverage = yield* env.deps.indexer.vectorCoverage()
    const floor = env.deps.vectorCoverageFloor ?? VECTOR_COVERAGE_FLOOR
    const vectorPlaneInUse = coverage.embeddings > 0 || env.deps.indexer.embedderBound
    let detail: string | undefined
    if (vectorPlaneInUse && coverage.coverage < VECTOR_COVERAGE_HARD_FLOOR) {
      return yield* Effect.fail(new VectorCoverageLow(coverage, VECTOR_COVERAGE_HARD_FLOOR))
    }
    if (vectorPlaneInUse && coverage.coverage < floor) {
      detail = `vector coverage ${formatCoverage(coverage.coverage)} (${coverage.embeddings} of ${coverage.chunks} chunks) is below ${floor}; ${VECTOR_COVERAGE_REMEDY}`
      yield* Effect.logWarning(`sleep.preflight ${detail}`)
    }

    return {
      ...emptyOutcome({
        active: snapshot.files,
        archived: snapshot.archived,
        chunks: snapshot.chunks,
        embeddings: snapshot.embeddings,
        edges: snapshot.edges,
        derivedEdges: snapshot.derivedEdges,
        indexedAdded: update.added,
        indexedModified: update.modified,
        indexedRemoved: update.removed,
        indexedRenamed: update.renamed,
        embeddingsWritten: update.embeddingsWritten,
        indexSkipped: update.skipped.length,
        vectorCoverage: coverage.coverage
      }),
      ...(detail === undefined ? {} : { detail })
    }
  })

import type { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

import type { DatabaseShape } from "./database.js"
import { INDEX_STATE_ID } from "./schema-const.js"

/**
 * Vector coverage: the share of the index's chunks that carry a vector in the configured space.
 *
 * A SPARSE vector plane is worse than none (issue #141). The vector arm ranks whatever chunks hold a
 * vector, so when only a few do, its whole candidate list is those few files, and each of them
 * collects a vector contribution on top of whatever recency and salience already gave it. An exact
 * lexical match on an unembedded file collects one arm. With RRF's `k = 60` a file at vector rank 40
 * plus recency rank 1 still outscores a lexical rank 1 alone, so the embedded few win every query. In
 * production the embedded few were the newest files, because an incremental `index update --embed`
 * reaches only the chunks of files that changed, and every search returned the newest files
 * regardless of the query while `degraded` stayed false: the arm did fire.
 *
 * This module is the ONE reader of that ratio. `search` and `recall` consult it before embedding a
 * query, `memhtml status`, `memhtml index status` and `memhtml doctor` report it, and sleep's preflight
 * gates the night on it. One statement, so the four surfaces cannot disagree about what "coverage"
 * counts.
 *
 * **Only vectors in the CONFIGURED space count.** `embeddings.model` carries `<model-id>@<dim>`, and a
 * vector in another space is incomparable with the query vector, so for ranking purposes it is not
 * there. The indexer refuses to write across a model mismatch and `doctor` reports the mismatch
 * itself; this reader answers the narrower question of how much of the index the current space covers.
 *
 * **An index with zero chunks has coverage 1.** There is nothing the vector arm could inflate, no
 * file the plane fails to reach, and an empty store must read as healthy rather than as a store
 * whose vectors are all missing. The ratio is `embeddings / chunks` otherwise, in `[0, 1]`.
 */

/**
 * Below this, the vector plane is treated as absent: `search` and `recall` drop the vector arm and
 * report `degraded: true`, `doctor` reports `vectorCoverageLow` and `healthy: false`, and sleep's
 * preflight logs a warning. The CLI reads `MEMHTML_VECTOR_COVERAGE_FLOOR` over this default.
 *
 * 0.95 rather than 1.0 because coverage is never exactly complete on a live store: a write lands, its
 * chunks are projected, and its vectors follow in the same `update` a moment later, so a reader
 * between the two sees a handful of unembedded chunks on a healthy index. Five percent is far above
 * that gap and far below the 2 percent the incident measured.
 */
export const VECTOR_COVERAGE_FLOOR = 0.95

/**
 * Below this, sleep's preflight REFUSES the run, the way it refuses a mixed vector space. Half the
 * corpus without vectors means dedup, mining and conflict detection compare a sample against itself
 * and call the rest unique, with a green report. Not configurable: the soft floor is a quality knob,
 * this is the point past which the night's arithmetic stops describing the corpus.
 */
export const VECTOR_COVERAGE_HARD_FLOOR = 0.5

/**
 * What an operator does about low coverage. Named once so three surfaces say the same thing.
 *
 * `memhtml index embed` is the incremental backfill (issue #142): it embeds only the chunks without a
 * vector and is safe to rerun, so it is named first. `memhtml index rebuild --embed` reprojects the
 * whole tree and is the path when the index itself is suspect. A store that has no vectors at all
 * gets a third clause from {@link VectorCoverageLow}: `MEMHTML_EMBED=off`, for the operator who never
 * meant to embed.
 */
export const VECTOR_COVERAGE_REMEDY =
  "run `memhtml index embed` to backfill the missing vectors, or `memhtml index rebuild --embed`"

/**
 * The clause a ZERO-vector plane adds to the remedy. An embedder is bound (or the store would be the
 * lexical-only configuration) and it has written nothing, which is the shape of a default
 * `MEMHTML_EMBED=on` with no credential: every embed call fails softly, every search is degraded, and
 * the remedies above cannot succeed either. Naming the opt-out is what turns that refusal into a
 * decision the operator can make.
 */
export const VECTOR_COVERAGE_NO_VECTORS_REMEDY =
  "or set `MEMHTML_EMBED=off` for a store that is not meant to embed"

/** The measured ratio and the two counts behind it. */
export interface VectorCoverage {
  /** Every chunk in the index, embedded or not. */
  readonly chunks: number
  /** Chunks carrying a vector in the counted space. Never more than `chunks`. */
  readonly embeddings: number
  /** `embeddings / chunks`, or `1` when there are no chunks. */
  readonly coverage: number
  /**
   * The space that was counted: the configured watermark when the caller named one, else the stored
   * `index_state.embed_model`, else `null` for an index nothing has ever rebuilt.
   */
  readonly model: string | null
}

/**
 * Read the coverage in one statement.
 *
 * `embedWatermark` is the configured space, `@memhtml/llm`'s `EMBED_WATERMARK` in production. A
 * caller that does not know it (retrieval built without one, in a test) gets the STORED watermark,
 * which is the same string whenever the indexer has been allowed to write, because the indexer refuses
 * to write across a mismatch. The `coalesce` keeps that fallback inside the one statement rather than
 * as a second query whose answer could straddle a rebuild.
 */
export const readVectorCoverage = (
  db: DatabaseShape,
  embedWatermark?: string | undefined
): Effect.Effect<VectorCoverage, StorageFailure> =>
  db
    .get<{ chunks: number; embedded: number; model: string | null }>(
      `SELECT (SELECT count(*) FROM chunks) AS chunks,
              (SELECT count(*) FROM embeddings
                WHERE model = coalesce(?1, (SELECT embed_model FROM index_state WHERE id = ?2))) AS embedded,
              coalesce(?1, (SELECT embed_model FROM index_state WHERE id = ?2)) AS model`,
      [embedWatermark ?? null, INDEX_STATE_ID]
    )
    .pipe(
      Effect.map((row) => {
        const chunks = row?.chunks ?? 0
        const embeddings = row?.embedded ?? 0
        return {
          chunks,
          embeddings,
          coverage: chunks === 0 ? 1 : embeddings / chunks,
          model: row?.model ?? null
        }
      })
    )

/**
 * `0.4` as `40%` and `0.949` as `94.9%`, for log lines and failure reasons. One decimal rather than a
 * whole percent, so a ratio just under the floor never prints as the floor in the same sentence that
 * says it is below it.
 */
export const formatCoverage = (coverage: number): string =>
  `${Number((coverage * 100).toFixed(1))}%`

/**
 * The vector plane covers too little of the corpus for the night to run.
 *
 * Sleep's preflight fails with this below {@link VECTOR_COVERAGE_HARD_FLOOR}, and it travels the same
 * channel as `EmbedModelMismatch` and `IndexStale`: a typed phase failure the runner reports by
 * `_tag` and `reason`, so the report line names the ratio, the counts and the remedy. Defined here
 * beside the reader rather than in the sleep package because the ratio's meaning is this module's.
 */
export class VectorCoverageLow {
  readonly _tag = "VectorCoverageLow"
  readonly reason: string
  constructor(
    readonly coverage: VectorCoverage,
    readonly floor: number
  ) {
    const noVectors = coverage.embeddings === 0 ? `, ${VECTOR_COVERAGE_NO_VECTORS_REMEDY}` : ""
    this.reason = `${formatCoverage(coverage.coverage)} of chunks carry a vector (${coverage.embeddings} of ${coverage.chunks}), below the hard floor ${floor}; ${VECTOR_COVERAGE_REMEDY}${noVectors}`
  }
}

import {
  DatabaseService,
  type DatabaseShape,
  readIndexState,
  readVectorCoverage
} from "@memhtml/index"
import { EMBED_WATERMARK } from "@memhtml/llm"
import { Effect } from "effect"

import { RetrievalPolicy } from "./api-layer.js"

/**
 * Response shaping: the few places a payload is not simply the use case's own return value.
 *
 * Kept out of the dispatcher so an arm stays one call. A function lives here when a wire shape and an
 * internal shape differ.
 */

/**
 * The index's own report of itself: the watermark, the vector space, and the row counts.
 *
 * `memhtml index status` reads this rather than running an indexer method, because "what does the index
 * currently contain" must be answerable without the git subprocess an `update` would spawn. An
 * operator asking about a stale index is frequently asking because something is wrong with the repo.
 */
export const indexReport = () =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const policy = yield* RetrievalPolicy
    const state = yield* readIndexState(db).pipe(Effect.orElseSucceed(() => undefined))
    const coverage = yield* readVectorCoverage(db, EMBED_WATERMARK).pipe(
      Effect.orElseSucceed(() => ({ chunks: 0, embeddings: 0, coverage: 1, model: null }))
    )

    return {
      mode: "status",
      headSha: state?.head_sha ?? null,
      embedModel: state?.embed_model ?? null,
      embedDim: state?.embed_dim ?? null,
      /**
       * True when the stored vector space IS the configured one. On a mismatch the indexer stops
       * instead of writing, so reporting the two values separately lets an operator see which side
       * to change.
       */
      embedModelMatches: state?.embed_model === EMBED_WATERMARK,
      configuredEmbedModel: EMBED_WATERMARK,
      rebuiltAt: state?.rebuilt_at ?? null,
      updatedAt: state?.updated_at ?? null,
      files: yield* count(db, "SELECT count(*) AS n FROM files"),
      activeFiles: yield* count(db, "SELECT count(*) AS n FROM files WHERE archived = 0"),
      chunks: yield* count(db, "SELECT count(*) AS n FROM chunks"),
      embeddings: yield* count(db, "SELECT count(*) AS n FROM embeddings"),
      /**
       * `embeddings` above counts every vector; this counts the ones in the CONFIGURED space over the
       * chunks, which is the number that decides whether the vector arm runs (issue #141). The floor
       * travels with it so an operator reads the judgement and the threshold in one envelope.
       */
      vectorCoverage: coverage.coverage,
      vectorCoverageFloor: policy.vectorCoverageFloor,
      edges: yield* count(db, "SELECT count(*) AS n FROM edges"),
      derivedEdges: yield* count(db, "SELECT count(*) AS n FROM edges WHERE derived = 1"),
      tags: yield* count(db, "SELECT count(DISTINCT tag) AS n FROM file_tags"),
      entities: yield* count(
        db,
        "SELECT count(DISTINCT entity_type || ':' || entity_name) AS n FROM file_entities"
      ),
      traces: yield* count(db, "SELECT count(*) AS n FROM traces"),
      hasState: db.hasState
    }
  })

const count = (db: DatabaseShape, sql: string) =>
  db.get<{ n: number }>(sql).pipe(
    Effect.map((row) => row?.n ?? 0),
    Effect.orElseSucceed(() => 0)
  )

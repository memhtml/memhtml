import { Effect } from "effect"

import { emptyOutcome, type PhaseBody } from "../env.js"
import { corpusSnapshot } from "../sql.js"

/**
 * Phase 1, preflight. Refresh the index, snapshot the corpus, commit nothing.
 *
 * The index update runs FIRST because every later phase reads the index and writes git. A phase
 * scoring retention over rows that predate last night's writes would evict a memory written
 * yesterday for looking unreferenced. `EmbedModelMismatch` travels out as a phase failure instead
 * of being swallowed. A half-migrated vector space degrades every cosine in the run while each
 * individual vector stays well-formed, so continuing would corrupt dedup, mining, and conflict
 * detection with a green report.
 *
 * A dry run still updates the index. The index is a projection of git, not part of the corpus, so
 * refreshing it changes nothing a reviewer would see and makes the dry run's counts describe the
 * tree the real run would act on.
 */
export const preflight: PhaseBody = (env) =>
  Effect.gen(function* () {
    yield* env.deps.store.requireCleanTree()
    const update = yield* env.deps.indexer.update({ embed: true })
    const snapshot = yield* corpusSnapshot(env.deps.db)
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
        indexSkipped: update.skipped.length
      })
    }
  })

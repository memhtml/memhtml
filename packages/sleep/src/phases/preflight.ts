import { Effect } from "effect"

import { emptyOutcome, type PhaseBody } from "../env.js"
import { corpusSnapshot } from "../sql.js"

/**
 * Phase 1, preflight. Refresh the index, snapshot the corpus, commit nothing.
 *
 * The index update runs FIRST because every later phase reads the index and writes git. A phase
 * scoring retention over rows that predate last night's writes would evict a memory written
 * yesterday for looking unreferenced. `EmbedModelMismatch` and `IndexStale` travel out as a phase
 * failure instead of being swallowed. A half-migrated vector space degrades every cosine in the run
 * while each individual vector stays well-formed, so continuing would corrupt dedup, mining, and
 * conflict detection with a green report; a stale index is a corpus fragment every later phase would
 * read as the corpus.
 *
 * This is why the phase is a HARD PREREQUISITE of all sixteen after it
 * (`HARD_PREREQUISITES` in `../contract.ts`): each of its three failures — a dirty tree, a mixed
 * vector space, a half-built index — makes a later phase's commit wrong rather than merely
 * incomplete, and a dirty tree makes it the OPERATOR's bytes committed under sleep's trailers.
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

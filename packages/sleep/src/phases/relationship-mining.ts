import { Effect } from "effect"

import { emptyOutcome, type PhaseBody } from "../env.js"
import { neighbourPairs, replaceMinedEdges, SLEEP_EXCLUDED_TYPES } from "../sql.js"

/**
 * Phase 5, relationship mining. Derived `relates_to` edges in the index only. NO COMMIT.
 *
 * A mined edge is a re-derivable function of the corpus and the embedder. `index rebuild` plus the
 * next night's mining regenerates the identical set, so committing thousands of them would bury every
 * real diff in machine noise for zero recoverable information. The `derived` column is the firewall
 * that makes losing them cheap. The retention penalty counts only `derived = 0`, so an
 * uncorroborated machine suspicion cannot evict a memory.
 *
 * The insert is scoped to `provenance = 'sleep'` and `derived = 1` and the whole replace is one
 * atomic batch, so an authored edge is unreachable from here and the corpus is never left with the
 * old mined set deleted and the new one not yet written. In that window the lateral arm would
 * silently return nothing.
 */

/** The similarity floor a pair must clear to become a mined `relates_to`. */
export const MINING_COSINE_FLOOR = 0.85

/** Nearest neighbours considered per source file. */
export const MINING_PER_SOURCE_K = 5

/** Pairs mined per cycle. The cost guard on a corpus whose pair space is quadratic. */
export const MINING_SAMPLE_LIMIT = 2000

export const relationshipMining: PhaseBody = (env) =>
  Effect.gen(function* () {
    /**
     * Tasks are excluded, and here the exclusion is the graph firewall, not a cost guard.
     * Every mined edge is written with `edge_class = 'memory'`, so a pair with a task endpoint
     * would put a task INTO the memory graph, reaching PageRank, MMR, and the retention bridge
     * count. The `edges` CHECK cannot refuse it, because `relates_to` under `memory` is a
     * well-formed edge whatever files sit at its ends.
     */
    const pairs = yield* neighbourPairs(env.deps.db, {
      floor: MINING_COSINE_FLOOR,
      perSourceK: MINING_PER_SOURCE_K,
      limit: MINING_SAMPLE_LIMIT,
      excludeTypes: SLEEP_EXCLUDED_TYPES
    })

    const counts = { candidates: pairs.length, mined: pairs.length }
    if (env.dryRun) return emptyOutcome(counts)

    yield* replaceMinedEdges(env.deps.db, {
      runId: env.runId,
      at: env.at,
      rel: "relates_to",
      pairs
    })
    return emptyOutcome(counts)
  })

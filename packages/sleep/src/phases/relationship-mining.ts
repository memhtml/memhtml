import { Effect } from "effect"

import { emptyOutcome, type PhaseBody, type PhaseEnv, type SleepError } from "../env.js"
import { neighborPairs, replaceMinedEdges, SLEEP_EXCLUDED_TYPES } from "../sql.js"

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
 *
 * **Under `--deep` the phase additionally mines a GROUPING band (issue #63).** On a measured 3,079-file
 * inbox, 8% of files have a neighbor at the 0.85 floor and 84% touch no edge at all — no community, so
 * compress is structurally unable to reach them at any frequency. The deep band mines
 * [{@link DEEP_MINING_COSINE_FLOOR}, {@link MINING_COSINE_FLOOR}) as `laterally_related` edges whose
 * only consumer intent is giving label propagation a partition; the existing compress model then
 * judges the folds, and `absorbedKeys: []` is its refusal, so a looser grouping floor costs calls and
 * never correctness.
 *
 * **The two bands are separate rels, and that is the isolation mechanism.** {@link replaceMinedEdges}
 * scopes its atomic delete by rel, so the deep replace cannot clobber the default `relates_to` set and
 * the default replace cannot clobber the deep band. The issue sketched a distinct PROVENANCE instead;
 * the `edges` CHECKs pin `derived = 1` to `provenance = 'sleep'` (migration 0008), so that spelling
 * needs a table recreate while a distinct rel needs nothing: `laterally_related` is already in the
 * memory-rel vocabulary with no producer, and edge typing's candidate scan reads `rel = 'relates_to'`
 * alone, so the deep band never spends default edge-typing calls. A default run never touches the
 * deep rel, so a deep band persists until the next deep run re-mines it or `index rebuild` drops it —
 * both re-derivable, which is the property that makes an index-only edge safe to hold.
 */

/** The similarity floor a pair must clear to become a mined `relates_to`. */
export const MINING_COSINE_FLOOR = 0.85

/**
 * The GROUPING-band floor deep mining reaches down to (issue #63). At 0.72, between 43% and 61% of
 * the measured bulk-import inbox has a neighbor (43% at 0.75, 61% at 0.70, median best-neighbor
 * cosine 0.731) — reach enough to partition most of the tail while staying above the ~0.5-0.6
 * cross-topic baseline the fixture corpora measure, so a community is still a topic and not noise.
 * The compress model judging every proposed fold is what makes this floor a cost knob rather than a
 * correctness one.
 */
export const DEEP_MINING_COSINE_FLOOR = 0.72

/** Nearest neighbors considered per source file. */
export const MINING_PER_SOURCE_K = 5

/**
 * Pairs mined per cycle: a cap on what {@link replaceMinedEdges} writes, not on the scan — the
 * kernel's arithmetic is O(n²·d) whatever this says, and it bounds the edge table so one dense
 * neighborhood cannot flood the graph the lateral arm and PageRank read.
 */
export const MINING_SAMPLE_LIMIT = 2000

/**
 * The deep band's own write cap. Separate from {@link MINING_SAMPLE_LIMIT} because the band is wider
 * by construction — it exists to reach the 84% the default band cannot — and sharing the default cap
 * would make the deep run's reach a function of how crowded the default band happens to be.
 */
export const DEEP_MINING_SAMPLE_LIMIT = 10000

/** The rel the deep grouping band is written under. The band separator; see the module header. */
export const DEEP_GROUPING_REL = "laterally_related"

/**
 * Mine every band the run is entitled to and replace the index's mined sets: the whole phase minus
 * its counts. Exported because deep compress re-runs it BETWEEN passes (issue #63's
 * iterate-until-quiet): a fold's canonical is a new neighbor only after it is indexed and re-mined,
 * and a second implementation of the scan here would be free to disagree with the default one about
 * floors, caps, and exclusions.
 */
export const mineAllBands = (
  env: PhaseEnv
): Effect.Effect<{ readonly mined: number; readonly deepMined: number }, SleepError> =>
  Effect.gen(function* () {
    /**
     * Tasks are excluded, and here the exclusion is the graph firewall, not a cost guard.
     * Every mined edge is written with `edge_class = 'memory'`, so a pair with a task endpoint
     * would put a task INTO the memory graph, reaching PageRank, MMR, and the retention bridge
     * count. The `edges` CHECK cannot refuse it, because `relates_to` under `memory` is a
     * well-formed edge whatever files sit at its ends.
     */
    const pairs = yield* neighborPairs(env.deps.db, {
      floor: MINING_COSINE_FLOOR,
      perSourceK: MINING_PER_SOURCE_K,
      limit: MINING_SAMPLE_LIMIT,
      excludeTypes: SLEEP_EXCLUDED_TYPES
    })

    /**
     * The deep grouping band: everything in [deep floor, default floor). Mined only under `--deep`,
     * so a default run's writes — and therefore the graph every consumer reads on a corpus
     * that has never run deep — are byte-identical to what they were before this branch existed.
     * The default floor is the band's EXCLUSIVE ceiling: a pair at or above it is the default
     * band's, and holding it in both would double its label-propagation weight.
     */
    const deepPairs =
      env.deep === undefined
        ? []
        : (yield* neighborPairs(env.deps.db, {
            floor: DEEP_MINING_COSINE_FLOOR,
            perSourceK: MINING_PER_SOURCE_K,
            limit: DEEP_MINING_SAMPLE_LIMIT,
            excludeTypes: SLEEP_EXCLUDED_TYPES
          })).filter((pair) => pair.sim < MINING_COSINE_FLOOR)

    if (!env.dryRun) {
      yield* replaceMinedEdges(env.deps.db, {
        runId: env.runId,
        at: env.at,
        rel: "relates_to",
        pairs
      })
      if (env.deep !== undefined) {
        yield* replaceMinedEdges(env.deps.db, {
          runId: env.runId,
          at: env.at,
          rel: DEEP_GROUPING_REL,
          pairs: deepPairs
        })
      }
    }
    return { mined: pairs.length, deepMined: deepPairs.length }
  })

export const relationshipMining: PhaseBody = (env) =>
  Effect.gen(function* () {
    const mined = yield* mineAllBands(env)
    return emptyOutcome({
      candidates: mined.mined,
      mined: mined.mined,
      ...(env.deep === undefined ? {} : { deepMined: mined.deepMined })
    })
  })

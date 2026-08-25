import type { StorageFailure } from "@memhtml/contracts/errors"
import {
  bridgeCounts,
  type GraphEdge,
  labelPropagation,
  pagerank,
  type RetentionScore,
  scoreRetention
} from "@memhtml/domain"
import type { DatabaseShape } from "@memhtml/index"
import { Effect } from "effect"

import {
  accessRows,
  activeCorpus,
  type CorpusRow,
  memoryEdges,
  retentionEdgeCounts
} from "./sql.js"

/**
 * The retention scoring pass: ONE function, executed independently by each phase that needs a
 * banded corpus — `arc-synthesis`, `retention-triage`, `compress`, and `reprieve` each call it once,
 * and a deep compress run recomputes it per pass after re-indexing, deliberately.
 *
 * Shared as one FUNCTION because the consumers must agree by construction: they read the same
 * corpus through the same scoring, so a memory that triage banded COMPRESS is the same memory
 * compress sees banded COMPRESS. The index is refreshed once in preflight and the inputs below are
 * all index reads, so the nightly executions are recomputations of one deterministic function over
 * unchanged rows — they agree by determinism, not by sharing a value. NOT memoized per run, and the
 * reason is where a cache could live: a module-level cache is the contaminating-state failure this
 * repo has paid for repeatedly (see `PhaseEnv.detectionBudget`'s note), it would serve stale scores
 * to the deep compress loop that re-indexes mid-phase, and the sanctioned per-run slot on `PhaseEnv`
 * is the runner's surface to grow, not this module's.
 *
 * PageRank and communities run in TypeScript over the memory-class edge list, both deterministic:
 * PageRank sorts its nodes before iterating so the floating-point summation order is fixed, and label
 * propagation visits in sorted order with lexicographic tie-breaking instead of a random seed. These
 * scores decide which memories are evicted, so a run-to-run reordering would
 * change the outcome on a corpus that did not change.
 */

/** One scored memory, with everything both consumers need. */
export interface ScoredMemory {
  readonly row: CorpusRow
  readonly score: RetentionScore
  /** The community label, or `undefined` below the minimum community size. */
  readonly community: string | undefined
  /** Durable access bookkeeping, zeroed when the path has never been retrieved. */
  readonly access: {
    readonly accessCount: number
    readonly reinforcementCount: number
    readonly outcomeScore: number
    readonly lastAccessedAt: string | null
  }
}

/** The whole pass: every active memory scored, plus the community partition. */
export interface RetentionPass {
  readonly scored: ReadonlyArray<ScoredMemory>
  readonly communities: ReadonlyMap<string, string | undefined>
}

/**
 * Fractional days between two ISO instants, floored at zero.
 *
 * The clamp holds the result non-negative instead of assuming it. A file whose `memhtml-updated` is
 * ahead of the run date, from a clock skew or a hand-edited stamp, would otherwise produce a negative
 * age and an exponential recency signal ABOVE 1, which the retention composite's convexity forbids.
 */
export const ageDaysBetween = (from: string, to: string): number => {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, (end - start) / 86_400_000)
}

/** Fractional hours between two ISO instants, floored at zero. */
export const hoursBetween = (from: string, to: string): number => ageDaysBetween(from, to) * 24

/**
 * Score every active memory.
 *
 * `at` is the run's own instant, passed in instead of read from a clock. The recency signal is a
 * function of it, so a fixed instant is what makes a band decision assertable in a test.
 */
export const runRetentionPass = (
  db: DatabaseShape,
  at: string
): Effect.Effect<RetentionPass, StorageFailure> =>
  Effect.gen(function* () {
    const corpus = yield* activeCorpus(db)
    const edges = yield* memoryEdges(db)
    const edgeCounts = yield* retentionEdgeCounts(db)
    const access = yield* accessRows(db)

    const nodes = corpus.map((row) => row.path)
    const graphEdges: ReadonlyArray<GraphEdge> = edges.map((edge) => ({
      src: edge.src_path,
      dst: edge.dst_path,
      strength: edge.strength
    }))

    const ranks = pagerank(nodes, graphEdges)
    const communities = labelPropagation(nodes, graphEdges)
    const bridges = bridgeCounts(nodes, graphEdges, communities)
    const maxRank = [...ranks.values()].reduce((best, value) => Math.max(best, value), 0)

    const countsByPath = new Map(edgeCounts.map((row) => [row.path, row]))
    const accessByPath = new Map(access.map((row) => [row.path, row]))

    const scored = corpus.map((row): ScoredMemory => {
      const counters = countsByPath.get(row.path)
      const accessRow = accessByPath.get(row.path)
      const score = scoreRetention({
        memoryType: row.memory_type,
        ageDays: ageDaysBetween(row.updated_at, at),
        accessCount: accessRow?.access_count ?? 0,
        confidence: row.confidence,
        graphRank: ranks.get(row.path) ?? 0,
        maxGraphRank: maxRank,
        bridgeCount: bridges.get(row.path) ?? 0,
        reinforcementCount: counters?.reinforcements ?? 0,
        wordCount: row.word_count,
        contradictionCount: counters?.contradictions ?? 0
      })
      return {
        row,
        score,
        community: communities.get(row.path),
        access: {
          accessCount: accessRow?.access_count ?? 0,
          reinforcementCount: accessRow?.reinforcement_count ?? 0,
          outcomeScore: accessRow?.outcome_score ?? 0,
          lastAccessedAt: accessRow?.last_accessed_at ?? null
        }
      }
    })

    return { scored, communities }
  })

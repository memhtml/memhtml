import { cosine } from "./cosine.js"
import { MMR_LAMBDA } from "./ranking.js"

/**
 * Maximal marginal relevance over vectors the fusion query already returned. No embedding
 * round-trip: the candidates carry their own vectors.
 */

/**
 * A candidate for diversification. `score` is its fused relevance (unitless, higher is
 * better); `vector` is its embedding, or `undefined` when the chunk has no vector yet, which
 * happens for a lexical-floor hit or a deferred embed.
 */
export interface MmrCandidate {
  readonly path: string
  readonly score: number
  readonly vector?: ReadonlyArray<number> | undefined
}

/**
 * Greedily reorder candidates by `lambda * relevance - (1 - lambda) * maxSimilarityToSelected`.
 *
 * `lambda` is unitless in `[0, 1]`: 1 is pure relevance, 0 is pure diversity. At `lambda >= 1`
 * the function short-circuits and returns the input order truncated, because the penalty term
 * is multiplied by zero and the greedy pass would otherwise burn O(n^2) cosines to reproduce
 * the order it was given.
 *
 * A candidate with no vector takes penalty 0, which is how "unknown similarity" reads here. A
 * vectorless candidate cannot be shown to duplicate anything, so it is not penalized for it.
 * Vectorless candidates therefore keep their relative fusion order among themselves rather
 * than being shuffled by a fabricated distance.
 *
 * The output is always a duplicate-free subsequence of the input by membership: each candidate
 * is selected at most once and nothing is invented.
 */
export const applyMmr = (
  candidates: ReadonlyArray<MmrCandidate>,
  limit: number,
  lambda: number = MMR_LAMBDA
): ReadonlyArray<MmrCandidate> => {
  if (limit <= 0) return []
  if (lambda >= 1 || candidates.length <= 1) return candidates.slice(0, limit)

  const pool = [...candidates]
  const selected: Array<MmrCandidate> = []

  while (pool.length > 0 && selected.length < limit) {
    let bestIndex = 0
    let bestValue = Number.NEGATIVE_INFINITY

    for (const [index, candidate] of pool.entries()) {
      let penalty = 0
      if (candidate.vector !== undefined) {
        for (const chosen of selected) {
          if (chosen.vector === undefined) continue
          penalty = Math.max(penalty, cosine(candidate.vector, chosen.vector))
        }
      }
      const value = lambda * candidate.score - (1 - lambda) * penalty
      if (value > bestValue) {
        bestValue = value
        bestIndex = index
      }
    }

    const [chosen] = pool.splice(bestIndex, 1)
    if (chosen !== undefined) selected.push(chosen)
  }

  return selected
}

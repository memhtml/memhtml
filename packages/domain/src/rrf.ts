import { RRF_K } from "./ranking.js"

/**
 * The pure reciprocal-rank-fusion fold. The SQL that produces each arm's ranked list is the
 * index layer's; the arithmetic that combines them lives here, so a fusion-weight change is
 * testable without a database.
 */

/**
 * One arm's hit. `rank` is a **1-based position within that one arm's own candidate list**,
 * not a global rank and not a score. That is what lets RRF work across arms whose scores
 * are incomparable.
 */
export interface ArmHit {
  readonly path: string
  readonly rank: number
}

/**
 * One arm's contribution: `weight / (rank + k)`, unitless.
 *
 * Strictly decreasing in `rank` and linear in `weight`, so a weight-0 arm contributes exactly
 * 0 and is inert in the fold. `k` damps the difference between the top ranks, which is what
 * stops one arm's confident first place from dominating four other arms' consensus.
 */
export const rrfScore = (rank: number, weight: number, k: number = RRF_K): number =>
  weight / (rank + k)

/**
 * Fuse per-arm ranked lists into one `path -> score` map by summing contributions.
 *
 * `armResults[i]` pairs with `weights[i]`; an arm with no weight scores 0 throughout. Addition
 * commutes, so the result is order-insensitive across arms and the arm registry's order
 * is a presentation detail rather than a ranking input. A duplicate path inside one arm's
 * list accumulates, matching the SQL's `SUM` over a `UNION ALL`.
 */
export const fuseArms = (
  armResults: ReadonlyArray<ReadonlyArray<ArmHit>>,
  weights: ReadonlyArray<number>,
  k: number = RRF_K
): ReadonlyMap<string, number> => {
  const fused = new Map<string, number>()
  for (const [index, hits] of armResults.entries()) {
    const weight = weights[index] ?? 0
    if (weight === 0) continue
    for (const hit of hits) {
      fused.set(hit.path, (fused.get(hit.path) ?? 0) + rrfScore(hit.rank, weight, k))
    }
  }
  return fused
}

/**
 * Fused scores as a ranked list, best first. Ties break on path ascending, so the ordering is
 * total and reproducible. Two runs over the same corpus produce the same list, which is what
 * the discrimination gate compares against.
 */
export const rankFused = (
  fused: ReadonlyMap<string, number>
): ReadonlyArray<{ readonly path: string; readonly score: number }> =>
  [...fused.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((left, right) => right.score - left.score || (left.path < right.path ? -1 : 1))

/**
 * Fold a graph-walk result into existing fused scores, treating the walk's best-first order as
 * an arm's ranked list. A node absent from `fused` enters at its lateral-only contribution,
 * which is how a memory the lexical and vector arms both missed can still surface.
 *
 * An empty `order` or a non-positive `weight` returns the scores unchanged, so the lateral arm
 * is inert when dark and cannot fail on a cold graph.
 */
export const fuseLateral = (
  fused: ReadonlyMap<string, number>,
  order: ReadonlyArray<string>,
  weight: number,
  k: number = RRF_K
): ReadonlyMap<string, number> => {
  const merged = new Map(fused)
  if (weight <= 0 || order.length === 0) return merged
  for (const [index, path] of order.entries()) {
    merged.set(path, (merged.get(path) ?? 0) + rrfScore(index + 1, weight, k))
  }
  return merged
}

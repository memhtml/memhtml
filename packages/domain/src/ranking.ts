import { Option } from "effect"

/**
 * Reciprocal-rank-fusion's rank offset. 60 is the published default and the value
 * the retrieval SQL inlines as a literal, so it lives here once and the assembler
 * reads it rather than restating it.
 */
export const RRF_K = 60

/** Maximal-marginal-relevance's relevance/diversity split. */
export const MMR_LAMBDA = 0.5

/**
 * Seconds an access bump waits before it counts again. Stated once here and once
 * in the salience arm's SQL; a property test pins the two to agree at the boundary.
 */
export const REINFORCE_COOLDOWN_S = 900

/**
 * One arm's contribution to a fused score. `rank` is 1-based within that arm's
 * candidate list; `weight` is the arm's configured multiplier.
 *
 * A zero-weight arm and an out-of-range rank both yield `None` rather than 0, so a
 * disabled arm is structurally absent from the fold instead of silently adding a
 * neutral term that later arithmetic could mistake for a real score.
 */
export const rrfContribution = (rank: number, weight: number): Option.Option<number> =>
  !Number.isFinite(rank) || rank < 1 || weight <= 0
    ? Option.none()
    : Option.some(weight / (rank + RRF_K))

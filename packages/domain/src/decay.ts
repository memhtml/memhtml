/**
 * Confidence decay and the outcome EWMA, both on a fixed-point grid.
 *
 * The confidence-decay half IS the production path: sleep's confidence-decay phase calls
 * `decayConfidence` directly. The outcome-EWMA half is the REFERENCE implementation the
 * production SQL is checked against: `packages/index/src/reinforce.ts` computes the outcome
 * EWMA in float SQL with its own `OUTCOME_EWMA_ALPHA = 0.3` twin of
 * {@link DEFAULT_EWMA_ALPHA}, and the two constants are pinned to agree by each package's
 * tests.
 *
 * Every invariant here is a boundary claim. Decay stops *at* the floor, `alpha = 1` snaps
 * *exactly* to it, and `alpha = 0` is *exactly* a fixed point. In float arithmetic a convex
 * combination of two equal values can land one ulp below them, so the boundary cases would
 * hold approximately and fail as written. On the integer grid they are exact, so the
 * property tests can assert equality instead of closeness. Ported from the predecessor
 * memory system's `domain/curation.py`.
 */

/** The fixed-point scale: 10^4, so the grid step is the 4th decimal place. */
export const SCALE = 10_000

/** `+1.0` and `-1.0` on the grid. The outcome EWMA's domain is `[NEG_ONE_FP, POS_ONE_FP]`. */
export const POS_ONE_FP = SCALE
export const NEG_ONE_FP = -SCALE

/**
 * The outcome EWMA's weight on an incoming signal. Its production twin is
 * `OUTCOME_EWMA_ALPHA` in `packages/index/src/reinforce.ts`, the value the reinforce SQL
 * binds; both packages' tests pin their constant to 0.3 so a fork fails loudly.
 */
export const DEFAULT_EWMA_ALPHA = 0.3

/**
 * The floor confidence erodes toward but never past. A claim that stops being reinforced
 * loses weight without vanishing: an old uncorroborated claim is weak evidence, not absent
 * evidence, and a memory decayed to 0 would be indistinguishable from a retracted one.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.2

/**
 * The per-sleep-cycle confidence decay weight. Gentler than {@link DEFAULT_EWMA_ALPHA} on
 * purpose: confidence should erode over many unreinforced nights rather than collapse in
 * one, so a single missed reinforcement is forgiving. At 0.1 a claim closes a tenth of its
 * distance to the floor per cycle.
 */
export const DEFAULT_CONFIDENCE_DECAY_ALPHA = 0.1

/** A float in `[-1, 1]` onto the grid, rounded to the nearest grid point. */
export const toFp = (value: number): number => Math.round(value * SCALE)

/** A grid value back to a float. Exact. */
export const fromFp = (valueFp: number): number => valueFp / SCALE

/**
 * One EWMA step on the grid: `alpha * signal + (1 - alpha) * prev`, divided back down with
 * **floor** division. Floor rather than round-half-away because it is the one rounding mode
 * whose N-fold composition is reproducible without a rounding-mode argument, and the
 * residual drift against an unrounded fold is bounded by one grid step.
 *
 * For `alphaFp` in `[0, SCALE]` and both values in `[NEG_ONE_FP, POS_ONE_FP]` the result
 * stays in that domain and lies between `prevFp` and `signalFp`, so a negative signal can
 * never raise the score.
 */
export const ewmaStepFp = (alphaFp: number, prevFp: number, signalFp: number): number =>
  Math.floor((alphaFp * signalFp + (SCALE - alphaFp) * prevFp) / SCALE)

/**
 * Fold signals through {@link ewmaStepFp}, one rounding per step. Rounding inside the fold
 * rather than once at the end is what makes an N-signal batch agree with N single-signal
 * calls. Sleep may process a memory's corrections in one batch or across several nights,
 * and both paths must reach the same score.
 */
export const applyOutcomesFp = (
  alphaFp: number,
  prevFp: number,
  signalsFp: ReadonlyArray<number>
): number => signalsFp.reduce((score, signalFp) => ewmaStepFp(alphaFp, score, signalFp), prevFp)

/**
 * Decay a score toward -1.0 over `hits` negative corrections. `hits <= 0` is a no-op, so
 * re-running a phase over an already-drained watermark writes the same value.
 */
export const applyNegativeHitsFp = (alphaFp: number, prevFp: number, hits: number): number =>
  hits <= 0
    ? prevFp
    : applyOutcomesFp(
        alphaFp,
        prevFp,
        Array.from({ length: hits }, () => NEG_ONE_FP)
      )

/**
 * One confidence-decay step on the grid: an EWMA toward the floor, then a `min` with the
 * previous value.
 *
 * The `min` is what makes the step *unconditionally* non-increasing. Without it, a claim
 * already below the floor (one an operator correction pushed down, say) would be pulled
 * back *up* toward the floor by the same convex combination that erodes a healthy claim, so
 * decay would rehabilitate a discredited memory. The floor is a resting place for a claim
 * that stops being reinforced. A refuted claim is not pulled back up to it.
 */
export const decayConfidenceFp = (alphaFp: number, confFp: number, floorFp: number): number =>
  Math.min(confFp, ewmaStepFp(alphaFp, confFp, floorFp))

/**
 * Fold `cycles` decay steps. `cycles <= 0` is a no-op, so a phase re-run within one night
 * writes the same value.
 */
export const decayConfidenceNFp = (
  alphaFp: number,
  confFp: number,
  floorFp: number,
  cycles: number
): number => {
  let score = confFp
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    score = decayConfidenceFp(alphaFp, score, floorFp)
  }
  return score
}

/**
 * One confidence-decay step in the `[0, 1]` float space the HTML `memhtml-confidence` meta uses.
 * `alpha` is the fraction of the remaining distance to `floor` closed per cycle, both
 * unitless in `[0, 1]`.
 */
export const decayConfidence = (
  confidence: number,
  alpha: number = DEFAULT_CONFIDENCE_DECAY_ALPHA,
  floor: number = DEFAULT_CONFIDENCE_FLOOR
): number => fromFp(decayConfidenceFp(toFp(alpha), toFp(confidence), toFp(floor)))

/** {@link decayConfidence} folded over `cycles` unreinforced sleep cycles. */
export const decayConfidenceN = (
  confidence: number,
  cycles: number,
  alpha: number = DEFAULT_CONFIDENCE_DECAY_ALPHA,
  floor: number = DEFAULT_CONFIDENCE_FLOOR
): number => fromFp(decayConfidenceNFp(toFp(alpha), toFp(confidence), toFp(floor), cycles))

/**
 * The smallest confidence change worth committing. Confidence decay is the widest commit in
 * a sleep run, one meta line across many files, so a sub-threshold delta is dropped rather
 * than committed, keeping the night's diff reviewable.
 */
export const CONFIDENCE_COMMIT_DELTA = 0.005

/** True when a decayed confidence differs enough from the stored one to be worth a commit. */
export const isCommittableConfidenceChange = (before: number, after: number): boolean =>
  Math.abs(before - after) >= CONFIDENCE_COMMIT_DELTA

import { compensatedSum } from "./cosine.js"

/**
 * The eight-signal retention scorer and its triage bands, ported from the predecessor
 * memory system's `domain/retention.py`. Pure: the SQL phase gathers the raw inputs and calls this.
 */

/** The eight signals, in the fixed order every weight profile keys on. */
export const SIGNAL_NAMES = [
  "recency",
  "accessFrequency",
  "confidence",
  "pagerank",
  "bridgeImportance",
  "reinforcementCount",
  "contentDensity",
  "contestedStatus"
] as const

export type SignalName = (typeof SIGNAL_NAMES)[number]

/** A full set of normalized signal values, each unitless in `[0, 1]`. */
export type Signals = { readonly [K in SignalName]: number }

/** A weight profile: one coefficient per signal, the eight summing to exactly 1.0. */
export type WeightProfile = { readonly [K in SignalName]: number }

/** The triage verdict for one memory. */
export const TRIAGE_ACTIONS = ["keep", "compress", "evict"] as const
export type TriageAction = (typeof TRIAGE_ACTIONS)[number]

/**
 * Per-type weight profiles. Every profile's eight weights sum to exactly 1.0 under
 * compensated summation, which is what makes the composite a convex combination of eight
 * `[0, 1]` signals and therefore itself in `[0, 1]`.
 *
 * The five profiles below are the typed ones; every other memory type falls back to
 * {@link DEFAULT_WEIGHTS}. Recency carries the most weight for `episodic` (time is that
 * type's identity) and zero for `procedural` (a working procedure does not stale).
 */
export const WEIGHT_PROFILES: Readonly<Record<string, WeightProfile>> = {
  episodic: {
    recency: 0.25,
    accessFrequency: 0.15,
    confidence: 0.1,
    pagerank: 0.1,
    bridgeImportance: 0.1,
    reinforcementCount: 0.1,
    contentDensity: 0.1,
    contestedStatus: 0.1
  },
  semantic: {
    recency: 0.05,
    accessFrequency: 0.15,
    confidence: 0.2,
    pagerank: 0.2,
    bridgeImportance: 0.15,
    reinforcementCount: 0.1,
    contentDensity: 0.1,
    contestedStatus: 0.05
  },
  procedural: {
    recency: 0.0,
    accessFrequency: 0.2,
    confidence: 0.15,
    pagerank: 0.15,
    bridgeImportance: 0.1,
    reinforcementCount: 0.2,
    contentDensity: 0.1,
    contestedStatus: 0.1
  },
  arc: {
    recency: 0.1,
    accessFrequency: 0.1,
    confidence: 0.15,
    pagerank: 0.15,
    bridgeImportance: 0.15,
    reinforcementCount: 0.15,
    contentDensity: 0.1,
    contestedStatus: 0.1
  },
  error_pattern: {
    recency: 0.2,
    accessFrequency: 0.15,
    confidence: 0.1,
    pagerank: 0.05,
    bridgeImportance: 0.05,
    reinforcementCount: 0.2,
    contentDensity: 0.1,
    contestedStatus: 0.15
  }
}

/** The profile for a type with no dedicated one. Also sums to exactly 1.0. */
export const DEFAULT_WEIGHTS: WeightProfile = {
  recency: 0.15,
  accessFrequency: 0.15,
  confidence: 0.15,
  pagerank: 0.15,
  bridgeImportance: 0.1,
  reinforcementCount: 0.1,
  contentDensity: 0.1,
  contestedStatus: 0.1
}

/**
 * Recency half-lives in days. `null` means no time decay. An unlisted type takes
 * {@link DEFAULT_HALF_LIFE_DAYS}.
 */
export const HALF_LIVES_DAYS: Readonly<Record<string, number | null>> = {
  episodic: 10,
  semantic: 90,
  procedural: null,
  arc: 30,
  error_pattern: 14,
  /**
   * A task does not decay. This entry documents that and nothing reads it today, because sleep's
   * phases exclude tasks by type before any of them is scored, so nothing reaches the scorer to
   * decay. It is stated anyway, because the fallback for an unlisted type is
   * {@link DEFAULT_HALF_LIFE_DAYS}. If a future caller DOES score a task, the answer is then
   * "age says nothing about it" rather than a silent 30-day half-life. Age is actively
   * misleading about intended work, since an untouched task is the most likely to still be
   * owed.
   */
  task: null
}

/** Half-life in days for a type with no listed one. */
export const DEFAULT_HALF_LIFE_DAYS = 30

/**
 * The recency decay constant. `Math.LN2` rather than a `0.693` literal, so
 * `exp(-LN2 * age / halfLife)` is **exactly** 0.5 at `age == halfLife`. The half-life is
 * then the definition of the curve rather than an approximation of it, and a property test
 * can assert the equality instead of a tolerance.
 */
export const LN2 = Math.LN2

/**
 * Band edges. KEEP is `> 0.7`, EVICT is `<= 0.3`, and COMPRESS is the open interval between.
 * **Each boundary is owned by the lower band**: exactly 0.7 compresses, exactly 0.3
 * evicts. The three bands partition `[0, 1]` with no gap and no overlap.
 */
export const KEEP_THRESHOLD = 0.7
export const EVICT_THRESHOLD = 0.3

/** Decimal places the composite is rounded to, matching the predecessor's grain. */
export const SCORE_PRECISION = 4

/**
 * The raw per-memory inputs the SQL phase gathers. Kept raw rather than pre-normalized so
 * the normalization curves live in exactly one place, {@link computeSignals}.
 *
 * Units and scopes, per field:
 * - `memoryType` selects the weight profile and the half-life.
 * - `ageDays`: fractional days since the memory's own last update. Non-negative.
 * - `accessCount`: a quantity, per-memory lifetime, 0-based.
 * - `confidence`: unitless in `[0, 1]`; clamped rather than rejected.
 * - `graphRank` / `maxGraphRank`: PageRank scores in the same run's scale;
 *   `maxGraphRank` is that run's maximum, so the ratio is corpus-relative, not absolute.
 * - `bridgeCount`: a quantity of cross-community memory edges for this memory.
 * - `reinforcementCount`: a quantity of inbound `supports`/`reinforces` edges.
 * - `wordCount`: a quantity of words in the memory's body.
 * - `contradictionCount`: a quantity of **authored** (`derived: false`) contradictions;
 *   a sleep-mined suspicion is excluded upstream, so a machine guess cannot evict.
 */
export interface RetentionInput {
  readonly memoryType: string
  readonly ageDays: number
  readonly accessCount: number
  readonly confidence: number
  readonly graphRank: number
  readonly maxGraphRank: number
  readonly bridgeCount: number
  readonly reinforcementCount: number
  readonly wordCount: number
  readonly contradictionCount: number
}

/** The scoring result: the composite, its band, and the normalized signals behind it. */
export interface RetentionScore {
  readonly score: number
  readonly action: TriageAction
  readonly signals: Signals
}

/** The weight profile for a memory type. */
export const weightsFor = (memoryType: string): WeightProfile =>
  WEIGHT_PROFILES[memoryType] ?? DEFAULT_WEIGHTS

/** The recency half-life in days for a memory type; `null` means no time decay. */
export const halfLifeFor = (memoryType: string): number | null =>
  memoryType in HALF_LIVES_DAYS ? (HALF_LIVES_DAYS[memoryType] ?? null) : DEFAULT_HALF_LIFE_DAYS

/**
 * A profile's weight sum under compensated summation. Every shipped profile returns exactly
 * `1`; this is the convexity fact the composite's `[0, 1]` range rests on.
 */
export const profileWeightSum = (profile: WeightProfile): number =>
  compensatedSum(SIGNAL_NAMES.map((name) => profile[name]))

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Exponential recency decay. No half-life or a non-positive age means no decay. */
const signalRecency = (memoryType: string, ageDays: number): number => {
  const halfLife = halfLifeFor(memoryType)
  if (halfLife === null || ageDays <= 0) return 1
  return Math.exp((-LN2 * ageDays) / halfLife)
}

/** Ten or more accesses saturates. */
const signalAccessFrequency = (accessCount: number): number => Math.min(1, accessCount / 10)

/** Five or more cross-community edges saturates. */
const signalBridge = (bridgeCount: number): number => Math.min(1, bridgeCount / 5)

/** Five or more inbound reinforcements saturates. */
const signalReinforcement = (reinforcementCount: number): number =>
  Math.min(1, reinforcementCount / 5)

/**
 * Word count as a density proxy: 100 words saturates, and a body under 10 words is
 * penalized into `[0, 0.5)`, because a one-line memory carries less recoverable content
 * than its raw length suggests.
 */
const signalContentDensity = (wordCount: number): number =>
  wordCount < 10 ? Math.max(0, wordCount) / 20 : Math.min(1, wordCount / 100)

/** Three or more contradictions floors the signal at 0. Inverted: more contested is worse. */
const signalContested = (contradictionCount: number): number =>
  1 - Math.min(1, Math.max(0, contradictionCount) / 3)

/** Normalize the raw inputs to their `[0, 1]` signal values. */
export const computeSignals = (input: RetentionInput): Signals => ({
  recency: clamp01(signalRecency(input.memoryType, input.ageDays)),
  accessFrequency: signalAccessFrequency(Math.max(0, input.accessCount)),
  confidence: clamp01(input.confidence),
  pagerank: input.maxGraphRank > 0 ? clamp01(Math.max(0, input.graphRank) / input.maxGraphRank) : 0,
  bridgeImportance: signalBridge(Math.max(0, input.bridgeCount)),
  reinforcementCount: signalReinforcement(Math.max(0, input.reinforcementCount)),
  contentDensity: clamp01(signalContentDensity(input.wordCount)),
  contestedStatus: signalContested(input.contradictionCount)
})

/**
 * The weighted composite, unitless in `[0, 1]`, rounded to {@link SCORE_PRECISION} places.
 * Compensated summation, so the fold does not accumulate the drift that makes a
 * by-construction-convex profile score marginally above 1.
 */
export const compositeScore = (signals: Signals, profile: WeightProfile): number => {
  const total = compensatedSum(SIGNAL_NAMES.map((name) => signals[name] * profile[name]))
  const factor = 10 ** SCORE_PRECISION
  return Math.round(total * factor) / factor
}

/**
 * The band a composite falls in. Boundaries belong to the lower band: 0.7 compresses and
 * 0.3 evicts, so the bands partition `[0, 1]` and no score is ever unbanded.
 */
export const bandFor = (score: number): TriageAction => {
  if (score > KEEP_THRESHOLD) return "keep"
  if (score > EVICT_THRESHOLD) return "compress"
  return "evict"
}

/** Score one memory: normalize, weight by its type's profile, band the composite. */
export const scoreRetention = (input: RetentionInput): RetentionScore => {
  const signals = computeSignals(input)
  const score = compositeScore(signals, weightsFor(input.memoryType))
  return { score, action: bandFor(score), signals }
}

/**
 * The reprieve gate's floor. A TTL-passed memory scoring at least this, under the reprieve
 * cap, has its `memhtml-valid-until` extended instead of being archived.
 */
export const REPRIEVE_FLOOR = 0.5

/** Days a reprieve extends `memhtml-valid-until` by. */
export const REPRIEVE_DAYS = 14

/**
 * Reprieves a memory may earn before it is forced to expire. `0` is the kill switch that
 * restores pure-age TTL: the floor alone can never force expiry, because the reprieve score
 * is a sum of non-negative terms and is therefore always above 0.
 */
export const MAX_REPRIEVES = 3

/** Salience decay rate per hour for the reprieve score's recency term. */
export const SALIENCE_DECAY_RATE = 0.01

/** The four reprieve coefficients. They sum to 1.0 but the score is NOT convex. */
export const REPRIEVE_W_IMPORTANCE = 0.4
export const REPRIEVE_W_ACCESS = 0.3
export const REPRIEVE_W_OUTCOME = 0.2
export const REPRIEVE_W_RECENCY = 0.1

/**
 * What the reprieve score reads. Units and scopes:
 * - `importance`: 1-based ordinal in `[1, 10]`, clamped; divided by 10 before use.
 * - `accessCount`: a quantity, per-memory lifetime, 0-based.
 * - `outcomeScore`: unitless in `[-1, 1]`. A negative value contributes 0.
 * - `hoursSinceAccess`: fractional hours, non-negative.
 */
export interface ReprieveInput {
  readonly importance: number
  readonly accessCount: number
  readonly outcomeScore: number
  readonly hoursSinceAccess: number
  readonly decayRate?: number | undefined
}

/**
 * The four-term reprieve score. Deliberately **not** convex: the `log1p(accessCount)` term
 * is unbounded, so the score can exceed 1. It is proven only monotone and sign-clamped.
 *
 * A negative `outcomeScore` contributes exactly 0 and does not subtract, mirroring the
 * salience arm's `max(coalesce(outcome_score, 0.0), 0.0)`. Without that clamp a memory that
 * once produced a bad outcome would be punished twice, once by the outcome EWMA that already
 * lowered its salience, and again here by having its reprieve pushed below the floor.
 */
export const reprieveScore = (input: ReprieveInput): number => {
  const importance = Math.max(1, Math.min(10, input.importance)) / 10
  const accessTerm = Math.log1p(Math.max(0, input.accessCount))
  const outcomeTerm = Math.max(0, input.outcomeScore)
  const decayRate = input.decayRate ?? SALIENCE_DECAY_RATE
  const recencyTerm = Math.exp(-decayRate * Math.max(0, input.hoursSinceAccess))
  return (
    REPRIEVE_W_IMPORTANCE * importance +
    REPRIEVE_W_ACCESS * accessTerm +
    REPRIEVE_W_OUTCOME * outcomeTerm +
    REPRIEVE_W_RECENCY * recencyTerm
  )
}

/**
 * The bounded reprieve gate. A TTL-passed memory is reprieved iff its score clears `floor`
 * AND it has been reprieved fewer than `maxReprieves` times. `maxReprieves: 0` forces every
 * TTL-passed memory to expire regardless of score.
 */
export const shouldReprieve = (input: {
  readonly score: number
  readonly reprieveCount: number
  readonly floor?: number | undefined
  readonly maxReprieves?: number | undefined
}): boolean =>
  input.score >= (input.floor ?? REPRIEVE_FLOOR) &&
  input.reprieveCount < (input.maxReprieves ?? MAX_REPRIEVES)

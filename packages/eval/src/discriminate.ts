import type { StorageFailure } from "@memhtml/contracts/errors"
import type { RetrievalShape } from "@memhtml/index"
import { Effect } from "effect"

import type { DivergenceFamily } from "./controls.js"
import type { Probe } from "./corpus.js"

/**
 * The discrimination gate: can the retrieval stack rank a memory above its own high-similarity
 * WRONG twin?
 *
 * A retrieval layer that cannot is not shipping. Cosine similarity is geometric, and an embedding
 * model is weakest on exactly the tokens carrying a fact's polarity and its discriminators — so
 * "drain the VIP before reverting" and "do NOT drain the VIP before reverting" sit above 0.99 in
 * vector space while asserting opposite things. Every arm of the fold exists to break that tie, and
 * this is the only measurement that says whether they do.
 *
 * **Two numbers, and the strict one is the gate.** MRR is the aggregate an operator reads; the
 * refusal is per-probe and absolute: a single target ranked at or below any of its own controls is an
 * inversion, and one inversion fails the run regardless of what MRR says. An aggregate alone can be
 * bought by thirty easy probes covering one broken one.
 */

/** Which embedder produced the numbers. Recorded on the report so a pass is never ambiguous. */
export type EvalMode = "live" | "fake"

/** One probe's outcome. */
export interface ProbeResult {
  readonly query: string
  readonly targetPath: string
  /**
   * 1-based rank of the target within the WHOLE returned hit list, or `null` when it was not returned.
   * Scope: every active memory in the corpus. Compare against {@link discriminationRank}, which is the
   * same position measured in a different space.
   */
  readonly targetRank: number | null
  /**
   * 1-based rank of the target within `{target} ∪ controls` ALONE — the space the gate is stated in.
   * `1` means the target beat every one of its own impostors. Never `null`: the target is always a
   * member of this set, so an absent target ranks last rather than nowhere.
   */
  readonly discriminationRank: number
  /** Each control's 1-based rank in the whole hit list, `null` when absent from the hits. */
  readonly controlRanks: ReadonlyArray<{
    readonly path: string
    readonly family: DivergenceFamily
    readonly rank: number | null
  }>
  /**
   * True when the target strictly outranks EVERY control. A control the search never returned counts
   * as outranked: being absent is worse than being last.
   */
  readonly discriminated: boolean
  /** `1 / discriminationRank`. The term of {@link DiscriminationReport.mrr}. */
  readonly reciprocalRank: number
  /** `1 / targetRank`, or `0` when the target was absent. The term of `corpusMrr`. */
  readonly corpusReciprocalRank: number
  /** True when the vector arm did not fire for this probe. */
  readonly degraded: boolean
}

/** The whole run's outcome. This is the `eval.discrimination` envelope payload. */
export interface DiscriminationReport {
  readonly mode: EvalMode
  readonly probes: number
  /** Probes whose target strictly outranked all of its controls. */
  readonly discriminated: number
  /** Probes with at least one inversion. The gate fails when this is non-zero. */
  readonly inversions: ReadonlyArray<ProbeResult>
  /**
   * Mean reciprocal rank over `{target} ∪ controls`, unitless in `[0, 1]`, four decimals.
   *
   * **This is the gated number, and its coordinate space is the discrimination set — not the corpus.**
   * Design §5 states the floor in the same clause as `rank(target) < min(rank(control))`, so the space
   * the sentence is about is the target against its own impostors: `1.0` means every target beat every
   * control outright. See {@link corpusMrr} for the other reading, which is reported and not gated.
   */
  readonly mrr: number
  /**
   * Mean reciprocal rank over the WHOLE hit list, unitless in `[0, 1]`, four decimals.
   *
   * Reported rather than gated, because it is dominated by corpus size rather than by ranking quality:
   * `DEFAULT_ARM_LIMIT` is 40, which is 13% of a 300-file fixture and under 1% of a real corpus, so the
   * two query-blind arms cover a far larger share of a fixture than of production. Measured on this
   * generator at one seed: 0.21 at 304 files, 0.49 at 711, 0.58 at 1323 — with the inversion count
   * unchanged at every scale. A gate on this number would be a gate on how big the fixture is.
   */
  readonly corpusMrr: number
  /** The floor {@link mrr} was measured against. */
  readonly mrrFloor: number
  /** True when there are zero inversions AND `mrr >= mrrFloor`. */
  readonly passed: boolean
  /** Probes ranked by a degraded (vector-arm-free) search. */
  readonly degradedProbes: number
  readonly results: ReadonlyArray<ProbeResult>
}

/**
 * The MRR floor, from design §5. A gate below this admits a target that loses to one of its own
 * negation-flipped twins on one probe in seven, which is not a retrieval layer an agent can trust to
 * answer with the right fact.
 */
export const MRR_FLOOR = 0.85

/**
 * How many hits each probe requests.
 *
 * Wide enough that a control's rank is observable rather than truncated into `null`: a window of 10
 * would report an inversion and a merely-narrow miss identically, and the two need different fixes.
 * The gate itself compares ranks, so widening the window can only make it stricter.
 */
export const PROBE_LIMIT = 40

/** 1-based rank of a path in a hit list, or `null` when it is absent. */
const rankOf = (paths: ReadonlyArray<string>, path: string): number | null => {
  const at = paths.indexOf(path)
  return at === -1 ? null : at + 1
}

/**
 * True when `target` strictly outranks `control`.
 *
 * An absent control (rank `null`) is outranked by any returned target, and an absent TARGET is
 * outranked by everything — including an absent control, since a probe whose target the search never
 * returned has failed regardless of what happened to the impostors.
 */
const outranks = (target: number | null, control: number | null): boolean => {
  if (target === null) return false
  if (control === null) return true
  return target < control
}

/** Round to four decimals, so a report's numbers are comparable across runs without float noise. */
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

/**
 * Run every probe through the real retrieval service.
 *
 * `includeArchived` stays false: the corpus carries an archived tier and an archived memory must not
 * be a candidate, so a probe that ranked one would be reporting a scope leak rather than a ranking
 * failure. The controls are ACTIVE files, which is what makes them adversaries.
 */
export const runProbes = (
  retrieval: RetrievalShape,
  probes: ReadonlyArray<Probe>,
  options: { readonly limit?: number | undefined } = {}
): Effect.Effect<ReadonlyArray<ProbeResult>, StorageFailure> =>
  Effect.gen(function* () {
    const limit = options.limit ?? PROBE_LIMIT
    const results: Array<ProbeResult> = []

    for (const probe of probes) {
      const found = yield* retrieval.search({ query: probe.query, limit, includeArchived: false })
      const paths = found.hits.map((hit) => hit.path)
      const targetRank = rankOf(paths, probe.targetPath)

      const controlRanks = probe.controlPaths.map((path, offset) => ({
        path,
        family: probe.families[offset] as DivergenceFamily,
        rank: rankOf(paths, path)
      }))

      /**
       * The target's position among its own impostors: one plus however many controls beat it.
       *
       * Counted rather than read off a re-sort, because `null` is not a rank and the two absences mean
       * different things — an absent control did NOT beat the target, and an absent target was beaten by
       * every control the search did return. {@link outranks} already encodes both, so the count is the
       * number of controls it says the target failed to outrank.
       */
      const discriminationRank =
        1 + controlRanks.filter((control) => !outranks(targetRank, control.rank)).length

      results.push({
        query: probe.query,
        targetPath: probe.targetPath,
        targetRank,
        discriminationRank,
        controlRanks,
        discriminated: discriminationRank === 1,
        reciprocalRank: 1 / discriminationRank,
        corpusReciprocalRank: targetRank === null ? 0 : 1 / targetRank,
        degraded: found.degraded
      })
    }

    return results
  })

/**
 * Aggregate probe results into the report the gate reads.
 *
 * **An empty suite is a FAILURE, not a vacuous pass.** Zero probes yields `mrr: 0`, which is below any
 * floor — so a corpus whose probe generation silently produced nothing refuses rather than reporting a
 * green gate over no measurement. A skipped quality gate must never look like a passing one, and "no
 * probes ran" is the purest form of skipped.
 */
export const summarize = (
  mode: EvalMode,
  results: ReadonlyArray<ProbeResult>,
  mrrFloor: number = MRR_FLOOR
): DiscriminationReport => {
  const inversions = results.filter((result) => !result.discriminated)
  const mean = (term: (result: ProbeResult) => number): number =>
    results.length === 0
      ? 0
      : round4(results.reduce((total, result) => total + term(result), 0) / results.length)
  const mrr = mean((result) => result.reciprocalRank)
  return {
    mode,
    probes: results.length,
    discriminated: results.length - inversions.length,
    inversions,
    mrr,
    corpusMrr: mean((result) => result.corpusReciprocalRank),
    mrrFloor,
    passed: results.length > 0 && inversions.length === 0 && mrr >= mrrFloor,
    degradedProbes: results.filter((result) => result.degraded).length,
    results
  }
}

/** Run the suite and summarize it in one call. */
export const discriminate = (
  retrieval: RetrievalShape,
  probes: ReadonlyArray<Probe>,
  options: {
    readonly mode: EvalMode
    readonly mrrFloor?: number | undefined
    readonly limit?: number | undefined
  }
): Effect.Effect<DiscriminationReport, StorageFailure> =>
  runProbes(retrieval, probes, options).pipe(
    Effect.map((results) => summarize(options.mode, results, options.mrrFloor))
  )

/**
 * The lexical-floor scenario: the same suite with no vector arm.
 *
 * Design §5 requires two things of it — no error, and the lexical arm still beating the controls on
 * the probes that carry lexical signal. Only the SECOND half is a subset claim, and it has to be: a
 * numeric-family control differs from its target by one token, which the FTS arm cannot order, so
 * demanding the full gate without vectors would be demanding the vector arm be unnecessary.
 *
 * `lexicallyDiscriminated` is therefore the number reported and asserted, not `passed`.
 */
export interface FloorReport {
  readonly probes: number
  /** Probes the lexical floor still discriminated. */
  readonly lexicallyDiscriminated: number
  /** Every result, so a caller can see which families survive without vectors. */
  readonly results: ReadonlyArray<ProbeResult>
  /** True when every probe was ranked degraded — the assertion that the arm really is absent. */
  readonly allDegraded: boolean
}

export const runFloor = (
  retrieval: RetrievalShape,
  probes: ReadonlyArray<Probe>,
  options: { readonly limit?: number | undefined } = {}
): Effect.Effect<FloorReport, StorageFailure> =>
  runProbes(retrieval, probes, options).pipe(
    Effect.map((results) => ({
      probes: results.length,
      lexicallyDiscriminated: results.filter((result) => result.discriminated).length,
      results,
      allDegraded: results.length > 0 && results.every((result) => result.degraded)
    }))
  )

/**
 * A one-line summary of a failure, for stderr and for the sleep merge's refusal log.
 *
 * Names the first inversion rather than every one: an operator needs a probe to reproduce, and a
 * thirty-line dump of a failing gate is a thirty-line dump nobody reads. The full list is on the
 * report.
 */
export const describeFailure = (report: DiscriminationReport): string => {
  if (report.passed) return "discrimination passed"
  const first = report.inversions[0]
  const invertedBy =
    first === undefined
      ? ""
      : ` first inversion: "${first.query}" ranked ${first.targetPath} at ${
          first.targetRank ?? "absent"
        }, control ${
          first.controlRanks.find((control) => !outranks(first.targetRank, control.rank))?.path ??
          "?"
        } at or above it.`
  return (
    `discrimination FAILED in ${report.mode} mode: ${report.inversions.length} inversion(s) of ` +
    `${report.probes} probes, MRR ${report.mrr} against a floor of ${report.mrrFloor}.${invertedBy}`
  )
}

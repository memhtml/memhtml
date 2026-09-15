import { type MergeOutcome, type MergePair, mergeOutcomes, mergeVetoReasons } from "@memhtml/domain"
import { DEDUP_ADMIT_FLOOR, dedupMergeTextFor, groupPairsFor } from "@memhtml/sleep"

import {
  ACCEPTANCE_CORPUS,
  type AcceptanceLabel,
  type LabeledGroup
} from "./write-path-acceptance-corpus.js"

/**
 * The write-path acceptance arm: does `dedup-merge` FOLD the pairs it should, and only those?
 *
 * Composed from the production functions in the order the phase runs them once the model has
 * answered. Nothing here is re-implemented:
 *
 * 1. `dedupMergeTextFor` — the phase's own `{ gist, body }` for a member, the two texts the divergence
 *    veto reads (numeric over the gist, negation and variant over the join).
 * 2. `groupPairsFor` — the phase's own fan-out of a model group into oriented pairs: the oldest member
 *    keeps, every other member drops, similarity is the recall floor for a pair the corpus never mined.
 * 3. `mergeOutcomes` under `DEDUP_ADMIT_FLOOR` — the domain filter exactly as the model arm calls it:
 *    the veto, the self check, the in-batch role guard, and the per-run cap, with the similarity
 *    comparison disarmed because admission was the model's.
 *
 * **The positive class is a FOLD.** The discrimination arm scores refusal, because a gate exists to
 * refuse; this arm scores acceptance, because a fold path exists to fold, and the two nights that
 * motivated it (`vetoed: 171/171`, `vetoed: 178/178`, `merged: 0`) were nights the refusal arm would
 * have scored perfectly. So: `acceptance` is folds over the pairs the corpus says should fold;
 * `precision` is the share of folds that should have happened; `recall` equals acceptance. A fold of a
 * `keep` pair is a SAFETY failure and fails the tier outright whatever the rate, because it is the
 * blind-merge-of-a-correction the veto exists to prevent.
 *
 * Each pair's outcome names WHERE it stopped, in the filter's own order, read off the filter's own
 * `MergeOutcome` rather than re-derived. The veto stages name the predicate through `mergeVetoReasons`,
 * the way the phase's `vetoedPairs` does for its review tasks; `role-guard` is what the phase counts
 * under `roleGuarded`.
 */

/** Where a pair's fate was decided. `folded` is the outcome the corpus's `merge` label asks for. */
export type AcceptanceStage =
  | "threshold"
  | "veto:negation"
  | "veto:numeric"
  | "veto:variant"
  | "self"
  | "role-guard"
  | "cap"
  | "folded"

/** One oriented pair's decision beside its group's label. */
export interface PairDecision {
  /** `<group id>/<drop basename>`, stable across runs. */
  readonly id: string
  readonly group: string
  readonly label: AcceptanceLabel
  readonly class: string
  readonly keepPath: string
  readonly dropPath: string
  readonly folded: boolean
  readonly stage: AcceptanceStage
}

/** One class's agreement with its labels. */
export interface AcceptanceClassBreakdown {
  readonly class: string
  readonly label: AcceptanceLabel
  readonly pairs: number
  /** Decisions that matched the label: folded for `merge`, refused for `keep`. */
  readonly agreed: number
  readonly disagreed: ReadonlyArray<string>
}

/** The report the gate reads. */
export interface AcceptanceReport {
  readonly groups: number
  readonly pairs: number
  /** Pairs from `merge` groups: the ones that should fold. */
  readonly eligible: number
  /** Folds among the eligible. */
  readonly accepted: number
  /** Pairs from `keep` groups. */
  readonly guarded: number
  /** Folds among the guarded. Any value above zero fails the tier. */
  readonly foldedKeep: number
  /** `accepted / eligible`, four decimals; `0` when nothing was eligible. */
  readonly acceptance: number
  /** `accepted / (accepted + foldedKeep)`, four decimals; `0` when nothing folded. */
  readonly precision: number
  /** Same as `acceptance`, stated under the name the discrimination arm uses. */
  readonly recall: number
  readonly f1: number
  readonly acceptanceFloor: number
  /**
   * True when both labels are present AND no `keep` pair folded AND `acceptance >= acceptanceFloor`.
   * One label alone is a failure, not a vacuous pass, for the reason the discrimination arm gives.
   */
  readonly passed: boolean
  readonly perClass: ReadonlyArray<AcceptanceClassBreakdown>
  readonly decisions: ReadonlyArray<PairDecision>
}

/**
 * The measured baseline this floor was derived from, so the derivation is checkable.
 *
 * Measured 2026-09-11 at memhtml 0.14.0 on corpus v2 (12 merge groups implying 14 pairs, 7 keep groups
 * implying 7 pairs): acceptance 1.0 (14 of 14), precision 1.0 (no keep pair folded). Corpus v1 under
 * the rules before this one measured 0.6667 (8 of 12): three `incidental-number` pairs stopped at
 * `veto:numeric` because the numeric predicate read the whole article, and one `group-fanout` pair
 * stopped at `role-guard` because the guard claimed the keeper after the first fold. Both classes now
 * fold, and the known-gap set is empty.
 */
export const ACCEPTANCE_BASELINE = 1

/**
 * Acceptance floor: the baseline minus five points, floored to two decimals — the discrimination arm's
 * derivation, for the same reason. The floor is the alarm for a class-sized regression (a predicate
 * that starts firing on a class it did not), and the known-gap set is the alarm for a one-pair one.
 * A floor at the baseline would fire on every deliberate corpus edit.
 */
export const ACCEPTANCE_FLOOR = Math.floor((ACCEPTANCE_BASELINE - 0.05) * 100) / 100

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000
const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : round4(numerator / denominator)

const basenameOf = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.html$/, "")

/**
 * The oriented pairs the corpus implies, in group order, exactly as the phase would hand them to
 * `mergeCandidates`: `groupPairsFor` over each group, with corpus order as the age order and
 * `dedupMergeTextFor` as the veto's texts. `simFor` is empty because no pair here was mined, so every
 * similarity is the recall floor — the phase's own value for a group pair it never scored.
 *
 * A path named by two groups takes its age from its FIRST appearance, the way one corpus row has one
 * offset however many groups a model puts it in. The labeled corpus never repeats a path; the
 * role-guard cases the tests build do, and a last-wins map would re-age a keeper under them.
 */
export const impliedPairs = (
  corpus: ReadonlyArray<LabeledGroup> = ACCEPTANCE_CORPUS
): ReadonlyArray<{ readonly group: LabeledGroup; readonly pair: MergePair }> => {
  const flat = corpus.flatMap((group) => group.members)
  const order = new Map<string, number>()
  for (const [offset, one] of flat.entries()) {
    if (!order.has(one.path)) order.set(one.path, offset)
  }
  const textOf = new Map(
    flat.map(
      (one) => [one.path, dedupMergeTextFor({ gist: one.gist, body_text: one.body })] as const
    )
  )
  const simFor = new Map<string, number>()
  return corpus.flatMap((group) =>
    groupPairsFor(group.members, { order, textOf, simFor }).map((pair) => ({ group, pair }))
  )
}

/**
 * The filter's own stage, with a veto refined to the FIRST predicate that fired, in the veto's
 * disjunction order — the same reading the phase's review tasks give.
 */
const stageOf = ({ pair, stage }: MergeOutcome): AcceptanceStage => {
  if (stage !== "vetoed") return stage === "committed" ? "folded" : stage
  const keep = pair.keepText
  const drop = pair.dropText
  const first =
    keep === undefined || drop === undefined ? undefined : mergeVetoReasons(keep, drop)[0]
  return first === undefined ? "role-guard" : `veto:${first}`
}

/** Run the corpus through the composed fold path. Pure. */
export const decideAcceptance = (
  corpus: ReadonlyArray<LabeledGroup> = ACCEPTANCE_CORPUS
): ReadonlyArray<PairDecision> => {
  const implied = impliedPairs(corpus)
  const outcomes = mergeOutcomes(
    implied.map((one) => one.pair),
    { threshold: DEDUP_ADMIT_FLOOR }
  )
  return implied.map(({ group, pair }, offset) => {
    const outcome = outcomes[offset]
    const stage = outcome === undefined ? "role-guard" : stageOf(outcome)
    const folded = stage === "folded"
    return {
      id: `${group.id}/${basenameOf(pair.dropPath)}`,
      group: group.id,
      label: group.label,
      class: group.class,
      keepPath: pair.keepPath,
      dropPath: pair.dropPath,
      folded,
      stage
    }
  })
}

/** True when the decision matches the label. */
export const acceptanceAgrees = (decision: PairDecision): boolean =>
  decision.label === "merge" ? decision.folded : !decision.folded

/** Group by class, in first-seen order. */
export const acceptanceByClass = (
  decisions: ReadonlyArray<PairDecision>
): ReadonlyArray<AcceptanceClassBreakdown> => {
  const byClass = new Map<string, { label: AcceptanceLabel; pairs: number; disagreed: string[] }>()
  for (const decision of decisions) {
    const held = byClass.get(decision.class) ?? { label: decision.label, pairs: 0, disagreed: [] }
    held.pairs += 1
    if (!acceptanceAgrees(decision)) held.disagreed.push(decision.id)
    byClass.set(decision.class, held)
  }
  return [...byClass].map(([cls, held]) => ({
    class: cls,
    label: held.label,
    pairs: held.pairs,
    agreed: held.pairs - held.disagreed.length,
    disagreed: held.disagreed
  }))
}

/** Aggregate the decisions into the report the gate reads. */
export const summarizeAcceptance = (
  decisions: ReadonlyArray<PairDecision>,
  acceptanceFloor: number,
  groups: number
): AcceptanceReport => {
  const eligible = decisions.filter((one) => one.label === "merge")
  const guarded = decisions.filter((one) => one.label === "keep")
  const accepted = eligible.filter((one) => one.folded).length
  const foldedKeep = guarded.filter((one) => one.folded).length
  const acceptance = ratio(accepted, eligible.length)
  const precision = ratio(accepted, accepted + foldedKeep)
  const recall = acceptance
  const f1 = precision + recall === 0 ? 0 : round4((2 * precision * recall) / (precision + recall))
  return {
    groups,
    pairs: decisions.length,
    eligible: eligible.length,
    accepted,
    guarded: guarded.length,
    foldedKeep,
    acceptance,
    precision,
    recall,
    f1,
    acceptanceFloor,
    passed:
      eligible.length > 0 &&
      guarded.length > 0 &&
      foldedKeep === 0 &&
      acceptance >= acceptanceFloor,
    perClass: acceptanceByClass(decisions),
    decisions
  }
}

/** What {@link runWritePathAcceptance} takes. */
export interface AcceptanceOptions {
  readonly acceptanceFloor?: number | undefined
  readonly corpus?: ReadonlyArray<LabeledGroup> | undefined
}

/** Run the arm end to end. Pure and total: the report is the answer. */
export const runWritePathAcceptance = (options: AcceptanceOptions = {}): AcceptanceReport => {
  const corpus = options.corpus ?? ACCEPTANCE_CORPUS
  return summarizeAcceptance(
    decideAcceptance(corpus),
    options.acceptanceFloor ?? ACCEPTANCE_FLOOR,
    corpus.length
  )
}

/** A one-line summary: the numbers, then the first disagreement. */
export const describeAcceptance = (report: AcceptanceReport): string => {
  const head =
    `write-path acceptance: ${String(report.groups)} groups, ${String(report.pairs)} pairs ` +
    `(${String(report.eligible)} should fold, ${String(report.guarded)} must not), ` +
    `accepted ${String(report.accepted)} of ${String(report.eligible)} (${String(report.acceptance)}), ` +
    `precision ${String(report.precision)}, recall ${String(report.recall)}, ` +
    `keep pairs folded ${String(report.foldedKeep)}, floor ${String(report.acceptanceFloor)}`
  const first = report.decisions.find((decision) => !acceptanceAgrees(decision))
  const tail =
    first === undefined
      ? "; every decision matched its label."
      : `; first disagreement ${first.id} (${first.class}, labeled ${first.label}) ` +
        `${first.folded ? "folded" : `stopped at ${first.stage}`}.`
  return `${head}${report.passed ? " — passed" : " — FAILED"}${tail}`
}

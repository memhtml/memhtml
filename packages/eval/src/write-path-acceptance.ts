import {
  MAX_MERGE_PAIRS,
  type MergePair,
  mergeCandidates,
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "@memhtml/domain"
import { DEDUP_ADMIT_FLOOR, dedupTextFor, groupPairsFor } from "@memhtml/sleep"

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
 * 1. `dedupTextFor` — the phase's own text join (`${gist}\n${body_text}`), which is the string the
 *    divergence veto reads.
 * 2. `groupPairsFor` — the phase's own fan-out of a model group into oriented pairs: the oldest member
 *    keeps, every other member drops, similarity is the recall floor for a pair the corpus never mined.
 * 3. `mergeCandidates` under `DEDUP_ADMIT_FLOOR` — the domain filter exactly as the model arm calls it:
 *    the veto, the self check, the in-batch role guard, and the per-night cap, with the similarity
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
 * Each pair's outcome names WHERE it stopped, in the filter's own order. The veto stages name the
 * predicate by re-running the three exported predicates, the way the phase's `vetoedPairs` does for its
 * review tasks; `role-guard` is what the phase counts under `vetoed` although no predicate fired.
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
 * Measured 2026-09-11 at memhtml 0.14.0 on corpus v1 (11 merge groups implying 12 pairs, 5 keep
 * groups implying 5 pairs): acceptance 0.6667 (8 of 12), precision 1.0 (no keep pair folded). The four
 * eligible pairs that did not fold are the two known-gap classes: three `incidental-number` pairs
 * stopped at `veto:numeric`, one `group-fanout` pair stopped at `role-guard`.
 */
export const ACCEPTANCE_BASELINE = 0.6667

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
 * `dedupTextFor` as the offered text. `simFor` is empty because no pair here was mined, so every
 * similarity is the recall floor — the phase's own value for a group pair it never scored.
 */
export const impliedPairs = (
  corpus: ReadonlyArray<LabeledGroup> = ACCEPTANCE_CORPUS
): ReadonlyArray<{ readonly group: LabeledGroup; readonly pair: MergePair }> => {
  const flat = corpus.flatMap((group) => group.members)
  const order = new Map(flat.map((one, offset) => [one.path, offset] as const))
  const textOf = new Map(
    flat.map((one) => [one.path, dedupTextFor({ gist: one.gist, body_text: one.body })] as const)
  )
  const simFor = new Map<string, number>()
  return corpus.flatMap((group) =>
    groupPairsFor(group.members, { order, textOf, simFor }).map((pair) => ({ group, pair }))
  )
}

/** Which stage stopped a pair the filter did not commit, in the filter's own order. */
const stoppedAt = (
  pair: MergePair,
  offset: number,
  committedBefore: number,
  threshold: number
): AcceptanceStage => {
  if (committedBefore >= MAX_MERGE_PAIRS) return "cap"
  if (pair.similarity <= threshold) return "threshold"
  const keep = pair.keepText ?? ""
  const drop = pair.dropText ?? ""
  if (pair.keepText !== undefined && pair.dropText !== undefined) {
    if (negationDivergent(keep, drop)) return "veto:negation"
    if (numericTokenDivergent(keep, drop)) return "veto:numeric"
    if (variantQualifierDivergent(keep, drop)) return "veto:variant"
  }
  if (pair.keepPath === pair.dropPath) return "self"
  // The only remaining reason the filter skips a pair at `offset` is a path already claimed.
  void offset
  return "role-guard"
}

/** Run the corpus through the composed fold path. Pure. */
export const decideAcceptance = (
  corpus: ReadonlyArray<LabeledGroup> = ACCEPTANCE_CORPUS
): ReadonlyArray<PairDecision> => {
  const implied = impliedPairs(corpus)
  const decisions = mergeCandidates(
    implied.map((one) => one.pair),
    { threshold: DEDUP_ADMIT_FLOOR }
  )
  const committed = new Set(decisions.map((one) => `${one.keepPath} ${one.dropPath}`))
  let committedBefore = 0
  return implied.map(({ group, pair }, offset) => {
    const folded = committed.has(`${pair.keepPath} ${pair.dropPath}`)
    const stage = folded ? "folded" : stoppedAt(pair, offset, committedBefore, DEDUP_ADMIT_FLOOR)
    if (folded) committedBefore += 1
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

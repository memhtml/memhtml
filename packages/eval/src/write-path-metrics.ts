import type { WritePathLabel } from "./write-path-corpus.js"
import type { GateStage } from "./write-path-gate.js"

/**
 * Discrimination metrics for the write-path gate: does it tell good candidates from bad?
 *
 * **The positive class is `bad`, and a positive prediction is a refusal.** A gate exists to refuse, so
 * precision answers "of what it refused, how much deserved it" and recall answers "of what deserved
 * refusing, how much did it catch". Stated once here because the same four cells read the other way
 * round give a different precision, and a report that did not say which is the one it means is a
 * report two readers disagree about.
 *
 * Two numbers are gated and both are reported: F1 against a floor, and the per-item decisions against
 * a frozen manifest (`write-path-run.ts`). An aggregate alone can be bought: one class of thirty
 * easy refusals covers one class the gate never sees, which is why the report also breaks the
 * decisions down by class and names the items that disagreed with their label.
 */

/** One candidate's decision beside its label. */
export interface LabeledDecision {
  readonly id: string
  readonly label: WritePathLabel
  readonly class: string
  readonly accepted: boolean
  readonly stage: GateStage
  readonly reason: string | null
}

/**
 * The four cells, named by what happened rather than by TP/FP letters a reader has to re-derive.
 *
 * `badRejected` is the true positive, `goodRejected` the false positive, `badAccepted` the false
 * negative, `goodAccepted` the true negative.
 */
export interface ConfusionMatrix {
  readonly badRejected: number
  readonly goodRejected: number
  readonly badAccepted: number
  readonly goodAccepted: number
}

/** One class's agreement with its labels. */
export interface ClassBreakdown {
  readonly class: string
  readonly label: WritePathLabel
  readonly items: number
  /** Decisions that matched the label: rejected for `bad`, accepted for `good`. */
  readonly agreed: number
  /** Ids of the items whose decision contradicted the label. */
  readonly disagreed: ReadonlyArray<string>
}

/** The report the gate reads. This is the `eval.write-path` payload shape. */
export interface WritePathReport {
  readonly items: number
  readonly good: number
  readonly bad: number
  readonly confusion: ConfusionMatrix
  /** `badRejected / (badRejected + goodRejected)`, four decimals; `0` when nothing was rejected. */
  readonly precision: number
  /** `badRejected / (badRejected + badAccepted)`, four decimals; `0` when nothing was bad. */
  readonly recall: number
  /** Harmonic mean of the two, four decimals; `0` when either is `0`. */
  readonly f1: number
  /** `(badRejected + goodAccepted) / items`, four decimals. */
  readonly accuracy: number
  readonly f1Floor: number
  /**
   * True when the corpus is non-empty AND carries both labels AND `f1 >= f1Floor`.
   *
   * An empty corpus, or one with a single label, is a FAILURE rather than a vacuous pass: a mean
   * over nothing is not a measurement, and a gate scored only on good items (or only on bad) cannot
   * have discriminated anything.
   */
  readonly passed: boolean
  readonly perClass: ReadonlyArray<ClassBreakdown>
  readonly decisions: ReadonlyArray<LabeledDecision>
}

/** Round to four decimals, so a report's numbers compare across runs without float noise. */
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : round4(numerator / denominator)

/** The four cells from the decisions. */
export const confusionOf = (decisions: ReadonlyArray<LabeledDecision>): ConfusionMatrix => {
  let badRejected = 0
  let goodRejected = 0
  let badAccepted = 0
  let goodAccepted = 0
  for (const decision of decisions) {
    if (decision.label === "bad") {
      if (decision.accepted) badAccepted += 1
      else badRejected += 1
    } else if (decision.accepted) goodAccepted += 1
    else goodRejected += 1
  }
  return { badRejected, goodRejected, badAccepted, goodAccepted }
}

/** True when the decision matches the label. */
export const agrees = (decision: LabeledDecision): boolean =>
  decision.label === "bad" ? !decision.accepted : decision.accepted

/** Group by class, in first-seen order, so the breakdown reads in corpus order. */
export const breakdownByClass = (
  decisions: ReadonlyArray<LabeledDecision>
): ReadonlyArray<ClassBreakdown> => {
  const byClass = new Map<string, { label: WritePathLabel; items: number; disagreed: string[] }>()
  for (const decision of decisions) {
    const held = byClass.get(decision.class) ?? { label: decision.label, items: 0, disagreed: [] }
    held.items += 1
    if (!agrees(decision)) held.disagreed.push(decision.id)
    byClass.set(decision.class, held)
  }
  return [...byClass].map(([cls, held]) => ({
    class: cls,
    label: held.label,
    items: held.items,
    agreed: held.items - held.disagreed.length,
    disagreed: held.disagreed
  }))
}

/** Aggregate the decisions into the report the gate reads. */
export const summarizeWritePath = (
  decisions: ReadonlyArray<LabeledDecision>,
  f1Floor: number
): WritePathReport => {
  const confusion = confusionOf(decisions)
  const good = confusion.goodAccepted + confusion.goodRejected
  const bad = confusion.badRejected + confusion.badAccepted
  const precision = ratio(confusion.badRejected, confusion.badRejected + confusion.goodRejected)
  const recall = ratio(confusion.badRejected, bad)
  const f1 = precision + recall === 0 ? 0 : round4((2 * precision * recall) / (precision + recall))
  return {
    items: decisions.length,
    good,
    bad,
    confusion,
    precision,
    recall,
    f1,
    accuracy: ratio(confusion.badRejected + confusion.goodAccepted, decisions.length),
    f1Floor,
    passed: decisions.length > 0 && good > 0 && bad > 0 && f1 >= f1Floor,
    perClass: breakdownByClass(decisions),
    decisions
  }
}

/**
 * A one-line summary for stderr and a report subject: the four numbers, then the first disagreement.
 */
export const describeWritePath = (report: WritePathReport): string => {
  const head =
    `write-path discrimination: ${String(report.items)} items (${String(report.good)} good, ` +
    `${String(report.bad)} bad), precision ${String(report.precision)}, recall ${String(report.recall)}, ` +
    `F1 ${String(report.f1)} against a floor of ${String(report.f1Floor)}`
  const first = report.decisions.find((decision) => !agrees(decision))
  const tail =
    first === undefined
      ? "; every decision matched its label."
      : `; first disagreement ${first.id} (${first.class}, labeled ${first.label}) was ` +
        `${first.accepted ? "accepted" : `refused at ${first.stage}`}.`
  return `${head}${report.passed ? " — passed" : " — FAILED"}${tail}`
}

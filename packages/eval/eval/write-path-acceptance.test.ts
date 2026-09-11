import { describe, expect, it } from "vitest"
import {
  ACCEPTANCE_BASELINE,
  ACCEPTANCE_FLOOR,
  acceptanceAgrees,
  runWritePathAcceptance,
  summarizeAcceptance
} from "../src/write-path-acceptance.js"
import {
  ACCEPTANCE_CORPUS,
  ACCEPTANCE_KNOWN_GAP_CLASSES
} from "../src/write-path-acceptance-corpus.js"

/**
 * The write-path acceptance arm, end to end, against the production fold path.
 *
 * Nothing here fakes the phase: the text the veto reads is `dedupTextFor`, the pairs are
 * `groupPairsFor`'s, and the filter is `mergeCandidates` under `DEDUP_ADMIT_FLOOR`. The only thing
 * substituted is the model's ANSWER, which the labeled group stands in for.
 *
 * Three gates, coarse to fine: no `keep` pair folds (safety, absolute); acceptance at or above the
 * floor; the known-gap set exactly as stated, in both directions.
 */

const run = () => runWritePathAcceptance()

describe("the fold path on the labeled groups", () => {
  it("never folds a pair the corpus says to keep", () => {
    const report = run()
    expect(report.foldedKeep).toBe(0)
    expect(report.precision).toBe(1)
  })

  it("clears the acceptance floor, which is the measured baseline minus five points", () => {
    const report = run()
    expect(report.groups).toBe(ACCEPTANCE_CORPUS.length)
    expect(report.eligible).toBeGreaterThan(0)
    expect(report.guarded).toBeGreaterThan(0)
    expect(report.acceptanceFloor).toBe(ACCEPTANCE_FLOOR)
    expect(report.acceptanceFloor).toBe(Math.floor((ACCEPTANCE_BASELINE - 0.05) * 100) / 100)
    expect(report.acceptance).toBe(ACCEPTANCE_BASELINE)
    expect(report.acceptance).toBeGreaterThanOrEqual(report.acceptanceFloor)
    expect(report.passed).toBe(true)
  })

  it("reaches the fold and every veto predicate at least once, so no stage is measured vacuously", () => {
    const report = run()
    const stages = new Set(report.decisions.map((decision) => decision.stage))
    expect([...stages].sort()).toEqual(
      ["folded", "role-guard", "veto:negation", "veto:numeric", "veto:variant"].sort()
    )
  })

  it("disagrees with a label ONLY in the classes stated as known gaps", () => {
    /**
     * Both directions. A disagreement outside the set is a regression (a predicate firing on a class
     * it did not, or a `keep` pair folding). A gap class with NO disagreement means the fold path now
     * covers it — update `ACCEPTANCE_KNOWN_GAP_CLASSES`, re-measure `ACCEPTANCE_BASELINE`, and say so.
     */
    const report = run()
    const disagreeing = report.perClass.filter((entry) => entry.disagreed.length > 0)
    expect(disagreeing.map((entry) => entry.class).sort()).toEqual(
      [...ACCEPTANCE_KNOWN_GAP_CLASSES].sort()
    )
    for (const entry of disagreeing) {
      if (entry.class === "group-fanout") {
        // The defect's shape IS half-caught: the first pair folds and claims the keeper, the second
        // is skipped by the role guard. Exactly one of each, or the mechanism has changed.
        expect(entry.pairs).toBe(2)
        expect(entry.agreed).toBe(1)
        continue
      }
      // Every pair of the other gap classes is uncovered, not some: a half-caught class would mean
      // the fold path discriminates on something other than the class definition.
      expect(entry.agreed).toBe(0)
    }
  })

  it("names the disagreements and where each one stopped", () => {
    /**
     * The root cause of the 2026-09-10 and 2026-09-11 all-veto nights, pinned: the same claim with an
     * incidental number on one side stops at `veto:numeric`, and the third member of a group stops at
     * `role-guard` because the keeper was claimed by the first fold.
     */
    const report = run()
    const disagreements = report.decisions.filter((decision) => !acceptanceAgrees(decision))
    expect(disagreements.map((d) => `${d.id} ${d.stage}`).sort()).toEqual(
      [
        "m03/sleep-writes-land-on-a-branch role-guard",
        "m06/drain-vip-rule veto:numeric",
        "m07/failed-run-restores-branch veto:numeric",
        "m08/disclose-tool-failures veto:numeric"
      ].sort()
    )
  })

  it("refuses the templated-series pair for differing numbers, as the store's review tasks record", () => {
    const report = run()
    const templated = report.decisions.filter((decision) => decision.class === "templated-series")
    expect(templated).toHaveLength(1)
    expect(templated[0]?.stage).toBe("veto:numeric")
  })

  it("is deterministic: two runs agree exactly", () => {
    const [first, second] = [run(), run()]
    expect(second.decisions).toEqual(first.decisions)
    expect(second.acceptance).toBe(first.acceptance)
  })
})

describe("the floor fires", () => {
  it("fails the same decisions against a floor above the measured acceptance", () => {
    const report = run()
    const strict = summarizeAcceptance(report.decisions, report.acceptance + 0.0001, report.groups)
    expect(strict.passed).toBe(false)
    expect(strict.acceptance).toBe(report.acceptance)
  })

  it("fails outright when a keep pair folds, whatever the rate", () => {
    const report = run()
    const flipped = report.decisions.map((decision) =>
      decision.label === "keep" && decision.id === "k01/blue-green-is-not-safe"
        ? { ...decision, folded: true, stage: "folded" as const }
        : decision
    )
    const unsafe = summarizeAcceptance(flipped, 0, report.groups)
    expect(unsafe.foldedKeep).toBe(1)
    expect(unsafe.passed).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import {
  ACCEPTANCE_BASELINE,
  ACCEPTANCE_FLOOR,
  acceptanceAgrees,
  decideAcceptance,
  runWritePathAcceptance,
  summarizeAcceptance
} from "../src/write-path-acceptance.js"
import {
  ACCEPTANCE_CORPUS,
  ACCEPTANCE_KNOWN_GAP_CLASSES,
  BODY_NUMBER_ONLY_GROUP,
  type LabeledGroup
} from "../src/write-path-acceptance-corpus.js"

/**
 * The write-path acceptance arm, end to end, against the production fold path.
 *
 * Nothing here fakes the phase: the texts the veto reads are `dedupMergeTextFor`'s, the pairs are
 * `groupPairsFor`'s, and the filter is `mergeOutcomes` under `DEDUP_ADMIT_FLOOR`. The only thing
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

  it("measures 14 of 14 eligible pairs folded and 7 of 7 guarded pairs refused", () => {
    /**
     * The numbers the baseline was re-stated from, pinned so a corpus edit that moves them has to say
     * so here. Corpus v1 under the previous rules measured 8 of 12.
     */
    const report = run()
    expect(report.eligible).toBe(14)
    expect(report.accepted).toBe(14)
    expect(report.guarded).toBe(7)
    expect(report.foldedKeep).toBe(0)
  })

  it("reaches the fold and every veto predicate at least once, so no stage is measured vacuously", () => {
    const report = run()
    const stages = new Set(report.decisions.map((decision) => decision.stage))
    expect([...stages].sort()).toEqual(
      ["folded", "veto:negation", "veto:numeric", "veto:variant"].sort()
    )
  })

  it("disagrees with a label ONLY in the classes stated as known gaps, which is none", () => {
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
    expect(ACCEPTANCE_KNOWN_GAP_CLASSES).toEqual([])
  })

  it("folds the classes the two all-veto runs could not: incidental numbers and whole groups", () => {
    /**
     * The root cause of the 2026-09-10 and 2026-09-11 all-veto runs, closed: the same claim with an
     * incidental number in one body folds because the numeric predicate reads the gist, and the third
     * member of a group folds because the guard admits a repeated keeper. Every pair of each class, or
     * the fold path discriminates on something other than the class definition.
     */
    const report = run()
    for (const cls of ["incidental-number", "group-fanout", "group-fanout-incidental"]) {
      const entry = report.perClass.find((one) => one.class === cls)
      expect(entry?.label).toBe("merge")
      expect(entry?.disagreed).toEqual([])
    }
    const fanout = report.decisions.filter((decision) => decision.group === "m03")
    expect(fanout.map((decision) => `${decision.dropPath} ${decision.stage}`)).toEqual([
      "areas/sleep/sleep-branch-then-merge.html folded",
      "areas/sleep/sleep-writes-land-on-a-branch.html folded"
    ])
    expect(new Set(fanout.map((decision) => decision.keepPath))).toEqual(
      new Set(["areas/sleep/sleep-runs-on-its-own-branch.html"])
    )
  })

  it("still refuses the counterexamples, each at the predicate its class names", () => {
    /**
     * The known counterexamples of the new rules. A numeric conflict IN the claim ("retry 3" against
     * "retry 13") is still a numeric veto; a negation stated only in the body and a variant qualifier
     * only one body carries are still vetoes, because those two predicates read the joined text; and
     * the templated series whose claims quote different objectives (a channel id, a creation date)
     * still stops at the numeric predicate over the gist.
     */
    const report = run()
    const stageOf = (id: string) => report.decisions.find((decision) => decision.id === id)?.stage
    expect(stageOf("k01/blue-green-is-not-safe")).toBe("veto:negation")
    expect(stageOf("k02/embed-retries-thirteen")).toBe("veto:numeric")
    expect(stageOf("k03/m1-pro-toolchain-image")).toBe("veto:variant")
    expect(stageOf("k04/verdict-suppressed-failure-b")).toBe("veto:numeric")
    expect(stageOf("k05/use-the-deprecated-sync-flag")).toBe("veto:variant")
    expect(stageOf("k06/cutover-draining-does-not-complete")).toBe("veto:negation")
    expect(stageOf("k07/laptops-need-arm-image-pro")).toBe("veto:variant")
  })

  it("is deterministic: two runs agree exactly", () => {
    const [first, second] = [run(), run()]
    expect(second.decisions).toEqual(first.decisions)
    expect(second.acceptance).toBe(first.acceptance)
  })
})

describe("what the gist rule trades away, measured rather than assumed", () => {
  it("FOLDS two number-free claims whose bodies cite different numbers, and says so", () => {
    /**
     * `BODY_NUMBER_ONLY_GROUP` is the shape the whole-article predicate used to refuse and the
     * gist-scoped one does not. It is outside the labeled corpus because whether it folds is the
     * model's call, not the veto's; this pins the arm's honest reading of it so the trade is visible.
     * A future rule that refuses it again (numbers adjacent to shared vocabulary, say) fails here and
     * has to re-state this.
     */
    const decisions = decideAcceptance([BODY_NUMBER_ONLY_GROUP])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.stage).toBe("folded")
    expect(acceptanceAgrees(decisions[0] as never)).toBe(false)
    const report = summarizeAcceptance(decisions, 0, 1)
    expect(report.foldedKeep).toBe(1)
    expect(report.passed).toBe(false)
  })
})

describe("the role guard through the composed path", () => {
  const one = (path: string, gist: string): LabeledGroup["members"][number] => ({
    path,
    gist,
    body: gist
  })
  const group = (id: string, members: LabeledGroup["members"]): LabeledGroup => ({
    id,
    label: "merge",
    class: "synthetic",
    provenance: "test",
    members
  })

  it("admits a repeated KEEPER across two groups: both drops fold into it", () => {
    const decisions = decideAcceptance([
      group("g1", [one("k.html", "the keeper"), one("a.html", "the keeper")]),
      group("g2", [one("k.html", "the keeper"), one("b.html", "the keeper")])
    ])
    expect(
      decisions.map((decision) => `${decision.keepPath} ${decision.dropPath} ${decision.stage}`)
    ).toEqual(["k.html a.html folded", "k.html b.html folded"])
  })

  it("refuses to fold INTO a path this batch archives, and reports it as the guard, not a veto", () => {
    /**
     * `(b → gf)` then `(gf → a)`: `gf` is dropped by the first group, so the second group's keeper is
     * a file the same batch destroys. The stage is `role-guard`, which the phase counts under
     * `roleGuarded` and never under `vetoed`.
     */
    const decisions = decideAcceptance([
      group("g1", [one("b.html", "the fact"), one("gf.html", "the fact")]),
      group("g2", [one("gf.html", "the fact"), one("a.html", "the fact")])
    ])
    expect(
      decisions.map((decision) => `${decision.keepPath} ${decision.dropPath} ${decision.stage}`)
    ).toEqual(["b.html gf.html folded", "gf.html a.html role-guard"])
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

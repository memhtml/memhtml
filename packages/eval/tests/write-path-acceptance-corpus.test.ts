import { describe, expect, it } from "vitest"
import {
  acceptanceByClass,
  describeAcceptance,
  type PairDecision,
  summarizeAcceptance
} from "../src/write-path-acceptance.js"
import {
  ACCEPTANCE_CORPUS,
  ACCEPTANCE_KNOWN_GAP_CLASSES
} from "../src/write-path-acceptance-corpus.js"

/**
 * The fast tier: the acceptance corpus's own invariants and the metrics arithmetic, with no fold run.
 */

describe("the labeled groups", () => {
  it("carry unique ids, both labels, and two or more members each", () => {
    const ids = ACCEPTANCE_CORPUS.map((group) => group.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ACCEPTANCE_CORPUS.some((group) => group.label === "merge")).toBe(true)
    expect(ACCEPTANCE_CORPUS.some((group) => group.label === "keep")).toBe(true)
    for (const group of ACCEPTANCE_CORPUS) {
      expect(group.members.length).toBeGreaterThanOrEqual(2)
      expect(group.provenance.length).toBeGreaterThan(0)
    }
  })

  it("never reuses a path, so corpus order is a total age order", () => {
    const paths = ACCEPTANCE_CORPUS.flatMap((group) => group.members.map((one) => one.path))
    expect(new Set(paths).size).toBe(paths.length)
  })

  it("states its known gaps as merge classes that exist", () => {
    const mergeClasses = new Set(
      ACCEPTANCE_CORPUS.filter((group) => group.label === "merge").map((group) => group.class)
    )
    for (const gap of ACCEPTANCE_KNOWN_GAP_CLASSES) expect(mergeClasses.has(gap)).toBe(true)
  })

  it("keeps each class under one label", () => {
    const labelOf = new Map<string, string>()
    for (const group of ACCEPTANCE_CORPUS) {
      const held = labelOf.get(group.class)
      if (held !== undefined) expect(held).toBe(group.label)
      labelOf.set(group.class, group.label)
    }
  })
})

const decision = (
  id: string,
  label: "merge" | "keep",
  cls: string,
  folded: boolean
): PairDecision => ({
  id,
  group: id.split("/")[0] ?? id,
  label,
  class: cls,
  keepPath: "k.html",
  dropPath: `${id}.html`,
  folded,
  stage: folded ? "folded" : "veto:numeric"
})

describe("the acceptance arithmetic", () => {
  it("scores acceptance over eligible pairs and precision over folds", () => {
    const report = summarizeAcceptance(
      [
        decision("m1/a", "merge", "x", true),
        decision("m1/b", "merge", "x", false),
        decision("k1/a", "keep", "y", false)
      ],
      0.5,
      2
    )
    expect(report.eligible).toBe(2)
    expect(report.accepted).toBe(1)
    expect(report.acceptance).toBe(0.5)
    expect(report.precision).toBe(1)
    expect(report.foldedKeep).toBe(0)
    expect(report.passed).toBe(true)
  })

  it("fails a corpus with one label as not a measurement", () => {
    const onlyMerge = summarizeAcceptance([decision("m1/a", "merge", "x", true)], 0, 1)
    expect(onlyMerge.acceptance).toBe(1)
    expect(onlyMerge.passed).toBe(false)
  })

  it("fails a folded keep pair whatever the floor", () => {
    const report = summarizeAcceptance(
      [decision("m1/a", "merge", "x", true), decision("k1/a", "keep", "y", true)],
      0,
      2
    )
    expect(report.precision).toBe(0.5)
    expect(report.passed).toBe(false)
  })

  it("breaks down by class naming the disagreeing pairs", () => {
    const breakdown = acceptanceByClass([
      decision("m1/a", "merge", "x", true),
      decision("m2/a", "merge", "x", false),
      decision("k1/a", "keep", "y", false)
    ])
    expect(breakdown).toEqual([
      { class: "x", label: "merge", pairs: 2, agreed: 1, disagreed: ["m2/a"] },
      { class: "y", label: "keep", pairs: 1, agreed: 1, disagreed: [] }
    ])
  })

  it("describes a report in one line naming the first disagreement", () => {
    const report = summarizeAcceptance(
      [decision("m1/a", "merge", "x", false), decision("k1/a", "keep", "y", false)],
      0,
      2
    )
    const line = describeAcceptance(report)
    expect(line).toContain("accepted 0 of 1")
    expect(line).toContain("first disagreement m1/a (x, labeled merge) stopped at veto:numeric")
  })
})

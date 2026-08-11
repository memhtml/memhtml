import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  excludeSelfSupersede,
  MAX_MERGE_PAIRS,
  type MergePair,
  mergeCandidates,
  mergeVetoed,
  NEAR_DUPLICATE_THRESHOLD,
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "../src/merge.js"

const PREDICATES = [
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent,
  mergeVetoed
] as const

/** Prose drawn from the vocabularies the guards key on, so divergence actually occurs. */
const body = fc
  .array(
    fc.constantFrom(
      "the",
      "deploy",
      "step",
      "is",
      "safe",
      "not",
      "never",
      "retry",
      "3",
      "13",
      "v2",
      "v2.1",
      "m1",
      "pro",
      "beta",
      "fails",
      "isn't",
      "reject"
    ),
    { minLength: 1, maxLength: 12 }
  )
  .map((words) => words.join(" "))

const path = fc.stringMatching(/^[a-z]{1,6}$/).map((stem) => `areas/oncall/${stem}.html`)

describe("divergence predicates", () => {
  it("is symmetric in its two arguments, every one of them", () => {
    fc.assert(
      fc.property(body, body, (a, b) => {
        for (const predicate of PREDICATES) {
          expect(predicate(a, b)).toBe(predicate(b, a))
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is reflexive-free: a body never diverges from itself", () => {
    fc.assert(
      fc.property(body, (text) => {
        for (const predicate of PREDICATES) {
          expect(predicate(text, text)).toBe(false)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is exactly the disjunction of the three families", () => {
    fc.assert(
      fc.property(body, body, (a, b) => {
        expect(mergeVetoed(a, b)).toBe(
          negationDivergent(a, b) || numericTokenDivergent(a, b) || variantQualifierDivergent(a, b)
        )
      }),
      { numRuns: 1000 }
    )
  })

  it("catches the polarity flip an embedding scores as near-identical", () => {
    expect(negationDivergent("the deploy step is safe", "the deploy step is not safe")).toBe(true)
    expect(mergeVetoed("the deploy step is safe", "the deploy step is not safe")).toBe(true)
  })

  it("reads a contraction as its expansion, so isn't surfaces the not", () => {
    expect(negationDivergent("the deploy step is safe", "the deploy step isn't safe")).toBe(true)
  })

  it("does not flag two bodies that both negate, or neither", () => {
    expect(negationDivergent("never retry", "do not retry")).toBe(false)
    expect(negationDivergent("always retry", "retry again")).toBe(false)
  })

  it("catches a numeric flip", () => {
    expect(numericTokenDivergent("retry 3 times", "retry 13 times")).toBe(true)
    expect(numericTokenDivergent("ADR 11 supersedes", "ADR 13 supersedes")).toBe(true)
  })

  it("does not flag two number-free bodies or two with the same numbers", () => {
    expect(numericTokenDivergent("drain the vip", "drain the vip first")).toBe(false)
    expect(numericTokenDivergent("retry 3 times", "retry 3 times quickly")).toBe(false)
  })

  it("catches a variant qualifier one side lacks", () => {
    expect(variantQualifierDivergent("the M1 build", "the M1 Pro build")).toBe(true)
    expect(variantQualifierDivergent("the release", "the release beta")).toBe(true)
    expect(variantQualifierDivergent("the M1 Pro build", "the M1 Pro build again")).toBe(false)
  })

  it("is case- and unicode-normalization-insensitive", () => {
    expect(negationDivergent("NOT SAFE", "not safe")).toBe(false)
    expect(mergeVetoed("Retry 3 Times", "retry 3 times")).toBe(false)
  })
})

describe("mergeCandidates", () => {
  const pair = (over: Partial<MergePair> = {}): MergePair => ({
    keepPath: "areas/oncall/a.html",
    dropPath: "areas/oncall/b.html",
    similarity: 0.99,
    ...over
  })

  it("pins the threshold and the per-cycle cap", () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toBe(0.92)
    expect(MAX_MERGE_PAIRS).toBe(100)
  })

  it("applies the threshold strictly: exactly at it is not a duplicate", () => {
    expect(mergeCandidates([pair({ similarity: NEAR_DUPLICATE_THRESHOLD })])).toHaveLength(0)
    expect(mergeCandidates([pair({ similarity: NEAR_DUPLICATE_THRESHOLD + 1e-9 })])).toHaveLength(1)
  })

  it("vetoes a divergent pair no matter how high its cosine", () => {
    fc.assert(
      fc.property(body, body, fc.double({ min: 0.93, max: 1, noNaN: true }), (a, b, similarity) => {
        const decisions = mergeCandidates([pair({ similarity, keepText: a, dropText: b })])
        expect(decisions.length).toBe(mergeVetoed(a, b) ? 0 : 1)
      }),
      { numRuns: 1000 }
    )
  })

  it("skips the guards when either text is absent, so a text-less caller is unchanged", () => {
    expect(mergeCandidates([pair({ keepText: "safe", dropText: undefined })])).toHaveLength(1)
    expect(mergeCandidates([pair({ keepText: undefined, dropText: "not safe" })])).toHaveLength(1)
  })

  it("refuses a self-merge", () => {
    expect(mergeCandidates([pair({ dropPath: "areas/oncall/a.html" })])).toHaveLength(0)
  })

  it("fixes each path in one role for the batch: no path is twice a drop, twice a keeper, or both", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(path, path, fc.double({ min: 0.5, max: 1, noNaN: true }))
            .map(
              ([keepPath, dropPath, similarity]): MergePair => ({ keepPath, dropPath, similarity })
            ),
          { maxLength: 20 }
        ),
        (pairs) => {
          const decisions = mergeCandidates(pairs)
          const dropped = decisions.map((decision) => decision.dropPath)
          const kept = decisions.map((decision) => decision.keepPath)
          expect(new Set(dropped).size).toBe(dropped.length)
          expect(new Set(kept).size).toBe(kept.length)
          for (const keeper of kept) {
            expect(dropped).not.toContain(keeper)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("breaks a forward transitive chain rather than folding into an archived file", () => {
    const decisions = mergeCandidates([
      { keepPath: "a.html", dropPath: "b.html", similarity: 0.99 },
      { keepPath: "b.html", dropPath: "c.html", similarity: 0.99 }
    ])
    expect(decisions).toEqual([{ keepPath: "a.html", dropPath: "b.html", similarity: 0.99 }])
  })

  it("refuses to archive a path that already absorbed another this batch", () => {
    const decisions = mergeCandidates([
      { keepPath: "gf.html", dropPath: "a.html", similarity: 0.99 },
      { keepPath: "b.html", dropPath: "gf.html", similarity: 0.99 }
    ])
    expect(decisions).toEqual([{ keepPath: "gf.html", dropPath: "a.html", similarity: 0.99 }])
  })

  it("honors input order as priority order", () => {
    const decisions = mergeCandidates([
      { keepPath: "a.html", dropPath: "b.html", similarity: 0.95 },
      { keepPath: "c.html", dropPath: "b.html", similarity: 0.99 }
    ])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.keepPath).toBe("a.html")
  })

  it("caps the decision count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (maxPairs) => {
        const pairs = Array.from({ length: 40 }, (_, index) => ({
          keepPath: `k${index}.html`,
          dropPath: `d${index}.html`,
          similarity: 0.99
        }))
        expect(mergeCandidates(pairs, { maxPairs }).length).toBeLessThanOrEqual(maxPairs)
      }),
      { numRuns: 1000 }
    )
  })

  it("carries every decision's similarity through untouched", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(path, path, fc.double({ min: 0.93, max: 1, noNaN: true }))
            .map(
              ([keepPath, dropPath, similarity]): MergePair => ({ keepPath, dropPath, similarity })
            ),
          { maxLength: 15 }
        ),
        (pairs) => {
          // First-wins, matching the guard: two pairs can name the same (keep, drop) at
          // different similarities, and only the earlier one is ever committed.
          const bySource = new Map<string, number>()
          for (const pair of pairs) {
            const key = `${pair.keepPath} ${pair.dropPath}`
            if (!bySource.has(key)) bySource.set(key, pair.similarity)
          }
          for (const decision of mergeCandidates(pairs)) {
            expect(bySource.get(`${decision.keepPath} ${decision.dropPath}`)).toBe(
              decision.similarity
            )
          }
        }
      ),
      { numRuns: 1000 }
    )
  })
})

describe("excludeSelfSupersede", () => {
  it("removes the canonical and preserves the order of the rest", () => {
    fc.assert(
      fc.property(fc.array(path, { maxLength: 12 }), path, (members, canonical) => {
        const remaining = excludeSelfSupersede(canonical, members)
        expect(remaining).not.toContain(canonical)
        expect(remaining).toEqual(members.filter((member) => member !== canonical))
      }),
      { numRuns: 1000 }
    )
  })

  it("is a no-op when the canonical is not in the batch", () => {
    expect(excludeSelfSupersede("z.html", ["a.html", "b.html"])).toEqual(["a.html", "b.html"])
  })

  it("removes every occurrence of the canonical", () => {
    expect(excludeSelfSupersede("a.html", ["a.html", "b.html", "a.html"])).toEqual(["b.html"])
  })
})

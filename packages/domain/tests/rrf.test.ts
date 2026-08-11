import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { RRF_K } from "../src/ranking.js"
import { type ArmHit, fuseArms, fuseLateral, rankFused, rrfScore } from "../src/rrf.js"

const rank = fc.integer({ min: 1, max: 5000 })
const weight = fc.double({ min: 0.01, max: 4, noNaN: true })

/** One arm's ranked list: distinct paths at ranks 1..n, which is what the SQL produces. */
const armResult = fc
  .uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 0, maxLength: 12 })
  .map((paths): ReadonlyArray<ArmHit> => paths.map((path, index) => ({ path, rank: index + 1 })))

describe("rrfScore", () => {
  it("is strictly decreasing in rank", () => {
    fc.assert(
      fc.property(rank, weight, (r, w) => {
        expect(rrfScore(r, w)).toBeGreaterThan(rrfScore(r + 1, w))
      }),
      { numRuns: 1000 }
    )
  })

  it("scales linearly in weight and is exactly 0 at weight 0", () => {
    fc.assert(
      fc.property(rank, weight, (r, w) => {
        expect(rrfScore(r, w)).toBeCloseTo(w * rrfScore(r, 1), 12)
        expect(rrfScore(r, 0)).toBe(0)
      }),
      { numRuns: 1000 }
    )
  })

  it("damps the gap between top ranks as k rises, which is what k is for", () => {
    const gapAt = (k: number): number => rrfScore(1, 1, k) - rrfScore(2, 1, k)
    expect(gapAt(0)).toBeGreaterThan(gapAt(RRF_K))
    expect(gapAt(RRF_K)).toBeGreaterThan(gapAt(1000))
  })

  it("defaults k to the published offset", () => {
    expect(rrfScore(1, 1)).toBe(rrfScore(1, 1, RRF_K))
    expect(rrfScore(1, 1)).toBe(1 / (1 + 60))
  })
})

describe("fuseArms", () => {
  it("sums each arm's contribution per path", () => {
    const fused = fuseArms(
      [
        [
          { path: "a", rank: 1 },
          { path: "b", rank: 2 }
        ],
        [
          { path: "b", rank: 1 },
          { path: "c", rank: 2 }
        ]
      ],
      [1, 1]
    )
    expect(fused.get("a")).toBeCloseTo(rrfScore(1, 1), 12)
    expect(fused.get("b")).toBeCloseTo(rrfScore(2, 1) + rrfScore(1, 1), 12)
    expect(fused.get("c")).toBeCloseTo(rrfScore(2, 1), 12)
  })

  it("is order-insensitive across arms, since addition commutes", () => {
    fc.assert(
      fc.property(
        armResult,
        armResult,
        armResult,
        weight,
        weight,
        weight,
        (a, b, c, wa, wb, wc) => {
          const forward = fuseArms([a, b, c], [wa, wb, wc])
          const reversed = fuseArms([c, b, a], [wc, wb, wa])
          expect(forward.size).toBe(reversed.size)
          for (const [path, score] of forward) {
            expect(reversed.get(path)).toBeCloseTo(score, 12)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("leaves a weight-0 arm inert: it contributes no score and introduces no path", () => {
    fc.assert(
      fc.property(armResult, armResult, weight, (kept, dark, w) => {
        const withDark = fuseArms([kept, dark], [w, 0])
        const alone = fuseArms([kept], [w])
        expect(withDark.size).toBe(alone.size)
        for (const [path, score] of alone) {
          expect(withDark.get(path)).toBeCloseTo(score, 12)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("treats a missing weight as a dropped arm rather than weight 1", () => {
    const fused = fuseArms([[{ path: "a", rank: 1 }], [{ path: "b", rank: 1 }]], [1])
    expect(fused.has("a")).toBe(true)
    expect(fused.has("b")).toBe(false)
  })

  it("introduces no path no arm ranked", () => {
    fc.assert(
      fc.property(armResult, armResult, weight, weight, (a, b, wa, wb) => {
        const seen = new Set([...a, ...b].map((hit) => hit.path))
        for (const path of fuseArms([a, b], [wa, wb]).keys()) {
          expect(seen.has(path)).toBe(true)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("scores a path in every arm above the same path in one arm alone", () => {
    fc.assert(
      fc.property(rank, rank, weight, weight, (r1, r2, w1, w2) => {
        const both = fuseArms([[{ path: "x", rank: r1 }], [{ path: "x", rank: r2 }]], [w1, w2])
        const one = fuseArms([[{ path: "x", rank: r1 }]], [w1])
        expect(both.get("x") ?? 0).toBeGreaterThan(one.get("x") ?? 0)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("rankFused", () => {
  it("orders best-first and breaks ties on path, so the ordering is total", () => {
    const ranked = rankFused(
      new Map([
        ["b", 0.5],
        ["a", 0.5],
        ["c", 0.9]
      ])
    )
    expect(ranked.map((hit) => hit.path)).toEqual(["c", "a", "b"])
  })

  it("is a permutation of its input", () => {
    fc.assert(
      fc.property(armResult, armResult, weight, weight, (a, b, wa, wb) => {
        const fused = fuseArms([a, b], [wa, wb])
        const ranked = rankFused(fused)
        expect(ranked).toHaveLength(fused.size)
        expect(new Set(ranked.map((hit) => hit.path)).size).toBe(fused.size)
      }),
      { numRuns: 1000 }
    )
  })

  it("emits a nonincreasing score sequence", () => {
    fc.assert(
      fc.property(armResult, armResult, weight, weight, (a, b, wa, wb) => {
        const ranked = rankFused(fuseArms([a, b], [wa, wb]))
        for (let index = 1; index < ranked.length; index += 1) {
          const previous = ranked[index - 1]
          const current = ranked[index]
          if (previous === undefined || current === undefined) continue
          expect(previous.score).toBeGreaterThanOrEqual(current.score)
        }
      }),
      { numRuns: 1000 }
    )
  })
})

describe("fuseLateral", () => {
  it("leaves the scores untouched when dark or when the walk is empty", () => {
    fc.assert(
      fc.property(
        armResult,
        weight,
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 6 }),
        (arm, w, order) => {
          const base = fuseArms([arm], [w])
          const dark = fuseLateral(base, order, 0)
          const cold = fuseLateral(base, [], w)
          for (const [path, score] of base) {
            expect(dark.get(path)).toBe(score)
            expect(cold.get(path)).toBe(score)
          }
          expect(dark.size).toBe(base.size)
          expect(cold.size).toBe(base.size)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("introduces a walk-only node at its lateral contribution", () => {
    const base = new Map([["a", 0.1]])
    const fused = fuseLateral(base, ["b", "c"], 1)
    expect(fused.get("b")).toBeCloseTo(rrfScore(1, 1), 12)
    expect(fused.get("c")).toBeCloseTo(rrfScore(2, 1), 12)
    expect(fused.get("a")).toBe(0.1)
  })

  it("rewards an earlier walk position more, reading the order as 1-based ranks", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 2, maxLength: 8 }),
        weight,
        (order, w) => {
          const fused = fuseLateral(new Map(), order, w)
          for (let index = 1; index < order.length; index += 1) {
            const earlier = order[index - 1]
            const later = order[index]
            if (earlier === undefined || later === undefined) continue
            expect(fused.get(earlier) ?? 0).toBeGreaterThan(fused.get(later) ?? 0)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("never lowers an existing score", () => {
    fc.assert(
      fc.property(
        armResult,
        weight,
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 8 }),
        weight,
        (arm, w, order, lateralWeight) => {
          const base = fuseArms([arm], [w])
          const fused = fuseLateral(base, order, lateralWeight)
          for (const [path, score] of base) {
            expect(fused.get(path) ?? 0).toBeGreaterThanOrEqual(score)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })
})

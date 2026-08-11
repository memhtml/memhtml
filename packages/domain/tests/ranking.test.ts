import { Option } from "effect"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { MMR_LAMBDA, REINFORCE_COOLDOWN_S, RRF_K, rrfContribution } from "../src/ranking.js"

const contribution = (rank: number, weight: number): number =>
  Option.getOrElse(rrfContribution(rank, weight), () => 0)

describe("rrf constants", () => {
  it("pins the published fusion offset and the MMR split", () => {
    expect(RRF_K).toBe(60)
    expect(MMR_LAMBDA).toBe(0.5)
    expect(REINFORCE_COOLDOWN_S).toBe(900)
  })
})

describe("rrfContribution", () => {
  it("is strictly decreasing in rank", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), (rank) => {
        expect(contribution(rank, 1)).toBeGreaterThan(contribution(rank + 1, 1))
      }),
      { numRuns: 1000 }
    )
  })

  it("returns None for a zero-weight arm so a disabled arm is absent, not neutral", () => {
    expect(Option.isNone(rrfContribution(1, 0))).toBe(true)
    expect(Option.isNone(rrfContribution(1, -0.5))).toBe(true)
  })

  it("returns None for a rank outside the 1-based candidate range", () => {
    expect(Option.isNone(rrfContribution(0, 1))).toBe(true)
    expect(Option.isNone(rrfContribution(Number.NaN, 1))).toBe(true)
    expect(Option.isNone(rrfContribution(Number.POSITIVE_INFINITY, 1))).toBe(true)
  })

  it("scales linearly in weight", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: 0.01, max: 4, noNaN: true }),
        (rank, weight) => {
          expect(contribution(rank, weight)).toBeCloseTo(weight * contribution(rank, 1), 12)
        }
      ),
      { numRuns: 1000 }
    )
  })
})

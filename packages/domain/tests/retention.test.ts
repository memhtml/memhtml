import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { compensatedSum } from "../src/cosine.js"
import {
  bandFor,
  compositeScore,
  computeSignals,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_WEIGHTS,
  EVICT_THRESHOLD,
  HALF_LIVES_DAYS,
  halfLifeFor,
  KEEP_THRESHOLD,
  MAX_REPRIEVES,
  profileWeightSum,
  REPRIEVE_FLOOR,
  type RetentionInput,
  reprieveScore,
  SIGNAL_NAMES,
  type Signals,
  scoreRetention,
  shouldReprieve,
  WEIGHT_PROFILES,
  type WeightProfile
} from "../src/retention.js"

const PROFILED_TYPES = Object.keys(WEIGHT_PROFILES)
const ALL_PROFILES: ReadonlyArray<WeightProfile> = [
  ...Object.values(WEIGHT_PROFILES),
  DEFAULT_WEIGHTS
]

const anyType = fc.oneof(
  fc.constantFrom(...PROFILED_TYPES),
  fc.constantFrom("verdict", "precedent", "agent_insight", "user_preference")
)

const unit = fc.double({ min: 0, max: 1, noNaN: true })

const signals: fc.Arbitrary<Signals> = fc
  .tuple(unit, unit, unit, unit, unit, unit, unit, unit)
  .map(
    ([
      recency,
      accessFrequency,
      confidence,
      pagerank,
      bridgeImportance,
      reinforcementCount,
      contentDensity,
      contestedStatus
    ]) => ({
      recency,
      accessFrequency,
      confidence,
      pagerank,
      bridgeImportance,
      reinforcementCount,
      contentDensity,
      contestedStatus
    })
  )

const retentionInput: fc.Arbitrary<RetentionInput> = fc.record({
  memoryType: anyType,
  ageDays: fc.double({ min: 0, max: 3650, noNaN: true }),
  accessCount: fc.integer({ min: 0, max: 500 }),
  confidence: unit,
  graphRank: fc.double({ min: 0, max: 1, noNaN: true }),
  maxGraphRank: fc.double({ min: 0.0001, max: 1, noNaN: true }),
  bridgeCount: fc.integer({ min: 0, max: 40 }),
  reinforcementCount: fc.integer({ min: 0, max: 40 }),
  wordCount: fc.integer({ min: 0, max: 5000 }),
  contradictionCount: fc.integer({ min: 0, max: 20 })
})

describe("weight profiles", () => {
  it("names eight signals and gives every profile a coefficient for each", () => {
    expect(SIGNAL_NAMES).toHaveLength(8)
    expect(new Set(SIGNAL_NAMES).size).toBe(8)
    for (const profile of ALL_PROFILES) {
      for (const name of SIGNAL_NAMES) {
        expect(typeof profile[name]).toBe("number")
      }
    }
  })

  it("sums every profile to exactly 1.0, which is what makes the composite convex", () => {
    for (const profile of ALL_PROFILES) {
      expect(profileWeightSum(profile)).toBe(1)
    }
  })

  it("carries no negative weight, so no signal can subtract", () => {
    for (const profile of ALL_PROFILES) {
      for (const name of SIGNAL_NAMES) {
        expect(profile[name]).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe("half-lives", () => {
  it("pins the ported per-type half-lives in days", () => {
    expect(HALF_LIVES_DAYS.episodic).toBe(10)
    expect(HALF_LIVES_DAYS.semantic).toBe(90)
    expect(HALF_LIVES_DAYS.procedural).toBeNull()
    expect(HALF_LIVES_DAYS.arc).toBe(30)
    expect(HALF_LIVES_DAYS.error_pattern).toBe(14)
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(30)
  })

  it("never decays a task on age, which says the opposite of what it would mean", () => {
    // An untouched task is the one most likely to still be owed, so age must not lower its score.
    // Sleep excludes tasks by type before scoring, so this is the answer if that ever changes.
    expect(HALF_LIVES_DAYS.task).toBeNull()
    expect(halfLifeFor("task")).toBeNull()
  })

  it("falls back for an unlisted type but keeps procedural's explicit null", () => {
    expect(halfLifeFor("verdict")).toBe(DEFAULT_HALF_LIFE_DAYS)
    expect(halfLifeFor("procedural")).toBeNull()
  })

  it("halves the recency signal exactly at the half-life", () => {
    for (const memoryType of ["episodic", "semantic", "arc", "error_pattern", "verdict"]) {
      const halfLife = halfLifeFor(memoryType)
      if (halfLife === null) continue
      const decayed = computeSignals({
        memoryType,
        ageDays: halfLife,
        accessCount: 0,
        confidence: 0,
        graphRank: 0,
        maxGraphRank: 1,
        bridgeCount: 0,
        reinforcementCount: 0,
        wordCount: 0,
        contradictionCount: 0
      })
      expect(decayed.recency).toBeCloseTo(0.5, 15)
    }
  })

  it("never decays a procedural memory's recency", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10_000, noNaN: true }), (ageDays) => {
        const computed = computeSignals({
          memoryType: "procedural",
          ageDays,
          accessCount: 0,
          confidence: 0,
          graphRank: 0,
          maxGraphRank: 1,
          bridgeCount: 0,
          reinforcementCount: 0,
          wordCount: 0,
          contradictionCount: 0
        })
        expect(computed.recency).toBe(1)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("computeSignals", () => {
  it("normalizes every signal into [0, 1]", () => {
    fc.assert(
      fc.property(retentionInput, (input) => {
        const computed = computeSignals(input)
        for (const name of SIGNAL_NAMES) {
          expect(computed[name]).toBeGreaterThanOrEqual(0)
          expect(computed[name]).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("saturates the count signals at their documented ceilings", () => {
    const at = (over: Partial<RetentionInput>): Signals =>
      computeSignals({
        memoryType: "semantic",
        ageDays: 0,
        accessCount: 0,
        confidence: 0,
        graphRank: 0,
        maxGraphRank: 1,
        bridgeCount: 0,
        reinforcementCount: 0,
        wordCount: 0,
        contradictionCount: 0,
        ...over
      })
    expect(at({ accessCount: 10 }).accessFrequency).toBe(1)
    expect(at({ accessCount: 1000 }).accessFrequency).toBe(1)
    expect(at({ bridgeCount: 5 }).bridgeImportance).toBe(1)
    expect(at({ reinforcementCount: 5 }).reinforcementCount).toBe(1)
    expect(at({ wordCount: 100 }).contentDensity).toBe(1)
    expect(at({ contradictionCount: 3 }).contestedStatus).toBe(0)
  })

  const densityAt = (wordCount: number): number =>
    computeSignals({
      memoryType: "semantic",
      ageDays: 0,
      accessCount: 0,
      confidence: 0,
      graphRank: 0,
      maxGraphRank: 1,
      bridgeCount: 0,
      reinforcementCount: 0,
      wordCount,
      contradictionCount: 0
    }).contentDensity

  it("penalizes a body under ten words below the main wordCount/100 line", () => {
    for (let wordCount = 1; wordCount < 10; wordCount += 1) {
      const density = densityAt(wordCount)
      expect(density).toBeGreaterThan(0)
      expect(density).toBeLessThan(wordCount / 100)
    }
    expect(densityAt(0)).toBe(0)
  })

  /**
   * `contentDensity` is monotone in word count, so a terse memory can never OUT-score a fuller
   * one on a retention signal and survive eviction for being short. The 9-vs-10 pair is the seam
   * where the short-body arm meets the main curve, which is where a divergent short arm shows up
   * first, so it is asserted on its own ahead of the sweep.
   *
   * Mutation-verified 2026-08-24: a short arm of `wordCount / 20` scores a 9-word body 0.45
   * against a 10-word body's 0.10 and fails the 9-vs-10 pair below.
   */
  it("is monotone in word count, so a terse body never out-scores a fuller one", () => {
    expect(densityAt(9)).toBeLessThanOrEqual(densityAt(10))
    for (let wordCount = 0; wordCount <= 120; wordCount += 1) {
      expect(densityAt(wordCount + 1), `at ${wordCount}`).toBeGreaterThanOrEqual(
        densityAt(wordCount)
      )
    }
  })

  it("joins the short-body arm to the main curve continuously at ten words", () => {
    // The arms agree at the seam: 10² / 1000 == 10 / 100, so there is no jump to game.
    expect(densityAt(10)).toBe(0.1)
    expect(densityAt(9)).toBeCloseTo(0.081, 12)
  })
})

describe("compositeScore", () => {
  it("lands in [0, 1] for any signals and any profile", () => {
    fc.assert(
      fc.property(signals, fc.constantFrom(...ALL_PROFILES), (values, profile) => {
        const score = compositeScore(values, profile)
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1)
      }),
      { numRuns: 1000 }
    )
  })

  it("is nondecreasing in every positive signal", () => {
    fc.assert(
      fc.property(
        signals,
        fc.constantFrom(...SIGNAL_NAMES),
        unit,
        fc.constantFrom(...ALL_PROFILES),
        (values, name, bump, profile) => {
          const raised = { ...values, [name]: Math.min(1, values[name] + bump) }
          expect(compositeScore(raised, profile)).toBeGreaterThanOrEqual(
            compositeScore(values, profile)
          )
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("is nonincreasing in contradictionCount, the one inverted input", () => {
    fc.assert(
      fc.property(retentionInput, fc.integer({ min: 1, max: 10 }), (input, extraContradictions) => {
        const before = scoreRetention(input).score
        const after = scoreRetention({
          ...input,
          contradictionCount: input.contradictionCount + extraContradictions
        }).score
        expect(after).toBeLessThanOrEqual(before)
      }),
      { numRuns: 1000 }
    )
  })

  it("scores an all-max signal set at 1 and an all-zero one at 0", () => {
    const max = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, 1])) as unknown as Signals
    const zero = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, 0])) as unknown as Signals
    for (const profile of ALL_PROFILES) {
      expect(compositeScore(max, profile)).toBe(1)
      expect(compositeScore(zero, profile)).toBe(0)
    }
  })

  it("is the weighted average it claims to be", () => {
    fc.assert(
      fc.property(signals, fc.constantFrom(...ALL_PROFILES), (values, profile) => {
        const expected = compensatedSum(SIGNAL_NAMES.map((name) => values[name] * profile[name]))
        expect(compositeScore(values, profile)).toBeCloseTo(expected, 4)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("bandFor", () => {
  it("gives each boundary to the LOWER band: 0.7 compresses, 0.3 evicts", () => {
    expect(bandFor(KEEP_THRESHOLD)).toBe("compress")
    expect(bandFor(EVICT_THRESHOLD)).toBe("evict")
    expect(bandFor(0.7000001)).toBe("keep")
    expect(bandFor(0.3000001)).toBe("compress")
  })

  it("partitions [0, 1]: every score bands, and into exactly one band", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (score) => {
        const band = bandFor(score)
        expect(["keep", "compress", "evict"]).toContain(band)
        expect(band === "keep").toBe(score > KEEP_THRESHOLD)
        expect(band === "evict").toBe(score <= EVICT_THRESHOLD)
        expect(band === "compress").toBe(score > EVICT_THRESHOLD && score <= KEEP_THRESHOLD)
      }),
      { numRuns: 1000 }
    )
  })

  it("is monotone: a higher score never bands more aggressively", () => {
    const severity = { keep: 0, compress: 1, evict: 2 } as const
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a]
          expect(severity[bandFor(higher)]).toBeLessThanOrEqual(severity[bandFor(lower)])
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("bands the composite scoreRetention returns", () => {
    fc.assert(
      fc.property(retentionInput, (input) => {
        const scored = scoreRetention(input)
        expect(scored.action).toBe(bandFor(scored.score))
      }),
      { numRuns: 1000 }
    )
  })
})

const reprieveInput = fc.record({
  importance: fc.integer({ min: 1, max: 10 }),
  accessCount: fc.integer({ min: 0, max: 500 }),
  outcomeScore: fc.double({ min: -1, max: 1, noNaN: true }),
  hoursSinceAccess: fc.double({ min: 0, max: 10_000, noNaN: true })
})

describe("reprieveScore", () => {
  it("is strictly increasing in accessCount, since log1p is", () => {
    fc.assert(
      fc.property(reprieveInput, fc.integer({ min: 1, max: 100 }), (input, extra) => {
        expect(reprieveScore({ ...input, accessCount: input.accessCount + extra })).toBeGreaterThan(
          reprieveScore(input)
        )
      }),
      { numRuns: 1000 }
    )
  })

  it("is nondecreasing in importance", () => {
    fc.assert(
      fc.property(reprieveInput, (input) => {
        const lower = reprieveScore({ ...input, importance: 1 })
        const higher = reprieveScore({ ...input, importance: 10 })
        expect(higher).toBeGreaterThanOrEqual(lower)
      }),
      { numRuns: 1000 }
    )
  })

  it("contributes 0 for a negative outcome, never a penalty", () => {
    fc.assert(
      fc.property(reprieveInput, fc.double({ min: -1, max: 0, noNaN: true }), (input, negative) => {
        expect(reprieveScore({ ...input, outcomeScore: negative })).toBe(
          reprieveScore({ ...input, outcomeScore: 0 })
        )
      }),
      { numRuns: 1000 }
    )
  })

  it("is strictly positive, so the floor alone can never force expiry", () => {
    fc.assert(
      fc.property(reprieveInput, (input) => {
        expect(reprieveScore(input)).toBeGreaterThan(0)
      }),
      { numRuns: 1000 }
    )
  })

  it("decays with hours since access, all else equal", () => {
    fc.assert(
      fc.property(reprieveInput, fc.double({ min: 1, max: 1000, noNaN: true }), (input, extra) => {
        expect(
          reprieveScore({ ...input, hoursSinceAccess: input.hoursSinceAccess + extra })
        ).toBeLessThanOrEqual(reprieveScore(input))
      }),
      { numRuns: 1000 }
    )
  })
})

describe("shouldReprieve", () => {
  it("pins the ported floor and cap", () => {
    expect(REPRIEVE_FLOOR).toBe(0.5)
    expect(MAX_REPRIEVES).toBe(3)
  })

  it("forces expiry for every score when maxReprieves is 0, the kill switch", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.integer({ min: 0, max: 10 }),
        (score, reprieveCount) => {
          expect(shouldReprieve({ score, reprieveCount, maxReprieves: 0 })).toBe(false)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("owns the floor boundary with the reprieve: exactly at the floor is reprieved", () => {
    expect(shouldReprieve({ score: REPRIEVE_FLOOR, reprieveCount: 0 })).toBe(true)
    expect(shouldReprieve({ score: REPRIEVE_FLOOR - 1e-9, reprieveCount: 0 })).toBe(false)
  })

  it("stops at the cap, counting reprieves already granted", () => {
    expect(shouldReprieve({ score: 1, reprieveCount: MAX_REPRIEVES - 1 })).toBe(true)
    expect(shouldReprieve({ score: 1, reprieveCount: MAX_REPRIEVES })).toBe(false)
    expect(shouldReprieve({ score: 1, reprieveCount: MAX_REPRIEVES + 5 })).toBe(false)
  })
})

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  applyNegativeHitsFp,
  applyOutcomesFp,
  CONFIDENCE_COMMIT_DELTA,
  DEFAULT_CONFIDENCE_DECAY_ALPHA,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_EWMA_ALPHA,
  decayConfidence,
  decayConfidenceFp,
  decayConfidenceN,
  decayConfidenceNFp,
  ewmaStepFp,
  fromFp,
  isCommittableConfidenceChange,
  NEG_ONE_FP,
  POS_ONE_FP,
  SCALE,
  toFp
} from "../src/decay.js"

const alphaFp = fc.integer({ min: 0, max: SCALE })
const confFp = fc.integer({ min: 0, max: SCALE })
const floorFp = fc.integer({ min: 0, max: SCALE })
const signedFp = fc.integer({ min: NEG_ONE_FP, max: POS_ONE_FP })

describe("fixed-point grid", () => {
  it("pins the scale and the ported alphas", () => {
    expect(SCALE).toBe(10_000)
    expect(POS_ONE_FP).toBe(SCALE)
    expect(NEG_ONE_FP).toBe(-SCALE)
    expect(DEFAULT_EWMA_ALPHA).toBe(0.3)
    expect(DEFAULT_CONFIDENCE_DECAY_ALPHA).toBe(0.1)
    expect(DEFAULT_CONFIDENCE_FLOOR).toBe(0.2)
  })

  it("round-trips a grid-aligned float exactly", () => {
    fc.assert(
      fc.property(signedFp, (valueFp) => {
        expect(toFp(fromFp(valueFp))).toBe(valueFp)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("ewmaStepFp", () => {
  it("stays inside the domain", () => {
    fc.assert(
      fc.property(alphaFp, signedFp, signedFp, (alpha, prev, signal) => {
        const next = ewmaStepFp(alpha, prev, signal)
        expect(next).toBeGreaterThanOrEqual(NEG_ONE_FP)
        expect(next).toBeLessThanOrEqual(POS_ONE_FP)
      }),
      { numRuns: 1000 }
    )
  })

  it("moves toward the signal and never past it", () => {
    fc.assert(
      fc.property(alphaFp, signedFp, signedFp, (alpha, prev, signal) => {
        const next = ewmaStepFp(alpha, prev, signal)
        expect(next).toBeGreaterThanOrEqual(Math.min(prev, signal))
        expect(next).toBeLessThanOrEqual(Math.max(prev, signal))
      }),
      { numRuns: 1000 }
    )
  })

  it("is a fixed point at alpha 0 and snaps to the signal at alpha SCALE", () => {
    fc.assert(
      fc.property(signedFp, signedFp, (prev, signal) => {
        expect(ewmaStepFp(0, prev, signal)).toBe(prev)
        expect(ewmaStepFp(SCALE, prev, signal)).toBe(signal)
      }),
      { numRuns: 1000 }
    )
  })

  it("never raises a score on a negative hit", () => {
    fc.assert(
      fc.property(alphaFp, signedFp, (alpha, prev) => {
        expect(ewmaStepFp(alpha, prev, NEG_ONE_FP)).toBeLessThanOrEqual(prev)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("applyOutcomesFp", () => {
  it("folds an N-signal batch exactly as N single steps do", () => {
    fc.assert(
      fc.property(
        alphaFp,
        signedFp,
        fc.array(signedFp, { minLength: 0, maxLength: 12 }),
        (alpha, prev, signals) => {
          let stepwise = prev
          for (const signal of signals) stepwise = ewmaStepFp(alpha, stepwise, signal)
          expect(applyOutcomesFp(alpha, prev, signals)).toBe(stepwise)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("treats an empty batch and a non-positive hit count as no-ops", () => {
    fc.assert(
      fc.property(alphaFp, signedFp, fc.integer({ min: -5, max: 0 }), (alpha, prev, hits) => {
        expect(applyOutcomesFp(alpha, prev, [])).toBe(prev)
        expect(applyNegativeHitsFp(alpha, prev, hits)).toBe(prev)
      }),
      { numRuns: 1000 }
    )
  })

  it("agrees with the explicit all-negative batch", () => {
    fc.assert(
      fc.property(alphaFp, signedFp, fc.integer({ min: 1, max: 20 }), (alpha, prev, hits) => {
        expect(applyNegativeHitsFp(alpha, prev, hits)).toBe(
          applyOutcomesFp(
            alpha,
            prev,
            Array.from({ length: hits }, () => NEG_ONE_FP)
          )
        )
      }),
      { numRuns: 1000 }
    )
  })
})

describe("decayConfidenceFp", () => {
  it("stays inside [0, SCALE]", () => {
    fc.assert(
      fc.property(alphaFp, confFp, floorFp, (alpha, conf, floor) => {
        const next = decayConfidenceFp(alpha, conf, floor)
        expect(next).toBeGreaterThanOrEqual(0)
        expect(next).toBeLessThanOrEqual(SCALE)
      }),
      { numRuns: 1000 }
    )
  })

  it("is unconditionally non-increasing", () => {
    fc.assert(
      fc.property(alphaFp, confFp, floorFp, (alpha, conf, floor) => {
        expect(decayConfidenceFp(alpha, conf, floor)).toBeLessThanOrEqual(conf)
      }),
      { numRuns: 1000 }
    )
  })

  it("respects the floor from at or above it", () => {
    fc.assert(
      fc.property(alphaFp, confFp, floorFp, (alpha, conf, floor) => {
        if (conf < floor) return
        expect(decayConfidenceFp(alpha, conf, floor)).toBeGreaterThanOrEqual(floor)
      }),
      { numRuns: 1000 }
    )
  })

  it("never rehabilitates a claim already below the floor", () => {
    fc.assert(
      fc.property(alphaFp, confFp, floorFp, (alpha, conf, floor) => {
        if (conf >= floor) return
        expect(decayConfidenceFp(alpha, conf, floor)).toBe(conf)
      }),
      { numRuns: 1000 }
    )
  })

  it("is a fixed point at alpha 0 and snaps to the floor at alpha SCALE", () => {
    fc.assert(
      fc.property(confFp, floorFp, (conf, floor) => {
        expect(decayConfidenceFp(0, conf, floor)).toBe(conf)
        expect(decayConfidenceFp(SCALE, conf, floor)).toBe(Math.min(conf, floor))
      }),
      { numRuns: 1000 }
    )
  })

  it("is idempotent once it reaches the floor", () => {
    fc.assert(
      fc.property(alphaFp, floorFp, (alpha, floor) => {
        expect(decayConfidenceFp(alpha, floor, floor)).toBe(floor)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("decayConfidenceNFp", () => {
  it("equals the step-wise loop for any cycle count", () => {
    fc.assert(
      fc.property(
        alphaFp,
        confFp,
        floorFp,
        fc.integer({ min: 0, max: 40 }),
        (alpha, conf, floor, cycles) => {
          let stepwise = conf
          for (let cycle = 0; cycle < cycles; cycle += 1) {
            stepwise = decayConfidenceFp(alpha, stepwise, floor)
          }
          expect(decayConfidenceNFp(alpha, conf, floor, cycles)).toBe(stepwise)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("treats a non-positive cycle count as a no-op, so a phase re-run is idempotent", () => {
    fc.assert(
      fc.property(alphaFp, confFp, floorFp, fc.integer({ min: -5, max: 0 }), (a, c, f, cycles) => {
        expect(decayConfidenceNFp(a, c, f, cycles)).toBe(c)
      }),
      { numRuns: 1000 }
    )
  })

  it("is monotone in the cycle count", () => {
    fc.assert(
      fc.property(
        alphaFp,
        confFp,
        floorFp,
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (alpha, conf, floor, cycles, extra) => {
          expect(decayConfidenceNFp(alpha, conf, floor, cycles + extra)).toBeLessThanOrEqual(
            decayConfidenceNFp(alpha, conf, floor, cycles)
          )
        }
      ),
      { numRuns: 1000 }
    )
  })
})

describe("decayConfidence in the [0, 1] float space", () => {
  it("stays in [0, 1] and never rises", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (confidence, alpha, floor) => {
          const next = decayConfidence(confidence, alpha, floor)
          expect(next).toBeGreaterThanOrEqual(0)
          expect(next).toBeLessThanOrEqual(1)
          expect(next).toBeLessThanOrEqual(toFp(confidence) / SCALE)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("erodes a full-confidence claim toward the floor without crossing it", () => {
    let confidence = 1
    for (let cycle = 0; cycle < 200; cycle += 1) {
      confidence = decayConfidence(confidence)
      expect(confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_FLOOR)
    }
    expect(confidence).toBeCloseTo(DEFAULT_CONFIDENCE_FLOOR, 4)
  })

  it("agrees with the folded form over N cycles", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 30 }),
        (confidence, cycles) => {
          let stepwise = confidence
          for (let cycle = 0; cycle < cycles; cycle += 1) stepwise = decayConfidence(stepwise)
          expect(decayConfidenceN(confidence, cycles)).toBeCloseTo(stepwise, 4)
        }
      ),
      { numRuns: 1000 }
    )
  })
})

describe("commit-worthiness", () => {
  it("suppresses a sub-threshold delta so the widest sleep commit stays reviewable", () => {
    expect(CONFIDENCE_COMMIT_DELTA).toBe(0.005)
    expect(isCommittableConfidenceChange(0.9, 0.9)).toBe(false)
    expect(isCommittableConfidenceChange(0.9, 0.8988)).toBe(false)
    expect(isCommittableConfidenceChange(0.9, 0.895)).toBe(true)
  })

  it("is symmetric in the two values", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (before, after) => {
          expect(isCommittableConfidenceChange(before, after)).toBe(
            isCommittableConfidenceChange(after, before)
          )
        }
      ),
      { numRuns: 1000 }
    )
  })
})

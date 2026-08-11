import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { compensatedSum, cosine, cosineDistance } from "../src/cosine.js"
import { applyMmr, type MmrCandidate } from "../src/mmr.js"
import { MMR_LAMBDA } from "../src/ranking.js"

const component = fc.double({ min: -10, max: 10, noNaN: true })
const vector = fc.array(component, { minLength: 4, maxLength: 8 })

/**
 * A vector with a representable magnitude. Filtering on "some component is non-zero" is not
 * enough: a subnormal like `5e-324` squares to exactly 0, so the magnitude underflows and the
 * zero-magnitude guard correctly fires — which is the behavior the underflow test below pins.
 */
const nonZeroVector = vector.filter(
  (values) => values.reduce((sum, value) => sum + value * value, 0) > 0
)

const candidate = fc
  .tuple(
    fc.stringMatching(/^[a-z]{1,6}$/),
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.option(fc.array(component, { minLength: 4, maxLength: 4 }), { nil: undefined })
  )
  .map(([path, score, vec]): MmrCandidate => ({ path, score, vector: vec }))

const candidates = fc
  .uniqueArray(candidate, { minLength: 0, maxLength: 10, selector: (c) => c.path })
  .map((list) => [...list].sort((left, right) => right.score - left.score))

describe("cosine", () => {
  it("returns 0 rather than NaN for a zero-magnitude vector", () => {
    fc.assert(
      fc.property(vector, (values) => {
        const zeros = values.map(() => 0)
        expect(cosine(zeros, values)).toBe(0)
        expect(cosine(values, zeros)).toBe(0)
        expect(Number.isNaN(cosine(zeros, zeros))).toBe(false)
      }),
      { numRuns: 1000 }
    )
  })

  it("never returns NaN for any pair of vectors", () => {
    fc.assert(
      fc.property(vector, vector, (a, b) => {
        expect(Number.isNaN(cosine(a, b))).toBe(false)
      }),
      { numRuns: 1000 }
    )
  })

  it("is symmetric and bounded by [-1, 1] exactly, not approximately", () => {
    fc.assert(
      fc.property(vector, vector, (a, b) => {
        const similarity = cosine(a, b)
        expect(cosine(b, a)).toBe(similarity)
        expect(similarity).toBeGreaterThanOrEqual(-1)
        expect(similarity).toBeLessThanOrEqual(1)
      }),
      { numRuns: 1000 }
    )
  })

  it("clamps the subnormal-magnitude pair whose unclamped ratio exceeds 1", () => {
    const a = [0, 0, 0, 2.222758749485078e-162]
    const b = [0, 0, 0, 2.0808141537085223e-155, 0]
    expect(cosine(a, b)).toBe(1)
    expect(cosineDistance(a, b)).toBe(0)
  })

  it("keeps the distance in [0, 2] for any pair", () => {
    fc.assert(
      fc.property(vector, vector, (a, b) => {
        const distance = cosineDistance(a, b)
        expect(distance).toBeGreaterThanOrEqual(0)
        expect(distance).toBeLessThanOrEqual(2)
      }),
      { numRuns: 1000 }
    )
  })

  it("scores a vector against itself at 1 and against its negation at -1", () => {
    fc.assert(
      fc.property(nonZeroVector, (values) => {
        expect(cosine(values, values)).toBeCloseTo(1, 10)
        expect(
          cosine(
            values,
            values.map((v) => -v)
          )
        ).toBeCloseTo(-1, 10)
      }),
      { numRuns: 1000 }
    )
  })

  it("treats a vector whose magnitude underflows as zero-magnitude, not as NaN", () => {
    const subnormal = [0, 0, 0, 5e-324]
    expect(cosine(subnormal, subnormal)).toBe(0)
    expect(cosine(subnormal, [1, 0, 0, 0])).toBe(0)
  })

  it("is scale-invariant, which is what makes it a direction measure", () => {
    // Components bounded away from zero: scaling a near-subnormal vector underflows its
    // magnitude to 0 and the zero-magnitude guard fires, which is a float limit rather than a
    // similarity claim. A real Cohere vector's components sit near unit scale.
    const wellScaled = fc.array(
      fc
        .double({ min: 0.001, max: 10, noNaN: true })
        .chain((magnitude) => fc.constantFrom(magnitude, -magnitude)),
      { minLength: 4, maxLength: 6 }
    )
    fc.assert(
      fc.property(
        wellScaled,
        wellScaled,
        fc.double({ min: 0.1, max: 50, noNaN: true }),
        (a, b, k) => {
          expect(
            cosine(
              a.map((v) => v * k),
              b
            )
          ).toBeCloseTo(cosine(a, b), 8)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("reports distance as one minus similarity, the space the vector SQL works in", () => {
    fc.assert(
      fc.property(vector, vector, (a, b) => {
        expect(cosineDistance(a, b)).toBeCloseTo(1 - cosine(a, b), 12)
      }),
      { numRuns: 1000 }
    )
  })
})

describe("compensatedSum", () => {
  it("sums the profile weights that naive addition gets wrong", () => {
    expect(compensatedSum([0.25, 0.15, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe(1)
    expect([0.25, 0.15, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1].reduce((a, b) => a + b, 0)).not.toBe(1)
  })

  it("agrees with naive addition to within float tolerance", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -1000, max: 1000, noNaN: true })), (values) => {
        expect(compensatedSum(values)).toBeCloseTo(
          values.reduce((sum, value) => sum + value, 0),
          6
        )
      }),
      { numRuns: 1000 }
    )
  })

  it("is 0 over an empty sequence", () => {
    expect(compensatedSum([])).toBe(0)
  })
})

describe("applyMmr", () => {
  it("preserves fusion order at lambda 1", () => {
    fc.assert(
      fc.property(candidates, fc.integer({ min: 1, max: 12 }), (pool, limit) => {
        expect(applyMmr(pool, limit, 1).map((c) => c.path)).toEqual(
          pool.slice(0, limit).map((c) => c.path)
        )
      }),
      { numRuns: 1000 }
    )
  })

  it("returns a duplicate-free subsequence by membership, inventing nothing", () => {
    fc.assert(
      fc.property(
        candidates,
        fc.integer({ min: 1, max: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (pool, limit, lambda) => {
          const selected = applyMmr(pool, limit, lambda)
          const available = new Set(pool.map((c) => c.path))
          expect(new Set(selected.map((c) => c.path)).size).toBe(selected.length)
          for (const chosen of selected) {
            expect(available.has(chosen.path)).toBe(true)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("returns min(limit, poolSize) candidates", () => {
    fc.assert(
      fc.property(
        candidates,
        fc.integer({ min: 0, max: 15 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (pool, limit, lambda) => {
          expect(applyMmr(pool, limit, lambda)).toHaveLength(Math.min(limit, pool.length))
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("returns nothing for a non-positive limit", () => {
    fc.assert(
      fc.property(candidates, fc.integer({ min: -5, max: 0 }), (pool, limit) => {
        expect(applyMmr(pool, limit)).toEqual([])
      }),
      { numRuns: 1000 }
    )
  })

  it("keeps vectorless candidates in their relative fusion order", () => {
    fc.assert(
      fc.property(candidates, fc.double({ min: 0, max: 0.99, noNaN: true }), (pool, lambda) => {
        const blindOrder = (list: ReadonlyArray<MmrCandidate>): ReadonlyArray<string> =>
          list.filter((c) => c.vector === undefined).map((c) => c.path)
        const selected = applyMmr(pool, pool.length, lambda)
        expect(blindOrder(selected)).toEqual(blindOrder(pool))
      }),
      { numRuns: 1000 }
    )
  })

  it("takes no penalty for a vectorless candidate, so it outranks a vectored duplicate", () => {
    const shared = [1, 0, 0, 0]
    const selected = applyMmr(
      [
        { path: "first", score: 1, vector: shared },
        { path: "duplicate", score: 0.6, vector: shared },
        { path: "blind", score: 0.5 }
      ],
      3,
      0.5
    )
    expect(selected.map((c) => c.path)).toEqual(["first", "blind", "duplicate"])
  })

  it("never demotes a vectorless candidate below a duplicate of an already-selected vector", () => {
    fc.assert(
      fc.property(
        // A representable magnitude, not merely a non-zero component: a subnormal squares to 0,
        // so the duplicate would score similarity 0 and carry no penalty to compare against.
        fc
          .array(component, { minLength: 4, maxLength: 4 })
          .filter((v) => v.reduce((sum, x) => sum + x * x, 0) > 0),
        fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (shared, blindScore, lambda) => {
          if (lambda >= 1) return
          const order = applyMmr(
            [
              { path: "anchor", score: 1, vector: shared },
              { path: "duplicate", score: blindScore, vector: shared },
              { path: "blind", score: blindScore }
            ],
            3,
            lambda
          ).map((c) => c.path)
          expect(order.indexOf("blind")).toBeLessThan(order.indexOf("duplicate"))
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("picks the most relevant candidate first, whatever lambda", () => {
    fc.assert(
      fc.property(
        candidates.filter((pool) => pool.length > 0),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (pool, lambda) => {
          const first = applyMmr(pool, pool.length, lambda)[0]
          expect(first?.path).toBe(pool[0]?.path)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("demotes an exact duplicate of an already-selected vector", () => {
    const shared = [1, 0, 0, 0]
    const selected = applyMmr(
      [
        { path: "first", score: 1, vector: shared },
        { path: "clone", score: 0.98, vector: shared },
        { path: "other", score: 0.9, vector: [0, 1, 0, 0] }
      ],
      2,
      0.5
    )
    expect(selected.map((c) => c.path)).toEqual(["first", "other"])
  })

  it("keeps a near-duplicate when lambda leaves no room for diversity", () => {
    const shared = [1, 0, 0, 0]
    const selected = applyMmr(
      [
        { path: "first", score: 1, vector: shared },
        { path: "clone", score: 0.98, vector: shared },
        { path: "other", score: 0.1, vector: [0, 1, 0, 0] }
      ],
      2,
      1
    )
    expect(selected.map((c) => c.path)).toEqual(["first", "clone"])
  })

  it("defaults lambda to the pinned relevance/diversity split", () => {
    fc.assert(
      fc.property(candidates, fc.integer({ min: 1, max: 12 }), (pool, limit) => {
        expect(applyMmr(pool, limit).map((c) => c.path)).toEqual(
          applyMmr(pool, limit, MMR_LAMBDA).map((c) => c.path)
        )
      }),
      { numRuns: 1000 }
    )
  })
})

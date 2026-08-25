import { describe, expect, it, vi } from "vitest"

import { applyMmr, type MmrCandidate } from "../src/mmr.js"

/**
 * A cost assertion, not a correctness one, because the defect it locks is invisible to output:
 * `applyMmr`'s cached penalty fold and a fold that recomputes every candidate's max against the
 * whole selected set return the SAME order for every input, and one of them does it with 49x
 * more dot products. `mmr.test.ts` compares the two against each other, so it cannot see this —
 * with both sides collapsed to the same algorithm the equivalence holds trivially.
 *
 * The counter replaces `cosine` with a wrapper around the real one, so the number is an
 * invocation count rather than a wall-clock reading: exact, deterministic, and immune to a
 * loaded machine.
 *
 * The discriminating axis is the LIMIT, not the pool size. Both folds are linear in n at fixed
 * k — the from-scratch one costs about n·k²/2 — so doubling the pool doubles both and separates
 * nothing. Doubling k doubles the cached fold and quadruples the from-scratch one.
 *
 * Measured 2026-08-25 over a pool of 400: the shipped fold spends 7,410 cosines at limit 20 and
 * 14,820 at limit 40, growth exactly 2.00. Recomputing from scratch spends 73,530 and 291,460,
 * growth 3.96, overshooting the one-pass-per-round budget 9x at limit 20 and 18x at limit 40.
 * Both bounds below are derived from the algorithm rather than copied from a run, so the gap
 * between pass and fail is orders of magnitude and neither needs a fudge factor.
 */
const counter = vi.hoisted(() => ({ calls: 0 }))

vi.mock("../src/cosine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cosine.js")>()
  return {
    ...actual,
    cosine: (a: ArrayLike<number>, b: ArrayLike<number>): number => {
      counter.calls += 1
      return actual.cosine(a, b)
    }
  }
})

/** The pool every measurement runs against. Big enough that k² and k are orders apart. */
const POOL_SIZE = 400

/**
 * A pool where every candidate carries a distinct non-degenerate vector, so every round costs
 * one cosine per surviving candidate and the count is a pure function of (pool size, limit).
 * Scores descend, which fixes the first selection and keeps the measurement reproducible.
 */
const poolOf = (poolSize: number): ReadonlyArray<MmrCandidate> =>
  Array.from({ length: poolSize }, (_, index) => {
    const angle = (index * Math.PI) / poolSize
    return {
      path: `p${index}`,
      score: 1 - index / poolSize,
      vector: [Math.cos(angle), Math.sin(angle), 0.5, -0.25]
    }
  })

/** Cosine invocations for one `applyMmr` run, having first checked the run is correct. */
const cosinesFor = (poolSize: number, limit: number): number => {
  const pool = poolOf(poolSize)
  counter.calls = 0
  const selected = applyMmr(pool, limit, 0.5)
  const calls = counter.calls
  // Correctness first: a cost bound over a wrong answer locks nothing.
  expect(selected).toHaveLength(limit)
  expect(new Set(selected.map((c) => c.path)).size).toBe(limit)
  expect(selected[0]?.path).toBe("p0")
  /**
   * And a census, so an upper bound cannot pass by counting nothing: at any limit above 1 the
   * round after the first selection scans the whole surviving pool, so a count below that means
   * the probe stopped seeing calls — an inlined dot product, or an import that moved.
   */
  expect(
    calls,
    "the cosine probe counted nothing, so the bounds are vacuous"
  ).toBeGreaterThanOrEqual(poolSize - 1)
  return calls
}

describe("applyMmr cost", () => {
  it("spends at most one pass over the surviving pool per selection round", () => {
    for (const limit of [20, 40]) {
      const calls = cosinesFor(POOL_SIZE, limit)
      expect(
        calls,
        `${calls} cosines to select ${limit} of ${POOL_SIZE}, budget ${limit * POOL_SIZE}`
      ).toBeLessThanOrEqual(limit * POOL_SIZE)
    }
  })

  it("grows linearly in the limit, not quadratically", () => {
    const small = cosinesFor(POOL_SIZE, 20)
    const large = cosinesFor(POOL_SIZE, 40)
    const growth = large / small
    expect(
      growth,
      `doubling the limit multiplied the cosine count by ${growth.toFixed(2)} (${small} -> ${large})`
    ).toBeLessThan(2.5)
  })
})

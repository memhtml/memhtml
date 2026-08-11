import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { REINFORCE_COOLDOWN_S } from "../src/ranking.js"
import {
  partitionByCooldown,
  REINFORCE_SIGNALS,
  shouldBumpAccess,
  signalValue
} from "../src/reinforce.js"

const NOW = new Date("2026-08-02T14:03:11Z")
const at = (secondsAgo: number): Date => new Date(NOW.getTime() - secondsAgo * 1000)

describe("shouldBumpAccess", () => {
  it("pins the window at 900 seconds", () => {
    expect(REINFORCE_COOLDOWN_S).toBe(900)
  })

  it("bumps a memory with no stamp at all", () => {
    expect(shouldBumpAccess(undefined, NOW)).toBe(true)
  })

  it("owns the boundary with the bump, matching the SQL guard's >=", () => {
    expect(shouldBumpAccess(at(REINFORCE_COOLDOWN_S), NOW)).toBe(true)
    expect(shouldBumpAccess(at(REINFORCE_COOLDOWN_S - 0.001), NOW)).toBe(false)
    expect(shouldBumpAccess(at(REINFORCE_COOLDOWN_S + 0.001), NOW)).toBe(true)
  })

  it("refuses anything inside the window and allows anything outside it", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100_000, noNaN: true }), (secondsAgo) => {
        expect(shouldBumpAccess(at(secondsAgo), NOW)).toBe(secondsAgo >= REINFORCE_COOLDOWN_S)
      }),
      { numRuns: 1000 }
    )
  })

  it("is monotone in elapsed time: once bumpable, always bumpable", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        (secondsAgo, extra) => {
          if (!shouldBumpAccess(at(secondsAgo), NOW)) return
          expect(shouldBumpAccess(at(secondsAgo + extra), NOW)).toBe(true)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("refuses a stamp from the future, which a clock skew can produce", () => {
    expect(shouldBumpAccess(at(-60), NOW)).toBe(false)
  })

  it("honors a caller-supplied window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 86_400 }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        (cooldown, secondsAgo) => {
          expect(shouldBumpAccess(at(secondsAgo), NOW, cooldown)).toBe(secondsAgo >= cooldown)
        }
      ),
      { numRuns: 1000 }
    )
  })
})

describe("signalValue", () => {
  it("names three signals and maps them into [-1, 1] with neutral at 0", () => {
    expect(REINFORCE_SIGNALS).toEqual(["positive", "negative", "neutral"])
    expect(signalValue("positive")).toBe(1)
    expect(signalValue("negative")).toBe(-1)
    expect(signalValue("neutral")).toBe(0)
  })
})

describe("partitionByCooldown", () => {
  it("partitions every path into exactly one list, order preserved", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[a-z]{1,6}$/),
            fc.option(fc.double({ min: 0, max: 5000, noNaN: true }), { nil: undefined })
          ),
          { maxLength: 20 }
        ),
        (raw) => {
          const entries = raw.map(([path, secondsAgo]) => ({
            path,
            lastAccessedAt: secondsAgo === undefined ? undefined : at(secondsAgo)
          }))
          const { bumped, cooledDown } = partitionByCooldown(entries, NOW)
          expect(bumped.length + cooledDown.length).toBe(entries.length)
          expect([...bumped, ...cooledDown].sort()).toEqual(
            entries.map((entry) => entry.path).sort()
          )
          for (const entry of entries) {
            const expected = shouldBumpAccess(entry.lastAccessedAt, NOW)
            expect(bumped.includes(entry.path) || cooledDown.includes(entry.path)).toBe(true)
            if (expected) expect(bumped).toContain(entry.path)
            else expect(cooledDown).toContain(entry.path)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("agrees with the predicate on every entry", () => {
    const { bumped, cooledDown } = partitionByCooldown(
      [
        { path: "fresh", lastAccessedAt: at(10) },
        { path: "stale", lastAccessedAt: at(1000) },
        { path: "new" }
      ],
      NOW
    )
    expect(bumped).toEqual(["stale", "new"])
    expect(cooledDown).toEqual(["fresh"])
  })
})

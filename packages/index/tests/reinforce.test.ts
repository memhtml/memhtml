import { REINFORCE_COOLDOWN_S, shouldBumpAccess } from "@memhtml/domain"
import { Effect } from "effect"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { OUTCOME_EWMA_ALPHA, reinforce } from "../src/reinforce.js"
import { withDb, withDbNoState } from "./harness.js"

/**
 * The reinforcement cooldown, on both sides of the seam.
 *
 * The window lives once as `@memhtml/domain`'s `REINFORCE_COOLDOWN_S` and once as the SQL guard's
 * comparison, because SQL cannot call the function. That is a genuine duplication, so it needs a
 * genuine pin: the property test below runs the SAME instants through `shouldBumpAccess` and through
 * the real database and requires they agree, including at the exact boundary where `>=` versus `>`
 * decides the answer.
 */

const BASE = Date.parse("2026-08-01T00:00:00Z")
const iso = (offsetSeconds: number) => new Date(BASE + offsetSeconds * 1000).toISOString()

describe("reinforce", () => {
  it("bumps a path with no prior access row", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const result = yield* reinforce(db, ["areas/a.html"], "neutral", iso(0))
        const row = yield* db.get<{ access_count: number; reinforcement_count: number }>(
          "SELECT access_count, reinforcement_count FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
        return { result, row }
      })
    )
    expect(outcome.result).toEqual({ bumped: ["areas/a.html"], cooledDown: [] })
    expect(outcome.row?.access_count).toBe(1)
    // Being read is evidence of relevance, not of correctness: a neutral signal moves no outcome.
    expect(outcome.row?.reinforcement_count).toBe(0)
  })

  it("reports a second bump inside the window as cooled down and leaves the row alone", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* reinforce(db, ["areas/a.html"], "neutral", iso(0))
        const result = yield* reinforce(db, ["areas/a.html"], "neutral", iso(60))
        const row = yield* db.get<{ access_count: number; last_accessed_at: string }>(
          "SELECT access_count, last_accessed_at FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
        return { result, row }
      })
    )
    expect(outcome.result).toEqual({ bumped: [], cooledDown: ["areas/a.html"] })
    expect(outcome.row?.access_count).toBe(1)
    // The stamp must not move either — a refreshed stamp on a refused bump would extend the cooldown
    // indefinitely under a query loop, which is the exact abuse the cooldown exists to stop.
    expect(outcome.row?.last_accessed_at).toBe(iso(0))
  })

  it("bumps again at exactly the cooldown boundary, and not one second before", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* reinforce(db, ["areas/a.html"], "neutral", iso(0))
        const justBefore = yield* reinforce(
          db,
          ["areas/a.html"],
          "neutral",
          iso(REINFORCE_COOLDOWN_S - 1)
        )
        const exactly = yield* reinforce(db, ["areas/a.html"], "neutral", iso(REINFORCE_COOLDOWN_S))
        return { justBefore, exactly }
      })
    )
    expect(outcome.justBefore.bumped).toEqual([])
    // `>=`, matching the domain twin: a stamp exactly the window old IS bumpable.
    expect(outcome.exactly.bumped).toEqual(["areas/a.html"])
  })

  it("moves the outcome score by the EWMA only on a non-neutral signal", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* reinforce(db, ["areas/a.html"], "positive", iso(0))
        const afterPositive = yield* db.get<{ outcome_score: number; reinforcement_count: number }>(
          "SELECT outcome_score, reinforcement_count FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
        yield* reinforce(db, ["areas/a.html"], "neutral", iso(REINFORCE_COOLDOWN_S))
        const afterNeutral = yield* db.get<{ outcome_score: number; reinforcement_count: number }>(
          "SELECT outcome_score, reinforcement_count FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
        yield* reinforce(db, ["areas/a.html"], "negative", iso(REINFORCE_COOLDOWN_S * 2))
        const afterNegative = yield* db.get<{ outcome_score: number }>(
          "SELECT outcome_score FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
        return { afterPositive, afterNeutral, afterNegative }
      })
    )
    expect(outcome.afterPositive?.outcome_score).toBeCloseTo(1)
    expect(outcome.afterPositive?.reinforcement_count).toBe(1)
    expect(outcome.afterNeutral?.outcome_score).toBeCloseTo(1)
    expect(outcome.afterNeutral?.reinforcement_count).toBe(1)
    expect(outcome.afterNegative?.outcome_score).toBeCloseTo(
      1 * (1 - OUTCOME_EWMA_ALPHA) - OUTCOME_EWMA_ALPHA
    )
  })

  it("keeps the outcome score inside the column's range under repeated signals", async () => {
    const score = await withDb((db) =>
      Effect.gen(function* () {
        for (let step = 0; step < 30; step += 1) {
          yield* reinforce(db, ["areas/a.html"], "negative", iso(step * REINFORCE_COOLDOWN_S))
        }
        return yield* db.get<{ outcome_score: number }>(
          "SELECT outcome_score FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
      })
    )
    // The CHECK would refuse an out-of-range write, so the clamp has to be in the statement: 30 EWMA
    // steps toward -1 converge below it, and a driver rounding error must not fail the write.
    expect(score?.outcome_score).toBeGreaterThanOrEqual(-1)
    expect(score?.outcome_score).toBeLessThan(-0.9)
  })

  it("splits a mixed batch by each path's own cooldown", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* reinforce(db, ["areas/hot.html"], "neutral", iso(0))
        return yield* reinforce(
          db,
          ["areas/hot.html", "areas/cold.html", "areas/new.html"],
          "neutral",
          iso(60)
        )
      })
    )
    expect([...result.bumped].sort()).toEqual(["areas/cold.html", "areas/new.html"])
    expect(result.cooledDown).toEqual(["areas/hot.html"])
  })

  it("deduplicates a repeated path within one call rather than double-counting it", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const result = yield* reinforce(
          db,
          ["areas/a.html", "areas/a.html", "areas/a.html"],
          "neutral",
          iso(0)
        )
        const row = yield* db.get<{ access_count: number }>(
          "SELECT access_count FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
        return { result, row }
      })
    )
    expect(outcome.result.bumped).toEqual(["areas/a.html"])
    // Otherwise one call could inflate salience threefold, defeating the cooldown from inside.
    expect(outcome.row?.access_count).toBe(1)
  })

  it("reports everything as cooled down when no state plane is attached", async () => {
    const result = await withDbNoState((db) => reinforce(db, ["areas/a.html"], "positive", iso(0)))
    // There is nowhere to record the bump, so claiming one happened would be a lie the caller acts on.
    expect(result).toEqual({ bumped: [], cooledDown: ["areas/a.html"] })
  })

  it("treats an empty path list as a no-op", async () => {
    const result = await withDb((db) => reinforce(db, [], "positive", iso(0)))
    expect(result).toEqual({ bumped: [], cooledDown: [] })
  })
})

/**
 * The pin between the SQL guard and its pure twin.
 *
 * Both sides see the same stored stamp and the same "now", and they must agree on bumpability for
 * every offset — this is the property that makes the duplication safe rather than a seam waiting to
 * drift. The generator deliberately concentrates on the boundary: an off-by-one there is invisible to
 * a uniformly random offset and is exactly the mistake `>=` versus `>` produces.
 */
describe("the SQL guard agrees with domain.shouldBumpAccess", () => {
  it("agrees at every offset, boundary included", async () => {
    const offsets = await Effect.runPromise(
      Effect.sync(() =>
        fc.sample(
          fc.oneof(
            fc.constantFrom(
              0,
              1,
              REINFORCE_COOLDOWN_S - 2,
              REINFORCE_COOLDOWN_S - 1,
              REINFORCE_COOLDOWN_S,
              REINFORCE_COOLDOWN_S + 1,
              REINFORCE_COOLDOWN_S * 2
            ),
            fc.integer({ min: 0, max: REINFORCE_COOLDOWN_S * 3 })
          ),
          200
        )
      )
    )

    const disagreements = await withDb((db) =>
      Effect.gen(function* () {
        const found: Array<{ offset: number; sql: boolean; domain: boolean }> = []
        for (const [index, offset] of offsets.entries()) {
          const path = `areas/p${index}.html`
          const stored = iso(0)
          const now = iso(offset)
          yield* reinforce(db, [path], "neutral", stored)
          const result = yield* reinforce(db, [path], "neutral", now)
          const sql = result.bumped.length === 1
          const domain = shouldBumpAccess(new Date(stored), new Date(now))
          if (sql !== domain) found.push({ offset, sql, domain })
        }
        return found
      })
    )

    expect(disagreements).toEqual([])
  })

  it("agrees that an absent stamp is always bumpable", async () => {
    const outcome = await withDb((db) => reinforce(db, ["areas/fresh.html"], "neutral", iso(0)))
    expect(outcome.bumped).toEqual(["areas/fresh.html"])
    expect(shouldBumpAccess(undefined, new Date(iso(0)))).toBe(true)
  })
})

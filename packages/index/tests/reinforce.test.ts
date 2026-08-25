import { DEFAULT_EWMA_ALPHA, REINFORCE_COOLDOWN_S, shouldBumpAccess } from "@memhtml/domain"
import { Effect } from "effect"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { DatabaseShape, SqlValue } from "../src/database.js"
import { OUTCOME_EWMA_ALPHA, REINFORCE_PATH_BATCH, reinforce } from "../src/reinforce.js"
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

/**
 * The EWMA weight, on both sides of the seam.
 *
 * `@memhtml/domain`'s `DEFAULT_EWMA_ALPHA` is the fixed-point reference implementation the float SQL
 * here is checked against, and SQL cannot read a TypeScript constant, so the value is declared in both
 * packages. Each package pins its own to 0.3, and this side additionally pins the PAIR — so a fork of
 * either constant fails here rather than drifting the reference model off the shipped arithmetic.
 */
describe("the SQL alpha agrees with domain.DEFAULT_EWMA_ALPHA", () => {
  it("pins both to 0.3 and to each other", () => {
    expect(OUTCOME_EWMA_ALPHA).toBe(0.3)
    expect(OUTCOME_EWMA_ALPHA).toBe(DEFAULT_EWMA_ALPHA)
  })

  it("moves a stored score by exactly the shared weight", async () => {
    const score = await withDb((db) =>
      Effect.gen(function* () {
        yield* reinforce(db, ["areas/a.html"], "positive", iso(0))
        yield* reinforce(db, ["areas/a.html"], "negative", iso(REINFORCE_COOLDOWN_S))
        return yield* db.get<{ outcome_score: number }>(
          "SELECT outcome_score FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
      })
    )
    // The arithmetic the reference model computes on the grid, read off the real column.
    expect(score?.outcome_score).toBeCloseTo(1 * (1 - DEFAULT_EWMA_ALPHA) - DEFAULT_EWMA_ALPHA)
  })
})

/**
 * The SHAPE of the write, not only its result.
 *
 * A per-path statement and a batched one return the same `bumped` split, so a result-only assertion
 * passes either way — the difference is one round trip against N, which is the store-scaled per-op
 * term this package refuses everywhere else. These tests read the statements as issued.
 */
describe("reinforce batches its upsert", () => {
  interface Issued {
    readonly sql: string
    readonly params: ReadonlyArray<SqlValue>
  }

  /** Records the access upserts passing through, and nothing else. */
  const spyOn = (
    db: DatabaseShape
  ): { readonly db: DatabaseShape; readonly issued: Array<Issued> } => {
    const issued: Array<Issued> = []
    return {
      issued,
      db: {
        ...db,
        all: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) => {
          if (sql.includes("INSERT INTO state.access")) issued.push({ sql, params: [...params] })
          return db.all<A>(sql, params)
        }
      }
    }
  }

  it("asks once for a whole batch, with every path bound", async () => {
    const paths = Array.from({ length: 40 }, (_, at) => `areas/p${String(at)}.html`)
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const spy = spyOn(db)
        const result = yield* reinforce(spy.db, paths, "positive", iso(0))
        const rows = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM state.access")
        return { result, issued: [...spy.issued], rows: rows?.n }
      })
    )

    expect(outcome.result.bumped).toEqual(paths)
    expect(outcome.rows).toBe(40)
    // ONE statement for forty paths — this is the assertion that fails on a per-path loop.
    expect(outcome.issued).toHaveLength(1)
    // Five shared values then the paths, all bound: none of them appears in the SQL text.
    expect(outcome.issued[0]?.params).toEqual([
      iso(0),
      1,
      1,
      OUTCOME_EWMA_ALPHA,
      REINFORCE_COOLDOWN_S,
      ...paths
    ])
    for (const path of paths) expect(outcome.issued[0]?.sql).not.toContain(path)
  })

  it("splits a batch wider than the bind ceiling", async () => {
    const paths = Array.from(
      { length: REINFORCE_PATH_BATCH + 1 },
      (_, at) => `areas/p${String(at).padStart(6, "0")}.html`
    )
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const spy = spyOn(db)
        const result = yield* reinforce(spy.db, paths, "neutral", iso(0))
        return { result, issued: [...spy.issued] }
      })
    )

    expect(outcome.result.bumped).toHaveLength(REINFORCE_PATH_BATCH + 1)
    expect(outcome.issued).toHaveLength(2)
    // Five shared values on each statement; no statement binds more paths than the ceiling.
    expect(outcome.issued.map((one) => one.params.length - 5)).toEqual([REINFORCE_PATH_BATCH, 1])
  })

  /**
   * The per-row decision inside ONE statement, which is what a multi-row upsert has to preserve. A
   * batch mixing cooling-down and bumpable paths must split exactly as N separate statements would,
   * and every row is decided against its OWN stored stamp rather than the batch's.
   */
  it("decides each path in the batch on its own stamp", async () => {
    const hot = Array.from({ length: 5 }, (_, at) => `areas/hot${String(at)}.html`)
    const cold = Array.from({ length: 5 }, (_, at) => `areas/cold${String(at)}.html`)
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const spy = spyOn(db)
        /** The neighbours' rows: reinforced recently, so they are inside the window. */
        yield* reinforce(db, hot, "positive", iso(0))
        spy.issued.length = 0
        const result = yield* reinforce(spy.db, [...hot, ...cold], "positive", iso(60))
        const rows = yield* db.all<{ path: string; access_count: number }>(
          "SELECT path, access_count FROM state.access ORDER BY path"
        )
        return { result, issued: spy.issued.length, rows }
      })
    )

    expect(outcome.issued).toBe(1)
    expect([...outcome.result.bumped].sort()).toEqual([...cold].sort())
    expect([...outcome.result.cooledDown].sort()).toEqual([...hot].sort())
    // Every hot row is untouched at 1, every cold row is new at 1 — no row took the batch's verdict.
    expect(outcome.rows.filter((row) => row.access_count !== 1)).toEqual([])
    expect(outcome.rows).toHaveLength(10)
  })
})

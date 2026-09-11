import { DatabaseService, RetrievalPolicy } from "@memhtml/cli"
import type { DatabaseShape } from "@memhtml/index"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { indexReport, traceSessionsFlag } from "../src/views.js"

/**
 * The `--trace-sessions` validation (issue #99). The refusal arm is the one worth pinning: the
 * value becomes a SQL `LIMIT`, where SQLite reads a negative as NO limit, so an accepted `-1`
 * would hand the consolidator the whole unconsolidated backlog in one turn.
 */
describe("traceSessionsFlag", () => {
  const outcome = (raw: number | undefined) => Effect.runSync(Effect.result(traceSessionsFlag(raw)))

  it("passes absence through as absence", () => {
    const result = outcome(undefined)
    expect(Result.isSuccess(result) && result.success).toBe(undefined)
  })

  it("accepts a positive integer unchanged", () => {
    const result = outcome(3)
    expect(Result.isSuccess(result) && result.success).toBe(3)
  })

  it.each([0, -1, 2.5])("refuses %s rather than clamping it", (raw) => {
    const result = outcome(raw)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toContain("--trace-sessions")
    }
  })
})

/**
 * A count the query could not read is `null`, never `0`: zero is a real, healthy answer for an
 * empty corpus, and a caller reading `files: 0` on a database the query could not open was just
 * told the corpus is empty. `degraded: true` names the state, and the watermark read failing sets
 * it too — `headSha: null` from a failed read is indistinguishable from "no row yet" without it.
 */
describe("indexReport degrades a failed read honestly", () => {
  const failingDb = {
    hasState: false,
    get: () => Effect.fail(new Error("database is locked")),
    all: () => Effect.fail(new Error("database is locked")),
    run: () => Effect.fail(new Error("database is locked"))
  } as unknown as DatabaseShape

  it("reports null counts and degraded: true when every read fails", async () => {
    const report = await Effect.runPromise(
      indexReport().pipe(
        Effect.provideService(DatabaseService, failingDb),
        Effect.provideService(RetrievalPolicy, { vectorCoverageFloor: 0.5 })
      )
    )
    expect(report.degraded).toBe(true)
    expect(report.files).toBeNull()
    expect(report.edges).toBeNull()
    expect(report.headSha).toBeNull()
  })
})

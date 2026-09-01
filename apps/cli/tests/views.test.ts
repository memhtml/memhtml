import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { traceSessionsFlag } from "../src/views.js"

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

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { readIndexState } from "../src/index-state.js"
import { INDEX_STATE_ID } from "../src/schema-const.js"
import { withDb } from "./harness.js"

/**
 * The `index_state` read, against the shipped migrations and the shipped driver.
 *
 * These cases are about the difference between DECODING a row and casting one, and the difference is
 * narrower than it first looks — which is why the reachable states are probed here rather than
 * assumed. SQLite has type AFFINITY, not type enforcement, and affinity does most of the work for
 * free: probed 2026-08-12 on node 24.19.0 (SQLite 3.53.3), `'1024'` into an `INTEGER` column is
 * converted and stored as the integer `1024`, and an integer into a `TEXT` column is stored as
 * `'1024'`. So the sloppy cases a cast would mishandle mostly cannot arise.
 *
 * Two can, and they are what these cases lock:
 *   - a TEXT value affinity CANNOT convert (`'1024px'`) stays TEXT, and the column's own
 *     `CHECK (embed_dim > 0)` does not stop it, because SQLite orders every INTEGER below every TEXT
 *     so the comparison is true;
 *   - `'12.5'` is converted to the REAL `12.5` and stored, since affinity only declines a lossy
 *     integer conversion.
 *
 * Both reach the model guard's `!==` against a configured number, where a string or a fraction never
 * compares equal and the indexer refuses every write against a perfectly good vector space. No test
 * can catch either through a cast, because the cast is the thing being trusted.
 */

const insertState = (embedDim: string) => `INSERT INTO index_state
  (id, head_sha, embed_model, embed_dim, rebuilt_at, updated_at)
  VALUES (${INDEX_STATE_ID}, 'abc123', 'cohere.embed-v4:0@1024', ${embedDim},
    '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')`

/** Insert a row, report what SQLite actually stored, and report what the read makes of it. */
const readWith = (embedDim: string) =>
  withDb((db) =>
    Effect.gen(function* () {
      yield* db.run(insertState(embedDim))
      const raw = yield* db.get<{ t: string }>("SELECT typeof(embed_dim) AS t FROM index_state")
      return { stored: raw?.t, result: yield* Effect.result(readIndexState(db)) }
    })
  )

describe("readIndexState", () => {
  it("is undefined before the first rebuild, rather than an error", async () => {
    // "Never indexed" is a state, not a failure — the two report paths render it and the indexer
    // refuses on it, so the read hands both of them the same absence.
    expect(await withDb((db) => readIndexState(db))).toBeUndefined()
  })

  it("decodes the whole watermark row, with embed_dim a number", async () => {
    const state = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run(insertState("1024"))
        return yield* readIndexState(db)
      })
    )
    expect(state).toEqual({
      id: INDEX_STATE_ID,
      head_sha: "abc123",
      embed_model: "cohere.embed-v4:0@1024",
      embed_dim: 1024,
      rebuilt_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    })
    expect(typeof state?.embed_dim).toBe("number")
  })

  it("accepts a numeric string, because INTEGER affinity already converted it", async () => {
    // Stated so the next reader knows the decode is not doing this part: `'1024'` never reaches it
    // as a string. A test asserting a refusal here would be asserting against the driver.
    const outcome = await readWith("'1024'")
    expect(outcome.stored).toBe("integer")
    expect(outcome.result._tag).toBe("Success")
  })

  it("REFUSES TEXT that affinity could not convert, which the column's CHECK lets through", async () => {
    const outcome = await readWith("'1024px'")
    // The premise: SQLite really kept the string, so there is something to catch.
    expect(outcome.stored).toBe("text")
    expect(outcome.result._tag).toBe("Failure")
    if (outcome.result._tag === "Failure") {
      expect(outcome.result.failure).toBeInstanceOf(StorageFailure)
      expect(outcome.result.failure.operation).toBe("index_state.decode")
    }
  })

  it("REFUSES a fractional dimension, which the column cannot express and CHECK cannot see", async () => {
    // `CHECK (embed_dim > 0)` is satisfied by 12.5. A dimension is a count of floats, so the schema
    // is the only place this can be rejected.
    const outcome = await readWith("'12.5'")
    expect(outcome.stored).toBe("real")
    expect(outcome.result._tag).toBe("Failure")
    if (outcome.result._tag === "Failure") {
      expect(outcome.result.failure.operation).toBe("index_state.decode")
    }
  })
})

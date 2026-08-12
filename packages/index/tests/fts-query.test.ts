import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { hasFtsTerms, sanitizeFtsQuery } from "../src/fts-query.js"
import { FTS_INDEX_NAME } from "../src/schema-const.js"
import { withDb } from "./harness.js"

/**
 * The sanitizer, and the driver behavior that makes it necessary.
 *
 * The second suite here is the regression lock: it runs each hazard through the REAL driver, first
 * raw (proving it is a hard error and not an empty result) and then sanitized (proving the fix). A
 * unit test on the sanitizer alone would pass just as well against a driver that tolerated
 * apostrophes, so it would not be a lock on anything.
 */

describe("sanitizeFtsQuery", () => {
  it("keeps ordinary prose as its own terms, lowercased", () => {
    expect(sanitizeFtsQuery("Drain the VIP before reverting")).toBe(
      "drain the vip before reverting"
    )
  })

  it("splits an apostrophe rather than passing it to the parser", () => {
    // Raw `don't` is "Syntax Error: don't" on this driver — an ordinary word in ordinary prose.
    expect(sanitizeFtsQuery("don't drain")).toBe("don t drain")
  })

  it("splits a type:name entity reference, which the parser reads as a field selector", () => {
    // Raw `service:checkout-api` is "Field does not exist: 'service'", and `type:name` is the
    // system's own entity notation, so an agent will type it.
    expect(sanitizeFtsQuery("service:checkout-api")).toBe("service checkout api")
  })

  it("drops a leading hyphen, which the parser reads as negation", () => {
    expect(sanitizeFtsQuery("-zebra")).toBe("zebra")
    expect(sanitizeFtsQuery("zebra -giraffe")).toBe("zebra giraffe")
  })

  it("keeps diacritics as one token rather than ASCII-folding them", () => {
    // Folding here would make `déployé` unmatchable against a corpus that stores the diacritics.
    expect(sanitizeFtsQuery("déployé café")).toBe("déployé café")
  })

  it("keeps non-Latin scripts", () => {
    expect(sanitizeFtsQuery("日本語 memory")).toBe("日本語 memory")
  })

  it("collapses runs of separators to one space", () => {
    expect(sanitizeFtsQuery("a  b\t\tc\n\nd")).toBe("a b c d")
  })

  it("returns the empty string for a query with no indexable term", () => {
    for (const query of ["", "   ", "!!! ???", "-", "--", "\\", "%", "*", "..."]) {
      expect(sanitizeFtsQuery(query), `expected no terms from ${JSON.stringify(query)}`).toBe("")
      expect(hasFtsTerms(query)).toBe(false)
    }
  })

  it("is idempotent, so a doubly-sanitized query is unchanged", () => {
    const once = sanitizeFtsQuery("service:checkout-api don't -- 50%")
    expect(sanitizeFtsQuery(once)).toBe(once)
  })
})

/** The corpus the driver-level assertions MATCH against. */
const seed = (db: Parameters<Parameters<typeof withDb>[0]>[0]) =>
  Effect.gen(function* () {
    yield* db.writeAll([
      {
        sql: `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist,
                fts_text, disclosure_text, para, created_at, updated_at, indexed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          "areas/oncall/a.html",
          "sha-a",
          "sha256:aaa",
          "procedural",
          "Drain the VIP",
          "the service checkout api rollback does not drain",
          "drain first",
          "Drain the VIP\ndrain first\nthe service checkout api rollback does not drain",
          "drain first",
          "areas",
          "2026-08-01T00:00:00Z",
          "2026-08-01T00:00:00Z",
          "2026-08-01T00:00:00Z"
        ]
      }
    ])
  })

/** MATCH one raw string, reporting whether the driver accepted it. */
const matchRaw = (db: Parameters<Parameters<typeof withDb>[0]>[0], query: string) =>
  Effect.result(
    db.all<{ path: string }>(
      `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
       JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
       WHERE ${FTS_INDEX_NAME} MATCH ? AND files.archived = 0 LIMIT 5`,
      [query]
    )
  )

describe("the driver hazards the sanitizer exists for", () => {
  /**
   * Probed live 2026-08-12 on node 24.19.0 (SQLite 3.53.3). Each of these FAILS the statement rather
   * than returning no rows, and every one of them is a form an agent writes without meaning anything
   * by it.
   */
  const hazards = [
    "don't",
    "service:checkout-api",
    "checkout-api",
    "-zebra",
    "!!! ???",
    "-",
    "--",
    "AND",
    "OR",
    "a OR",
    "NEAR(a b",
    '"unbalanced',
    "[x]",
    "{x}",
    "\\"
  ]

  /**
   * Forms FTS5 ACCEPTS, which the sanitizer normalizes anyway.
   *
   * `zebra*` is a prefix search, `^x` anchors to a column's first token, and lowercase `and` is an
   * ordinary term where `AND` is a keyword. None of them throws, so none is a hazard — they are here
   * because a query that silently means something other than its words is its own bug, and because
   * the sanitizer's docstring claims it flattens them.
   */
  const tolerated = ["zebra*", "^x", "and", "NEAR"]

  it("rejects each hazard raw, and accepts every one of them sanitized", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db)
        const results: Array<{ query: string; rawFailed: boolean; sanitizedOk: boolean }> = []
        for (const query of hazards) {
          const raw = yield* matchRaw(db, query)
          const safe = sanitizeFtsQuery(query)
          const sanitized = safe === "" ? undefined : yield* matchRaw(db, safe)
          results.push({
            query,
            rawFailed: Result.isFailure(raw),
            // A no-term query is not run at all — the arm leaves the fold — so it counts as handled.
            sanitizedOk: sanitized === undefined || Result.isSuccess(sanitized)
          })
        }
        return results
      })
    )

    const survived = outcome.filter((entry) => !entry.rawFailed).map((entry) => entry.query)
    // If this ever shrinks, FTS5 got more tolerant and the sanitizer is now belt-and-braces — which is
    // fine, but the docstring's hazard list is then stale and should be re-probed.
    expect(survived).toEqual([])
    expect(outcome.every((entry) => entry.sanitizedOk)).toBe(true)
  })

  it("flattens the operator forms FTS5 would have accepted, so a query means its words", () => {
    // Asserted on the sanitizer alone: these never reach MATCH in operator form.
    expect(tolerated.map(sanitizeFtsQuery)).toEqual(["zebra", "x", "and", "near"])
  })

  it("still finds the row through a sanitized entity reference", async () => {
    const paths = await withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db)
        const rows = yield* db.all<{ path: string }>(
          `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
           JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
           WHERE ${FTS_INDEX_NAME} MATCH ? AND files.archived = 0 LIMIT 5`,
          [sanitizeFtsQuery("service:checkout-api")]
        )
        return rows.map((row) => row.path)
      })
    )
    // The colon was a field selector and a hard error; split into terms it is a working query.
    expect(paths).toEqual(["areas/oncall/a.html"])
  })

  it("REFUSES an empty MATCH, which is why a term-free query must drop the arm, not bind it", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db)
        return yield* matchRaw(db, "")
      })
    )
    /**
     * `fts5: syntax error near ""`. So `sanitizeFtsQuery` returning `""` cannot be forwarded to MATCH:
     * the lexical arm has to leave the fold entirely (`hasQueryTerms` in the assembler, `matched` in
     * `searchTraces`). A caller that bound the sanitized text unconditionally would turn every
     * punctuation-only query into a storage failure — the exact outcome this module prevents.
     */
    expect(Result.isFailure(outcome)).toBe(true)
  })
})

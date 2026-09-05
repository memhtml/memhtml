import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { ftsQueryForms, hasFtsTerms, sanitizeFtsQuery } from "../src/fts-query.js"
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
  it("keeps ordinary prose as its own terms, lowercased and joined with OR", () => {
    // Space-separated terms are an implicit AND to FTS5, which returns a file only when it holds
    // every one of them. OR lets bm25 rank any file holding any of them, most-of-them first.
    expect(sanitizeFtsQuery("Drain the VIP before reverting")).toBe(
      "drain OR the OR vip OR before OR reverting"
    )
  })

  it("reads a sentence as any-of, so one proper noun is enough to match", () => {
    expect(sanitizeFtsQuery("orion wants talk")).toBe("orion OR wants OR talk")
  })

  it("splits an apostrophe rather than passing it to the parser", () => {
    // Raw `don't` is "Syntax Error: don't" on this driver — an ordinary word in ordinary prose.
    expect(sanitizeFtsQuery("don't drain")).toBe("don OR t OR drain")
  })

  it("splits a type:name entity reference, which the parser reads as a field selector", () => {
    // Raw `service:checkout-api` is "Field does not exist: 'service'", and `type:name` is the
    // system's own entity notation, so an agent will type it.
    expect(sanitizeFtsQuery("service:checkout-api")).toBe("service OR checkout OR api")
  })

  it("drops a leading hyphen, which the parser reads as negation", () => {
    expect(sanitizeFtsQuery("-zebra")).toBe("zebra")
    expect(sanitizeFtsQuery("zebra -giraffe")).toBe("zebra OR giraffe")
  })

  it("keeps diacritics as one token rather than ASCII-folding them", () => {
    // Folding here would make `déployé` unmatchable against a corpus that stores the diacritics.
    expect(sanitizeFtsQuery("déployé café")).toBe("déployé OR café")
  })

  it("keeps non-Latin scripts", () => {
    expect(sanitizeFtsQuery("日本語 memory")).toBe("日本語 OR memory")
  })

  it("collapses runs of separators to one OR", () => {
    expect(sanitizeFtsQuery("a  b\t\tc\n\nd")).toBe("a OR b OR c OR d")
  })

  it("returns the empty string for a query with no indexable term", () => {
    for (const query of ["", "   ", "!!! ???", "-", "--", "\\", "%", "*", "..."]) {
      expect(sanitizeFtsQuery(query), `expected no terms from ${JSON.stringify(query)}`).toBe("")
      expect(hasFtsTerms(query)).toBe(false)
    }
  })

  it("turns a caller's own OR into an ordinary term, so prose never reaches the parser as an operator", () => {
    // Uppercase OR is the keyword and lowercase or is a word. The sanitizer emits the keyword itself
    // and lowercases everything the caller wrote, so the two cannot be confused.
    expect(sanitizeFtsQuery("a OR b")).toBe("a OR or OR b")
    expect(sanitizeFtsQuery("OR")).toBe("or")
  })

  it("keeps a double-quoted span as one phrase, sanitized inside like everywhere else", () => {
    expect(sanitizeFtsQuery('find "drain the VIP" fast')).toBe('find OR "drain the vip" OR fast')
    // The apostrophe splits inside the quotes exactly as it does outside them.
    expect(sanitizeFtsQuery('"don\'t drain"')).toBe('"don t drain"')
    // A quoted operator is a literal: `"or"` is a phrase of one ordinary word.
    expect(sanitizeFtsQuery('"OR"')).toBe('"or"')
    expect(sanitizeFtsQuery('"orion" "standup slot"')).toBe('"orion" OR "standup slot"')
  })

  it("treats an unbalanced quote as no quote, and an empty pair as no term", () => {
    expect(sanitizeFtsQuery('find "drain the vip')).toBe("find OR drain OR the OR vip")
    expect(sanitizeFtsQuery('orion "')).toBe("orion")
    expect(sanitizeFtsQuery('""')).toBe("")
    expect(hasFtsTerms('""')).toBe(false)
    expect(sanitizeFtsQuery('"" orion')).toBe("orion")
    // Only a quoted operator inside: still a literal phrase, never the keyword.
    expect(sanitizeFtsQuery('"AND"')).toBe('"and"')
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

  it("is accepted by the driver once sanitized, and again when its own output is sanitized", async () => {
    /**
     * The OR keyword makes a second pass produce a different string (`or` becomes a term), so the
     * property that holds is acceptance rather than identity: whatever the sanitizer emits, and
     * whatever it emits when fed its own output, is a MATCH the driver runs.
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seed(db)
        const once = sanitizeFtsQuery('service:checkout-api don\'t -- 50% "drain the VIP"')
        const twice = sanitizeFtsQuery(once)
        return {
          once,
          twice,
          onceOk: Result.isSuccess(yield* matchRaw(db, once)),
          twiceOk: Result.isSuccess(yield* matchRaw(db, twice))
        }
      })
    )
    expect(outcome.once).toBe('service OR checkout OR api OR don OR t OR 50 OR "drain the vip"')
    expect(outcome.twice).not.toBe(outcome.once)
    expect(outcome.onceOk).toBe(true)
    expect(outcome.twiceOk).toBe(true)
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

/**
 * A few files where exactly one carries the proper noun `orion`, in its title and its body, and the
 * others share none of a natural-language sentence's words with it.
 */
const seedNouns = (db: Parameters<Parameters<typeof withDb>[0]>[0]) =>
  Effect.gen(function* () {
    const row = (path: string, title: string, body: string) => ({
      sql: `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist,
              fts_text, disclosure_text, para, created_at, updated_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        path,
        `sha-${path}`,
        `sha256:${path}`,
        "semantic",
        title,
        body,
        title,
        `${title}\n${title}\n${body}`,
        title,
        "areas",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z"
      ]
    })
    yield* db.writeAll([
      row(
        "areas/team/orion.html",
        "Orion keeps the standup slot",
        "orion runs the standup and keeps its notes"
      ),
      row(
        "areas/oncall/pager.html",
        "The deploy pipeline pages the oncall",
        "a failed deploy pages whoever holds the pager"
      ),
      row(
        "areas/checkout/cache.html",
        "The checkout api caches sessions",
        "the checkout api caches its sessions for an hour"
      )
    ])
  })

/** The lexical arm's own statement shape: MATCH the sanitized text, best bm25 first. */
const matchRanked = (db: Parameters<Parameters<typeof withDb>[0]>[0], query: string) =>
  db.all<{ path: string }>(
    `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
     JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
     WHERE ${FTS_INDEX_NAME} MATCH ? AND files.archived = 0
     ORDER BY bm25(${FTS_INDEX_NAME})
     LIMIT 10`,
    [sanitizeFtsQuery(query)]
  )

describe("a natural-language sentence over the lexical arm", () => {
  it("finds the file carrying the one proper noun a sentence names, though its other words match nothing", async () => {
    const paths = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedNouns(db)
        const rows = yield* matchRanked(db, "orion wants talk")
        return rows.map((row) => row.path)
      })
    )
    /**
     * FTS5 reads space-separated terms as AND, so a sanitizer that joins tokens with spaces returns
     * this sentence NOTHING: no file holds `wants` or `talk`. The arm has to read the sentence as
     * any-of and let bm25 rank, or every query longer than a verbatim quote gets zero lexical hits.
     */
    expect(paths).toEqual(["areas/team/orion.html"])
  })

  it("keeps a quoted phrase adjacent, so a caller can still demand word order", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedNouns(db)
        const inOrder = yield* matchRanked(db, '"checkout api caches"')
        const outOfOrder = yield* matchRanked(db, '"caches checkout api"')
        return {
          inOrder: inOrder.map((row) => row.path),
          outOfOrder: outOfOrder.map((row) => row.path)
        }
      })
    )
    expect(outcome.inOrder).toEqual(["areas/checkout/cache.html"])
    // The same three words in another order match nothing as a phrase, which is what makes the
    // quotes a demand for adjacency rather than decoration the sanitizer strips.
    expect(outcome.outOfOrder).toEqual([])
  })

  /**
   * Quoting and operator forms that the sanitizer's OR join and phrase handling must never turn into
   * a driver error. Each is run sanitized through the real driver; a form that sanitizes to `""` is
   * dropped by the caller and counts as handled.
   */
  const forms = [
    "OR",
    "OR OR",
    "AND OR NOT",
    '"unbalanced',
    'orion "unbalanced',
    '""',
    '"OR"',
    '"AND NOT"',
    '"don\'t drain"',
    "the and of to",
    '"" orion',
    '"orion" "standup"',
    'a "b'
  ]

  it("emits a MATCH the driver accepts for every quoting and operator form, in BOTH forms, or none", async () => {
    // The all-terms form reaches the driver too, since the lexical arm binds it whenever some file
    // holds every term, so a phrase inside an AND join has to be as acceptable as inside an OR join.
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedNouns(db)
        const results: Array<{
          query: string
          sanitized: string
          anyAccepted: boolean
          allAccepted: boolean
        }> = []
        for (const query of forms) {
          const { all, any } = ftsQueryForms(query)
          const anyProbe = any === "" ? undefined : yield* matchRaw(db, any)
          const allProbe = all === "" ? undefined : yield* matchRaw(db, all)
          results.push({
            query,
            sanitized: any,
            anyAccepted: anyProbe === undefined || Result.isSuccess(anyProbe),
            allAccepted: allProbe === undefined || Result.isSuccess(allProbe)
          })
        }
        return results
      })
    )
    const rejected = outcome.filter((entry) => !entry.anyAccepted || !entry.allAccepted)
    expect(rejected, JSON.stringify(rejected)).toEqual([])
    // `hasFtsTerms`, `sanitizeFtsQuery`, and the two forms agree on which queries carry a term at all.
    for (const entry of outcome) {
      expect(sanitizeFtsQuery(entry.query)).toBe(entry.sanitized)
      expect(hasFtsTerms(entry.query)).toBe(entry.sanitized !== "")
      expect(ftsQueryForms(entry.query).all === "").toBe(entry.sanitized === "")
    }
  })
})

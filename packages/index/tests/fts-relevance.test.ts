import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { Write } from "../src/database.js"
import { FTS_INDEX_NAME } from "../src/schema-const.js"
import { withDb } from "./harness.js"

/**
 * The lexical arm's two load-bearing properties: it ranks by `bm25()`, and its index stays in step
 * with the corpus through triggers.
 *
 * Both are worth locking because both fail QUIETLY. A bm25 sign error still returns a ranked list, in
 * exactly the wrong order. A missing trigger still answers MATCH, from rows the corpus has since
 * changed — and `files_fts` is EXTERNAL CONTENT, which does not observe its content table on its own,
 * so nothing but the triggers keeps it honest.
 *
 * The schema carries ONE denormalized `fts_text` column so a term is found wherever it was authored;
 * the title-only test is what proves that, and it would fail against a per-field index.
 */

/**
 * Build the writes for `count` rows where every 7th is term-dense, so relevance order and rowid order
 * disagree. The caller applies them, because the disagreement is the whole point of the fixture and
 * hiding the `writeAll` inside here would make the seeding order invisible to the test that depends
 * on it.
 */
const seedRelevanceCorpus = (count: number) => {
  const dense = new Set<string>()
  const writes: Array<Write> = []
  for (let index = 0; index < count; index += 1) {
    const path = `areas/notes/p${String(index).padStart(3, "0")}.html`
    const isDense = index % 7 === 0
    if (isDense) dense.add(path)
    const body = isDense
      ? "zebra zebra zebra zebra zebra zebra a densely repeating claim"
      : index % 3 === 0
        ? "zebra mentioned once among other filler words"
        : "no matching term at all here, only filler"
    writes.push({
      sql: `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist,
              fts_text, disclosure_text, para, created_at, updated_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        path,
        `sha-${index}`,
        `sha256:${index}`,
        "semantic",
        `Entry ${index}`,
        body,
        "claim",
        `Entry ${index}\nclaim\n${body}`,
        "claim",
        "areas",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-08-01T00:00:00Z"
      ]
    })
  }
  return { dense, writes }
}

describe("the single-column FTS5 index", () => {
  it("returns term-dense rows first, ahead of rows that merely contain the term", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const { dense, writes } = seedRelevanceCorpus(140)
        yield* db.writeAll(writes)
        const rows = yield* db.all<{ path: string; rank: number }>(
          `SELECT path, ROW_NUMBER() OVER () AS rank FROM (
             SELECT files.path AS path FROM ${FTS_INDEX_NAME}
             JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
             WHERE ${FTS_INDEX_NAME} MATCH ? AND files.archived = 0
             ORDER BY bm25(${FTS_INDEX_NAME})
             LIMIT ?
           )`,
          ["zebra", 40]
        )
        return { dense: [...dense].sort(), rows }
      })
    )

    const top = outcome.rows.slice(0, outcome.dense.length).map((row) => row.path)
    // Every dense row outranks every single-mention row. This is what `ORDER BY bm25` buys: seeded in
    // rowid order, the dense rows are every 7th, so rowid order would interleave them.
    expect(top.sort()).toEqual(outcome.dense)
    // The window numbers the ranked order it was given, 1-based and gapless.
    expect(outcome.rows.map((row) => row.rank)).toEqual(outcome.rows.map((_, offset) => offset + 1))
  })

  it("scores bm25 negative-is-better, which is why the arm orders ASCENDING", async () => {
    /**
     * The sign convention, asserted directly. An `ORDER BY bm25(...) DESC` would return a
     * plausible-looking ranked list with the least relevant row first, and every test that only
     * checks membership would pass. This is the one that would not.
     */
    const scores = await withDb((db) =>
      Effect.gen(function* () {
        const { dense, writes } = seedRelevanceCorpus(140)
        yield* db.writeAll(writes)
        const rows = yield* db.all<{ path: string; score: number }>(
          `SELECT files.path AS path, bm25(${FTS_INDEX_NAME}) AS score FROM ${FTS_INDEX_NAME}
           JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
           WHERE ${FTS_INDEX_NAME} MATCH ?`,
          ["zebra"]
        )
        const denseScores = rows.filter((row) => dense.has(row.path)).map((row) => row.score)
        const sparseScores = rows.filter((row) => !dense.has(row.path)).map((row) => row.score)
        return { denseScores, sparseScores }
      })
    )

    expect(scores.denseScores.length).toBeGreaterThan(0)
    expect(scores.sparseScores.length).toBeGreaterThan(0)
    // Every score is negative, and the dense rows are MORE negative than the sparse ones.
    expect(scores.denseScores.every((score) => score < 0)).toBe(true)
    expect(Math.max(...scores.denseScores)).toBeLessThan(Math.min(...scores.sparseScores))
  })

  it("finds a term that lives only in the title, because the column carries the title too", async () => {
    const paths = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.writeAll([
          {
            sql: `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text,
                    gist, fts_text, disclosure_text, para, created_at, updated_at, indexed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              "areas/notes/a.html",
              "sha-a",
              "sha256:a",
              "semantic",
              "Wildebeest migration patterns",
              "the body says nothing about that animal",
              "a claim",
              "Wildebeest migration patterns\na claim\nthe body says nothing about that animal",
              "a claim",
              "areas",
              "2026-08-01T00:00:00Z",
              "2026-08-01T00:00:00Z",
              "2026-08-01T00:00:00Z"
            ]
          }
        ])
        const rows = yield* db.all<{ path: string }>(
          `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
           JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
           WHERE ${FTS_INDEX_NAME} MATCH ?`,
          ["wildebeest"]
        )
        return rows.map((row) => row.path)
      })
    )
    // Denormalizing is what makes a title-only term findable: one column, so one MATCH reaches the
    // title, the gist, and the body alike.
    expect(paths).toEqual(["areas/notes/a.html"])
  })

  it("drops a stale term and finds the new one immediately after an update", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.writeAll([
          {
            sql: `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text,
                    gist, fts_text, disclosure_text, para, created_at, updated_at, indexed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              "areas/notes/a.html",
              "sha-a",
              "sha256:a",
              "semantic",
              "T",
              "zebra body",
              "c",
              "T\nc\nzebra body",
              "c",
              "areas",
              "2026-08-01T00:00:00Z",
              "2026-08-01T00:00:00Z",
              "2026-08-01T00:00:00Z"
            ]
          }
        ])
        yield* db.run("UPDATE files SET fts_text = ? WHERE path = ?", [
          "T\nc\ngiraffe body",
          "areas/notes/a.html"
        ])
        const matching = (term: string) =>
          db.all<{ path: string }>(
            `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
             JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
             WHERE ${FTS_INDEX_NAME} MATCH ?`,
            [term]
          )
        const stale = yield* matching("zebra")
        const fresh = yield* matching("giraffe")
        return { stale: stale.length, fresh: fresh.length }
      })
    )
    // The update trigger unindexes the old terms and indexes the new ones in the same transaction as
    // the row, so an incremental re-index needs no separate FTS pass. Without that trigger `stale`
    // would still be 1: external-content FTS5 does not observe its content table.
    expect(outcome).toEqual({ stale: 0, fresh: 1 })
  })
})

/**
 * The delete half of the trigger contract, which the update test cannot reach.
 *
 * A deleted row must leave the index, and the delete trigger has to pass FTS5 the row's OLD text to
 * unindex the right terms. Handing it the wrong text does not raise — it corrupts the index quietly,
 * leaving terms behind that match a row the corpus no longer has. This is the test that catches a
 * removed or mis-written `files_fts_delete`.
 */
describe("the delete trigger", () => {
  it("unindexes a removed row, so MATCH stops finding a path the corpus dropped", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const { writes } = seedRelevanceCorpus(20)
        yield* db.writeAll(writes)
        const target = "areas/notes/p000.html"
        const before = yield* db.all<{ path: string }>(
          `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
           JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
           WHERE ${FTS_INDEX_NAME} MATCH ?`,
          ["zebra"]
        )
        yield* db.run("DELETE FROM files WHERE path = ?", [target])
        const after = yield* db.all<{ path: string }>(
          `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
           JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
           WHERE ${FTS_INDEX_NAME} MATCH ?`,
          ["zebra"]
        )
        /**
         * Counted from the index itself, not through the join. The join would hide a leak: an orphan
         * FTS row whose rowid no longer exists in `files` drops out of an inner join silently, so a
         * corrupt index and a clean one look identical from the outside.
         */
        const indexed = yield* db.get<{ n: number }>(
          `SELECT count(*) AS n FROM ${FTS_INDEX_NAME} WHERE ${FTS_INDEX_NAME} MATCH ?`,
          ["zebra"]
        )
        return {
          hadTarget: before.some((row) => row.path === target),
          keepsTarget: after.some((row) => row.path === target),
          joined: after.length,
          indexed: indexed?.n ?? -1
        }
      })
    )

    expect(outcome.hadTarget).toBe(true)
    expect(outcome.keepsTarget).toBe(false)
    // The index holds exactly what the join returns: no orphan row left behind for the deleted path.
    expect(outcome.indexed).toBe(outcome.joined)
  })
})

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { Write } from "../src/database.js"
import { FTS_COLUMN } from "../src/schema-const.js"
import { withDb } from "./harness.js"

/**
 * The regression lock on the single-column FTS decision.
 *
 * `docs/design.md`'s probe note says MATCH on any indexed column searches the whole index and that
 * MATCH returns rows in relevance order. Re-probed 2026-08-02 on @tursodatabase/database 0.7.2, BOTH
 * halves are false under a MULTI-column index:
 *
 * - MATCH is scoped to the named column alone — a term living in `title` is not found by
 *   `body_text MATCH`.
 * - the rows come back in ROWID order, not relevance order.
 *
 * That matters because this driver exposes no `rank` column and no `bm25()`, so MATCH's own row order
 * is the entire relevance signal, and the FTS arm's rank is `ROW_NUMBER() OVER ()` over it. Under a
 * multi-column index the lexical arm silently degrades to "any row containing the term, oldest first"
 * — a green test suite and a broken ranking.
 *
 * So the schema carries ONE denormalized `fts_text` column. These tests prove the property that
 * decision buys, and the second one builds a multi-column index on a scratch table to show the
 * failure is real rather than remembered.
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

describe("the single-column FTS index", () => {
  it("returns term-dense rows first, ahead of rows that merely contain the term", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const { dense, writes } = seedRelevanceCorpus(140)
        yield* db.writeAll(writes)
        const rows = yield* db.all<{ path: string; rank: number }>(
          `SELECT path, ROW_NUMBER() OVER () AS rank FROM (
             SELECT path FROM files WHERE ${FTS_COLUMN} MATCH ? AND archived = 0 LIMIT ?
           )`,
          ["zebra", 40]
        )
        return { dense: [...dense].sort(), rows }
      })
    )

    const top = outcome.rows.slice(0, outcome.dense.length).map((row) => row.path)
    // Every dense row outranks every single-mention row. Under a multi-column index this fails: the
    // first results are p000, p003, p006, ... — rowid order.
    expect(top.sort()).toEqual(outcome.dense)
    // The window numbers the MATCH order it was given, 1-based and gapless.
    expect(outcome.rows.map((row) => row.rank)).toEqual(outcome.rows.map((_, offset) => offset + 1))
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
          `SELECT path FROM files WHERE ${FTS_COLUMN} MATCH ?`,
          ["wildebeest"]
        )
        return rows.map((row) => row.path)
      })
    )
    // Denormalizing is what makes a title-only term findable: MATCH is per-column on this driver.
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
        const stale = yield* db.all<{ path: string }>(
          `SELECT path FROM files WHERE ${FTS_COLUMN} MATCH ?`,
          ["zebra"]
        )
        const fresh = yield* db.all<{ path: string }>(
          `SELECT path FROM files WHERE ${FTS_COLUMN} MATCH ?`,
          ["giraffe"]
        )
        return { stale: stale.length, fresh: fresh.length }
      })
    )
    // The index is maintained transactionally, so an incremental re-index needs no separate FTS pass.
    expect(outcome).toEqual({ stale: 0, fresh: 1 })
  })
})

/**
 * The counter-demonstration, on a scratch table the schema does not own.
 *
 * This exists so the reason for the single-column decision is checkable rather than a claim in a
 * comment. If a future driver release fixes multi-column relevance ordering, THIS test fails — and
 * that failure is the signal to re-probe and reconsider, which is exactly what it is for.
 */
describe("why the index is not multi-column", () => {
  it("loses relevance order and scopes MATCH per column under a multi-column index", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run(
          "CREATE TABLE probe (path TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL)"
        )
        yield* db.run("CREATE INDEX probe_fts ON probe USING fts(title, body)")

        const dense = new Set<string>()
        const writes: Array<Write> = []
        for (let index = 0; index < 60; index += 1) {
          const path = `p${String(index).padStart(3, "0")}`
          const isDense = index % 7 === 0
          if (isDense) dense.add(path)
          writes.push({
            sql: "INSERT INTO probe (path, title, body) VALUES (?, ?, ?)",
            params: [
              path,
              index === 5 ? "wildebeest only in the title" : "plain title",
              isDense
                ? "zebra zebra zebra zebra zebra zebra dense"
                : index % 3 === 0
                  ? "zebra once"
                  : "filler only"
            ]
          })
        }
        yield* db.writeAll(writes)

        const ordered = yield* db.all<{ path: string }>(
          "SELECT path FROM probe WHERE body MATCH ? LIMIT 12",
          ["zebra"]
        )
        const crossColumn = yield* db.all<{ path: string }>(
          "SELECT path FROM probe WHERE body MATCH ?",
          ["wildebeest"]
        )
        return {
          firstFew: ordered.slice(0, 6).map((row) => row.path),
          dense: [...dense],
          crossColumn: crossColumn.length
        }
      })
    )

    // Rowid order, not relevance order: p000 is dense but p001/p002 contain no `zebra` at all, and the
    // single-mention p003 arrives ahead of the dense p007.
    expect(outcome.firstFew).toEqual(["p000", "p003", "p006", "p007", "p009", "p012"])
    expect(outcome.firstFew.every((path) => outcome.dense.includes(path))).toBe(false)
    // And a title-only term is invisible to a body MATCH, contradicting design.md's probe note.
    expect(outcome.crossColumn).toBe(0)
  })
})

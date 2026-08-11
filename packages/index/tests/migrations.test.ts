import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { FTS_COLUMN, FTS_INDEX_NAME, MEMORY_TABLES, TRACE_TABLES } from "../src/schema-const.js"
import { migrationsAfter, withDb, withDbNoState, withDbThrough } from "./harness.js"

/**
 * The DDL against the real driver. Every assertion here is about a constraint the schema claims to
 * enforce — a CHECK that is never exercised is a comment, and the fleet's recurring lesson is that a
 * stateless fake confirms the shape of a write while the constraint goes untested.
 */

describe("migrations", () => {
  it("applies all ten index migrations and the one state migration", async () => {
    const counts = await withDb((db) =>
      Effect.succeed({ index: db.migrationsApplied, state: db.stateMigrationsApplied })
    )
    expect(counts).toEqual({ index: 10, state: 1 })
  })

  it("creates every table the truncate lists name", async () => {
    const names = await withDb((db) =>
      db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    )
    const present = new Set(names.map((row) => row.name))
    for (const table of [...MEMORY_TABLES, ...TRACE_TABLES]) {
      expect(present.has(table), `missing table ${table}`).toBe(true)
    }
    expect(present.has("index_state")).toBe(true)
    expect(present.has("memory_session_links")).toBe(true)
    expect(present.has("sleep_runs")).toBe(true)
    expect(present.has("sleep_phases")).toBe(true)
    expect(present.has("trace_consolidations")).toBe(true)
  })

  it("reaches the state plane's tables through the attach", async () => {
    const rows = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run("INSERT INTO state.access (path, updated_at) VALUES (?, ?)", [
          "areas/x/a.html",
          "2026-08-01T00:00:00Z"
        ])
        return yield* db.all<{ path: string }>("SELECT path FROM state.access")
      })
    )
    expect(rows).toEqual([{ path: "areas/x/a.html" }])
  })

  it("keeps the two planes' migration ledgers apart", async () => {
    const ledgers = await withDb((db) =>
      Effect.gen(function* () {
        const index = yield* db.all<{ name: string }>(
          "SELECT name FROM schema_migrations ORDER BY name"
        )
        const state = yield* db.all<{ name: string }>(
          "SELECT name FROM state.schema_migrations ORDER BY name"
        )
        return { index: index.map((row) => row.name), state: state.map((row) => row.name) }
      })
    )
    expect(ledgers.index).toEqual([
      "0001_files.sql",
      "0002_chunks.sql",
      "0003_fts.sql",
      "0004_edges.sql",
      "0005_traces.sql",
      "0006_sleep.sql",
      "0007_watermark.sql",
      "0008_tasks.sql",
      "0009_frame_key.sql",
      "0010_trace_consolidations.sql"
    ])
    expect(ledgers.state).toEqual(["S0001_access.sql"])
  })

  it("reports no state plane when none is attached", async () => {
    const shape = await withDbNoState((db) =>
      Effect.succeed({ hasState: db.hasState, applied: db.stateMigrationsApplied })
    )
    expect(shape).toEqual({ hasState: false, applied: 0 })
  })

  it("indexes only the one denormalized FTS column", async () => {
    const row = await withDb((db) =>
      db.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE name = ?", [FTS_INDEX_NAME])
    )
    expect(row?.sql).toContain(FTS_COLUMN)
    // A second column would silently cost relevance ordering: probed 2026-08-02, a multi-column FTS
    // index returns MATCH results in rowid order and scopes MATCH to the named column alone.
    expect(row?.sql).not.toContain("body_text,")
    expect(row?.sql).not.toContain("title,")
  })
})

/**
 * 0008 is recreate-and-copy over a POPULATED database, and `DROP TABLE files` cascades to every
 * child (probed live 2026-08-02 on @tursodatabase/database 0.7.2 — including inside the one
 * `immediate` transaction the runner wraps a migration file in). So the upgrade is tested against
 * rows, and the assertion is that the row set is identical rather than merely present: a migration
 * that dropped the embeddings would re-pay Bedrock for every unchanged memory in the corpus, and
 * would report success either way.
 *
 * (Verified by mutation: removing the snapshot/restore from `0008_tasks.sql` empties `file_tags`,
 * `file_entities`, `file_facets`, `file_citations`, `chunks`, AND `embeddings`.)
 */
describe("0008 over a populated 0007 database", () => {
  const AT = "2026-08-01T00:00:00Z"

  /** Seed one file with a row in every child table, plus two edges of different classes. */
  const seed = (db: Parameters<Parameters<typeof withDb>[0]>[0]) =>
    Effect.gen(function* () {
      for (const [path, hash, type, archived] of [
        ["areas/oncall/a.html", "sha256:aaa", "procedural", 0],
        ["projects/memhtml/b.html", "sha256:bbb", "semantic", 0],
        ["archive/2026/areas/oncall/c.html", "sha256:ccc", "episodic", 1]
      ] as ReadonlyArray<readonly [string, string, string, number]>) {
        yield* db.run(
          `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist,
             fts_text, disclosure_text, para, workspace, confidence, importance, archived,
             word_count, created_at, updated_at, event_at, indexed_at)
           VALUES (?, ?, ?, ?, 'T', 'the body text', 'g', 'T\ng\nthe body text', 'd', ?, ?, 0.9, 7,
             ?, 3, ?, ?, '2026-07-01', ?)`,
          [
            path,
            `blob-${path}`,
            hash,
            type,
            path.slice(0, path.indexOf("/")),
            "memhtml",
            archived,
            AT,
            AT,
            AT
          ]
        )
      }
      yield* db.run("INSERT INTO file_tags (path, tag) VALUES ('areas/oncall/a.html', 'deploy')")
      yield* db.run(
        "INSERT INTO file_entities (path, entity_type, entity_name) VALUES ('areas/oncall/a.html', 'service', 'checkout-api')"
      )
      yield* db.run(
        "INSERT INTO file_facets (path, name, value, numeric_value) VALUES ('areas/oncall/a.html', 'Host', 'alb-1', 3)"
      )
      yield* db.run(
        "INSERT INTO file_citations (path, text, href) VALUES ('areas/oncall/a.html', 'sev2', '/x')"
      )
      yield* db.run(
        "INSERT INTO chunks (chunk_id, path, content_hash, ordinal, text, char_count) VALUES ('c1', 'areas/oncall/a.html', 'sha256:aaa', 0, 'the body text', 13)"
      )
      yield* db.run(
        "INSERT INTO embeddings (chunk_id, model, dim, vec, created_at) VALUES ('c1', 'm@1024', 1024, ?, ?)",
        [new Uint8Array(4096).fill(7), AT]
      )
      yield* db.run(
        "INSERT INTO edges (src_path, rel, dst_path, edge_class, created_at) VALUES ('areas/oncall/a.html', 'relates_to', 'projects/memhtml/b.html', 'memory', ?)",
        [AT]
      )
      yield* db.run(
        "INSERT INTO edges (src_path, rel, dst_path, edge_class, created_at) VALUES ('areas/oncall/a.html', 'from_session', 'traces/s1', 'provenance', ?)",
        [AT]
      )
    })

  /** Everything the upgrade must preserve, as comparable JSON. */
  const contents = (db: Parameters<Parameters<typeof withDb>[0]>[0]) =>
    Effect.gen(function* () {
      const rows = <A>(sql: string) => db.all<A>(sql)
      return {
        tags: yield* rows("SELECT * FROM file_tags ORDER BY path, tag"),
        entities: yield* rows("SELECT * FROM file_entities ORDER BY path, entity_name"),
        facets: yield* rows("SELECT * FROM file_facets ORDER BY path, name"),
        citations: yield* rows("SELECT * FROM file_citations ORDER BY path, text"),
        chunks: yield* rows("SELECT * FROM chunks ORDER BY chunk_id"),
        // `length(vec)` rather than the blob: a JSON round trip of a Uint8Array is not comparable,
        // and the byte LENGTH is what proves the vector survived whole rather than truncated.
        embeddings: yield* rows(
          "SELECT chunk_id, model, dim, length(vec) AS bytes, created_at FROM embeddings ORDER BY chunk_id"
        ),
        edges: yield* rows("SELECT * FROM edges ORDER BY src_path, rel, dst_path")
      }
    })

  it("preserves every row of every table, and adds the new columns as null", async () => {
    const outcome = await withDbThrough("0007_watermark.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* seed(db)
        const before = yield* contents(db)
        const beforeFiles = yield* db.all<Record<string, unknown>>(
          "SELECT * FROM files ORDER BY path"
        )

        const applied = yield* Effect.promise(apply)

        const after = yield* contents(db)
        const afterFiles = yield* db.all<Record<string, unknown>>(
          "SELECT * FROM files ORDER BY path"
        )
        return {
          applied,
          before,
          after,
          beforeFiles,
          afterFiles,
          integrity: yield* db.all<Record<string, unknown>>("PRAGMA foreign_key_check")
        }
      })
    )

    // Every migration after 0007 applies over the 0007 database. Derived, not a literal: the count is
    // incidental to what this test asserts, and a literal fails here on every new migration file.
    expect(outcome.applied).toBe(await migrationsAfter("0007_watermark.sql"))
    expect(outcome.after).toEqual(outcome.before)
    expect(outcome.integrity).toEqual([])

    // `files` keeps every row and every old column value; each new one arrives null. `frame_key`
    // included: 0009 does not backfill, because the key derives from the gist through TypeScript and
    // SQL cannot call `frameKeyOf` — the rows fill in on the next rebuild or the next touch.
    expect(outcome.afterFiles).toHaveLength(outcome.beforeFiles.length)
    for (const [offset, after] of outcome.afterFiles.entries()) {
      const { task_status, due_at, frame_key, ...carried } = after
      expect(task_status).toBeNull()
      expect(due_at).toBeNull()
      expect(frame_key).toBeNull()
      expect(carried).toEqual(outcome.beforeFiles[offset])
    }
  })

  it("leaves foreign keys enforcing, so the recreate did not disarm them", async () => {
    /**
     * The migration never turns `foreign_keys` off — a `PRAGMA` is documented as a no-op inside a
     * transaction, so a file that relied on one would work on this driver and silently destroy data
     * on a release that followed the documentation. This asserts the constraints still bite after
     * the recreate, in both directions: an orphan is refused and a rename still cascades.
     */
    const outcome = await withDbThrough("0007_watermark.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* seed(db)
        yield* Effect.promise(apply)
        const orphan = yield* Effect.result(
          db.run("INSERT INTO file_tags (path, tag) VALUES ('areas/absent.html', 'x')")
        )
        yield* db.run("UPDATE files SET path = ? WHERE path = ?", [
          "archive/2026/areas/oncall/a.html",
          "areas/oncall/a.html"
        ])
        return {
          orphan,
          chunk: yield* db.get<{ path: string }>("SELECT path FROM chunks WHERE chunk_id = 'c1'"),
          embeddings: yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        }
      })
    )

    expect(Result.isFailure(outcome.orphan)).toBe(true)
    expect(outcome.chunk?.path).toBe("archive/2026/areas/oncall/a.html")
    expect(outcome.embeddings?.n).toBe(1)
  })

  it("rebuilds every index the recreated tables had, plus the task one", async () => {
    // A dropped table takes its indexes with it, so an index the migration forgot to recreate is
    // an index the database silently no longer has — and a missing partial UNIQUE index is a
    // missing dedup guarantee, which no query fails on.
    const names = await withDbThrough("0007_watermark.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* Effect.promise(apply)
        const rows = yield* db.all<{ name: string }>(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index' AND tbl_name IN ('files', 'edges') AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        return rows.map((row) => row.name)
      })
    )

    expect(names).toEqual([
      "edges_derived",
      "edges_dst",
      "edges_rel",
      "edges_src",
      "files_blob",
      "files_content_hash_active",
      "files_event",
      "files_frame_key_active",
      FTS_INDEX_NAME,
      "files_para",
      "files_session",
      "files_task_status",
      "files_ttl",
      "files_type_active",
      "files_updated",
      "files_workspace"
    ])
  })

  it("leaves the rebuilt FTS index ranking the copied rows", async () => {
    // The index is dropped with the table and rebuilt over the finished copy, so a MATCH has to
    // find rows that were written before the index existed.
    const hits = await withDbThrough("0007_watermark.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* seed(db)
        yield* Effect.promise(apply)
        return yield* db.all<{ path: string }>("SELECT path FROM files WHERE fts_text MATCH 'body'")
      })
    )
    expect(hits.length).toBe(3)
  })
})

/**
 * 0009 is ADDITIVE — `ALTER TABLE … ADD COLUMN` plus one partial index — so the risks are the
 * opposite of 0008's. Nothing can be destroyed by an added nullable column; what CAN go wrong is the
 * index being absent, being unique, or carrying a predicate that disagrees with the lookup's. Each of
 * those is silent: the first degrades a seek to a scan, the second refuses the very writes the
 * conflict assist exists to observe, the third does both depending on the row.
 */
describe("0009 over a populated 0008 database", () => {
  const AT = "2026-08-01T00:00:00Z"

  const seedRow = (
    db: Parameters<Parameters<typeof withDb>[0]>[0],
    path: string,
    hash: string,
    archived: number,
    memoryType = "semantic"
  ) =>
    db.run(
      `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, gist,
         fts_text, disclosure_text, para, archived, task_status, word_count, created_at, updated_at,
         indexed_at)
       VALUES (?, ?, ?, ?, 'T', 'b', 'the capital of india is New Delhi', 'f', 'd', ?, ?, ?, 1, ?, ?, ?)`,
      [
        path,
        `blob-${path}`,
        hash,
        memoryType,
        archived === 1 ? "archive" : "areas",
        archived,
        memoryType === "task" ? "todo" : null,
        AT,
        AT,
        AT
      ]
    )

  it("adds frame_key as NULL on every existing row without disturbing the rest", async () => {
    const outcome = await withDbThrough("0008_tasks.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* seedRow(db, "areas/oncall/a.html", "sha256:aaa", 0)
        yield* seedRow(db, "archive/2026/areas/b.html", "sha256:bbb", 1)
        const before = yield* db.all<Record<string, unknown>>("SELECT * FROM files ORDER BY path")

        const applied = yield* Effect.promise(apply)

        const after = yield* db.all<Record<string, unknown>>("SELECT * FROM files ORDER BY path")
        return { applied, before, after }
      })
    )

    expect(outcome.applied).toBe(await migrationsAfter("0008_tasks.sql"))
    expect(outcome.after).toHaveLength(2)
    for (const [offset, row] of outcome.after.entries()) {
      const { frame_key, ...carried } = row
      // Not backfilled by design: SQL cannot call `frameKeyOf`, and a SQL reimplementation of the
      // regex would be a second copy of a measured heuristic, free to drift.
      expect(frame_key).toBeNull()
      expect(carried).toEqual(outcome.before[offset])
    }
  })

  it("creates files_frame_key_active with the lookup's exact predicate, and NOT unique", async () => {
    const row = await withDbThrough("0008_tasks.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* Effect.promise(apply)
        return yield* db.get<{ sql: string }>(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'files_frame_key_active'"
        )
      })
    )

    expect(row?.sql).toBeDefined()
    // Each clause asserted separately, because a predicate that agrees with `activeFramesFor` on two
    // of three still turns a seek into a scan on the rows where it differs.
    expect(row?.sql).toContain("archived = 0")
    // `<>` or `!=`: the driver stores this predicate NORMALIZED — 0009 writes `memory_type <> 'task'`
    // and `sqlite_schema` reports `memory_type != 'task'` (probed 2026-08-07 on
    // @tursodatabase/database 0.7.2). They are the same operator, so the assertion admits both rather
    // than pinning a driver's spelling; matching only the literal source form would fail this test on
    // a correct migration.
    expect(row?.sql).toMatch(/memory_type (?:<>|!=) 'task'/)
    expect(row?.sql).toContain("frame_key IS NOT NULL")
    // UNIQUE here would refuse the second half of every conflict pair — the assist's whole input.
    expect(row?.sql).not.toContain("UNIQUE")
  })

  it("admits two ACTIVE rows sharing a frame key, because that pair IS the signal", async () => {
    /**
     * The non-uniqueness, at the database rather than in a comment. A conflict is two live claims in
     * one slot with different values; an index that refused the second would keep the corpus clean by
     * never recording the disagreement, and the assist would have nothing to find.
     *
     * (Verified by mutation: adding `UNIQUE` to 0009's index makes this test fail on the second
     * insert while every other test in this file still passes — which is exactly how quietly that
     * mistake would ship.)
     */
    const outcome = await withDbThrough("0008_tasks.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* Effect.promise(apply)
        yield* seedRow(db, "areas/oncall/a.html", "sha256:aaa", 0)
        yield* seedRow(db, "areas/oncall/b.html", "sha256:bbb", 0)
        yield* db.run("UPDATE files SET frame_key = 'the capital of india is'")
        const second = yield* Effect.result(
          db.run("UPDATE files SET frame_key = 'the capital of india is' WHERE path = ?", [
            "areas/oncall/b.html"
          ])
        )
        return {
          second,
          n: yield* db.get<{ n: number }>(
            "SELECT count(*) AS n FROM files WHERE frame_key = 'the capital of india is'"
          )
        }
      })
    )
    expect(Result.isSuccess(outcome.second)).toBe(true)
    expect(outcome.n?.n).toBe(2)
  })

  it("keeps the FTS index working, so the ALTER did not disturb the virtual index", async () => {
    // `ADD COLUMN` on a table carrying an FTS index is the one interaction this migration has with
    // 0003, and a broken index would surface only as retrieval finding nothing.
    const hits = await withDbThrough("0008_tasks.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* seedRow(db, "areas/oncall/a.html", "sha256:aaa", 0)
        yield* Effect.promise(apply)
        return yield* db.all<{ path: string }>("SELECT path FROM files WHERE fts_text MATCH 'f'")
      })
    )
    expect(hits).toHaveLength(1)
  })
})

/**
 * 0010 adds `trace_consolidations`: pure `CREATE TABLE`, no ALTER, no recreate-and-copy. The tests
 * that matter are therefore not about the DDL surviving — they are about the table's CATEGORY. It is
 * run state like `sleep_runs`, not an index projection like `files`, and the difference is only
 * observable across a rebuild.
 */
describe("0010 over a populated 0009 database", () => {
  const AT = "2026-08-08T00:00:00Z"

  it("applies over rows and leaves the existing tables alone", async () => {
    const outcome = await withDbThrough("0009_frame_key.sql", (db, apply) =>
      Effect.gen(function* () {
        yield* db.run(fileRow().sql, fileRow().params)
        const before = yield* db.all<Record<string, unknown>>("SELECT * FROM files ORDER BY path")

        const applied = yield* Effect.promise(apply)

        return {
          applied,
          before,
          after: yield* db.all<Record<string, unknown>>("SELECT * FROM files ORDER BY path"),
          // The new table is reachable and empty: a fresh migration invents no watermark, so the
          // first cycle after it sees every session as unconsolidated.
          watermarks: yield* db.all<{ session_id: string }>(
            "SELECT session_id FROM trace_consolidations"
          )
        }
      })
    )

    expect(outcome.applied).toBe(await migrationsAfter("0009_frame_key.sql"))
    expect(outcome.after).toEqual(outcome.before)
    expect(outcome.watermarks).toEqual([])
  })

  it("takes one row per session, a second consolidation moving the run rather than doubling", async () => {
    /**
     * `session_id` as the primary key with `DO UPDATE`, which is what makes a reconsolidation after a
     * lost `index.db` idempotent in SHAPE: the row moves to the run that actually re-read the session
     * instead of accumulating one row per attempt or keeping a `run_id` naming a deleted branch.
     */
    const rows = await withDb((db) =>
      Effect.gen(function* () {
        const upsert = (runId: string) =>
          db.run(
            `INSERT INTO trace_consolidations (session_id, run_id, consolidated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               run_id = excluded.run_id, consolidated_at = excluded.consolidated_at`,
            ["session-a", runId, AT]
          )
        yield* upsert("sleep/2026-08-08")
        yield* upsert("sleep/2026-08-09")
        return yield* db.all<{ session_id: string; run_id: string }>(
          "SELECT session_id, run_id FROM trace_consolidations"
        )
      })
    )
    expect(rows).toEqual([{ session_id: "session-a", run_id: "sleep/2026-08-09" }])
  })

  it("takes a watermark for a session with no traces row, because there is no foreign key", async () => {
    /**
     * Deliberate, and the same reasoning `memory_session_links` records in 0005. The trace plane is a
     * rebuildable index over `~/.claude/projects`, so a session's `traces` row can be rebuilt away —
     * its transcript rotated, its project directory pruned — while the fact that the cycle already
     * read it stays true. A foreign key would delete the watermark and invite a re-read of a file that
     * may no longer exist.
     */
    const outcome = await withDb((db) =>
      Effect.result(
        db.run(
          "INSERT INTO trace_consolidations (session_id, run_id, consolidated_at) VALUES (?, ?, ?)",
          ["a-session-no-transcript-was-ever-scanned-for", "sleep/2026-08-08", AT]
        )
      )
    )
    expect(Result.isSuccess(outcome)).toBe(true)
  })

  it("is absent from MEMORY_TABLES, which is what makes it survive a rebuild", async () => {
    /**
     * The INV-2 assertion, and it is made against the truncate list rather than by running a rebuild —
     * because that list IS the mechanism: `indexer.rebuild` empties exactly `MEMORY_TABLES`
     * (`packages/index/src/indexer.ts:408`) and never drops or recreates the database file, so a table
     * absent from it is untouched. `sleep_runs` and `sleep_phases` are checked alongside so the
     * assertion reads as "this is the same category as those", which is the actual claim.
     *
     * (Verified by mutation: adding `"trace_consolidations"` to `MEMORY_TABLES` fails this case AND
     * the watermark-survives-a-rebuild case in the sleep suite — which is what a reviewer would want,
     * since the list is the kind of thing a future migration author appends to reflexively.)
     */
    const names: ReadonlyArray<string> = MEMORY_TABLES
    for (const runState of ["trace_consolidations", "sleep_runs", "sleep_phases"]) {
      expect(names, `${runState} would be truncated by a rebuild`).not.toContain(runState)
    }
    // And the table really does exist, so the assertion above is about a real table rather than a
    // name nothing creates.
    const present = await withDb((db) =>
      db.get<{ name: string }>("SELECT name FROM sqlite_schema WHERE name = ?", [
        "trace_consolidations"
      ])
    )
    expect(present?.name).toBe("trace_consolidations")
  })
})

/** One valid `files` row's worth of parameters, so a constraint test varies exactly one field. */
const fileRow = (over: Partial<Record<string, string | number | null>> = {}) => {
  const base: Record<string, string | number | null> = {
    path: "areas/oncall/a.html",
    blob_sha: "sha-a",
    content_hash: "sha256:aaa",
    memory_type: "procedural",
    title: "A",
    body_text: "body",
    gist: "claim",
    fts_text: "A\nclaim\nbody",
    disclosure_text: "claim",
    para: "areas",
    confidence: 0.9,
    importance: 8,
    archived: 0,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    indexed_at: "2026-08-01T00:00:00Z",
    ...over
  }
  const columns = Object.keys(base)
  return {
    sql: `INSERT INTO files (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map((column) => base[column] ?? null)
  }
}

describe("files constraints", () => {
  it("refuses a second ACTIVE row with the same content hash", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const first = fileRow()
        yield* db.run(first.sql, first.params)
        const second = fileRow({ path: "areas/oncall/b.html", blob_sha: "sha-b" })
        return yield* Effect.result(db.run(second.sql, second.params))
      })
    )
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("admits the same content hash once the earlier row is archived", async () => {
    const count = await withDb((db) =>
      Effect.gen(function* () {
        const archivedRow = fileRow({
          path: "archive/2026/areas/oncall/a.html",
          para: "archive",
          archived: 1
        })
        yield* db.run(archivedRow.sql, archivedRow.params)
        const active = fileRow({ path: "areas/oncall/a.html" })
        yield* db.run(active.sql, active.params)
        return yield* db.get<{ n: number }>("SELECT count(*) AS n FROM files")
      })
    )
    expect(count?.n).toBe(2)
  })

  it("refuses a memory_type outside the ten-value vocabulary", async () => {
    const outcome = await withDb((db) => {
      const row = fileRow({ memory_type: "gossip" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("admits two ACTIVE tasks with the same content hash, and still refuses two memories", async () => {
    /**
     * The dedup carve-out, at the database, in BOTH directions — one assertion without the other
     * proves nothing. Two open tasks with identical bodies are two real work items ("review the
     * deploy runbook" twice is two things to do); two identical active memories are one fact
     * stored twice, which is what `files_content_hash_active` exists to refuse.
     *
     * (Verified by mutation: dropping `AND memory_type <> 'task'` from the index makes the first
     * half fail and leaves the second half passing.)
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const firstTask = fileRow({
          path: "areas/inbox/tasks/t1.html",
          content_hash: "sha256:same",
          memory_type: "task",
          task_status: "todo"
        })
        yield* db.run(firstTask.sql, firstTask.params)
        const secondTask = fileRow({
          path: "areas/inbox/tasks/t2.html",
          blob_sha: "sha-t2",
          content_hash: "sha256:same",
          memory_type: "task",
          task_status: "todo"
        })
        const taskDuplicate = yield* Effect.result(db.run(secondTask.sql, secondTask.params))

        const memory = fileRow({ path: "areas/oncall/m1.html", content_hash: "sha256:memhtml" })
        yield* db.run(memory.sql, memory.params)
        const twin = fileRow({
          path: "areas/oncall/m2.html",
          blob_sha: "sha-m2",
          content_hash: "sha256:memhtml"
        })
        const memoryDuplicate = yield* Effect.result(db.run(twin.sql, twin.params))

        // And a MEMORY may share a hash with an open task: the carve-out removes tasks from the
        // index's scope entirely, so a new memory is never deduped ONTO one.
        const crossing = fileRow({
          path: "areas/oncall/m3.html",
          blob_sha: "sha-m3",
          content_hash: "sha256:same"
        })
        const acrossTypes = yield* Effect.result(db.run(crossing.sql, crossing.params))

        return { taskDuplicate, memoryDuplicate, acrossTypes }
      })
    )

    expect(Result.isSuccess(outcome.taskDuplicate)).toBe(true)
    expect(Result.isFailure(outcome.memoryDuplicate)).toBe(true)
    expect(Result.isSuccess(outcome.acrossTypes)).toBe(true)
  })

  it("refuses a task_status outside the four, and admits null on every other type", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const bad = fileRow({
          path: "areas/inbox/tasks/bad.html",
          memory_type: "task",
          task_status: "wip"
        })
        // An IN-list CHECK passes NULL, which is what lets one column serve a task and a memory
        // without a type-conditional constraint.
        const memory = fileRow({ path: "areas/oncall/plain.html" })
        return {
          badStatus: yield* Effect.result(db.run(bad.sql, bad.params)),
          nullOnMemory: yield* Effect.result(db.run(memory.sql, memory.params))
        }
      })
    )
    expect(Result.isFailure(outcome.badStatus)).toBe(true)
    expect(Result.isSuccess(outcome.nullOnMemory)).toBe(true)
  })

  it("refuses a para outside the four buckets", async () => {
    const outcome = await withDb((db) => {
      const row = fileRow({ para: "inbox" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("refuses a confidence outside [0, 1] and an importance outside [1, 10]", async () => {
    const outcomes = await withDb((db) =>
      Effect.gen(function* () {
        const bad = fileRow({ confidence: 1.5 })
        const worse = fileRow({ path: "areas/oncall/c.html", importance: 0 })
        return [
          yield* Effect.result(db.run(bad.sql, bad.params)),
          yield* Effect.result(db.run(worse.sql, worse.params))
        ]
      })
    )
    expect(outcomes.every(Result.isFailure)).toBe(true)
  })

  it("cascades a file delete to its tags, entities, facets, citations, chunks, and embeddings", async () => {
    const remaining = await withDb((db) =>
      Effect.gen(function* () {
        const row = fileRow()
        yield* db.run(row.sql, row.params)
        yield* db.run("INSERT INTO file_tags (path, tag) VALUES (?, ?)", [
          "areas/oncall/a.html",
          "deploy"
        ])
        yield* db.run(
          "INSERT INTO file_entities (path, entity_type, entity_name) VALUES (?, ?, ?)",
          ["areas/oncall/a.html", "service", "checkout-api"]
        )
        yield* db.run("INSERT INTO file_facets (path, name, value) VALUES (?, ?, ?)", [
          "areas/oncall/a.html",
          "Applies to",
          "ALB"
        ])
        yield* db.run("INSERT INTO file_citations (path, text) VALUES (?, ?)", [
          "areas/oncall/a.html",
          "checkout-api sev2"
        ])
        yield* db.run(
          "INSERT INTO chunks (chunk_id, path, content_hash, ordinal, text, char_count) VALUES (?, ?, ?, ?, ?, ?)",
          ["chunk-1", "areas/oncall/a.html", "sha256:aaa", 0, "body", 4]
        )
        yield* db.run(
          "INSERT INTO embeddings (chunk_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)",
          ["chunk-1", "m@8", 2, new Uint8Array(8), "2026-08-01T00:00:00Z"]
        )

        yield* db.run("DELETE FROM files WHERE path = ?", ["areas/oncall/a.html"])

        return yield* db.get<{
          tags: number
          entities: number
          facets: number
          citations: number
          chunks: number
          embeddings: number
        }>(
          `SELECT (SELECT count(*) FROM file_tags) AS tags,
                  (SELECT count(*) FROM file_entities) AS entities,
                  (SELECT count(*) FROM file_facets) AS facets,
                  (SELECT count(*) FROM file_citations) AS citations,
                  (SELECT count(*) FROM chunks) AS chunks,
                  (SELECT count(*) FROM embeddings) AS embeddings`
        )
      })
    )
    expect(remaining).toEqual({
      tags: 0,
      entities: 0,
      facets: 0,
      citations: 0,
      chunks: 0,
      embeddings: 0
    })
  })

  it("keeps a chunk's embedding when only the file's PATH changes", async () => {
    const survived = await withDb((db) =>
      Effect.gen(function* () {
        const row = fileRow()
        yield* db.run(row.sql, row.params)
        yield* db.run(
          "INSERT INTO chunks (chunk_id, path, content_hash, ordinal, text, char_count) VALUES (?, ?, ?, ?, ?, ?)",
          ["chunk-1", "areas/oncall/a.html", "sha256:aaa", 0, "body", 4]
        )
        yield* db.run(
          "INSERT INTO embeddings (chunk_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)",
          ["chunk-1", "m@8", 2, new Uint8Array(8), "2026-08-01T00:00:00Z"]
        )
        // The archive move, as the indexer performs it: ONE update of the parent key, never a delete
        // plus an add. `ON UPDATE CASCADE` carries the chunk with it and the embedding rides along.
        yield* db.run("UPDATE files SET path = ? WHERE path = ?", [
          "archive/2026/areas/oncall/a.html",
          "areas/oncall/a.html"
        ])
        return yield* db.get<{ embeddings: number; chunkPath: string }>(
          `SELECT (SELECT count(*) FROM embeddings) AS embeddings,
                  (SELECT path FROM chunks WHERE chunk_id = 'chunk-1') AS chunkPath`
        )
      })
    )
    expect(survived).toEqual({ embeddings: 1, chunkPath: "archive/2026/areas/oncall/a.html" })
  })
})

describe("edges constraints", () => {
  const edge = (over: Partial<Record<string, string | number>> = {}) => {
    const base: Record<string, string | number> = {
      src_path: "areas/a.html",
      rel: "supersedes",
      dst_path: "areas/b.html",
      edge_class: "memory",
      derived: 0,
      strength: 1.0,
      provenance: "authored",
      created_at: "2026-08-01T00:00:00Z",
      ...over
    }
    const columns = Object.keys(base)
    return {
      sql: `INSERT INTO edges (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params: columns.map((column) => base[column] ?? null)
    }
  }

  it("admits a memory rel under the memory class", async () => {
    const outcome = await withDb((db) => {
      const row = edge()
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isSuccess(outcome)).toBe(true)
  })

  it("refuses a person rel under the memory class", async () => {
    const outcome = await withDb((db) => {
      const row = edge({ rel: "about_person" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("admits a person rel under the person class", async () => {
    const outcome = await withDb((db) => {
      const row = edge({ rel: "about_person", edge_class: "person" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isSuccess(outcome)).toBe(true)
  })

  it("refuses a self-loop", async () => {
    const outcome = await withDb((db) => {
      const row = edge({ dst_path: "areas/a.html" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("refuses a derived edge that does not claim sleep provenance", async () => {
    const outcome = await withDb((db) => {
      const row = edge({ rel: "relates_to", derived: 1, provenance: "authored" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isFailure(outcome)).toBe(true)
  })

  it("admits a task rel under the task class and refuses it under any other", async () => {
    /**
     * The graph firewall at the database. `edge_class = 'memory'` is what every query that may feed
     * PageRank, MMR, or the retention bridge count filters on, so a `blocks` edge admitted into the
     * memory class would let an agent's to-do list reweight the retention of its knowledge.
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const results: Record<string, unknown> = {}
        for (const rel of ["blocks", "subtask_of"]) {
          const good = edge({
            src_path: `areas/inbox/tasks/${rel}-a.html`,
            rel,
            dst_path: `areas/inbox/tasks/${rel}-b.html`,
            edge_class: "task"
          })
          results[`${rel}AsTask`] = yield* Effect.result(db.run(good.sql, good.params))
          const bad = edge({
            src_path: `areas/inbox/tasks/${rel}-c.html`,
            rel,
            dst_path: `areas/inbox/tasks/${rel}-d.html`,
            edge_class: "memory"
          })
          results[`${rel}AsMemory`] = yield* Effect.result(db.run(bad.sql, bad.params))
        }
        // And the reverse: a memory rel cannot wear the task class either.
        const inverted = edge({ rel: "relates_to", edge_class: "task" })
        results.memoryRelAsTask = yield* Effect.result(db.run(inverted.sql, inverted.params))
        return results
      })
    )

    expect(Result.isSuccess(outcome.blocksAsTask as never)).toBe(true)
    expect(Result.isSuccess(outcome.subtask_ofAsTask as never)).toBe(true)
    expect(Result.isFailure(outcome.blocksAsMemory as never)).toBe(true)
    expect(Result.isFailure(outcome.subtask_ofAsMemory as never)).toBe(true)
    expect(Result.isFailure(outcome.memoryRelAsTask as never)).toBe(true)
  })

  it("admits an edge pointing at a path with no file row", async () => {
    // No FK on src/dst by design: a <link> may name a file the indexer has not reached yet, and a
    // hard FK would make indexing order-dependent.
    const outcome = await withDb((db) => {
      const row = edge({ dst_path: "areas/never-indexed.html" })
      return Effect.result(db.run(row.sql, row.params))
    })
    expect(Result.isSuccess(outcome)).toBe(true)
  })
})

describe("index_state", () => {
  it("holds exactly one row", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run(
          "INSERT INTO index_state (id, head_sha, embed_model, embed_dim, rebuilt_at, updated_at) VALUES (1, 'sha', 'm@1024', 1024, 'x', 'x')"
        )
        return yield* Effect.result(
          db.run(
            "INSERT INTO index_state (id, head_sha, embed_model, embed_dim, rebuilt_at, updated_at) VALUES (2, 'sha', 'm@1024', 1024, 'x', 'x')"
          )
        )
      })
    )
    expect(Result.isFailure(outcome)).toBe(true)
  })
})

describe("state plane constraints", () => {
  it("refuses an outcome score outside [-1, 1] and a negative access count", async () => {
    const outcomes = await withDb((db) =>
      Effect.gen(function* () {
        const tooHigh = yield* Effect.result(
          db.run("INSERT INTO state.access (path, outcome_score, updated_at) VALUES (?, ?, ?)", [
            "areas/a.html",
            1.5,
            "x"
          ])
        )
        const negativeCount = yield* Effect.result(
          db.run("INSERT INTO state.access (path, access_count, updated_at) VALUES (?, ?, ?)", [
            "areas/b.html",
            -1,
            "x"
          ])
        )
        return [tooHigh, negativeCount]
      })
    )
    expect(outcomes.every(Result.isFailure)).toBe(true)
  })

  it("admits a negative outcome score inside the range: a bad outcome is a fact, not a violation", async () => {
    const row = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run(
          "INSERT INTO state.access (path, outcome_score, updated_at) VALUES (?, ?, ?)",
          ["areas/a.html", -1, "x"]
        )
        return yield* db.get<{ outcome_score: number }>(
          "SELECT outcome_score FROM state.access WHERE path = ?",
          ["areas/a.html"]
        )
      })
    )
    expect(row?.outcome_score).toBe(-1)
  })

  it("requires at least one detection on a corroboration row", async () => {
    const outcome = await withDb((db) =>
      Effect.result(
        db.run(
          "INSERT INTO state.edge_corroboration (src_path, rel, dst_path, detections, updated_at) VALUES (?, ?, ?, ?, ?)",
          ["areas/a.html", "contradicts", "areas/b.html", 0, "x"]
        )
      )
    )
    expect(Result.isFailure(outcome)).toBe(true)
  })
})

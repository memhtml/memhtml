import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { type DatabaseShape, makeDatabase, splitStatements, TURSO_OPTS } from "../src/database.js"

/**
 * This suite is about the runner, not the schema, so it applies NO migrations: an empty directory
 * isolates the ledger machinery from what the seven real migrations happen to create. The shipped DDL
 * is exercised against the real driver in `migrations.test.ts`.
 */
const MIGRATIONS = new URL("./fixtures/no-migrations", import.meta.url).pathname

/** Runs a scoped program against a fresh in-memory database. */
const withDb = <A, E>(body: (db: DatabaseShape) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase(":memory:", MIGRATIONS)
        return yield* body(db)
      })
    )
  )

describe("TURSO_OPTS", () => {
  it("requests both experimental features every connect needs", () => {
    expect(TURSO_OPTS.experimental).toEqual(["index_method", "attach"])
  })
})

describe("splitStatements", () => {
  it("does not split on a semicolon inside a line comment", () => {
    expect(splitStatements("SELECT 1 -- a; b\n; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"])
  })

  it("does not split on a semicolon inside a block comment", () => {
    expect(splitStatements("SELECT 1 /* a; b */; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"])
  })

  it("does not split on a semicolon inside a string literal", () => {
    expect(splitStatements("INSERT INTO t VALUES('a;b'); SELECT 2")).toEqual([
      "INSERT INTO t VALUES('a;b')",
      "SELECT 2"
    ])
  })

  it("handles SQL's doubled-quote escape", () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'it''s; fine'",
      "SELECT 2"
    ])
  })

  it("drops empty fragments from trailing and doubled semicolons", () => {
    expect(splitStatements("SELECT 1;;\n\n; ")).toEqual(["SELECT 1"])
  })

  it("returns nothing for a file that is only comments", () => {
    expect(splitStatements("-- nothing here\n/* nor here */\n")).toEqual([])
  })
})

describe("makeDatabase", () => {
  it("connects to :memory: and applies zero migrations from an empty dir", async () => {
    const applied = await withDb((db) => Effect.succeed(db.migrationsApplied))
    expect(applied).toBe(0)
  })

  it("creates the schema_migrations ledger even with nothing to apply", async () => {
    const row = await withDb((db) =>
      db.get<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'"
      )
    )
    expect(row?.name).toBe("schema_migrations")
  })

  it("enforces PRAGMA foreign_keys on the live connection", async () => {
    const row = await withDb((db) => db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))
    expect(row?.foreign_keys).toBe(1)
  })

  it("round-trips run, get, and all through the real driver", async () => {
    const rows = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
        yield* db.run("INSERT INTO t (id, label) VALUES (?, ?)", [1, "one"])
        yield* db.run("INSERT INTO t (id, label) VALUES (?, ?)", [2, "two"])
        return yield* db.all<{ id: number; label: string }>("SELECT id, label FROM t ORDER BY id")
      })
    )
    expect(rows).toEqual([
      { id: 1, label: "one" },
      { id: 2, label: "two" }
    ])
  })

  it("returns undefined rather than failing when get matches no row", async () => {
    const row = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        return yield* db.get<{ id: number }>("SELECT id FROM t WHERE id = ?", [7])
      })
    )
    expect(row).toBeUndefined()
  })

  it("commits every write in a batch or none of them", async () => {
    const count = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        const outcome = yield* Effect.result(
          db.writeAll([
            { sql: "INSERT INTO t (id) VALUES (?)", params: [1] },
            { sql: "INSERT INTO t (id) VALUES (?)", params: [1] }
          ])
        )
        expect(Result.isFailure(outcome)).toBe(true)
        return yield* db.get<{ n: number }>("SELECT count(*) AS n FROM t")
      })
    )
    expect(count?.n).toBe(0)
  })

  it("treats an empty batch as a no-op instead of a driver call", async () => {
    const outcome = await withDb((db) => Effect.result(db.writeAll([])))
    expect(Result.isSuccess(outcome)).toBe(true)
  })

  it("reduces a driver rejection to the operation name", async () => {
    const outcome = await withDb((db) => Effect.result(db.run("SELECT * FROM absent_table")))
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("StorageFailure")
      expect(outcome.failure.operation).toBe("run")
      expect(Object.keys(outcome.failure).sort()).toEqual(["_tag", "operation"])
    }
  })

  it("fails on connect when the migrations dir does not exist", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(Effect.result(makeDatabase(":memory:", "/nonexistent/memhtml-migrations")))
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) expect(outcome.failure.operation).toBe("migrate.scan")
  })
})

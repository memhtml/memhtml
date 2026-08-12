import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { type DatabaseShape, isBusyCause, makeDatabase } from "../src/database.js"

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

/**
 * The busy predicate, against a contended write the driver actually rejected.
 *
 * `isBusyCause` decides whether a failed statement is retried, and a predicate that never matches
 * would make the retry policy a no-op that no other test in this suite could detect. So the error
 * here is CAPTURED from a real second-writer conflict rather than constructed: what the predicate
 * has to agree with is the shape node:sqlite throws, not the shape this file imagines.
 */
describe("isBusyCause", () => {
  it("recognizes the rejection a real contended write produces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memhtml-busy-"))
    const path = join(dir, "contended.db")
    const holder = new DatabaseSync(path)
    try {
      holder.exec("PRAGMA journal_mode = WAL")
      holder.exec("CREATE TABLE t (x INTEGER)")
      holder.exec("BEGIN IMMEDIATE")
      holder.prepare("INSERT INTO t VALUES (1)").run()

      // A second connection that gives up promptly, so the test does not wait out a real timeout.
      const contender = new DatabaseSync(path, { timeout: 1 })
      let captured: unknown
      try {
        contender.exec("BEGIN IMMEDIATE")
      } catch (cause) {
        captured = cause
      } finally {
        contender.close()
      }

      expect(captured).toBeDefined()
      expect(isBusyCause(captured)).toBe(true)
      // And it does not fire for an unrelated failure, which would retry a real bug forever.
      expect(isBusyCause(new Error("no such column: nope"))).toBe(false)
      expect(isBusyCause(undefined)).toBe(false)
    } finally {
      holder.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

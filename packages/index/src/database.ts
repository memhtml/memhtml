import { mkdir, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { StorageFailure } from "@memhtml/contracts/errors"
import { connect, type Database } from "@tursodatabase/database"
import { Context, Effect } from "effect"

/**
 * The one connect-options constant, the source for every `connect` in the system.
 *
 * `index_method` is what makes `CREATE INDEX ... USING fts(...)` available — and once
 * such an index exists, every statement touching that table needs the flag too, not
 * just the ones that MATCH. A plain `SELECT` from `files` fails without it. `attach`
 * is what lets `.memhtml/state.db` join `main.files` in one query.
 *
 * Probed live 2026-08-01 against @tursodatabase/database 0.7.2 (SQLite 3.50.4 core).
 *
 * `satisfies` checks both names against the driver's own `ExperimentalFeature` union,
 * so a release that renames or drops a flag is a compile error here rather than an
 * unopenable database at runtime.
 */
export const TURSO_OPTS = {
  experimental: ["index_method", "attach"]
} as const satisfies { readonly experimental: ReadonlyArray<ExperimentalFeature> }

/**
 * Read off `connect`'s own signature rather than imported: the driver declares
 * `DatabaseOpts` in `@tursodatabase/database-common`, which its entry point does not
 * re-export and which is therefore not a dependency this package may name.
 */
type DatabaseOpts = NonNullable<Parameters<typeof connect>[1]>
type ExperimentalFeature = NonNullable<DatabaseOpts["experimental"]>[number]

/**
 * A fresh mutable copy per call. The driver's signature takes a mutable array, and
 * handing the same array to every connection would let one connection's driver
 * mutate the flags of the next.
 */
const connectOpts = (): DatabaseOpts => ({ experimental: [...TURSO_OPTS.experimental] })

export type SqlValue = string | number | null | Uint8Array

export interface Write {
  readonly sql: string
  readonly params: ReadonlyArray<SqlValue>
}

export interface DatabaseShape {
  readonly run: (
    sql: string,
    params?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<void, StorageFailure>
  readonly get: <A>(
    sql: string,
    params?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<A | undefined, StorageFailure>
  readonly all: <A>(
    sql: string,
    params?: ReadonlyArray<SqlValue>
  ) => Effect.Effect<ReadonlyArray<A>, StorageFailure>
  /** Applies every write atomically: all commit, or none do. */
  readonly writeAll: (writes: ReadonlyArray<Write>) => Effect.Effect<void, StorageFailure>
  readonly migrationsApplied: number
  /**
   * Migrations recorded in the ATTACHed state plane's own ledger, or `0` when no state database is
   * attached. Two counters because the planes are versioned independently: `index.db` is deleted
   * and rebuilt, `state.db` is not.
   */
  readonly stateMigrationsApplied: number
  /** True when `state.access` and `state.edge_corroboration` are reachable from this connection. */
  readonly hasState: boolean
}

export const DatabaseService = Context.Service<DatabaseShape>("memhtml/Database")

class DriverRejection {
  readonly _tag = "DriverRejection"
  readonly detail: string
  constructor(
    readonly operation: string,
    cause: unknown
  ) {
    this.detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  }
}

/**
 * Wraps a driver rejection as a typed failure. The typed error carries only the
 * operation name so SQL parameters and memory contents never reach a tool response;
 * the driver's own message is logged for operators instead of being dropped.
 */
const attempt = <A>(operation: string, thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new DriverRejection(operation, cause)
  }).pipe(
    Effect.tapError((error) => Effect.logError(`db.${operation} failed: ${error.detail}`)),
    Effect.mapError((error) => StorageFailure.make({ operation: error.operation })),
    Effect.withSpan(`db.${operation}`)
  )

const migrationsTable = (ledger: string) => `CREATE TABLE IF NOT EXISTS ${ledger} (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`

/**
 * Applies pending migrations in filename order and returns the total recorded.
 * Each migration and its bookkeeping row commit together, so a crash mid-run
 * never leaves a migration half-applied.
 *
 * `schemaPrefix` qualifies the ledger table: the state plane is a second, independently-versioned
 * schema reached over the same connection, so it needs its own `state.schema_migrations` rather than
 * sharing the index's ledger. Sharing one would make deleting and rebuilding `index.db` — the whole
 * point of it being rebuildable — silently mark the state plane's migrations as unapplied.
 *
 * The migration statements themselves are not rewritten. A state migration names its own schema
 * (`CREATE TABLE state.access`), because the schema name is a fixed property of the design rather
 * than a deployment variable, and a runner that rewrote DDL by regex would have to distinguish a
 * table reference from `ON DELETE CASCADE`.
 */
const runMigrations = (db: Database, migrationsDir: string, schemaPrefix = "") =>
  Effect.gen(function* () {
    const ledger = `${schemaPrefix}schema_migrations`
    yield* attempt("migrate.init", () => db.exec(migrationsTable(ledger)))

    const files = yield* attempt("migrate.scan", async () => {
      const entries = await readdir(migrationsDir)
      return entries.filter((file) => file.endsWith(".sql")).sort()
    })

    const applied = yield* attempt("migrate.applied", () => db.all(`SELECT name FROM ${ledger}`))
    const seen = new Set(
      applied.flatMap((row) =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as { name?: unknown }).name === "string"
          ? [(row as { name: string }).name]
          : []
      )
    )

    let count = seen.size
    for (const file of files) {
      if (seen.has(file)) continue
      const sql = yield* attempt("migrate.read", () => readFile(join(migrationsDir, file), "utf8"))
      yield* attempt("migrate.apply", () =>
        db.batch(
          [
            ...splitStatements(sql).map((statement) => ({ sql: statement, args: [] })),
            {
              sql: `INSERT INTO ${ledger}(name, applied_at) VALUES(?, ?)`,
              args: [file, new Date().toISOString()]
            }
          ],
          "immediate"
        )
      )
      yield* Effect.log(`applied migration ${file}`)
      count += 1
    }

    return count
  })

/**
 * Turso's `batch` takes one statement per entry, so migration files are split on
 * statement boundaries. Splitting on every `;` is wrong: a semicolon inside a
 * comment or a quoted literal is not a boundary, and treating it as one truncates
 * the surrounding statement into unparseable fragments.
 */
export const splitStatements = (sql: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  let current = ""
  let index = 0

  const push = () => {
    const trimmed = current.trim()
    if (trimmed.length > 0) statements.push(trimmed)
    current = ""
  }

  while (index < sql.length) {
    const two = sql.slice(index, index + 2)

    if (two === "--") {
      const end = sql.indexOf("\n", index)
      index = end === -1 ? sql.length : end + 1
      continue
    }

    if (two === "/*") {
      const end = sql.indexOf("*/", index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }

    const char = sql[index] as string

    if (char === "'" || char === '"') {
      // Consume the whole literal, honouring SQL's doubled-quote escape.
      current += char
      index += 1
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            current += char + char
            index += 2
            continue
          }
          current += char
          index += 1
          break
        }
        current += sql[index]
        index += 1
      }
      continue
    }

    if (char === ";") {
      push()
      index += 1
      continue
    }

    current += char
    index += 1
  }

  push()
  return statements
}

/**
 * ATTACH the state plane onto an existing connection under the `state` schema name and apply its
 * own migrations.
 *
 * One connection carrying both planes is what lets the salience retrieval arm `LEFT JOIN
 * state.access` in the same statement as `main.files`, with no application-side join over two
 * result sets.
 *
 * Attaching is not idempotent — a second `ATTACH ... AS state` fails with "database state is
 * already in use" (probed 2026-08-02) — so this is called exactly once per connection, by
 * {@link makeDatabase}.
 */
export const attachState = (db: Database, statePath: string, migrationsDir: string) =>
  Effect.gen(function* () {
    if (statePath !== ":memory:") {
      yield* attempt("state.mkdir", () => mkdir(dirname(statePath), { recursive: true }))
    }
    yield* attempt("state.attach", async () => {
      await db.run("ATTACH ? AS state", statePath)
    })
    return yield* runStateMigrations(db, migrationsDir)
  })

/** {@link runMigrations} against the `state.` ledger. Named so a caller reads which plane it moves. */
export const runStateMigrations = (db: Database, migrationsDir: string) =>
  runMigrations(db, migrationsDir, "state.")

/**
 * A scoped connection with `foreign_keys` on and every pending migration applied.
 * Exported so tests drive the real driver against `":memory:"` — a fake would verify
 * the shape of these calls and not the driver's own constraint enforcement.
 *
 * `state` attaches the durable plane over the same connection. Omit it for a caller that only reads
 * the rebuildable index; the salience arm and every `state.*` write then have nothing to bind to,
 * which is why {@link DatabaseShape.hasState} is on the service and the arm registry consults it
 * rather than assuming.
 */
export const makeDatabase = (
  databasePath: string,
  migrationsDir: string,
  state?: { readonly path: string; readonly migrationsDir: string }
) =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (databasePath !== ":memory:") {
          yield* attempt("mkdir", () => mkdir(dirname(databasePath), { recursive: true }))
        }
        return yield* attempt("connect", () => connect(databasePath, connectOpts()))
      }),
      (handle) => Effect.promise(() => handle.close()).pipe(Effect.orDie)
    )

    yield* attempt("foreign_keys", () => db.exec("PRAGMA foreign_keys = ON"))
    const migrationsApplied = yield* runMigrations(db, migrationsDir)
    const stateMigrationsApplied =
      state === undefined ? 0 : yield* attachState(db, state.path, state.migrationsDir)

    const service: DatabaseShape = {
      run: (sql, params = []) =>
        attempt("run", async () => {
          await db.run(sql, ...params)
        }),
      get: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
        attempt("get", async () => (await db.get(sql, ...params)) as A | undefined),
      all: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
        attempt("all", async () => (await db.all(sql, ...params)) as ReadonlyArray<A>),
      writeAll: (writes) =>
        writes.length === 0
          ? Effect.void
          : attempt("writeAll", async () => {
              await db.batch(
                writes.map((write) => ({ sql: write.sql, args: [...write.params] })),
                "immediate"
              )
            }),
      migrationsApplied,
      stateMigrationsApplied,
      hasState: state !== undefined
    }
    return service
  })

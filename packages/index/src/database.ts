import { mkdir, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { DatabaseSync } from "node:sqlite"

import { StorageFailure } from "@memhtml/contracts/errors"
import { cosineDistance } from "@memhtml/domain"
import { Context, Effect, Schedule } from "effect"

/** The driver handle. Node's own SQLite, so there is no third-party database dependency. */
type Database = DatabaseSync

/**
 * How long a writer waits for the write lock before giving up.
 *
 * SQLite in WAL mode admits one writer at a time and any number of concurrent readers, and a
 * second writer BLOCKS for this long rather than failing immediately. That is the whole of the
 * concurrency story: the fleet runs many short-lived CLI invocations plus a long-lived MCP
 * server against one store, and they serialize by waiting. Zero here would turn every overlap
 * into `SQLITE_BUSY`.
 */
const BUSY_TIMEOUT_MS = 5_000

/**
 * A `Float32Array` over stored bytes, copying only when it must.
 *
 * `Float32Array` requires a 4-byte-aligned `byteOffset`, and a driver row's `Uint8Array` may be
 * a view into a pooled buffer at any offset. Viewing in place is the common case and costs
 * nothing; a misaligned or ragged blob is copied rather than refused, because the vector arm's
 * job is to rank and a throw here would fail a whole search over one row.
 */
const float32View = (bytes: Uint8Array): Float32Array | undefined => {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return undefined
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

/**
 * Register `vector_distance_cos(a, b)` — cosine distance over two float32 blobs.
 *
 * SQLite ships no vector functions, so the vector retrieval arm's distance is this. It is
 * `@memhtml/domain`'s `cosineDistance`, not a second implementation: the MMR pass already
 * decodes the same blobs and calls the same function in TypeScript, and two copies of this
 * arithmetic could disagree about a clamp or a zero-magnitude vector while both looked right.
 *
 * `deterministic` lets the planner treat it as a pure function of its arguments, which it is.
 *
 * Exact brute force over every candidate row: measured 79 ms for 10k × 1024-dim vectors at
 * top-40 (probed 2026-08-12 on node 24.19.0), against a Bedrock query-embedding round trip of
 * a few hundred milliseconds that every vector search pays first. An approximate index buys
 * nothing until the corpus is an order of magnitude larger.
 */
const registerVectorDistance = (db: Database): void => {
  db.function("vector_distance_cos", { deterministic: true }, (a: unknown, b: unknown) => {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return null
    const left = float32View(a)
    const right = float32View(b)
    return left === undefined || right === undefined ? null : cosineDistance(left, right)
  })
}

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
  /**
   * Apply a whole SQL script — many statements, no parameters — in ONE transaction.
   *
   * This is the migration primitive, exposed because a caller applying migration files must use
   * the same one the runner does. Whether a `DROP TABLE`'s cascade is contained by that
   * transaction is exactly the kind of fact a per-statement loop would answer differently.
   */
  readonly script: (sql: string) => Effect.Effect<void, StorageFailure>
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

/**
 * SQLite's `SQLITE_BUSY`. Surfaced by node:sqlite as `errcode: 5` with `"database is locked"`.
 *
 * Matched on the numeric code rather than the message, which is prose and localizable.
 */
const SQLITE_BUSY = 5

/**
 * True when a thrown driver value is `SQLITE_BUSY` — the write lock was unavailable, so the
 * statement did NOT run and may be retried.
 *
 * Exported because it is the load-bearing half of {@link BUSY_BACKOFF}: a retry whose predicate
 * never matches is a retry that does nothing, and nothing else in the suite would notice. Its test
 * captures a REAL contended write rather than constructing an error object, since what this has to
 * agree with is the shape node:sqlite actually throws.
 */
export const isBusyCause = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { errcode?: unknown }).errcode === SQLITE_BUSY

class DriverRejection {
  readonly _tag = "DriverRejection"
  readonly detail: string
  readonly busy: boolean
  constructor(
    readonly operation: string,
    cause: unknown
  ) {
    this.detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    this.busy = isBusyCause(cause)
  }
}

/**
 * Backoff for a contended write.
 *
 * `busy_timeout` covers a short wait inside one call, and stops covering anything past its
 * deadline — a probe against a held `BEGIN IMMEDIATE` throws `database is locked` rather than
 * queueing indefinitely. This deployment has many short-lived CLI processes plus a nightly cron
 * writing to one file, and **Effect coordinates nothing across processes**, so the driver's
 * timeout plus this retry is the whole of the answer.
 *
 * Jittered because the contending processes are cron-triggered and would otherwise retry in
 * lockstep; v4's `jittered` scales each delay by a random 0.8–1.2.
 *
 * Retrying is safe precisely BECAUSE the error is `SQLITE_BUSY`: the lock was never taken, so the
 * statement had no effect to half-apply. A write inside {@link transact} rolls back before the
 * retry, so the transaction is re-run whole rather than resumed.
 */
const BUSY_BACKOFF = Schedule.exponential("15 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ duration: "20 seconds" })
)

/**
 * Wraps a driver rejection as a typed failure. The typed error carries only the
 * operation name so SQL parameters and memory contents never reach a tool response;
 * the driver's own message is logged for operators instead of being dropped.
 */
const asStorageFailure = <A>(operation: string, effect: Effect.Effect<A, DriverRejection>) =>
  effect.pipe(
    Effect.tapError((error) => Effect.logError(`db.${operation} failed: ${error.detail}`)),
    Effect.mapError((error) => StorageFailure.make({ operation: error.operation })),
    Effect.withSpan(`db.${operation}`)
  )

/** For the asynchronous edges, which here are all filesystem calls. */
const attempt = <A>(operation: string, thunk: () => Promise<A>) =>
  asStorageFailure(
    operation,
    Effect.tryPromise({ try: thunk, catch: (cause) => new DriverRejection(operation, cause) })
  )

/**
 * For driver calls, which are synchronous — `DatabaseSync` does its work on the calling thread.
 *
 * `Effect.try` rather than `Effect.tryPromise` is what keeps that honest. A promise per query
 * would add a microtask hop and a wrapper allocation to the hottest path in the system, and
 * would tell a reader the query yields to the event loop when it does not.
 */
const attemptSync = <A>(operation: string, thunk: () => A) =>
  asStorageFailure(
    operation,
    Effect.retry(
      Effect.try({ try: thunk, catch: (cause) => new DriverRejection(operation, cause) }),
      { while: (error) => error.busy, schedule: BUSY_BACKOFF }
    )
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
    yield* attemptSync("migrate.init", () => db.exec(migrationsTable(ledger)))

    const files = yield* attempt("migrate.scan", async () => {
      const entries = await readdir(migrationsDir)
      return entries.filter((file) => file.endsWith(".sql")).sort()
    })

    const applied = yield* attemptSync("migrate.applied", () =>
      db.prepare(`SELECT name FROM ${ledger}`).all()
    )
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
      yield* attempt("migrate.apply", async () => {
        transact(db, () => {
          db.exec(sql)
          db.prepare(`INSERT INTO ${ledger}(name, applied_at) VALUES(?, ?)`).run(
            file,
            new Date().toISOString()
          )
        })
      })
      yield* Effect.log(`applied migration ${file}`)
      count += 1
    }

    return count
  })

/**
 * Run `body` inside one `IMMEDIATE` transaction: it commits, or nothing it did happened.
 *
 * `IMMEDIATE` takes the write lock up front rather than on the first write, so a writer that
 * cannot have the lock waits out `BUSY_TIMEOUT_MS` here instead of half-way through and having
 * to unwind. SQLite makes DDL transactional, which is what lets a migration file's `CREATE`s
 * and its ledger row commit together — a crash mid-file leaves the migration unapplied and
 * unrecorded rather than half-applied.
 *
 * The rollback is best-effort on purpose: if the transaction is already gone the original
 * failure is the one worth reporting, and a throw from `ROLLBACK` would replace it.
 */
const transact = (db: Database, body: () => void): void => {
  db.exec("BEGIN IMMEDIATE")
  try {
    body()
    db.exec("COMMIT")
  } catch (cause) {
    try {
      db.exec("ROLLBACK")
    } catch {}
    throw cause
  }
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
 * already in use" — so this is called exactly once per connection, by {@link makeDatabase}.
 */
export const attachState = (db: Database, statePath: string, migrationsDir: string) =>
  Effect.gen(function* () {
    if (statePath !== ":memory:") {
      yield* attempt("state.mkdir", () => mkdir(dirname(statePath), { recursive: true }))
    }
    yield* attempt("state.attach", async () => {
      db.prepare("ATTACH ? AS state").run(statePath)
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
    /**
     * `acquireDisposable` rather than `acquireRelease`: `DatabaseSync` implements `Symbol.dispose`
     * (verified on node 24.19.0), so the scope closes the handle through the language's own
     * protocol and there is no hand-written release to drift from `close()`.
     */
    const db = yield* Effect.acquireDisposable(
      Effect.gen(function* () {
        if (databasePath !== ":memory:") {
          yield* attempt("mkdir", () => mkdir(dirname(databasePath), { recursive: true }))
        }
        return yield* attemptSync(
          "connect",
          () => new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS })
        )
      })
    )

    /**
     * WAL is what lets readers run while a writer holds the lock, and it is a persistent
     * property of the file rather than of the connection — setting it every open is harmless and
     * means a database created by any caller ends up in the same mode. `NORMAL` synchronous is
     * the standard WAL pairing: a power loss can cost the last commits, which for a projection
     * rebuildable from the git tree is not a durability question.
     */
    yield* attempt("pragmas", async () => {
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA synchronous = NORMAL")
      db.exec("PRAGMA foreign_keys = ON")
    })
    registerVectorDistance(db)
    const migrationsApplied = yield* runMigrations(db, migrationsDir)
    const stateMigrationsApplied =
      state === undefined ? 0 : yield* attachState(db, state.path, state.migrationsDir)

    const service: DatabaseShape = {
      run: (sql, params = []) =>
        attemptSync("run", () => {
          db.prepare(sql).run(...params)
        }),
      /**
       * Rows come back as null-prototype records of `SQLOutputValue`, and the caller names the
       * shape it expects. The cast is the seam where an untyped driver row becomes a typed row,
       * exactly as it was with the previous driver: the SQL and the type parameter are written
       * together, and no runtime check here could tell a wrong column name from a right one.
       */
      get: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
        attemptSync("get", () => db.prepare(sql).get(...params) as A | undefined),
      all: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
        attemptSync("all", () => db.prepare(sql).all(...params) as unknown as ReadonlyArray<A>),
      /**
       * One transaction, and one prepared statement per DISTINCT sql in the batch.
       *
       * The indexer's batches are thousands of rows through a handful of statements, so
       * preparing per row would pay the parse cost once per row for no benefit. Grouping by sql
       * text keeps the cache batch-local: it cannot grow without bound the way a connection-wide
       * cache would under the retrieval assembler's per-scope query shapes.
       */
      writeAll: (writes) =>
        writes.length === 0
          ? Effect.void
          : attemptSync("writeAll", () => {
              const prepared = new Map<string, ReturnType<Database["prepare"]>>()
              transact(db, () => {
                for (const write of writes) {
                  let statement = prepared.get(write.sql)
                  if (statement === undefined) {
                    statement = db.prepare(write.sql)
                    prepared.set(write.sql, statement)
                  }
                  statement.run(...write.params)
                }
              })
            }),
      script: (sql) =>
        attemptSync("script", () => {
          transact(db, () => db.exec(sql))
        }),
      migrationsApplied,
      stateMigrationsApplied,
      hasState: state !== undefined
    }
    return service
  })

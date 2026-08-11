/**
 * Probe 2: isolate the Turso FTS-index insert cost on `files`.
 *
 * Fills `files` to N rows, creates the FTS index, then measures at that size:
 *   a. inserting 256 rows through the live FTS index (what indexer.update does today)
 *   b. DROP INDEX, insert 256 rows, CREATE INDEX (the rebuild trick, applied incrementally)
 *   c. a single-row insert through the live index (the interactive write path)
 *
 * node tests-integration/probe-fts-cost.mjs [--sizes 1000,5000,10000]
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MIGRATIONS_DIR, makeDatabase } from "@memhtml/index"
import { Effect } from "effect"

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6

const fileRow = (i, tag) => ({
  sql: `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text, fts_text,
          para, created_at, updated_at, indexed_at)
        VALUES (?, ?, ?, 'semantic', ?, ?, ?, 'areas',
          '2026-08-05T00:00:00Z', '2026-08-05T00:00:00Z', '2026-08-05T00:00:00Z')
        ON CONFLICT(path) DO NOTHING`,
  params: [
    `areas/inbox/${tag}-${i}.html`,
    `sha-${tag}-${i}`,
    `hash-${tag}-${i}`,
    `memory ${tag} ${i}`,
    `probe fact body ${tag} ${i}`,
    `memory ${tag} ${i}\nprobe fact ${tag} ${i}: searchable text about topic ${i % 97} and entity ${i % 31}`
  ]
})

const insertRows = (db, rows) =>
  Effect.gen(function* () {
    for (let at = 0; at < rows.length; at += 200) {
      yield* db.writeAll(rows.slice(at, at + 200))
    }
  })

const runSize = (size) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "memhtml-fts-probe-")))
    const db = yield* makeDatabase(join(dir, "index.db"), MIGRATIONS_DIR)

    // Fill to size with FTS dropped (fast), then create the index once — mirrors rebuild.
    yield* db.run("DROP INDEX IF EXISTS files_fts")
    const fill = Array.from({ length: size }, (_, i) => fileRow(i, "seed"))
    const t0 = process.hrtime.bigint()
    yield* insertRows(db, fill)
    const fillMs = ms(t0)
    const t1 = process.hrtime.bigint()
    yield* db.run("CREATE INDEX files_fts ON files USING fts(fts_text)")
    const createMs = ms(t1)

    // a. 256 rows through the live index
    const t2 = process.hrtime.bigint()
    yield* insertRows(db, Array.from({ length: 256 }, (_, i) => fileRow(i, "live")))
    const liveMs = ms(t2)

    // b. drop, 256 rows, recreate
    const t3 = process.hrtime.bigint()
    yield* db.run("DROP INDEX files_fts")
    yield* insertRows(db, Array.from({ length: 256 }, (_, i) => fileRow(i, "drop")))
    yield* db.run("CREATE INDEX files_fts ON files USING fts(fts_text)")
    const dropMs = ms(t3)

    // c. one row through the live index
    const t4 = process.hrtime.bigint()
    yield* db.writeAll([fileRow(0, "single")])
    const singleMs = ms(t4)

    console.log(
      `size=${String(size).padEnd(6)} fill(noFTS)=${fillMs.toFixed(0)}ms  create=${createMs.toFixed(0)}ms  live256=${liveMs.toFixed(0)}ms  drop+256+create=${dropMs.toFixed(0)}ms  live1=${singleMs.toFixed(1)}ms`
    )
  })

const sizes = (() => {
  const at = process.argv.indexOf("--sizes")
  return (at !== -1 ? process.argv[at + 1] : "1000,5000,10000").split(",").map(Number)
})()

await Effect.runPromise(
  Effect.gen(function* () {
    for (const size of sizes) yield* Effect.scoped(runSize(size))
  })
)

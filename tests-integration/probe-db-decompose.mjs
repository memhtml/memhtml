/**
 * Probe 3: decompose db.writeAll inside indexer.update by SQL statement shape.
 *
 * MANUAL measurement rig — no task, workflow, or test tier runs this; a human runs it by
 * hand when db.writeAll's per-statement cost is in question, and the docs cite its
 * numbers. Lint covers it; typecheck and CI do not.
 *
 * Same harness as probe-write-cost.mjs at one store size, but the database's writeAll
 * executes each write individually (db.run) with time bucketed by statement prefix.
 * Transaction semantics differ from db.batch — the point is the RELATIVE scaling of
 * statement kinds across store sizes, not the absolute total.
 *
 * Run from repo root after `pnpm build`:
 *   node tests-integration/probe-db-decompose.mjs [--sizes 1000,5000] [--batch 256]
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { StorageFailure } from "@memhtml/contracts/errors"
import { renderTemplate } from "@memhtml/html"
import {
  MIGRATIONS_DIR,
  makeDatabase,
  makeGitPort,
  makeIndexer,
  makeIndexRecorder,
  STATE_MIGRATIONS_DIR
} from "@memhtml/index"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import {
  INDEX_DB_PATH,
  initRepo,
  isoSecond,
  makeGit,
  makeStore,
  STATE_DB_PATH
} from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect } from "effect"

const buckets = new Map()
const bucketOf = (sql) => sql.replace(/\s+/g, " ").trim().slice(0, 60)
const ms = (ns) => Number(ns) / 1e6

const seedFile = (i) =>
  renderTemplate({
    title: `seed memory ${i}`,
    claim: `Seed fact number ${i}: a unique pre-existing memory occupying the inbox directory.`,
    memoryType: "semantic",
    at: isoSecond(Date.now())
  })

const runSize = (storeSize, batchSize) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), `memhtml-probe3-${storeSize}-`))
    )
    const git = makeGit(root)
    yield* initRepo(git)
    yield* configureIdentity(git)

    yield* Effect.promise(() => mkdir(join(root, "areas/inbox"), { recursive: true }))
    yield* Effect.promise(async () => {
      for (let i = 0; i < storeSize; i += 1) {
        await writeFile(join(root, `areas/inbox/seed-${i}.html`), seedFile(i), "utf8")
      }
    })
    yield* git.run(["add", "-A"])
    yield* git.commit(`seed ${storeSize} files`)

    const db = yield* makeDatabase(join(root, INDEX_DB_PATH), MIGRATIONS_DIR, {
      path: join(root, STATE_DB_PATH),
      migrationsDir: STATE_MIGRATIONS_DIR
    })
    // Per-statement writeAll: one transaction per write, timed into buckets.
    const dbDecomposed = {
      ...db,
      writeAll: (writes) =>
        Effect.gen(function* () {
          for (const write of writes) {
            const t0 = process.hrtime.bigint()
            yield* db.run(write.sql, write.params)
            const key = bucketOf(write.sql)
            const entry = buckets.get(key) ?? { calls: 0, ns: 0n }
            entry.calls += 1
            entry.ns += process.hrtime.bigint() - t0
            buckets.set(key, entry)
          }
        })
    }
    const recorder = makeIndexRecorder(db)
    const store = makeStore(git, { dedupeLookup: recorder.activePathForHash })
    const port = makeGitPort({
      git,
      readFile: (path) =>
        Effect.tryPromise({
          try: () => readFile(join(root, path), "utf8"),
          catch: (cause) => cause
        }),
      fail: (operation) => Effect.fail(StorageFailure.make({ operation: `git.${operation}` }))
    })
    const indexer = makeIndexer({
      db: dbDecomposed,
      git: port,
      embedWatermark: EMBED_WATERMARK,
      embedDim: EMBED_DIM,
      embeddings: undefined,
      now: () => new Date().toISOString()
    })
    yield* indexer.rebuild({ embed: false })
    buckets.clear() // rebuild writes are not the question

    const at = isoSecond(Date.now())
    const inputs = Array.from({ length: batchSize }, (_, i) => ({
      title: `probe s${storeSize} op ${i}`,
      claim: `Probe fact s${storeSize}-${i}: the write path cost model measurement sentence ${i}.`,
      memoryType: "semantic",
      at
    }))
    yield* store.writeMemories(inputs)

    const t0 = process.hrtime.bigint()
    yield* indexer.update({ embed: false })
    const total = ms(process.hrtime.bigint() - t0)

    console.log(
      `\n=== store=${storeSize} batch=${batchSize}  update total ${total.toFixed(0)}ms (per-stmt txns) ===`
    )
    const sorted = [...buckets].sort((a, b) => Number(b[1].ns - a[1].ns))
    for (const [key, entry] of sorted.slice(0, 12)) {
      console.log(
        `  ${ms(entry.ns).toFixed(0).padStart(7)}ms x${String(entry.calls).padEnd(5)} ${key}`
      )
    }
    buckets.clear()
    yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
  })

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}
const sizes = arg("sizes", "1000,5000").split(",").map(Number)
const batch = Number(arg("batch", "256"))

await Effect.runPromise(
  Effect.gen(function* () {
    for (const size of sizes) yield* Effect.scoped(runSize(size, batch))
  })
)

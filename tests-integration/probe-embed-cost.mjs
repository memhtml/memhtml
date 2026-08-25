/**
 * Probe: where does the embed lane's store-scaled per-batch cost live?
 *
 * MANUAL measurement rig — no task, workflow, or test tier runs this; a human runs it by
 * hand when the embed lane's cost model is in question, and the docs cite its numbers.
 * Lint covers it; typecheck and CI do not.
 *
 * The 2026-08-05 eval ingest (embeddings ON) grew 45s → ~5.5min per 256-op batch over
 * 72 batches while the same path with embeddings OFF measured flat after bd54b6b. The
 * suspects, in the order that ingest implicated them:
 *
 *   1. embedMissing's pending scan — `chunks LEFT JOIN embeddings WHERE e.chunk_id IS
 *      NULL OR e.model <> ?`, a full chunks-table scan per batch
 *   2. db.writeAll inflation with table size (probed once: 2.5s → 22s, saturating)
 *   3. the embed model call itself (constant per batch — a control, not a suspect)
 *
 * Same rig as probe-write-cost.mjs but with a deterministic local embedder, so every
 * millisecond is store-scaled work rather than Bedrock latency. Run from repo root
 * after `pnpm build`:
 *   node tests-integration/probe-embed-cost.mjs [--sizes 1000,5000,10000] [--batch 256] [--rounds 2]
 *
 * Safe to run beside a live `memhtml serve mcp`: it builds its own temp store and never touches
 * yours. What it must not share is a store, since its numbers are of an uncontended writer.
 */
import { createHash } from "node:crypto"
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

// ---------- timing ----------

const stats = new Map()
const record = (name, ns) => {
  const entry = stats.get(name) ?? { calls: 0, ns: 0n }
  entry.calls += 1
  entry.ns += ns
  stats.set(name, entry)
}
const snapshot = () => new Map([...stats].map(([k, v]) => [k, { ...v }]))
const diffSince = (before) => {
  const out = new Map()
  for (const [k, v] of stats) {
    const prev = before.get(k) ?? { calls: 0, ns: 0n }
    const calls = v.calls - prev.calls
    const ns = v.ns - prev.ns
    if (calls > 0 || ns > 0n) out.set(k, { calls, ns })
  }
  return out
}
const ms = (ns) => Number(ns) / 1e6

const wrapEffect =
  (name, fn) =>
  (...args) =>
    Effect.suspend(() => {
      const t0 = process.hrtime.bigint()
      return fn(...args).pipe(
        Effect.ensuring(Effect.sync(() => record(name, process.hrtime.bigint() - t0)))
      )
    })

// ---------- deterministic embedder ----------

/** Cheap, pure, EMBED_DIM-wide. The vector's content is irrelevant here; only cost shape matters. */
const fakeVector = (text) => {
  const vector = new Float32Array(EMBED_DIM)
  const digest = createHash("sha256").update(text, "utf8").digest()
  for (let i = 0; i < 16; i += 1) {
    vector[digest.readUInt16BE(i) % EMBED_DIM] = 1
  }
  return vector
}
const makeEmbedder = () => ({
  embed: wrapEffect("embed.call", (texts) => Effect.sync(() => texts.map(fakeVector)))
})

// ---------- probe corpus ----------

const batchInputs = (tag, count) =>
  Array.from({ length: count }, (_, i) => ({
    title: `probe ${tag} op ${i}`,
    claim: `Probe fact ${tag}-${i}: the embed lane cost model measurement sentence number ${i} for round ${tag}.`,
    memoryType: "semantic"
  }))

const seedFile = (i) =>
  renderTemplate({
    title: `seed memory ${i}`,
    claim: `Seed fact number ${i}: a unique pre-existing memory occupying the inbox directory.`,
    memoryType: "semantic",
    at: isoSecond(Date.now())
  })

// ---------- one store size ----------

const runSize = (storeSize, batchSize, rounds) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), `memhtml-eprobe-${storeSize}-`))
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
    /** Tag the pending scan apart from every other read on the same connection. */
    const dbTimed = {
      ...db,
      // Split writeAll by lane: the embeddings upsert batch never touches the FTS-indexed
      // `files` table, so if growth lives only in the projection lane the index is the term.
      writeAll: (writes) =>
        wrapEffect(
          writes.every((w) => w.sql.includes("INTO embeddings"))
            ? "db.writeAll.embedlane"
            : "db.writeAll.projlane",
          db.writeAll
        )(writes),
      all: (sql, params) =>
        wrapEffect(
          sql.includes("LEFT JOIN embeddings") ? "db.all.pending" : "db.all.other",
          db.all
        )(sql, params),
      get: (sql, params) =>
        wrapEffect(
          sql.includes("count(*)") && sql.includes("embeddings")
            ? "db.get.gapcount"
            : "db.get.other",
          db.get
        )(sql, params)
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
      db: dbTimed,
      git: port,
      embedWatermark: EMBED_WATERMARK,
      embedDim: EMBED_DIM,
      embeddings: makeEmbedder(),
      now: () => new Date().toISOString()
    })

    // Rebuild WITH embeddings: the steady state is "everything before this batch has a vector".
    const rebuildT0 = process.hrtime.bigint()
    yield* indexer.rebuild({ embed: true })
    const rebuildMs = ms(process.hrtime.bigint() - rebuildT0)
    console.log(`\n=== store=${storeSize}  (rebuild+embed ${rebuildMs.toFixed(0)}ms) ===`)

    const rows = []
    for (let round = 0; round < rounds; round += 1) {
      const inputs = batchInputs(`s${storeSize}r${round}`, batchSize)
      yield* store.writeMemories(inputs)

      const before = snapshot()
      const updateT0 = process.hrtime.bigint()
      // What this rig measures is the pending-scan term. The lexical index is not a variable here:
      // FTS5 is maintained by triggers and its insert cost is linear in the batch rather than in
      // the store, measured flat at 6/5/6/5/5/5 ms over six consecutive 256-op batches against a
      // 10k-file store (2026-08-12), so there is nothing to A/B against it.
      const report = yield* indexer.update({ embed: true })
      const updateMs = ms(process.hrtime.bigint() - updateT0)
      const delta = diffSince(before)

      const pick = (name) => delta.get(name) ?? { calls: 0, ns: 0n }
      const row = {
        store: storeSize + round * batchSize,
        round,
        updateMs,
        embedded: report.embeddingsWritten,
        pendingMs: ms(pick("db.all.pending").ns),
        pendingCalls: pick("db.all.pending").calls,
        projMs: ms(pick("db.writeAll.projlane").ns),
        projCalls: pick("db.writeAll.projlane").calls,
        embedLaneMs: ms(pick("db.writeAll.embedlane").ns),
        embedLaneCalls: pick("db.writeAll.embedlane").calls,
        embedMs: ms(pick("embed.call").ns),
        gapcountMs: ms(pick("db.get.gapcount").ns),
        otherAllMs: ms(pick("db.all.other").ns)
      }
      rows.push(row)
      console.log(
        `  round=${round} update=${updateMs.toFixed(0)}ms  embedded=${row.embedded}  ` +
          `pending=${row.pendingMs.toFixed(0)}ms x${row.pendingCalls}  ` +
          `proj=${row.projMs.toFixed(0)}ms x${row.projCalls}  ` +
          `embedlane=${row.embedLaneMs.toFixed(0)}ms x${row.embedLaneCalls}  ` +
          `embed=${row.embedMs.toFixed(0)}ms`
      )
    }

    yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    return rows
  })

// ---------- main ----------

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}
const sizes = arg("sizes", "1000,5000,10000").split(",").map(Number)
const batch = Number(arg("batch", "256"))
const rounds = Number(arg("rounds", "2"))

const program = Effect.gen(function* () {
  const all = []
  for (const size of sizes) {
    const rows = yield* Effect.scoped(runSize(size, batch, rounds))
    all.push(...rows)
  }
  console.log("\n=== summary (ms per update, embeddings on) ===")
  console.log("store   update   pending(calls)  proj(calls)     embedlane(calls)  embed")
  for (const r of all) {
    console.log(
      `${String(r.store).padEnd(7)} ${r.updateMs.toFixed(0).padEnd(8)} ` +
        `${`${r.pendingMs.toFixed(0)} (${r.pendingCalls})`.padEnd(15)} ` +
        `${`${r.projMs.toFixed(0)} (${r.projCalls})`.padEnd(15)} ` +
        `${`${r.embedLaneMs.toFixed(0)} (${r.embedLaneCalls})`.padEnd(17)} ` +
        `${r.embedMs.toFixed(0)}`
    )
  }
})

await Effect.runPromise(program)

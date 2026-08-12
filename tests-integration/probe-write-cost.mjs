/**
 * Probe: where does the per-op store-scaled write cost live?
 *
 * Seeds a temp store with N files CHEAPLY (direct file writes, one commit, one rebuild),
 * then drives 256-op batches through the REAL composition — makeStore over an instrumented
 * GitShape, makeIndexer over an instrumented git port — and times each suspect separately:
 *
 *   1. freePathFor disk probes  (residual of writeMemories after git + dedupe + render)
 *   2. git staging/commit walks (git.add + git.commit, per batch)
 *   3. indexer.update() diff    (port.diffNameStatus / statusPorcelainV2 / lsTreeR /
 *                                catFileBatch / readFile, db.writeAll)
 *
 * Run from repo root after `pnpm build`:
 *   node tests-integration/probe-write-cost.mjs [--sizes 1000,5000,10000] [--batch 256]
 *
 * Safe to run beside a live `memhtml serve mcp`: it builds its own temp store and never touches
 * yours. What it must not share is a store, since its numbers are of an uncontended writer.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { StorageFailure } from "@memhtml/contracts/errors"
import { renderTemplate } from "@memhtml/html"
import {
  MIGRATIONS_DIR,
  STATE_MIGRATIONS_DIR,
  makeDatabase,
  makeGitPort,
  makeIndexRecorder,
  makeIndexer
} from "@memhtml/index"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { INDEX_DB_PATH, STATE_DB_PATH, initRepo, isoSecond, makeGit, makeStore } from "@memhtml/store"
import { configureIdentity } from "@memhtml/store/testing"
import { Effect } from "effect"

// ---------- timing ----------

/** name -> { calls, ns }. Snapshot + diff between phases. */
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

const wrapEffect = (name, fn) =>
  (...args) =>
    Effect.suspend(() => {
      const t0 = process.hrtime.bigint()
      return fn(...args).pipe(
        Effect.ensuring(Effect.sync(() => record(name, process.hrtime.bigint() - t0)))
      )
    })

/** Wrap every function-valued property of a service object with a timer. */
const instrument = (prefix, service) => {
  const out = {}
  for (const [key, value] of Object.entries(service)) {
    out[key] = typeof value === "function" ? wrapEffect(`${prefix}.${key}`, value) : value
  }
  return out
}

// ---------- probe corpus ----------

/** Unique, non-dedupable inputs. Placement: no workspace/tags -> areas/inbox (the crowded dir). */
const batchInputs = (tag, count) =>
  Array.from({ length: count }, (_, i) => ({
    title: `probe ${tag} op ${i}`,
    claim: `Probe fact ${tag}-${i}: the write path cost model measurement sentence number ${i} for round ${tag}.`,
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

const runSize = (storeSize, batchSizes) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), `memhtml-probe-${storeSize}-`)))
    const rawGit = makeGit(root)
    const git = instrument("git", rawGit)
    yield* initRepo(git)
    yield* configureIdentity(rawGit)

    // Seed: direct writes, ONE add, ONE commit — bypasses the quadratic on purpose.
    const seedT0 = process.hrtime.bigint()
    yield* Effect.promise(() => mkdir(join(root, "areas/inbox"), { recursive: true }))
    yield* Effect.promise(async () => {
      for (let i = 0; i < storeSize; i += 1) {
        await writeFile(join(root, `areas/inbox/seed-${i}.html`), seedFile(i), "utf8")
      }
    })
    yield* rawGit.run(["add", "-A"])
    yield* rawGit.commit(`seed ${storeSize} files`)
    const seedMs = ms(process.hrtime.bigint() - seedT0)

    const db = yield* makeDatabase(join(root, INDEX_DB_PATH), MIGRATIONS_DIR, {
      path: join(root, STATE_DB_PATH),
      migrationsDir: STATE_MIGRATIONS_DIR
    })
    const dbTimed = { ...db, writeAll: wrapEffect("db.writeAll", db.writeAll) }
    const recorder = makeIndexRecorder(db)
    const store = makeStore(git, {
      dedupeLookup: wrapEffect("dedupeLookup", recorder.activePathForHash)
    })
    const port = makeGitPort({
      git,
      readFile: wrapEffect("port.readFile", (path) =>
        Effect.tryPromise({
          try: () => readFile(join(root, path), "utf8"),
          catch: (cause) => cause
        })
      ),
      fail: (operation) => Effect.fail(StorageFailure.make({ operation: `git.${operation}` }))
    })
    const indexer = makeIndexer({
      db: dbTimed,
      git: port,
      embedWatermark: EMBED_WATERMARK,
      embedDim: EMBED_DIM,
      embeddings: undefined,
      now: () => new Date().toISOString()
    })

    const rebuildT0 = process.hrtime.bigint()
    yield* indexer.rebuild({ embed: false })
    const rebuildMs = ms(process.hrtime.bigint() - rebuildT0)
    console.log(
      `\n=== store=${storeSize}  (seed ${seedMs.toFixed(0)}ms, rebuild ${rebuildMs.toFixed(0)}ms) ===`
    )

    const rows = []
    for (const [round, batchSize] of batchSizes.entries()) {
      const inputs = batchInputs(`s${storeSize}r${round}`, batchSize)

      // Render estimate: what renderChecked costs, measured on identical inputs outside the store.
      const renderT0 = process.hrtime.bigint()
      const at = isoSecond(Date.now())
      for (const input of inputs) renderTemplate({ ...input, at })
      const renderMs = ms(process.hrtime.bigint() - renderT0)

      const beforeWrite = snapshot()
      const writeT0 = process.hrtime.bigint()
      const batch = yield* store.writeMemories(inputs)
      const writeMs = ms(process.hrtime.bigint() - writeT0)
      const writeStats = diffSince(beforeWrite)

      const beforeUpdate = snapshot()
      const updateT0 = process.hrtime.bigint()
      const report = yield* indexer.update({ embed: false })
      const updateMs = ms(process.hrtime.bigint() - updateT0)
      const updateStats = diffSince(beforeUpdate)

      const pick = (map, name) => map.get(name) ?? { calls: 0, ns: 0n }
      const gitAdd = pick(writeStats, "git.add")
      const gitCommit = pick(writeStats, "git.commit")
      const dedupe = pick(writeStats, "dedupeLookup")
      const residual =
        writeMs - ms(gitAdd.ns) - ms(gitCommit.ns) - ms(dedupe.ns)

      console.log(
        `\n--- batch=${batchSize} written=${batch.summary.written} indexed(a/m)=${report.added}/${report.modified} ---`
      )
      console.log(`writeMemories total ${writeMs.toFixed(1)}ms`)
      console.log(`  git.add        ${ms(gitAdd.ns).toFixed(1)}ms x${gitAdd.calls}`)
      console.log(`  git.commit     ${ms(gitCommit.ns).toFixed(1)}ms x${gitCommit.calls}`)
      console.log(`  dedupeLookup   ${ms(dedupe.ns).toFixed(1)}ms x${dedupe.calls}`)
      console.log(
        `  residual       ${residual.toFixed(1)}ms  (render+hash+freePathFor+fs; render alone ~${renderMs.toFixed(1)}ms)`
      )
      console.log(`indexer.update total ${updateMs.toFixed(1)}ms`)
      for (const name of [
        "git.diffNameStatus",
        "git.statusPorcelainV2",
        "git.lsTreeR",
        "git.catFileBatch",
        "git.hashObject",
        "git.revParseHead",
        "port.readFile",
        "db.writeAll"
      ]) {
        const entry = pick(updateStats, name)
        if (entry.calls > 0)
          console.log(`  ${name.padEnd(22)} ${ms(entry.ns).toFixed(1)}ms x${entry.calls}`)
      }
      rows.push({
        store: storeSize,
        batch: batchSize,
        writeMs,
        updateMs,
        gitAddMs: ms(gitAdd.ns),
        gitCommitMs: ms(gitCommit.ns),
        dedupeMs: ms(dedupe.ns),
        residualMs: residual,
        renderMs,
        updateLsTreeMs: ms(pick(updateStats, "git.lsTreeR").ns),
        updateLsTreeCalls: pick(updateStats, "git.lsTreeR").calls,
        updateCatFileMs: ms(pick(updateStats, "git.catFileBatch").ns),
        updateStatusMs: ms(pick(updateStats, "git.statusPorcelainV2").ns),
        updateDiffMs: ms(pick(updateStats, "git.diffNameStatus").ns),
        updateDbMs: ms(pick(updateStats, "db.writeAll").ns)
      })
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
// Middle size also runs batch/4 and batch*4 to separate per-op from per-batch scaling.
const batchesFor = (size, index) =>
  sizes.length >= 2 && index === Math.floor(sizes.length / 2)
    ? [batch, Math.max(16, batch / 4), batch * 4]
    : [batch]

const program = Effect.gen(function* () {
  const all = []
  for (const [index, size] of sizes.entries()) {
    const rows = yield* Effect.scoped(runSize(size, batchesFor(size, index)))
    all.push(...rows)
  }
  console.log("\n=== summary (ms) ===")
  console.log(
    "store  batch  write  update  |  gitAdd  gitCommit  dedupe  residual  |  upd.lsTree(calls)  upd.catFile  upd.status  upd.diff  upd.db"
  )
  for (const r of all) {
    console.log(
      `${String(r.store).padEnd(6)} ${String(r.batch).padEnd(6)} ${r.writeMs.toFixed(0).padEnd(6)} ${r.updateMs.toFixed(0).padEnd(7)} |  ${r.gitAddMs.toFixed(0).padEnd(7)} ${r.gitCommitMs.toFixed(0).padEnd(10)} ${r.dedupeMs.toFixed(0).padEnd(7)} ${r.residualMs.toFixed(0).padEnd(9)} |  ${(r.updateLsTreeMs.toFixed(0) + " (" + r.updateLsTreeCalls + ")").padEnd(18)} ${r.updateCatFileMs.toFixed(0).padEnd(12)} ${r.updateStatusMs.toFixed(0).padEnd(11)} ${r.updateDiffMs.toFixed(0).padEnd(9)} ${r.updateDbMs.toFixed(0)}`
    )
  }
})

await Effect.runPromise(program)

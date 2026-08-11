#!/usr/bin/env node
// What a second opener of a live `.memhtml/index.db` can and cannot do.
//
// Run it rather than reasoning about it: this file exists because the same question was answered
// wrongly twice in one session, each time by probing a case that looked equivalent and was not.
// A second connection in the SAME process behaves nothing like one in a SECOND process, and the
// second process is the case every real consumer is in — `memhtml exec`, a sandboxed script, an eve
// agent, an integration test running beside `memhtml serve mcp`.
//
//   node scripts/probe-turso-locking.mjs
//
// Spawns a holder child that opens the database and keeps writing, then probes it from here.

import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"

// Resolve the driver through `@memhtml/index`, the package that declares it: under pnpm's strict
// node_modules a bare specifier does not resolve from `scripts/`, and hardcoding the .pnpm path
// would silently drift from the installed version.
const DRIVER_HOST = new URL("../packages/index/package.json", import.meta.url)
const require = createRequire(DRIVER_HOST)
const DRIVER = require.resolve("@tursodatabase/database")
const { connect } = await import(DRIVER)

// The flags `packages/index/src/database.ts:39` passes. Locking behaviour is flag-sensitive, so a
// probe run without them proves nothing about this repo.
const EXPERIMENTAL = ["index_method", "attach"]

const dir = mkdtempSync(join(tmpdir(), "memhtml-turso-probe-"))
const dbPath = join(dir, "probe.db")

const HOLDER = `
const { connect } = await import(${JSON.stringify(DRIVER)})
const db = await connect(${JSON.stringify(dbPath)}, { experimental: ${JSON.stringify(EXPERIMENTAL)} })
await db.exec("CREATE TABLE IF NOT EXISTS f (k TEXT PRIMARY KEY, v TEXT)")
await db.run("INSERT OR REPLACE INTO f VALUES (?,?)", "seed", "held")
process.send({ ready: true, journalMode: (await db.get("PRAGMA journal_mode"))?.journal_mode })
let n = 0
const tick = setInterval(() => { db.run("INSERT OR REPLACE INTO f VALUES (?,?)", "tick-" + n++, "v").catch(() => {}) }, 300)
process.on("message", async () => { clearInterval(tick); await db.close(); process.exit(0) })
`

const holder = spawn(process.execPath, ["--input-type=module", "-e", HOLDER], {
  stdio: ["ignore", "inherit", "inherit", "ipc"]
})
const journalMode = await new Promise((resolve) =>
  holder.once("message", (m) => resolve(m.journalMode))
)
console.log(`holder process is open and writing. journal_mode = ${journalMode}\n`)

const probe = async (label, path, opts) => {
  let db
  try {
    db = await connect(path, opts)
  } catch (e) {
    console.log(`  ${label}\n      OPEN FAILED: ${String(e.message).slice(0, 72)}`)
    return
  }
  const parts = []
  try {
    parts.push(`rows=${(await db.get("SELECT count(*) AS c FROM f"))?.c}`)
  } catch (e) {
    parts.push(`READ FAILED: ${String(e.message).slice(0, 40)}`)
  }
  for (const [what, sql] of [
    ["INSERT", "INSERT OR REPLACE INTO f VALUES ('probe','v')"],
    ["DROP", "DROP TABLE f"]
  ]) {
    try {
      await db.exec(sql)
      parts.push(`${what}=ALLOWED`)
    } catch (e) {
      parts.push(`${what}=refused`)
    }
  }
  console.log(`  ${label}\n      OPEN ok | ${parts.join(" | ")}`)
  await db.close()
}

console.log("SECOND PROCESS (this one), against the held database:")
await probe("default connect()", dbPath, { experimental: [...EXPERIMENTAL] })
await probe("readonly: true", dbPath, { readonly: true, experimental: [...EXPERIMENTAL] })

// `PRAGMA query_only` cannot help here: it is a statement, so it needs a connection first, and the
// open is what fails. Shown so nobody proposes it again.
await probe("query_only (needs an open first)", dbPath, { experimental: [...EXPERIMENTAL] })

// A plain copy of a live WAL database made by a non-writer cannot checkpoint, so it may be missing
// recent commits — the copy is a stale snapshot even when it opens.
const copy = join(dir, "copy.db")
copyFileSync(dbPath, copy)
if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${copy}-wal`)
chmodSync(copy, 0o444)
await probe("copy + chmod 0444 + readonly", copy, { readonly: true, experimental: [...EXPERIMENTAL] })

console.log("\nFRESHNESS of a readonly handle (does it track the writer?):")
const counts = []
for (const i of [0, 1, 2]) {
  if (i > 0) await new Promise((r) => setTimeout(r, 1500))
  const held = await connect(dbPath, { readonly: true, experimental: [...EXPERIMENTAL] })
  const first = (await held.get("SELECT count(*) AS c FROM f"))?.c
  await new Promise((r) => setTimeout(r, 1500))
  const second = (await held.get("SELECT count(*) AS c FROM f"))?.c
  await held.close()
  counts.push({ first, second })
  console.log(
    `  open #${i + 1}: ${first} rows, then ${second} rows 1.5s later on the SAME handle` +
      (second === first ? "  (pinned at open)" : "  (tracks the writer)")
  )
}
console.log(
  "  a fresh open sees more rows each time, so the snapshot is pinned per connection:\n" +
    `  ${counts.map((c) => c.first).join(" -> ")}`
)

console.log("\nSAME PROCESS, second handle beside a writer we own:")
const writer = await connect(join(dir, "same.db"), { experimental: [...EXPERIMENTAL] })
await writer.exec("CREATE TABLE IF NOT EXISTS f (k TEXT PRIMARY KEY, v TEXT)")
await probe("readonly: true (same process)", join(dir, "same.db"), {
  readonly: true,
  experimental: [...EXPERIMENTAL]
})
console.log("  ^ the flag is NOT enforced here. Same-process results do not transfer.")
await writer.close()

holder.send("stop")
await new Promise((r) => holder.once("exit", r))
rmSync(dir, { recursive: true, force: true })

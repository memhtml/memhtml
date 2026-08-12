/**
 * What a second process can do to a live store — measured, not remembered.
 *
 * Run it: `node scripts/probe-sqlite-concurrency.mjs`
 *
 * The question "can another process read/write this index while something else holds it" has been
 * answered wrongly here before, in both directions, each time by a probe that ran and printed
 * output. Two rules came out of that, and this script exists to obey both:
 *
 *   1. When a constraint is about a BOUNDARY — process, connection, privilege — the probe must cross
 *      that exact boundary. A second connection in the same process is evidence about something else.
 *   2. The probe must VARY the thing under test. The earlier rounds held the driver's configuration
 *      fixed and so could never discover that the configuration was the answer.
 *
 * So every case below names the boundary it crossed and the configuration it used, and the
 * configuration is a variable rather than a constant.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const dir = mkdtempSync(join(tmpdir(), "memhtml-concurrency-"))
const dbPath = join(dir, "probe.db")

/** A child process that opens the same file and reports what happened, as JSON on stdout. */
const CHILD = `
import { DatabaseSync } from "node:sqlite"
const [path, mode, timeout] = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o))
try {
  const db = new DatabaseSync(path, { timeout: Number(timeout), ...(mode === "readonly" ? { readOnly: true } : {}) })
  const read = db.prepare("SELECT count(*) AS n FROM t").get().n
  let write = "ok"
  try {
    db.exec("BEGIN IMMEDIATE")
    db.prepare("INSERT INTO t VALUES (?)").run(999)
    db.exec("COMMIT")
  } catch (error) { write = \`\${error.code ?? error.name}/errcode=\${error.errcode}: \${error.message}\` }
  db.close()
  out({ open: "ok", read, write })
} catch (error) { out({ open: \`\${error.code ?? error.name}/errcode=\${error.errcode}: \${error.message}\` }) }
`
const childPath = join(dir, "child.mjs")
writeFileSync(childPath, CHILD)

const child = (mode, timeout) => {
  const result = spawnSync(process.execPath, [childPath, dbPath, mode, String(timeout)], {
    encoding: "utf8"
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { open: `probe failed: ${result.stderr.trim().split("\n").at(-1)}` }
  }
}

const holder = new DatabaseSync(dbPath)
holder.exec("PRAGMA journal_mode = WAL")
holder.exec("CREATE TABLE t (x INTEGER)")
holder.prepare("INSERT INTO t VALUES (1)").run()

console.log(`boundary crossed: SEPARATE PROCESS. journal_mode=WAL. node ${process.version}\n`)

console.log("— while the holder is IDLE (no transaction open) —")
console.log("  default open, timeout=5000:", JSON.stringify(child("default", 5000)))
console.log("  readOnly open, timeout=5000:", JSON.stringify(child("readonly", 5000)))

holder.exec("BEGIN IMMEDIATE")
holder.prepare("INSERT INTO t VALUES (2)").run()

console.log("\n— while the holder HOLDS a write transaction —")
console.log("  default open, timeout=1 (gives up at once):", JSON.stringify(child("default", 1)))
console.log("  readOnly open, timeout=1:", JSON.stringify(child("readonly", 1)))
console.log(
  "\n  ^ a reader still reads its pre-transaction snapshot; a writer reports errcode=5"
)
console.log("    (SQLITE_BUSY), which is the code `isBusyCause` matches and the retry policy waits on.")

holder.exec("COMMIT")
console.log("\n— after the holder COMMITS —")
console.log("  default open, timeout=5000:", JSON.stringify(child("default", 5000)))

holder.close()
rmSync(dir, { recursive: true, force: true })

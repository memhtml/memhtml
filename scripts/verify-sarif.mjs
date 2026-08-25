/**
 * Prove a scanner actually produced a usable SARIF report.
 *
 *   node scripts/verify-sarif.mjs <path> [label]
 *
 * Every scanner in `mise run security` has its FINDINGS exit code swallowed (`|| true`,
 * `--exit-code 0`, `--exit-code=0`), because a non-zero exit kills the workflow step before
 * `upload-sarif` runs and throws away the finding detail that made the scan worth running. That
 * swallow also collapses two results which must never read alike: "scanned, found nothing" and
 * "crashed before writing anything". This is the discriminator, and it is ONE definition called by
 * five tasks — a check that can drift from the thing it checks is the defect it exists to prevent.
 *
 * `[ -s file ]` is not that check, and the incident says why. Observed 2026-08-18 on CI run
 * 32092649447: betterleaks exited 0 having written a TRUNCATED SARIF, and a truncated file is
 * non-empty — a 43-byte `{"runs":[{"tool":{"driver":{"name":"osv-sca` passes `-s` and parses as
 * nothing. `{"runs":[]}` passes `-s` too, and means the document carries no scan at all. semgrep has
 * its own version of the same shape: its formatter returns the literal string
 * `<ERROR: no SARIF output>` when the RPC that renders SARIF yields nothing, which is nine words of
 * non-empty file.
 *
 * So four properties are checked, each of them one that `upload-sarif` already requires — a report
 * this accepts is a report the upload accepts, so the check cannot refuse a scan the pipeline would
 * otherwise have shipped:
 *   - the file parses as JSON        the observed failure, and semgrep's sentinel string
 *   - `runs` is a non-empty array   a document with no scan in it
 *   - every run carries `results[]` an empty array means "found nothing"; a missing one means the
 *                                   run never got that far. Emitted unconditionally by all five:
 *                                   measured in `.sarif/osv.sarif` and `.sarif/betterleaks.sarif`,
 *                                   and source-pinned for the two Go scanners (grype builds
 *                                   `make([]*sarif.Result, 0)` "so we have at least an empty
 *                                   array"; trivy's go-sarif v2.3.3 `NewRun` seeds `Results:
 *                                   []*Result{}`, and neither tags the field `omitempty`)
 *   - every run names `tool.driver.name`  one upload carries all five reports and code scanning
 *                                   attributes each by that name, so an unnamed run lands nowhere
 *
 * Exit 0 when the report is usable, 1 with the reason on stderr when it is not, 2 on a usage error.
 */
import { readFileSync } from "node:fs"

const [path, label] = process.argv.slice(2)

if (path === undefined) {
  console.error("usage: node scripts/verify-sarif.mjs <path> [label]")
  process.exit(2)
}

const prefix = label === undefined || label === "" ? "verify-sarif" : label

/** Every rejection is fatal and says which property failed — the reason is the whole value here. */
const fail = (reason) => {
  console.error(
    `${prefix}: ${path} is not a usable SARIF report (${reason}) — the scan did NOT run`
  )
  process.exit(1)
}

let raw = ""
try {
  raw = readFileSync(path, "utf8")
} catch (error) {
  fail(`unreadable: ${error.code ?? error.message}`)
}

let sarif = {}
try {
  sarif = JSON.parse(raw)
} catch (error) {
  fail(`invalid JSON after ${raw.length} bytes: ${error.message}`)
}

if (!Array.isArray(sarif.runs) || sarif.runs.length === 0) fail("no runs[]")

// `offset` is 0-based within this document's runs — the position a reader needs to find the run.
for (const [offset, run] of sarif.runs.entries()) {
  if (!Array.isArray(run?.results)) fail(`runs[${offset}] carries no results[]`)
  const driver = run?.tool?.driver?.name
  if (typeof driver !== "string" || driver === "") fail(`runs[${offset}] names no tool.driver.name`)
}

const results = sarif.runs.reduce((total, run) => total + run.results.length, 0)
const tools = sarif.runs.map((run) => run.tool.driver.name).join(", ")
console.log(
  `${prefix}: ${path} is usable — ${sarif.runs.length} run(s) from ${tools}, ${results} result(s)`
)

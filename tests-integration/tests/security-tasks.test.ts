import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const MISE = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8")

/**
 * That `mise run security` can tell a clean scan from a scan that never happened.
 *
 * Every scanner's FINDINGS exit code is swallowed on purpose, because a non-zero exit kills the
 * workflow step before `upload-sarif` runs and throws away the finding detail that was the reason to
 * scan. The cost of that swallow is one collapsed distinction: "scanned, found nothing" and "crashed
 * before writing anything" arrive as the same status. Two things restore it, and this file gates
 * both — a `rm -f` of the report before the scan, and `scripts/verify-sarif.mjs` after it.
 *
 * The reason a test exists rather than a convention: nothing about a green `mise run security`
 * distinguishes a verified report from an unverified one, so a task that quietly loses its check
 * looks exactly like a task that kept it. Two measured failures say what the check has to catch:
 *   - a TRUNCATED report (CI run 32092649447, 2026-08-18) — 43 non-empty bytes that `[ -s ]` passes;
 *   - a STALE report — `.sarif/` is gitignored and survives between local runs, so a crashed scanner
 *     leaves the previous run's file answering for a scan this run never performed. Local only: CI
 *     checks out fresh. That is the worse direction, since the local gate is the one a developer
 *     trusts before pushing.
 */

/** One scanner's contract with `mise run security`. */
interface ScanClaim {
  /** The mise task, spelled as its `[tasks."…"]` header. */
  readonly task: string
  /** The SARIF it must delete first and prove afterwards, repo-relative. */
  readonly report: string
  /** The flag or idiom that swallows this scanner's findings exit code, which must stay. */
  readonly swallowsFindings: string
}

const SCANS: ReadonlyArray<ScanClaim> = [
  { task: "security:osv", report: ".sarif/osv.sarif", swallowsFindings: "|| true" },
  { task: "security:semgrep", report: ".sarif/semgrep.sarif", swallowsFindings: "|| true" },
  { task: "security:leaks", report: ".sarif/betterleaks.sarif", swallowsFindings: "--exit-code=0" },
  { task: "security:sbom", report: ".sarif/grype.sarif", swallowsFindings: "|| true" },
  { task: "security:trivy", report: ".sarif/trivy.sarif", swallowsFindings: "--exit-code 0" }
]

/**
 * The SHELL of one mise task — the body of its `run = """…"""`, with the surrounding comments left
 * out.
 *
 * Reading the whole table would make every assertion below vacuous, and measurably so: each task's
 * comment explains its own `|| true` and its own `rm -f`, so a check for either string matches the
 * prose whether or not the command survives. Proven by deleting `|| true` from the semgrep
 * invocation and watching a whole-table version of this suite stay green.
 */
const taskShell = (task: string): string => {
  const header = `[tasks."${task}"]`
  const start = MISE.indexOf(header)
  expect(start, `mise.toml declares ${header}`).toBeGreaterThan(-1)
  const rest = MISE.slice(start + header.length)
  const end = rest.search(/^\[/m)
  const body = end === -1 ? rest : rest.slice(0, end)
  const shell = /^run = """$([\s\S]*?)^"""$/m.exec(body)?.[1]
  expect(shell, `${task} carries a multi-line \`run\` script`).toBeTypeOf("string")
  return shell ?? ""
}

describe("the scan tasks in mise.toml", () => {
  it("is a complete census of them, so a sixth scanner cannot arrive unchecked", () => {
    /**
     * Derived from the file rather than trusted from the table above — a claim table that names
     * four of five scanners reports success about the one it omits. `security:vex` renders
     * osv-scanner.toml from the OpenVEX ledger and scans nothing, so it has no report to verify.
     */
    const declared = [...MISE.matchAll(/^\[tasks\."(security:[^"]+)"\]$/gm)]
      .map((match) => match[1])
      .filter((task) => task !== undefined && task !== "security:vex")
    expect(new Set(declared)).toEqual(new Set(SCANS.map((scan) => scan.task)))
  })

  it.each(SCANS)("$task deletes $report before scanning", ({ task, report }) => {
    /**
     * ORDER is the whole property, so the assertion is that the report's FIRST appearance in the
     * shell is the line deleting it. Asking only whether some line deletes it is satisfied by a
     * delete that runs afterwards: `security:leaks` also deletes the file inside its retry branch,
     * and a version of this case that searched the whole script stayed green with the pre-scan
     * delete removed.
     */
    const mentions = taskShell(task)
      .split("\n")
      .filter((line) => line.includes(report))
    expect(mentions.length, `${task} names ${report}`).toBeGreaterThan(0)
    expect(
      mentions[0]?.trimStart(),
      `a previous run's ${report} must not be able to answer for this one`
    ).toMatch(/^rm -f /)
  })

  it.each(SCANS)("$task proves $report through the one shared verifier", ({ task, report }) => {
    // One definition for five callers. Five copies of a check is how one of them stops matching
    // the thing it checks, which is the defect this whole arrangement exists to prevent.
    expect(taskShell(task)).toContain(`scripts/verify-sarif.mjs ${report}`)
  })

  it.each(SCANS)(
    "$task still swallows findings, which must not fail it",
    ({ task, swallowsFindings }) => {
      expect(taskShell(task)).toContain(swallowsFindings)
    }
  )

  it("checks no report with `[ -s ]`, which a truncated SARIF passes", () => {
    // The specific regression: an emptiness test reads the measured 43-byte truncation as a report.
    for (const { task } of SCANS) {
      expect(taskShell(task), `${task} must verify its report, not merely size it`).not.toContain(
        "[ -s "
      )
    }
  })

  it("names every scan in the aggregate `security` task", () => {
    // `mise run security` is the entry point CI calls; a scan missing from `depends` is verified by
    // nothing because it never runs.
    const header = "[tasks.security]"
    const rest = MISE.slice(MISE.indexOf(header) + header.length)
    const end = rest.search(/^\[/m)
    const aggregate = end === -1 ? rest : rest.slice(0, end)
    for (const { task } of SCANS) {
      expect(aggregate, `\`security\` depends on ${task}`).toContain(`"${task}"`)
    }
  })
})

describe("scripts/verify-sarif.mjs", () => {
  let scratch = ""

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "verify-sarif-"))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  const verify = (path: string) =>
    spawnSync("node", ["scripts/verify-sarif.mjs", path, "probe"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    })

  const USABLE = '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"probe"}},"results":[]}]}'

  /** A report that is not usable, and the property that catches it. */
  interface UnusableCase {
    readonly why: string
    readonly bytes: string
    readonly reason: string
  }

  const UNUSABLE: ReadonlyArray<UnusableCase> = [
    {
      why: "the truncated report CI produced on 2026-08-18",
      bytes: '{"runs":[{"tool":{"driver":{"name":"osv-sca',
      reason: "invalid JSON"
    },
    { why: "a document carrying no run", bytes: '{"runs":[]}', reason: "no runs[]" },
    {
      why: "a run whose findings array never got written",
      bytes: '{"runs":[{"tool":{"driver":{"name":"probe"}}}]}',
      reason: "carries no results[]"
    },
    {
      why: "a run code scanning could not attribute to a tool",
      bytes: '{"runs":[{"results":[]}]}',
      reason: "names no tool.driver.name"
    },
    {
      why: "semgrep's own no-output sentinel",
      bytes: "<ERROR: no SARIF output>",
      reason: "invalid JSON"
    }
  ]

  it("accepts a report with a run, a results array, and a tool name", async () => {
    const path = join(scratch, "usable.sarif")
    await writeFile(path, USABLE)
    const run = verify(path)
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain("is usable")
  })

  it.each(UNUSABLE)("refuses $why", async ({ why, bytes, reason }) => {
    const path = join(scratch, `unusable-${why.replace(/\W+/g, "-")}.sarif`)
    await writeFile(path, bytes)
    // Non-vacuous by construction: every case here is a file `[ -s path ]` reports as present and
    // non-empty, which is exactly why size is not the check.
    expect(
      bytes.length,
      "an empty file would prove nothing about size-versus-content"
    ).toBeGreaterThan(0)
    const run = verify(path)
    expect(run.status, `expected a refusal, got: ${run.stdout}`).toBe(1)
    expect(run.stderr).toContain(reason)
    expect(run.stderr).toContain("the scan did NOT run")
  })

  it("refuses a report that was never written", () => {
    const run = verify(join(scratch, "absent.sarif"))
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("ENOENT")
  })

  it("exits 2 without a path, so a mis-wired task fails as usage rather than as a scan", () => {
    const run = spawnSync("node", ["scripts/verify-sarif.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain("usage:")
  })
})

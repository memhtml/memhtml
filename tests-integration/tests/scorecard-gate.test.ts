import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SCRIPT = join(REPO_ROOT, "scripts", "scorecard-gate.mjs")
const FIXTURES = join(REPO_ROOT, "tests-integration", "fixtures", "scorecard")
const POLICY = join(REPO_ROOT, "security", "scorecard-policy.json")
const BASELINE = join(REPO_ROOT, "security", "scorecard-baseline.json")

interface Report {
  scorecard: { version: string }
  score: number
  checks: { name: string; score: number; reason: string; error?: string }[]
}

const reportCheck = (report: Report, index: number) => {
  const check = report.checks[index]
  if (!check) throw new Error(`fixture is missing check ${index}`)
  return check
}

const runGate = (args: string[], env = process.env) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    timeout: 180_000
  })

describe("the Scorecard ratchet", () => {
  let scratch: string
  let serial = 0
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "scorecard-gate-tests-"))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  const modifiedReport = async (change: (report: Report) => void) => {
    const report = JSON.parse(await readFile(join(FIXTURES, "clean.json"), "utf8")) as Report
    change(report)
    const path = join(scratch, `report-${serial++}.json`)
    await writeFile(path, JSON.stringify(report))
    return runGate(["--report", path])
  }

  it.each([
    ["clean", 0, "11 of 11 policy checks ran"],
    ["floor", 1, "FLOOR Binary-Artifacts 9 < floor 10"],
    ["missing", 2, "MISSING Vulnerabilities did not run"],
    ["error", 2, "ERROR Vulnerabilities: internal error"],
    ["version", 2, "VERSION report v5.5.0, pinned v5.6.0"],
    ["raised", 1, "RAISED License 10 > baseline 9"],
    ["vulnerability", 0, "not credited: Vulnerabilities"]
  ])("%s report exits %i and names %s", (fixture, status, line) => {
    const run = runGate(["--report", join(FIXTURES, `${fixture}.json`)])
    expect(run.status, run.stderr).toBe(status)
    expect(run.stdout).toContain(line)
  })

  it("requires all 11 local check names in the policy and baseline", async () => {
    const policy = JSON.parse(await readFile(POLICY, "utf8")) as {
      checks: Record<string, { min: number | null; evidence?: boolean; why?: string }>
    }
    const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as {
      checks: Record<string, number>
    }
    const expected = [
      "Binary-Artifacts",
      "Dangerous-Workflow",
      "Dependency-Update-Tool",
      "Fuzzing",
      "License",
      "Packaging",
      "Pinned-Dependencies",
      "SAST",
      "Security-Policy",
      "Token-Permissions",
      "Vulnerabilities"
    ]
    expect(Object.keys(policy.checks).sort()).toEqual(expected)
    expect(Object.keys(baseline.checks).sort()).toEqual(expected)
    for (const name of expected.filter((name) => name !== "Vulnerabilities")) {
      expect(policy.checks[name]?.min).toBe(name === "License" ? 9 : 10)
      expect(baseline.checks[name]).toBe(name === "License" ? 9 : 10)
    }
    expect(policy.checks.Vulnerabilities?.evidence).toBe(false)
    expect(policy.checks.Vulnerabilities?.why).toContain("osv-scanner")
  })

  it.each([
    ["empty", "0 checks", (report: Report) => (report.checks = [])],
    ["duplicate", "DUPLICATE", (report: Report) => report.checks.push(reportCheck(report, 0))],
    [
      "unlisted",
      "UNLISTED",
      (report: Report) => report.checks.push({ name: "Other", score: 10, reason: "completed" })
    ],
    [
      "inconclusive exemption",
      "INCONCLUSIVE",
      (report: Report) => (reportCheck(report, 10).score = -1)
    ],
    ["invalid score", "INVALID", (report: Report) => (reportCheck(report, 0).score = 11)],
    ["fractional score", "INVALID", (report: Report) => (reportCheck(report, 0).score = 9.5)],
    [
      "explicit error",
      "ERROR",
      (report: Report) => (reportCheck(report, 10).error = "scan failed")
    ],
    [
      "invalid reason",
      "INVALID",
      (report: Report) => Object.assign(reportCheck(report, 0), { reason: null })
    ],
    [
      "invalid name",
      "INVALID",
      (report: Report) => Object.assign(reportCheck(report, 0), { name: 42 })
    ],
    ["invalid aggregate", "INVALID", (report: Report) => (report.score = 11)]
  ])("refuses a %s report with vacuity", async (_name, line, change) => {
    const run = await modifiedReport(change)
    expect(run.status, run.stderr).toBe(2)
    expect(run.stdout).toContain(line)
  })

  it("ratchets each credited check independently", async () => {
    const clean = JSON.parse(await readFile(join(FIXTURES, "clean.json"), "utf8")) as Report
    for (const check of clean.checks.filter((check) => check.name !== "Vulnerabilities")) {
      const run = await modifiedReport((report) => {
        const target = report.checks.find((candidate) => candidate.name === check.name)
        if (target) target.score = check.score - 1
      })
      expect(run.status, run.stderr).toBe(1)
      expect(run.stdout).toContain(`FLOOR ${check.name}`)
      expect(run.stdout).toContain(`DROP ${check.name}`)
    }
  })

  it("allows a rise only after the baseline rises too", async () => {
    const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as {
      checks: Record<string, number>
    }
    baseline.checks.License = 10
    const path = join(scratch, "raised-baseline.json")
    await writeFile(path, JSON.stringify(baseline))
    const run = runGate(["--report", join(FIXTURES, "raised.json"), "--baseline", path])
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain("0 findings, 0 vacuity")
  })

  it("rejects a baseline drop even when its floor still passes", async () => {
    const policy = JSON.parse(await readFile(POLICY, "utf8")) as {
      checks: Record<string, { min: number }>
    }
    const license = policy.checks.License
    if (!license) throw new Error("fixture is missing License")
    license.min = 8
    const policyPath = join(scratch, "lower-fixture-floor.json")
    await writeFile(policyPath, JSON.stringify(policy))
    const report = JSON.parse(await readFile(join(FIXTURES, "clean.json"), "utf8")) as Report
    reportCheck(report, 4).score = 8
    const reportPath = join(scratch, "drop-above-floor.json")
    await writeFile(reportPath, JSON.stringify(report))
    const run = runGate(["--report", reportPath, "--policy", policyPath])
    expect(run.status, run.stderr).toBe(1)
    expect(run.stdout).toContain("DROP License 8 < baseline 9")
    expect(run.stdout).not.toContain("FLOOR License")
  })

  it("reports the aggregate without gating it", async () => {
    const run = await modifiedReport((report) => {
      report.score = 0
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain("overall 0.0, 0 findings, 0 vacuity")
  })

  it("refuses empty policy and partial baseline configurations", async () => {
    const policy = JSON.parse(await readFile(POLICY, "utf8")) as { checks: Record<string, unknown> }
    policy.checks = {}
    const policyPath = join(scratch, "empty-policy.json")
    await writeFile(policyPath, JSON.stringify(policy))
    const empty = runGate(["--policy", policyPath, "--report", join(FIXTURES, "clean.json")])
    expect(empty.status).toBe(2)
    expect(empty.stderr).toContain("0 policy checks")
    const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as {
      checks: Record<string, number>
    }
    delete baseline.checks.License
    const baselinePath = join(scratch, "partial-baseline.json")
    await writeFile(baselinePath, JSON.stringify(baseline))
    const partial = runGate(["--baseline", baselinePath, "--report", join(FIXTURES, "clean.json")])
    expect(partial.status).toBe(2)
    expect(partial.stderr).toContain("baseline check names")
  })

  it("refuses unreadable and malformed reports and unknown options", async () => {
    const missing = runGate(["--report", join(scratch, "absent.json")])
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain("VACUOUS")
    const path = join(scratch, "malformed.json")
    await writeFile(path, '{"checks":')
    expect(runGate(["--report", path]).status).toBe(2)
    const unknown = runGate(["--unknown", "value"])
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain("usage:")
  })

  const cloneHead = async (name: string) => {
    const clone = join(scratch, name)
    const cloned = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", REPO_ROOT, clone], {
      encoding: "utf8"
    })
    expect(cloned.status, cloned.stderr).toBe(0)
    return clone
  }

  const commit = (clone: string, paths: string[], subject: string) => {
    const author = spawnSync("git", ["log", "-1", "--format=%an%n%ae"], {
      cwd: clone,
      encoding: "utf8"
    })
      .stdout.trim()
      .split("\n")
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: author[0],
      GIT_AUTHOR_EMAIL: author[1],
      GIT_COMMITTER_NAME: author[0],
      GIT_COMMITTER_EMAIL: author[1]
    }
    const staged = spawnSync("git", ["add", ...paths], { cwd: clone, encoding: "utf8", env })
    expect(staged.status, staged.stderr).toBe(0)
    const committed = spawnSync("git", ["commit", "-m", subject], {
      cwd: clone,
      encoding: "utf8",
      env
    })
    expect(committed.status, committed.stderr).toBe(0)
  }

  // The real git export is the subject here. A fake Scorecard keeps the regular check offline;
  // live committed plants separately prove how the pinned scanner scores these same files.
  const offlineScanner = async () => {
    const commands = join(scratch, `commands-${serial++}`)
    await mkdir(commands)
    const report = await readFile(join(FIXTURES, "clean.json"), "utf8")
    await writeFile(
      join(commands, "mise"),
      `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
if (process.env.SCANNER_START_MARKER) fs.writeFileSync(process.env.SCANNER_START_MARKER, "started")
const report = ${report}
const tree = process.argv.find(arg => arg.startsWith("--local=")).slice(8)
const binaries = [path.join(tree, "native"), path.join(tree, "node_modules", "native")]
if (binaries.some(binary => fs.existsSync(binary) && fs.readFileSync(binary).equals(fs.readFileSync(process.execPath)))) {
  report.checks.find(check => check.name === "Binary-Artifacts").score = 0
}
const workflow = fs.readFileSync(path.join(tree, ".github/workflows/check.yml"), "utf8")
if (!/^permissions:/m.test(workflow)) {
  report.checks.find(check => check.name === "Token-Permissions").score = 0
}
if (process.env.EXPORT_CAPTURE) {
  fs.writeFileSync(process.env.EXPORT_CAPTURE, fs.readFileSync(path.join(tree, "marker.txt")))
}
process.stdout.write(JSON.stringify(report))
`,
      { mode: 0o755 }
    )
    return { ...process.env, PATH: `${commands}:${process.env.PATH}` }
  }

  it("ignores an installed native binary, but rejects that same binary committed in HEAD", async () => {
    const clone = await cloneHead("installed-clone")
    const installed = join(clone, "node_modules", "native")
    await mkdir(dirname(installed), { recursive: true })
    await copyFile(process.execPath, installed)
    const ignored = spawnSync("git", ["check-ignore", "node_modules/native"], {
      cwd: clone,
      encoding: "utf8"
    })
    expect(ignored.status, ignored.stderr).toBe(0)
    const env = await offlineScanner()
    const clean = runGate(["--target", clone], env)
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
    expect(clean.stdout).toContain("11 of 11 policy checks ran")

    await copyFile(installed, join(clone, "native"))
    commit(clone, ["native"], "test: commit native binary")
    const planted = runGate(["--target", clone], env)
    expect(planted.status, planted.stdout + planted.stderr).toBe(1)
    expect(planted.stdout).toContain("FLOOR Binary-Artifacts")
  })

  it("scores a committed permissions drop even when export-ignore names the workflow", async () => {
    const clone = await cloneHead("permissions-clone")
    const workflow = join(clone, ".github", "workflows", "check.yml")
    await writeFile(
      workflow,
      (await readFile(workflow, "utf8")).replace(/^permissions:\n {2}contents: read\n/m, "")
    )
    await writeFile(join(clone, ".gitattributes"), ".github/workflows/check.yml export-ignore\n")
    commit(clone, [".gitattributes", ".github/workflows/check.yml"], "test: hide workflow export")
    const run = runGate(["--target", clone], await offlineScanner())
    expect(run.status, run.stdout + run.stderr).toBe(1)
    expect(run.stdout).toContain("FLOOR Token-Permissions 0 < floor 10")
  })

  it("scores a committed binary even when export-ignore names it", async () => {
    const clone = await cloneHead("binary-clone")
    await copyFile(process.execPath, join(clone, "native"))
    await writeFile(join(clone, ".gitattributes"), "native export-ignore\n")
    commit(clone, [".gitattributes", "native"], "test: hide binary export")
    const run = runGate(["--target", clone], await offlineScanner())
    expect(run.status, run.stdout + run.stderr).toBe(1)
    expect(run.stdout).toContain("FLOOR Binary-Artifacts 0 < floor 10")
  })

  it("exports committed content without export-subst expansion", async () => {
    const clone = await cloneHead("substitution-clone")
    const content = "$Format:%H$\n"
    await writeFile(join(clone, "marker.txt"), content)
    await writeFile(join(clone, ".gitattributes"), "marker.txt export-subst\n")
    commit(clone, [".gitattributes", "marker.txt"], "test: preserve archive content")
    const capture = join(scratch, "captured-marker.txt")
    const run = runGate(["--target", clone], {
      ...(await offlineScanner()),
      EXPORT_CAPTURE: capture
    })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(await readFile(capture, "utf8")).toBe(content)
  })

  it("refuses an export whose file list differs from the committed tree", async () => {
    const commands = join(scratch, "incomplete-export")
    await mkdir(commands)
    await writeFile(
      join(commands, "tar"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process")
const { renameSync, rmSync } = require("node:fs")
const { join } = require("node:path")
const args = process.argv.slice(2)
const run = spawnSync("/usr/bin/tar", args)
if (run.status !== 0) process.exit(run.status)
const tree = args[args.indexOf("-C") + 1]
if (process.env.EXPORT_DEFECT === "rename") {
  renameSync(join(tree, "README.md"), join(tree, "README-renamed.md"))
} else {
  rmSync(join(tree, "README.md"))
}
`,
      { mode: 0o755 }
    )
    const env = await offlineScanner()
    for (const defect of ["remove", "rename"]) {
      const started = join(scratch, `scanner-${defect}.txt`)
      const run = runGate([], {
        ...env,
        PATH: `${commands}:${env.PATH}`,
        EXPORT_DEFECT: defect,
        SCANNER_START_MARKER: started
      })
      expect(run.status, run.stdout + run.stderr).toBe(2)
      expect(run.stderr).toContain("EXPORT exported file list differs from committed HEAD")
      await expect(readFile(started)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  it("refuses a tool exit failure even when the tool prints a clean report", async () => {
    const commands = join(scratch, "commands")
    await mkdir(commands)
    const report = await readFile(join(FIXTURES, "clean.json"), "utf8")
    await writeFile(
      join(commands, "mise"),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(report)})\nprocess.exit(1)\n`,
      { mode: 0o755 }
    )
    const run = runGate([], { ...process.env, PATH: `${commands}:${process.env.PATH}` })
    expect(run.status, run.stdout + run.stderr).toBe(2)
    expect(run.stdout).toContain("TOOL Scorecard exited 1")
  })
})

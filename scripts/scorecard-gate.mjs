/**
 * Score each local check against its floor and committed baseline.
 *
 *   node scripts/scorecard-gate.mjs
 *   node scripts/scorecard-gate.mjs --report report.json
 *   node scripts/scorecard-gate.mjs --target checkout --policy policy.json --baseline baseline.json
 *
 * Live scans export HEAD into a fresh temporary directory: installed dependencies and dirty files
 * must not count as committed binaries. Reports are read in memory; their local repository paths
 * never enter the baseline. The aggregate is diagnostic only, because it can hide a failed check.
 *
 * Exit 0 passes, 1 names a per-check finding, and 2 means no trustworthy verdict was produced.
 * Vulnerabilities still has to run successfully, but its score is left to osv-scanner and the
 * existing vulnerability reporting policy.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const score = (value) => Number.isInteger(value) && value >= 0 && value <= 10
const load = (path) => JSON.parse(readFileSync(path, "utf8"))
const refuse = (reason) => {
  throw new Error(reason)
}

/** Configurations are evidence too: an empty or partial baseline cannot ratchet anything. */
const validateConfig = (policy, baseline) => {
  if (!object(policy) || !/^v\d+\.\d+\.\d+$/.test(policy.version)) {
    refuse("CONFIG policy needs an exact version")
  }
  const command = ["mise", "x", `aqua:ossf/scorecard@${policy.version.slice(1)}`, "--", "scorecard"]
  if (
    policy.mode !== "local" ||
    !Array.isArray(policy.command) ||
    JSON.stringify(policy.command) !== JSON.stringify(command)
  ) {
    refuse("CONFIG command must run the exact pinned Scorecard in local mode")
  }
  if (!object(policy.checks) || Object.keys(policy.checks).length === 0) {
    refuse("CONFIG 0 policy checks")
  }
  for (const [name, rule] of Object.entries(policy.checks)) {
    if (!object(rule)) refuse(`CONFIG invalid rule for ${name}`)
    if (rule.evidence === false) {
      if (
        name !== "Vulnerabilities" ||
        rule.min !== null ||
        typeof rule.why !== "string" ||
        !rule.why.trim()
      ) {
        refuse(`CONFIG invalid evidence exemption for ${name}`)
      }
    } else if (!score(rule.min) || (rule.evidence !== undefined && rule.evidence !== true)) {
      refuse(`CONFIG invalid floor for ${name}`)
    }
  }
  if (!object(baseline) || baseline.version !== policy.version || !object(baseline.checks)) {
    refuse("CONFIG baseline version and checks must match the policy")
  }
  if (
    JSON.stringify(Object.keys(baseline.checks).sort()) !==
    JSON.stringify(Object.keys(policy.checks).sort())
  ) {
    refuse("CONFIG baseline check names must match the policy")
  }
  for (const [name, old] of Object.entries(baseline.checks)) {
    if (!score(old)) refuse(`CONFIG invalid baseline score for ${name}`)
  }
}

/** Scorecard may exit nonzero with valid JSON; that is a tool failure, never a clean report. */
const evaluate = (policy, baseline, report, status) => {
  const vacuity = []
  const findings = []
  const got = new Map()
  if (status !== 0) vacuity.push(`TOOL Scorecard exited ${status ?? "without a status"}`)
  if (!object(report)) refuse("INVALID report must be an object")
  const version = report.scorecard?.version
  if (version !== policy.version) {
    vacuity.push(`VERSION report ${version ?? "missing"}, pinned ${policy.version}`)
  }
  const overall = report.score
  if (typeof overall !== "number" || !Number.isFinite(overall) || overall < 0 || overall > 10) {
    vacuity.push("INVALID aggregate score")
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    vacuity.push("0 checks in report")
  } else {
    for (const check of report.checks) {
      if (!object(check) || typeof check.name !== "string" || !check.name.trim()) {
        vacuity.push("INVALID check needs a name")
        continue
      }
      if (got.has(check.name)) {
        vacuity.push(`DUPLICATE ${check.name}`)
        continue
      }
      got.set(check.name, check)
      if (!Object.hasOwn(policy.checks, check.name)) {
        vacuity.push(`UNLISTED ${check.name} ran but the policy does not list it`)
      }
    }
  }
  let ran = 0
  for (const [name, rule] of Object.entries(policy.checks).sort()) {
    const check = got.get(name)
    if (!check) {
      vacuity.push(`MISSING ${name} did not run`)
      continue
    }
    if (typeof check.reason !== "string") {
      vacuity.push(`INVALID ${name} needs a reason`)
      continue
    }
    if (check.error || /internal\s+error/i.test(check.reason)) {
      vacuity.push(`ERROR ${name}: ${check.reason}`)
      continue
    }
    if (check.score === -1) {
      vacuity.push(`INCONCLUSIVE ${name}: ${check.reason}`)
      continue
    }
    if (!score(check.score)) {
      vacuity.push(`INVALID ${name} score`)
      continue
    }
    ran += 1
    if (rule.evidence === false) continue
    if (check.score < rule.min) {
      findings.push(`FLOOR ${name} ${check.score} < floor ${rule.min}: ${check.reason}`)
    }
    const old = baseline.checks[name]
    if (check.score < old) {
      findings.push(`DROP ${name} ${check.score} < baseline ${old}: ${check.reason}`)
    } else if (check.score > old) {
      findings.push(`RAISED ${name} ${check.score} > baseline ${old}: ratchet the baseline up`)
    }
  }
  const overallText =
    typeof overall === "number" && Number.isFinite(overall) ? overall.toFixed(1) : "invalid"
  console.log(
    `scorecard: ${ran} of ${Object.keys(policy.checks).length} policy checks ran (${version ?? "missing"}, exit ${status ?? "unknown"}), overall ${overallText}, ${findings.length} findings, ${vacuity.length} vacuity`
  )
  for (const [name, rule] of Object.entries(policy.checks).sort()) {
    if (rule.evidence === false) console.log(`  not credited: ${name} (${rule.why})`)
  }
  for (const line of [...vacuity, ...findings]) console.log(`  ${line}`)
  return vacuity.length > 0 ? 2 : findings.length > 0 ? 1 : 0
}

const checkedCommand = (command, args, options) => {
  const run = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, ...options })
  if (run.error || run.status !== 0) {
    refuse(`TOOL ${command} failed (${run.error?.code ?? run.signal ?? run.status})`)
  }
  return run
}

const scanHead = (policy, target) => {
  const scratch = mkdtempSync(
    join(process.env.TMPDIR ?? process.env.RUNNER_TEMP ?? tmpdir(), "scorecard-")
  )
  try {
    const archive = join(scratch, "head.tar")
    const tree = join(scratch, "tree")
    mkdirSync(tree)
    checkedCommand("git", ["-C", target, "archive", "HEAD", "--format=tar", `--output=${archive}`])
    checkedCommand("tar", ["-xf", archive, "-C", tree])
    const [command, ...args] = policy.command
    const run = spawnSync(
      command,
      [
        ...args,
        `--local=${tree}`,
        `--checks=${Object.keys(policy.checks).join(",")}`,
        "--format=json"
      ],
      {
        cwd: scratch,
        encoding: "utf8",
        timeout: 600_000,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024
      }
    )
    if (run.error || run.signal) {
      refuse(`TOOL Scorecard failed (${run.error?.code ?? run.signal})`)
    }
    let report
    try {
      report = JSON.parse(run.stdout)
    } catch {
      refuse(`INVALID no JSON report from Scorecard (exit ${run.status})`)
    }
    return { report, status: run.status }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  const options = {
    "--policy": join(REPO_ROOT, "security", "scorecard-policy.json"),
    "--baseline": join(REPO_ROOT, "security", "scorecard-baseline.json"),
    "--target": REPO_ROOT,
    "--report": undefined
  }
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!Object.hasOwn(options, flag) || !value || value.startsWith("--")) {
      refuse(
        "usage: node scripts/scorecard-gate.mjs [--policy file] [--baseline file] [--report file] [--target checkout]"
      )
    }
    options[flag] = resolve(value)
  }
  const policy = load(options["--policy"])
  const baseline = load(options["--baseline"])
  validateConfig(policy, baseline)
  const { report, status } = options["--report"]
    ? { report: load(options["--report"]), status: 0 }
    : scanHead(policy, options["--target"])
  process.exitCode = evaluate(policy, baseline, report, status)
} catch (error) {
  console.error(`scorecard: VACUOUS: ${error.message}`)
  process.exitCode = 2
}

#!/usr/bin/env node
/**
 * Report whether each `<pkg>@<version>` clears this repo's install cooldown.
 *
 * `minimumReleaseAge` is read from `pnpm-workspace.yaml` rather than hardcoded, because the number
 * is a policy the repo owns and a script that restates it drifts from it. `minimumReleaseAgeExclude`
 * is honoured, so a package deliberately exempted reports as exempt rather than as blocked.
 *
 * Usage:
 *   node cooldown-check.mjs eve@0.44.1 @biomejs/biome@2.5.10
 *   node cooldown-check.mjs --pr 74            # read the versions out of a dependabot PR body
 *
 * Exit 0 when every version is installable, 1 when any is inside the window. That makes it usable
 * as a gate before spending a gate run on a version pnpm will refuse.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = join(SKILL_DIR, "..", "..", "..")

/** `minimumReleaseAge` in minutes, plus any per-package exemptions, as the workspace declares them. */
const readPolicy = () => {
  const source = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8")
  const minutes = Number(/^minimumReleaseAge:\s*(\d+)/m.exec(source)?.[1] ?? NaN)
  if (!Number.isFinite(minutes)) {
    throw new Error("pnpm-workspace.yaml declares no minimumReleaseAge — the policy moved")
  }
  const excludeBlock = /^minimumReleaseAgeExclude:\s*\n((?:\s+-\s+.*\n)*)/m.exec(source)?.[1] ?? ""
  const exclude = new Set(
    [...excludeBlock.matchAll(/^\s+-\s+"?([^"\s]+)"?\s*$/gm)].map((match) => match[1])
  )
  return { minutes, exclude }
}

/** Every `<pkg>@<version>` a dependabot PR body proposes, in the order the body lists them. */
const readFromPr = (number) => {
  const body = execFileSync(
    "gh",
    ["pr", "view", String(number), "--json", "body", "--jq", ".body"],
    {
      encoding: "utf8",
      cwd: REPO_ROOT
    }
  )
  return [...body.matchAll(/^Updates `([^`]+)` from \S+ to (\S+)$/gm)].map(
    ([, name, version]) => `${name}@${version}`
  )
}

/** The registry's publish time for one exact version, or null when it does not exist. */
const publishedAt = (name, version) => {
  const raw = execFileSync("npm", ["view", name, "time", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  })
  return JSON.parse(raw)[version] ?? null
}

/** Split `@scope/name@1.2.3` on its LAST `@`, so a scoped name survives. */
const splitSpec = (spec) => {
  const at = spec.lastIndexOf("@")
  if (at <= 0) throw new Error(`not a <pkg>@<version> spec: ${spec}`)
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("usage: cooldown-check.mjs <pkg@version>... | --pr <number>")
  process.exit(2)
}

const specs = args[0] === "--pr" ? readFromPr(args[1]) : args
const { minutes, exclude } = readPolicy()
const windowMs = minutes * 60_000
const now = Date.now()
const cutoff = new Date(now - windowMs)

console.log(`minimumReleaseAge: ${minutes} minutes (${(minutes / 60).toFixed(0)}h)`)
console.log(`installable if published before: ${cutoff.toISOString()}`)
if (exclude.size > 0) console.log(`exempt: ${[...exclude].join(", ")}`)
console.log("")

let blocked = 0
for (const spec of specs) {
  const { name, version } = splitSpec(spec)
  if (exclude.has(name)) {
    console.log(`EXEMPT     ${spec}  (minimumReleaseAgeExclude)`)
    continue
  }
  const time = publishedAt(name, version)
  if (time === null) {
    console.log(`MISSING    ${spec}  (no such version in the registry)`)
    blocked += 1
    continue
  }
  const ageHours = (now - Date.parse(time)) / 3_600_000
  if (ageHours >= minutes / 60) {
    console.log(`ok         ${spec}  published ${time}  age ${ageHours.toFixed(1)}h`)
  } else {
    const clearsAt = new Date(Date.parse(time) + windowMs).toISOString()
    console.log(
      `BLOCKED    ${spec}  published ${time}  age ${ageHours.toFixed(1)}h  clears ${clearsAt}`
    )
    blocked += 1
  }
}

if (blocked > 0) {
  console.log(
    `\n${blocked} version(s) inside the window. A blocked install is the policy working, not a broken lockfile — take the newest version that clears it, or wait.`
  )
}
process.exit(blocked > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * The pnpm version is declared twice, and this is what stops the two from drifting.
 *
 * `mise.toml`'s `[tools] pnpm` is what mise installs and puts on PATH, and it has to sit
 * above `node` there or node's corepack symlink shadows it. `package.json`'s
 * `packageManager` is what pnpm itself and every non-mise consumer reads. Neither can be
 * derived from the other: mise resolves `[tools]` before any Node exists to evaluate a
 * template, and pnpm will not read mise.toml.
 *
 * A disagreement between them is silent by default. `pnpm-workspace.yaml` sets
 * `pmOnFail: ignore`, so pnpm 11 runs whatever version it is rather than self-switching
 * to the one `packageManager` names — the behavior that would otherwise paper over a bad
 * pin. (Measured on pnpm 10, which predates that setting: a `[tools]` pin of 10 against a
 * `packageManager` of 11.16.0 self-switched and reported 11.16.0. pnpm 11 will not.)
 *
 * Exits 0 when they agree, 1 with both values when they do not.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Resolved from import.meta.url, not process.cwd(), so the check is correct from any
// directory a task runner or hook happens to invoke it in.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const readPackageManagerPin = () => {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8")
  const { packageManager } = JSON.parse(raw)
  if (typeof packageManager !== "string") {
    return { error: "package.json declares no `packageManager` string" }
  }
  // `pnpm@11.16.0+sha256.abc...` — the hash suffix is optional and not part of the version.
  const match = /^pnpm@(?<version>[^+]+)/.exec(packageManager)
  return match?.groups?.version
    ? { version: match.groups.version }
    : { error: `package.json packageManager is not a pnpm pin: ${packageManager}` }
}

const readMisePin = () => {
  const raw = readFileSync(join(repoRoot, "mise.toml"), "utf8")
  // Deliberately a line match rather than a TOML parse: this script must run before any
  // dependency is installed, so it gets no parser. Anchored to the start of a line so a
  // `pnpm` mentioned inside a task's `run` or a comment cannot satisfy it.
  const match = /^pnpm\s*=\s*"(?<version>[^"]+)"/m.exec(raw)
  return match?.groups?.version
    ? { version: match.groups.version }
    : { error: 'mise.toml declares no `pnpm = "..."` under [tools]' }
}

const pkg = readPackageManagerPin()
const mise = readMisePin()

for (const [source, result] of [
  ["package.json", pkg],
  ["mise.toml", mise]
]) {
  if (result.error) {
    console.error(`pnpm pin check FAILED: ${result.error} (${source})`)
    process.exit(1)
  }
}

if (pkg.version !== mise.version) {
  console.error(
    `pnpm pin check FAILED: mise.toml [tools] pnpm = "${mise.version}" but ` +
      `package.json packageManager = "pnpm@${pkg.version}".\n` +
      "Both declare the pnpm that runs; set them to the same version."
  )
  process.exit(1)
}

console.log(`pnpm pin check ok: ${pkg.version} in both mise.toml and package.json`)

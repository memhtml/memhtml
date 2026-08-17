#!/usr/bin/env node
/**
 * Write the published `package.json` into `dist-package/`, beside what tsdown built.
 *
 * tsdown owns the bundle and the asset copies; this owns the metadata, which is the part that decides
 * what npm actually serves. Kept as its own step because a manifest is a contract — `bin`, `files`,
 * `engines`, and the dependency versions a consumer resolves — and it is worth reading on one screen.
 *
 * Every dependency version is read from what is INSTALLED rather than from the manifests that declare
 * it. Two reasons: `catalog:` is a pnpm specifier that means nothing to npm and has to be resolved to
 * something concrete, and the installed tree is the one every gate ran against, so it is the version
 * this artifact was actually tested with.
 */
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const STAGING = join(REPO_ROOT, "dist-package")

/** Every package whose dependencies end up in the bundle's external set. */
const WORKSPACE_PACKAGES = [
  "apps/cli",
  "apps/mcp",
  "apps/consolidator",
  "packages/contracts",
  "packages/domain",
  "packages/eval",
  "packages/html",
  "packages/index",
  "packages/llm",
  "packages/sleep",
  "packages/store",
  "packages/traces"
]

const manifestOf = async (dir) => JSON.parse(await readFile(join(REPO_ROOT, dir, "package.json"), "utf8"))

/**
 * The version of a dependency as installed, resolved from the package that declares it outward.
 *
 * Outward from the DECLARING package because pnpm puts a package's dependencies in its own
 * `node_modules` rather than hoisting them: `@effect/platform-node` exists only under `apps/mcp`.
 */
const installedVersion = async (name, fromDir) => {
  let at = join(REPO_ROOT, fromDir)
  for (;;) {
    const candidate = join(at, "node_modules", name, "package.json")
    if (existsSync(candidate)) return JSON.parse(await readFile(candidate, "utf8")).version
    const up = dirname(at)
    if (up === at) throw new Error(`${name} is not installed; run \`mise run install\` first`)
    at = up
  }
}

const dependencies = {}
for (const dir of WORKSPACE_PACKAGES) {
  const manifest = await manifestOf(dir)
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@memhtml/")) continue
    const version = await installedVersion(name, dir)
    if (dependencies[name] !== undefined && dependencies[name] !== version) {
      throw new Error(`${name} is installed at two versions: ${dependencies[name]} and ${version}`)
    }
    // An exact pin, matching how this repo pins everything else: the artifact resolves the versions
    // its gates ran against, not whatever a caret admits on the day someone installs it.
    dependencies[name] = version
  }
}

for (const required of ["dist/memhtml.mjs", "dist/memhtml-mcp.mjs", "migrations", "guest", "agent", "src"]) {
  if (!existsSync(join(STAGING, required))) {
    throw new Error(`dist-package/${required} is missing; run \`pnpm package:assemble\``)
  }
}

const root = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"))

await writeFile(
  join(STAGING, "package.json"),
  `${JSON.stringify(
    {
      name: "memhtml",
      version: root.version,
      description:
        "An agent's long-term memory: one fact per semantic HTML file in git, four-arm retrieval, and a nightly sleep cycle.",
      keywords: ["memory", "agent", "mcp", "retrieval", "sqlite", "git", "semantic-html", "cli"],
      homepage: "https://github.com/memhtml/memhtml",
      bugs: { url: "https://github.com/memhtml/memhtml/issues" },
      repository: { type: "git", url: "git+https://github.com/memhtml/memhtml.git" },
      license: "Apache-2.0",
      type: "module",
      engines: { node: ">=24" },
      bin: { memhtml: "./dist/memhtml.mjs", "memhtml-mcp": "./dist/memhtml-mcp.mjs" },
      /**
       * No `exports` map, on purpose. The published contract is the two binaries; nothing here is
       * importable, so declaring an entry point would promise a surface no test covers and no
       * consumer asked for. Adding one later is a minor bump — removing one would be a major.
       */
      files: ["dist", "migrations", "state-migrations", "guest", "agent", "src", "README.md", "LICENSE"],
      dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
      publishConfig: { access: "public", provenance: false }
    },
    null,
    2
  )}\n`
)

process.stdout.write(
  `${JSON.stringify(
    { staging: STAGING, version: root.version, dependencies: Object.keys(dependencies).length },
    null,
    2
  )}\n`
)

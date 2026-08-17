#!/usr/bin/env node
/**
 * Assemble the workspace into ONE publishable package, `memhtml`.
 *
 * ## Why an assembly step rather than a bundler
 *
 * Three things in this system resolve paths from their own module location at run time — the index's
 * `migrations/` and `state-migrations/` (`new URL("../migrations", import.meta.url)`), the CLI's
 * `guest/corpus.mjs`, and the consolidator's `agent/` reaching `../../src/*.js` — and two more read a
 * dependency's FILE off disk rather than importing it (`node-html-parser`'s bytes go into the QuickJS
 * guest, `highlight.js` loads through `createRequire`). A bundler moves emitted code away from the
 * assets those paths are relative to, and inlines the two packages that must stay resolvable files. So
 * nothing is bundled: each workspace package is COPIED whole into `node_modules/@memhtml/<name>/`, at
 * the depth its own code expects, and every `@memhtml/*` specifier keeps resolving the way node
 * already resolves it.
 *
 * ## Why `bundleDependencies`
 *
 * `npm pack` excludes `node_modules` unconditionally — `files` cannot override it — and
 * `bundleDependencies` is the one mechanism that includes it. It must be given REAL directories:
 * pointed at pnpm's symlink farm it crashes npm itself ("Exit handler never called!"), which is why
 * this script copies into a staging tree instead of packing the workspace in place.
 *
 * ## Why the vendored manifests declare no dependencies
 *
 * npm plants a phantom EMPTY directory in the bundled subtree for every dependency a vendored manifest
 * names, and an empty `memhtml/node_modules/effect` breaks `import "effect"` from all twelve packages
 * (probed 2026-08-17). The externals are declared once, at the top level, where the consumer's
 * installer puts them somewhere every vendored package can reach by walking up.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const STAGING = join(REPO_ROOT, "dist-package")

/** The published name and the two binaries it puts on PATH. */
const PACKAGE_NAME = "memhtml"

/**
 * Every workspace package that travels, and the non-`dist/` directories each one resolves at run time.
 *
 * `tests-integration/tests/packaging.test.ts` holds the same asset facts as claims tied to the source
 * line that resolves each one, so a new asset fails there before it can be forgotten here.
 */
export const VENDORED = [
  { dir: "apps/cli", assets: ["guest"] },
  { dir: "apps/mcp", assets: [] },
  { dir: "apps/consolidator", assets: ["agent", "src"] },
  { dir: "packages/contracts", assets: [] },
  { dir: "packages/domain", assets: [] },
  { dir: "packages/eval", assets: [] },
  { dir: "packages/html", assets: [] },
  { dir: "packages/index", assets: ["migrations", "state-migrations"] },
  { dir: "packages/llm", assets: [] },
  { dir: "packages/sleep", assets: [] },
  { dir: "packages/store", assets: [] },
  { dir: "packages/traces", assets: [] }
]

const manifestOf = async (dir) => JSON.parse(await readFile(join(REPO_ROOT, dir, "package.json"), "utf8"))

/**
 * The version a `catalog:` specifier means, read from what is INSTALLED rather than from
 * `pnpm-workspace.yaml`.
 *
 * The installed tree is what every gate ran against, so it is the version this artifact was tested
 * with. Parsing the catalog would restate an intention; reading the tree states a fact.
 */
const installedVersion = async (name, fromDir) => {
  // From the DECLARING package outward, because pnpm puts a package's dependencies in its own
  // `node_modules` rather than hoisting them: `@effect/platform-node` exists only under `apps/mcp`.
  let at = join(REPO_ROOT, fromDir)
  for (;;) {
    const candidate = join(at, "node_modules", name, "package.json")
    if (existsSync(candidate)) return JSON.parse(await readFile(candidate, "utf8")).version
    const up = dirname(at)
    if (up === at) throw new Error(`${name} is not installed; run \`mise run install\` first`)
    at = up
  }
}

const assemble = async () => {
  await rm(STAGING, { recursive: true, force: true })
  await mkdir(join(STAGING, "node_modules", "@memhtml"), { recursive: true })
  await mkdir(join(STAGING, "bin"), { recursive: true })

  const anchor = await manifestOf("apps/cli")
  const external = {}
  const bundled = []

  for (const { dir, assets } of VENDORED) {
    const source = await manifestOf(dir)
    const to = join(STAGING, "node_modules", source.name)
    await mkdir(to, { recursive: true })

    if (!existsSync(join(REPO_ROOT, dir, "dist"))) {
      throw new Error(`${dir} has no dist/; run \`mise run build\` first`)
    }
    await cp(join(REPO_ROOT, dir, "dist"), join(to, "dist"), { recursive: true })
    await rm(join(to, "dist", ".tsbuildinfo"), { force: true })
    for (const asset of assets) {
      const from = join(REPO_ROOT, dir, asset)
      if (!existsSync(from)) throw new Error(`${dir} is missing its ${asset}/ asset directory`)
      await cp(from, join(to, asset), { recursive: true })
    }

    for (const [name, range] of Object.entries(source.dependencies ?? {})) {
      if (name.startsWith("@memhtml/")) continue
      const version = range === "catalog:" ? await installedVersion(name, dir) : range
      if (external[name] !== undefined && external[name] !== version) {
        throw new Error(`${name} is wanted at ${external[name]} and at ${version}`)
      }
      external[name] = version
    }

    await writeFile(
      join(to, "package.json"),
      `${JSON.stringify(
        {
          name: source.name,
          version: source.version,
          type: source.type,
          exports: source.exports,
          ...(source.bin === undefined ? {} : { bin: source.bin })
        },
        null,
        2
      )}\n`
    )
    bundled.push(source.name)
  }

  /**
   * The two entry points, as thin files with their own shebang.
   *
   * Relative imports into the vendored tree deliberately: a bare `@memhtml/cli/bin` specifier is gated
   * by that package's `exports` map, which declares no such subpath. npm links THESE files onto PATH,
   * so the shebang has to be here.
   */
  await writeFile(
    join(STAGING, "bin", "memhtml.mjs"),
    '#!/usr/bin/env node\nimport "../node_modules/@memhtml/cli/dist/bin.js"\n'
  )
  await writeFile(
    join(STAGING, "bin", "memhtml-mcp.mjs"),
    '#!/usr/bin/env node\nimport "../node_modules/@memhtml/mcp/dist/bin.js"\n'
  )

  for (const file of ["README.md", "LICENSE"]) {
    await cp(join(REPO_ROOT, file), join(STAGING, file))
  }

  await writeFile(
    join(STAGING, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: anchor.version,
        description:
          "An agent's long-term memory: one fact per semantic HTML file in git, four-arm retrieval, and a nightly sleep cycle.",
        keywords: ["memory", "agent", "mcp", "retrieval", "sqlite", "git", "semantic-html"],
        type: "module",
        license: anchor.license,
        repository: { type: "git", url: "git+https://github.com/memhtml/memhtml.git" },
        engines: anchor.engines,
        bin: { memhtml: "./bin/memhtml.mjs", "memhtml-mcp": "./bin/memhtml-mcp.mjs" },
        files: ["bin", "README.md", "LICENSE"],
        /**
         * The bundled names are declared here TOO, and must be: npm silently ignores a
         * `bundleDependencies` entry that no `dependencies` field names, producing a five-file tarball
         * with the whole vendored tree missing. Nothing is fetched for them — the tarball already
         * carries them — so the version is this release's own.
         */
        dependencies: Object.fromEntries(
          [
            ...Object.entries(external),
            ...bundled.map((name) => [name, anchor.version])
          ].sort(([a], [b]) => a.localeCompare(b))
        ),
        bundleDependencies: bundled.sort(),
        publishConfig: { access: "public" }
      },
      null,
      2
    )}\n`
  )

  return { version: anchor.version, external: Object.keys(external).length, bundled: bundled.length }
}

/**
 * Only assemble when RUN, never when imported.
 *
 * `tests-integration/tests/packaging.test.ts` imports {@link VENDORED} so the gate and the shipper
 * cannot disagree about which packages travel. Without this guard that import would assemble the
 * whole tree as a side effect of running a test.
 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await assemble()
  const entries = (await readdir(STAGING, { recursive: true })).length
  process.stdout.write(`${JSON.stringify({ staging: STAGING, ...report, entries }, null, 2)}\n`)
}

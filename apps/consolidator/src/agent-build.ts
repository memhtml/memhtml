import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"

import { ConsolidatorUnavailable } from "./contract.js"

/**
 * Where `eve build` may run, which is not always where this package is installed.
 *
 * eve is filesystem-first: `eve build` compiles `agent/` — and the `../../src/*.ts` it reaches — into
 * `.output/`, and `eve start` serves that directory. In a checkout that is `pnpm build:agent` writing
 * into the package itself, and it works.
 *
 * From an INSTALLED package it does not, and the failure is worse than an error: the build succeeds and
 * the server it produces cannot boot. Measured 2026-08-17 against an npm-installed tarball —
 * `eve build` exited 0, then `eve start` exited 13 on `Detected unsettled top-level await ... await
 * workflowWorld.start?.()`. The discriminator is the tree's LOCATION, not its contents: nitro
 * externalizes any module resolved from inside `node_modules`, so an installed `@memhtml/consolidator`
 * became a traced lib chunk (`server/index.mjs` 17.3 kB beside a 4.73 MB `_libs/@memhtml/…` chunk),
 * while the same sources built from a checkout were inlined (`index.mjs` 317 kB) and answered
 * `/eve/v1/health` with `{"ok":true,"status":"ready"}` in ~2s.
 *
 * So the agent tree is COPIED out to a cache directory and built there, where nothing above it is
 * named `node_modules` and nitro inlines it. Shipping a prebuilt `.output/` in the tarball is the other
 * candidate and is refused: the build traces native binaries into it
 * (`server/node_modules/node-liblzma/build/Release/node_lzma.node`) and eve says so itself — "Ensure
 * your production environment matches the builder OS and architecture (linux-x64)". A published
 * artifact cannot carry one platform's binaries.
 */

/**
 * eve's CLI entry point, or `null` when eve does not resolve from here.
 *
 * Spawned as `process.execPath <path>` rather than through a package manager, because a consumer who
 * installed this package has whatever manager they used and need not have any particular one on PATH.
 * `apps/cli/src/serve.ts` spawns the MCP server the same way, for the same reason.
 *
 * Resolution goes through the MANIFEST, not the bin. `resolve("eve/bin/eve.js")` raises
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`: eve's `exports` map declares no `./bin/*` subpath, so node refuses
 * the deep path even though the file is there (probed against eve 0.33.0). `./package.json` IS
 * exported, and the `bin` field beside it names the entry point.
 */
export const eveBinPath = (): string | null => {
  const require = createRequire(import.meta.url)
  let manifestPath: string
  try {
    manifestPath = require.resolve("eve/package.json")
  } catch {
    return null
  }
  const { bin } = require(manifestPath) as { readonly bin?: Record<string, string> | string }
  const entry = typeof bin === "string" ? bin : bin?.eve
  return entry === undefined ? null : resolve(dirname(manifestPath), entry)
}

/** Per-version, so an upgrade builds fresh instead of serving the previous release's output. */
const cacheRootFor = (version: string): string =>
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "memhtml", "eve", version)

/** A bare specifier's package name: two segments when scoped, one otherwise. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

/**
 * Every package the staged tree imports, read from the tree rather than from a manifest.
 *
 * A manifest looks like the obvious source and is the wrong one twice over. The published package is
 * assembled with its `@memhtml/*` edges resolved as siblings and its `dependencies` field deliberately
 * empty — declaring them inside a bundled manifest makes npm create phantom empty directories in the
 * vendored subtree, which poisons resolution for every sibling (probed 2026-08-17: an empty
 * `memhtml/node_modules/effect` made `import "effect"` fail from every vendored package). And the
 * agent tree's real requirement is what it IMPORTS, which is a subset a manifest cannot narrow to.
 *
 * So the specifiers are read off the files eve is about to compile. Relative imports resolve inside the
 * staged tree and `node:` builtins need nothing, so neither is linked.
 */
const importedPackages = async (roots: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const found = new Set<string>()
  const pattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, "utf8")
      for (const [, specifier] of text.matchAll(pattern)) {
        if (specifier === undefined) continue
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue
        if (specifier.startsWith("node:")) continue
        found.add(packageOf(specifier))
      }
    }
  }
  return [...found].sort()
}

/** Every `.ts` file under a directory, at any depth. */
const sourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(join(entry.parentPath, entry.name))
  }
  return out
}

const packageVersion = async (packageRoot: string): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly version?: string
  }
  return manifest.version ?? "0.0.0"
}

/**
 * Where a dependency's directory actually is, found the way node finds it.
 *
 * `require.resolve("<name>/package.json")` is the obvious route and is not enough: an `exports` map
 * that does not list `./package.json` makes node refuse the subpath, and two of this package's own
 * dependencies are like that — `@memhtml/contracts` and `just-bash` both answer
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` (probed 2026-08-17). Walking the ancestors' `node_modules` asks the
 * filesystem instead of the resolver, so an exports map cannot hide a directory that is plainly there.
 *
 * The walk covers every layout this ships into: pnpm's per-package symlink farm, npm's hoisted
 * top-level tree, and the vendored single-package tarball, where `@memhtml/*` sit one `node_modules`
 * in and the externals one further up.
 */
const dependencyDir = (fromDir: string, name: string): string | null => {
  let at = fromDir
  for (;;) {
    const candidate = join(at, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return candidate
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/**
 * Link every package the staged tree imports into the cache directory.
 *
 * A cache directory under `~/.cache` has no ancestor holding this package's dependencies — which is
 * the entire point of building outside `node_modules` — so node's upward walk from there finds nothing.
 * One symlink per imported package reproduces the module graph the installed package already has,
 * resolved from `packageRoot` because that is where the real tree is.
 */
const linkDependencies = async (input: {
  readonly packageRoot: string
  readonly cacheRoot: string
}): Promise<void> => {
  const { packageRoot, cacheRoot } = input
  const names = await importedPackages([join(cacheRoot, "agent"), join(cacheRoot, "src")])
  for (const name of names) {
    const from = dependencyDir(packageRoot, name)
    // A package that is not on disk is the build's problem to report, not this step's: eve names the
    // unresolved import, which is a better message than anything guessable here.
    if (from === null) continue
    const to = join(cacheRoot, "node_modules", name)
    if (existsSync(to)) continue
    await mkdir(dirname(to), { recursive: true })
    await symlink(from, to, "dir")
  }
}

/**
 * Copy the buildable tree into `cacheRoot`, ready for `eve build`.
 *
 * Exported because this is the half a reader can get subtly wrong and the half that needs no 17 MB
 * build to check: `agent/` reaches `../../src/*.js`, so the two directories travel TOGETHER and at
 * their original depth. Flattening them, or staging `agent/` alone, produces the
 * `UNRESOLVED_IMPORT` that a missing `src/` in the tarball already produced once.
 */
export const stageAgentTree = async (input: {
  readonly packageRoot: string
  readonly cacheRoot: string
  readonly version: string
}): Promise<void> => {
  const { packageRoot, cacheRoot, version } = input
  await mkdir(cacheRoot, { recursive: true })
  await cp(join(packageRoot, "agent"), join(cacheRoot, "agent"), { recursive: true })
  await cp(join(packageRoot, "src"), join(cacheRoot, "src"), { recursive: true })
  await writeFile(
    join(cacheRoot, "package.json"),
    `${JSON.stringify(
      { name: "memhtml-consolidator-agent", version, private: true, type: "module" },
      null,
      2
    )}\n`
  )
  await linkDependencies({ packageRoot, cacheRoot })
}

const runEveBuild = (input: {
  readonly eveBin: string
  readonly cwd: string
}): Effect.Effect<void, ConsolidatorUnavailable> =>
  Effect.callback<void, ConsolidatorUnavailable>((resume) => {
    const child = spawn(process.execPath, [input.eveBin, "build"], {
      cwd: input.cwd,
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      resume(
        Effect.fail(
          ConsolidatorUnavailable.make({ reason: `could not spawn eve build: ${String(cause)}` })
        )
      )
    })
    child.once("exit", (code) => {
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(
              ConsolidatorUnavailable.make({
                reason: `eve build exited with code ${String(code)} in ${input.cwd}. ${stderr.slice(-400)}`
              })
            )
      )
    })
    return Effect.sync(() => {
      child.kill("SIGKILL")
    })
  })

/**
 * The directory `eve start` will be run in, building the agent first when nothing has.
 *
 * Order is deliberate. An explicit `appRoot` is an operator's choice and is never second-guessed. A
 * package that already holds `.output/` is a checkout where `build:agent` has run, and reusing it keeps
 * development behaviour byte-identical. Only the remaining case — an installed package with no output —
 * materializes the cache directory, and it costs one ~17 MB build per version rather than one per run.
 */
export const resolveAgentAppRoot = (input: {
  readonly packageRoot: string
  readonly configured?: string | undefined
  readonly eveBin: string
}): Effect.Effect<string, ConsolidatorUnavailable> =>
  Effect.gen(function* () {
    const { packageRoot, configured, eveBin } = input
    if (configured !== undefined) return configured
    if (existsSync(join(packageRoot, ".output"))) return packageRoot

    const version = yield* Effect.tryPromise({
      try: () => packageVersion(packageRoot),
      catch: (cause) =>
        ConsolidatorUnavailable.make({
          reason: `could not read the consolidator's version: ${String(cause)}`
        })
    })
    const cacheRoot = cacheRootFor(version)
    if (existsSync(join(cacheRoot, ".output"))) return cacheRoot

    yield* Effect.logInfo(`building the consolidator agent into ${cacheRoot} (once per version)`)
    yield* Effect.tryPromise({
      try: () => stageAgentTree({ packageRoot, cacheRoot, version }),
      catch: (cause) =>
        ConsolidatorUnavailable.make({
          reason: `could not stage the consolidator agent in ${cacheRoot}: ${String(cause)}`
        })
    })

    yield* runEveBuild({ eveBin, cwd: cacheRoot })

    if (!existsSync(join(cacheRoot, ".output"))) {
      return yield* Effect.fail(
        ConsolidatorUnavailable.make({ reason: `eve build wrote no .output/ in ${cacheRoot}` })
      )
    }
    return cacheRoot
  })

/** Exported for the tests that assert the location, which is the part a reader can get wrong. */
export const agentCacheRootFor = (version: string): string => resolve(cacheRootFor(version))

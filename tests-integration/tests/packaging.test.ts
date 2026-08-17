import { readdir, readFile } from "node:fs/promises"
import { dirname, join, posix, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * What the published artifact carries, which is a different question from what the workspace runs.
 *
 * Every other tier resolves `@memhtml/*` through pnpm's links, where `guest/`, `agent/`, `src/`, and
 * the two migration directories sit on disk whether or not anything declares them. The published
 * package is a bundle: the emitted code lands in `dist/`, so each of those assets has to be COPIED to
 * where the bundled code still resolves it, and nothing about the workspace notices when it is not.
 *
 * Three assets were absent from every tarball under exactly that blindness — `guest/corpus.mjs`, the
 * consolidator's `src/*.ts`, and, once bundling arrived, the migrations, which a glob copied to
 * `migrations/index/migrations/` and left the directory the code reads empty of `.sql`. The symptom was
 * `no such table: files` on the first write, three steps from the cause.
 *
 * So the claims below are declarative and offline. Each names the asset, the source line that resolves
 * it, and the literal doing the resolving, and the assertions are that the shipper copies it, that the
 * resolution is still in the source, and that no undeclared resolution exists. Where the copied bytes
 * land at RUN time is `scripts/smoke-package.mjs`, which installs the tarball and uses it.
 */

/** A directory or file the bundled code resolves from its own module location at run time. */
interface AssetClaim {
  /** Path inside the published package, relative to its root. */
  readonly path: string
  /** Workspace directory the shipper copies from. */
  readonly from: string
  /** Repo-relative source file that resolves {@link path}. */
  readonly resolvedIn: string
  /** The literal in {@link resolvedIn} that does the resolving. */
  readonly needle: string
}

/**
 * A dependency whose FILE is read from `node_modules` rather than imported.
 *
 * These must stay external to the bundle: the code needs bytes at a resolvable path, not a module in
 * its own graph. A bundler that absorbed one would leave a passing unit suite and a broken install, so
 * both the externalization and the dependency edge are asserted.
 */
interface DependencyFileClaim {
  readonly dependency: string
  readonly declaredIn: string
  readonly resolvedIn: string
  readonly needle: string
}

const ASSET_CLAIMS: ReadonlyArray<AssetClaim> = [
  {
    path: "migrations",
    from: "packages/index/migrations",
    resolvedIn: "packages/index/src/schema-const.ts",
    needle: 'new URL("../migrations", import.meta.url)'
  },
  {
    path: "state-migrations",
    from: "packages/index/state-migrations",
    resolvedIn: "packages/index/src/schema-const.ts",
    needle: 'new URL("../state-migrations", import.meta.url)'
  },
  {
    path: "guest",
    from: "apps/cli/guest",
    resolvedIn: "apps/cli/src/exec.ts",
    needle: '"..", "guest", "corpus.mjs"'
  },
  /**
   * eve compiles `agent/` in a build of its own and reaches the consolidator's TypeScript by relative
   * path, so `src/` ships as SOURCE and the two travel together at their original depth.
   */
  {
    path: "agent",
    from: "apps/consolidator/agent",
    resolvedIn: "apps/consolidator/src/client.ts",
    needle: 'resolve(dirname(fileURLToPath(import.meta.url)), "..")'
  },
  {
    path: "src",
    from: "apps/consolidator/src",
    resolvedIn: "apps/consolidator/agent/sandbox/sandbox.ts",
    needle: '"../../src/mount.js"'
  }
]

const DEPENDENCY_FILE_CLAIMS: ReadonlyArray<DependencyFileClaim> = [
  /**
   * Read as TEXT and injected into the QuickJS guest, never loaded on the host. Its published
   * `dist/index.mjs` is already self-contained, which is why `memhtml exec` needs no bundling of its own.
   */
  {
    dependency: "node-html-parser",
    declaredIn: "apps/cli",
    resolvedIn: "apps/cli/src/exec.ts",
    needle: 'createRequire(import.meta.url)\n    .resolve("node-html-parser")'
  },
  /** Loaded lazily through `createRequire`, so 192 grammars stay off the read path's module graph. */
  {
    dependency: "highlight.js",
    declaredIn: "packages/html",
    resolvedIn: "packages/html/src/detect.ts",
    needle: 'requireModule("highlight.js")'
  },
  /**
   * eve's CLI is SPAWNED, so what matters is that its bin is a real file at a resolvable path. Reached
   * through `eve/package.json` because eve's `exports` map declares no `./bin/*` subpath.
   */
  {
    dependency: "eve",
    declaredIn: "apps/consolidator",
    resolvedIn: "apps/consolidator/src/agent-build.ts",
    needle: 'require.resolve("eve/package.json")'
  }
]

/** Packages whose compiled output becomes the bundle, taken from the shipper's own list. */
const BUNDLED_PACKAGES = [
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
] as const

const sourceOf = (path: string): Promise<string> => readFile(join(REPO_ROOT, path), "utf8")

/** Strip comments, so a text assertion is about CODE and not about the prose explaining it. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const tsdownConfig = async (): Promise<string> => codeOnly(await sourceOf("tsdown.config.ts"))

const manifestOf = async (dir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(REPO_ROOT, dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >

describe("the shipper copies every asset the bundled code resolves", () => {
  it.for(ASSET_CLAIMS)("copies $from into the package as $path", async (claim) => {
    const config = await tsdownConfig()
    // The directory form, `to: OUT_DIR`, because a directory source keeps its own name. A glob with
    // `flatten: false` nests one level deeper and silently empties the directory the code reads.
    expect(config).toContain(`{ from: "${claim.from}", to: OUT_DIR }`)
  })

  /**
   * The anti-stale half. A claim guards nothing once the resolution it describes has left the source,
   * and a guard that outlives its subject is worse than no guard: roughly a quarter of the regression
   * tests written in this repo were vacuous until someone reverted the fix and watched them fail.
   */
  it.for(ASSET_CLAIMS)("still resolves $path in $resolvedIn", async (claim) => {
    expect(await sourceOf(claim.resolvedIn)).toContain(claim.needle)
  })

  /** `files` is what npm serves. An asset copied but not listed is an asset that does not ship. */
  it("lists every asset in the published `files`", async () => {
    const writer = await sourceOf("scripts/package-manifest.mjs")
    for (const { path } of ASSET_CLAIMS) expect(writer).toContain(`"${path}"`)
  })
})

describe("a dependency read as a file stays external and declared", () => {
  it.for(DEPENDENCY_FILE_CLAIMS)("$declaredIn depends on $dependency", async (claim) => {
    const manifest = (await manifestOf(claim.declaredIn)) as {
      readonly dependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {})).toContain(claim.dependency)
    expect(await sourceOf(claim.resolvedIn)).toContain(claim.needle)
  })

  /**
   * The externalization is derived from the manifests rather than listed, and as SUBPATH patterns.
   * A bare name is not enough — this repo imports `effect/unstable/cli`, and externalizing only
   * `"effect"` inlined the rest and quadrupled the MCP bundle with no warning.
   */
  it("externalizes declared dependencies and their subpaths", async () => {
    const config = await tsdownConfig()
    expect(config).toContain("neverBundle: [...externalDependencies(), /^node:/]")
    expect(config).toContain("(?:/|$)")
    // Nothing hand-listed: a literal name here would go stale the moment a dependency is added.
    expect(config).not.toMatch(/neverBundle:\s*\[\s*"/)
  })

  /** `alwaysBundle` force-bundles what the matched packages import, which drags the externals back in. */
  it("does not force-bundle the workspace packages", async () => {
    expect(await tsdownConfig()).not.toContain("alwaysBundle")
  })
})

describe("only the assembled package can publish", () => {
  /**
   * The twelve were configured to publish in lockstep and never did, which is the only reason changing
   * it was free. `npm publish` refuses a private package, so the bundle is the only thing that ships
   * even if a workflow asks for more.
   */
  it.for(BUNDLED_PACKAGES)("%s is private", async (dir) => {
    const manifest = await manifestOf(dir)
    expect(manifest.private).toBe(true)
    // `publishConfig` on a package that cannot publish is a leftover that reads as intent.
    expect(manifest.publishConfig).toBeUndefined()
  })

  it("publishes one name, with two bins and no import surface", async () => {
    const writer = await sourceOf("scripts/package-manifest.mjs")
    expect(writer).toContain('name: "memhtml"')
    expect(writer).toContain('memhtml: "./dist/memhtml.mjs"')
    expect(writer).toContain('"memhtml-mcp": "./dist/memhtml-mcp.mjs"')
    // No `exports`: the contract is the binaries. Adding one later is a minor; removing one, a major.
    expect(writer).not.toMatch(/^\s*exports:/m)
  })
})

/**
 * The census, which is what makes the claim tables a gate rather than a list of things somebody thought
 * of. Any shipped source that resolves a path from its own location is declared or a failure, at the
 * commit that adds it rather than at somebody's install.
 */
describe("every run-time path resolution in shipped source is declared", () => {
  it("finds no undeclared `import.meta.url` resolution", async () => {
    const declared = new Set(
      [...ASSET_CLAIMS, ...DEPENDENCY_FILE_CLAIMS].map((claim) => posix.normalize(claim.resolvedIn))
    )
    // `serve.ts` resolves the sibling MCP bin, which is emitted BY the bundle rather than copied into
    // it, so it belongs to neither table. Named here so the census still refuses anything else.
    declared.add("apps/cli/src/serve.ts")

    /** Repo-relative `.ts` paths under a directory, at any depth, or none when it does not exist. */
    const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> => {
      const root = join(REPO_ROOT, dir)
      try {
        const names = await readdir(root, { recursive: true })
        return names
          .map((name) => posix.join(dir, name.split(sep).join(posix.sep)))
          .filter((path) => path.endsWith(".ts"))
      } catch {
        return []
      }
    }

    const scanned: string[] = []
    const undeclared: string[] = []
    for (const dir of BUNDLED_PACKAGES) {
      for (const sub of ["src", "agent"]) {
        for (const path of await filesUnder(posix.join(dir, sub))) {
          scanned.push(path)
          if (!(await sourceOf(path)).includes("import.meta.url")) continue
          if (!declared.has(path)) undeclared.push(path)
        }
      }
    }

    // A census asserts an independently-derived total rather than reporting one: a scan that silently
    // matched nothing would otherwise pass by finding no violations in an empty set.
    expect(scanned.length).toBeGreaterThan(60)
    expect(undeclared).toEqual([])
  })
})

import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, posix, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const run = promisify(execFile)

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * What the tarball carries, which is a different question from what the workspace runs.
 *
 * Every other tier here resolves `@memhtml/*` through the workspace, where `src/`, `guest/`,
 * `agent/`, and `migrations/` all sit on disk whether or not any manifest mentions them. `npm publish`
 * ships only what `files` names, so an asset the code resolves at run time and no manifest declares is
 * invisible to a green suite and absent from every install. Three such assets shipped broken before
 * this file existed: `guest/corpus.mjs` (so `memhtml exec` could not read its sandbox helper),
 * `apps/consolidator/src/*.ts` (so `eve build` could not resolve the agent tree's `../../src/*.js`
 * imports), and the migrations, which survive only because `packages/index` names them.
 *
 * So the unit under test is the pack manifest, and the assertions are declarative: a claim names the
 * asset, the source that resolves it, and the literal doing the resolving. A claim whose literal has
 * left the source fails as STALE, so a guard cannot outlive the thing it guards.
 */

/** A file that must reach the tarball because shipped code resolves it at run time. */
interface AssetClaim {
  /** Repo-relative package directory. */
  readonly dir: string
  /** Path inside the tarball, or a directory whose every {@link ext} file must ship. */
  readonly path: string
  /** When set, {@link path} is a directory and every file under it with this extension must ship. */
  readonly ext?: string
  /** Package-relative source file that resolves {@link path}. */
  readonly resolvedIn: string
  /** The literal in {@link resolvedIn} that does the resolving. */
  readonly needle: string
}

/**
 * A dependency whose FILE is read from `node_modules` rather than imported.
 *
 * These cannot be inlined by any future bundling step: the code needs bytes at a resolvable path, not
 * a module in its own graph. A bundler that helpfully absorbed one would leave a passing unit suite and
 * a broken install, so the dependency edge itself is the assertion.
 */
interface DependencyFileClaim {
  readonly dir: string
  readonly dependency: string
  readonly resolvedIn: string
  readonly needle: string
}

const ASSET_CLAIMS: ReadonlyArray<AssetClaim> = [
  {
    dir: "apps/cli",
    path: "guest/corpus.mjs",
    resolvedIn: "src/exec.ts",
    needle: '"..", "guest", "corpus.mjs"'
  },
  {
    dir: "packages/index",
    path: "migrations",
    ext: ".sql",
    resolvedIn: "src/schema-const.ts",
    needle: 'new URL("../migrations", import.meta.url)'
  },
  {
    dir: "packages/index",
    path: "state-migrations",
    ext: ".sql",
    resolvedIn: "src/schema-const.ts",
    needle: 'new URL("../state-migrations", import.meta.url)'
  },
  /**
   * eve is filesystem-first and compiles `agent/` in a build of its own, reaching this package's
   * TypeScript by relative path. So `src/` ships as SOURCE — the one package here for which `dist/` is
   * not the whole shipped artifact.
   */
  {
    dir: "apps/consolidator",
    path: "src/mount.ts",
    resolvedIn: "agent/sandbox/sandbox.ts",
    needle: '"../../src/mount.js"'
  },
  {
    dir: "apps/consolidator",
    path: "src/run-auth.ts",
    resolvedIn: "agent/channels/eve.ts",
    needle: '"../../src/run-auth.js"'
  },
  {
    dir: "apps/consolidator",
    path: "agent",
    ext: ".ts",
    resolvedIn: "src/client.ts",
    needle: 'resolve(dirname(fileURLToPath(import.meta.url)), "..")'
  },
  {
    dir: "apps/consolidator",
    path: "agent/instructions.md",
    resolvedIn: "agent/agent.ts",
    needle: "instructions"
  },
  /**
   * The server the CLI's `serve mcp` supervisor spawns. `@memhtml/mcp` depends on `@memhtml/cli` for
   * the composition root, so the edge cannot be a dependency without a cycle and the path is a
   * relative walk across two packages instead. That walk lands correctly only where the two
   * directories are siblings — a flat `node_modules/@memhtml/`, or the workspace. It is why
   * `MEMHTML_MCP_BIN` exists, and it dissolves entirely once both bins ship from one package.
   */
  {
    dir: "apps/mcp",
    path: "dist/bin.js",
    resolvedIn: "../cli/src/serve.ts",
    needle: 'new URL("../../mcp/dist/bin.js", import.meta.url)'
  }
]

const DEPENDENCY_FILE_CLAIMS: ReadonlyArray<DependencyFileClaim> = [
  /**
   * Read as TEXT and injected into the QuickJS guest, never loaded on the host. `node-html-parser`'s
   * published `dist/index.mjs` is already self-contained, which is the whole reason `memhtml exec`
   * needs no bundling step of its own.
   */
  {
    dir: "apps/cli",
    dependency: "node-html-parser",
    resolvedIn: "src/exec.ts",
    needle: 'createRequire(import.meta.url)\n    .resolve("node-html-parser")'
  },
  /**
   * Loaded lazily through `createRequire` on the first detection, so 192 grammars stay off the read
   * path's module graph.
   */
  {
    dir: "packages/html",
    dependency: "highlight.js",
    resolvedIn: "src/detect.ts",
    needle: 'requireModule("highlight.js")'
  }
]

interface Packed {
  readonly name: string
  readonly paths: ReadonlySet<string>
}

/** Every publishable workspace package, discovered rather than listed, so a new one cannot escape. */
const publishableDirs = async (): Promise<ReadonlyArray<string>> => {
  const found: string[] = []
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(REPO_ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = posix.join(parent, entry.name)
      const manifest = JSON.parse(
        await readFile(join(REPO_ROOT, dir, "package.json"), "utf8")
      ) as Record<string, unknown>
      if (manifest.private !== true) found.push(dir)
    }
  }
  return found.sort()
}

const packed = new Map<string, Packed>()

const pack = async (dir: string): Promise<Packed> => {
  const cached = packed.get(dir)
  if (cached !== undefined) return cached
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(REPO_ROOT, dir),
    maxBuffer: 32 * 1024 * 1024
  })
  const [report] = JSON.parse(stdout) as ReadonlyArray<{
    readonly name: string
    readonly files: ReadonlyArray<{ readonly path: string }>
  }>
  if (report === undefined) throw new Error(`npm pack reported nothing for ${dir}`)
  const result: Packed = { name: report.name, paths: new Set(report.files.map((f) => f.path)) }
  packed.set(dir, result)
  return result
}

const sourceOf = (dir: string, file: string): Promise<string> =>
  readFile(join(REPO_ROOT, dir, file), "utf8")

/** Every file under a shipped directory, tarball-relative, at any depth. */
const filesUnder = async (
  dir: string,
  sub: string,
  ext: string
): Promise<ReadonlyArray<string>> => {
  const root = join(REPO_ROOT, dir, sub)
  const out: string[] = []
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(ext)) out.push(posix.join(sub, relative(root, full)))
    }
  }
  await walk(root)
  return out.sort()
}

describe("the pack manifest carries every asset the shipped code resolves", () => {
  it.for(ASSET_CLAIMS)("$dir ships $path", async (claim) => {
    const { paths } = await pack(claim.dir)
    const wanted =
      claim.ext === undefined ? [claim.path] : await filesUnder(claim.dir, claim.path, claim.ext)

    expect(wanted.length).toBeGreaterThan(0)
    for (const path of wanted) expect(paths).toContain(path)
  })

  /**
   * The anti-stale half. A claim is only a guard while the resolution it describes is still in the
   * source; once it is not, the claim silently guards nothing and the asset can leave `files`
   * unnoticed. Roughly a quarter of the regression tests written in this repo were vacuous until
   * someone reverted the fix and watched them fail, so the claim proves itself here instead.
   */
  it.for(ASSET_CLAIMS)("$dir still resolves $path in $resolvedIn", async (claim) => {
    expect(await sourceOf(claim.dir, claim.resolvedIn)).toContain(claim.needle)
  })
})

describe("a dependency read as a file stays an unbundled dependency", () => {
  it.for(DEPENDENCY_FILE_CLAIMS)("$dir depends on $dependency", async (claim) => {
    const manifest = JSON.parse(
      await readFile(join(REPO_ROOT, claim.dir, "package.json"), "utf8")
    ) as {
      readonly dependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {})).toContain(claim.dependency)
    expect(await sourceOf(claim.dir, claim.resolvedIn)).toContain(claim.needle)
  })
})

/**
 * The census, which is what makes the two tables above a gate rather than a list of things somebody
 * happened to think of. Any shipped source file that resolves a path from its own location is either
 * declared or a failure: a new asset added with no claim fails here, at the commit that adds it,
 * rather than at somebody's install.
 */
describe("every run-time path resolution in shipped source is declared", () => {
  it("finds no undeclared `import.meta.url` resolution", async () => {
    const declared = new Set(
      [...ASSET_CLAIMS, ...DEPENDENCY_FILE_CLAIMS].map((c) =>
        posix.join(c.dir, posix.normalize(c.resolvedIn))
      )
    )

    const undeclared: string[] = []
    for (const dir of await publishableDirs()) {
      for (const sub of ["src", "agent"]) {
        let files: ReadonlyArray<string>
        try {
          files = await filesUnder(dir, sub, ".ts")
        } catch {
          continue
        }
        for (const file of files) {
          if (!(await sourceOf(dir, file)).includes("import.meta.url")) continue
          if (!declared.has(posix.join(dir, file))) undeclared.push(posix.join(dir, file))
        }
      }
    }

    expect(undeclared).toEqual([])
  })
})

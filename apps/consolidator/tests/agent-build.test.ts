import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { agentCacheRootFor, resolveAgentAppRoot, stageAgentTree } from "../src/agent-build.js"
import type { ConsolidatorUnavailable } from "../src/contract.js"

/**
 * Where the agent gets built, which an installed package cannot decide the way a checkout can.
 *
 * The measurement behind all of this is in `agent-build.ts`: built from inside `node_modules`, eve's
 * output is a server that exits 13 on an unsettled top-level await, because nitro externalizes any
 * module it resolves from there. Built from a directory with no `node_modules` ancestor, the same
 * sources inline and the server answers its health route. So the cases below are about LOCATION, and
 * none of them runs a real 17 MB build — the end-to-end proof belongs to the tier that installs a
 * tarball, and what is checkable cheaply is which directory is chosen and what is put in it.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** An eve bin path that is never spawned: every case here returns before the build step. */
const UNUSED_EVE_BIN = "/nonexistent/eve/bin/eve.js"

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "agent-build-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const run = <A>(
  effect: Effect.Effect<A, ConsolidatorUnavailable>
): Promise<Result.Result<A, ConsolidatorUnavailable>> => Effect.runPromise(Effect.result(effect))

describe("the cache directory is keyed by version", () => {
  /**
   * Per-version and not per-install: two versions of this package must not serve each other's output,
   * and one version must not rebuild 17 MB on every run.
   */
  it("puts a version in the path", () => {
    expect(agentCacheRootFor("1.2.3")).toContain(join("memhtml", "eve", "1.2.3"))
    expect(agentCacheRootFor("1.2.3")).not.toBe(agentCacheRootFor("1.2.4"))
  })

  /** `XDG_CACHE_HOME` is where a cache belongs when the environment names one. */
  it("honours XDG_CACHE_HOME", () => {
    const before = process.env.XDG_CACHE_HOME
    try {
      process.env.XDG_CACHE_HOME = "/tmp/xdg-probe"
      expect(agentCacheRootFor("9.9.9")).toBe(join("/tmp/xdg-probe", "memhtml", "eve", "9.9.9"))
    } finally {
      if (before === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = before
    }
  })
})

describe("an app root the caller named is never second-guessed", () => {
  /**
   * `appRoot` is an operator's escape hatch for a deployment that puts the agent somewhere this code
   * would not look. Overriding it and then relocating the build would make the option a suggestion.
   */
  it("returns the configured root verbatim, and builds nothing", async () => {
    const result = await run(
      resolveAgentAppRoot({
        packageRoot: PACKAGE_ROOT,
        configured: scratch,
        eveBin: UNUSED_EVE_BIN
      })
    )
    expect(Result.getOrThrow(result)).toBe(scratch)
    expect(existsSync(join(scratch, "agent"))).toBe(false)
  })
})

describe("a tree that already holds .output is used where it is", () => {
  /**
   * The checkout case, and it keeps development byte-identical: `pnpm build:agent` writes `.output/`
   * into the package, and finding it there means no copy, no cache directory, and no second build.
   */
  it("prefers the package's own .output", async () => {
    await mkdir(join(scratch, ".output"), { recursive: true })
    const result = await run(
      resolveAgentAppRoot({ packageRoot: scratch, configured: undefined, eveBin: UNUSED_EVE_BIN })
    )
    expect(Result.getOrThrow(result)).toBe(scratch)
  })
})

describe("staging copies agent/ and src/ together, at their original depth", () => {
  /**
   * `agent/sandbox/sandbox.ts` reaches `../../src/mount.js` and `agent/channels/eve.ts` reaches
   * `../../src/run-auth.js`. Two levels up from `agent/<dir>/` is the staged root, so `src/` has to sit
   * beside `agent/` exactly as it does in the package. Staging `agent/` alone is the mistake this
   * proves against, and it is the same `UNRESOLVED_IMPORT` a tarball without `src/` produced.
   */
  it("lands src/ beside agent/, so ../../src resolves", async () => {
    await stageAgentTree({ packageRoot: PACKAGE_ROOT, cacheRoot: scratch, version: "0.0.0-test" })

    expect(existsSync(join(scratch, "agent", "agent.ts"))).toBe(true)
    expect(existsSync(join(scratch, "agent", "sandbox", "sandbox.ts"))).toBe(true)
    expect(existsSync(join(scratch, "agent", "channels", "eve.ts"))).toBe(true)
    expect(existsSync(join(scratch, "agent", "instructions.md"))).toBe(true)

    // The assertion that matters: resolve the import the way the file spells it.
    const fromSandbox = resolve(join(scratch, "agent", "sandbox"), "..", "..", "src", "mount.ts")
    const fromChannel = resolve(
      join(scratch, "agent", "channels"),
      "..",
      "..",
      "src",
      "run-auth.ts"
    )
    expect(existsSync(fromSandbox)).toBe(true)
    expect(existsSync(fromChannel)).toBe(true)
  })

  /** A manifest, because a staged tree with no `package.json` is not a package eve can build. */
  it("writes a private ESM manifest carrying the version", async () => {
    await stageAgentTree({ packageRoot: PACKAGE_ROOT, cacheRoot: scratch, version: "4.5.6" })
    const manifest = JSON.parse(await readFile(join(scratch, "package.json"), "utf8")) as {
      readonly type?: string
      readonly private?: boolean
      readonly version?: string
    }
    expect(manifest.type).toBe("module")
    expect(manifest.private).toBe(true)
    expect(manifest.version).toBe("4.5.6")
  })

  /**
   * The staged tree has no ancestor holding this package's dependencies — that is the whole point of
   * moving out of `node_modules` — so each package the tree IMPORTS is linked in by name. The list comes
   * from the sources rather than from a manifest, because the published package's vendored manifest
   * carries no `dependencies` (declaring them makes npm plant phantom empty directories in the bundled
   * subtree). Every name here is one the agent tree really imports.
   */
  it("links every package the staged tree imports", async () => {
    await stageAgentTree({ packageRoot: PACKAGE_ROOT, cacheRoot: scratch, version: "0.0.0-test" })
    for (const name of [
      "eve",
      "@ai-sdk/amazon-bedrock",
      "effect",
      "just-bash",
      "@memhtml/contracts"
    ]) {
      expect(existsSync(join(scratch, "node_modules", name, "package.json"))).toBe(true)
    }
  })

  /**
   * A census, so a NEW bare import in `agent/` or `src/` cannot arrive unlinked. The expected set is
   * derived here from the same sources the staging step reads, and the assertion is that every name in
   * it landed — a scan that quietly matched nothing would fail on the emptiness first.
   */
  it("leaves no imported package unlinked", async () => {
    await stageAgentTree({ packageRoot: PACKAGE_ROOT, cacheRoot: scratch, version: "0.0.0-test" })
    const wanted = new Set<string>()
    for (const sub of ["agent", "src"]) {
      for (const entry of await readdir(join(scratch, sub), {
        withFileTypes: true,
        recursive: true
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
        const text = await readFile(join(entry.parentPath, entry.name), "utf8")
        for (const [, spec] of text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
          if (spec === undefined || /^[./]/.test(spec) || spec.startsWith("node:")) continue
          const segments = spec.split("/")
          const first = segments[0] ?? spec
          wanted.add(spec.startsWith("@") ? segments.slice(0, 2).join("/") : first)
        }
      }
    }
    expect(wanted.size).toBeGreaterThan(3)
    const missing = [...wanted].filter(
      (name) => !existsSync(join(scratch, "node_modules", name, "package.json"))
    )
    expect(missing).toEqual([])
  })

  /** Staging twice is how a resumed run behaves, and it must not fail on links that already exist. */
  it("is idempotent", async () => {
    await stageAgentTree({ packageRoot: PACKAGE_ROOT, cacheRoot: scratch, version: "0.0.0-test" })
    await expect(
      stageAgentTree({ packageRoot: PACKAGE_ROOT, cacheRoot: scratch, version: "0.0.0-test" })
    ).resolves.toBeUndefined()
  })
})

describe("a build that produces nothing is a typed failure", () => {
  /**
   * The spawn cannot succeed here — the bin does not exist — and the point is that it arrives as
   * `ConsolidatorUnavailable` rather than as a defect. A sleep cycle skips an unavailable consolidator
   * and keeps its other fourteen phases.
   */
  it("reports ConsolidatorUnavailable when eve cannot be spawned", async () => {
    const packageRoot = join(scratch, "pkg")
    await mkdir(join(packageRoot, "agent"), { recursive: true })
    await mkdir(join(packageRoot, "src"), { recursive: true })
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "probe", version: "0.0.1", dependencies: {} })
    )
    process.env.XDG_CACHE_HOME = join(scratch, "cache")
    try {
      const result = await run(
        resolveAgentAppRoot({ packageRoot, configured: undefined, eveBin: UNUSED_EVE_BIN })
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ConsolidatorUnavailable")
        expect(result.failure.reason).toContain("eve build")
      }
    } finally {
      delete process.env.XDG_CACHE_HOME
    }
  })
})

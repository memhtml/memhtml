import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  acquireBuildLock,
  agentCacheRootFor,
  cacheBuildComplete,
  claimStaleLock,
  resolveAgentAppRoot,
  stageAgentTree
} from "../src/agent-build.js"
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
  it("honors XDG_CACHE_HOME", () => {
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

describe("completion is the marker plus the output, never the directory alone", () => {
  const packagedProbe = async (): Promise<string> => {
    const packageRoot = join(scratch, "pkg")
    await mkdir(join(packageRoot, "agent"), { recursive: true })
    await mkdir(join(packageRoot, "src"), { recursive: true })
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "probe", version: "0.0.1", dependencies: {} })
    )
    return packageRoot
  }

  /**
   * THE partial-build regression. `eve build` writes `.output/` in place over seconds, so a process
   * killed mid-build leaves a partial directory — and a bare `existsSync(.output)` reads it as a
   * completed build FOREVER: nothing ever rebuilds it and `eve start` serves half an app. A cache
   * root holding `.output/` but no completion marker is exactly that shape, and the resolver must
   * REBUILD (here: fail at the unspawnable eve, proving it went down the build path) rather than
   * return the partial.
   *
   * (Mutation: restoring `if (existsSync(join(cacheRoot, ".output"))) return cacheRoot` makes this
   * case get the partial cache root back as a success, which fails both assertions.)
   */
  it("rebuilds when .output exists WITHOUT the completion marker", async () => {
    const packageRoot = await packagedProbe()
    process.env.XDG_CACHE_HOME = join(scratch, "cache")
    try {
      const cacheRoot = agentCacheRootFor("0.0.1")
      // The shape a killed build leaves: output present, no marker.
      await mkdir(join(cacheRoot, ".output"), { recursive: true })
      expect(cacheBuildComplete(cacheRoot)).toBe(false)

      const result = await run(
        resolveAgentAppRoot({ packageRoot, configured: undefined, eveBin: UNUSED_EVE_BIN })
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason).toContain("eve build")
    } finally {
      delete process.env.XDG_CACHE_HOME
    }
  })

  /** The marked cache is served with no build: the once-per-version economics survive the marker. */
  it("returns a cache root whose marker AND output are present, building nothing", async () => {
    const packageRoot = await packagedProbe()
    process.env.XDG_CACHE_HOME = join(scratch, "cache")
    try {
      const cacheRoot = agentCacheRootFor("0.0.1")
      await mkdir(join(cacheRoot, ".output"), { recursive: true })
      await writeFile(join(cacheRoot, ".memhtml-build-complete"), "test\n")
      expect(cacheBuildComplete(cacheRoot)).toBe(true)

      const result = await run(
        resolveAgentAppRoot({ packageRoot, configured: undefined, eveBin: UNUSED_EVE_BIN })
      )
      // UNUSED_EVE_BIN cannot be spawned, so a success proves no build ran.
      expect(Result.getOrThrow(result)).toBe(cacheRoot)
    } finally {
      delete process.env.XDG_CACHE_HOME
    }
  })

  /** A marker with no output beside it certifies nothing — both halves are required. */
  it("does not treat a marker without .output as complete", async () => {
    const cacheRoot = join(scratch, "marker-only")
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(join(cacheRoot, ".memhtml-build-complete"), "test\n")
    expect(cacheBuildComplete(cacheRoot)).toBe(false)
  })
})

/**
 * A stand-in for `eve build`, spawned exactly as the real one is: `process.execPath <path> build`, with
 * the build directory as its cwd.
 *
 * Most of what it drives is not eve's behavior but what THIS module does with an exit code and a cwd,
 * and a real build is ~17 MB of nitro output. The fake is what makes the publish path drivable at all:
 * every case above returns before the spawn, so staging → verify → marker had no cover.
 *
 * The ONE piece of eve's behavior it does reproduce is the load-bearing one — see
 * {@link EVE_WRITES_SERVER_ENTRY}.
 */
const fakeEve = async (label: string, body: string): Promise<string> => {
  const bin = join(scratch, `eve-${label}.mjs`)
  await writeFile(bin, body, "utf8")
  return bin
}

/**
 * Writes the server entry a real build writes, then exits 0 — and BAKES ITS BUILD-TIME CWD into it, in
 * the shape eve uses.
 *
 * That one detail is what lets an offline fake catch a relocated build. eve writes the absolute
 * `appRoot`/`agentRoot` of the directory it built in into `.output/server/index.mjs` and re-bundles the
 * authored source from that path at boot, so a finished build serves nothing from anywhere else
 * (`agent-build.ts` carries the measurement). A fake that emitted a constant string cannot express
 * that: a resolver which built the tree somewhere and moved it into place would satisfy every other
 * assertion in this file — entry present, output present, marker present — and hand back a directory
 * whose server exits 1.
 */
const EVE_WRITES_SERVER_ENTRY = `
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const server = join(process.cwd(), ".output", "server")
mkdirSync(server, { recursive: true })
const baked = JSON.stringify({ appRoot: process.cwd(), agentRoot: join(process.cwd(), "agent") })
writeFileSync(join(server, "index.mjs"), "const manifest = " + baked + "\\n")
`

/** Exits 0 having created `.output/` and put nothing in it: exit 0, produced nothing. */
const EVE_WRITES_EMPTY_OUTPUT = `
import { mkdirSync } from "node:fs"
import { join } from "node:path"
mkdirSync(join(process.cwd(), ".output"), { recursive: true })
`

/** Writes a complete-looking output and is then SIGKILLed, which is the death the marker exists for. */
const EVE_DIES_AFTER_WRITING_OUTPUT = `
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const server = join(process.cwd(), ".output", "server")
mkdirSync(server, { recursive: true })
writeFileSync(join(server, "index.mjs"), "// a half-published server\\n")
process.kill(process.pid, "SIGKILL")
`

/**
 * Writes a first and a last stderr line 2 KiB apart, then fails.
 *
 * The exit is deferred by a timer rather than taken with `process.exit`, and that is load-bearing for
 * the case that reads the message: a parent's `exit` event may fire while stdio data is still in
 * flight, so a fake that died the instant it wrote would make the assertion race the pipe.
 */
const EVE_FAILS_NOISILY = `
process.stderr.write("HEAD_MARKER the first line eve wrote " + "noise ".repeat(400) + "\\n")
process.stderr.write("TAIL_MARKER the line that killed it\\n")
setTimeout(() => {
  process.exitCode = 1
}, 50)
`

/** A package root shaped like an installed one: `agent/`, `src/`, and a version to key the cache by. */
const probePackageRoot = async (): Promise<string> => {
  const packageRoot = join(scratch, "pkg")
  await mkdir(join(packageRoot, "agent"), { recursive: true })
  await mkdir(join(packageRoot, "src"), { recursive: true })
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "probe", version: "0.0.1", dependencies: {} })
  )
  return packageRoot
}

/** Run a resolve with the cache redirected into the scratch directory, never the developer's own. */
const resolveWithCache = async (input: {
  readonly packageRoot: string
  readonly eveBin: string
}): Promise<Result.Result<string, ConsolidatorUnavailable>> => {
  const before = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = join(scratch, "cache")
  try {
    return await run(
      resolveAgentAppRoot({
        packageRoot: input.packageRoot,
        configured: undefined,
        eveBin: input.eveBin
      })
    )
  } finally {
    if (before === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = before
  }
}

/** The cache root the resolve above would choose for the probe package's version. */
const probeCacheRoot = (): string => {
  const before = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = join(scratch, "cache")
  try {
    return agentCacheRootFor("0.0.1")
  } finally {
    if (before === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = before
  }
}

/**
 * The build-time root a build baked into its own output, which is what eve's boot resolves against.
 *
 * Read back out of the emitted entry rather than assumed, because the assertion this serves is an
 * EQUALITY between where the build ran and where the resolver says to serve from, and a helper that
 * returned the directory it was handed would make that equality vacuous.
 */
const bakedAppRoot = async (appRoot: string): Promise<string> => {
  const emitted = await readFile(join(appRoot, ".output", "server", "index.mjs"), "utf8")
  const found = /const manifest = (\{.*\})/.exec(emitted)
  expect(found).not.toBeNull()
  const manifest = JSON.parse(found?.[1] ?? "{}") as { readonly appRoot?: string }
  return manifest.appRoot ?? ""
}

describe("a build is complete when it is marked, and only once it produced a server", () => {
  /**
   * THE publish path, which no case could reach before a fake eve existed: stage into the cache root,
   * verify the entry, write the marker. The marker and the output have to be readable TOGETHER, because
   * `cacheBuildComplete` is the answer every later run reads.
   *
   * (Mutation: dropping the `writeFile(buildMarkerPath(cacheRoot))` line leaves a cache root whose
   * `.output/` is complete and which `cacheBuildComplete` reads as partial, failing the third
   * assertion — and in production the finalizer would then delete a good build and the next run would
   * rebuild forever.)
   */
  it("marks a verified build, so the marker and the output are read together", async () => {
    const packageRoot = await probePackageRoot()
    const eveBin = await fakeEve("ok", EVE_WRITES_SERVER_ENTRY)
    const cacheRoot = probeCacheRoot()

    const result = await resolveWithCache({ packageRoot, eveBin })
    expect(Result.getOrThrow(result)).toBe(cacheRoot)
    expect(existsSync(join(cacheRoot, ".output", "server", "index.mjs"))).toBe(true)
    expect(cacheBuildComplete(cacheRoot)).toBe(true)
  })

  /**
   * THE relocation lock, and the one case in this file that is about eve's behavior rather than this
   * module's. eve bakes the absolute path of the directory it built in into `.output/`, and at boot it
   * re-bundles the authored source from that path — so the directory a build ran in is the only
   * directory it can be served from, and a finished build is not a movable artifact. The check is the
   * one eve's own boot performs: the root this resolver hands back IS the root the build ran in.
   *
   * Nothing cheaper can hold this. A resolver that built the tree in a temp sibling and moved it into
   * place satisfies every other assertion here — entry present, output present, marker present, cache
   * root returned — and yields a server that exits 1 on `Failed to resolve the authored package root`,
   * which only a real `eve start` would show. Reproducing eve's baked path in the fake is what brings
   * the failure inside the offline tier.
   *
   * (Mutation: building in a `${cacheRoot}.staging-<pid>` sibling and `rename`ing it into place makes
   * the baked path the staging path, so the first assertion compares two different directories and
   * fails. Publishing `.output/` without `agent/` beside it fails the third.)
   */
  it("serves the build from the directory it was built in, which is what eve bakes", async () => {
    const packageRoot = await probePackageRoot()
    const eveBin = await fakeEve("ok-baked", EVE_WRITES_SERVER_ENTRY)

    const appRoot = Result.getOrThrow(await resolveWithCache({ packageRoot, eveBin }))

    expect(await bakedAppRoot(appRoot)).toBe(appRoot)
    // Non-vacuity: an equality between two empty strings would also pass the line above.
    expect(await bakedAppRoot(appRoot)).toContain(join("memhtml", "eve", "0.0.1"))
    // eve re-bundles the SOURCE at the baked path, so `agent/` has to still be there beside the output.
    expect(existsSync(join(appRoot, "agent"))).toBe(true)
  })

  /**
   * A build that dies after writing its output leaves NOTHING a later run consults. The killed
   * process's `.output/` is complete and it carries no marker, so `cacheBuildComplete` reads it as the
   * partial it is and the finalizer reclaims the whole root under the lock, rather than leaving ~17 MB
   * for a sweep that would have to exist.
   *
   * (Mutation: dropping the `Effect.ensuring` finalizer leaves the killed build's cache root on disk
   * and fails the third assertion. Writing the marker BEFORE verifying the entry makes
   * `cacheBuildComplete` true for that wreckage, so the finalizer spares it and the fourth fails.)
   */
  it("leaves no cache root when the build dies after writing its output", async () => {
    const packageRoot = await probePackageRoot()
    const cacheRoot = probeCacheRoot()

    const killed = await resolveWithCache({
      packageRoot,
      eveBin: await fakeEve("killed", EVE_DIES_AFTER_WRITING_OUTPUT)
    })
    expect(Result.isFailure(killed)).toBe(true)
    if (Result.isFailure(killed)) expect(killed.failure.reason).toContain("eve build")
    expect(existsSync(cacheRoot)).toBe(false)
    expect(cacheBuildComplete(cacheRoot)).toBe(false)

    // The next run rebuilds and succeeds, which is what "nothing consultable" has to mean.
    const retried = await resolveWithCache({
      packageRoot,
      eveBin: await fakeEve("ok-after-kill", EVE_WRITES_SERVER_ENTRY)
    })
    expect(Result.getOrThrow(retried)).toBe(cacheRoot)
    expect(cacheBuildComplete(cacheRoot)).toBe(true)
  })

  /**
   * `eve build` exiting 0 is not the claim that it emitted a server. An empty `.output/` earns the
   * completion marker under a directory check and the marker is permanent, so the box would serve an
   * app with no entry point for that version's whole life — the "a scanner can exit 0 having produced
   * nothing" hazard in build form. The file a boot needs is what gets verified.
   *
   * (Mutation: restoring `existsSync(join(staging, ".output"))` makes this build succeed, publish, and
   * return the cache root, failing every assertion here.)
   */
  it("REFUSES a build that exits 0 with an empty output directory", async () => {
    const packageRoot = await probePackageRoot()
    const cacheRoot = probeCacheRoot()

    const result = await resolveWithCache({
      packageRoot,
      eveBin: await fakeEve("empty", EVE_WRITES_EMPTY_OUTPUT)
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("ConsolidatorUnavailable")
      // The reason names the file, because "no .output/" would send an operator to a directory that
      // is right there.
      expect(result.failure.reason).toContain(join(".output", "server", "index.mjs"))
    }
    expect(cacheBuildComplete(cacheRoot)).toBe(false)
    expect(existsSync(join(cacheRoot, ".memhtml-build-complete"))).toBe(false)
  })

  /**
   * The build child's stderr reaches the operator as its TAIL. A message rendered from the head of the
   * retained buffer shows what the child said first, which for a failing build is its banner.
   *
   * (Mutation: rendering `stderr.slice(0, 400)` puts HEAD_MARKER in the reason and drops TAIL_MARKER,
   * failing both assertions.)
   */
  it("carries the END of the build child's stderr into the failure", async () => {
    const packageRoot = await probePackageRoot()
    const result = await resolveWithCache({
      packageRoot,
      eveBin: await fakeEve("noisy", EVE_FAILS_NOISILY)
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toContain("TAIL_MARKER")
      expect(result.failure.reason).not.toContain("HEAD_MARKER")
    }
  })
})

describe("the build lock excludes concurrent builders", () => {
  /**
   * Two processes resolving the same unbuilt version — the sleep cycle and a hand-driven `memhtml` —
   * would otherwise stage into one shared cache root at once, interleaving two `eve build`s' trees.
   * `mkdir` is the atomic primitive; holding the lock means the second acquirer WAITS.
   */
  it("blocks a second acquirer until the first releases", async () => {
    const cacheRoot = join(scratch, "locked")
    const first = await acquireBuildLock(cacheRoot)

    let secondHeld = false
    const second = acquireBuildLock(cacheRoot).then((lock) => {
      secondHeld = true
      return lock
    })
    // Long enough for at least one poll cycle: the second must still be waiting.
    await new Promise((done) => setTimeout(done, 700))
    expect(secondHeld).toBe(false)

    await first.release()
    const lock = await second
    expect(secondHeld).toBe(true)
    await lock.release()
  })

  /**
   * A holder killed between `mkdir` and `release` leaves the lock directory behind with no process
   * to remove it; without the age gate every future run on the box would wait out its full budget
   * and fail. A lock older than the stale age is TAKEN OVER. The age is forged with `utimes` rather
   * than waited out.
   */
  it("takes over a lock whose holder is stale", async () => {
    const cacheRoot = join(scratch, "stale")
    const lockDir = `${cacheRoot}.lock`
    await mkdir(lockDir, { recursive: true })
    const old = (Date.now() - 11 * 60_000) / 1000
    await utimes(lockDir, old, old)

    const lock = await acquireBuildLock(cacheRoot)
    expect(existsSync(lockDir)).toBe(true)
    await lock.release()
    expect(existsSync(lockDir)).toBe(false)
  })

  /**
   * The takeover discards ONE directory: the one whose staleness was measured.
   *
   * Two waiters can both read the same stale lock and both decide to take it over, and the ordering
   * `stat(A), stat(B), claim(A), mkdir(A), claim(B), mkdir(B)` is what a takeover that removed whatever
   * sat at the path admits — B discards the fresh lock A just took and both end up holding, which
   * permits two concurrent ~17 MB builds and lets a builder that already returned its cache root find it
   * momentarily absent. The claim is a `rename` bound to the measured INODE, so B's late claim finds a
   * stranger and puts it back.
   *
   * Driven directly because the interleaving cannot be forced through {@link acquireBuildLock} from one
   * process: a waiter's own `mkdir` follows its claim immediately.
   *
   * (Mutation: restoring `rm(lockDir, { recursive: true, force: true })` in place of the inode-bound
   * rename fails the first case — the lock is gone — and leaves the second passing.)
   */
  it("REFUSES to discard a lock whose inode is not the one measured as stale", async () => {
    const cacheRoot = join(scratch, "identity")
    const lockDir = `${cacheRoot}.lock`
    await mkdir(dirname(lockDir), { recursive: true })
    await mkdir(lockDir)
    await writeFile(join(lockDir, "holder"), "a live builder\n")

    // The reading a waiter would be acting on if the lock it measured had already been released and
    // replaced: an inode no directory at this path has.
    await claimStaleLock(lockDir, -1)

    expect(existsSync(lockDir)).toBe(true)
    // Put back where it was, contents intact, rather than left in the staging name.
    expect(existsSync(join(lockDir, "holder"))).toBe(true)
    expect(await readdir(dirname(lockDir))).toEqual([basename(lockDir)])
  })

  /** The non-vacuity control: the measured inode IS discarded, or the takeover would never fire. */
  it("discards the lock it measured, and nothing beside it", async () => {
    const cacheRoot = join(scratch, "measured")
    const lockDir = `${cacheRoot}.lock`
    await mkdir(dirname(lockDir), { recursive: true })
    await mkdir(lockDir)
    const { ino } = await stat(lockDir)

    await claimStaleLock(lockDir, ino)

    expect(existsSync(lockDir)).toBe(false)
    // No staging name is left behind either: a `.stale-<pid>` directory nobody removes is the leak
    // this would trade for the one it fixes.
    expect(await readdir(dirname(lockDir))).toEqual([])
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

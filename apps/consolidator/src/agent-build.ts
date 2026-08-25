import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Effect } from "effect"

import { appendStderrTail, stderrMessageTail } from "./child-stderr.js"
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
 * the deep path even though the file is there. `tests/start-port.test.ts` re-proves both halves
 * against the INSTALLED eve on every run — the deep path refused, `./package.json` exported with a
 * real `bin` beside it — so an eve release that changes either fails there.
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

/**
 * The file whose PRESENCE says the cache directory holds a COMPLETED build.
 *
 * `.output/` existing cannot say that: `eve build` writes it in place over seconds, so a process
 * killed mid-build leaves a partial `.output/` that an existence check reads as complete — forever,
 * because nothing would ever rebuild it, and `eve start` over a partial output is a server that
 * fails in whatever way the missing half implies. This marker is written into the STAGING directory
 * only after `eve build` exits 0 with its output verified, and the staging directory is then
 * `rename`d to the cache root in one atomic step — so the marker can only ever be observed beside
 * the finished build it certifies. A cache directory without it, whatever else it holds, is a
 * partial to discard and rebuild.
 */
const BUILD_COMPLETE_MARKER = ".memhtml-build-complete"

/** Where a completed build's marker sits. Exported logic's one source of the path. */
const buildMarkerPath = (cacheRoot: string): string => join(cacheRoot, BUILD_COMPLETE_MARKER)

/**
 * The file `eve start` serves, relative to a built root.
 *
 * A build is verified against THIS PATH rather than against `.output/`, because `eve build` exiting 0
 * is not the same claim as `eve build` having emitted a server. An empty-but-present `.output/` earns
 * the completion marker under a directory check, and the marker is permanent — so the box would serve
 * an app with no entry point for that version's whole life. It is the "a scanner can exit 0 having
 * produced nothing" hazard in build form, and the entry file is the artifact whose absence a boot
 * would discover.
 */
const BUILT_SERVER_ENTRY = join(".output", "server", "index.mjs")

/**
 * The staging directory's suffix, named once so the stage path and its sweep cannot drift.
 *
 * `<cacheRoot>.staging-<pid>` — a SIBLING of the cache root, so publishing is one `rename` on one
 * filesystem, and pid-suffixed so a dead process's tree is never mistaken for a live one's.
 */
const STAGING_SUFFIX = ".staging-"

const stagingPathFor = (cacheRoot: string, pid: number): string =>
  `${cacheRoot}${STAGING_SUFFIX}${String(pid)}`

/**
 * How stale an orphaned staging tree must be before the sweep reclaims it. A build holds the lock for
 * tens of seconds and cannot hold it past {@link BUILD_WAIT_BUDGET_MS}, so a day is two orders of
 * magnitude of margin, and a tree younger than that may belong to a live builder.
 */
const ORPHAN_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * How old a build lock may be before another process takes it over.
 *
 * The lock (a `mkdir`-ed sibling directory) is held for one stage-plus-build, measured in tens of
 * seconds for the ~17 MB output. Ten minutes says its holder is dead — killed between `mkdir` and
 * the `finally` that removes it — rather than slow, and a dead holder's lock would otherwise block
 * every future run on this box for this version.
 */
const BUILD_LOCK_STALE_MS = 10 * 60_000

/** How often a waiting process re-checks the marker and the lock. */
const BUILD_LOCK_POLL_MS = 500

/**
 * How long a process waits on another's build before giving up. Stale takeover happens well before
 * this; the budget only binds when a LIVE holder builds for longer than the stale age plus a poll.
 */
const BUILD_WAIT_BUDGET_MS = BUILD_LOCK_STALE_MS + 60_000

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
    // Only a bounded TAIL is retained, and the failure message below renders the END of it. Both
    // rules are `child-stderr.ts`'s, shared with the `eve start` child in `client.ts`.
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = appendStderrTail(stderr, chunk)
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
                reason: `eve build exited with code ${String(code)} in ${input.cwd}. ${stderrMessageTail(stderr)}`
              })
            )
      )
    })
    return Effect.sync(() => {
      child.kill("SIGKILL")
    })
  })

/**
 * Whether a cache directory holds a COMPLETED build. The marker is the answer; `.output/` alone is
 * not, because a killed `eve build` leaves a partial `.output/` behind. See
 * {@link BUILD_COMPLETE_MARKER}, which is written only beside a verified {@link BUILT_SERVER_ENTRY}.
 */
export const cacheBuildComplete = (cacheRoot: string): boolean =>
  existsSync(buildMarkerPath(cacheRoot)) && existsSync(join(cacheRoot, ".output"))

/**
 * Remove staging trees a PAST process left beside this cache root. Best-effort; never fails a build.
 *
 * `${cacheRoot}.staging-<pid>` is removed by its own builder's finalizer on every path an Effect
 * finalizer runs on, and SIGKILL runs none of them — so a killed build strands ~17 MB with nothing else
 * in reach of it: that finalizer knows only its own pid's path, and the temp-dir sweep in `client.ts`
 * covers a different prefix under a different root. This is the one thing that can reclaim them, and it
 * runs under the build lock so it cannot race a live stager.
 *
 * Age-gated by {@link ORPHAN_STAGING_MAX_AGE_MS}, and this process's own staging path is never a
 * candidate whatever its mtime says.
 */
export const sweepOrphanedStagingTrees = async (cacheRoot: string): Promise<void> => {
  const parent = dirname(cacheRoot)
  const prefix = `${basename(cacheRoot)}${STAGING_SUFFIX}`
  const own = stagingPathFor(cacheRoot, process.pid)
  const cutoff = Date.now() - ORPHAN_STAGING_MAX_AGE_MS
  const names = await readdir(parent).catch((): ReadonlyArray<string> => [])
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const path = join(parent, name)
    if (path === own) continue
    const mtime = await stat(path).then(
      (stats) => stats.mtimeMs,
      () => null
    )
    if (mtime === null || mtime > cutoff) continue
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

/** A held build lock: the directory to remove when done. */
interface BuildLock {
  readonly release: () => Promise<void>
}

/**
 * Move a lock believed stale out of the way, and refuse to move any other lock.
 *
 * ## `rename` is the arbitration; an `rm` is not
 *
 * Two waiters can measure the same stale lock and both decide to take it over. An unconditional
 * `rm(lockDir)` there is not an arbitration at all — it says nothing about WHICH directory it removed,
 * so the ordering `stat(A), stat(B), rm(A), mkdir(A), rm(B), mkdir(B)` leaves A and B both holding: B's
 * `rm` deleted the fresh lock A had just created, and B's `mkdir` then succeeded. `rename` narrows
 * that: for one directory instance exactly one racer's rename can succeed, so the loser gets ENOENT and
 * returns to the `mkdir`, where the winner's fresh lock excludes it.
 *
 * ## The inode is what binds the rename to the lock that was MEASURED
 *
 * `rename` alone still moves whatever sits at the path. A waiter's staleness reading is taken before
 * its rename, and in between the takeover winner can have released and a third process can have created
 * a fresh lock at the same path — renaming THAT aside would delete a live holder's lock and hand this
 * waiter a second, concurrent hold, which is the same defect one step later. So a claim whose renamed
 * directory is not the inode the staleness was read from is put straight back and this waiter acquires
 * nothing; only the measured directory is ever discarded.
 *
 * The residual is the moment between such a mistaken rename and its restore, during which the path is
 * empty and a waiter arriving at the top of the loop can `mkdir` it. That window is microseconds of
 * filesystem calls and it costs at most what the previous shape cost always.
 *
 * Exported for `tests/agent-build.test.ts`, which drives both arms directly: the interleaving above
 * cannot be forced through {@link acquireBuildLock} from one process.
 */
export const claimStaleLock = async (lockDir: string, staleIno: number): Promise<void> => {
  const aside = `${lockDir}.stale-${String(process.pid)}`
  await rm(aside, { recursive: true, force: true }).catch(() => {})
  const claimed = await rename(lockDir, aside).then(
    () => true,
    () => false
  )
  if (!claimed) return
  const moved = await stat(aside).then(
    (stats) => stats.ino,
    () => null
  )
  if (moved !== staleIno) {
    await rename(aside, lockDir).catch(() => {})
    return
  }
  await rm(aside, { recursive: true, force: true }).catch(() => {})
}

/**
 * Take the per-version build lock, waiting out or taking over another holder.
 *
 * `mkdir` without `recursive` is the primitive: it either creates the directory (the lock is ours)
 * or throws `EEXIST` (someone holds it), atomically, on every filesystem node runs on. Two runs on
 * one box CAN race here — the sleep cycle and a hand-driven `memhtml` both resolving the same
 * unbuilt version — and without the lock both would build into the shared cache root at once,
 * interleaving two `eve build`s' output.
 *
 * A holder that died between its `mkdir` and its `release` (SIGKILL leaves no `finally`) is detected
 * by the lock directory's AGE: past {@link BUILD_LOCK_STALE_MS} it cannot be a live build, so the
 * waiter claims it through {@link claimStaleLock} and retries the `mkdir`. The claim is a `rename`
 * bound to the inode the staleness was measured on, and that binding is what keeps two waiters from
 * both ending up holding: see that function for the interleaving an unconditional `rm` admits.
 *
 * Exported for `tests/agent-build.test.ts`, which proves the lock excludes and the stale takeover
 * fires; no production caller outside {@link resolveAgentAppRoot} reaches it.
 */
export const acquireBuildLock = async (cacheRoot: string): Promise<BuildLock> => {
  const lockDir = `${cacheRoot}.lock`
  // The lock is taken before anything else touches the cache tree, so its parent may not exist yet.
  // Created separately from the lock itself: `recursive: true` on the lock mkdir would report
  // success on an ALREADY-EXISTING directory, which is exactly the case the lock must refuse.
  await mkdir(dirname(lockDir), { recursive: true })
  const deadline = Date.now() + BUILD_WAIT_BUDGET_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      return { release: () => rm(lockDir, { recursive: true, force: true }).catch(() => {}) }
    } catch (cause) {
      if ((cause as { readonly code?: string }).code !== "EEXIST") throw cause
    }
    // The inode travels with the age, because the claim below acts on the directory this reading
    // describes and not merely on the path it sits at.
    const held = await stat(lockDir).then(
      (stats) => ({ age: Date.now() - stats.mtimeMs, ino: stats.ino }),
      () => null
    )
    if (held !== null && held.age > BUILD_LOCK_STALE_MS) {
      await claimStaleLock(lockDir, held.ino)
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another process has held the build lock ${lockDir} past the wait budget; ` +
          "remove it if no eve build is running"
      )
    }
    await new Promise((done) => setTimeout(done, BUILD_LOCK_POLL_MS))
  }
}

/**
 * The directory `eve start` will be run in, building the agent first when nothing has.
 *
 * Order is deliberate. An explicit `appRoot` is an operator's choice and is never second-guessed. A
 * package that already holds `.output/` is a checkout where `build:agent` has run, and reusing it keeps
 * development behavior byte-identical. Only the remaining case — an installed package with no output —
 * materializes the cache directory, and it costs one ~17 MB build per version rather than one per run.
 *
 * ## Completion is a RENAME, not a file count
 *
 * The build is staged and run in a TEMP SIBLING of the cache root and moved into place with one
 * `rename` after `eve build` exits 0 and its {@link BUILT_SERVER_ENTRY} is on disk — the file a boot
 * needs, rather than the directory it sits in. `rename` on one filesystem is
 * atomic, so the cache root either holds a whole completed build (marker included, see
 * {@link BUILD_COMPLETE_MARKER}) or does not exist — a process killed anywhere in the middle leaves
 * only a staging directory nothing consults, which the next run removes and redoes. A cache root
 * WITHOUT the marker (the shape a pre-marker build, or a directly-killed in-place build, leaves) is
 * treated as partial: removed and rebuilt.
 *
 * The build itself runs under a `mkdir`-based lock with stale-age takeover
 * ({@link acquireBuildLock}), because two processes staging into the same version's cache
 * concurrently would interleave their trees.
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
    if (cacheBuildComplete(cacheRoot)) return cacheRoot

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireBuildLock(cacheRoot),
        catch: (cause) =>
          ConsolidatorUnavailable.make({
            reason: `could not lock the consolidator agent build: ${String(cause)}`
          })
      }),
      () => {
        /**
         * Suffixed with the pid so a stale staging directory from a dead process is never mistaken
         * for this one's; the lock means at most one LIVE process stages per version at a time.
         */
        const staging = stagingPathFor(cacheRoot, process.pid)
        return Effect.gen(function* () {
          // Another process may have completed the build while this one waited on the lock.
          if (cacheBuildComplete(cacheRoot)) return cacheRoot

          yield* Effect.logInfo(
            `building the consolidator agent into ${cacheRoot} (once per version)`
          )
          yield* Effect.tryPromise({
            try: async () => {
              // Under the lock, so a sibling staging tree here belongs to a dead builder.
              await sweepOrphanedStagingTrees(cacheRoot)
              await rm(staging, { recursive: true, force: true })
              await stageAgentTree({ packageRoot, cacheRoot: staging, version })
            },
            catch: (cause) =>
              ConsolidatorUnavailable.make({
                reason: `could not stage the consolidator agent in ${staging}: ${String(cause)}`
              })
          })

          yield* runEveBuild({ eveBin, cwd: staging })

          if (!existsSync(join(staging, BUILT_SERVER_ENTRY))) {
            return yield* Effect.fail(
              ConsolidatorUnavailable.make({
                reason: `eve build wrote no ${BUILT_SERVER_ENTRY} in ${staging}`
              })
            )
          }

          yield* Effect.tryPromise({
            try: async () => {
              await writeFile(buildMarkerPath(staging), `${new Date().toISOString()}\n`, "utf8")
              // A markerless cache root is a partial from an interrupted pre-rename (or killed
              // in-place) build; replace it.
              await rm(cacheRoot, { recursive: true, force: true })
              await rename(staging, cacheRoot)
            },
            catch: (cause) =>
              ConsolidatorUnavailable.make({
                reason: `could not publish the built agent to ${cacheRoot}: ${String(cause)}`
              })
          })
          return cacheRoot
        }).pipe(
          // A failed build's staging tree is ~17 MB nothing will consult; remove it while the lock
          // still excludes a concurrent stager. After the success rename this path no longer exists
          // and the forced rm is a no-op.
          Effect.ensuring(
            Effect.promise(() => rm(staging, { recursive: true, force: true }).catch(() => {}))
          )
        )
      },
      (lock) => Effect.promise(lock.release)
    )
  })

/** Exported for the tests that assert the location, which is the part a reader can get wrong. */
export const agentCacheRootFor = (version: string): string => resolve(cacheRootFor(version))

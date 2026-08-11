import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildManifest, COMMANDS, RESPONSE_TYPES, renderAgentsDoc } from "@memhtml/cli"
import { STATE_SIDECAR_PATH } from "@memhtml/store"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"

/**
 * The plan's verification item 1, as far as a test can reach it: **a FRESH CLONE of a memory repo
 * reproduces the whole system.**
 *
 * `pnpm install && pnpm check` from a clean clone of THIS repo is a CI property rather than a test —
 * a suite cannot meaningfully re-run its own toolchain. What is testable, and what actually carries the
 * design's weight, is the other clean-clone claim: clone the memory repo, `memhtml init` it, import the
 * committed sidecar, rebuild the index, and everything is back — because `index.db` and `state.db` are
 * both gitignored and neither is in the clone.
 *
 * This is also where finding #24 is proven: `merge.ours.driver` is per-clone CONFIG, so the
 * `.gitattributes` a clone inherits is INERT until `memhtml init` re-sets it. A clone that skipped that step
 * would conflict on generated files and write conflict markers into `sitemap.xml`.
 */

describe("verification item 1 — a fresh clone reproduces the system", () => {
  let origin: Cli
  let clone: Cli
  let cloneRoot: string

  beforeAll(async () => {
    origin = await makeCli()

    await writeMemory(origin, {
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."],
      workspace: "checkout-api",
      tags: ["deploy"],
      entities: ["service:checkout-api"]
    })
    const second = await writeMemory(origin, {
      title: "The metrics agent scrapes every exporter each minute",
      claim: "The metrics agent scrapes every exporter once each minute.",
      type: "semantic",
      tags: ["observability"]
    })

    // Access history and the committed sidecar: the one plane git cannot reproduce on its own.
    await origin.json(["search", "drain the vip before reverting"])
    await origin.json(["reinforce", second.path, "--signal", "positive"])
    await origin.json(["state", "export"])
    await origin.json(["publish"])

    cloneRoot = await mkdtemp(join(tmpdir(), "memhtml-integration-clone-"))
    await rm(cloneRoot, { recursive: true, force: true })
    // A real clone, through git, of a real repo.
    await origin.git("clone", origin.root, cloneRoot)

    clone = await makeCli({ root: cloneRoot, init: false })
    // What an operator runs on a fresh clone. Convergent: it writes nothing that is already there.
    await clone.json(["init"])
  })

  afterAll(async () => {
    await origin.cleanup()
    await clone.cleanup()
  })

  it("does not carry either database in the clone", async () => {
    /**
     * The premise. `index.db` is a projection of the tree and `state.db` is reproduced from its
     * committed sidecar, so both are gitignored — and if a clone DID carry them, every claim below would
     * be trivially true for the wrong reason.
     */
    for (const file of ["index.db", "state.db"]) {
      const tracked = await clone.git("ls-files", "--", `.memhtml/${file}`)
      expect(tracked.trim()).toBe("")
    }
    const ignore = await readFile(join(cloneRoot, ".gitignore"), "utf8")
    expect(ignore).toContain(".memhtml/index.db")
    expect(ignore).toContain(".memhtml/state.db")
  })

  it("carries the committed sidecar, which is the state plane's only durable copy", async () => {
    const sidecar = await readFile(join(cloneRoot, STATE_SIDECAR_PATH), "utf8")
    expect(sidecar.trim().length).toBeGreaterThan(0)
    expect((await stat(join(cloneRoot, STATE_SIDECAR_PATH))).size).toBeGreaterThan(0)
  })

  it("re-sets merge.ours.driver, which the inherited .gitattributes is INERT without", async () => {
    /**
     * **Finding #24, and both halves are required.** Probed live: with `merge=ours` set in
     * `.gitattributes` and no driver configured, git STILL conflicts and writes conflict markers into
     * the file. Config is per-clone and is not cloned, so `memhtml init` on a fresh clone is what makes the
     * attribute mean anything — which is exactly why the runbook says to run it.
     */
    const attributes = await readFile(join(cloneRoot, ".gitattributes"), "utf8")
    expect(attributes).toContain("index.html merge=ours")
    expect(attributes).toContain("sitemap.xml merge=ours")
    expect((await clone.git("config", "--get", "merge.ours.driver")).trim()).toBe("true")
  })

  it("rebuilds a fully working system from the clone alone", async () => {
    // The whole claim, in the three commands the runbook names.
    await clone.json(["state", "import"])
    const rebuilt = await clone.json<{
      readonly filesIndexed: number
      readonly skipped: ReadonlyArray<unknown>
    }>(["index", "rebuild", "--embed"])
    expect(rebuilt.filesIndexed).toBeGreaterThan(1)
    expect(rebuilt.skipped).toEqual([])

    // Search works, with every arm — including salience, which only has signal because the sidecar
    // restored the access plane.
    const hits = await clone.json<{
      readonly hits: ReadonlyArray<{ readonly path: string }>
      readonly degraded: boolean
      readonly arms: ReadonlyArray<string>
    }>(["search", "drain the vip before reverting"])
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.degraded).toBe(false)
    expect(hits.arms).toContain("vector")
    expect(hits.arms).toContain("salience")
  })

  it("reproduces the origin's access counts, not merely the row's existence", async () => {
    /**
     * The sidecar's whole point: a fresh clone reproduces the system INCLUDING its access history. A
     * test that only checked the row existed would pass against an import that zeroed every counter,
     * which is the failure that makes salience ranking silently uniform.
     */
    const { DatabaseService, STATE_SCHEMA } = await import("@memhtml/index")

    const read = (cli: Cli) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseService
          return yield* db.all<{ path: string; access_count: number; reinforcement_count: number }>(
            `SELECT path, access_count, reinforcement_count FROM ${STATE_SCHEMA}.access ORDER BY path`
          )
        }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
      )

    const originRows = await read(origin)
    const cloneRows = await read(clone)
    expect(originRows.length).toBeGreaterThan(0)
    expect(cloneRows).toEqual(originRows)
  })

  it("doctor is clean on the clone", async () => {
    const report = await clone.json<{
      readonly dangling: ReadonlyArray<unknown>
      readonly orphanAccessRows: ReadonlyArray<string>
      readonly indexFresh: boolean
      readonly healthy: boolean
    }>(["doctor"])
    expect(report.dangling).toEqual([])
    expect(report.orphanAccessRows).toEqual([])
    expect(report.indexFresh).toBe(true)
    expect(report.healthy).toBe(true)
  })

  it("regenerates byte-identical published artifacts on the clone", async () => {
    /**
     * The `merge=ours` contract's other half: a conflict is resolved by REGENERATING, which only works
     * if the same tree yields the same bytes on another machine. A clone is the closest a test gets to
     * another machine.
     */
    const originSitemap = await readFile(join(origin.root, "sitemap.xml"), "utf8")
    const published = await clone.json<{ readonly written: number }>(["publish"])
    expect(published.written).toBe(0)
    expect(await readFile(join(cloneRoot, "sitemap.xml"), "utf8")).toBe(originSitemap)
  })

  it("answers `memhtml manifest` with no database and no credentials", async () => {
    /**
     * The FIRST call an agent makes, and the liveness check. Asserted with NO layer at all, because the
     * point is that self-description cannot be conditional on the thing it describes already working.
     */
    const manifest = buildManifest()
    expect(manifest.commands).toHaveLength(COMMANDS.length)
    const known = new Set<string>(RESPONSE_TYPES)
    for (const type of manifest.responseTypes) expect(known.has(type)).toBe(true)
  })

  it("keeps AGENTS.md in sync with the command table", async () => {
    /**
     * Finding #39: `COMMANDS` drives parsing, the manifest, AND the generated doc, so a command added
     * without regenerating is drift the doc cannot self-detect. `memhtml agents-doc --check` is this same
     * comparison as a command — asserted here too so the integration tier fails on drift.
     *
     * The path is resolved from THIS FILE rather than from `process.cwd()`, and it is not allowed to
     * fall back to a skip: a drift check that silently passes when it cannot find the file is the
     * "skipped gate that looks like a passing one" this repo refuses everywhere else.
     */
    const docPath = new URL("../../AGENTS.md", import.meta.url)
    const committed = await readFile(docPath, "utf8")
    expect(committed.length).toBeGreaterThan(0)
    expect(committed).toBe(renderAgentsDoc())
  })
})

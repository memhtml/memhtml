import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { type DoctorProbes, doctor, traceRootIn } from "../src/doctor.js"
import { install } from "../src/install.js"
import { receiptPath } from "../src/receipt.js"
import type { BinaryLocation, DoctorCheck, HostId, InstallOptions } from "../src/types.js"

/**
 * `doctor`, with both child-process probes injected.
 *
 * The two rows that spawn something are the ones a unit test cannot own — a version probe and a live MCP
 * handshake — so they arrive as functions and every case below states what they answered. The suite in
 * `apps/cli` drives the real ones against the built binary; here the subject is what doctor CONCLUDES
 * from an answer, which is the half that decides whether an operator is told the truth.
 */

const workspaces: Array<string> = []

interface Fixture {
  readonly home: string
  readonly memhtmlRoot: string
  readonly binary: BinaryLocation
}

const fixture = async (): Promise<Fixture> => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "memhtml-int-doctor-")))
  workspaces.push(workspace)
  const home = join(workspace, "home")
  const bin = join(workspace, "bin")
  const memhtmlRoot = join(workspace, "memory")
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  // A real store shape: doctor reads the directory rather than calling `memhtml status`, which would
  // scaffold one and make the check pass by creating what it was asked about.
  await mkdir(join(memhtmlRoot, ".memhtml"), { recursive: true })
  const cli = join(bin, "memhtml")
  const mcp = join(bin, "memhtml-mcp")
  await writeFile(cli, "#!/usr/bin/env node\n", "utf8")
  await writeFile(mcp, "#!/usr/bin/env node\n", "utf8")
  return { home, memhtmlRoot, binary: { node: process.execPath, cli, mcp, version: "9.9.9" } }
}

afterAll(async () => {
  await Promise.all(workspaces.map((root) => rm(root, { recursive: true, force: true })))
})

const optionsFor = (host: HostId, where: Fixture, over: Partial<InstallOptions> = {}) => ({
  host,
  scope: "user" as const,
  root: where.home,
  memhtmlRoot: where.memhtmlRoot,
  ...(host === "claude" ? { traceRoot: join(where.home, ".claude") } : {}),
  hooks: "all" as const,
  bareCommand: false,
  force: false,
  dryRun: false,
  binary: where.binary,
  ...over
})

/** Both probes answering as a working install would. */
const healthyProbes = (version: string): DoctorProbes => ({
  version: () => Promise.resolve({ ok: true, detail: `reports ${version}`, value: version }),
  handshake: () => Promise.resolve({ ok: true, detail: "memhtml 9.9.9 answered initialize" })
})

const row = (checks: ReadonlyArray<DoctorCheck>, name: string): DoctorCheck | undefined =>
  checks.find((check) => check.name === name)

describe("doctor on a healthy install", () => {
  it("reports every row green, for every host", async () => {
    for (const host of ["claude", "codex", "cursor", "opencode"] as const) {
      const where = await fixture()
      if (host === "claude") {
        // A transcript two levels under the recorded trace root, which is what the indexing hooks read.
        await mkdir(join(where.home, ".claude", "projects", "api"), { recursive: true })
        await writeFile(
          join(where.home, ".claude", "projects", "api", "session.jsonl"),
          '{"type":"user"}\n',
          "utf8"
        )
      }
      await install(optionsFor(host, where))
      const result = await doctor(host, "user", where.home, { probes: healthyProbes("9.9.9") })
      const failed = result.checks.filter((check) => !check.ok)
      expect(failed).toEqual([])
      expect(result.healthy).toBe(true)
      expect(row(result.checks, "mcp-handshake")?.detail).toContain("initialize")
      expect(row(result.checks, "skill")?.ok).toBe(true)
    }
  })

  it("names the trace root for Claude Code and reports none for the other three", async () => {
    const where = await fixture()
    await mkdir(join(where.home, ".claude", "projects"), { recursive: true })
    await writeFile(join(where.home, ".claude", "projects", "a.jsonl"), "{}\n", "utf8")
    await install(optionsFor("claude", where))
    const claude = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(row(claude.checks, "trace-root")?.detail).toContain(join(where.home, ".claude"))

    const other = await fixture()
    await install(optionsFor("codex", other))
    const codex = await doctor("codex", "user", other.home, { probes: healthyProbes("9.9.9") })
    // No reader exists for Codex transcripts, so no indexing hook was written and there is no row.
    expect(row(codex.checks, "trace-root")).toBeUndefined()
  })

  it("carries Codex's hook-trust reminder as an informational green row", async () => {
    const where = await fixture()
    await install(optionsFor("codex", where))
    const result = await doctor("codex", "user", where.home, { probes: healthyProbes("9.9.9") })
    const trust = row(result.checks, "hook-trust")
    expect(trust?.ok).toBe(true)
    expect(trust?.detail).toContain("/hooks")
    expect(trust?.detail).toContain("not verifiable from outside")
  })

  it("says Cursor has no user-level instruction file rather than failing the row", async () => {
    const where = await fixture()
    await install(optionsFor("cursor", where))
    const result = await doctor("cursor", "user", where.home, { probes: healthyProbes("9.9.9") })
    const block = row(result.checks, "instruction-block")
    expect(block?.ok).toBe(true)
    expect(block?.detail).toContain("no user-level instruction file")
  })
})

describe("doctor on a broken install", () => {
  it("answers one row when there is no receipt", async () => {
    const where = await fixture()
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.name).toBe("receipt")
    expect(result.checks[0]?.suggestions).toContain("memhtml integrations install claude")
  })

  it("answers one row when the receipt does not parse", async () => {
    const where = await fixture()
    const path = receiptPath("user", where.home, "claude")
    await mkdir(join(where.home, ".config", "memhtml", "integrations"), { recursive: true })
    await writeFile(path, "{ not json", "utf8")
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.detail).toContain("not usable")
    expect(result.checks[0]?.suggestions).toEqual(["memhtml integrations install claude --force"])
  })

  it("fails the store-root row on a directory with no .memhtml/, and suggests init", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    await rm(join(where.memhtmlRoot, ".memhtml"), { recursive: true, force: true })
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    const store = row(result.checks, "store-root")
    expect(store?.ok).toBe(false)
    expect(store?.detail).toContain("holds no .memhtml/")
    expect(store?.suggestions).toEqual([`memhtml init --repo ${where.memhtmlRoot}`])
    expect(result.healthy).toBe(false)
  })

  it("fails the store-root row when the store is gone entirely", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    await rm(where.memhtmlRoot, { recursive: true, force: true })
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(row(result.checks, "store-root")?.detail).toContain("does not exist")
  })

  it("fails one entry row for a drifted fragment, naming the file", async () => {
    const where = await fixture()
    await mkdir(join(where.home, ".claude", "projects"), { recursive: true })
    await writeFile(join(where.home, ".claude", "projects", "a.jsonl"), "{}\n", "utf8")
    await install(optionsFor("claude", where))
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    await writeFile(claudeMd, "gutted\n", "utf8")
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    const drifted = result.checks.filter((check) => !check.ok)
    expect(drifted.map((check) => check.name)).toEqual([
      "entry:instruction-block",
      "instruction-block"
    ])
    expect(drifted[0]?.detail).toContain(claudeMd)
    expect(drifted[0]?.suggestions).toContain("memhtml integrations install claude --force")
  })

  it("tells an upgrade from a healthy install through the version row", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    const result = await doctor("claude", "user", where.home, {
      probes: healthyProbes("10.0.0")
    })
    const version = row(result.checks, "cli-version")
    expect(version?.ok).toBe(false)
    expect(version?.detail).toContain("upgraded since install")
    expect(version?.suggestions).toEqual(["memhtml integrations install claude"])
  })

  it("fails the binary rows when the toolchain moved", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    await rm(where.binary.mcp, { force: true })
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(row(result.checks, "binary-mcp")?.ok).toBe(false)
    expect(row(result.checks, "binary-cli")?.ok).toBe(true)
  })

  it("never spawns the server over a bare store root, because starting it would create one", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    await rm(join(where.memhtmlRoot, ".memhtml"), { recursive: true, force: true })
    let spawned = false
    const result = await doctor("claude", "user", where.home, {
      probes: {
        ...healthyProbes("9.9.9"),
        handshake: () => {
          spawned = true
          return Promise.resolve({ ok: true, detail: "answered initialize" })
        }
      }
    })
    // A diagnostic that creates the thing it is checking always passes on the second run.
    expect(spawned).toBe(false)
    expect(row(result.checks, "mcp-handshake")?.ok).toBe(false)
    expect(row(result.checks, "mcp-handshake")?.detail).toContain("would create one")
  })

  it("fails the handshake row with the probe's own sentence", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    const result = await doctor("claude", "user", where.home, {
      probes: {
        ...healthyProbes("9.9.9"),
        handshake: () =>
          Promise.resolve({
            ok: false,
            detail: "the server exited (code 1) before answering initialize"
          })
      }
    })
    const handshake = row(result.checks, "mcp-handshake")
    expect(handshake?.ok).toBe(false)
    expect(handshake?.detail).toContain("before answering initialize")
    expect(handshake?.suggestions).toContain("memhtml integrations install claude")
  })

  it("fails the trace-root row when the recorded tree holds no transcript", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    const result = await doctor("claude", "user", where.home, { probes: healthyProbes("9.9.9") })
    const trace = row(result.checks, "trace-root")
    expect(trace?.ok).toBe(false)
    expect(trace?.detail).toContain("no *.jsonl within two levels")
  })

  it("fails the hooks row when every owned entry was deleted by hand", async () => {
    const where = await fixture()
    await install(optionsFor("cursor", where))
    await writeFile(join(where.home, ".cursor", "hooks.json"), '{ "version": 1 }\n', "utf8")
    const result = await doctor("cursor", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(row(result.checks, "hooks")?.ok).toBe(false)
    expect(row(result.checks, "hooks")?.detail).toContain("no memhtml hook entry")
  })

  it("expects no hook when the install said --hooks none", async () => {
    const where = await fixture()
    await install(optionsFor("cursor", where, { hooks: "none" }))
    const result = await doctor("cursor", "user", where.home, { probes: healthyProbes("9.9.9") })
    expect(row(result.checks, "hooks")).toEqual({
      name: "hooks",
      ok: true,
      detail: "installed with --hooks none, so no hook is expected",
      suggestions: []
    })
  })
})

describe("traceRootIn", () => {
  it("reads the root out of a shell hook line and out of a plugin's argv array", () => {
    expect(
      traceRootIn("/usr/bin/node /opt/memhtml hook session-end --host claude --repo /m")
    ).toBeUndefined()
    expect(
      traceRootIn(
        "/usr/bin/node /opt/memhtml hook session-end --host claude --trace-root /home/ada/.claude"
      )
    ).toBe("/home/ada/.claude")
    // A path with a space is single-quoted by `shellJoin`, which is the form that has to parse.
    expect(traceRootIn("node memhtml hook session-end --trace-root '/home/ada/my logs'")).toBe(
      "/home/ada/my logs"
    )
    expect(
      traceRootIn('const IDLE_ARGS = ["hook","session-end","--trace-root","/home/ada/.claude"]')
    ).toBe("/home/ada/.claude")
  })
})

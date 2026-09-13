import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../src/envelope.js"
import { run } from "../src/run.js"

/**
 * The `integrations` family through `run()`, with `$HOME` pinned to a temp directory.
 *
 * Two things this suite is the only place to prove. **No arm builds the app layer**: `install` runs on a
 * machine with no store, and the case below asserts that the store root it RECORDS is still empty
 * afterwards — a `.memhtml/` there would mean the command opened what it was only supposed to name. And
 * `MEMHTML_REFUSE_ENV_ROOT`, which this run sets for every test, does not refuse these five: they open no
 * repo, so a refusal would block `memhtml integrations install` on exactly the fresh machine it sets up.
 *
 * `$HOME` and `$MEMHTML_TRACE_ROOT` are set per case and restored after it. The trace root has to be
 * pinned for the same reason `hook.test.ts` pins it: the default is `~/.claude`, and a doctor row walks
 * that tree looking for transcripts.
 *
 * The `doctor` case drives the REAL probes — `node apps/cli/dist/bin.js manifest` and a live MCP
 * `initialize` against `apps/mcp/dist/bin.js` — so it needs a current build (`pnpm build`), which is the
 * repo's standing rule for anything that resolves a `@memhtml/*` dist path.
 */

const workspaces: Array<string> = []
const saved = new Map<string, string | undefined>()

const pin = (name: string, value: string): void => {
  if (!saved.has(name)) saved.set(name, process.env[name])
  process.env[name] = value
}

interface Sandbox {
  readonly home: string
  readonly store: string
}

/** A temp `$HOME`, a temp store root that install only RECORDS, and the two hosts' config directories. */
const sandbox = async (hosts: ReadonlyArray<string> = [".claude"]): Promise<Sandbox> => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "memhtml-cli-int-")))
  workspaces.push(workspace)
  const home = join(workspace, "home")
  const store = join(workspace, "store")
  await mkdir(home, { recursive: true })
  for (const host of hosts) await mkdir(join(home, host), { recursive: true })
  pin("HOME", home)
  pin("MEMHTML_TRACE_ROOT", join(home, ".claude"))
  return { home, store }
}

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const parse = (
  stdout: string
): {
  readonly type?: string
  readonly code?: string
  readonly error?: string
  readonly data?: unknown
  readonly suggestions?: ReadonlyArray<string>
} => JSON.parse(stdout)

const dataOf = <A>(stdout: string): A => parse(stdout).data as A

interface Report {
  readonly action: string
  readonly scope: string
  readonly root: string
  readonly memhtmlRoot?: string
  readonly changed: boolean
  readonly dryRun: boolean
  readonly hosts: ReadonlyArray<{
    readonly host: string
    readonly changed: boolean
    readonly state?: string
    readonly entries: ReadonlyArray<{
      readonly path: string
      readonly role: string
      readonly action: string
    }>
    readonly backups: ReadonlyArray<string>
    readonly receiptPath: string
    readonly nextSteps: ReadonlyArray<string>
    readonly contents?: Record<string, string>
  }>
}

describe("integrations install", () => {
  it("reports the plan and writes nothing under --dry-run", async () => {
    const where = await sandbox()
    const result = await run([
      "integrations",
      "install",
      "claude",
      "--repo",
      where.store,
      "--dry-run"
    ])
    expect(result.exitCode).toBe(EXIT_OK)
    expect(parse(result.stdout).type).toBe("integrations.report")
    const report = dataOf<Report>(result.stdout)
    expect(report).toMatchObject({ action: "install", scope: "user", dryRun: true, changed: true })
    const host = report.hosts[0]
    expect(host?.host).toBe("claude")
    expect(host?.entries.every((entry) => entry.action === "planned")).toBe(true)
    // The rendered content of every file it would write, and not one of them on disk.
    expect(Object.keys(host?.contents ?? {})).toHaveLength(host?.entries.length ?? 0)
    await expect(readdir(join(where.home, ".claude"))).resolves.toEqual([])
  })

  it("wires the host, records the store, and opens nothing", async () => {
    const where = await sandbox()
    const result = await run(["integrations", "install", "claude", "--repo", where.store])
    expect(result.exitCode).toBe(EXIT_OK)
    const report = dataOf<Report>(result.stdout)
    expect(report.memhtmlRoot).toBe(where.store)
    expect(report.hosts[0]?.changed).toBe(true)

    const config: unknown = JSON.parse(await readFile(join(where.home, ".claude.json"), "utf8"))
    expect(config).toMatchObject({
      mcpServers: { memhtml: { env: { MEMHTML_ROOT: where.store } } }
    })
    /**
     * The lock that says no arm built the app layer. `layerApp` would `mkdir -p <store>/.memhtml` and run
     * every migration; the store this install RECORDED is still absent, so the command named a root
     * rather than opening one.
     */
    await expect(readdir(where.store)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("wires every detected host when no host is named", async () => {
    const where = await sandbox([".claude", ".cursor"])
    const result = await run(["integrations", "install", "--repo", where.store])
    const report = dataOf<Report>(result.stdout)
    expect(report.hosts.map((host) => host.host)).toEqual(["claude", "cursor"])
  })

  it("writes nothing for any host when one detected host would refuse", async () => {
    const where = await sandbox([".claude", ".cursor"])
    // Somebody else's `mcpServers.memhtml` in Cursor's file: the second host refuses, so the first must
    // not have been wired on the way there.
    await writeFile(
      join(where.home, ".cursor", "mcp.json"),
      '{ "mcpServers": { "memhtml": { "command": "their-own-server" } } }\n',
      "utf8"
    )
    const result = await run(["integrations", "install", "--repo", where.store])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const failure = parse(result.stdout)
    expect(failure.code).toBe("ERR_INTEGRATION_MODIFIED")
    expect(failure.error).not.toContain("remain installed")
    expect(await readdir(where.home)).toEqual([".claude", ".cursor"])
    expect(await readdir(join(where.home, ".claude"))).toEqual([])
  })

  it("is idempotent through the CLI: the second run reports changed: false", async () => {
    const where = await sandbox()
    await run(["integrations", "install", "claude", "--repo", where.store])
    const again = await run(["integrations", "install", "claude", "--repo", where.store])
    expect(dataOf<Report>(again.stdout).changed).toBe(false)
  })

  it("answers ERR_UNKNOWN_HOST at exit 2 for a host outside the vocabulary", async () => {
    await sandbox()
    const result = await run(["integrations", "install", "nope"])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const failure = parse(result.stdout)
    expect(failure.code).toBe("ERR_UNKNOWN_HOST")
    expect(failure.suggestions).toContain("memhtml integrations install claude")
    expect(failure.suggestions).toContain("memhtml help integrations install")
  })

  it("answers ERR_INTEGRATION_MODIFIED at exit 1 when a managed block was edited", async () => {
    const where = await sandbox()
    await run(["integrations", "install", "claude", "--repo", where.store])
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    await writeFile(claudeMd, "gutted\n", "utf8")
    const result = await run(["integrations", "install", "claude", "--repo", where.store])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const failure = parse(result.stdout)
    expect(failure.code).toBe("ERR_INTEGRATION_MODIFIED")
    // The suggestions are the ones `errors.ts` publishes for the tag, not a second copy of them.
    expect(failure.suggestions).toEqual([
      "memhtml integrations doctor claude",
      "memhtml integrations install claude --force"
    ])
    expect(await readFile(claudeMd, "utf8")).toBe("gutted\n")
  })

  it("refuses a --project path that is not a git repository, at exit 2", async () => {
    const where = await sandbox()
    const result = await run([
      "integrations",
      "install",
      "claude",
      "--project",
      where.home,
      "--repo",
      where.store
    ])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).code).toBe("ERR_INVALID_FLAG")
    expect(parse(result.stdout).error).toContain("git repository")
  })

  it("is not refused by MEMHTML_REFUSE_ENV_ROOT, because it opens no repo", async () => {
    const where = await sandbox()
    // The variable is set for this whole run (`vitest.config.ts`), and `--repo` is absent on purpose.
    expect(process.env.MEMHTML_REFUSE_ENV_ROOT).toBeDefined()
    pin("MEMHTML_ROOT", where.store)
    const result = await run(["integrations", "install", "claude"])
    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf<Report>(result.stdout).memhtmlRoot).toBe(where.store)
  })
})

describe("integrations list and uninstall", () => {
  it("reports installed after an install and not-installed after an uninstall", async () => {
    const where = await sandbox()
    await run(["integrations", "install", "claude", "--repo", where.store])

    const listed = await run(["integrations", "list"])
    expect(parse(listed.stdout).type).toBe("integrations.list")
    const rows = dataOf<{
      readonly rows: ReadonlyArray<{ host: string; scope: string; state: string; version?: string }>
    }>(listed.stdout).rows
    expect(rows.find((row) => row.host === "claude")?.state).toBe("installed")
    expect(rows.find((row) => row.host === "claude")?.version).toBe("0.14.0")
    expect(rows.filter((row) => row.scope === "user")).toHaveLength(4)

    const removed = await run(["integrations", "uninstall", "claude"])
    expect(removed.exitCode).toBe(EXIT_OK)
    const report = dataOf<Report>(removed.stdout)
    expect(report.action).toBe("uninstall")
    expect(report.hosts[0]?.entries.every((entry) => entry.action === "removed")).toBe(true)

    const after = await run(["integrations", "list"])
    const afterRows = dataOf<{ readonly rows: ReadonlyArray<{ host: string; state: string }> }>(
      after.stdout
    ).rows
    expect(afterRows.find((row) => row.host === "claude")?.state).toBe("not-installed")
  })

  it("is success and a no-op when the host was never installed", async () => {
    await sandbox()
    const result = await run(["integrations", "uninstall", "codex"])
    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf<Report>(result.stdout)).toMatchObject({ changed: false })
    expect(dataOf<Report>(result.stdout).hosts[0]?.state).toBe("not-installed")
  })
})

describe("integrations doctor", () => {
  it("completes the live MCP handshake against the server the entry names", async () => {
    const where = await sandbox()
    // A store with `.memhtml/` and nothing else: doctor reads the directory rather than calling
    // `memhtml status`, which would scaffold one and make the row pass by creating what it checks.
    await mkdir(join(where.store, ".memhtml"), { recursive: true })
    await mkdir(join(where.home, ".claude", "projects"), { recursive: true })
    await writeFile(join(where.home, ".claude", "projects", "a.jsonl"), '{"type":"user"}\n', "utf8")
    await run(["integrations", "install", "claude", "--repo", where.store])

    const result = await run(["integrations", "doctor", "claude"])
    expect(result.exitCode).toBe(EXIT_OK)
    expect(parse(result.stdout).type).toBe("integrations.doctor")
    const report = dataOf<{
      readonly healthy: boolean
      readonly hosts: ReadonlyArray<{
        readonly host: string
        readonly healthy: boolean
        readonly checks: ReadonlyArray<{ name: string; ok: boolean; detail: string }>
      }>
    }>(result.stdout)
    const checks = report.hosts[0]?.checks ?? []
    const handshake = checks.find((check) => check.name === "mcp-handshake")
    expect(handshake?.detail).toContain("answered initialize")
    expect(handshake?.ok).toBe(true)
    expect(checks.find((check) => check.name === "cli-version")?.ok).toBe(true)
    expect(checks.filter((check) => !check.ok)).toEqual([])
    expect(report.healthy).toBe(true)
  }, 30_000)

  it("answers one receipt row when the host is not installed", async () => {
    await sandbox()
    const result = await run(["integrations", "doctor", "cursor"])
    const report = dataOf<{
      readonly healthy: boolean
      readonly hosts: ReadonlyArray<{
        readonly checks: ReadonlyArray<{ name: string; ok: boolean }>
      }>
    }>(result.stdout)
    expect(report.healthy).toBe(false)
    expect(report.hosts[0]?.checks.map((check) => check.name)).toEqual(["receipt"])
  })
})

describe("integrations shell", () => {
  it("prints the snippet without writing, then writes it inside the fence", async () => {
    const where = await sandbox()
    const rc = join(where.home, ".zshrc")
    await writeFile(rc, "# my rc\n", "utf8")

    const printed = await run(["integrations", "shell", "--repo", where.store, "--rc", rc])
    expect(parse(printed.stdout).type).toBe("integrations.shell")
    const first = dataOf<{ rc: string; snippet: string; written: boolean; changed: boolean }>(
      printed.stdout
    )
    expect(first).toMatchObject({ rc, written: false, changed: false })
    expect(first.snippet).toContain(`export MEMHTML_ROOT="${where.store}"`)
    expect(await readFile(rc, "utf8")).toBe("# my rc\n")

    const written = await run([
      "integrations",
      "shell",
      "--repo",
      where.store,
      "--rc",
      rc,
      "--write"
    ])
    expect(dataOf<{ written: boolean; changed: boolean }>(written.stdout)).toMatchObject({
      written: true,
      changed: true
    })
    const body = await readFile(rc, "utf8")
    expect(body).toContain("# my rc")
    expect(body).toContain("# MEMHTML:START")

    // A second --write replaces the fence rather than stacking a second one, so nothing changes.
    const again = await run(["integrations", "shell", "--repo", where.store, "--rc", rc, "--write"])
    expect(dataOf<{ changed: boolean }>(again.stdout).changed).toBe(false)
    expect(await readFile(rc, "utf8")).toBe(body)
  })
})

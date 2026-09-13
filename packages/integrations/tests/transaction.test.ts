import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { sha256 } from "../src/fs.js"
import { hostSpec } from "../src/hosts.js"
import { install, planInstall } from "../src/install.js"
import { listIntegrations } from "../src/list.js"
import { readReceipt, receiptPath } from "../src/receipt.js"
import { type BinaryLocation, HOSTS, type HostId, type InstallOptions } from "../src/types.js"
import { uninstall } from "../src/uninstall.js"

/**
 * The transaction, driven against a temp `$HOME` for every host.
 *
 * Three properties get mutation-verified locks here, and each one is named in the case that holds it:
 * **rollback** (a write that throws leaves every other file byte-identical), **the modified refusal** (a
 * hand edit to a managed fragment refuses install and writes nothing), and **idempotence** (a second
 * install reports `changed: false` and touches no byte, including the receipt's `installedAt`).
 *
 * Everything is real: real files, the real adapters, the real receipt. The only fake is the BINARY, and
 * it is a pair of real files in the temp directory rather than a string — `locateBinary` refuses a
 * missing server script, and a doctor row asserts the recorded paths exist, so a fictional path would
 * make those two tests vacuous.
 */

const workspaces: Array<string> = []

interface Fixture {
  readonly home: string
  readonly memhtmlRoot: string
  readonly binary: BinaryLocation
}

const fixture = async (): Promise<Fixture> => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "memhtml-int-tx-")))
  workspaces.push(workspace)
  const home = join(workspace, "home")
  const bin = join(workspace, "bin")
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  const cli = join(bin, "memhtml")
  const mcp = join(bin, "memhtml-mcp")
  await writeFile(cli, "#!/usr/bin/env node\n", "utf8")
  await writeFile(mcp, "#!/usr/bin/env node\n", "utf8")
  return {
    home,
    memhtmlRoot: join(workspace, "memory"),
    binary: { node: process.execPath, cli, mcp, version: "9.9.9" }
  }
}

afterAll(async () => {
  await Promise.all(workspaces.map((root) => rm(root, { recursive: true, force: true })))
})

const optionsFor = (
  host: HostId,
  where: Fixture,
  over: Partial<InstallOptions> = {}
): InstallOptions => ({
  host,
  scope: "user",
  root: where.home,
  memhtmlRoot: where.memhtmlRoot,
  // Only Claude Code has a transcript reader, so only Claude Code records a trace root — which is also
  // what decides whether the two indexing hooks are written at all.
  ...(host === "claude" ? { traceRoot: join(where.home, ".claude") } : {}),
  hooks: "all",
  bareCommand: false,
  force: false,
  dryRun: false,
  binary: where.binary,
  ...over
})

/** Every file under `root`, relative path to content hash. Empty directories are not files. */
const digest = async (root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out[relative(root, full)] = sha256(await readFile(full, "utf8"))
    }
  }
  await walk(root)
  return out
}

const files = async (root: string): Promise<ReadonlyArray<string>> =>
  Object.keys(await digest(root)).sort()

const text = (path: string): Promise<string> => readFile(path, "utf8")

describe("install writes exactly the artifacts each host declares", () => {
  it("wires Claude Code, including both indexing hooks", async () => {
    const where = await fixture()
    const report = await install(optionsFor("claude", where))
    expect(report.changed).toBe(true)
    expect(await files(where.home)).toEqual([
      ".claude.json",
      ".claude/CLAUDE.md",
      ".claude/settings.json",
      ".claude/skills/memhtml/SKILL.md",
      ".config/memhtml/integrations/claude.json"
    ])
    expect(report.entries.map((entry) => entry.role)).toEqual([
      "mcp-entry",
      "hooks",
      "instruction-block",
      "skill"
    ])
    expect(report.entries.every((entry) => entry.action === "created")).toBe(true)
    const settings: unknown = JSON.parse(await text(join(where.home, ".claude", "settings.json")))
    expect(Object.keys((settings as { hooks: Record<string, unknown> }).hooks).sort()).toEqual([
      "PreCompact",
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit"
    ])
    const config: unknown = JSON.parse(await text(join(where.home, ".claude.json")))
    expect(
      (config as { mcpServers: { memhtml: { env: Record<string, string> } } }).mcpServers.memhtml
        .env
    ).toEqual({ MEMHTML_ROOT: where.memhtmlRoot })
  })

  it("wires Codex behind a TOML fence, with no indexing hook", async () => {
    const where = await fixture()
    await install(optionsFor("codex", where))
    expect(await files(where.home)).toEqual([
      ".agents/skills/memhtml/SKILL.md",
      ".codex/AGENTS.md",
      ".codex/config.toml",
      ".codex/hooks.json",
      ".config/memhtml/integrations/codex.json"
    ])
    const config = await text(join(where.home, ".codex", "config.toml"))
    expect(config).toContain("# MEMHTML:START")
    expect(config).toContain("[mcp_servers.memhtml]")
    const hooks: unknown = JSON.parse(await text(join(where.home, ".codex", "hooks.json")))
    expect(Object.keys((hooks as { hooks: Record<string, unknown> }).hooks).sort()).toEqual([
      "SessionStart",
      "UserPromptSubmit"
    ])
  })

  it("wires Cursor with one hook, a version key, and no instruction file at user scope", async () => {
    const where = await fixture()
    const report = await install(optionsFor("cursor", where))
    expect(await files(where.home)).toEqual([
      ".agents/skills/memhtml/SKILL.md",
      ".config/memhtml/integrations/cursor.json",
      ".cursor/hooks.json",
      ".cursor/mcp.json"
    ])
    expect(report.entries.map((entry) => entry.role)).toEqual(["mcp-entry", "hooks", "skill"])
    const hooks: unknown = JSON.parse(await text(join(where.home, ".cursor", "hooks.json")))
    expect(hooks).toMatchObject({ version: 1 })
    expect(Object.keys((hooks as { hooks: Record<string, unknown> }).hooks)).toEqual([
      "sessionStart"
    ])
  })

  it("wires OpenCode with a generated plugin instead of a hooks file", async () => {
    const where = await fixture()
    const report = await install(optionsFor("opencode", where))
    expect(await files(where.home)).toEqual([
      ".agents/skills/memhtml/SKILL.md",
      ".config/memhtml/integrations/opencode.json",
      ".config/opencode/AGENTS.md",
      ".config/opencode/opencode.json",
      ".config/opencode/plugins/memhtml.js"
    ])
    expect(report.entries.map((entry) => entry.role)).toEqual([
      "mcp-entry",
      "plugin",
      "instruction-block",
      "skill"
    ])
    const plugin = await text(join(where.home, ".config", "opencode", "plugins", "memhtml.js"))
    expect(plugin).toContain("MemhtmlPlugin")
    // The plugin imports node's own child_process and nothing of memhtml's, so a moved toolchain
    // cannot stop OpenCode from starting.
    expect(plugin).not.toContain("@memhtml/")
    const config: unknown = JSON.parse(
      await text(join(where.home, ".config", "opencode", "opencode.json"))
    )
    expect(config).toMatchObject({ mcp: { memhtml: { type: "local", enabled: true } } })
  })

  it("writes no hook and no plugin under --hooks none", async () => {
    for (const host of HOSTS) {
      const where = await fixture()
      const report = await install(optionsFor(host, where, { hooks: "none" }))
      expect(report.entries.some((entry) => entry.role === "hooks")).toBe(false)
      expect(report.entries.some((entry) => entry.role === "plugin")).toBe(false)
      expect(await files(where.home)).not.toContain(".config/opencode/plugins/memhtml.js")
    }
  })

  it("shares one skill file across the three hosts that read ~/.agents, and says so", async () => {
    const where = await fixture()
    const shared = join(where.home, ".agents", "skills", "memhtml", "SKILL.md")
    await install(optionsFor("codex", where))
    // The same bytes, so the second host adopts the file rather than refusing it as somebody else's.
    const second = await install(optionsFor("cursor", where))
    expect(second.entries.find((entry) => entry.role === "skill")?.action).toBe("unchanged")

    const removed = await uninstall("codex", "user", where.home)
    expect(removed.removed.find((entry) => entry.role === "skill")?.action).toBe("unchanged")
    // Cursor is still wired to it, so the file stays and Cursor still reads as installed.
    expect(await text(shared)).toContain("name: memhtml")
    const rows = await listIntegrations(where.home)
    expect(rows.find((row) => row.host === "cursor")?.state).toBe("installed")
    expect(rows.find((row) => row.host === "codex")?.state).toBe("not-installed")
  })

  it("records a receipt whose claims hash what is on disk, for every host", async () => {
    for (const host of HOSTS) {
      const where = await fixture()
      await install(optionsFor(host, where))
      const receipt = await readReceipt(receiptPath("user", where.home, host))
      expect(receipt?.host).toBe(host)
      expect(receipt?.binary.cli).toBe(where.binary.cli)
      expect(receipt?.entries.length).toBeGreaterThan(2)
      const rows = await listIntegrations(where.home)
      expect(rows.find((row) => row.host === host)?.state).toBe("installed")
    }
  })
})

describe("idempotence (mutation-verified lock: install twice writes no byte)", () => {
  it("reports changed: false and leaves every file, including the receipt, byte-identical", async () => {
    for (const host of HOSTS) {
      const where = await fixture()
      await install(optionsFor(host, where))
      const before = await digest(where.home)
      const again = await install(optionsFor(host, where))
      expect(again.changed).toBe(false)
      expect(again.entries.every((entry) => entry.action === "unchanged")).toBe(true)
      // The receipt too: rewriting it would move `installedAt` and make an idempotent re-run show up
      // as work in every diff of a dotfiles repository.
      expect(await digest(where.home)).toEqual(before)
    }
  })

  it("reports changed: true when the store root moves, and rewrites only what changed", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    const moved = await install(
      optionsFor("claude", where, { memhtmlRoot: join(where.home, "elsewhere") })
    )
    expect(moved.changed).toBe(true)
    expect(moved.entries.every((entry) => entry.action === "updated")).toBe(true)
  })
})

describe("a file other tools own", () => {
  it("keeps JSONC comments, foreign servers, and foreign hooks through install and uninstall", async () => {
    const where = await fixture()
    const claudeJson = join(where.home, ".claude.json")
    const settings = join(where.home, ".claude", "settings.json")
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    await mkdir(dirname(settings), { recursive: true })
    await writeFile(
      claudeJson,
      '{\n  // the operator\'s own note\n  "mcpServers": {\n    "other": {\n      "command": "other-mcp"\n    }\n  }\n}\n',
      "utf8"
    )
    // Written out over lines, the way a formatter leaves it: see the case below for what an inline
    // member costs, which is the one thing install does not preserve byte for byte.
    await writeFile(
      settings,
      [
        "{",
        '  "hooks": {',
        '    "SessionStart": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "echo mine",',
        '            "timeout": 5',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
        ""
      ].join("\n"),
      "utf8"
    )
    await writeFile(claudeMd, "# My notes\n\nHello.\n", "utf8")
    const originals = {
      claudeJson: await text(claudeJson),
      settings: await text(settings),
      claudeMd: await text(claudeMd)
    }

    await install(optionsFor("claude", where))
    const afterInstall = await text(claudeJson)
    expect(afterInstall).toContain("the operator's own note")
    expect(afterInstall).toContain('"other"')
    expect(await text(settings)).toContain("echo mine")
    expect(await text(claudeMd)).toContain("# My notes")

    const removed = await uninstall("claude", "user", where.home)
    expect(removed.state).toBe("installed")
    expect(await text(claudeJson)).toBe(originals.claudeJson)
    expect(await text(claudeMd)).toBe(originals.claudeMd)
    expect(await text(settings)).toBe(originals.settings)
  })

  it("re-prints an inline sibling member, which is jsonc-parser's minimal edit and not a loss", async () => {
    /**
     * Measured, and the one thing an install does NOT keep byte for byte. `jsonc-parser` computes a
     * minimal text edit, and inserting a sibling key re-prints a member the operator had written on one
     * line: `"other": { "command": "other-mcp" }` comes back over three. Comments, key order, and every
     * value survive — the line breaking of the member beside ours does not.
     */
    const where = await fixture()
    const claudeJson = join(where.home, ".claude.json")
    const original = '{\n  "mcpServers": {\n    "other": { "command": "other-mcp" }\n  }\n}\n'
    await writeFile(claudeJson, original, "utf8")
    await install(optionsFor("claude", where))
    await uninstall("claude", "user", where.home)
    const after = await text(claudeJson)
    expect(after).not.toBe(original)
    expect(JSON.parse(after)).toEqual(JSON.parse(original))
  })

  it("keeps an OpenCode opencode.json's comments and its own mcp server", async () => {
    const where = await fixture()
    const config = join(where.home, ".config", "opencode", "opencode.json")
    await mkdir(dirname(config), { recursive: true })
    const original = [
      "{",
      "  // pinned on purpose",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "other": {',
      '      "type": "local",',
      '      "command": ["other-mcp"]',
      "    }",
      "  }",
      "}",
      ""
    ].join("\n")
    await writeFile(config, original, "utf8")
    await install(optionsFor("opencode", where))
    const after = await text(config)
    expect(after).toContain("// pinned on purpose")
    expect(after).toContain('"$schema"')
    expect(after).toContain('"other"')
    await uninstall("opencode", "user", where.home)
    expect(await text(config)).toBe(original)
  })

  it("keeps a Codex config.toml's own tables outside the fence", async () => {
    const where = await fixture()
    const config = join(where.home, ".codex", "config.toml")
    await mkdir(dirname(config), { recursive: true })
    const original = 'model = "gpt-5.6"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n'
    await writeFile(config, original, "utf8")
    await install(optionsFor("codex", where))
    expect(await text(config)).toContain('model = "gpt-5.6"')
    expect(await text(config)).toContain("[mcp_servers.other]")
    await uninstall("codex", "user", where.home)
    expect(await text(config)).toBe(original)
  })

  it("refuses a Codex config.toml that already declares [mcp_servers.memhtml] by hand", async () => {
    const where = await fixture()
    const config = join(where.home, ".codex", "config.toml")
    await mkdir(dirname(config), { recursive: true })
    await writeFile(config, '[mcp_servers.memhtml]\ncommand = "memhtml-mcp"\n', "utf8")
    const before = await digest(where.home)
    await expect(install(optionsFor("codex", where))).rejects.toMatchObject({
      _tag: "IntegrationModified"
    })
    // A second table would make the file unloadable, so nothing was written at all.
    expect(await digest(where.home)).toEqual(before)
  })

  it("refuses an unclaimed memhtml MCP entry, and adopts it with --force", async () => {
    const where = await fixture()
    const claudeJson = join(where.home, ".claude.json")
    await writeFile(claudeJson, '{ "mcpServers": { "memhtml": { "command": "old" } } }\n', "utf8")
    await expect(install(optionsFor("claude", where))).rejects.toMatchObject({
      _tag: "IntegrationModified",
      path: claudeJson
    })
    const forced = await install(optionsFor("claude", where, { force: true }))
    expect(forced.backups.length).toBe(1)
    expect(await text(forced.backups[0] ?? "")).toContain('"old"')
    expect(await text(claudeJson)).toContain(where.binary.mcp)
  })
})

describe("the modified refusal (mutation-verified lock: a hand edit stops install)", () => {
  it("refuses install and writes nothing when a managed block was edited", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    const edited = (await text(claudeMd)).replace("memhtml memory", "MY memory")
    await writeFile(claudeMd, edited, "utf8")
    const before = await digest(where.home)

    await expect(install(optionsFor("claude", where))).rejects.toMatchObject({
      _tag: "IntegrationModified",
      host: "claude",
      path: claudeMd
    })
    expect(await digest(where.home)).toEqual(before)
  })

  it("ignores an edit OUTSIDE the fence, because those bytes were never claimed", async () => {
    const where = await fixture()
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    await install(optionsFor("claude", where))
    await writeFile(claudeMd, `${await text(claudeMd)}\nmy own paragraph\n`, "utf8")
    const again = await install(optionsFor("claude", where))
    expect(again.changed).toBe(false)
    expect(await text(claudeMd)).toContain("my own paragraph")
  })

  it("overwrites with --force and keeps the prior bytes in a named backup", async () => {
    const where = await fixture()
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    await mkdir(dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, "# My notes\n", "utf8")
    await install(optionsFor("claude", where))
    const edited = (await text(claudeMd)).replace("## memhtml memory", "## MY memory")
    await writeFile(claudeMd, edited, "utf8")

    const forced = await install(optionsFor("claude", where, { force: true }))
    expect(forced.changed).toBe(true)
    expect(forced.backups).toHaveLength(1)
    const backup = forced.backups[0] ?? ""
    expect(backup.startsWith(`${claudeMd}.memhtml-backup-`)).toBe(true)
    expect(await text(backup)).toBe(edited)
    const restored = await text(claudeMd)
    expect(restored).toContain("## memhtml memory")
    // The prose outside the fence is the operator's and survives the overwrite.
    expect(restored).toContain("# My notes")
  })

  it("refuses uninstall on a modified entry, with no --force to override it", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    const skill = join(where.home, ".claude", "skills", "memhtml", "SKILL.md")
    await writeFile(skill, `${await text(skill)}\n## my own section\n`, "utf8")
    const before = await digest(where.home)

    await expect(uninstall("claude", "user", where.home)).rejects.toMatchObject({
      _tag: "IntegrationModified",
      path: skill
    })
    expect(await digest(where.home)).toEqual(before)
    expect(await text(skill)).toContain("my own section")
  })

  it("reports a modified install as `modified` in list", async () => {
    const where = await fixture()
    await install(optionsFor("cursor", where))
    const rules = join(where.home, ".agents", "skills", "memhtml", "SKILL.md")
    await writeFile(rules, "gutted\n", "utf8")
    const rows = await listIntegrations(where.home)
    expect(rows.find((row) => row.host === "cursor")?.state).toBe("modified")
    expect(rows.find((row) => row.host === "cursor")?.detail).toContain("skill")
  })
})

describe("uninstall", () => {
  it("is success and a no-op when nothing is installed", async () => {
    const where = await fixture()
    const report = await uninstall("codex", "user", where.home)
    expect(report).toMatchObject({ state: "not-installed", removed: [], changed: false })
    expect(await files(where.home)).toEqual([])
  })

  it("leaves no file, and no empty skill directory, for every host", async () => {
    for (const host of HOSTS) {
      const where = await fixture()
      await install(optionsFor(host, where))
      const report = await uninstall(host, "user", where.home)
      expect(report.removed.every((entry) => entry.action === "removed")).toBe(true)
      expect(await files(where.home)).toEqual([])
      const skillDir = dirname(hostSpec(host, "user", where.home).skill)
      await expect(readdir(skillDir)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await listIntegrations(where.home)).toEqual(
        expect.arrayContaining([expect.objectContaining({ host, state: "not-installed" })])
      )
    }
  })

  it("leaves the host's own directory alone", async () => {
    const where = await fixture()
    await install(optionsFor("claude", where))
    await uninstall("claude", "user", where.home)
    /**
     * `.claude/` is Claude Code's and stays. `skills/memhtml/` was ours and goes, while `skills/` itself
     * is the host's namespace and is left even when empty — pruning a directory a host is about to write
     * to is not uninstall's business, and no FILE of ours is left anywhere.
     */
    await expect(readdir(join(where.home, ".claude"))).resolves.toEqual(["skills"])
    expect(await files(where.home)).toEqual([])
  })
})

describe("dry run", () => {
  it("reports every path with its rendered content and writes nothing", async () => {
    const where = await fixture()
    const report = await install(optionsFor("claude", where, { dryRun: true }))
    expect(report.dryRun).toBe(true)
    expect(report.entries.every((entry) => entry.action === "planned")).toBe(true)
    expect(await files(where.home)).toEqual([])

    const contents = report.contents ?? {}
    expect(Object.keys(contents).sort()).toEqual(report.entries.map((entry) => entry.path).sort())
    // The rendered content is what a real install would land, byte for byte.
    const real = await install(optionsFor("claude", where))
    for (const [path, planned] of Object.entries(contents)) {
      expect(await text(path)).toBe(planned)
    }
    expect(real.entries.map((entry) => entry.path).sort()).toEqual(Object.keys(contents).sort())
  })
})

describe("rollback (mutation-verified lock: a failed write leaves nothing behind)", () => {
  it("restores every earlier file when one write throws", async () => {
    const where = await fixture()
    const claudeMd = join(where.home, ".claude", "CLAUDE.md")
    await mkdir(dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, "# notes\n", "utf8")
    /**
     * A regular FILE where the skill's directory has to go. The skill is the last write of the plan, so
     * the MCP entry, the hooks, and the instruction block have all landed by the time `mkdir` fails with
     * ENOTDIR — which is exactly the shape of failure rollback exists for.
     */
    await writeFile(join(where.home, ".claude", "skills"), "not a directory", "utf8")
    const before = await digest(where.home)

    await expect(install(optionsFor("claude", where))).rejects.toThrow()
    expect(await digest(where.home)).toEqual(before)
    // And no receipt, so a failed install is indistinguishable from one that never ran.
    expect(await readReceipt(receiptPath("user", where.home, "claude"))).toBeNull()
  })
})

describe("project scope", () => {
  it("puts the block in AGENTS.md and an import in CLAUDE.md when the repo has an AGENTS.md", async () => {
    const where = await fixture()
    const root = join(where.home, "work", "api")
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "# House rules\n", "utf8")
    const report = await install(optionsFor("claude", where, { scope: "project", root }))
    expect(
      report.entries
        .filter((entry) => entry.role === "instruction-block")
        .map((entry) => entry.path)
    ).toEqual([join(root, "AGENTS.md"), join(root, "CLAUDE.md")])
    expect(await text(join(root, "AGENTS.md"))).toContain("memhtml memory")
    expect(await text(join(root, "CLAUDE.md"))).toContain("@AGENTS.md")
    expect(await files(root)).toEqual([
      ".claude/settings.json",
      ".claude/skills/memhtml/SKILL.md",
      ".mcp.json",
      ".memhtml-integrations/claude.json",
      "AGENTS.md",
      "CLAUDE.md"
    ])
  })

  it("puts the block in CLAUDE.md when the repo has no AGENTS.md", async () => {
    const where = await fixture()
    const root = join(where.home, "work", "api")
    await mkdir(root, { recursive: true })
    const report = await install(optionsFor("claude", where, { scope: "project", root }))
    expect(
      report.entries
        .filter((entry) => entry.role === "instruction-block")
        .map((entry) => entry.path)
    ).toEqual([join(root, "CLAUDE.md")])
    expect(await text(join(root, "CLAUDE.md"))).toContain("memhtml memory")
  })

  it("leaves a CLAUDE.md that is only `@AGENTS.md` untouched", async () => {
    const where = await fixture()
    const root = join(where.home, "work", "api")
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "# House rules\n", "utf8")
    await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n", "utf8")
    const report = await install(optionsFor("claude", where, { scope: "project", root }))
    // The pointer is the operator's choice; writing our block into it would show the prose twice.
    expect(report.entries.map((entry) => entry.path)).not.toContain(join(root, "CLAUDE.md"))
    expect(await text(join(root, "CLAUDE.md"))).toBe("@AGENTS.md\n")
    expect(await text(join(root, "AGENTS.md"))).toContain("memhtml memory")
  })

  it("writes a Cursor rules file at project scope, where user scope had none", async () => {
    const where = await fixture()
    const root = join(where.home, "work", "api")
    await mkdir(root, { recursive: true })
    const report = await install(optionsFor("cursor", where, { scope: "project", root }))
    const rules = report.entries.find((entry) => entry.role === "rules")
    expect(rules?.path).toBe(join(root, ".cursor", "rules", "memhtml.mdc"))
    expect(await text(rules?.path ?? "")).toContain("alwaysApply: true")
  })

  it("refuses the filesystem root as a project root", async () => {
    const where = await fixture()
    await expect(
      install(optionsFor("claude", where, { scope: "project", root: "/" }))
    ).rejects.toThrow(/filesystem root/)
  })

  it("keeps the user-scope and project-scope receipts apart", async () => {
    const where = await fixture()
    const root = join(where.home, "work", "api")
    await mkdir(root, { recursive: true })
    await install(optionsFor("claude", where))
    await install(optionsFor("claude", where, { scope: "project", root }))
    const rows = await listIntegrations(where.home, root)
    expect(
      rows.filter((row) => row.host === "claude").map((row) => [row.scope, row.state])
    ).toEqual([
      ["user", "installed"],
      ["project", "installed"]
    ])
  })
})

describe("planInstall", () => {
  it("is pure: reading a plan writes nothing and every apply is a function of the current text", async () => {
    const where = await fixture()
    const plan = await planInstall(optionsFor("claude", where))
    expect(await files(where.home)).toEqual([])
    for (const write of plan.writes) {
      const fresh = write.apply(null)
      // Applying to our own output is a fixed point, which is what makes a re-install a no-op.
      expect(write.apply(fresh)).toBe(fresh)
      expect(write.ownedNow(fresh)).toBe(write.content)
      expect(write.strip(fresh)).toBeNull()
    }
  })
})

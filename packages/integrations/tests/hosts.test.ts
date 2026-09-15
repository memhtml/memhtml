import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { DEFAULT_TRACE_ROOT, DETECT_DIRS, detectHosts, hostSpec } from "../src/hosts.js"
import { HOSTS, SCOPES } from "../src/types.js"

/**
 * The registry is a table of vendor facts, so its test is a table too: every path, for every host, at
 * every scope, spelled out rather than derived.
 *
 * Deriving the expectation from the same `join` calls the implementation makes would assert only that
 * `join` is deterministic. A typo in a vendor's directory name is exactly the defect this catches, and it
 * is invisible to any test that builds its expectation from the code under test.
 */

const roots: Array<string> = []

const tempRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memhtml-int-hosts-")))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** Every managed path of one spec, relative to the root, so an expectation reads as a file tree. */
const layout = (host: (typeof HOSTS)[number], scope: (typeof SCOPES)[number], root: string) => {
  const spec = hostSpec(host, scope, root)
  return {
    mcp: relative(root, spec.mcp.file),
    hooks: relative(root, spec.hooks.file),
    instruction: spec.instruction === null ? null : relative(root, spec.instruction.file),
    skill: relative(root, spec.skill)
  }
}

describe("hostSpec at user scope", () => {
  it("puts Claude Code's files where Claude Code reads them", () => {
    expect(layout("claude", "user", "/home/ada")).toEqual({
      mcp: ".claude.json",
      hooks: ".claude/settings.json",
      instruction: ".claude/CLAUDE.md",
      skill: ".claude/skills/memhtml/SKILL.md"
    })
    const spec = hostSpec("claude", "user", "/home/ada")
    expect(spec.mcp.format).toBe("json")
    expect(spec.mcp.format === "json" ? spec.mcp.keyPath : []).toEqual(["mcpServers", "memhtml"])
    // Claude Code watches its own settings, hooks, and skills, so nothing is left for the operator.
    expect(spec.nextSteps).toEqual([])
  })

  it("puts Codex's MCP entry in the config.toml it also hand-tunes, behind a fence", () => {
    expect(layout("codex", "user", "/home/ada")).toEqual({
      mcp: ".codex/config.toml",
      hooks: ".codex/hooks.json",
      instruction: ".codex/AGENTS.md",
      skill: ".agents/skills/memhtml/SKILL.md"
    })
    const spec = hostSpec("codex", "user", "/home/ada")
    expect(spec.mcp.format).toBe("toml-fence")
    expect(spec.mcp.format === "toml-fence" ? spec.mcp.table : "").toBe("mcp_servers.memhtml")
    expect(spec.nextSteps.join(" ")).toContain("/hooks")
  })

  it("gives Cursor no user-level instruction file, and versions its hooks file", () => {
    expect(layout("cursor", "user", "/home/ada")).toEqual({
      mcp: ".cursor/mcp.json",
      hooks: ".cursor/hooks.json",
      instruction: null,
      skill: ".agents/skills/memhtml/SKILL.md"
    })
    const spec = hostSpec("cursor", "user", "/home/ada")
    expect(spec.hooks.format === "json-arrays" ? spec.hooks.versionKey : undefined).toEqual({
      keyPath: ["version"],
      value: 1
    })
  })

  it("gives OpenCode a plugin file where the other three have a hooks file", () => {
    expect(layout("opencode", "user", "/home/ada")).toEqual({
      mcp: ".config/opencode/opencode.json",
      hooks: ".config/opencode/plugins/memhtml.js",
      instruction: ".config/opencode/AGENTS.md",
      skill: ".agents/skills/memhtml/SKILL.md"
    })
    expect(hostSpec("opencode", "user", "/home/ada").hooks.format).toBe("plugin-file")
    expect(
      hostSpec("opencode", "user", "/home/ada").mcp.format === "json"
        ? hostSpec("opencode", "user", "/home/ada").mcp
        : null
    ).toMatchObject({ keyPath: ["mcp", "memhtml"] })
  })
})

describe("hostSpec at project scope", () => {
  it("moves every path inside the repository", () => {
    expect(layout("claude", "project", "/work/api")).toEqual({
      mcp: ".mcp.json",
      hooks: ".claude/settings.json",
      instruction: "CLAUDE.md",
      skill: ".claude/skills/memhtml/SKILL.md"
    })
    expect(layout("codex", "project", "/work/api")).toEqual({
      mcp: ".codex/config.toml",
      hooks: ".codex/hooks.json",
      instruction: "AGENTS.md",
      skill: ".agents/skills/memhtml/SKILL.md"
    })
    expect(layout("cursor", "project", "/work/api")).toEqual({
      mcp: ".cursor/mcp.json",
      hooks: ".cursor/hooks.json",
      instruction: ".cursor/rules/memhtml.mdc",
      skill: ".agents/skills/memhtml/SKILL.md"
    })
    expect(layout("opencode", "project", "/work/api")).toEqual({
      mcp: "opencode.json",
      hooks: ".opencode/plugins/memhtml.js",
      instruction: "AGENTS.md",
      skill: ".agents/skills/memhtml/SKILL.md"
    })
  })

  it("offers Claude Code an AGENTS.md fork, and only Claude Code", () => {
    const claude = hostSpec("claude", "project", "/work/api")
    expect(
      claude.instruction?.format === "markdown-block" ? claude.instruction.agentsFile : undefined
    ).toBe("/work/api/AGENTS.md")
    for (const host of ["codex", "cursor", "opencode"] as const) {
      const spec = hostSpec(host, "project", "/work/api")
      expect(
        spec.instruction?.format === "markdown-block" ? spec.instruction.agentsFile : undefined
      ).toBeUndefined()
    }
    // The prompt is the host's own, and it is the one manual step a project install leaves.
    expect(claude.nextSteps.join(" ")).toContain(".mcp.json")
  })

  it("declares one path per artifact, with no two artifacts sharing a path", () => {
    for (const host of HOSTS) {
      for (const scope of SCOPES) {
        const spec = hostSpec(host, scope, "/work/api")
        const paths = [spec.mcp.file, spec.hooks.file, spec.instruction?.file, spec.skill].filter(
          (path): path is string => path !== undefined
        )
        expect(new Set(paths).size).toBe(paths.length)
        for (const path of paths) expect(path.startsWith("/work/api/")).toBe(true)
      }
    }
  })
})

describe("detectHosts", () => {
  it("reports every host whose config directory exists, in HOSTS order", async () => {
    const home = await tempRoot()
    expect(await detectHosts(home)).toEqual([])
    await mkdir(join(home, DETECT_DIRS.opencode), { recursive: true })
    await mkdir(join(home, DETECT_DIRS.claude), { recursive: true })
    expect(await detectHosts(home)).toEqual(["claude", "opencode"])
  })

  it("ignores a FILE at the detection path", async () => {
    const home = await tempRoot()
    await writeFile(join(home, DETECT_DIRS.claude), "not a directory", "utf8")
    expect(await detectHosts(home)).toEqual([])
  })
})

describe("DEFAULT_TRACE_ROOT", () => {
  it("names a transcript directory for Claude Code alone", () => {
    // The reader in `@memhtml/traces` speaks Claude Code's format and no other, so any other host's
    // default here would arm an indexing hook over a tree it cannot parse.
    expect(DEFAULT_TRACE_ROOT.claude).toBe(join("~", ".claude"))
    expect(DEFAULT_TRACE_ROOT.codex).toBeNull()
    expect(DEFAULT_TRACE_ROOT.cursor).toBeNull()
    expect(DEFAULT_TRACE_ROOT.opencode).toBeNull()
  })
})

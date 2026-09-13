import { describe, expect, it } from "vitest"

import { mcpCommand } from "../src/command-line.js"
import {
  claudeMcpEntry,
  codexMcpToml,
  cursorMcpEntry,
  MCP_SERVER_KEY,
  opencodeMcpEntry
} from "../src/render/mcp.js"
import type { BinaryLocation } from "../src/types.js"

const BINARY: BinaryLocation = {
  node: "/opt/nodes/24.9.0/bin/node",
  cli: "/opt/memhtml/0.14.0/dist/memhtml.mjs",
  mcp: "/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs",
  version: "0.14.0"
}

const ENV = {
  MEMHTML_ROOT: "/home/dev/memory",
  MEMHTML_TRACE_ROOT: "/home/dev/.claude"
}

/**
 * A minimal TOML reader for exactly the document `codexMcpToml` writes: table headers, `key = "value"`,
 * and one array of basic strings. It parses rather than searches, so a stray line or a key landing under
 * the wrong table is a failure instead of a substring that happens to be present.
 */
const parseToml = (text: string) => {
  const tables: Record<string, Record<string, string | ReadonlyArray<string>>> = {}
  let current: string | undefined
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header?.[1] !== undefined) {
      current = header[1]
      tables[current] = {}
      continue
    }
    const pair = /^([A-Za-z0-9_]+) = (.+)$/.exec(line)
    if (pair === null || current === undefined) throw new Error(`unparsed TOML line: ${line}`)
    const [, key, raw] = pair
    if (key === undefined || raw === undefined) throw new Error(`unparsed TOML line: ${line}`)
    const table = tables[current]
    if (table === undefined) throw new Error(`no table for ${key}`)
    const unquote = (value: string) =>
      value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    table[key] = raw.startsWith("[")
      ? raw
          .slice(1, -1)
          .split(", ")
          .map((item) => unquote(item))
      : unquote(raw)
  }
  return tables
}

describe("JSON MCP entries", () => {
  it("renders Claude Code's mcpServers.memhtml with command, args, and env", () => {
    expect(MCP_SERVER_KEY).toBe("memhtml")
    expect(claudeMcpEntry(mcpCommand(BINARY, false), ENV)).toEqual({
      command: "/opt/nodes/24.9.0/bin/node",
      args: ["/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs"],
      env: ENV
    })
  })

  it("omits args entirely on the bare command rather than writing an empty array", () => {
    /**
     * MUTATION-VERIFIED LOCK "empty args is omitted, not written": making `claudeMcpEntry` always spread
     * `args` fails this case. `claude mcp get` prints the entry back, and `args: []` reads as a command
     * whose arguments were lost.
     */
    const entry = claudeMcpEntry(mcpCommand(BINARY, true), ENV)
    expect(entry).toEqual({ command: "memhtml-mcp", env: ENV })
    expect("args" in entry).toBe(false)
  })

  it("gives Cursor the same object as Claude Code, key for key", () => {
    for (const bare of [false, true]) {
      expect(cursorMcpEntry(mcpCommand(BINARY, bare), ENV)).toEqual(
        claudeMcpEntry(mcpCommand(BINARY, bare), ENV)
      )
    }
  })

  it("copies env rather than aliasing the caller's object", () => {
    const env = { MEMHTML_ROOT: "/home/dev/memory" }
    const entry = claudeMcpEntry(mcpCommand(BINARY, true), env)
    expect(entry.env).not.toBe(env)
    expect(entry.env).toEqual(env)
  })
})

describe("opencodeMcpEntry", () => {
  it("renders one command array, environment rather than env, and enabled", () => {
    expect(opencodeMcpEntry(mcpCommand(BINARY, false), ENV)).toEqual({
      type: "local",
      command: ["/opt/nodes/24.9.0/bin/node", "/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs"],
      environment: ENV,
      enabled: true
    })
    expect(opencodeMcpEntry(mcpCommand(BINARY, true), ENV).command).toEqual(["memhtml-mcp"])
  })
})

describe("codexMcpToml", () => {
  it("round-trips through a minimal parse: two tables, command, args, env keys", () => {
    const text = codexMcpToml(mcpCommand(BINARY, false), ENV)
    expect(text).toMatch(/^\[mcp_servers\.memhtml\]$/m)
    expect(text).toMatch(/^\[mcp_servers\.memhtml\.env\]$/m)
    expect(parseToml(text)).toEqual({
      "mcp_servers.memhtml": {
        command: "/opt/nodes/24.9.0/bin/node",
        args: ["/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs"]
      },
      "mcp_servers.memhtml.env": ENV
    })
  })

  it("keeps the env table last, so no key lands under the wrong table", () => {
    const text = codexMcpToml(mcpCommand(BINARY, false), ENV)
    expect(text.indexOf("[mcp_servers.memhtml.env]")).toBeGreaterThan(text.indexOf("command ="))
    expect(text.indexOf("MEMHTML_ROOT =")).toBeGreaterThan(
      text.indexOf("[mcp_servers.memhtml.env]")
    )
    expect(text.endsWith("\n")).toBe(true)
  })

  it("omits the args line for the bare command", () => {
    const text = codexMcpToml(mcpCommand(BINARY, true), ENV)
    expect(text).not.toContain("args")
    expect(parseToml(text)["mcp_servers.memhtml"]).toEqual({ command: "memhtml-mcp" })
  })

  it("escapes the backslash and the double quote in a basic string", () => {
    const text = codexMcpToml(
      { command: 'C:\\Program Files\\node "x"', args: ["C:\\memhtml\\mcp.mjs"] },
      { MEMHTML_ROOT: 'C:\\Users\\dev\\"memory"' }
    )
    expect(text).toContain('command = "C:\\\\Program Files\\\\node \\"x\\""')
    expect(parseToml(text)).toEqual({
      "mcp_servers.memhtml": {
        command: 'C:\\Program Files\\node "x"',
        args: ["C:\\memhtml\\mcp.mjs"]
      },
      "mcp_servers.memhtml.env": { MEMHTML_ROOT: 'C:\\Users\\dev\\"memory"' }
    })
  })
})

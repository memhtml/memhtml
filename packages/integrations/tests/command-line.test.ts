import { describe, expect, it } from "vitest"

import { cliCommand, hookCommand, mcpCommand, shellJoin, shellQuote } from "../src/command-line.js"
import type { BinaryLocation } from "../src/types.js"

const BINARY: BinaryLocation = {
  node: "/opt/nodes/24.9.0/bin/node",
  cli: "/opt/memhtml/0.14.0/dist/memhtml.mjs",
  mcp: "/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs",
  version: "0.14.0"
}

const ROOT = "/home/dev/memory"

describe("cliCommand / mcpCommand", () => {
  it("runs the recorded node against the recorded entry script by default", () => {
    expect(cliCommand(BINARY, false)).toEqual({
      command: "/opt/nodes/24.9.0/bin/node",
      args: ["/opt/memhtml/0.14.0/dist/memhtml.mjs"]
    })
    expect(mcpCommand(BINARY, false)).toEqual({
      command: "/opt/nodes/24.9.0/bin/node",
      args: ["/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs"]
    })
  })

  it("writes the bare binary names with no arguments when bare is asked for", () => {
    expect(cliCommand(BINARY, true)).toEqual({ command: "memhtml", args: [] })
    expect(mcpCommand(BINARY, true)).toEqual({ command: "memhtml-mcp", args: [] })
  })
})

describe("hookCommand", () => {
  it("passes the store as --repo so a hook never depends on cwd or a shell environment", () => {
    expect(hookCommand(BINARY, false, "session-start", "claude", { memhtmlRoot: ROOT })).toEqual({
      command: "/opt/nodes/24.9.0/bin/node",
      args: [
        "/opt/memhtml/0.14.0/dist/memhtml.mjs",
        "hook",
        "session-start",
        "--host",
        "claude",
        "--repo",
        ROOT
      ]
    })
  })

  it("appends --trace-root only when a transcript root is known", () => {
    const without = hookCommand(BINARY, true, "pre-compact", "claude", { memhtmlRoot: ROOT })
    expect(without.args).not.toContain("--trace-root")
    const withTrace = hookCommand(BINARY, true, "pre-compact", "claude", {
      memhtmlRoot: ROOT,
      traceRoot: "/home/dev/.claude"
    })
    expect(withTrace).toEqual({
      command: "memhtml",
      args: [
        "hook",
        "pre-compact",
        "--host",
        "claude",
        "--repo",
        ROOT,
        "--trace-root",
        "/home/dev/.claude"
      ]
    })
  })

  it("names the host it renders for, per host", () => {
    for (const host of ["claude", "codex", "cursor", "opencode"] as const) {
      const line = hookCommand(BINARY, true, "session-start", host, { memhtmlRoot: ROOT })
      expect(line.args[line.args.indexOf("--host") + 1]).toBe(host)
    }
  })
})

describe("shellJoin", () => {
  it("leaves a plain POSIX path unquoted", () => {
    expect(shellJoin(cliCommand(BINARY, false))).toBe(
      "/opt/nodes/24.9.0/bin/node /opt/memhtml/0.14.0/dist/memhtml.mjs"
    )
  })

  it("quotes a space, which is the whole reason this function exists", () => {
    /**
     * Claude Code, Codex, and Cursor store a hook as one `command` STRING and run it through a shell, so
     * an unquoted `Application Support` is a two-word command that silently does nothing.
     */
    const spaced: BinaryLocation = {
      ...BINARY,
      node: "/Users/dev/Library/Application Support/node/bin/node",
      cli: "/Users/dev/Library/Application Support/memhtml/memhtml.mjs"
    }
    expect(shellJoin(cliCommand(spaced, false))).toBe(
      "'/Users/dev/Library/Application Support/node/bin/node' " +
        "'/Users/dev/Library/Application Support/memhtml/memhtml.mjs'"
    )
  })

  it("splices a single quote as close, double-quoted quote, reopen", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
    expect(shellJoin({ command: "memhtml", args: ["hook", "--repo", "/home/it's/memory"] })).toBe(
      `memhtml hook --repo '/home/it'"'"'s/memory'`
    )
  })

  it("quotes every character a shell would otherwise read", () => {
    for (const value of ["a b", "a;b", "a$b", "a`b", "a|b", "a>b", "a*b", "a(b)", "", "a\nb"]) {
      expect(shellQuote(value).startsWith("'")).toBe(true)
    }
    for (const value of ["memhtml", "/opt/a-b_c.d/e", "MEMHTML_ROOT=/x", "user@host", "50%"]) {
      expect(shellQuote(value)).toBe(value)
    }
  })
})

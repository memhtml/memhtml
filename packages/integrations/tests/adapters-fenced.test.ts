import { describe, expect, it } from "vitest"

import {
  BLOCK_END,
  BLOCK_START,
  isClaudeImportOnly,
  readFencedBlock,
  removeFencedBlock,
  upsertFencedBlock
} from "../src/adapters/markdown.js"
import {
  readShellFence,
  removeShellFence,
  SHELL_FENCE_END,
  SHELL_FENCE_START,
  upsertShellFence
} from "../src/adapters/shellrc.js"
import {
  FENCE_END,
  FENCE_START,
  hasUnfencedTable,
  readFencedToml,
  removeFencedToml,
  upsertFencedToml
} from "../src/adapters/toml.js"

/**
 * The three text adapters — Codex's `config.toml`, the instruction Markdown, and the shell rc files — share
 * one fenced-region implementation, so they are tested together and each is asserted to actually use it.
 *
 * The property that matters most is byte-exact reversal: `remove(upsert(text))` must equal `text`, including
 * the blank line `upsert` inserted as a separator. Uninstall's promise is that a config file comes back the
 * way it was found, and a fence that leaves one stray blank line behind breaks the receipt hash on the next
 * doctor run.
 *
 * The malformed cases throw on purpose. A file with a start marker and no end has been hand-edited or is the
 * debris of a killed run, and every guess about where our region ends can delete somebody else's lines.
 */

const TOML_BLOCK = `[mcp_servers.memhtml]
command = "/home/ada/.local/bin/memhtml-mcp"`

const USER_TOML = `model = "gpt-5"

# my own server
[mcp_servers.notes]
command = "notes-mcp"
`

describe("the TOML fence", () => {
  it("appends after a blank line and leaves the operator's file above it untouched", () => {
    const next = upsertFencedToml(USER_TOML, TOML_BLOCK)
    expect(next).toBe(`${USER_TOML}\n${FENCE_START}\n${TOML_BLOCK}\n${FENCE_END}\n`)
  })

  it("creates the file from nothing without a leading blank line", () => {
    expect(upsertFencedToml(null, TOML_BLOCK)).toBe(`${FENCE_START}\n${TOML_BLOCK}\n${FENCE_END}\n`)
    expect(upsertFencedToml("  \n\n", TOML_BLOCK)).toBe(
      `${FENCE_START}\n${TOML_BLOCK}\n${FENCE_END}\n`
    )
  })

  it("replaces the region in place, keeping the lines on both sides", () => {
    const installed = upsertFencedToml(`${USER_TOML}\ntrailing = true\n`, TOML_BLOCK)
    const upgraded = upsertFencedToml(installed, `${TOML_BLOCK}\nargs = []`)
    expect(readFencedToml(upgraded)).toBe(`${TOML_BLOCK}\nargs = []`)
    expect(upgraded).toContain("# my own server")
    expect(upgraded).toContain("trailing = true")
    expect(upgraded.split(FENCE_START).length - 1).toBe(1)
  })

  it("is idempotent, and remove puts the file back byte for byte", () => {
    const once = upsertFencedToml(USER_TOML, TOML_BLOCK)
    expect(upsertFencedToml(once, TOML_BLOCK)).toBe(once)
    expect(removeFencedToml(once)).toBe(USER_TOML)
  })

  it("leaves exactly one blank line when the fence sat between two blocks the operator owns", () => {
    const installed = upsertFencedToml(USER_TOML, TOML_BLOCK)
    const later = '[mcp_servers.later]\ncommand = "later-mcp"\n'
    expect(removeFencedToml(`${installed}\n${later}`)).toBe(`${USER_TOML}\n${later}`)
  })

  it("returns an empty string when the fence was the whole file", () => {
    expect(removeFencedToml(upsertFencedToml(null, TOML_BLOCK))).toBe("")
  })

  it("removes nothing when there is no fence", () => {
    expect(removeFencedToml(USER_TOML)).toBe(USER_TOML)
    expect(removeFencedToml(null)).toBe("")
  })

  it("reads the region back and answers null when there is none", () => {
    expect(readFencedToml(upsertFencedToml(USER_TOML, TOML_BLOCK))).toBe(TOML_BLOCK)
    expect(readFencedToml(USER_TOML)).toBeNull()
    expect(readFencedToml(null)).toBeNull()
  })

  it("keeps an empty body as an empty region rather than a blank line", () => {
    const empty = upsertFencedToml(null, "")
    expect(empty).toBe(`${FENCE_START}\n${FENCE_END}\n`)
    expect(readFencedToml(empty)).toBe("")
  })

  it("throws on a start marker with no end, naming the missing marker", () => {
    const broken = `${USER_TOML}\n${FENCE_START}\n${TOML_BLOCK}\n`
    expect(() => upsertFencedToml(broken, TOML_BLOCK)).toThrow(FENCE_END)
    expect(() => removeFencedToml(broken)).toThrow(FENCE_END)
    expect(() => readFencedToml(broken)).toThrow(FENCE_END)
  })

  it("throws on an end marker with no start", () => {
    expect(() => upsertFencedToml(`${USER_TOML}\n${FENCE_END}\n`, TOML_BLOCK)).toThrow(FENCE_START)
  })

  it("throws on duplicated markers, reporting how many it found", () => {
    const doubled = `${FENCE_START}\na = 1\n${FENCE_END}\n\n${FENCE_START}\nb = 2\n${FENCE_END}\n`
    expect(() => upsertFencedToml(doubled, TOML_BLOCK)).toThrow(/found 2 /)
  })

  it("throws when the end marker precedes the start marker", () => {
    expect(() => upsertFencedToml(`${FENCE_END}\na = 1\n${FENCE_START}\n`, TOML_BLOCK)).toThrow(
      /before/
    )
  })
})

describe("hasUnfencedTable", () => {
  it("finds the operator's own table and its child tables", () => {
    expect(hasUnfencedTable(`[mcp_servers.memhtml]\ncommand = "x"\n`, "mcp_servers.memhtml")).toBe(
      true
    )
    expect(hasUnfencedTable(`[mcp_servers.memhtml.env]\nA = "1"\n`, "mcp_servers.memhtml")).toBe(
      true
    )
    expect(hasUnfencedTable(`[[mcp_servers.memhtml]]\n`, "mcp_servers.memhtml")).toBe(true)
    expect(hasUnfencedTable(`[mcp_servers.memhtml] # mine\n`, "mcp_servers.memhtml")).toBe(true)
    expect(hasUnfencedTable(`  [mcp_servers.memhtml]\n`, "mcp_servers.memhtml")).toBe(true)
  })

  it("does not count our own table inside the fence", () => {
    const installed = upsertFencedToml(USER_TOML, TOML_BLOCK)
    expect(hasUnfencedTable(installed, "mcp_servers.memhtml")).toBe(false)
    expect(hasUnfencedTable(installed, "mcp_servers.notes")).toBe(true)
  })

  it("does not match a different table, a prefix of one, or a commented-out header", () => {
    expect(hasUnfencedTable(USER_TOML, "mcp_servers.memhtml")).toBe(false)
    expect(hasUnfencedTable(`[mcp_servers.memhtmlx]\n`, "mcp_servers.memhtml")).toBe(false)
    expect(hasUnfencedTable(`[mcp_servers]\n`, "mcp_servers.memhtml")).toBe(false)
    expect(hasUnfencedTable(`# [mcp_servers.memhtml]\n`, "mcp_servers.memhtml")).toBe(false)
    expect(hasUnfencedTable(null, "mcp_servers.memhtml")).toBe(false)
  })

  it("still answers on a file whose markers are malformed, since it feeds a refusal message", () => {
    const broken = `${FENCE_START}\n[mcp_servers.memhtml]\n`
    expect(hasUnfencedTable(broken, "mcp_servers.memhtml")).toBe(false)
  })
})

describe("the Markdown block", () => {
  const USER_MD = `# My instructions\n\nAlways run the tests.\n`
  const BODY = "## memhtml\n\nSearch before answering."

  it("round-trips through a file the operator owns", () => {
    const installed = upsertFencedBlock(USER_MD, BODY)
    expect(installed).toBe(`${USER_MD}\n${BLOCK_START}\n${BODY}\n${BLOCK_END}\n`)
    expect(readFencedBlock(installed)).toBe(BODY)
    expect(removeFencedBlock(installed)).toBe(USER_MD)
  })

  it("replaces the block on re-install without touching the prose around it", () => {
    const installed = upsertFencedBlock(`${USER_MD}\n## After\n`, BODY)
    const upgraded = upsertFencedBlock(installed, "## memhtml\n\nNew rules.")
    expect(readFencedBlock(upgraded)).toBe("## memhtml\n\nNew rules.")
    expect(upgraded).toContain("Always run the tests.")
    expect(upgraded).toContain("## After")
    expect(upgraded.split(BLOCK_START).length - 1).toBe(1)
  })

  it("returns an empty string when the block was the whole file, so the caller can delete it", () => {
    expect(removeFencedBlock(upsertFencedBlock(null, BODY))).toBe("")
    expect(removeFencedBlock(upsertFencedBlock("", BODY))).toBe("")
  })

  it("answers null and leaves the file alone when there is no block", () => {
    expect(readFencedBlock(USER_MD)).toBeNull()
    expect(removeFencedBlock(USER_MD)).toBe(USER_MD)
  })

  it("throws on malformed or duplicated markers", () => {
    expect(() => upsertFencedBlock(`${BLOCK_START}\n${BODY}\n`, BODY)).toThrow(BLOCK_END)
    const doubled = `${BLOCK_START}\na\n${BLOCK_END}\n\n${BLOCK_START}\nb\n${BLOCK_END}\n`
    expect(() => readFencedBlock(doubled)).toThrow(/found 2 /)
  })
})

describe("isClaudeImportOnly", () => {
  it("recognizes a CLAUDE.md that is only the AGENTS.md import", () => {
    expect(isClaudeImportOnly("@AGENTS.md")).toBe(true)
    expect(isClaudeImportOnly("@AGENTS.md\n")).toBe(true)
    expect(isClaudeImportOnly("\n\n@AGENTS.md\n\n")).toBe(true)
  })

  it("does not claim a file that carries anything else", () => {
    expect(isClaudeImportOnly("@AGENTS.md\n\nAlso: run the tests.\n")).toBe(false)
    expect(isClaudeImportOnly("# Notes\n\n@AGENTS.md\n")).toBe(false)
    expect(isClaudeImportOnly("@OTHER.md\n")).toBe(false)
    expect(isClaudeImportOnly("")).toBe(false)
    expect(isClaudeImportOnly(null)).toBe(false)
  })
})

describe("the shell rc fence", () => {
  const RC = `export EDITOR=vim\n\nalias ll='ls -l'\n`
  const BODY = 'export MEMHTML_ROOT="/home/ada/memory"'

  it("uses the same markers as the TOML fence, since both files are shell-commented", () => {
    expect(SHELL_FENCE_START).toBe(FENCE_START)
    expect(SHELL_FENCE_END).toBe(FENCE_END)
  })

  it("round-trips and is idempotent", () => {
    const installed = upsertShellFence(RC, BODY)
    expect(installed).toBe(`${RC}\n${SHELL_FENCE_START}\n${BODY}\n${SHELL_FENCE_END}\n`)
    expect(upsertShellFence(installed, BODY)).toBe(installed)
    expect(readShellFence(installed)).toBe(BODY)
    expect(removeShellFence(installed)).toBe(RC)
  })

  it("throws on a half-written fence rather than appending a second one", () => {
    expect(() => upsertShellFence(`${RC}\n${SHELL_FENCE_START}\n${BODY}\n`, BODY)).toThrow(
      SHELL_FENCE_END
    )
  })
})

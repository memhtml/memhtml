import { RECALL_DISCIPLINE } from "@memhtml/contracts/guidance"
import { describe, expect, it } from "vitest"

import { cliCommand, shellJoin } from "../src/command-line.js"
import { renderSkill, SKILL_DIR_NAME } from "../src/render/skill.js"
import type { BinaryLocation } from "../src/types.js"

const BINARY: BinaryLocation = {
  node: "/opt/nodes/24.9.0/bin/node",
  cli: "/opt/memhtml/0.14.0/dist/memhtml.mjs",
  mcp: "/opt/memhtml/0.14.0/dist/memhtml-mcp.mjs",
  version: "0.14.0"
}

const ROOT = "/home/dev/memory"
const CLI = cliCommand(BINARY, false)
const skill = renderSkill({ memhtmlRoot: ROOT, cli: CLI })
const lines = skill.split("\n")

describe("renderSkill frontmatter", () => {
  it("carries name and description, name matching the directory every host enforces", () => {
    expect(SKILL_DIR_NAME).toBe("memhtml")
    expect(lines[0]).toBe("---")
    expect(lines[1]).toBe(`name: ${SKILL_DIR_NAME}`)
    expect(lines[2]).toBe(
      "description: Recall from and write to the memhtml long-term memory store; use before answering " +
        "about past decisions, incidents, people, or preferences, and after learning a durable fact."
    )
    expect(lines[3]).toBe("---")
  })

  it("keeps the description on ONE line and free of a colon-space YAML trap", () => {
    const value = (lines[2] ?? "").slice("description: ".length)
    expect(value.includes(": ")).toBe(false)
    expect(value.startsWith("Recall from and write to")).toBe(true)
    expect(lines[4]).toBe("")
  })
})

describe("renderSkill body", () => {
  it("has the four sections in order", () => {
    const headings = lines.filter((line) => line.startsWith("## "))
    expect(headings).toEqual(["## When to use", "## How", "## Commands", "## Contract"])
  })

  it("names the store and the CLI it was installed with", () => {
    expect(skill).toContain(`\`${ROOT}\``)
    expect(skill).toContain(shellJoin(CLI))
  })

  it("carries every recall-discipline paragraph verbatim, as its own line", () => {
    for (const paragraph of RECALL_DISCIPLINE) {
      expect(lines).toContain(paragraph)
    }
  })

  it("tables six commands, each with a CLI form and its MCP twin", () => {
    const rows = lines.filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    expect(rows).toHaveLength(7) // one header plus six commands
    for (const [form, tool] of [
      ["search", "memory_search"],
      ["recall", "memory_recall"],
      ["read", "memory_read"],
      ["reinforce", "memory_reinforce"],
      ["write", "memory_write"],
      ["correct", "memory_correct"]
    ] as const) {
      const row = rows.find((line) => line.includes(`\`${tool}\``))
      expect(row, tool).toBeDefined()
      expect(row).toContain(`\`${shellJoin(CLI)} ${form}`)
    }
  })

  it("states the envelope contract and points at the manifest for the rest", () => {
    const contract = skill.slice(skill.indexOf("## Contract"))
    expect(contract).toContain("ONE JSON envelope")
    expect(contract).toContain("`code`")
    expect(contract).toContain(`\`${shellJoin(CLI)} manifest\``)
  })
})

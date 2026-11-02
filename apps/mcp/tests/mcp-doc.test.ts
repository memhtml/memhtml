import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Schema } from "effect"
import { Tool } from "effect/ai"
import { describe, expect, it } from "vitest"

import { ToolFailure } from "../src/failure.js"
import { escapeProse, MCP_DOC_PATH, renderMcpDoc, toolLines } from "../src/mcp-doc.js"
import { FileResource, PinnedResource, RESOURCE_TEMPLATES } from "../src/resources.js"
import { MemhtmlToolkit, TOOL_NAMES } from "../src/tools.js"

/** The repo root, three levels up from this file: `apps/mcp/tests` → `memhtml`. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const DOC_PATH = join(REPO_ROOT, MCP_DOC_PATH)

/** One `### …` section of the page: its heading up to the next heading of any level. */
const sectionOf = (doc: string, heading: string): string => {
  const line = `### ${heading}\n`
  const start = doc.indexOf(line)
  if (start === -1) throw new Error(`no section headed ${heading}`)
  const body = start + line.length
  const next = doc.slice(body).search(/^#{2,3} /m)
  return next === -1 ? doc.slice(start) : doc.slice(start, body + next)
}

interface SchemaNode {
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly items?: SchemaNode
  readonly anyOf?: ReadonlyArray<SchemaNode>
}

/** Every property name a parameter schema declares, nested ones included. */
const fieldNames = (node: SchemaNode): ReadonlyArray<string> => [
  ...Object.entries(node.properties ?? {}).flatMap(([name, field]) => [name, ...fieldNames(field)]),
  ...(node.items === undefined ? [] : fieldNames(node.items)),
  ...(node.anyOf ?? []).flatMap(fieldNames)
]

describe("the generated MCP reference page", () => {
  it("is deterministic: two renders are byte-identical", () => {
    // A render carrying a timestamp or the server's version would fail the drift check below on
    // every run, or at every release.
    expect(renderMcpDoc()).toBe(renderMcpDoc())
  })

  it("opens with the line that says it is generated and by what", () => {
    const [first] = renderMcpDoc().split("\n")
    expect(first).toContain("mise run mcp-doc")
    expect(first).toContain("Do not edit by hand")
  })

  it("names every tool, in toolkit order, with its whole published description", () => {
    const doc = renderMcpDoc()
    const at = TOOL_NAMES.map((name) => doc.indexOf(`### \`${name}\`\n`))
    for (const [index, name] of TOOL_NAMES.entries()) expect(at[index], name).toBeGreaterThan(-1)
    expect([...at]).toEqual([...at].sort((a, b) => a - b))
    for (const name of TOOL_NAMES) {
      const description = Tool.getDescription(MemhtmlToolkit.tools[name]) ?? ""
      expect(description.length, name).toBeGreaterThan(40)
      expect(sectionOf(doc, `\`${name}\``)).toContain(escapeProse(description))
    }
  })

  it("lists every parameter each tool's schema declares, nested fields included", () => {
    const doc = renderMcpDoc()
    for (const name of TOOL_NAMES) {
      const section = sectionOf(doc, `\`${name}\``)
      const schema = Tool.getJsonSchema(MemhtmlToolkit.tools[name]) as unknown as SchemaNode
      const names = fieldNames(schema)
      if (names.length === 0) expect(section, name).toContain("No parameters.")
      for (const field of names) expect(section, `${name}.${field}`).toContain(`- \`${field}\``)
    }
    // A required field is marked, and an optional one is not.
    const write = sectionOf(doc, "`memory_write`")
    expect(write).toContain("- `title` (required): `string`.")
    expect(write).toContain("- `body`: `string | null`.")
    // The batch's op fields sit indented under `ops`, since they describe one array element.
    expect(sectionOf(doc, "`memory_write_batch`")).toContain(
      "- `ops` (required): `object[]`.\n  - `title` (required)"
    )
  })

  it("renders a field description wherever the schema carries one", () => {
    /**
     * No toolkit field carries a description today, so this renders a probe tool. An annotation on a
     * required field lands on the field's node, and one on the value inside `Optional(…)` lands on the
     * non-null branch of its `anyOf`; both have to reach the page.
     */
    const probe = Tool.make("probe", {
      description: "A probe tool.",
      parameters: Schema.Struct({
        plain: Schema.String.annotate({ description: "Read as <text>." }),
        optional: Schema.optionalKey(
          Schema.NullOr(Schema.Int.annotate({ description: "Counted from one." }))
        )
      }),
      failure: ToolFailure
    })
    const lines = toolLines(probe)
    expect(lines).toContain("- `plain` (required): `string`. Read as &lt;text>.")
    expect(lines).toContain("- `optional`: `integer | null`. Counted from one.")
  })

  it("refuses a tool whose failure is not ToolFailure, which the Failures section speaks for", () => {
    const undeclared = Tool.make("undeclared", {
      description: "A tool with no declared failure.",
      parameters: Tool.EmptyParams
    })
    expect(() => toolLines(undeclared)).toThrow(/ToolFailure/)
  })

  it("names every resource template with its name, MIME type, and description", () => {
    const doc = renderMcpDoc()
    const templates = [FileResource.template, PinnedResource.template]
    expect(templates.map((template) => template.uriTemplate)).toEqual([...RESOURCE_TEMPLATES])
    for (const template of templates) {
      const section = sectionOf(doc, `\`${template.uriTemplate}\``)
      expect(section).toContain(template.name)
      expect(section).toContain(`\`${template.mimeType}\``)
      expect(section).toContain(escapeProse(template.description ?? ""))
    }
  })

  it("escapes markup outside code spans and leaves code spans alone", () => {
    // A bare `<details>` would fold the rest of the page in a Markdown renderer, and `<YYYY>` would
    // vanish as an unknown tag. Inside a code span the text is already literal.
    expect(escapeProse("a <p> and `<p>` and &lt;p&gt;")).toBe(
      "a &lt;p> and `<p>` and &amp;lt;p&amp;gt;"
    )
    // A run of three backticks closes only at the next run of three, and a lone backtick is text.
    expect(escapeProse("(```ts <x> ```) ` <y>")).toBe("(```ts <x> ```) ` &lt;y>")
  })

  it("matches the committed docs/reference/mcp-tools.md", async () => {
    /**
     * The drift check. The page is rendered from the toolkit and the resources, so a tool, parameter,
     * or description changed without regenerating fails HERE. The fix is one command:
     * `mise run mcp-doc`.
     */
    const committed = await readFile(DOC_PATH, "utf8")
    expect(committed).toBe(renderMcpDoc())
  })
})

#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { Tool } from "effect/ai"

import { reinforcePathsMissing, ToolFailure } from "./failure.js"
import { FileResource, PinnedResource, RESOURCE_TEMPLATES } from "./resources.js"
import { MemhtmlToolkit, TOOL_NAMES } from "./tools.js"

/**
 * `docs/reference/mcp-tools.md`, generated from the server's own definitions.
 *
 * Generated rather than written, for `AGENTS.md`'s reason: a hand-written reference cites the code
 * and goes stale the first time a tool moves. Each tool's description is `Tool.getDescription`, the
 * text `tools/list` publishes, and each parameter list is read from `Tool.getJsonSchema`, so the page
 * and the wire are one reading of one toolkit. `tests/mcp-doc.test.ts` checks the committed page
 * against a fresh render, and `mise run mcp-doc` rewrites it.
 *
 * The rendering is deterministic to the byte: no timestamp, no version (the server's version moves
 * at every release, and a page that named it would drift at every release), and no iteration over
 * anything but the toolkit's and the resources' own declared order.
 */

/** Where the page lives, relative to the repository root that `mise run mcp-doc` runs from. */
export const MCP_DOC_PATH = "docs/reference/mcp-tools.md"

/**
 * Prose as Markdown text: `&` and `<` escaped outside code spans, everything else untouched.
 *
 * The descriptions name markup (`<mark>`, `<details>`, `archive/<YYYY>/`) in running prose, and a
 * Markdown renderer reads a bare tag as HTML: `<details>` would fold the rest of the page and
 * `<YYYY>` would vanish. A code span is already literal, so its contents pass through as they are,
 * and escaping inside one would print the entity. `&` is escaped too, so a description that spells
 * an entity (`&lt;p&gt;`) shows the entity rather than the character it names.
 *
 * A code span follows CommonMark: a run of N backticks opens one, and the next run of exactly N
 * closes it. A run with no closing partner is literal text.
 */
export const escapeProse = (text: string): string => {
  const runs = [...text.matchAll(/`+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length
  }))
  const entities = (plain: string) => plain.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  let out = ""
  let at = 0
  let open = 0
  while (open < runs.length) {
    const opener = runs[open]
    if (opener === undefined) break
    const width = opener.end - opener.start
    const closeAt = runs.findIndex((run, index) => index > open && run.end - run.start === width)
    const closer = runs[closeAt]
    if (closer === undefined) {
      open += 1
      continue
    }
    out += entities(text.slice(at, opener.start)) + text.slice(opener.start, closer.end)
    at = closer.end
    open = closeAt + 1
  }
  return out + entities(text.slice(at))
}

/**
 * The JSON Schema keywords the toolkit's parameter schemas derive.
 *
 * Read through this interface and checked against {@link KEYWORDS}, so a schema that grows a keyword
 * this page does not render (a `$ref`, a `pattern`, a real numeric bound) stops the render rather
 * than reaching the page with the constraint silently dropped.
 */
interface SchemaNode {
  readonly type?: string
  readonly description?: string
  readonly enum?: ReadonlyArray<unknown>
  readonly anyOf?: ReadonlyArray<SchemaNode>
  readonly items?: SchemaNode
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: unknown
  readonly minimum?: number
  readonly maximum?: number
}

const KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "description",
  "enum",
  "anyOf",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "minimum",
  "maximum"
])

/** A node whose every keyword this page renders, or a refusal naming the one it does not. */
const checked = (node: SchemaNode, where: string): SchemaNode => {
  for (const keyword of Object.keys(node)) {
    if (!KEYWORDS.has(keyword)) {
      throw new Error(`${where}: the schema carries \`${keyword}\`, which this page cannot render`)
    }
  }
  // `Schema.Int` derives the safe-integer range, which says "an integer" and nothing more. Any other
  // bound is a constraint a caller has to read, and this page does not render one.
  const bounded =
    (node.minimum !== undefined && node.minimum !== Number.MIN_SAFE_INTEGER) ||
    (node.maximum !== undefined && node.maximum !== Number.MAX_SAFE_INTEGER)
  if (bounded) {
    throw new Error(`${where}: the schema carries a numeric bound this page cannot render`)
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    throw new Error(`${where}: the schema carries an \`additionalProperties\` schema`)
  }
  return node
}

/** A schema as a TypeScript-style type: `string`, `string[] | null`, `"a" | "b"`. */
const typeOf = (node: SchemaNode, where: string): string => {
  const { anyOf, enum: values, items, type } = checked(node, where)
  if (anyOf !== undefined) return anyOf.map((branch) => typeOf(branch, where)).join(" | ")
  if (values !== undefined) return values.map((value) => JSON.stringify(value)).join(" | ")
  if (type === "array") {
    if (items === undefined) throw new Error(`${where}: an array schema names no items`)
    const item = typeOf(items, `${where}[]`)
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`
  }
  if (type === undefined) throw new Error(`${where}: the schema names no type`)
  return type
}

/** The object whose fields a parameter carries: itself, its array items, or a union branch. */
const objectWithin = (node: SchemaNode): SchemaNode | undefined => {
  if (node.properties !== undefined) return node
  if (node.items !== undefined) return objectWithin(node.items)
  for (const branch of node.anyOf ?? []) {
    const found = objectWithin(branch)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * A field's own description, wherever its schema put it.
 *
 * An annotation on the whole field lands on the field's node, and one on the value inside
 * `Optional(…)` lands on the non-null branch of the `anyOf` the wrapper derives. Both are the field's
 * description, so both are read.
 */
const descriptionOf = (field: SchemaNode): string | undefined =>
  field.description ?? field.anyOf?.find((branch) => branch.description !== undefined)?.description

/**
 * An object schema's fields as a Markdown list, nested fields indented under their parent.
 *
 * Every field carries its type and whether it is required; a field the schema describes carries that
 * description too. A field the list does not mark required may be left out.
 */
const fieldLines = (object: SchemaNode, where: string, indent: string): ReadonlyArray<string> => {
  const required = new Set(object.required ?? [])
  return Object.entries(object.properties ?? {}).flatMap(([name, field]) => {
    const at = `${where}.${name}`
    const description = descriptionOf(field)
    const described = description === undefined ? "" : ` ${escapeProse(description)}`
    const line = `${indent}- \`${name}\`${required.has(name) ? " (required)" : ""}: \`${typeOf(field, at)}\`.${described}`
    const nested = objectWithin(field)
    return nested === undefined ? [line] : [line, ...fieldLines(nested, at, `${indent}  `)]
  })
}

/**
 * One tool's section: heading, published description, then its parameters.
 *
 * Exported so a test can render a tool whose fields carry descriptions, which no tool in the toolkit
 * does today.
 */
export const toolLines = (tool: Tool.Any): ReadonlyArray<string> => {
  /**
   * The Failures section speaks for every tool, so a tool declaring anything else would be a tool this
   * page misdescribes. Refused here rather than rendered, since a second failure shape is a change
   * the section's prose has to be rewritten for.
   */
  if (tool.failureSchema !== ToolFailure) {
    throw new Error(`${tool.name}: declares a failure other than ToolFailure`)
  }
  const description = Tool.getDescription(tool)
  if (description === undefined) throw new Error(`${tool.name}: publishes no description`)
  const schema = checked(Tool.getJsonSchema(tool) as unknown as SchemaNode, tool.name)
  const fields = fieldLines(schema, tool.name, "")
  return [
    `### \`${tool.name}\``,
    "",
    escapeProse(description),
    "",
    ...(fields.length === 0 ? ["No parameters."] : ["Parameters:", "", ...fields]),
    ""
  ]
}

/**
 * The resources, in the order `Resources` merges them.
 *
 * Checked against `RESOURCE_TEMPLATES`, the list `tests/resources.test.ts` ties to what the registry
 * publishes, so a resource added to the server and not to this list stops the render.
 */
const RESOURCE_LAYERS = [FileResource, PinnedResource] as const

const resourceLines = (): ReadonlyArray<string> => {
  const templates = RESOURCE_LAYERS.map((layer) => layer.template)
  const listed = templates.map((template) => template.uriTemplate)
  if (listed.join("\n") !== RESOURCE_TEMPLATES.join("\n")) {
    throw new Error("the page's resource list disagrees with RESOURCE_TEMPLATES")
  }
  return templates.flatMap((template) => [
    `### \`${template.uriTemplate}\``,
    "",
    template.mimeType === undefined
      ? `${template.name}.`
      : `${template.name}, \`${template.mimeType}\`.`,
    "",
    ...(template.description === undefined ? [] : [escapeProse(template.description), ""])
  ])
}

/** The whole page, as bytes. */
export const renderMcpDoc = (): string => {
  const tools = TOOL_NAMES.map((name) => MemhtmlToolkit.tools[name])
  const lines: Array<string> = []

  lines.push("<!-- Generated by `mise run mcp-doc` from `apps/mcp/src`. Do not edit by hand. -->")
  lines.push("")
  lines.push("# `memhtml-mcp` tools and resources")
  lines.push("")
  lines.push(
    `\`memhtml-mcp\` serves a memhtml repository over MCP on stdio. It publishes ${tools.length} tools and ${RESOURCE_LAYERS.length} resource templates, and this page is rendered from those definitions. Each description is the text the server publishes, with \`&\` and \`<\` escaped so the markup it names reads as text. Each parameter list is read from the input schema \`tools/list\` publishes for that tool, and a parameter not marked required may be left out. A failed call is described once, under [Failures](#failures).`
  )
  lines.push("")
  lines.push("## Tools")
  lines.push("")
  lines.push("In the order `tools/list` returns them:")
  lines.push("")
  for (const tool of tools) lines.push(`- [\`${tool.name}\`](#${tool.name})`)
  lines.push("")
  for (const tool of tools) lines.push(...toolLines(tool))

  lines.push("## Failures")
  lines.push("")
  lines.push(
    "Every tool declares `ToolFailure` as its failure, and no tool declares a narrower set of codes. A refused call returns a tool result with `isError: true` and one text block. The block starts with a stable `ERR_*` code and a colon, then gives the reason and, after `Try:`, the calls that can recover. Branch on the code, never on the prose after it. The codes come from the vocabulary the CLI publishes, listed under Error codes in [AGENTS.md](../../AGENTS.md)."
  )
  lines.push("")
  lines.push("For example, a `memory_reinforce` call that names no path answers with:")
  lines.push("")
  lines.push("```text")
  lines.push(reinforcePathsMissing().message)
  lines.push("```")
  lines.push("")

  lines.push("## Resources")
  lines.push("")
  lines.push(
    "Each template is listed with the name and MIME type `resources/templates/list` publishes for it. A failed read is a JSON-RPC error whose message has the same shape as a tool failure's text."
  )
  lines.push("")
  lines.push(...resourceLines())

  // One trailing newline, not two: the last section ends with a blank line already.
  while (lines.at(-1) === "") lines.pop()
  return `${lines.join("\n")}\n`
}

/**
 * Write the page when it differs from a fresh render, and say which happened.
 *
 * One JSON object on stdout, like `gen-fixture`, so a second run reads `"written": false` and shows
 * the render is stable. The path resolves from the working directory, which `mise run` sets to the
 * repository root.
 */
const main = async (): Promise<void> => {
  const path = resolve(MCP_DOC_PATH)
  const rendered = renderMcpDoc()
  const existing = await readFile(path, "utf8").catch(() => null)
  const written = existing !== rendered
  if (written) await writeFile(path, rendered, "utf8")
  process.stdout.write(
    `${JSON.stringify({ path: MCP_DOC_PATH, bytes: Buffer.byteLength(rendered), written })}\n`
  )
}

// Guarded so a test can import the renderer without writing the page as a side effect.
if (import.meta.main) await main()

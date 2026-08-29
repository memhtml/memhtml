import { describe, expect, it } from "vitest"

import { commandSlug, referencePages, TIER } from "../src/loaders/pages.js"
import { collectRegistry } from "../src/loaders/registry.js"
import { mdxExpressions } from "./mdx-braces.js"

/**
 * Census probes over the generated Reference tier.
 *
 * Every expectation is a total DERIVED from the registry and compared against the rendered page —
 * never a number copied out of a build log. A probe that asserted `36` would pass forever after the
 * thirty-seventh command silently stopped being documented.
 *
 * The rendered side is counted off the Markdown body rather than off the data structure that built
 * it, so a page that assembles a row and then drops it is a failure here.
 */

const registry = collectRegistry()
const pages = referencePages(registry, { base: "/memhtml" })

const page = (id: string) => {
  const found = pages.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no page \`${id}\` — generated: ${pages.map((p) => p.id).join(", ")}`)
  return found
}

/**
 * Every DATA row of every Markdown table on a page.
 *
 * A header is the line immediately above a separator, so both drop out and what is left is the rows
 * a reader counts.
 */
const tableRows = (body: string): ReadonlyArray<string> => {
  const lines = body.split("\n")
  const isSeparator = (line: string | undefined): boolean =>
    line !== undefined && /^\|(\s*---\s*\|)+$/.test(line)
  return lines.filter(
    (line, at) => line.startsWith("|") && !isSeparator(line) && !isSeparator(lines[at + 1])
  )
}

const rowsMentioning = (body: string, values: ReadonlyArray<string>): number =>
  tableRows(body).filter((row) => values.some((value) => row.includes(`\`${value}\``))).length

/**
 * Page text and registry text on one footing.
 *
 * A page escapes `<` and promotes a bare flag to a code span, both of which change bytes the
 * registry wrote plainly. Undoing exactly those two transformations here — rather than calling the
 * page's own helper — keeps the comparison independent of the code under test.
 */
const flatten = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&amp;", "&").replaceAll("`", "")

/**
 * The ledger fields a stray brace could have come from, as `KEY.field: text`.
 *
 * The requirements page puts `sentence` and `verificationNote` through `cell`, which escapes `&` and
 * `<` and nothing else, so a brace in the ledger reaches the MDX verbatim. EVERY string field is
 * walked rather than those two by name, so a field added to `Requirement` is attributed at the commit
 * that adds it instead of arriving as an unexplained build error.
 */
const bracedLedgerFields = (source: typeof registry): ReadonlyArray<string> =>
  source.requirements.flatMap((requirement) =>
    Object.entries(requirement)
      .filter(([, value]) => typeof value === "string" && value.includes("{"))
      .map(([field, value]) => `${requirement.key}.${field}: ${String(value)}`)
  )

describe("every registry member reaches a page", () => {
  it("gives each command its own page", () => {
    const commandPages = pages.filter((one) => one.id.startsWith(`${TIER}/commands/`))
    expect(commandPages).toHaveLength(registry.commands.length)
    expect(commandPages.map((one) => one.id).sort()).toEqual(
      registry.commands.map((command) => `${TIER}/commands/${commandSlug(command.name)}`).sort()
    )
  })

  it("gives each guide topic its own page, plus an index", () => {
    const topicPages = pages.filter((one) => one.id.startsWith(`${TIER}/guide/`))
    expect(topicPages).toHaveLength(registry.guide.length)
    expect(topicPages.map((one) => one.id).sort()).toEqual(
      registry.guide.map((block) => `${TIER}/guide/${block.topic}`).sort()
    )
    expect(page(`${TIER}/guide`).body).toContain("| Topic |")
  })

  it("lists every global flag", () => {
    const body = page(`${TIER}/global-flags`).body
    expect(tableRows(body)).toHaveLength(registry.globalFlags.length)
    for (const flag of registry.globalFlags) expect(body).toContain(`\`--${flag.name}\``)
  })

  it("lists every response type once", () => {
    const body = page(`${TIER}/response-types`).body
    expect(tableRows(body)).toHaveLength(registry.responseTypes.length)
    expect(rowsMentioning(body, registry.responseTypes)).toBe(registry.responseTypes.length)
  })

  it("lists every error code once", () => {
    const body = page(`${TIER}/error-codes`).body
    expect(tableRows(body)).toHaveLength(registry.errorCodes.length)
    expect(
      rowsMentioning(
        body,
        registry.errorCodes.map((row) => row.code)
      )
    ).toBe(registry.errorCodes.length)
  })

  it("lists every environment variable once", () => {
    const body = page(`${TIER}/config`).body
    expect(tableRows(body)).toHaveLength(registry.configVars.length)
    for (const variable of registry.configVars) expect(body).toContain(`\`${variable.name}\``)
  })

  it("gives every MCP tool a numbered subsection carrying its published description", () => {
    const body = page(`${TIER}/mcp-tools`).body
    const subsections = body.split("\n").filter((line) => line.startsWith("### "))
    expect(subsections).toHaveLength(registry.mcpTools.length)
    // Registration order is the reading order the toolkit publishes; the page preserves it.
    expect(subsections.map((line) => line.replace(/^### \d+\.\d+\. | \{.*$/g, ""))).toEqual(
      registry.mcpTools.map((tool) => tool.name)
    )
    for (const tool of registry.mcpTools) {
      expect(flatten(body)).toContain(flatten(tool.description).slice(0, 80))
    }
  })

  it("lists every MCP resource template", () => {
    const body = page(`${TIER}/mcp-resources`).body
    expect(tableRows(body)).toHaveLength(registry.mcpResources.length)
    for (const resource of registry.mcpResources) expect(body).toContain(resource.template)
  })

  it("lists every vocabulary and every value in it", () => {
    const body = page(`${TIER}/vocabulary`).body
    expect(tableRows(body)).toHaveLength(registry.vocabularies.length)
    expect(body.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(
      // One section per vocabulary, plus the summary and the provenance.
      registry.vocabularies.length + 2
    )
    for (const vocabulary of registry.vocabularies) {
      for (const value of vocabulary.values) expect(body).toContain(`\`${value}\``)
    }
  })

  it("lists every sleep phase in execution order", () => {
    const body = page(`${TIER}/sleep-phases`).body
    expect(tableRows(body)).toHaveLength(registry.sleepPhases.length)
    const order = tableRows(body).map((row) => row.split("|")[2]?.trim() ?? "")
    expect(order).toEqual(registry.sleepPhases.map((phase) => `\`${phase.name}\``))
  })

  it("lists every RRF arm with its weight", () => {
    const body = page(`${TIER}/rrf-arms`).body
    expect(tableRows(body)).toHaveLength(registry.rankArms.length)
    expect(body.split("\n").filter((line) => line.startsWith("### "))).toHaveLength(
      registry.rankArms.length
    )
    for (const arm of registry.rankArms) expect(body).toContain(`\`${arm.weight}\``)
  })

  it("gives every migration a subsection and states the objects it creates", () => {
    const body = page(`${TIER}/schema`).body
    expect(body.split("\n").filter((line) => line.startsWith("### "))).toHaveLength(
      registry.migrations.length
    )
    for (const migration of registry.migrations) {
      expect(body).toContain(`\`${migration.file}\``)
      for (const created of migration.creates) expect(body).toContain(`\`${created}\``)
    }
  })

  it("lists every requirement under its own prefix", () => {
    const body = page(`${TIER}/requirements`).body
    const prefixes = new Set(registry.requirements.map((requirement) => requirement.prefix))
    expect(body.split("\n").filter((line) => line.startsWith("### "))).toHaveLength(prefixes.size)
    for (const requirement of registry.requirements) {
      expect(body).toContain(`\`${requirement.key}\``)
    }
    // Each requirement is a row exactly once across the per-prefix tables.
    const keyRows = tableRows(body).filter((row) =>
      registry.requirements.some((requirement) => row.startsWith(`| \`${requirement.key}\``))
    )
    expect(keyRows).toHaveLength(registry.requirements.length)
  })

  it("lists every workspace package twice: once described, once for its imports", () => {
    const body = page(`${TIER}/packages`).body
    expect(tableRows(body)).toHaveLength(registry.packages.length * 2)
    for (const entry of registry.packages) expect(body).toContain(`\`${entry.name}\``)
  })

  it("counts every registry on the overview, and links each page that has one", () => {
    const body = page(TIER).body
    expect(tableRows(body)).toHaveLength(registry.commands.length + 14)
    for (const command of registry.commands) {
      expect(body).toContain(`/memhtml/${TIER}/commands/${commandSlug(command.name)}/`)
    }
  })
})

describe("the pages themselves", () => {
  it("gives every page a non-empty filePath inside the docs collection", () => {
    for (const one of pages) {
      expect(one.filePath.length).toBeGreaterThan(0)
      expect(one.filePath.startsWith("src/content/docs/")).toBe(true)
      expect(one.filePath.endsWith(".md")).toBe(true)
    }
  })

  it("keeps ids and file paths unique", () => {
    expect(new Set(pages.map((one) => one.id)).size).toBe(pages.length)
    expect(new Set(pages.map((one) => one.filePath)).size).toBe(pages.length)
  })

  it("gives every page a title, a description, and a body", () => {
    for (const one of pages) {
      expect(one.title.length).toBeGreaterThan(0)
      expect(one.description.length).toBeGreaterThan(0)
      expect(one.body.length).toBeGreaterThan(0)
    }
  })

  it("numbers top-level sections from one, in order, in the heading text", () => {
    for (const one of pages) {
      const headings = one.body.split("\n").filter((line) => line.startsWith("## "))
      expect(headings.length).toBeGreaterThan(1)
      expect(headings.map((heading) => heading.split(" ")[1])).toEqual(
        headings.map((_, at) => `${at + 1}.`)
      )
    }
  })

  /*
   * A brace anchor would be the better convention — it survives a renumbering without churning
   * inbound links — and it is nonetheless forbidden here, along with every other brace outside a code
   * span. `starlight-md-txt` parses every page's raw body through `remark-mdx`, where a brace opens a
   * JSX expression, so one anywhere fails the whole raw-Markdown route. Those routes are this site's
   * agent surface, so they win.
   *
   * Scoped to the brace rather than to the `{ #anchor }` spelling, because acorn refuses every value
   * that is not an expression and a page assembles prose from registries this file does not enumerate.
   * A page body is what `remark-mdx` receives, so this reads the same bytes the build parses.
   */
  it("writes no MDX expression, which would break the raw Markdown route", () => {
    for (const one of pages) {
      expect(
        mdxExpressions(one.body),
        `${one.id} — braced source fields: ${
          bracedLedgerFields(registry).join(" | ") || "none in the spec ledger"
        }`
      ).toEqual([])
    }
  })

  it("names the registry it came from on every page", () => {
    for (const one of pages) {
      expect(one.body).toContain("Provenance")
      expect(one.body).toContain(one.source.split(",")[0] ?? one.source)
    }
  })

  it("mounts no raw HTML element from the memory file format", () => {
    for (const one of pages) {
      // Escaping happens outside code spans only, so the check is on the spans that remain.
      const outsideCode = one.body.replace(/`+[^`]*`+/g, "")
      expect(outsideCode).not.toMatch(/<(article|mark|time|link|meta|p|li|figure)\b/)
    }
  })
})

/*
 * The requirements page is the one generated page whose prose comes from a JSON ledger rather than
 * from a doc comment, and `spec/memhtml.symspec.json` is edited by hand. A brace in a `sentence` or a
 * `verificationNote` therefore reaches `remark-mdx` verbatim and fails `astro build` with acorn's own
 * message, which names no requirement and no field. The case above catches the brace; these two are
 * what turn it into an answer — the first states the ledger is clean and prints every braced field it
 * holds, the second proves the pair actually bites on a synthetic entry rather than passing vacuously.
 */
describe("a braced value in the spec ledger fails as a probe rather than as an acorn error", () => {
  const requirementsOf = (source: typeof registry) => {
    const generated = referencePages(source, { base: "/memhtml" }).find(
      (candidate) => candidate.id === `${TIER}/requirements`
    )
    if (!generated) throw new Error(`no \`${TIER}/requirements\` page`)
    return generated.body
  }

  it("holds for the ledger on disk, and reports the fields a brace could come from", () => {
    const braced = bracedLedgerFields(registry)
    expect(
      mdxExpressions(requirementsOf(registry)),
      `braced ledger fields: ${braced.join(" | ") || "none"}`
    ).toEqual([])
  })

  /*
   * The negative control, and the reason this file can call the case above a lock. `referencePages` is
   * a pure function of a registry, so the poison is a synthetic requirement rather than a temporary
   * edit to the ledger — nothing on disk moves, and the control cannot rot away from the gate it
   * verifies because both read the same two helpers.
   */
  it("names the requirement key and the offending text when a ledger entry carries a brace", () => {
    const poisoned = {
      ...registry,
      requirements: [
        ...registry.requirements,
        {
          key: "ENT-1",
          prefix: "ENT",
          sentence:
            "While MEMHTML_EXTRACT_ENTITIES is on, memhtml shall extract entities on write.",
          status: "implemented",
          priority: "should",
          patternType: "state-driven",
          verificationMethod: "test",
          verificationNote: "the port resolves to { extractor: undefined } when the flag is off",
          systemName: "memhtml"
        }
      ]
    }
    const strays = mdxExpressions(requirementsOf(poisoned))
    expect(strays.length).toBeGreaterThan(0)
    expect(strays.join(" ")).toContain("{ extractor: undefined }")
    // Found by key rather than by position: the attribution names whatever the ledger holds, so a
    // real braced field arriving later must not turn this control's own subject into an index.
    const attribution = bracedLedgerFields(poisoned).find((entry) => entry.startsWith("ENT-1."))
    expect(attribution).toBeDefined()
    expect(attribution).toContain("verificationNote")
    expect(attribution).toContain("{ extractor: undefined }")
  })

  /*
   * And the escape hatch is real: the same text inside a code span is leaf content `remark-mdx` never
   * parses, so an author with a braced value to document has somewhere to put it. Without this case
   * the pair above would be satisfied by a probe that simply refused every brace, including the ones
   * the build accepts.
   */
  it("accepts the same value inside a code span, which is where a braced value belongs", () => {
    const quoted = {
      ...registry,
      requirements: [
        ...registry.requirements,
        {
          key: "ENT-2",
          prefix: "ENT",
          sentence: "While MEMHTML_EXTRACT_ENTITIES is off, memhtml shall write nothing extra.",
          status: "implemented",
          priority: "should",
          patternType: "state-driven",
          verificationMethod: "test",
          verificationNote: "the port resolves to `{ extractor: undefined }` when the flag is off",
          systemName: "memhtml"
        }
      ]
    }
    expect(mdxExpressions(requirementsOf(quoted))).toEqual([])
  })
})

describe("the registries agree with each other", () => {
  it("keeps `write --type`'s vocabulary the full storage set, `arc` included (issue #88)", () => {
    /**
     * The operator surface admits every storage type: `memhtml write --type arc` is the door for
     * curated import and deliberately authored rules. The narrow vocabulary is the AGENT surface's,
     * and it lives in `memory_write`'s schema (`WritableType`, apps/mcp/src/tools.ts), pinned by
     * that package's own tests — restating it here against the CLI flag was the pre-#88 invariant.
     */
    const vocabulary = registry.vocabularies.find((one) => one.name === "MEMORY_TYPES")
    const writable = registry.commands
      .find((command) => command.name === "write")
      ?.flags.find((flag) => flag.name === "type")?.values
    expect(writable).toBeDefined()
    expect([...(writable ?? [])]).toEqual([...(vocabulary?.values ?? [])])
  })

  it("keeps `serve mcp`'s own summary honest about the surface it serves", () => {
    const summary = registry.commands.find((command) => command.name === "serve mcp")?.summary ?? ""
    expect(summary).toContain(`${registry.mcpTools.length} tools`)
    expect(summary).toContain(`${registry.mcpResources.length} resources`)
  })

  it("keeps `sleep run`'s own summary honest about the phase count", () => {
    const summary = registry.commands.find((command) => command.name === "sleep run")?.summary ?? ""
    expect(summary).toContain(`${registry.sleepPhases.length} phases`)
  })

  it("derives each command's further reading from the guide's own prose", () => {
    for (const command of registry.commands) {
      // Independently recomputed here: a topic covers a command when its body names the invocation.
      const expected = registry.guide
        .filter((block) => {
          const at = block.body.indexOf(`memhtml ${command.name}`)
          if (at < 0) return false
          const next = block.body.charAt(at + `memhtml ${command.name}`.length)
          return !/[\w-]/.test(next)
        })
        .map((block) => block.topic)
      const body = page(`${TIER}/commands/${commandSlug(command.name)}`).body
      for (const topic of expected) expect(body).toContain(`${TIER}/guide/${topic}/`)
      if (expected.length === 0) expect(body).toContain("No guide block names this command")
    }
  })

  it("falls back to the topic index for most commands, because there are few blocks", () => {
    const withoutGuide = registry.commands.filter((command) =>
      page(`${TIER}/commands/${commandSlug(command.name)}`).body.includes(
        "No guide block names this command"
      )
    )
    expect(withoutGuide.length).toBeGreaterThan(registry.commands.length / 2)
  })
})

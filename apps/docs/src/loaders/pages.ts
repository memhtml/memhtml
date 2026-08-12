import type { ArgSpec, CommandSpec, FlagSpec } from "@memhtml/cli"

import {
  bullets,
  cell,
  code,
  codeList,
  fence,
  inlineText,
  paragraphs,
  type Section,
  sections,
  table
} from "./markdown.js"
import { type Registry, SOURCES } from "./registry.js"

/**
 * The Reference tier: one page per registry member, as a pure function of the registry.
 *
 * Pure and total on purpose. Pure, so a test can append a synthetic member to a registry and assert
 * the page count moves — a page that can only be counted after a site build is a page no unit test
 * locks. Total, so every member of every registry reaches a page: the loader stores exactly what
 * this returns, and `store.set` is the only place a page can be lost.
 *
 * No quantity is ever written as a literal. Where prose needs a count it reads `length`, which is why
 * adding a command cannot leave a sentence claiming there are the previous number of them.
 */

/** One virtual page, ready for the content store. */
export interface ReferencePage {
  /** The entry id, which is also the URL path under the site base. */
  readonly id: string
  readonly title: string
  readonly description: string
  /** The repo-relative registry this page is derived from. Stated on the page. */
  readonly source: string
  /** The Markdown body, RFC-numbered. */
  readonly body: string
  /**
   * The path the entry claims, relative to the Astro project root.
   *
   * MANDATORY: the content layer throws a `TypeError` on an entry without one, and Starlight reads
   * it for breadcrumbs and for the `autogenerate` sidebar tree, which both work on the path relative
   * to `src/content/docs`. No such file exists — the shape is what carries the meaning.
   */
  readonly filePath: string
  /** The newest commit of the registry behind the page, when git can answer. */
  readonly lastUpdated: Date | undefined
}

/** Where in the site the tier lives. One constant, so a move is one edit. */
export const TIER = "reference"

const DOCS_COLLECTION = "src/content/docs"

/** A command's slug: `task add` is one page, `task-add`. */
export const commandSlug = (name: string): string => name.replaceAll(" ", "-")

const pageLink = (base: string, id: string, label: string): string =>
  `[${label}](${base.replace(/\/$/, "")}/${id}/)`

const flagType = (flag: FlagSpec): string =>
  flag.type === "boolean" ? "flag" : flag.type === "int" ? "integer" : "string"

const flagDefault = (flag: FlagSpec): string =>
  flag.default === undefined || flag.default === "" ? "—" : code(String(flag.default))

const synopsisFlag = (flag: FlagSpec): string =>
  flag.type === "boolean" ? `--${flag.name}` : `--${flag.name} <${flag.type}>`

const synopsisArg = (arg: ArgSpec): string => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)

const synopsis = (command: CommandSpec): string => {
  const required = command.flags.filter((flag) => flag.required === true).map(synopsisFlag)
  const optional = command.flags.some((flag) => flag.required !== true) ? ["[options]"] : []
  return ["memhtml", command.name, ...command.args.map(synopsisArg), ...required, ...optional].join(
    " "
  )
}

const argumentSection = (command: CommandSpec): Section => ({
  title: "Arguments",
  body:
    command.args.length === 0
      ? "This command takes no positional arguments."
      : table(
          ["Argument", "Required", "Description"],
          command.args.map((arg) => [
            code(arg.name),
            arg.required ? "yes" : "no",
            cell(arg.description)
          ])
        )
})

const flagSection = (command: CommandSpec, base: string): Section => ({
  title: "Flags",
  body: [
    command.flags.length === 0
      ? "This command takes no flags of its own."
      : table(
          ["Flag", "Type", "Default", "Values", "Description"],
          command.flags.map((flag) => [
            code(`--${flag.name}`),
            flagType(flag) + (flag.repeatable === true ? ", repeatable" : ""),
            flagDefault(flag),
            flag.values === undefined ? "—" : codeList([...flag.values]),
            cell(flag.description) + (flag.required === true ? " **Required.**" : "")
          ])
        ),
    `Every command additionally accepts the ${pageLink(base, `${TIER}/global-flags`, "global flags")}.`
  ].join("\n\n")
})

const responseSection = (command: CommandSpec, base: string): Section => ({
  title: "Response",
  body: [
    `One JSON envelope on stdout, whose ${code("type")} is ${codeList([...command.responseTypes])}.`,
    `See ${pageLink(base, `${TIER}/envelope`, "the JSON envelope")} for the envelope's own shape, ${pageLink(base, `${TIER}/response-types`, "response types")} for the whole discriminator vocabulary, and ${pageLink(base, `${TIER}/error-codes`, "error codes")} for what a failure carries.`
  ].join("\n\n")
})

/**
 * The guide blocks that cover a command, read out of the guide's own prose.
 *
 * A mapping table maintained beside the guide would be a second statement of the same fact and would
 * drift on the first rewrite. A block covers a command when it names the invocation. There are far
 * more commands than blocks, so most commands match nothing and fall back to the topic index — that
 * is the normal case, not a gap.
 */
const topicsCovering = (registry: Registry, name: string): ReadonlyArray<string> => {
  const invocation = new RegExp(`memhtml ${name.replaceAll(" ", "\\s")}(?![\\w-])`)
  return registry.guide.filter((block) => invocation.test(block.body)).map((block) => block.topic)
}

const furtherReadingSection = (registry: Registry, command: CommandSpec, base: string): Section => {
  const topics = topicsCovering(registry, command.name)
  return {
    title: "Further reading",
    anchor: "further-reading",
    body:
      topics.length === 0
        ? `No guide block names this command. The ${pageLink(base, `${TIER}/guide`, "guide")} is the workflow prose an agent reads before the command table means anything.`
        : [
            "The guide blocks that name this command:",
            bullets(topics.map((topic) => pageLink(base, `${TIER}/guide/${topic}`, code(topic))))
          ].join("\n\n")
  }
}

const provenance = (source: string, what: string): Section => ({
  title: "Provenance",
  body: `This page is derived from ${code(source)} at build time and has no file of its own: ${what} Change the registry and the page changes with it.`
})

const commandPage = (registry: Registry, command: CommandSpec, base: string): ReferencePage => ({
  id: `${TIER}/commands/${commandSlug(command.name)}`,
  title: `memhtml ${command.name}`,
  description: command.summary,
  source: SOURCES.commands,
  filePath: `${DOCS_COLLECTION}/${TIER}/commands/${commandSlug(command.name)}.md`,
  lastUpdated: registry.commitDates.commands,
  body: sections([
    {
      title: "Synopsis",
      body: [inlineText(command.summary), fence("sh", synopsis(command))].join("\n\n")
    },
    argumentSection(command),
    flagSection(command, base),
    responseSection(command, base),
    furtherReadingSection(registry, command, base),
    provenance(
      SOURCES.commands,
      `the ${code("COMMANDS")} array there is the one source of argument parsing, of ${code("memhtml manifest")}, and of ${code("AGENTS.md")}.`
    )
  ])
})

const overviewPage = (registry: Registry, base: string): ReferencePage => {
  const census: ReadonlyArray<readonly [string, string, number, string]> = [
    [`${TIER}/commands/…`, "Commands", registry.commands.length, SOURCES.commands],
    [`${TIER}/global-flags`, "Global flags", registry.globalFlags.length, SOURCES.commands],
    [`${TIER}/guide`, "Guide topics", registry.guide.length, SOURCES.commands],
    [`${TIER}/response-types`, "Response types", registry.responseTypes.length, SOURCES.envelope],
    [`${TIER}/error-codes`, "Error codes", registry.errorCodes.length, SOURCES.envelope],
    [`${TIER}/config`, "Environment variables", registry.configVars.length, SOURCES.config],
    [`${TIER}/mcp-tools`, "MCP tools", registry.mcpTools.length, SOURCES.mcpTools],
    [`${TIER}/mcp-resources`, "MCP resources", registry.mcpResources.length, SOURCES.mcpResources],
    [
      `${TIER}/vocabulary`,
      "Closed vocabularies",
      registry.vocabularies.length,
      `${SOURCES.types}, ${SOURCES.edges}`
    ],
    [`${TIER}/sleep-phases`, "Sleep phases", registry.sleepPhases.length, SOURCES.sleep],
    [`${TIER}/rrf-arms`, "RRF arms", registry.rankArms.length, SOURCES.retrieval],
    [`${TIER}/schema`, "Migrations", registry.migrations.length, SOURCES.migrations],
    [`${TIER}/requirements`, "Requirements", registry.requirements.length, SOURCES.symspec],
    [`${TIER}/packages`, "Workspace packages", registry.packages.length, "apps/, packages/"]
  ]
  return {
    id: TIER,
    title: "Reference",
    description: "Every command, code, vocabulary, and requirement, generated from its registry.",
    source: SOURCES.commands,
    filePath: `${DOCS_COLLECTION}/${TIER}/index.md`,
    lastUpdated: registry.commitDates.commands,
    body: sections([
      {
        title: "What this tier is",
        anchor: "what-this-tier-is",
        body: [
          "Every page here is generated at build time from the registry that defines the thing it documents, and no page exists as a file in the repository. A count on one of these pages is the length of an array in the source, so a page cannot claim a surface the binary does not have.",
          "The registries and their sizes:",
          table(
            ["Page", "Registry", "Members", "Source"],
            census.map(([id, label, count, source]) => [
              id.endsWith("…") ? code(id) : pageLink(base, id, label),
              cell(label),
              String(count),
              code(source)
            ])
          )
        ].join("\n\n")
      },
      {
        title: "The commands",
        body: [
          `${code("memhtml")} accepts ${registry.commands.length} commands. Each has its own page.`,
          table(
            ["Command", "Summary"],
            registry.commands.map((command) => [
              pageLink(
                base,
                `${TIER}/commands/${commandSlug(command.name)}`,
                code(`memhtml ${command.name}`)
              ),
              cell(command.summary)
            ])
          )
        ].join("\n\n")
      },
      {
        title: "How a command surface is described",
        anchor: "how-a-command-is-described",
        body: paragraphs(registry.prose.commands ?? "")
      },
      provenance(
        SOURCES.commands,
        "a content-layer loader injects these pages into the docs collection, so `autogenerate` and Pagefind see them as ordinary pages."
      )
    ])
  }
}

const globalFlagsPage = (registry: Registry, base: string): ReferencePage => ({
  id: `${TIER}/global-flags`,
  title: "Global flags",
  description: "The flags every command accepts, whatever it does.",
  source: SOURCES.commands,
  filePath: `${DOCS_COLLECTION}/${TIER}/global-flags.md`,
  lastUpdated: registry.commitDates.commands,
  body: sections([
    { title: "Why they are listed once", body: paragraphs(registry.prose.globalFlags ?? "") },
    {
      title: "The flags",
      body: table(
        ["Flag", "Type", "Default", "Description"],
        registry.globalFlags.map((flag) => [
          code(`--${flag.name}`),
          flagType(flag),
          flagDefault(flag),
          cell(flag.description)
        ])
      )
    },
    {
      title: "Where they apply",
      body: `All ${registry.commands.length} ${pageLink(base, TIER, "commands")} accept every flag above.`
    },
    provenance(
      SOURCES.commands,
      `${code("GLOBAL_FLAGS")} is folded into every command's parse and into ${code("memhtml manifest")}.`
    )
  ])
})

const guideIndexPage = (registry: Registry, base: string): ReferencePage => ({
  id: `${TIER}/guide`,
  title: "The guide",
  description: "The workflow prose the CLI publishes to an agent before it has written anything.",
  source: SOURCES.commands,
  filePath: `${DOCS_COLLECTION}/${TIER}/guide/index.md`,
  lastUpdated: registry.commitDates.commands,
  body: sections([
    { title: "What the guide is", body: paragraphs(registry.prose.guide ?? "") },
    {
      title: "The topics",
      body: table(
        ["Topic", "Commands it names"],
        registry.guide.map((block) => [
          pageLink(base, `${TIER}/guide/${block.topic}`, code(block.topic)),
          codeList(
            registry.commands
              .filter((command) => topicsCovering(registry, command.name).includes(block.topic))
              .map((command) => `memhtml ${command.name}`)
          )
        ])
      )
    },
    provenance(
      SOURCES.commands,
      `${code("GUIDE")} is what a bare ${code("memhtml")}, ${code("memhtml help")}, and ${code("memhtml manifest")} return, and what ${code("AGENTS.md")} renders.`
    )
  ])
})

/**
 * One guide block, verbatim.
 *
 * The JSONL example is lifted into a fenced block: it is a constant the guide interpolates and a
 * test in `apps/cli` parses, so a reader has to be able to copy it exactly, and inline prose would
 * let Markdown reflow the bytes.
 */
const guideTopicPage = (
  registry: Registry,
  block: { readonly topic: string; readonly body: string },
  base: string
): ReferencePage => {
  const parts = block.body.split(registry.guideOpExample)
  const rendered = parts
    .map((part) => paragraphs(part))
    .join(`\n\n${fence("json", registry.guideOpExample)}\n\n`)
  const covered = registry.commands.filter((command) =>
    topicsCovering(registry, command.name).includes(block.topic)
  )
  return {
    id: `${TIER}/guide/${block.topic}`,
    title: block.topic,
    description: `The ${block.topic} block of the CLI's guide.`,
    source: SOURCES.commands,
    filePath: `${DOCS_COLLECTION}/${TIER}/guide/${block.topic}.md`,
    lastUpdated: registry.commitDates.commands,
    body: sections([
      { title: "The block", body: rendered },
      {
        title: "Commands it names",
        body:
          covered.length === 0
            ? "This block names no command directly."
            : bullets(
                covered.map((command) =>
                  pageLink(
                    base,
                    `${TIER}/commands/${commandSlug(command.name)}`,
                    code(`memhtml ${command.name}`)
                  )
                )
              )
      },
      provenance(
        SOURCES.commands,
        `the block is authored beside ${code("COMMANDS")} and is served verbatim by ${code("memhtml manifest")}, so this page and the live answer are the same bytes.`
      )
    ])
  }
}

const envelopePage = (registry: Registry, base: string): ReferencePage => ({
  id: `${TIER}/envelope`,
  title: "The JSON envelope",
  description: "One envelope per command on stdout, and nothing else.",
  source: SOURCES.envelope,
  filePath: `${DOCS_COLLECTION}/${TIER}/envelope.md`,
  lastUpdated: registry.commitDates.envelope,
  body: sections([
    { title: "The contract", body: paragraphs(registry.prose.envelope ?? "") },
    {
      title: "The two shapes",
      body: [
        `Both carry ${code("apiVersion")}, which this build sets to ${code(registry.apiVersion)}.`,
        fence(
          "json",
          JSON.stringify(
            { apiVersion: registry.apiVersion, type: registry.responseTypes.at(0), data: {} },
            null,
            2
          )
        ),
        fence(
          "json",
          JSON.stringify(
            {
              apiVersion: registry.apiVersion,
              error: "prose that changes freely as wording improves",
              code: registry.errorCodes.at(0)?.code,
              suggestions: []
            },
            null,
            2
          )
        ),
        `Branch on ${code("code")}, never on ${code("error")}.`
      ].join("\n\n")
    },
    {
      title: "Exit codes",
      body: [
        paragraphs(registry.prose.exitCodes ?? ""),
        table(
          ["Constant", "Value"],
          registry.exitCodes.map((exit) => [code(exit.name), code(String(exit.value))])
        )
      ].join("\n\n")
    },
    {
      title: "The discriminators",
      body: `${registry.responseTypes.length} ${pageLink(base, `${TIER}/response-types`, "response types")} and ${registry.errorCodes.length} ${pageLink(base, `${TIER}/error-codes`, "error codes")}. Both vocabularies are append-only: a shipped value never changes meaning and is never removed.`
    },
    provenance(SOURCES.envelope, "the envelope, its codes, and its exit codes are declared there.")
  ])
})

const responseTypesPage = (registry: Registry, base: string): ReferencePage => {
  const emitters = (type: string): ReadonlyArray<CommandSpec> =>
    registry.commands.filter((command) =>
      (command.responseTypes as ReadonlyArray<string>).includes(type)
    )
  const orphans = registry.responseTypes.filter((type) => emitters(type).length === 0)
  return {
    id: `${TIER}/response-types`,
    title: "Response types",
    description: "The discriminator a caller reads before parsing `data`.",
    source: SOURCES.envelope,
    filePath: `${DOCS_COLLECTION}/${TIER}/response-types.md`,
    lastUpdated: registry.commitDates.envelope,
    body: sections([
      { title: "Why they are append-only", body: paragraphs(registry.prose.responseTypes ?? "") },
      {
        title: "The types",
        body: [
          table(
            ["Type", "Emitted by"],
            registry.responseTypes.map((type) => [
              code(type),
              emitters(type).length === 0
                ? "— *no command declares it*"
                : emitters(type)
                    .map((command) =>
                      pageLink(
                        base,
                        `${TIER}/commands/${commandSlug(command.name)}`,
                        code(`memhtml ${command.name}`)
                      )
                    )
                    .join(", ")
            ])
          ),
          orphans.length === 0
            ? `Every one of the ${registry.responseTypes.length} types is declared by at least one command.`
            : `${codeList(orphans)} — ${orphans.length} of the ${registry.responseTypes.length} types — ${orphans.length === 1 ? "is declared" : "are declared"} by no command. The vocabulary is append-only, so a type outlives the command that emitted it.`
        ].join("\n\n")
      },
      provenance(
        SOURCES.envelope,
        `the emitters are read from each command's own ${code("responseTypes")}, so this table is the join rather than a copy of it.`
      )
    ])
  }
}

const errorCodesPage = (registry: Registry, base: string): ReferencePage => {
  const unraised = registry.errorCodes.filter((row) => row.sites.length === 0)
  return {
    id: `${TIER}/error-codes`,
    title: "Error codes",
    description: "What a failure carries, and where each code comes from.",
    source: SOURCES.envelope,
    filePath: `${DOCS_COLLECTION}/${TIER}/error-codes.md`,
    lastUpdated: registry.commitDates.envelope,
    body: sections([
      { title: "Why they are append-only", body: paragraphs(registry.prose.errorCodes ?? "") },
      {
        title: "The codes",
        body: [
          `The registry ships the codes as a bare list with no per-code prose, so the columns below are the ones the sources state: the typed domain failures the CLI translates into each code, the suggestions it offers for those failures, and every file naming the code. **A code with no named file and no failure mapped to it is a gap in the sources, not a code with a hidden meaning.**`,
          table(
            ["Code", "From these failures", "Suggestions", "Named in"],
            registry.errorCodes.map((row) => [
              code(row.code),
              codeList(row.tags),
              row.suggestions.length === 0 ? "—" : codeList(row.suggestions),
              row.sites.length === 0 ? "*nowhere*" : codeList(row.sites)
            ])
          ),
          unraised.length === 0
            ? `Every code is named somewhere in ${code("apps/cli/src")} or ${code("apps/mcp/src")}.`
            : `${codeList(unraised.map((row) => row.code))} — ${unraised.length} of the ${registry.errorCodes.length} codes — ${unraised.length === 1 ? "is declared" : "are declared"} and named nowhere else in ${code("apps/cli/src")} or ${code("apps/mcp/src")}. Append-only means a code outlives the condition that raised it.`
        ].join("\n\n")
      },
      {
        title: "How a failure reaches a caller",
        anchor: "how-a-failure-reaches-a-caller",
        body: `Every typed domain failure passes through one translation in ${code("apps/cli/src/errors.ts")}, which is total: an unrecognised failure becomes ${code("ERR_UNKNOWN")} rather than an empty response. The envelope's shape is on ${pageLink(base, `${TIER}/envelope`, "the JSON envelope")}.`
      },
      provenance(
        SOURCES.envelope,
        `the mapping column is read from the translation's own switch, and the last column is a census over ${code("apps/cli/src")} and ${code("apps/mcp/src")}.`
      )
    ])
  }
}

const configPage = (registry: Registry): ReferencePage => ({
  id: `${TIER}/config`,
  title: "Environment variables",
  description: "The whole environment surface, and what absence means for each.",
  source: SOURCES.config,
  filePath: `${DOCS_COLLECTION}/${TIER}/config.md`,
  lastUpdated: registry.commitDates.config,
  body: sections([
    { title: "How they are read", body: paragraphs(registry.prose.config ?? "") },
    {
      title: "The variables",
      body: table(
        ["Variable", "Absent means", "Description"],
        registry.configVars.map((variable) => [
          code(variable.name),
          variable.fallback === null ? "*meaningful*" : code(variable.fallback),
          cell(variable.description)
        ])
      )
    },
    provenance(
      SOURCES.config,
      `${code("CONFIG_VARS")} is what ${code("memhtml manifest")} publishes, so a variable this page omits is one the binary does not read.`
    )
  ])
})

const mcpToolsPage = (registry: Registry, base: string): ReferencePage => ({
  id: `${TIER}/mcp-tools`,
  title: "MCP tools",
  description: "The stdio server's toolkit, in the order `tools/list` publishes it.",
  source: SOURCES.mcpTools,
  filePath: `${DOCS_COLLECTION}/${TIER}/mcp-tools.md`,
  lastUpdated: registry.commitDates.mcpTools,
  body: sections([
    {
      title: "The toolkit",
      body: [
        `${registry.mcpTools.length} tools over the same repository the CLI writes, served by ${pageLink(base, `${TIER}/commands/serve-mcp`, code("memhtml serve mcp"))}. The order below is the toolkit's registration order, which is what a client reads top-down.`,
        table(
          ["Tool", "Ports it declares"],
          registry.mcpTools.map((tool) => [code(tool.name), codeList(tool.ports)])
        )
      ].join("\n\n")
    },
    {
      title: "Why the surface is arranged this way",
      body: paragraphs(registry.prose.mcpTools ?? "")
    },
    {
      title: "The tools",
      body: `Each description below is the string ${code("tools/list")} publishes, verbatim — it is what a client reads when it chooses a tool.`,
      children: registry.mcpTools.map((tool) => ({
        title: tool.name,
        body: [`Ports: ${codeList(tool.ports)}`, paragraphs(tool.description)].join("\n\n")
      }))
    },
    provenance(
      SOURCES.mcpTools,
      "each description is folded from the shared constants the file concatenates, so the page cannot state a contract the server does not publish."
    )
  ])
})

const mcpResourcesPage = (registry: Registry): ReferencePage => ({
  id: `${TIER}/mcp-resources`,
  title: "MCP resources",
  description: "Citation-grade drill-down: the file behind an answer, and a sleep run's report.",
  source: SOURCES.mcpResources,
  filePath: `${DOCS_COLLECTION}/${TIER}/mcp-resources.md`,
  lastUpdated: registry.commitDates.mcpResources,
  body: sections([
    { title: "What a resource is for", body: paragraphs(registry.prose.mcpResources ?? "") },
    {
      title: "The templates",
      body: table(
        ["URI template", "Name", "MIME type", "Description"],
        registry.mcpResources.map((resource) => [
          code(resource.template),
          cell(resource.name),
          code(resource.mimeType),
          cell(resource.description)
        ])
      )
    },
    provenance(
      SOURCES.mcpResources,
      `the templates are reassembled from the resource declarations and checked against ${code("RESOURCE_TEMPLATES")}; a disagreement fails this build.`
    )
  ])
})

const vocabularyPage = (registry: Registry): ReferencePage => ({
  id: `${TIER}/vocabulary`,
  title: "Closed vocabularies",
  description: "Memory types, edge rels, PARA buckets, task statuses, and edge provenance.",
  source: SOURCES.types,
  filePath: `${DOCS_COLLECTION}/${TIER}/vocabulary.md`,
  lastUpdated: registry.commitDates.types,
  body: sections([
    {
      title: "The vocabularies",
      body: [
        `${registry.vocabularies.length} closed sets, each restated by a SQL ${code("CHECK")} constraint. A value outside one is refused rather than stored.`,
        table(
          ["Constant", "Members", "Values"],
          registry.vocabularies.map((vocabulary) => [
            code(vocabulary.name),
            String(vocabulary.values.length),
            codeList(vocabulary.values)
          ])
        )
      ].join("\n\n")
    },
    ...registry.vocabularies.map((vocabulary) => ({
      title: vocabulary.name,
      anchor: vocabulary.name.toLowerCase().replaceAll("_", "-"),
      body: [
        `${vocabulary.values.length} values, from ${code(vocabulary.source)}: ${codeList(vocabulary.values)}`,
        paragraphs(vocabulary.doc ?? "")
      ]
        .filter((part) => part !== "")
        .join("\n\n")
    })),
    provenance(
      `${SOURCES.types} and ${SOURCES.edges}`,
      "each set is read as the array the schemas and the CHECK constraints are built from."
    )
  ])
})

const sleepPhasesPage = (registry: Registry, base: string): ReferencePage => ({
  id: `${TIER}/sleep-phases`,
  title: "Sleep phases",
  description: "The nightly curation cycle's phases, in execution order.",
  source: SOURCES.sleep,
  filePath: `${DOCS_COLLECTION}/${TIER}/sleep-phases.md`,
  lastUpdated: registry.commitDates.sleep,
  body: sections([
    {
      title: "The order",
      body: [
        `${registry.sleepPhases.length} phases, each an isolated commit on a review branch. ${pageLink(base, `${TIER}/commands/sleep-run`, code("memhtml sleep run"))} runs them; ${code("--phases")} takes any subset.`,
        table(
          ["#", "Phase", "Commits", "Calls a model", "Blocks on failure"],
          registry.sleepPhases.map((phase) => [
            String(phase.index),
            code(phase.name),
            phase.commits ? "yes" : "no",
            phase.callsModel ? "yes" : "no",
            codeList(phase.blocks)
          ])
        ),
        `${registry.sleepPhases.filter((phase) => phase.callsModel).length} phases call a model; the rest are deterministic and cost no model call.`
      ].join("\n\n")
    },
    { title: "Why this order", body: paragraphs(registry.prose.sleepPhases ?? "") },
    provenance(
      SOURCES.sleep,
      `the phase names, the committing set, the model-calling set, and the hard prerequisites are four constants there — the same ones the runner, ${code("memhtml sleep resume")}, and the report read.`
    )
  ])
})

const rrfArmsPage = (registry: Registry, base: string): ReferencePage => ({
  id: `${TIER}/rrf-arms`,
  title: "RRF arms",
  description: "The four ranking arms, their weights, and what each needs to fire.",
  source: SOURCES.retrieval,
  filePath: `${DOCS_COLLECTION}/${TIER}/rrf-arms.md`,
  lastUpdated: registry.commitDates.retrieval,
  body: sections([
    {
      title: "The fold",
      body: [
        `${registry.rankArms.length} arms, fused by reciprocal rank. An arm whose precondition is absent leaves the fold, which is how ${pageLink(base, `${TIER}/commands/search`, code("memhtml search"))} degrades to the lexical floor instead of failing.`,
        table(
          ["Arm", "Weight", "Needs the query vector", "Needs the state plane", "Needs query terms"],
          registry.rankArms.map((arm) => [
            code(arm.name),
            code(arm.weight),
            arm.needsEmbedding ? "yes" : "no",
            arm.needsState ? "yes" : "no",
            arm.needsQueryTerms ? "yes" : "no"
          ])
        )
      ].join("\n\n")
    },
    { title: "Why the arms are data", body: paragraphs(registry.prose.rankArms ?? "") },
    {
      title: "The arms",
      body: "Each arm's own rationale, from the registry.",
      children: registry.rankArms.map((arm) => ({
        title: arm.name,
        body: [`Weight ${code(arm.weight)}.`, paragraphs(arm.doc ?? "")]
          .filter((part) => part !== "")
          .join("\n\n")
      }))
    },
    provenance(SOURCES.retrieval, "the arms are a registry the SQL assembler folds over.")
  ])
})

const schemaPage = (registry: Registry, base: string): ReferencePage => {
  const plane = (which: "index" | "state") =>
    registry.migrations.filter((migration) => migration.plane === which)
  const planeSection = (which: "index" | "state", title: string, prose: string): Section => ({
    title,
    body: [
      paragraphs(prose),
      `${plane(which).length} migrations.`,
      table(
        ["File", "Creates"],
        plane(which).map((migration) => [code(migration.file), codeList(migration.creates)])
      )
    ].join("\n\n"),
    children: plane(which).map((migration) => ({
      title: migration.file,
      anchor: migration.file.replace(/\.sql$/, "").toLowerCase(),
      body: [codeList(migration.creates), paragraphs(migration.rationale)]
        .filter((part) => part !== "")
        .join("\n\n")
    }))
  })
  return {
    id: `${TIER}/schema`,
    title: "Database schema and migrations",
    description: "The two SQLite planes, and every migration that builds them.",
    source: SOURCES.migrations,
    filePath: `${DOCS_COLLECTION}/${TIER}/schema.md`,
    lastUpdated: registry.commitDates.migrations,
    body: sections([
      {
        title: "Two planes",
        body: `The index is a disposable projection of the git tree: ${pageLink(base, `${TIER}/commands/index-rebuild`, code("memhtml index rebuild"))} reproduces it from ${code("HEAD")}. The state plane is not reproducible from git, which is why it has a committed sidecar. Adding a migration means adding a ${code(".sql")} file — the directories are read in filename order and no code changes.`
      },
      planeSection("index", "The index plane", registry.prose.indexPlane ?? ""),
      planeSection("state", "The state plane", registry.prose.statePlane ?? ""),
      provenance(
        `${SOURCES.migrations} and ${SOURCES.stateMigrations}`,
        "each row is the file's own leading rationale and the objects its statements create."
      )
    ])
  }
}

const requirementsPage = (registry: Registry): ReferencePage => {
  const countBy = (key: (requirement: Registry["requirements"][number]) => string) => {
    const counts = new Map<string, number>()
    for (const requirement of registry.requirements) {
      const value = key(requirement)
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts].sort(([left], [right]) => left.localeCompare(right))
  }
  const prefixes = countBy((requirement) => requirement.prefix)
  const statuses = countBy((requirement) => requirement.status)
  const methods = countBy((requirement) => requirement.verificationMethod)
  const ofPrefix = (prefix: string) =>
    registry.requirements.filter((requirement) => requirement.prefix === prefix)
  return {
    id: `${TIER}/requirements`,
    title: "Requirements",
    description:
      "The EARS requirements ledger: every requirement, its status, and its verification.",
    source: SOURCES.symspec,
    filePath: `${DOCS_COLLECTION}/${TIER}/requirements.md`,
    lastUpdated: registry.commitDates.symspec,
    body: sections([
      {
        title: "Standing",
        body: [
          `${registry.requirements.length} requirements under ${prefixes.length} key prefixes. Each names the method that verifies it and the code that satisfies it.`,
          table(
            ["Status", "Requirements", "Keys"],
            statuses.map(([status, count]) => [
              code(status),
              String(count),
              codeList(
                registry.requirements
                  .filter((requirement) => requirement.status === status)
                  .map((requirement) => requirement.key)
              )
            ])
          ),
          table(
            ["Verification method", "Requirements"],
            methods.map(([method, count]) => [code(method), String(count)])
          )
        ].join("\n\n")
      },
      {
        title: "By prefix",
        body: [
          table(
            ["Prefix", "System", "Requirements"],
            prefixes.map(([prefix, count]) => [
              `[${code(prefix)}](#${prefix.toLowerCase()})`,
              codeList([...new Set(ofPrefix(prefix).map((one) => one.systemName))]),
              String(count)
            ])
          )
        ].join("\n\n"),
        children: prefixes.map(([prefix]) => ({
          title: prefix,
          anchor: prefix.toLowerCase(),
          body: table(
            ["Key", "Requirement", "Status", "Verification", "Satisfied by"],
            ofPrefix(prefix).map((requirement) => [
              code(requirement.key),
              cell(requirement.sentence),
              code(requirement.status),
              code(requirement.verificationMethod),
              requirement.verificationNote === "" ? "—" : cell(requirement.verificationNote)
            ])
          )
        }))
      },
      provenance(
        SOURCES.symspec,
        "the ledger is the source; retiring or adding a requirement is a commit against it."
      )
    ])
  }
}

const packagesPage = (registry: Registry): ReferencePage => {
  const undescribed = registry.packages.filter((entry) => entry.description === undefined)
  return {
    id: `${TIER}/packages`,
    title: "Packages",
    description: "Every workspace package, what it owns, and which siblings it may import.",
    source: "apps/, packages/",
    filePath: `${DOCS_COLLECTION}/${TIER}/packages.md`,
    lastUpdated: registry.commitDates.commands,
    body: sections([
      {
        title: "The workspace",
        body: [
          `${registry.packages.length} packages. ${registry.packages.length - undescribed.length} of them state a description in their own manifest.`,
          table(
            ["Package", "Directory", "Description"],
            registry.packages.map((entry) => [
              code(entry.name),
              code(entry.directory),
              entry.description === undefined ? "*none stated*" : cell(entry.description)
            ])
          ),
          undescribed.length === 0
            ? ""
            : `${codeList(undescribed.map((entry) => entry.name))} ${undescribed.length === 1 ? "states" : "state"} no description in ${undescribed.length === 1 ? "its" : "their"} manifest, so this table has nothing to quote.`
        ]
          .filter((part) => part !== "")
          .join("\n\n")
      },
      {
        title: "Dependency direction",
        body: [
          "Dependencies point inward, and the column below is each manifest's own workspace dependency list — the edges TypeScript project references enforce.",
          table(
            ["Package", "Imports"],
            registry.packages.map((entry) => [
              code(entry.name),
              codeList(entry.workspaceDependencies)
            ])
          )
        ].join("\n\n")
      },
      provenance(
        "each package's own package.json",
        "the description and the dependency list are the manifest's, not a second copy."
      )
    ])
  }
}

/** Every page in the tier, in a stable order. */
export const referencePages = (
  registry: Registry,
  options: { readonly base: string }
): ReadonlyArray<ReferencePage> => {
  const base = options.base
  return [
    overviewPage(registry, base),
    ...registry.commands.map((command) => commandPage(registry, command, base)),
    globalFlagsPage(registry, base),
    guideIndexPage(registry, base),
    ...registry.guide.map((block) => guideTopicPage(registry, block, base)),
    envelopePage(registry, base),
    responseTypesPage(registry, base),
    errorCodesPage(registry, base),
    configPage(registry),
    mcpToolsPage(registry, base),
    mcpResourcesPage(registry),
    vocabularyPage(registry),
    sleepPhasesPage(registry, base),
    rrfArmsPage(registry, base),
    schemaPage(registry, base),
    requirementsPage(registry),
    packagesPage(registry)
  ]
}

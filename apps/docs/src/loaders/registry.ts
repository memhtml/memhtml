import { spawnSync } from "node:child_process"

import {
  API_VERSION,
  COMMANDS,
  CONFIG_VARS,
  type CommandSpec,
  type ConfigVar,
  ERROR_CODES,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  type FlagSpec,
  GLOBAL_FLAGS,
  GUIDE,
  GUIDE_OP_EXAMPLE,
  type GuideBlock,
  RESPONSE_TYPES,
  SUGGESTIONS
} from "@memhtml/cli"

import {
  booleanProperty,
  callArgumentIdentifiers,
  docCommentFor,
  identifierListProperty,
  makeCallsOf,
  moduleDocOf,
  numericProperty,
  objectMembersOf,
  REPO_ROOT,
  resetSourceCache,
  sourceNames,
  sourceText,
  stringArrayConst,
  stringPairArrayConst,
  stringProperty,
  switchReturnsOf,
  taggedTemplateCallsOf,
  tsFilesUnder
} from "./repo-sources.js"

/**
 * Every registry the Reference tier publishes, collected once per build.
 *
 * A page is a pure function of this record, which is what makes the mutation lock possible: a test
 * appends a synthetic member to one field and asserts the page count moves. Nothing here is a
 * literal restatement of a count — every quantity on every page is `length` of one of these arrays.
 */

/** The module naming both migration directories, quoted on the schema page. */
const SCHEMA_CONST = "packages/index/src/schema-const.ts"

/** Where a page's facts come from, named on the page so a reader can go edit the registry. */
export const SOURCES = {
  commands: "apps/cli/src/commands.ts",
  envelope: "apps/cli/src/envelope.ts",
  config: "apps/cli/src/config.ts",
  mcpTools: "apps/mcp/src/tools.ts",
  mcpResources: "apps/mcp/src/resources.ts",
  types: "packages/contracts/src/types.ts",
  edges: "packages/contracts/src/edges.ts",
  sleep: "packages/sleep/src/contract.ts",
  retrieval: "packages/index/src/retrieval-sql.ts",
  migrations: "packages/index/migrations",
  stateMigrations: "packages/index/state-migrations",
  symspec: "spec/memhtml.symspec.json"
} as const

/** One MCP tool, as `tools/list` publishes it. */
export interface McpTool {
  readonly name: string
  readonly description: string
  /** The ports the handler declares, which is the set of capabilities it can reach. */
  readonly ports: ReadonlyArray<string>
}

/** One MCP resource template. */
export interface McpResource {
  readonly template: string
  readonly name: string
  readonly description: string
  readonly mimeType: string
}

/** One closed vocabulary: the constant's name, its members, and its own doc comment. */
export interface Vocabulary {
  readonly name: string
  readonly source: string
  readonly values: ReadonlyArray<string>
  readonly doc: string | undefined
}

/** One sleep phase, with the properties the phase registry states about it. */
export interface SleepPhaseRow {
  readonly name: string
  /** 1-based ordinal within the execution order. A label, never arithmetic input. */
  readonly index: number
  readonly commits: boolean
  readonly callsModel: boolean
  /** Phases this one must succeed for. */
  readonly blocks: ReadonlyArray<string>
}

/** One RRF arm. `weight` stays the authored text so `1.0` does not print as `1`. */
export interface RankArmRow {
  readonly name: string
  readonly weight: string
  readonly needsEmbedding: boolean
  readonly needsState: boolean
  readonly needsQueryTerms: boolean
  readonly doc: string | undefined
}

/** One migration file: its own leading rationale, and the objects it creates. */
export interface MigrationRow {
  readonly file: string
  readonly plane: "index" | "state"
  readonly rationale: string
  readonly creates: ReadonlyArray<string>
}

/**
 * One error code, with everything the sources actually state about it.
 *
 * The registry ships the codes as a bare list, so a page cannot describe what a code MEANS without
 * inventing prose. What is derivable is where the code comes from: which typed domain failures
 * `codeFor` translates into it, which suggestions the CLI offers for those failures, and which files
 * name the code at all. A code with an empty `sites` list is declared and raised nowhere — a gap the
 * page states rather than hides, because the vocabulary is append-only and a retired code stays.
 */
export interface ErrorCodeRow {
  readonly code: string
  readonly tags: ReadonlyArray<string>
  readonly suggestions: ReadonlyArray<string>
  readonly sites: ReadonlyArray<string>
}

/** One EARS requirement from the symspec ledger. */
export interface Requirement {
  readonly key: string
  readonly prefix: string
  readonly sentence: string
  readonly status: string
  readonly priority: string
  readonly patternType: string
  readonly verificationMethod: string
  readonly verificationNote: string
  readonly systemName: string
}

/** One workspace package. */
export interface PackageRow {
  readonly name: string
  readonly directory: string
  readonly description: string | undefined
  readonly workspaceDependencies: ReadonlyArray<string>
}

export interface Registry {
  readonly commands: ReadonlyArray<CommandSpec>
  readonly globalFlags: ReadonlyArray<FlagSpec>
  readonly guide: ReadonlyArray<GuideBlock>
  readonly guideOpExample: string
  readonly responseTypes: ReadonlyArray<string>
  readonly errorCodes: ReadonlyArray<ErrorCodeRow>
  readonly configVars: ReadonlyArray<ConfigVar>
  readonly apiVersion: string
  /** The three exit codes, as the binary's own constants name them. */
  readonly exitCodes: ReadonlyArray<{ readonly name: string; readonly value: number }>
  readonly mcpTools: ReadonlyArray<McpTool>
  readonly mcpResources: ReadonlyArray<McpResource>
  readonly vocabularies: ReadonlyArray<Vocabulary>
  readonly sleepPhases: ReadonlyArray<SleepPhaseRow>
  readonly rankArms: ReadonlyArray<RankArmRow>
  readonly migrations: ReadonlyArray<MigrationRow>
  readonly requirements: ReadonlyArray<Requirement>
  readonly packages: ReadonlyArray<PackageRow>
  /** Doc comments quoted as page prose, keyed by the registry they document. */
  readonly prose: Readonly<Record<string, string | undefined>>
  /** The newest commit date of each source, for the derived page's `lastUpdated`. */
  readonly commitDates: Readonly<Record<string, Date | undefined>>
}

const toolRegistry = (): ReadonlyArray<McpTool> => {
  const path = SOURCES.mcpTools
  const built = new Map(
    makeCallsOf(path, "Tool").map(
      (call) =>
        [
          call.identifier,
          {
            name: call.name,
            description: stringProperty(path, call.object, "description"),
            ports: identifierListProperty(path, call.object, "dependencies")
          }
        ] as const
    )
  )
  // Registration order, not source order: `MemhtmlToolkit` is what `tools/list` publishes, and its
  // comment states the order is the reading order an agent needs. The identifiers resolve back to
  // the `Tool.make` calls above, so a tool declared and never registered is absent from the page —
  // which is correct, since it is absent from the server.
  return callArgumentIdentifiers(path, "MemhtmlToolkit").map((identifier) => {
    const tool = built.get(identifier)
    if (!tool) throw new Error(`${path}: \`${identifier}\` is registered but never built`)
    return tool
  })
}

const resourceRegistry = (): ReadonlyArray<McpResource> => {
  const path = SOURCES.mcpResources
  const templates = stringArrayConst(path, "RESOURCE_TEMPLATES")
  const declared = taggedTemplateCallsOf(path, "McpServer", "resource").map((entry) => ({
    template: entry.template,
    name: stringProperty(path, entry.object, "name"),
    description: stringProperty(path, entry.object, "description"),
    mimeType: stringProperty(path, entry.object, "mimeType")
  }))
  // The two independent readings must agree: `RESOURCE_TEMPLATES` exists so a test can assert the
  // surface without a handshake, and it is a second copy of the URIs the `resource` calls build. A
  // page that published one while the server serves the other is the drift this tier exists to
  // refuse.
  const built = declared.map((entry) => entry.template)
  if (built.length !== templates.length || built.some((uri, at) => uri !== templates.at(at))) {
    throw new Error(`${path}: RESOURCE_TEMPLATES disagrees with the declared resources`)
  }
  return declared
}

/** Where a code may be named. The declaring file is excluded: declaring one is not raising one. */
const CODE_SITE_ROOTS = ["apps/cli/src", "apps/mcp/src"] as const

const errorCodeRegistry = (): ReadonlyArray<ErrorCodeRow> => {
  const mapping = switchReturnsOf("apps/cli/src/errors.ts", "codeFor")
  const sources = CODE_SITE_ROOTS.flatMap((root) => tsFilesUnder(root))
    .filter((path) => path !== SOURCES.envelope)
    .map((path) => [path, sourceText(path)] as const)
  return ERROR_CODES.map((code) => {
    const tags = mapping
      .filter((pair) => pair.returns === code && pair.match !== undefined)
      .map((pair) => pair.match ?? "")
    return {
      code,
      tags,
      suggestions: tags.flatMap((tag) => SUGGESTIONS[tag]?.({ _tag: tag }) ?? []),
      sites: sources.filter(([, text]) => text.includes(`"${code}"`)).map(([path]) => path)
    }
  })
}

const vocabularyOf = (source: string, name: string): Vocabulary => ({
  name,
  source,
  values: stringArrayConst(source, name),
  doc: docCommentFor(source, name)
})

const sleepPhaseRegistry = (): ReadonlyArray<SleepPhaseRow> => {
  const path = SOURCES.sleep
  const phases = stringArrayConst(path, "SLEEP_PHASES")
  const nonCommitting = new Set(stringArrayConst(path, "NON_COMMITTING_PHASES"))
  const llm = new Set(stringArrayConst(path, "LLM_PHASES"))
  const prerequisites = stringPairArrayConst(path, "HARD_PREREQUISITES")
  return phases.map((name, offset) => ({
    name,
    index: offset + 1,
    commits: !nonCommitting.has(name),
    callsModel: llm.has(name),
    blocks: prerequisites.filter(([before]) => before === name).map(([, after]) => after)
  }))
}

const rankArmRegistry = (): ReadonlyArray<RankArmRow> => {
  const path = SOURCES.retrieval
  return objectMembersOf(path, "RANK_ARMS").map(({ object, doc }) => ({
    name: stringProperty(path, object, "name"),
    weight: numericProperty(path, object, "weight"),
    needsEmbedding: booleanProperty(path, object, "needsEmbedding"),
    needsState: booleanProperty(path, object, "needsState"),
    needsQueryTerms: booleanProperty(path, object, "needsQueryTerms"),
    doc
  }))
}

/** The leading `--` comment block of a `.sql` file, up to its first blank comment line. */
const leadingSqlComment = (text: string): string => {
  const lines: Array<string> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("--")) break
    const stripped = line.replace(/^--\s?/, "")
    if (stripped.trim() === "") break
    lines.push(stripped)
  }
  return lines.join("\n").trim()
}

const CREATES =
  /^CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gm

const migrationRegistry = (): ReadonlyArray<MigrationRow> => {
  const planes = [
    { plane: "index" as const, directory: SOURCES.migrations },
    { plane: "state" as const, directory: SOURCES.stateMigrations }
  ]
  return planes.flatMap(({ plane, directory }) =>
    sourceNames(directory, ".sql").map((file) => {
      const text = sourceText(`${directory}/${file}`)
      return {
        file,
        plane,
        rationale: leadingSqlComment(text),
        creates: [...text.matchAll(CREATES)].map(
          (match) => `${match[1]?.toLowerCase() ?? "object"} ${match[2] ?? ""}`
        )
      }
    })
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const requiredString = (row: Record<string, unknown>, field: string, where: string): string => {
  const value = row[field]
  if (typeof value !== "string") throw new Error(`${where}: \`${field}\` is not a string`)
  return value
}

const requirementRegistry = (): ReadonlyArray<Requirement> => {
  const parsed: unknown = JSON.parse(sourceText(SOURCES.symspec))
  if (!isRecord(parsed) || !isRecord(parsed.requirements)) {
    throw new Error(`${SOURCES.symspec}: no \`requirements\` object`)
  }
  const rows = Object.values(parsed.requirements).map((entry): Requirement => {
    if (!isRecord(entry)) throw new Error(`${SOURCES.symspec}: a requirement is not an object`)
    const key = requiredString(entry, "key", SOURCES.symspec)
    return {
      key,
      // The ledger's own key shape: a system prefix, a hyphen, an ordinal. The prefix is the axis
      // the page filters on, and it is read off the key rather than carried beside it.
      prefix: key.slice(0, key.lastIndexOf("-")),
      sentence: requiredString(entry, "sentence", SOURCES.symspec),
      status: requiredString(entry, "status", SOURCES.symspec),
      priority: requiredString(entry, "priority", SOURCES.symspec),
      patternType: requiredString(entry, "patternType", SOURCES.symspec),
      verificationMethod: requiredString(entry, "verificationMethod", SOURCES.symspec),
      verificationNote: typeof entry.verificationNote === "string" ? entry.verificationNote : "",
      systemName: requiredString(entry, "systemName", SOURCES.symspec)
    }
  })
  return [...rows].sort((left, right) => left.key.localeCompare(right.key, "en", { numeric: true }))
}

const WORKSPACE_DIRECTORIES = ["apps", "packages"] as const

const packageRegistry = (): ReadonlyArray<PackageRow> =>
  WORKSPACE_DIRECTORIES.flatMap((parent) =>
    sourceNames(parent, "")
      .filter((name) => !name.startsWith("."))
      .flatMap((name) => {
        const manifest: unknown = JSON.parse(sourceText(`${parent}/${name}/package.json`))
        if (!isRecord(manifest)) throw new Error(`${parent}/${name}: unreadable package.json`)
        const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
        return [
          {
            name: requiredString(manifest, "name", `${parent}/${name}/package.json`),
            directory: `${parent}/${name}`,
            description:
              typeof manifest.description === "string" ? manifest.description : undefined,
            workspaceDependencies: Object.keys(dependencies)
              .filter((dependency) => dependency.startsWith("@memhtml/"))
              .sort()
          }
        ]
      })
  )

/**
 * The newest commit touching a file, or `undefined` when git cannot answer.
 *
 * A generated page has no file of its own, so Starlight's git lookup would have nothing to read.
 * The truthful date for a derived page is the date its REGISTRY last moved, which is what this
 * returns — and an absent answer omits the field rather than inventing today.
 */
const newestCommitDate = (relativePath: string): Date | undefined => {
  const result = spawnSync("git", ["log", "-1", "--format=%ct", "--", relativePath], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  })
  const seconds = Number(result.stdout?.trim())
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined
}

/** Read every registry. Throws rather than degrading: drift must fail the build. */
export const collectRegistry = (): Registry => {
  resetSourceCache()
  const migrations = migrationRegistry()
  const commitDates = Object.fromEntries(
    Object.entries(SOURCES).map(([key, path]) => [key, newestCommitDate(path)])
  )
  return {
    commands: COMMANDS,
    globalFlags: GLOBAL_FLAGS,
    guide: GUIDE,
    guideOpExample: GUIDE_OP_EXAMPLE,
    responseTypes: RESPONSE_TYPES,
    errorCodes: errorCodeRegistry(),
    configVars: CONFIG_VARS,
    apiVersion: API_VERSION,
    exitCodes: [
      { name: "EXIT_OK", value: EXIT_OK },
      { name: "EXIT_USAGE", value: EXIT_USAGE },
      { name: "EXIT_RUNTIME", value: EXIT_RUNTIME }
    ],
    mcpTools: toolRegistry(),
    mcpResources: resourceRegistry(),
    vocabularies: [
      vocabularyOf(SOURCES.types, "MEMORY_TYPES"),
      vocabularyOf(SOURCES.types, "PARA_BUCKETS"),
      vocabularyOf(SOURCES.types, "TASK_STATUSES"),
      vocabularyOf(SOURCES.edges, "EDGE_CLASSES"),
      vocabularyOf(SOURCES.edges, "MEMORY_RELS"),
      vocabularyOf(SOURCES.edges, "PERSON_RELS"),
      vocabularyOf(SOURCES.edges, "PROVENANCE_RELS"),
      vocabularyOf(SOURCES.edges, "TASK_RELS"),
      vocabularyOf(SOURCES.edges, "EDGE_PROVENANCES")
    ],
    sleepPhases: sleepPhaseRegistry(),
    rankArms: rankArmRegistry(),
    migrations,
    requirements: requirementRegistry(),
    packages: packageRegistry(),
    prose: {
      commands: docCommentFor(SOURCES.commands, "COMMANDS"),
      globalFlags: docCommentFor(SOURCES.commands, "GLOBAL_FLAGS"),
      guide: docCommentFor(SOURCES.commands, "GUIDE"),
      responseTypes: docCommentFor(SOURCES.envelope, "RESPONSE_TYPES"),
      errorCodes: docCommentFor(SOURCES.envelope, "ERROR_CODES"),
      exitCodes: docCommentFor(SOURCES.envelope, "EXIT_OK"),
      envelope: moduleDocOf(SOURCES.envelope),
      config: moduleDocOf(SOURCES.config),
      indexPlane: docCommentFor(SCHEMA_CONST, "MIGRATIONS_DIR"),
      statePlane: docCommentFor(SCHEMA_CONST, "STATE_MIGRATIONS_DIR"),
      sleepPhases: docCommentFor(SOURCES.sleep, "SLEEP_PHASES"),
      mcpTools: moduleDocOf(SOURCES.mcpTools),
      mcpResources: moduleDocOf(SOURCES.mcpResources),
      rankArms: moduleDocOf(SOURCES.retrieval)
    },
    commitDates
  }
}

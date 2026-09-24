import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4ToolResultPart
} from "@ai-sdk/provider"
import { MEMORY_TYPES, type MemoryType, slugify } from "@memhtml/contracts"
import { renderTemplate } from "@memhtml/html"
import { MockLanguageModelV4 } from "ai/test"

import { type Briefing, parseBriefing } from "./briefing.js"
import { type CollapseBriefing, parseCollapseBriefing } from "./collapse-briefing.js"
import type { ProposedOp } from "./tools.js"

/**
 * The scripted model behind `--model fake`: credential-free, deterministic, and useful.
 *
 * Two scripts, chosen by the briefing it is handed:
 *
 * Under a curate-run briefing it plays the dedup rule of the charter and nothing else: `status` once,
 * then one `exec` whose script lists every frame-key group in the briefing that holds more than one
 * active path, archives every path but the first of each, and splices a `supersedes` link into the
 * kept file's head for each archive, then `finish`. On a fixture that holds a duplicate pair the
 * harvester yields one `archive` and one `link` from that one `exec` (the head edit becomes a
 * `link` op; no `propose` is needed), so `curate run --model fake` lands a real commit in the smoke
 * run and the integration tier with no model on the network, and proves the code-mode edge path
 * end to end.
 *
 * Under a collapse briefing (`collapse-briefing.ts`) it plays one fold the way the collapse charter
 * asks: one `propose` carrying the canonical `put` under the home prefix (title, the members'
 * claims as the body, every tag and entity, the collapse tag, and one `supersedes` link per member
 * unless the briefing says the driver completes them) plus one `archive` per member (again unless
 * the driver completes them), then `finish` naming the canonical. So `curate collapse --model fake`
 * lands a real fold on a fixture, and the driver's completion of archives and links is exercised
 * on the large-group path.
 *
 * It reads each briefing back out of the user message and the archive list out of the `exec` tool
 * result, so the only coupling is to shapes this package owns.
 */

export const FAKE_PROVIDER = "memhtml"
export const FAKE_MODEL_ID = "fake"

/** The script the fake asks `exec` to run over the groups. Exported so a test can run it alone. */
export const fakeDedupScript = (
  groups: ReadonlyArray<{ readonly paths: ReadonlyArray<string> }>,
  year: string
): string =>
  [
    'import * as fs from "node:fs"',
    'const ROOT = "/mnt/memhtml"',
    `const YEAR = ${JSON.stringify(year)}`,
    `const GROUPS = ${JSON.stringify(groups.map((group) => [...group.paths].sort()))}`,
    "const archived = []",
    "for (const paths of GROUPS) {",
    "  const kept = paths[0]",
    "  for (const path of paths.slice(1)) {",
    '    const to = "archive/" + YEAR + "/" + path',
    '    fs.mkdirSync(ROOT + "/" + to.slice(0, to.lastIndexOf("/")), { recursive: true })',
    '    fs.writeFileSync(ROOT + "/" + to, fs.readFileSync(ROOT + "/" + path, "utf8"))',
    '    fs.unlinkSync(ROOT + "/" + path)',
    // The edge, placed from code mode: one <link> line spliced before </head> of the kept file,
    // which the harvester turns into a link op because the article is untouched.
    '    const keptHtml = fs.readFileSync(ROOT + "/" + kept, "utf8")',
    "    const link = '<link rel=\"memhtml-supersedes\" href=\"/' + to + '\">'",
    '    fs.writeFileSync(ROOT + "/" + kept, keptHtml.replace("</head>", link + "\\n</head>"))',
    "    archived.push({ kept, from: path, to })",
    "  }",
    "}",
    "console.log(JSON.stringify({ groups: GROUPS.length, archived }))"
  ].join("\n")

interface Archived {
  readonly kept: string
  readonly from: string
  readonly to: string
}

/** Tool names the conversation shows the assistant has called so far, in order. */
const callsSoFar = (options: LanguageModelV4CallOptions): ReadonlyArray<string> =>
  options.prompt.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []))
      : []
  )

/** Every text part of every user message, in order. */
const userTexts = (options: LanguageModelV4CallOptions): ReadonlyArray<string> =>
  options.prompt.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : []
  )

const briefingOf = (options: LanguageModelV4CallOptions): Briefing | null => {
  for (const text of userTexts(options)) {
    const parsed = parseBriefing(text)
    if (parsed !== null) return parsed
  }
  return null
}

const collapseBriefingOf = (options: LanguageModelV4CallOptions): CollapseBriefing | null => {
  for (const text of userTexts(options)) {
    const parsed = parseCollapseBriefing(text)
    if (parsed !== null) return parsed
  }
  return null
}

const textOf = (part: LanguageModelV4ToolResultPart): string | null =>
  part.output.type === "text"
    ? part.output.value
    : part.output.type === "json"
      ? JSON.stringify(part.output.value)
      : null

/** The archive list the `exec` result printed, or `[]` when the script did not run cleanly. */
const archivedFrom = (options: LanguageModelV4CallOptions): ReadonlyArray<Archived> => {
  for (const message of options.prompt) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "exec") continue
      const text = textOf(part)
      if (text === null) return []
      try {
        const result = JSON.parse(text) as { exitCode?: number; stdout?: string }
        if (result.exitCode !== 0 || typeof result.stdout !== "string") return []
        const printed = JSON.parse(result.stdout.trim()) as { archived?: ReadonlyArray<Archived> }
        return printed.archived ?? []
      } catch {
        return []
      }
    }
  }
  return []
}

const toolCall = (toolName: string, args: unknown): LanguageModelV4GenerateResult => ({
  content: [
    {
      type: "tool-call",
      toolCallId: `${toolName}-${String(Date.now())}`,
      toolName,
      input: JSON.stringify(args)
    }
  ],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined }
  },
  warnings: []
})

const isMemoryType = (value: string): value is MemoryType =>
  (MEMORY_TYPES as ReadonlyArray<string>).includes(value)

/** The canonical's path under the briefing's home, the slug from its title. */
export const fakeCanonicalPath = (briefing: Pick<CollapseBriefing, "home" | "title">): string =>
  `${briefing.home}/${slugify(briefing.title)}.html`

/**
 * The canonical the fake writes for a collapse briefing. The claim keeps the title first and ends in
 * a long tail after its last linking word, so it states no frame the members' claims share (the
 * frame rule reads the last `of|is|in|to|by|as` and wants a value of at most six tokens); a
 * canonical that keyed on a member's frame would earn a `contradicts` edge at commit.
 */
export const fakeCanonicalHtml = (briefing: CollapseBriefing): string => {
  const tags = new Set<string>()
  const entities = new Set<string>()
  for (const member of briefing.members) {
    for (const tag of member.tags) tags.add(tag)
    for (const entity of member.entities) entities.add(entity)
  }
  tags.add(briefing.tag)
  const archivable = briefing.members.filter((member) => member.ruling?.verdict !== "keep")
  return renderTemplate({
    title: briefing.title,
    claim: `${briefing.title}: folded by the fake curator from ${String(archivable.length)} member records into one canonical record.`,
    body: [
      "The members stated, in their own words:",
      ...briefing.members.map((member) => `${member.path}: ${member.claim}`)
    ],
    memoryType: isMemoryType(briefing.memoryType) ? briefing.memoryType : "semantic",
    at: briefing.today,
    tags: [...tags].sort(),
    entities: [...entities].sort(),
    links: briefing.driverCompletes
      ? []
      : archivable.map((member) => ({
          rel: "supersedes" as const,
          href: `/archive/${briefing.archiveYear}/${member.path}`
        }))
  })
}

/** The one proposal the fake makes for a collapse briefing: the put, then the archives when it owns them. */
export const fakeCollapseProposal = (briefing: CollapseBriefing): ReadonlyArray<ProposedOp> => {
  const put: ProposedOp = {
    kind: "put",
    path: fakeCanonicalPath(briefing),
    html: fakeCanonicalHtml(briefing)
  }
  if (briefing.driverCompletes) return [put]
  return [
    put,
    ...briefing.members
      .filter((member) => member.ruling?.verdict !== "keep")
      .map((member): ProposedOp => ({ kind: "archive", path: member.path }))
  ]
}

const nextCollapseCall = (
  briefing: CollapseBriefing,
  calls: ReadonlyArray<string>
): LanguageModelV4GenerateResult => {
  if (calls.length === 0) return toolCall("propose", { ops: fakeCollapseProposal(briefing) })
  const archived = briefing.driverCompletes
    ? 0
    : briefing.members.filter((member) => member.ruling?.verdict !== "keep").length
  return toolCall("finish", {
    report: [
      `Folded ${briefing.title} into ${fakeCanonicalPath(briefing)}`,
      String(archived),
      "",
      briefing.driverCompletes
        ? "The driver archives the members and links them to the canonical."
        : "Every member is archived and reached from the canonical by a supersedes link."
    ].join("\n")
  })
}

/** The next call in the fake's script, decided from what the conversation shows it has done. */
export const fakeNextCall = (
  options: LanguageModelV4CallOptions
): LanguageModelV4GenerateResult => {
  const calls = callsSoFar(options)
  const collapse = collapseBriefingOf(options)
  if (collapse !== null) return nextCollapseCall(collapse, calls)
  const step = calls.length
  if (step === 0) return toolCall("status", {})
  if (step === 1) {
    const briefing = briefingOf(options)
    const groups = (briefing?.frameKeyGroups ?? []).map((group) => ({
      paths: group.records.map((record) => record.path)
    }))
    const year = String(new Date().getUTCFullYear())
    return toolCall("exec", { script: fakeDedupScript(groups, year) })
  }
  const archived = archivedFrom(options)
  const report =
    archived.length === 0
      ? [
          "No duplicate frame-key groups to settle; nothing archived.",
          "",
          "The fake curator plays the dedup rule only. Left undone: every other priority."
        ].join("\n")
      : [
          `Archived ${String(archived.length)} duplicate record(s) behind their canonical twins.`,
          "",
          ...archived.map((entry) => `- ${entry.from} -> ${entry.to}, superseded by ${entry.kept}`),
          "",
          "The fake curator plays the dedup rule only. Left undone: every other priority."
        ].join("\n")
  return toolCall("finish", { report })
}

/** A `LanguageModelV4` that follows {@link fakeNextCall}. A fresh instance per run. */
export const fakeCuratorModel = (): LanguageModelV4 =>
  new MockLanguageModelV4({
    provider: FAKE_PROVIDER,
    modelId: FAKE_MODEL_ID,
    doGenerate: async (options) => fakeNextCall(options)
  })

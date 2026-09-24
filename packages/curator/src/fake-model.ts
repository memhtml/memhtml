import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4ToolResultPart
} from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

import { type Briefing, parseBriefing } from "./briefing.js"

/**
 * The scripted model behind `--model fake`: credential-free, deterministic, and useful.
 *
 * It plays the dedup rule and the integrity rule of the charter and nothing else. Its script is
 * fixed: `status` once, then one `exec` whose script (1) lists every `duplicates` group in the
 * briefing, archives every path but the first of each, and splices a `supersedes` link into the
 * kept file's head for each archive, and (2) walks every active memory file for a
 * `<link rel="memhtml-...">` whose root-relative target is no file in the corpus and cuts that line,
 * then `finish`. On a fixture that holds a duplicate pair and one dangling link the harvester yields
 * one `archive`, one `link`, and one `unlink` from that one `exec` (both head edits become edge
 * ops; no `propose` is needed), so `curate run --model fake` lands a real commit in the smoke run
 * and the integration tier with no model on the network, and proves both code-mode edge paths end
 * to end. The briefing's `contradictions` are left alone, as the charter's first priority says.
 *
 * It reads the briefing back out of the user message (`parseBriefing`) and the archive and unlink
 * lists out of the `exec` tool result, so the only coupling is to shapes this package owns.
 */

export const FAKE_PROVIDER = "memhtml"
export const FAKE_MODEL_ID = "fake"

/**
 * The script the fake asks `exec` to run: the dedup over `groups`, then the dangling-link sweep over
 * the active buckets. Exported so a test can run it alone.
 *
 * The sweep runs after the dedup, so the `supersedes` edges the dedup placed point at archive files
 * that exist by then and are never cut. It walks `areas/`, `projects/`, and `resources/` only: an
 * archived file's edge is not a session's to drop (`validateOps` refuses an `unlink` whose source is
 * not active), and one such op would keep the whole harvest out of the log.
 */
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
    // The sweep: every memhtml link line whose root-relative href names no file is cut, which the
    // harvester turns into an unlink op because, again, the article is untouched.
    "const unlinked = []",
    "const LINK = /^[ \\t]*<link\\s[^>]*\\brel=[\"']memhtml-([^\"']+)[\"'][^>]*\\bhref=[\"']([^\"']+)[\"'][^>]*>[ \\t]*\\r?\\n?/gm",
    // The guest's `statSync(...).isDirectory` is a boolean property, not a method (the shape
    // `apps/cli/guest/corpus.mjs` records), so the check takes both shapes.
    "const isDir = (path) => {",
    "  const stats = fs.statSync(path)",
    '  return typeof stats.isDirectory === "function" ? stats.isDirectory() : stats.isDirectory === true',
    "}",
    "const walk = (dir) => {",
    "  for (const name of fs.readdirSync(dir)) {",
    '    const full = dir + "/" + name',
    "    if (isDir(full)) walk(full)",
    '    else if (name.endsWith(".html") && name !== "index.html") sweep(full)',
    "  }",
    "}",
    "const sweep = (file) => {",
    '  const html = fs.readFileSync(file, "utf8")',
    "  const next = html.replace(LINK, (line, token, href) => {",
    '    if (!href.startsWith("/") || fs.existsSync(ROOT + href)) return line',
    '    unlinked.push({ path: file.slice(ROOT.length + 1), rel: token.replaceAll("-", "_"), href })',
    '    return ""',
    "  })",
    "  if (next !== html) fs.writeFileSync(file, next)",
    "}",
    'for (const bucket of ["areas", "projects", "resources"]) {',
    '  if (fs.existsSync(ROOT + "/" + bucket)) walk(ROOT + "/" + bucket)',
    "}",
    "console.log(JSON.stringify({ groups: GROUPS.length, archived, unlinked }))"
  ].join("\n")

interface Archived {
  readonly kept: string
  readonly from: string
  readonly to: string
}

interface Unlinked {
  readonly path: string
  readonly rel: string
  readonly href: string
}

interface ExecPrinted {
  readonly archived: ReadonlyArray<Archived>
  readonly unlinked: ReadonlyArray<Unlinked>
}

const NOTHING_PRINTED: ExecPrinted = { archived: [], unlinked: [] }

/** Tool names the conversation shows the assistant has called so far, in order. */
const callsSoFar = (options: LanguageModelV4CallOptions): ReadonlyArray<string> =>
  options.prompt.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []))
      : []
  )

const briefingOf = (options: LanguageModelV4CallOptions): Briefing | null => {
  for (const message of options.prompt) {
    if (message.role !== "user") continue
    for (const part of message.content) {
      if (part.type !== "text") continue
      const parsed = parseBriefing(part.text)
      if (parsed !== null) return parsed
    }
  }
  return null
}

const textOf = (part: LanguageModelV4ToolResultPart): string | null =>
  part.output.type === "text"
    ? part.output.value
    : part.output.type === "json"
      ? JSON.stringify(part.output.value)
      : null

/** What the `exec` result printed, or nothing when the script did not run cleanly. */
const printedFrom = (options: LanguageModelV4CallOptions): ExecPrinted => {
  for (const message of options.prompt) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "exec") continue
      const text = textOf(part)
      if (text === null) return NOTHING_PRINTED
      try {
        const result = JSON.parse(text) as { exitCode?: number; stdout?: string }
        if (result.exitCode !== 0 || typeof result.stdout !== "string") return NOTHING_PRINTED
        const printed = JSON.parse(result.stdout.trim()) as Partial<ExecPrinted>
        return { archived: printed.archived ?? [], unlinked: printed.unlinked ?? [] }
      } catch {
        return NOTHING_PRINTED
      }
    }
  }
  return NOTHING_PRINTED
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

/** The next call in the fake's script, decided from what the conversation shows it has done. */
export const fakeNextCall = (
  options: LanguageModelV4CallOptions
): LanguageModelV4GenerateResult => {
  const calls = callsSoFar(options)
  const step = calls.length
  if (step === 0) return toolCall("status", {})
  if (step === 1) {
    const briefing = briefingOf(options)
    // Only the `duplicates` list: a contradiction's members disagree and both stay live.
    const groups = (briefing?.duplicates ?? []).map((group) => ({
      paths: group.records.map((record) => record.path)
    }))
    const year = String(new Date().getUTCFullYear())
    return toolCall("exec", { script: fakeDedupScript(groups, year) })
  }
  const { archived, unlinked } = printedFrom(options)
  // The first line is the commit subject, which `commitSubject` caps at 72 characters, so every
  // shape here stays under the cap and the subject lands untruncated.
  const dropped = `dropped ${String(unlinked.length)} dangling link(s)`
  const subject =
    archived.length === 0
      ? unlinked.length === 0
        ? "No duplicate groups to settle; nothing archived."
        : `No duplicates to settle; ${dropped}.`
      : unlinked.length === 0
        ? `Archived ${String(archived.length)} duplicate record(s) behind their canonical twins.`
        : `Archived ${String(archived.length)} duplicate record(s) and ${dropped}.`
  const report = [
    subject,
    "",
    ...archived.map((entry) => `- ${entry.from} -> ${entry.to}, superseded by ${entry.kept}`),
    ...unlinked.map((entry) => `- ${entry.path}: dropped ${entry.rel} -> ${entry.href}`),
    ...(archived.length + unlinked.length === 0 ? [] : [""]),
    "The fake curator plays the dedup and integrity rules only. Left undone: every other priority."
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

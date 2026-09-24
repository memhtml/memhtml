import type { StorageFailure } from "@memhtml/contracts/errors"
import { APICallError, generateText, isStepCount, type LanguageModel, tool } from "ai"
import { Effect } from "effect"
import { z } from "zod"

import { type Briefing, renderBriefing } from "./briefing.js"
import { budgetWith, type CuratorBudget } from "./budget.js"
import { CURATOR_CHARTER } from "./charter.js"
import { type CuratorTools, ProposedOp, toOverlayOps } from "./tools.js"

/**
 * The curator loop: `generateText` with tools and stop conditions, bounded four ways in this
 * process (`budget.ts`), ending on a `finish` tool call.
 *
 * ## The answer is a tool call
 *
 * The run ends when the model calls `finish` with its report. The alternative, the SDK's
 * `Output.object`, renders on the Anthropic Messages API as `output_config.format`, which Bedrock
 * rejects outright (measured 2026-09-03 through the proxy: `output_config.format: Extra inputs are
 * not permitted`). A tool's `inputSchema` is ordinary JSON Schema every provider accepts, so every
 * structured thing the model says to this loop, the ops it proposes included, is a tool call.
 *
 * ## Every tool result is bounded
 *
 * One `exec` over a large corpus can print megabytes, and every step re-sends the whole
 * conversation, so a tool result is serialized and cut at {@link TOOL_RESULT_CAP} characters with a
 * marker naming how much was dropped. The cap is stated in each tool's description so the model
 * asks narrower questions rather than learning it by truncation.
 *
 * ## A rejected proposal is a tool result, not the end of the run
 *
 * A tool's schema is advisory: a model can name an archived path, a rel outside the vocabulary, or a
 * put whose article the head already holds. `propose` runs the binder's validation and hands the
 * violations back as the result, so the model reads them and fixes the proposal. The run stops only
 * on `finish` or a budget.
 */

/** Characters one tool result may occupy in the conversation. */
export const TOOL_RESULT_CAP = 30_000

export const TRUNCATION_MARKER = "[truncated:"

/** `text` cut at `cap` with a marker naming what was dropped; unchanged when it fits. */
export const truncateToolResult = (text: string, cap: number = TOOL_RESULT_CAP): string =>
  text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n${TRUNCATION_MARKER} ${String(text.length - cap)} of ${String(text.length)} characters dropped at the ${String(cap)}-character cap]`

export type StoppedBy = "finish" | "maxSteps" | "wallClock" | "maxOps" | "modelError"

export interface CuratorRun {
  /** Model calls made. */
  readonly steps: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** The `finish` report, or an explanation of the stop when there was none. */
  readonly report: string
  readonly stoppedBy: StoppedBy
  /** Overlay ops the tools reported appended during this run. */
  readonly opsAppended: number
  /** Tool names in call order, for a test and for the envelope. */
  readonly toolCalls: ReadonlyArray<string>
  /** The provider or runtime failure that stopped the run, when `stoppedBy` is `modelError`. */
  readonly error: string | null
}

export interface CuratorRunInput {
  readonly tools: CuratorTools
  readonly model: LanguageModel
  readonly budget?: Partial<CuratorBudget> | undefined
  /** The code-computed briefing, or an already rendered user message. */
  readonly briefing: Briefing | string
  /** An outer cancellation, joined with the wall clock. */
  readonly signal?: AbortSignal | undefined
  /** The system prompt; defaults to the charter file. Tests pass a string to skip the read. */
  readonly charter?: string | undefined
  /** The clock archive paths and the wall clock read. Defaults to `Date.now`. */
  readonly now?: (() => Date) | undefined
}

/** The result serialized for the model: JSON for objects, the text itself for strings, then cut. */
const asToolResult = (value: unknown): string =>
  truncateToolResult(typeof value === "string" ? value : JSON.stringify(value))

/** A thrown tool failure as a value the model can read and act on. */
const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const describeApiError = (error: APICallError): string => {
  const body = typeof error.responseBody === "string" ? error.responseBody.slice(0, 300) : ""
  return (
    `the model provider answered ${String(error.statusCode ?? "no status")} for ${error.url}` +
    (body === "" ? "" : `: ${body}`)
  )
}

export const runCurator = (input: CuratorRunInput): Effect.Effect<CuratorRun, StorageFailure> =>
  Effect.gen(function* () {
    const budget = budgetWith(input.budget)
    const charter = input.charter ?? (yield* CURATOR_CHARTER)
    const now = input.now ?? (() => new Date())
    const prompt =
      typeof input.briefing === "string" ? input.briefing : renderBriefing(input.briefing)

    const controller = new AbortController()
    const signal =
      input.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, input.signal])
    const timer = setTimeout(() => controller.abort(), budget.wallClockMs)

    let steps = 0
    let inputTokens = 0
    let outputTokens = 0
    let opsAppended = 0
    let report: string | null = null
    const toolCalls: Array<string> = []

    /** Run one tool body, counting the call and turning a throw into a result. */
    const guarded =
      <A>(name: string, body: () => Promise<A>) =>
      async (): Promise<string> => {
        toolCalls.push(name)
        try {
          return asToolResult(await body())
        } catch (cause) {
          return asToolResult({ error: `${name} failed: ${describeFailure(cause)}` })
        }
      }

    const capNote = `The result is cut at ${String(TOOL_RESULT_CAP)} characters.`

    const tools = {
      search: tool({
        description: `Two-arm search (lexical plus recency) over the active records of the version this session sees. Returns paths, scores, and claims. ${capNote}`,
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional().describe("Default 10, max 50.")
        }),
        execute: ({ query, limit }) =>
          guarded("search", () => input.tools.search(query, limit ?? 10))()
      }),
      read: tool({
        description: `One record by repo-relative path: its parsed fields and its whole HTML. Null when the path is not in the view. ${capNote}`,
        inputSchema: z.object({ path: z.string().min(1) }),
        execute: ({ path }) => guarded("read", () => input.tools.read(path))()
      }),
      exec: tool({
        description: `Run a JavaScript module over the corpus in a sandbox. The files are mounted writable at /mnt/memhtml; import { corpus } from "/workspace/lib/corpus.mjs" to parse them. A new .html file is harvested as a put; a <link rel="memhtml-..."> added to an existing file's head (article untouched) is harvested as a link op, one per link added, and one removed from the head is harvested as an unlink op, one per link removed; a file copied unchanged to archive/<YYYY>/<its path> with the original removed is harvested as an archive. Any other edit to an existing file is refused: revising a claim is a new file plus an archive of the old one, joined by a supersedes link, and a head edit other than adding or removing links is not an operation. The harvest is appended to the session only when the script exits 0 and no op is unlandable; the result says what was appended, what was rejected, and every violation. ${capNote}`,
        inputSchema: z.object({ script: z.string().min(1) }),
        execute: ({ script }) =>
          guarded("exec", async () => {
            const result = await input.tools.exec(script)
            opsAppended += result.appended
            return result
          })()
      }),
      propose: tool({
        description: `Append explicit operations to the session: put (a whole file), archive (a source path; the destination and bytes are derived), link (path, rel, root-relative href), unlink (path, rel, href of an edge the record carries). Every op is validated first; violations come back and nothing is appended when there are any. ${capNote}`,
        inputSchema: z.object({ ops: z.array(ProposedOp).min(1) }),
        execute: ({ ops }) =>
          guarded("propose", async () => {
            const resolved = await toOverlayOps(ops, input.tools, now())
            const result =
              resolved.ops.length === 0
                ? { appended: 0, violations: [] }
                : await input.tools.propose(resolved.ops)
            opsAppended += result.appended
            return { ...result, missing: resolved.missing }
          })()
      }),
      status: tool({
        description: "The session (base sha, ref, ops by kind) and this run's spend so far.",
        inputSchema: z.object({}),
        execute: () =>
          guarded("status", async () => ({
            ...(await input.tools.status()),
            stepsUsed: steps,
            stepsMax: budget.maxSteps,
            tokensUsed: { input: inputTokens, output: outputTokens },
            opsAppended,
            opsMax: budget.maxOps
          }))()
      }),
      finish: tool({
        description:
          "End the run with your report. The first line becomes the commit subject; below it, what you did, what you left undone, and what a human should look at.",
        inputSchema: z.object({ report: z.string().min(1) }),
        execute: ({ report: text }) =>
          guarded("finish", async () => {
            report = text
            return "finished"
          })()
      })
    }

    let error: string | null = null
    // One promise around the whole call: a rejection inside `generateText` must land in THIS
    // catch, and an `Effect.promise` rejection would be a defect the generator's own try could not
    // see. The wall-clock timer is cleared on every path.
    yield* Effect.promise(async () => {
      try {
        const result = await generateText({
          model: input.model,
          system: charter,
          prompt,
          tools,
          // "auto", not "required": under "required" the AI SDK throws when a step carries no tool
          // call, and the first live run (2026-09-23, Opus 5.5 through the proxy) ended exactly so,
          // with 23 ops in the session and its closing text lost. A text-only step now ends the run
          // and the text is the report.
          toolChoice: "auto",
          abortSignal: signal,
          stopWhen: [
            () => report !== null,
            () => signal.aborted,
            () => opsAppended >= budget.maxOps,
            isStepCount(budget.maxSteps)
          ],
          onStepFinish: (step) => {
            steps += 1
            inputTokens += step.usage.inputTokens ?? 0
            outputTokens += step.usage.outputTokens ?? 0
          }
        })
        // A model that answered with text and no tool call ended the loop on its own; the text is
        // its report, and the run stopped by `finish` as surely as through the tool.
        if (
          report === null &&
          result.text.trim() !== "" &&
          !signal.aborted &&
          steps < budget.maxSteps
        ) {
          report = result.text
        }
      } catch (cause) {
        if (!signal.aborted) {
          error = APICallError.isInstance(cause)
            ? describeApiError(cause)
            : `the curator run failed: ${describeFailure(cause)}`
        }
      } finally {
        clearTimeout(timer)
      }
    })

    const stoppedBy: StoppedBy =
      report !== null
        ? "finish"
        : error !== null
          ? "modelError"
          : signal.aborted
            ? "wallClock"
            : opsAppended >= budget.maxOps
              ? "maxOps"
              : "maxSteps"

    return {
      steps,
      inputTokens,
      outputTokens,
      report: report ?? stopReport(stoppedBy, { steps, opsAppended, budget, error }),
      stoppedBy,
      opsAppended,
      toolCalls,
      error
    }
  })

const stopReport = (
  stoppedBy: StoppedBy,
  facts: {
    readonly steps: number
    readonly opsAppended: number
    readonly budget: CuratorBudget
    readonly error: string | null
  }
): string => {
  switch (stoppedBy) {
    case "wallClock":
      return `stopped by the wall clock of ${String(facts.budget.wallClockMs)} ms after ${String(facts.steps)} model call(s) without a finish report`
    case "maxOps":
      return `stopped at the op ceiling of ${String(facts.budget.maxOps)} after appending ${String(facts.opsAppended)} op(s) without a finish report`
    case "modelError":
      return facts.error ?? "the model call failed"
    case "maxSteps":
      return `stopped at the step ceiling of ${String(facts.budget.maxSteps)} without a finish report`
    case "finish":
      return "finished"
  }
}

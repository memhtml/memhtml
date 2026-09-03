import {
  APICallError,
  generateText,
  isStepCount,
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  tool
} from "ai"

import type { JsonObject } from "./contract.js"

/**
 * One consolidation turn: a bounded tool loop over the AI SDK that ends in a structured answer.
 *
 * ## The loop is the SDK's, and the bounds are all in this call
 *
 * `generateText` with `tools`, `output`, and `stopWhen` is the agent: the model calls a tool, the
 * SDK runs it and calls the model again, until the model answers with the object `output` describes
 * or a stop condition holds. Three bounds are stated here and nowhere else — the step count, the
 * turn's output-token total, and the wall clock through `abortSignal` — and each is enforced by the
 * process making the calls, in this process. The previous runtime (eve, through 0.11.x) ran the same
 * loop in a spawned server behind an HTTP client, which is where every one of its bounds turned into
 * a cooperative signal that a wedged server never observed.
 *
 * ## The answer is a TOOL CALL, not a response format
 *
 * The model ends the turn by calling {@link ANSWER_TOOL} with the answer as the tool's input, and
 * `hasToolCall` stops the loop there. The alternative, the SDK's `Output.object`, renders on the
 * Anthropic Messages API as `output_config.format`, and Bedrock rejects the field outright
 * (measured 2026-09-03 through the proxy: `invalid_request_error: output_config.format: Extra inputs
 * are not permitted`; the direct path is the same API). A tool's `input_schema` is ordinary JSON
 * Schema the API has always accepted, and it is the shape the previous runtime used for the same
 * answer (its `final_output` tool). The schema is `CONSOLIDATION_OUTPUT_JSON_SCHEMA`, derived from
 * the Effect schema the client then DECODES with (`ConsolidationPayload`, excess properties refused),
 * so the provider is asked for exactly the shape the decoder refuses anything outside of.
 *
 * ## A rejected answer is a tool result, not the end of the turn
 *
 * The schema in a tool's `input_schema` is advisory to the model: measured live 2026-09-03, the
 * first full run through this loop answered with a claim of more than 300 characters against a
 * schema saying at most 300, and the client's decoder refused the whole night. So the answer tool
 * VALIDATES with the caller's `accept` and returns the problem as its result; the model reads it and
 * resubmits, and the loop stops only on an accepted answer. Bounded by {@link MAX_REJECTED_ANSWERS}
 * on top of the model-call and token ceilings, so a model that cannot satisfy the schema is stopped
 * by name rather than looping to the token cap.
 *
 * ## Prompt caching, per step
 *
 * Every step re-sends the whole conversation, and a transcript-reading turn's conversation is the
 * tool results — megabytes of context by the end (measured 2026-09-03: 396k input tokens per call by
 * the fortieth step, 395k of them cache reads). `prepareStep` marks the last message of each step as
 * an Anthropic cache breakpoint, which caches the prefix up to it; the next step reads that prefix
 * from cache and pays for the new tail only. The AI SDK cookbook's dynamic-caching pattern, applied
 * unconditionally because both of this client's model paths are Anthropic Messages (`model.ts`).
 */

export interface TurnInput {
  readonly model: LanguageModel
  /** The system prompt: `prompts/instructions.md`. */
  readonly instructions: string
  /** The one user message the client composes. */
  readonly message: string
  readonly tools: ToolSet
  /** The JSON Schema of the structured answer the turn must end with. */
  readonly outputSchema: JsonObject
  /**
   * Judge a submitted answer: `null` accepts it and ends the turn; a string is the problem, handed
   * back to the model as the tool's result so it can resubmit. The client passes the contract's
   * decoder here, so what the model is told is exactly what the client would have refused.
   */
  readonly accept: (input: unknown) => string | null
  /** Provider options on every model call (reasoning), keyed by provider. */
  readonly providerOptions: Record<string, Record<string, JSONValue>>
  /** How many model calls the turn may make before it is stopped. */
  readonly maxModelCalls: number
  /** Output tokens (reasoning included) the whole turn may spend before it is stopped. */
  readonly outputTokenLimit: number
  /** Wall-clock budget for the whole turn. */
  readonly budgetMs: number
}

/** The tool the model answers with. Named in `prompts/instructions.md` and the turn message. */
export const ANSWER_TOOL = "submit_answer"

/** How many rejected submissions a turn tolerates before it is stopped by name. */
export const MAX_REJECTED_ANSWERS = 3

export type TurnOutcome =
  | {
      readonly kind: "answered"
      /** The structured answer, undecoded: the client decodes it against the contract. */
      readonly output: unknown
      readonly modelCalls: number
      readonly outputTokens: number
    }
  | { readonly kind: "timeout"; readonly modelCalls: number }
  | {
      readonly kind: "stopped"
      /** Why the loop was stopped before the model answered: a bound, named with its numbers. */
      readonly reason: string
      readonly modelCalls: number
    }
  | { readonly kind: "failed"; readonly reason: string; readonly modelCalls: number }

const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const

/**
 * Mark the last message as the ONE cache breakpoint, clearing the mark every earlier message carries.
 *
 * The messages `prepareStep` receives are the previous steps' messages, providerOptions included, so
 * a mark set on step N's last message is still there on step N+1. Anthropic allows four breakpoints
 * per request and the SDK drops the excess with a warning (measured live 2026-09-03: "Maximum 4 cache
 * breakpoints exceeded (found 8)"), so leaving the old marks in place is how the NEW one gets dropped
 * and the growing prefix stops being cached. One mark, on the last message, every step.
 */
export const withCacheBreakpoint = (messages: ReadonlyArray<ModelMessage>): ModelMessage[] =>
  messages.map((message, index) => {
    // Rebuilt WITHOUT the original providerOptions: spreading the message back in would carry the
    // old mark along with it, which is the accumulation this function exists to prevent.
    const { providerOptions: previous, ...rest } = message
    const { anthropic, ...otherProviders } = previous ?? {}
    const { cacheControl: _dropped, ...otherAnthropic } =
      (anthropic as Record<string, JSONValue> | undefined) ?? {}
    const cleared: Record<string, Record<string, JSONValue>> = {
      ...(otherProviders as Record<string, Record<string, JSONValue>>),
      ...(Object.keys(otherAnthropic).length === 0 ? {} : { anthropic: otherAnthropic })
    }
    const providerOptions =
      index === messages.length - 1
        ? { ...cleared, anthropic: { ...otherAnthropic, ...CACHE_BREAKPOINT.anthropic } }
        : cleared
    return {
      ...rest,
      ...(Object.keys(providerOptions).length === 0 ? {} : { providerOptions })
    }
  }) as ModelMessage[]

/** A provider failure, rendered for an operator log: status and the first line of the body. */
const describeApiError = (error: APICallError): string => {
  const body = typeof error.responseBody === "string" ? error.responseBody.slice(0, 300) : ""
  return (
    `the model provider answered ${String(error.statusCode ?? "no status")} for ${error.url}` +
    (body === "" ? "" : `: ${body}`)
  )
}

export const runTurn = async (input: TurnInput): Promise<TurnOutcome> => {
  let modelCalls = 0
  let outputTokens = 0
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.budgetMs)
  try {
    let accepted: unknown
    let rejected = 0
    let lastProblem: string | null = null
    const answer = tool({
      description:
        "Submit your final answer: the candidates, the commitments, and the read receipt. Call this " +
        "when you are done reading. If the answer does not satisfy the schema, the result names the " +
        "problem and you must fix it and submit again; an accepted answer ends the turn.",
      inputSchema: jsonSchema(input.outputSchema as never),
      execute: async (submitted: unknown) => {
        const problem = input.accept(submitted)
        if (problem === null) {
          accepted = submitted
          return { accepted: true }
        }
        rejected += 1
        lastProblem = problem
        return { accepted: false, problem, resubmissionsLeft: MAX_REJECTED_ANSWERS - rejected }
      }
    })
    const result = await generateText({
      model: input.model,
      system: input.instructions,
      prompt: input.message,
      tools: { ...input.tools, [ANSWER_TOOL]: answer },
      providerOptions: input.providerOptions,
      stopWhen: [
        () => accepted !== undefined,
        () => rejected >= MAX_REJECTED_ANSWERS,
        isStepCount(input.maxModelCalls),
        ({ steps }) =>
          steps.reduce((sum, step) => sum + (step.usage.outputTokens ?? 0), 0) >=
          input.outputTokenLimit
      ],
      prepareStep: ({ messages }) => ({ messages: withCacheBreakpoint(messages) }),
      onStepFinish: (step) => {
        modelCalls += 1
        outputTokens += step.usage.outputTokens ?? 0
      },
      abortSignal: controller.signal
    })

    modelCalls = result.steps.length
    outputTokens = result.totalUsage.outputTokens ?? outputTokens

    const output = accepted

    if (output === undefined) {
      const last = result.steps.at(-1)
      const bound =
        rejected >= MAX_REJECTED_ANSWERS
          ? `${String(MAX_REJECTED_ANSWERS)} rejected submissions (last: ${String(lastProblem).slice(0, 300)})`
          : modelCalls >= input.maxModelCalls
            ? `the model-call ceiling of ${String(input.maxModelCalls)}`
            : outputTokens >= input.outputTokenLimit
              ? `the output-token ceiling of ${String(input.outputTokenLimit)} (${String(outputTokens)} spent)`
              : null
      if (bound !== null) {
        return {
          kind: "stopped",
          reason:
            `the consolidation turn reached ${bound} after ${String(modelCalls)} model call(s) ` +
            "without a structured answer",
          modelCalls
        }
      }
      return {
        kind: "failed",
        reason:
          `the consolidation turn ended after ${String(modelCalls)} model call(s) without a ` +
          `structured answer (finish reason ${String(last?.finishReason ?? "unknown")})`,
        modelCalls
      }
    }
    return { kind: "answered", output, modelCalls, outputTokens }
  } catch (cause) {
    if (controller.signal.aborted) return { kind: "timeout", modelCalls }
    if (APICallError.isInstance(cause)) {
      return { kind: "failed", reason: describeApiError(cause), modelCalls }
    }
    return {
      kind: "failed",
      reason: `the consolidation turn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      modelCalls
    }
  } finally {
    clearTimeout(timer)
  }
}

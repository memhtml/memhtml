import {
  ANTHROPIC_VERSION,
  MAX_TOKENS_CEILING,
  MAX_TOKENS_DEFAULT,
  STRUCTURED_TOOL_NAME
} from "./constants.js"
import { type Effort, type ModelKey, thinkingFor } from "./models.js"

/**
 * The native Messages API body for `invoke_model`. Not Converse: the effort and thinking
 * rules are per-model and exact, and Converse has no field for either.
 */

export interface GenerateOptions {
  readonly system?: string | undefined
  readonly maxTokens?: number | undefined
  readonly effort: Effort
}

/**
 * Bound a requested budget to what Bedrock accepts. Above the ceiling the service raises a
 * `ValidationException` rather than clamping, so an unbounded caller value would fail the
 * call instead of shortening the answer.
 */
export const clampTokens = (requested: number | undefined): number =>
  Math.min(requested ?? MAX_TOKENS_DEFAULT, MAX_TOKENS_CEILING)

/**
 * A JSON Schema object for the forced tool's `input_schema`. Open-keyed because JSON
 * Schema is, and because the derivation in `structured.ts` emits keys this module has no
 * reason to enumerate.
 */
export interface JsonSchemaObject {
  readonly [key: string]: unknown
}

export interface StructuredTool {
  readonly inputSchema: JsonSchemaObject
  readonly description?: string | undefined
}

/**
 * Build the request body. The `tool` argument is what separates the two lanes: absent, the
 * model answers in prose; present, it is forced through `tool_choice` into exactly one
 * `emit` call, which is the whole structured-output mechanism.
 *
 * `system` is omitted rather than sent empty, because an empty system block is a distinct
 * (and rejected) input from no system block at all.
 */
export const buildInvokeBody = (
  key: ModelKey,
  prompt: string,
  options: GenerateOptions,
  tool?: StructuredTool
): string => {
  const body: Record<string, unknown> = {
    anthropic_version: ANTHROPIC_VERSION,
    max_tokens: clampTokens(options.maxTokens),
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: options.effort }
  }
  if (options.system !== undefined && options.system.length > 0) {
    body.system = options.system
  }
  const thinking = thinkingFor(key)
  if (thinking !== null) {
    body.thinking = thinking
  }
  if (tool !== undefined) {
    body.tools = [
      {
        name: STRUCTURED_TOOL_NAME,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        input_schema: tool.inputSchema
      }
    ]
    body.tool_choice = { type: "tool", name: STRUCTURED_TOOL_NAME }
  }
  return JSON.stringify(body)
}

/**
 * `stop_reason` values that mean the content is not a complete answer. Both are typed
 * failures: a response cut off at `max_tokens` may never have reached the point that made
 * it a judgment, and a refusal carries no judgment at all. Either one read as a finished
 * result is a silent data-quality bug, so neither is ever coerced into one.
 */
export const INCOMPLETE_STOP_REASONS: ReadonlySet<string> = new Set(["max_tokens", "refusal"])

export interface ContentBlock {
  readonly type?: string
  readonly text?: string
  readonly name?: string
  readonly input?: unknown
}

export interface InvokeResponseBody {
  readonly stop_reason?: string | null
  readonly content?: ReadonlyArray<ContentBlock>
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
  }
}

/** The parsed payload, read defensively — every field on the wire is optional. */
export const asResponseBody = (payload: unknown): InvokeResponseBody =>
  (payload ?? {}) as InvokeResponseBody

/** The incomplete `stop_reason`, or null when the response ran to a natural end. */
export const incompleteReason = (parsed: InvokeResponseBody): string | null => {
  const stop = parsed.stop_reason ?? null
  return stop !== null && INCOMPLETE_STOP_REASONS.has(stop) ? stop : null
}

/**
 * Join the text blocks. Thinking blocks are discarded deliberately: a caller reads the
 * answer, not the deliberation, and concatenating the two would put reasoning the model
 * did not commit to into the value a phase acts on.
 */
export const readText = (parsed: InvokeResponseBody): string =>
  (parsed.content ?? [])
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" && block.text.length > 0
        ? [block.text]
        : []
    )
    .join("\n\n")

/**
 * The forced tool's `input`, or undefined when the model answered without calling it.
 * Matched on the block's `name`, not its position: a thinking block precedes the tool call
 * on the two adaptive models, so an index-based read would find the wrong block.
 */
export const readToolInput = (parsed: InvokeResponseBody): unknown => {
  const block = (parsed.content ?? []).find(
    (candidate) => candidate.type === "tool_use" && candidate.name === STRUCTURED_TOOL_NAME
  )
  return block?.input
}

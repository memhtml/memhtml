import {
  ANTHROPIC_VERSION,
  MAX_TOKENS_CEILING,
  MAX_TOKENS_DEFAULT,
  STRUCTURED_TOOL_NAME
} from "./constants.js"
import { type Effort, type ModelKey, thinkingFor } from "./models.js"

/**
 * The native Messages API body for `invoke_model`. The effort and thinking rules are
 * per-model and exact, and Converse has no field for either, so Converse is not used.
 */

export interface GenerateOptions {
  readonly system?: string | undefined
  readonly maxTokens?: number | undefined
  readonly effort: Effort
  /**
   * Mark the system prompt as a cache breakpoint.
   *
   * The batched phases send one system prompt and one tool schema across every batch of a night,
   * with only the member list changing per call, so the prefix is the same bytes tens of times in a
   * row. With this set, `system` goes out as a content-block array carrying
   * `cache_control: {type: "ephemeral"}` instead of a plain string, which is how the Messages API
   * names a prefix to cache. A plain string carries no place to put the marker, so the shape has to
   * change and not only gain a field.
   */
  readonly cacheSystem?: boolean | undefined
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
 * Build the request body. The `tool` argument selects the lane. When it is absent the model
 * answers in prose. When it is present, `tool_choice` forces the model into exactly one
 * `emit` call, and that is the whole structured-output mechanism.
 *
 * `system` is omitted rather than sent empty, because an empty system block is a distinct
 * (and rejected) input from no system block at all. An omitted system also has nothing to cache, so
 * `cacheSystem` over an absent or empty system emits no `system` key at all instead of an empty
 * cached block.
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
    body.system =
      options.cacheSystem === true
        ? [{ type: "text", text: options.system, cache_control: { type: "ephemeral" } }]
        : options.system
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
 * `stop_reason` values that mean the content is not a complete answer. Both become typed
 * failures. A response cut off at `max_tokens` may never have reached the point that made
 * it a judgment, and a refusal carries no judgment at all. Reading either as a finished
 * result would be a silent data-quality bug, so neither is coerced into one.
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

/** The parsed payload, read defensively, since every field on the wire is optional. */
export const asResponseBody = (payload: unknown): InvokeResponseBody =>
  (payload ?? {}) as InvokeResponseBody

/** The incomplete `stop_reason`, or null when the response ran to a natural end. */
export const incompleteReason = (parsed: InvokeResponseBody): string | null => {
  const stop = parsed.stop_reason ?? null
  return stop !== null && INCOMPLETE_STOP_REASONS.has(stop) ? stop : null
}

/**
 * Join the text blocks. Thinking blocks are discarded on purpose, because a caller reads
 * the answer rather than the deliberation. Concatenating the two would put reasoning the
 * model did not commit to into the value a phase acts on.
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
 * Matched on the block's `name` instead of its position, because a thinking block precedes
 * the tool call on the two adaptive models and an index-based read would find that block.
 */
export const readToolInput = (parsed: InvokeResponseBody): unknown => {
  const block = (parsed.content ?? []).find(
    (candidate) => candidate.type === "tool_use" && candidate.name === STRUCTURED_TOOL_NAME
  )
  return block?.input
}

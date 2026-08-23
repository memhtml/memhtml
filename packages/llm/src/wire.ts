import {
  ANTHROPIC_VERSION,
  MAX_TOKENS_CEILING,
  MAX_TOKENS_DEFAULT,
  STRUCTURED_TOOL_NAME
} from "./constants.js"
import { type Effort, type ModelKey, modelByKey, thinkingFor } from "./models.js"

/**
 * The `invoke_model` bodies, one dialect per provider, and the read-side that folds both
 * dialects into ONE response shape.
 *
 * The Anthropic lane is the native Messages body. The effort and thinking rules are
 * per-model and exact, and Converse has no field for either, so Converse is not used.
 *
 * The OpenAI lane is the chat-completions body, and its structured mechanism is
 * `response_format: {type: "json_schema", strict: true}` — constrained decoding, so the
 * bytes cannot leave the schema. Its response is normalized into {@link InvokeResponseBody}
 * right here at the wire, with the schema-constrained answer presented as a `tool_use`
 * block named `emit`: every consumer from `readToolInput` through `decodeToolInput` then
 * has exactly one shape to read, and the decode stays the single gate for both providers.
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
 * Build the request body in the model's own dialect. The `tool` argument selects the lane.
 * When it is absent the model answers in prose. When it is present the request constrains
 * the model to exactly one schema-shaped answer: a forced `emit` tool call on the
 * Anthropic dialect, a strict `json_schema` response format on the OpenAI one.
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
): string =>
  modelByKey(key).provider === "openai"
    ? buildOpenAiBody(prompt, options, tool)
    : buildAnthropicBody(key, prompt, options, tool)

const buildAnthropicBody = (
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
 * The OpenAI chat-completions body (probed live 2026-08-22 against
 * `global.openai.gpt-5.6-sol` — every field here is one the probe exercised).
 *
 * Differences from the Anthropic dialect, each one deliberate:
 *
 * - The token budget is `max_completion_tokens` and it bounds reasoning and answer
 *   together, so the same clamp applies. 128k accepted at the ceiling.
 * - Effort is `reasoning_effort`, taking the same four values.
 * - `system` rides as a leading `{role: "system"}` message; there is no `system` field.
 *   `cacheSystem` has no OpenAI-side marker — Bedrock reports `cache_write_tokens` in
 *   this dialect's usage without an opt-in field — so the flag is accepted and unused
 *   rather than rejected, keeping the option surface identical across lanes.
 * - The structured mechanism is `response_format.json_schema` with `strict: true`, named
 *   `emit` so logs read the same across providers. `description` becomes the schema's
 *   own `description`, the closest surface this dialect has to a tool description.
 */
const buildOpenAiBody = (
  prompt: string,
  options: GenerateOptions,
  tool?: StructuredTool
): string => {
  const messages: Array<Record<string, unknown>> = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: "system", content: options.system })
  }
  messages.push({ role: "user", content: prompt })
  const body: Record<string, unknown> = {
    max_completion_tokens: clampTokens(options.maxTokens),
    messages,
    reasoning_effort: options.effort
  }
  if (tool !== undefined) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: STRUCTURED_TOOL_NAME,
        strict: true,
        schema:
          tool.description === undefined
            ? tool.inputSchema
            : { description: tool.description, ...tool.inputSchema }
      }
    }
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

/** The OpenAI chat-completions payload, narrowed to the fields the normalizer reads. */
interface OpenAiResponseBody {
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string | null
    readonly message?: { readonly content?: string | null }
  }>
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
  }
}

/**
 * Fold an OpenAI chat-completions payload into {@link InvokeResponseBody}, so one read
 * side serves both dialects.
 *
 * `finish_reason` maps onto the Anthropic vocabulary this module already gates on:
 * `length` is `max_tokens` and `content_filter` is `refusal`, both of which
 * {@link INCOMPLETE_STOP_REASONS} already refuses; everything else passes through as a
 * complete answer. `structured` says how the caller asked, which decides how the content
 * is presented: a structured request's content is the schema-constrained JSON, parsed
 * here and presented as the `emit` tool's input, and a prose request's content is a text
 * block. Content that fails to parse on the structured path yields NO tool block, which
 * downstream reports as the existing "no tool_use block" violation — the right class,
 * since constrained decoding makes that a broken response rather than an off-schema one.
 */
export const normalizeOpenAiResponse = (
  payload: unknown,
  structured: boolean
): InvokeResponseBody => {
  const body = (payload ?? {}) as OpenAiResponseBody
  const choice = body.choices?.[0]
  const finish = choice?.finish_reason ?? null
  const stopReason =
    finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : finish
  const text = choice?.message?.content
  const content: Array<ContentBlock> = []
  if (typeof text === "string" && text.length > 0) {
    if (structured) {
      const input = (() => {
        try {
          return { value: JSON.parse(text) as unknown }
        } catch {
          return undefined
        }
      })()
      if (input !== undefined) {
        content.push({ type: "tool_use", name: STRUCTURED_TOOL_NAME, input: input.value })
      }
    } else {
      content.push({ type: "text", text })
    }
  }
  return {
    stop_reason: stopReason,
    content,
    usage: {
      ...(body.usage?.prompt_tokens === undefined
        ? {}
        : { input_tokens: body.usage.prompt_tokens }),
      ...(body.usage?.completion_tokens === undefined
        ? {}
        : { output_tokens: body.usage.completion_tokens })
    }
  }
}

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

import { Schema } from "effect"

/**
 * The models the sleep phases run on, and the wire rules that differ between them.
 *
 * Two providers, two call shapes, one decode. The Anthropic lane speaks the native
 * Messages body with a forced `emit` tool; the OpenAI lane speaks the chat-completions
 * body with `response_format: {type: "json_schema", strict: true}`. The OpenAI lane
 * exists for exactly one property the Anthropic lane cannot offer on Bedrock today:
 * constrained decoding, which makes an off-schema structured answer impossible at
 * generation time instead of repaired after (probed live 2026-08-22 — the Claude 5
 * models reject `strict` and `output_config.format` on every Bedrock surface, while
 * `global.openai.gpt-5.6-sol` honors strict JSON schema on InvokeModel). Both lanes
 * converge on the same response shape before `decodeToolInput`, so every phase and
 * every test sees one contract.
 */

/**
 * Reasoning effort. The Anthropic lane passes it as `output_config.effort`, the OpenAI
 * lane as `reasoning_effort`; both accept all four values (sol probed live 2026-08-22).
 */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh"])
export type Effort = typeof Effort.Type

export const ModelKey = Schema.Literals([
  "sonnet-5",
  "opus-5",
  "fable-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra"
])
export type ModelKey = typeof ModelKey.Type

/** Which wire dialect a model speaks. Selected per model, never per call. */
export type Provider = "anthropic" | "openai"

export interface ModelInfo {
  readonly key: ModelKey
  readonly label: string
  readonly modelId: string
  readonly provider: Provider
}

/**
 * Bedrock ids use the `global.` inference profiles, which makes them reachable from a
 * single region without provisioning per-region throughput. The OpenAI models REQUIRE
 * the profile: the bare `openai.gpt-5.6-*` ids reject on-demand invocation outright
 * (probed live 2026-08-22).
 */
export const MODELS: ReadonlyArray<ModelInfo> = [
  {
    key: "sonnet-5",
    label: "Claude Sonnet 5",
    modelId: "global.anthropic.claude-sonnet-5",
    provider: "anthropic"
  },
  {
    key: "opus-5",
    label: "Claude Opus 5",
    modelId: "global.anthropic.claude-opus-5",
    provider: "anthropic"
  },
  {
    key: "fable-5",
    label: "Claude Fable 5",
    modelId: "global.anthropic.claude-fable-5",
    provider: "anthropic"
  },
  {
    key: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    modelId: "global.openai.gpt-5.6-sol",
    provider: "openai"
  },
  /**
   * The mid-tier GPT-5.6, the write-time entity extractor's model (`apps/cli/src/extraction.ts`).
   * Probed live 2026-09-02 on InvokeModel: honors strict `json_schema` like Sol, answers a
   * one-item extraction in ~12s with 32 reasoning tokens at `reasoning_effort: "low"`.
   */
  {
    key: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    modelId: "global.openai.gpt-5.6-terra",
    provider: "openai"
  }
]

const BY_KEY = new Map(MODELS.map((model) => [model.key, model]))

/**
 * Resolve a key to its model. Total over `ModelKey`, so the type makes the throw
 * unreachable. It is there to fail loudly if the table is ever edited out of agreement
 * with the literal union, not to be caught.
 */
export const modelByKey = (key: ModelKey): ModelInfo => {
  const found = BY_KEY.get(key)
  if (found === undefined) {
    throw new Error(`unknown model key: ${key}`)
  }
  return found
}

/**
 * The `thinking` object per Anthropic model. Opus 5 and Fable 5 take `{type: "adaptive"}`
 * (Fable is adaptive-only). Sonnet 5 reasons unconditionally and takes NO thinking key.
 * Sending one to Sonnet 5 raises a validation error instead of being ignored. The OpenAI
 * lane never consults this: its reasoning dial is `reasoning_effort` alone.
 *
 * Verified live 2026-08-02: all three Claude models accept this shape alongside a forced
 * `tool_choice`, so structured output and adaptive thinking compose.
 */
export const thinkingFor = (key: ModelKey): { readonly type: "adaptive" } | null =>
  key === "opus-5" || key === "fable-5" ? { type: "adaptive" } : null

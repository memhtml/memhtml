import { Schema } from "effect"

/**
 * The three Claude 5 models the sleep phases run on, and the wire rules that differ
 * between them. Anthropic-only by design: the four LLM phases need one call shape, and a
 * second vendor would buy a second set of truncation and structured-output semantics for
 * no phase that asks for it.
 */

/** Reasoning effort, passed as `output_config.effort`. Accepted by all three models. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh"])
export type Effort = typeof Effort.Type

export const ModelKey = Schema.Literals(["sonnet-5", "opus-5", "fable-5"])
export type ModelKey = typeof ModelKey.Type

export interface ModelInfo {
  readonly key: ModelKey
  readonly label: string
  readonly modelId: string
}

/**
 * Bedrock ids use the `global.` inference profiles, which is what makes them reachable
 * from a single region without provisioning per-region throughput.
 */
export const MODELS: ReadonlyArray<ModelInfo> = [
  { key: "sonnet-5", label: "Claude Sonnet 5", modelId: "global.anthropic.claude-sonnet-5" },
  { key: "opus-5", label: "Claude Opus 5", modelId: "global.anthropic.claude-opus-5" },
  { key: "fable-5", label: "Claude Fable 5", modelId: "global.anthropic.claude-fable-5" }
]

const BY_KEY = new Map(MODELS.map((model) => [model.key, model]))

/**
 * Resolve a key to its model. Total over `ModelKey`, so the throw is unreachable through
 * the type — it exists to fail loudly if the table is ever edited out of agreement with
 * the literal union rather than to be caught.
 */
export const modelByKey = (key: ModelKey): ModelInfo => {
  const found = BY_KEY.get(key)
  if (found === undefined) {
    throw new Error(`unknown model key: ${key}`)
  }
  return found
}

/**
 * The `thinking` object per model. Opus 5 and Fable 5 take `{type: "adaptive"}` (Fable is
 * adaptive-only); Sonnet 5 reasons unconditionally and takes NO thinking key — sending one
 * is a validation error, not a no-op.
 *
 * Verified live 2026-08-02: all three accept this shape alongside a forced `tool_choice`,
 * so structured output and adaptive thinking compose.
 */
export const thinkingFor = (key: ModelKey): { readonly type: "adaptive" } | null =>
  key === "opus-5" || key === "fable-5" ? { type: "adaptive" } : null

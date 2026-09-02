import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai"
import { defineAgent } from "eve"

import { type ConsolidatorProxy, proxyFromEnv } from "../src/llm-proxy.js"
import {
  MODEL_CALL_OUTPUT_TOKEN_LIMIT,
  SESSION_OUTPUT_TOKEN_MAX_BATCH,
  sessionOutputTokenLimit
} from "../src/output-budget.js"

/**
 * The consolidator agent's runtime config.
 *
 * eve is filesystem-first: this file IS the config, reached by `eve build` then `eve start`,
 * never by a programmatic `defineAgent().run()`. `agent/instructions.md` is required and carries
 * the TRACE-2 bar. The client wrapper in `src/client.ts` drives it over HTTP.
 *
 * A provider-authored `LanguageModel`, not the Vercel AI Gateway: the gateway is an anti-goal, and
 * a provider-authored model is how eve is told to call a provider directly
 * (node_modules/eve/docs/agent-config.md, "Set the model"). Which provider is decided by the
 * environment at server boot, below.
 */

/**
 * The model, by its Bedrock inference-profile id. Through an LLM proxy the request carries
 * `bedrock/` plus this id (the LiteLLM convention), or whatever `MEMHTML_LLM_MODEL_PREFIX` and
 * `MEMHTML_LLM_MODEL_MAP` say instead (`src/llm-proxy.ts`), since a proxy names models on its own
 * terms.
 */
const CONSOLIDATOR_MODEL_ID = "global.anthropic.claude-opus-5"

/**
 * Read at SERVER BOOT, from the environment `eve start` spreads into the built server — the same
 * environment the client spawned it with (`src/client.ts`), which is `process.env` plus the run's
 * own values. `eve build` bakes `limits` into `.output/` but does not evaluate this file's model
 * expression, so a deployment flips between the two paths by setting one variable and restarting
 * nothing but the next run's server.
 */
const proxy = proxyFromEnv(process.env)

/**
 * Bedrock direct: the default.
 *
 * Credentials are read from the environment by the provider itself and there is NO default AWS
 * chain — `AWS_BEARER_TOKEN_BEDROCK`, else `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. No
 * shared config file, no SSO cache, no instance metadata. The provider is also lazy: this call
 * and the `bedrock(...)` call both succeed with zero credentials and nothing fails until
 * the first request, which is exactly why `hasConsolidatorCredentials()` exists in
 * `src/contract.ts` and runs before a server is ever spawned.
 */
const directModel = () =>
  createAmazonBedrock({ region: process.env.AWS_REGION ?? "us-east-1" })(CONSOLIDATOR_MODEL_ID)

/**
 * The same model through an OpenAI- and Anthropic-compatible LLM proxy, on its Anthropic Messages
 * route (`<base>/v1/messages`), when `MEMHTML_LLM_BASE_URL` names one.
 *
 * `@ai-sdk/anthropic` rather than the Bedrock provider with a `baseURL`: the Bedrock provider speaks
 * Bedrock's own InvokeModel/Converse HTTP surface with SigV4 or a Bedrock bearer token, which is
 * not what a proxy serves. The Anthropic provider speaks the Messages API the proxy does serve, and
 * it is the SAME `LanguageModelV4` implementation the Bedrock provider delegates Claude calls to
 * (`@ai-sdk/amazon-bedrock@5.0.61` depends on `@ai-sdk/anthropic@4.0.41`), so `reasoning: "high"`
 * below maps to the same adaptive-thinking request on either path, and the pinned version adds no
 * second copy to the install.
 *
 * The provider's `baseURL` is the versioned prefix, so `/v1` is appended here and the provider
 * appends `/messages`. A key travels as `Authorization: Bearer` (`authToken`), the header a proxy
 * reads; with no key the provider still insists on some credential, so a placeholder `x-api-key`
 * is sent that a keyless proxy ignores. The provider's own `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`
 * environment fallbacks never apply: both settings are always passed explicitly.
 */
const proxiedModel = (config: ConsolidatorProxy) =>
  createAnthropic({
    baseURL: `${config.baseUrl}/v1`,
    ...(config.apiKey === null ? { apiKey: "none" } : { authToken: config.apiKey })
  })(config.modelFor(CONSOLIDATOR_MODEL_ID))

export default defineAgent({
  /**
   * The model, wrapped so every call carries an OUTPUT-TOKEN CEILING.
   *
   * The wrapper is the fix for issue #113 and it is not cosmetic. eve passes no `maxOutputTokens` for
   * a directly-authored provider model — it resolves that number from the AI Gateway catalog, which
   * does not know a Bedrock inference-profile id — and `@ai-sdk/amazon-bedrock` sets
   * `inferenceConfig.maxTokens` only when the call settings name one. The request therefore goes out
   * with no limit and Bedrock applies its own 4,096-token default, which the consolidator's answer
   * does not fit: measured on a four-transcript batch, 28 consecutive calls came back
   * `finishReason: "length"` at exactly 4,096 tokens and all 15 `final_output` calls were truncated
   * JSON. `src/output-budget.ts` carries the measurement and the number. The ceiling applies to
   * both paths: the Anthropic provider falls back to its OWN default `max_tokens` when the call
   * settings name none, and whatever that default is, it is not a number this agent measured.
   *
   * `defaultSettingsMiddleware` from the `ai` package rather than a hand-written wrapper: the merge
   * is per-call-setting and belongs to the SDK that owns `LanguageModelV4`. `wrapLanguageModel`
   * preserves `specificationVersion`, `provider`, and `modelId`, which is what eve's compiler
   * validates a directly-authored model on
   * (node_modules/eve/dist/src/compiler/normalize-agent-config.js).
   */
  model: wrapLanguageModel({
    model: proxy === null ? directModel() : proxiedModel(proxy),
    middleware: defaultSettingsMiddleware({
      settings: { maxOutputTokens: MODEL_CALL_OUTPUT_TOKEN_LIMIT }
    })
  }),

  /**
   * REQUIRED here, unlike for a gateway model id. eve's window catalog does not know this
   * model id, and without the window it cannot judge when to compact. Verified against the
   * installed 0.33.0 type: `modelContextWindowTokens?: number` on the agent definition
   * (node_modules/eve/dist/src/shared/agent-definition.d.ts:59).
   *
   * **1,000,000 is the window Opus 5 serves on the Bedrock global inference profile**, confirmed by
   * the operator. The reason a number has to be written here at all is that eve resolves windows from
   * a Gateway catalog that does not know an inference profile id, so the resolution it would do is
   * unavailable rather than merely wrong — and the number it previously carried, 200_000, was not a
   * measurement of anything: it was the conservative value chosen when the catalog came up empty.
   *
   * Not cosmetic. This drives eve's COMPACTION THRESHOLD, so a window declared at a fifth of the real
   * one makes the harness compact a session that had four fifths of its budget left — and compaction
   * of a transcript-reading session discards the earlier reads a cross-session pattern is assembled
   * from, which is the one thing this agent exists to find.
   */
  modelContextWindowTokens: 1_000_000,

  /**
   * Provider-agnostic reasoning ONLY. Do not add
   * `modelOptions.providerOptions.bedrock.reasoningConfig`.
   *
   * Probed live: Opus 5 rejects `reasoningConfig: { type: "enabled", budgetTokens }` outright,
   * and eve drops an unsupported `providerOptions` silently — so the pairing fails in the worst
   * way, looking configured while being either an error or a no-op. `reasoning: "high"` is
   * forwarded by eve to the turn's model calls and is what actually takes effect.
   *
   * It also decides what the ceiling above has to cover: the provider maps `"high"` to ADAPTIVE
   * thinking for this model, whose reasoning tokens are reported as OUTPUT tokens and are NOT added
   * on top of `maxTokens` (`resolveAmazonBedrockReasoningConfig` adds a budget only for the
   * `type: "enabled"` shape). One ceiling covers reasoning and answer together.
   */
  reasoning: "high",

  limits: {
    /**
     * The whole turn's output-token ceiling, reasoning included, sized for the LARGEST batch the
     * contract admits rather than a typical one — the value is baked into `.output/` at build time
     * and serves every batch size, so a cap that fits four transcripts would starve thirty-two.
     *
     * The flat `50_000` that stood here was described as bounding "the answer, not the reading". It
     * bounded the reading, and every recorded turn against the operator's corpus landed within 6% of
     * it; two crossed it and eve PARKED them on a budget-continuation prompt nobody was there to
     * approve, which the client then misread as a contract violation (issue #113).
     *
     * Crossing it does not fail the model call, whatever eve's `SESSION_TOKEN_LIMIT_REACHED`
     * suggests — that branch is for task-mode runs. A client session is conversation-mode and gets
     * `session.waiting` with a `session-limit` input request; `unsettledTurnReason` in
     * `src/contract.ts` is what turns that into a typed failure naming the numbers.
     */
    maxOutputTokensPerSession: sessionOutputTokenLimit(SESSION_OUTPUT_TOKEN_MAX_BATCH)
  }
})

import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic"
import { createAnthropic } from "@ai-sdk/anthropic"
import { defaultSettingsMiddleware, type LanguageModel, wrapLanguageModel } from "ai"

import { type ConsolidatorProxy, proxyFromEnv } from "./llm-proxy.js"
import { MODEL_CALL_OUTPUT_TOKEN_LIMIT } from "./output-budget.js"

/**
 * The consolidator's model, built from the environment: Claude Opus 5 on Bedrock, reached either
 * directly or through an OpenAI- and Anthropic-compatible LLM proxy.
 *
 * ## Both paths speak the Anthropic Messages API, on purpose
 *
 * Direct goes through `@ai-sdk/amazon-bedrock/anthropic`, which is Bedrock's InvokeModel with full
 * Messages-API parity; proxied goes through `@ai-sdk/anthropic` against `<base>/v1/messages`. The
 * two are the same `LanguageModelV4` implementation underneath, so one `providerOptions.anthropic`
 * block (adaptive reasoning, cache control) means the same thing on either path, and a night that
 * flips `MEMHTML_LLM_BASE_URL` changes the transport and nothing else. The Converse-based
 * `createAmazonBedrock` provider was the earlier direct path; it keys its options under `bedrock`
 * and has no adaptive-thinking option for Claude, so the two paths would have diverged exactly where
 * the reasoning setting lives.
 *
 * ## Credentials are the provider's business, gated before any call
 *
 * Direct reads `AWS_BEARER_TOKEN_BEDROCK`, else the SigV4 pair, from the environment the provider is
 * handed. It is lazy: construction succeeds with nothing and the first request fails, which is why
 * `hasConsolidatorCredentials` (`contract.ts`) runs before this is ever called for. Proxied sends
 * `MEMHTML_LLM_API_KEY` as a bearer token when set; with no key the provider still insists on some
 * credential, so a placeholder `x-api-key` goes out that a keyless proxy ignores.
 *
 * ## The output ceiling rides the model
 *
 * Every call carries `maxOutputTokens` (`output-budget.ts`) through `defaultSettingsMiddleware`, so
 * no caller can forget it. Bedrock's own default is 4,096 tokens and the consolidator's answer does
 * not fit (issue #113); the ceiling covers reasoning and answer together, because adaptive thinking
 * reports reasoning as output tokens rather than adding a budget on top.
 */

/** The model, by its Bedrock inference-profile id. A proxy sees it through `llm-proxy.ts`'s naming. */
export const CONSOLIDATOR_MODEL_ID = "global.anthropic.claude-opus-5"

/**
 * Adaptive thinking at high effort, on the `anthropic` key both paths read. This is what eve used to
 * send for `reasoning: "high"` on this model (its provider mapping, read from the shipped dist), and
 * it was measured live: Opus 5 rejects `thinking: { type: "enabled", budgetTokens }` on Bedrock.
 */
export const REASONING_PROVIDER_OPTIONS = {
  anthropic: { thinking: { type: "adaptive" }, effort: "high" }
} as const

const directModel = (env: Record<string, string | undefined>) =>
  createAmazonBedrockAnthropic({
    region: env.AWS_REGION ?? "us-east-1",
    ...(env.AWS_BEARER_TOKEN_BEDROCK === undefined ? {} : { apiKey: env.AWS_BEARER_TOKEN_BEDROCK })
  })(CONSOLIDATOR_MODEL_ID)

const proxiedModel = (config: ConsolidatorProxy) =>
  createAnthropic({
    baseURL: `${config.baseUrl}/v1`,
    ...(config.apiKey === null ? { apiKey: "none" } : { authToken: config.apiKey })
  })(config.modelFor(CONSOLIDATOR_MODEL_ID))

/** The model for one run, decided by the environment the client was built over. */
export const consolidatorModel = (env: Record<string, string | undefined>): LanguageModel => {
  const proxy = proxyFromEnv(env)
  return wrapLanguageModel({
    model: proxy === null ? directModel(env) : proxiedModel(proxy),
    middleware: defaultSettingsMiddleware({
      settings: { maxOutputTokens: MODEL_CALL_OUTPUT_TOKEN_LIMIT }
    })
  })
}

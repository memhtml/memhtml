import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { modelByKey, proxyConfigFromEnv, proxyModelId } from "@memhtml/llm"
import { defaultSettingsMiddleware, type LanguageModel, wrapLanguageModel } from "ai"
import { Effect } from "effect"

import { DEFAULT_BUDGET } from "./budget.js"
import { CuratorModelSpecInvalid } from "./errors.js"
import { fakeCuratorModel } from "./fake-model.js"

/**
 * The model behind one run, from a `--model` spec: `fake`, `bedrock:<modelId>`, or `proxy:<model>`.
 *
 * Bedrock goes through `@ai-sdk/amazon-bedrock` with the region from `AWS_REGION` and credentials
 * from the default chain (`fromNodeProviderChain`: environment, profile, SSO, container, instance
 * role), unless `AWS_BEARER_TOKEN_BEDROCK` is set, in which case the provider reads that itself. The
 * proxy goes through `@ai-sdk/openai-compatible` against `MEMHTML_LLM_BASE_URL/v1`, naming the model
 * the way every other memhtml lane does (`proxyModelId`: the map's exact name, else the prefix from
 * `MEMHTML_LLM_MODEL_PREFIX` and the id). Both are wrapped so every call carries
 * `maxOutputTokens`: unset, Bedrock applies its own 4,096 and truncates.
 */

export type CuratorModelSpec =
  | { readonly kind: "fake" }
  | { readonly kind: "bedrock"; readonly modelId: string }
  | { readonly kind: "proxy"; readonly model: string }

/** The model a `proxy:` spec with no id, and the CLI's default, resolve to. */
export const DEFAULT_CURATOR_MODEL_ID = modelByKey("opus-5").modelId

export const MODEL_SPEC_PREFIXES = ["fake", "bedrock:", "proxy:"] as const

/** The environment variable `memhtml curate run` reads its default `--model` from. */
export const CURATOR_MODEL_VAR = "MEMHTML_CURATOR_MODEL"

/**
 * The spec a string names, or the reason it names none. Pure, so `run.ts` can judge a flag at exit 2
 * before any repo opens; {@link parseModelSpec} is the same function as an effect.
 */
export const modelSpecOf = (
  spec: string
):
  | { readonly ok: true; readonly spec: CuratorModelSpec }
  | { readonly ok: false; readonly reason: string } => {
  const trimmed = spec.trim()
  if (trimmed === "fake") return { ok: true, spec: { kind: "fake" } }
  const at = trimmed.indexOf(":")
  const prefix = at === -1 ? trimmed : trimmed.slice(0, at)
  const rest = at === -1 ? "" : trimmed.slice(at + 1).trim()
  if (prefix === "bedrock" || prefix === "proxy") {
    if (rest === "") {
      return {
        ok: false,
        reason: `${prefix}: needs a model id after the colon, e.g. ${prefix}:${DEFAULT_CURATOR_MODEL_ID}`
      }
    }
    return {
      ok: true,
      spec:
        prefix === "bedrock" ? { kind: "bedrock", modelId: rest } : { kind: "proxy", model: rest }
    }
  }
  return {
    ok: false,
    reason: `a model spec is one of ${MODEL_SPEC_PREFIXES.map((p) => (p === "fake" ? p : `${p}<model>`)).join(", ")}`
  }
}

export const parseModelSpec = (
  spec: string
): Effect.Effect<CuratorModelSpec, CuratorModelSpecInvalid> => {
  const parsed = modelSpecOf(spec)
  return parsed.ok
    ? Effect.succeed(parsed.spec)
    : Effect.fail(CuratorModelSpecInvalid.make({ spec, reason: parsed.reason }))
}

export interface CuratorModelOptions {
  readonly env?: Record<string, string | undefined> | undefined
  /** Per-call output ceiling; defaults to the budget's. */
  readonly maxOutputTokens?: number | undefined
}

const bedrockModel = (modelId: string, env: Record<string, string | undefined>): LanguageModelV4 =>
  createAmazonBedrock({
    region: env.AWS_REGION ?? "us-east-1",
    ...(env.AWS_BEARER_TOKEN_BEDROCK === undefined || env.AWS_BEARER_TOKEN_BEDROCK === ""
      ? { credentialProvider: fromNodeProviderChain() }
      : {})
  })(modelId)

const proxyModel = (
  spec: string,
  model: string,
  env: Record<string, string | undefined>
): Effect.Effect<LanguageModelV4, CuratorModelSpecInvalid> =>
  Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () => proxyConfigFromEnv(env),
      catch: (cause) =>
        CuratorModelSpecInvalid.make({
          spec,
          reason: cause instanceof Error ? cause.message : String(cause)
        })
    })
    if (config === null) {
      return yield* Effect.fail(
        CuratorModelSpecInvalid.make({
          spec,
          reason: "proxy: needs MEMHTML_LLM_BASE_URL, the proxy's origin, in the environment"
        })
      )
    }
    return createOpenAICompatible({
      name: "memhtml-proxy",
      baseURL: `${config.baseUrl}/v1`,
      ...(config.apiKey === null ? {} : { apiKey: config.apiKey })
    }).chatModel(proxyModelId(config, model))
  })

/**
 * The wrap every curator model gets: `maxOutputTokens` on every call. Unset, Bedrock applies its own
 * 4,096 and truncates a long tool call mid-argument. Exported so the wrap itself is testable with a
 * recording model; {@link curatorModel} is the only production caller.
 */
export const withOutputCeiling = (
  model: LanguageModelV4,
  maxOutputTokens: number = DEFAULT_BUDGET.maxOutputTokensPerCall
): LanguageModel =>
  wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({ settings: { maxOutputTokens } })
  })

/** The model for one run. Construction is lazy on both providers: nothing is called here. */
export const curatorModel = (
  spec: string,
  options: CuratorModelOptions = {}
): Effect.Effect<LanguageModel, CuratorModelSpecInvalid> =>
  Effect.gen(function* () {
    const env = options.env ?? process.env
    const parsed = yield* parseModelSpec(spec)
    const model: LanguageModelV4 =
      parsed.kind === "fake"
        ? fakeCuratorModel()
        : parsed.kind === "bedrock"
          ? bedrockModel(parsed.modelId, env)
          : yield* proxyModel(spec, parsed.model, env)
    return withOutputCeiling(model, options.maxOutputTokens)
  })

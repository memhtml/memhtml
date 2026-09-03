import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { LlmConfig } from "../src/client.js"
import { Embeddings, EmbeddingsLive } from "../src/embeddings.js"
import { ModelClient, ModelClientLive } from "../src/model-client.js"

/**
 * A declared service that nothing constructs is worse than a missing one: a port whose
 * claimed implementation defines none of its methods fails at the first call, in
 * production, with no covering test. These build the real layers and read every method
 * off the resulting service — no Bedrock call is made, but a layer that fails to
 * construct, or a shape missing a method, fails here.
 */

const withEnv = <A, E, R>(env: Record<string, string>, program: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.provideService(
      program,
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env })
    ) as Effect.Effect<A, E, never>
  )

describe("LlmConfig", () => {
  it("defaults the region to where both model families are reachable, and to Bedrock direct", async () => {
    expect(await withEnv({}, LlmConfig)).toEqual({ region: "us-east-1", proxy: null })
  })

  it("honors MEMHTML_AWS_REGION", async () => {
    expect(await withEnv({ MEMHTML_AWS_REGION: "us-west-2" }, LlmConfig)).toEqual({
      region: "us-west-2",
      proxy: null
    })
  })

  /**
   * The proxy is one variable to turn on. The other two are optional, a trailing slash on the
   * origin is tolerated, and a blank key is no key — a blank export is how a variable goes missing,
   * and `Authorization: Bearer ` with nothing after it would be sent as a credential.
   */
  it("reads an LLM proxy from MEMHTML_LLM_BASE_URL, with the key and the model map optional", async () => {
    const bare = await withEnv({ MEMHTML_LLM_BASE_URL: "http://127.0.0.1:4000/" }, LlmConfig)
    expect(bare.proxy).toEqual({
      baseUrl: "http://127.0.0.1:4000",
      apiKey: null,
      modelPrefix: "bedrock/",
      modelMap: new Map()
    })

    const full = await withEnv(
      {
        MEMHTML_LLM_BASE_URL: "https://llm.example.internal",
        MEMHTML_LLM_API_KEY: "  secret  ",
        MEMHTML_LLM_MODEL_MAP:
          "global.anthropic.claude-opus-5=claude-opus-5, cohere.embed-v4:0=cohere-embed-v4,"
      },
      LlmConfig
    )
    expect(full.proxy?.apiKey).toBe("secret")
    expect(full.proxy?.modelPrefix).toBe("bedrock/")
    expect(full.proxy?.modelMap.get("global.anthropic.claude-opus-5")).toBe("claude-opus-5")
    expect(full.proxy?.modelMap.get("cohere.embed-v4:0")).toBe("cohere-embed-v4")
  })

  /**
   * `Config` reads an empty value as ABSENT (probed against the pinned release), which is why the
   * disable sentinel is the word `none` and not "": the first case pins that "" still lands on the
   * default through this path, so the sleep lanes and the consolidator cannot disagree about it.
   */
  it("reads MEMHTML_LLM_MODEL_PREFIX: blank is the default, `none` is no prefix, a set one is as written", async () => {
    const blank = await withEnv(
      { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_MODEL_PREFIX: "" },
      LlmConfig
    )
    expect(blank.proxy?.modelPrefix).toBe("bedrock/")
    const bare = await withEnv(
      { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_MODEL_PREFIX: "none" },
      LlmConfig
    )
    expect(bare.proxy?.modelPrefix).toBe("")
    const custom = await withEnv(
      { MEMHTML_LLM_BASE_URL: "http://h", MEMHTML_LLM_MODEL_PREFIX: " aws/ " },
      LlmConfig
    )
    expect(custom.proxy?.modelPrefix).toBe("aws/")
  })

  it("treats a blank MEMHTML_LLM_BASE_URL as Bedrock direct", async () => {
    expect((await withEnv({ MEMHTML_LLM_BASE_URL: "   " }, LlmConfig)).proxy).toBeNull()
  })

  /**
   * A set-but-unusable value dies with the variable named rather than falling back to the direct
   * path: silently routing a night's traffic somewhere the operator did not point it is the
   * failure this exists to prevent. (Mutation: returning `null` from `normalizeProxyBaseUrl`'s
   * throw site passes the previous case and fails these two.)
   */
  it("refuses a proxy origin without a scheme, naming the variable", async () => {
    await expect(withEnv({ MEMHTML_LLM_BASE_URL: "127.0.0.1:4000" }, LlmConfig)).rejects.toThrow(
      /MEMHTML_LLM_BASE_URL/
    )
  })

  it("refuses a malformed model map entry, naming the entry", async () => {
    await expect(
      withEnv(
        { MEMHTML_LLM_BASE_URL: "http://127.0.0.1:4000", MEMHTML_LLM_MODEL_MAP: "claude-opus-5" },
        LlmConfig
      )
    ).rejects.toThrow(/MEMHTML_LLM_MODEL_MAP.*"claude-opus-5"/)
  })
})

describe("EmbeddingsLive", () => {
  it("constructs a service carrying both embed entry points", async () => {
    const service = await withEnv({}, Effect.scoped(Effect.provide(Embeddings, EmbeddingsLive)))
    expect(typeof service.embed).toBe("function")
    expect(typeof service.embedQuery).toBe("function")
  })
})

describe("ModelClientLive", () => {
  it("constructs a service carrying both generation entry points", async () => {
    const service = await withEnv({}, Effect.scoped(Effect.provide(ModelClient, ModelClientLive)))
    expect(typeof service.generate).toBe("function")
    expect(typeof service.generateObject).toBe("function")
  })
})

describe("layer composition", () => {
  it("merges into one layer, so a caller provides both from a single Layer.provide", async () => {
    const both = Layer.merge(EmbeddingsLive, ModelClientLive)
    const service = await withEnv(
      {},
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const embeddings = yield* Embeddings
            const models = yield* ModelClient
            return { embeddings, models }
          }),
          both
        )
      )
    )
    expect(typeof service.embeddings.embed).toBe("function")
    expect(typeof service.models.generateObject).toBe("function")
  })
})

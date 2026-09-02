import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { Effect, Schedule } from "effect"
import { describe, expect, it } from "vitest"
import { invokeJson } from "../src/client.js"
import { EMBED_DIM, EMBED_MODEL_ID } from "../src/constants.js"
import { buildEmbedBody, makeEmbeddings } from "../src/embeddings.js"
import { makeModelClient } from "../src/model-client.js"
import {
  fromProxyResponse,
  isRetryableProxyFailure,
  makeProxyClient,
  type ProxyFetch,
  ProxyHttpError,
  proxyRouteFor,
  toProxyRequest
} from "../src/proxy.js"
import {
  normalizeProxyBaseUrl,
  type ProxyConfig,
  parseProxyModelMap,
  proxyConfigFromEnv,
  proxyModelId,
  proxyModelPrefix
} from "../src/proxy-config.js"
import { buildInvokeBody } from "../src/wire.js"

/**
 * The LLM-proxy transport, asserted against the bytes that would go to the proxy rather than
 * against a mock's recollection — the same posture `fake-client.ts` takes toward Bedrock. Every
 * case runs with no network: `fetch` is a recorder handed in through `ProxyClientOptions`.
 */

const CONFIG: ProxyConfig = {
  baseUrl: "http://127.0.0.1:4000",
  apiKey: "k",
  modelPrefix: "bedrock/",
  modelMap: new Map([
    ["global.anthropic.claude-opus-5", "claude-opus-5"],
    [EMBED_MODEL_ID, "cohere-embed-v4"]
  ])
}

interface Call {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

/** A recording `fetch`. `answer` receives the 0-based call offset so a test can script a retry. */
const recorder = (answer: (offset: number) => { status: number; body: unknown }) => {
  const calls: Array<Call> = []
  const fetchImpl: ProxyFetch = (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>
    })
    const reply = answer(calls.length - 1)
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(JSON.stringify(reply.body))
    })
  }
  return { calls, fetchImpl }
}

const command = (modelId: string, body: string) =>
  new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body
  })

const signal = () => new AbortController().signal

/** No delay between attempts, so the retry cases run in milliseconds. */
const IMMEDIATE = Schedule.recurs(5)

describe("proxyConfigFromEnv", () => {
  it("is null when the base URL is absent or blank", () => {
    expect(proxyConfigFromEnv({})).toBeNull()
    expect(proxyConfigFromEnv({ MEMHTML_LLM_BASE_URL: "  " })).toBeNull()
  })

  it("normalizes the origin, trims the key, parses the map, and defaults the prefix to bedrock/", () => {
    const config = proxyConfigFromEnv({
      MEMHTML_LLM_BASE_URL: " http://127.0.0.1:4000// ",
      MEMHTML_LLM_API_KEY: " k ",
      MEMHTML_LLM_MODEL_MAP: "a=b"
    })
    expect(config).toEqual({
      baseUrl: "http://127.0.0.1:4000",
      apiKey: "k",
      modelPrefix: "bedrock/",
      modelMap: new Map([["a", "b"]])
    })
  })

  /**
   * Unset and blank are the LiteLLM default; the word `none` is "this proxy wants bare Bedrock ids".
   * A word rather than "" because `effect/Config` reads "" as absent, and the consolidator reads the
   * same variable from `process.env` — the two paths must agree. (Mutation: dropping the `none` arm
   * fails the second and fourth assertions.)
   */
  it("takes MEMHTML_LLM_MODEL_PREFIX as written, with `none` meaning no prefix and blank the default", () => {
    expect(proxyModelPrefix(undefined)).toBe("bedrock/")
    expect(proxyModelPrefix("none")).toBe("")
    expect(proxyModelPrefix(" NONE ")).toBe("")
    expect(proxyModelPrefix("")).toBe("bedrock/")
    expect(proxyModelPrefix(" litellm/ ")).toBe("litellm/")
    const bare = proxyConfigFromEnv({
      MEMHTML_LLM_BASE_URL: "http://h",
      MEMHTML_LLM_MODEL_PREFIX: "none"
    })
    expect(bare?.modelPrefix).toBe("")
  })

  it("requires an http(s) scheme", () => {
    expect(() => normalizeProxyBaseUrl("localhost:4000")).toThrow(/MEMHTML_LLM_BASE_URL/)
    expect(() => normalizeProxyBaseUrl("ftp://x")).toThrow(/MEMHTML_LLM_BASE_URL/)
    expect(normalizeProxyBaseUrl("https://x.y/")).toBe("https://x.y")
  })

  it("rejects a map entry with no `=`, an empty side, or a duplicate key", () => {
    expect(() => parseProxyModelMap("a")).toThrow(/"a"/)
    expect(() => parseProxyModelMap("a=")).toThrow(/"a="/)
    expect(() => parseProxyModelMap("=b")).toThrow(/"=b"/)
    expect(() => parseProxyModelMap("a=b,a=c")).toThrow(/twice/)
    expect(parseProxyModelMap(" , ")).toEqual(new Map())
  })

  it("names an unmapped id with the prefix and a mapped id exactly as mapped", () => {
    expect(proxyModelId(CONFIG, "global.openai.gpt-5.6-sol")).toBe(
      "bedrock/global.openai.gpt-5.6-sol"
    )
    expect(proxyModelId(CONFIG, "global.anthropic.claude-opus-5")).toBe("claude-opus-5")
    expect(proxyModelId({ ...CONFIG, modelPrefix: "" }, "global.openai.gpt-5.6-sol")).toBe(
      "global.openai.gpt-5.6-sol"
    )
  })
})

describe("proxyRouteFor", () => {
  it("routes by model id: Anthropic to messages, OpenAI to completions, the embedder to embeddings", () => {
    expect(proxyRouteFor("global.anthropic.claude-opus-5")).toBe("messages")
    expect(proxyRouteFor("global.anthropic.claude-sonnet-5")).toBe("messages")
    expect(proxyRouteFor("global.openai.gpt-5.6-sol")).toBe("completions")
    expect(proxyRouteFor(EMBED_MODEL_ID)).toBe("embeddings")
    expect(proxyRouteFor("amazon.nova-pro-v1:0")).toBeNull()
  })
})

describe("toProxyRequest", () => {
  it("turns the Bedrock Anthropic body into a Messages request: model in, anthropic_version out", () => {
    const body = JSON.parse(
      buildInvokeBody("opus-5", "hi", {
        system: "sys",
        effort: "high",
        cacheSystem: true,
        maxTokens: 1000
      })
    ) as Record<string, unknown>
    const request = toProxyRequest(CONFIG, "global.anthropic.claude-opus-5", body)
    expect(request?.path).toBe("/v1/messages")
    expect(request?.body.model).toBe("claude-opus-5")
    expect(request?.body).not.toHaveProperty("anthropic_version")
    // Everything the Messages dialect already carried rides through untouched.
    expect(request?.body.max_tokens).toBe(1000)
    expect(request?.body.thinking).toEqual({ type: "adaptive" })
    expect(request?.body.output_config).toEqual({ effort: "high" })
    expect(request?.body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } }
    ])
  })

  it("turns the Bedrock OpenAI body into a chat-completions request by adding the model", () => {
    const body = JSON.parse(
      buildInvokeBody("gpt-5.6-sol", "hi", { effort: "low", maxTokens: 500 })
    ) as Record<string, unknown>
    const request = toProxyRequest(CONFIG, "global.openai.gpt-5.6-sol", body)
    expect(request?.path).toBe("/v1/chat/completions")
    expect(request?.body).toEqual({ ...body, model: "bedrock/global.openai.gpt-5.6-sol" })
  })

  /**
   * The embedding lane is the one whose shape changes, and every field that changes is named. The
   * `input_type` passthrough is the one that matters most: it is what keeps documents and queries in
   * their two regions of Cohere's space (`embeddings.ts`).
   */
  it("turns the Cohere body into an OpenAI embeddings request that keeps input_type and dimensions", () => {
    const body = JSON.parse(buildEmbedBody(["a", "b"], "search_query")) as Record<string, unknown>
    const request = toProxyRequest(CONFIG, EMBED_MODEL_ID, body)
    expect(request?.path).toBe("/v1/embeddings")
    expect(request?.body).toEqual({
      model: "cohere-embed-v4",
      input: ["a", "b"],
      input_type: "search_query",
      dimensions: EMBED_DIM,
      encoding_format: "float"
    })
  })

  it("is null for a model this package does not call", () => {
    expect(toProxyRequest(CONFIG, "amazon.nova-pro-v1:0", {})).toBeNull()
  })
})

describe("fromProxyResponse", () => {
  it("passes chat payloads through untouched", () => {
    const payload = { stop_reason: "end_turn", content: [] }
    expect(fromProxyResponse("messages", payload)).toBe(payload)
    expect(fromProxyResponse("completions", payload)).toBe(payload)
  })

  it("folds OpenAI embeddings into Cohere's shape, ordered by index", () => {
    const folded = fromProxyResponse("embeddings", {
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] }
      ]
    })
    expect(folded).toEqual({
      embeddings: {
        float: [
          [1, 1],
          [2, 2]
        ]
      }
    })
  })

  it("folds an off-shape embeddings payload to no vectors, which the reader then refuses by count", () => {
    expect(fromProxyResponse("embeddings", { error: "nope" })).toEqual({
      embeddings: { float: [] }
    })
  })
})

describe("makeProxyClient", () => {
  it("posts to the mapped route with the bearer header and returns the payload bytes", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { output_tokens: 1 }
      }
    }))
    const client = makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    const payload = await Effect.runPromise(
      invokeJson(
        client,
        "global.anthropic.claude-opus-5",
        buildInvokeBody("opus-5", "hi", { effort: "low" })
      )
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/messages")
    expect(calls[0]?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer k"
    })
    expect(calls[0]?.body.model).toBe("claude-opus-5")
    expect(payload).toEqual({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { output_tokens: 1 }
    })
  })

  it("sends no authorization header when the proxy takes no key", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: {} }))
    const client = makeProxyClient(
      { ...CONFIG, apiKey: null },
      { fetch: fetchImpl, schedule: IMMEDIATE }
    )
    await client.send(command("global.openai.gpt-5.6-sol", "{}"), { abortSignal: signal() })
    expect(calls[0]?.headers).toEqual({ "content-type": "application/json" })
  })

  /** End to end through the real embedder: the fold is what lets `readEmbeddings` accept the answer. */
  it("serves the embedder, folding the OpenAI response back into vectors", async () => {
    const vector = (seed: number) => Array.from({ length: EMBED_DIM }, (_, i) => (seed + i) / 1000)
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: {
        object: "list",
        data: [
          { index: 0, embedding: vector(0) },
          { index: 1, embedding: vector(1) }
        ]
      }
    }))
    const embeddings = makeEmbeddings(
      makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    )
    const vectors = await Effect.runPromise(embeddings.embed(["a", "b"]))
    expect(vectors).toHaveLength(2)
    expect(vectors[1]?.length).toBe(EMBED_DIM)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/embeddings")
    expect(calls[0]?.body.input_type).toBe("search_document")
  })

  /** And the model client, whose incompleteness gate reads the passed-through payload. */
  it("serves the model client, whose truncation gate still fires on the proxied payload", async () => {
    const { fetchImpl } = recorder(() => ({
      status: 200,
      body: { stop_reason: "max_tokens", content: [{ type: "text", text: "cut" }] }
    }))
    const models = makeModelClient(
      makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    )
    const outcome = await Effect.runPromise(
      Effect.result(models.generate("opus-5", "hi", { effort: "low" }))
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure")
      expect(outcome.failure.reason).toContain("stop_reason=max_tokens")
  })

  /**
   * The proxy's own error body reaches the operator. `model_not_found` is the failure a wrong or
   * missing `MEMHTML_LLM_MODEL_MAP` entry produces, and a bare `404` would not say so.
   */
  it("fails a 4xx once, carrying the proxy's status and body verbatim", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 404,
      body: { error: { message: "Model not found", code: "model_not_found" } }
    }))
    const client = makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    const outcome = await Effect.runPromise(
      Effect.result(invokeJson(client, "global.anthropic.claude-opus-5", "{}"))
    )
    expect(calls).toHaveLength(1)
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason).toContain("ProxyHttpError: proxy 404")
      expect(outcome.failure.reason).toContain("model_not_found")
    }
  })

  it("retries a throttle and an upstream failure, then succeeds", async () => {
    const { calls, fetchImpl } = recorder((offset) =>
      offset === 0
        ? { status: 429, body: { error: "slow down" } }
        : offset === 1
          ? { status: 502, body: { error: "upstream" } }
          : { status: 200, body: { stop_reason: "end_turn", content: [] } }
    )
    const client = makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    const payload = await Effect.runPromise(
      invokeJson(client, "global.anthropic.claude-opus-5", "{}")
    )
    expect(calls).toHaveLength(3)
    expect(payload).toEqual({ stop_reason: "end_turn", content: [] })
  })

  it("rejects a model it has no route for, by name, before touching the network", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: {} }))
    const client = makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    await expect(
      client.send(command("amazon.nova-pro-v1:0", "{}"), { abortSignal: signal() })
    ).rejects.toThrow(/amazon\.nova-pro-v1:0/)
    expect(calls).toHaveLength(0)
  })
})

describe("isRetryableProxyFailure", () => {
  it("retries throttles, proxy timeouts, and 5xx; never other 4xx, aborts, or timeouts", () => {
    expect(isRetryableProxyFailure(new ProxyHttpError(429, ""))).toBe(true)
    expect(isRetryableProxyFailure(new ProxyHttpError(408, ""))).toBe(true)
    expect(isRetryableProxyFailure(new ProxyHttpError(503, ""))).toBe(true)
    expect(isRetryableProxyFailure(new ProxyHttpError(400, ""))).toBe(false)
    expect(isRetryableProxyFailure(new ProxyHttpError(404, ""))).toBe(false)
    expect(isRetryableProxyFailure(new TypeError("fetch failed"))).toBe(true)
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(isRetryableProxyFailure(abort)).toBe(false)
    const timeout = new Error("timed out")
    timeout.name = "TimeoutError"
    expect(isRetryableProxyFailure(timeout)).toBe(false)
    expect(isRetryableProxyFailure("string")).toBe(false)
  })
})

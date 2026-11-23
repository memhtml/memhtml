import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { Effect, Schedule, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { invokeJson } from "../src/client.js"
import { EMBED_DIM, EMBED_MODEL_ID, STRUCTURED_TOOL_NAME } from "../src/constants.js"
import { buildEmbedBody, makeEmbeddings } from "../src/embeddings.js"
import { makeModelClient } from "../src/model-client.js"
import {
  fromProxyResponse,
  fromResponsesPayload,
  isRetryableProxyFailure,
  makeProxyClient,
  type ProxyFetch,
  ProxyHttpError,
  proxyRouteFor,
  RESPONSES_MIN_OUTPUT_TOKENS,
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

/**
 * A Responses payload as bedrock-runtime's `/openai/v1/responses` shapes it behind an LLM gateway
 * (probed live 2026-11-23 with `global.openai.gpt-5.6-terra`), cut to the fields that matter and
 * the ones that could be misread: the reasoning item that precedes the message, and the echoed
 * request fields a fold must not take for the answer.
 */
const responsesPayload = (
  text: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: "resp_probe",
  object: "response",
  status: "completed",
  incomplete_details: null,
  error: null,
  model: "global.openai.gpt-5.6-terra",
  output: [
    { type: "reasoning", id: "rs_probe", summary: [], content: [] },
    {
      type: "message",
      id: "msg_probe",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", annotations: [], logprobs: [], text }]
    }
  ],
  usage: {
    input_tokens: 44,
    output_tokens: 12,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 56
  },
  max_output_tokens: 2000,
  store: false,
  text: { format: { type: "json_schema", name: "emit", strict: true } },
  ...overrides
})

/** The same probe cut off by its budget: a reasoning item, no message, `status: "incomplete"`. */
const TRUNCATED_RESPONSES_PAYLOAD = responsesPayload("", {
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [{ type: "reasoning", id: "rs_probe", summary: [], content: [] }],
  usage: { input_tokens: 13, output_tokens: 16, total_tokens: 29 }
})

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
  it("routes by model id: Anthropic to messages, OpenAI to responses, the embedder to embeddings", () => {
    expect(proxyRouteFor("global.anthropic.claude-opus-5")).toBe("messages")
    expect(proxyRouteFor("global.anthropic.claude-sonnet-5")).toBe("messages")
    expect(proxyRouteFor("global.openai.gpt-5.6-sol")).toBe("responses")
    expect(proxyRouteFor("global.openai.gpt-5.6-terra")).toBe("responses")
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

  /**
   * The whole Responses body, by equality, so a chat-completions key that leaked through
   * (`messages`, `max_completion_tokens`, `reasoning_effort`, `response_format`) fails here as an
   * extra key and a dropped one as a missing key.
   */
  it("turns the Bedrock OpenAI structured body into a Responses request", () => {
    const schema = {
      type: "object",
      properties: { color: { type: "string" } },
      required: ["color"],
      additionalProperties: false
    }
    const body = JSON.parse(
      buildInvokeBody(
        "gpt-5.6-terra",
        "hi",
        { system: "sys", effort: "low", maxTokens: 500 },
        { inputSchema: schema, description: "One color." }
      )
    ) as Record<string, unknown>
    const request = toProxyRequest(CONFIG, "global.openai.gpt-5.6-terra", body)
    expect(request?.route).toBe("responses")
    expect(request?.path).toBe("/v1/responses")
    expect(request?.body).toEqual({
      model: "bedrock/global.openai.gpt-5.6-terra",
      instructions: "sys",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 500,
      reasoning: { effort: "low" },
      prompt_cache_options: { mode: "explicit" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: STRUCTURED_TOOL_NAME,
          strict: true,
          schema: { description: "One color.", ...schema }
        }
      }
    })
  })

  it("sends a prose request with no instructions and no text format when it has neither", () => {
    const body = JSON.parse(
      buildInvokeBody("gpt-5.6-sol", "hi", { effort: "xhigh", openaiPromptCache: "implicit" })
    ) as Record<string, unknown>
    expect(toProxyRequest(CONFIG, "global.openai.gpt-5.6-sol", body)?.body).toEqual({
      model: "bedrock/global.openai.gpt-5.6-sol",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 64_000,
      reasoning: { effort: "xhigh" },
      store: false
    })
  })

  /**
   * Chat completions takes a budget of 1 and Responses refuses anything under its minimum with a
   * 400, so the smallest budget `clampTokens` yields is raised to the smallest this route accepts.
   * The answer is still truncated there, so it reaches the truncation gate and not the caller.
   */
  it("raises a budget under the Responses minimum to the minimum, and leaves one at it alone", () => {
    const budgetFor = (maxTokens: number) =>
      toProxyRequest(
        CONFIG,
        "global.openai.gpt-5.6-sol",
        JSON.parse(buildInvokeBody("gpt-5.6-sol", "hi", { effort: "low", maxTokens })) as Record<
          string,
          unknown
        >
      )?.body.max_output_tokens
    expect(RESPONSES_MIN_OUTPUT_TOKENS).toBe(16)
    expect(budgetFor(0)).toBe(16)
    expect(budgetFor(15)).toBe(16)
    expect(budgetFor(16)).toBe(16)
    expect(budgetFor(17)).toBe(17)
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
  it("passes a Messages payload through untouched", () => {
    const payload = { stop_reason: "end_turn", content: [] }
    expect(fromProxyResponse("messages", payload)).toBe(payload)
  })

  it("folds a completed Responses payload into the chat-completions payload", () => {
    expect(fromProxyResponse("responses", responsesPayload('{"color":"blue"}'))).toEqual({
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: '{"color":"blue"}' } }
      ],
      usage: { prompt_tokens: 44, completion_tokens: 12 }
    })
  })

  /** The first item is not a message, so its part is skipped even though its type is the answer's. */
  it("concatenates every output_text part of every message item, and nothing else", () => {
    const folded = fromResponsesPayload(
      responsesPayload("", {
        output: [
          { type: "reasoning", content: [{ type: "output_text", text: "thinking" }] },
          {
            type: "message",
            content: [
              { type: "output_text", text: '{"a":' },
              { type: "refusal", refusal: "no" },
              { type: "output_text", text: "1" }
            ]
          },
          { type: "function_call", name: "emit", arguments: "{}" },
          { type: "message", content: [{ type: "output_text", text: "}" }] }
        ]
      })
    ) as { choices: Array<{ message: { content: string | null } }> }
    expect(folded.choices[0]?.message.content).toBe('{"a":1}')
  })

  /**
   * `incomplete` is the truncation stop under its chat-completions name unless the details name
   * the content filter; a status the fold does not know stays itself, so it is never read as
   * `stop`. (Mutation: folding every non-completed status to `length` fails the last two.)
   */
  it("maps status onto finish_reason: completed, incomplete by its reason, anything else as itself", () => {
    const finishOf = (payload: unknown) =>
      (fromResponsesPayload(payload) as { choices: Array<{ finish_reason: string | null }> })
        .choices[0]?.finish_reason
    expect(finishOf(responsesPayload("ok"))).toBe("stop")
    expect(finishOf(TRUNCATED_RESPONSES_PAYLOAD)).toBe("length")
    expect(finishOf(responsesPayload("", { status: "incomplete", incomplete_details: null }))).toBe(
      "length"
    )
    expect(
      finishOf(
        responsesPayload("", {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" }
        })
      )
    ).toBe("content_filter")
    expect(finishOf(responsesPayload("", { status: "failed" }))).toBe("failed")
    expect(finishOf({})).toBeNull()
  })

  it("folds an off-shape Responses payload to an empty message with no usage", () => {
    for (const payload of [null, {}, { output: "nope", usage: { input_tokens: "3" } }]) {
      expect(fromResponsesPayload(payload)).toEqual({
        choices: [{ finish_reason: null, message: { role: "assistant", content: null } }],
        usage: {}
      })
    }
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

  /**
   * The bytes on the wire to the proxy's Responses route carry the cache-off field under the
   * default, and not under `implicit`. Asserted here and not only in `wire.test.ts` because this is
   * the transport memhtml runs behind in practice, and a proxy translation that rebuilt the body
   * from known fields would drop exactly this one.
   */
  it("carries prompt_cache_options to the Responses route by default, and omits it under implicit", async () => {
    const reply = () => ({ status: 200, body: responsesPayload("ok") })
    const byDefault = recorder(reply)
    await Effect.runPromise(
      makeModelClient(
        makeProxyClient(CONFIG, { fetch: byDefault.fetchImpl, schedule: IMMEDIATE })
      ).generate("gpt-5.6-sol", "hi", { effort: "low", system: "s" })
    )
    expect(byDefault.calls[0]?.url).toBe("http://127.0.0.1:4000/v1/responses")
    expect(byDefault.calls[0]?.body.prompt_cache_options).toEqual({ mode: "explicit" })

    const implicit = recorder(reply)
    await Effect.runPromise(
      makeModelClient(makeProxyClient(CONFIG, { fetch: implicit.fetchImpl, schedule: IMMEDIATE }), {
        openaiPromptCache: "implicit"
      }).generate("gpt-5.6-sol", "hi", { effort: "low", system: "s" })
    )
    expect(implicit.calls[0]?.body).not.toHaveProperty("prompt_cache_options")
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
   * The OpenAI lane end to end over the proxy: the prose answer and its usage come back through
   * the fold as the `Generation` the direct path returns for the same answer.
   */
  it("serves an OpenAI prose call on the Responses route, with text and usage", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: responsesPayload("Paris") }))
    const models = makeModelClient(
      makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    )
    const generation = await Effect.runPromise(
      models.generate("gpt-5.6-sol", "Capital of France?", { effort: "low", system: "One word." })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/responses")
    expect(calls[0]?.body.instructions).toBe("One word.")
    expect(generation.text).toBe("Paris")
    expect(generation.inputTokens).toBe(44)
    expect(generation.outputTokens).toBe(12)
  })

  it("serves an OpenAI structured call on the Responses route, decoding the schema-shaped answer", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: responsesPayload('{"color":"blue"}')
    }))
    const models = makeModelClient(
      makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    )
    const value = await Effect.runPromise(
      models.generateObject({
        schema: Schema.Struct({ color: Schema.String }),
        prompt: "Sky color?",
        modelKey: "gpt-5.6-terra",
        effort: "low"
      })
    )
    expect(value).toEqual({ color: "blue" })
    expect(calls[0]?.body.text).toMatchObject({
      format: { type: "json_schema", name: STRUCTURED_TOOL_NAME, strict: true }
    })
    expect(calls[0]?.body).not.toHaveProperty("response_format")
  })

  /** `status: "incomplete"` fails the call exactly as a `length` stop does on the direct path. */
  it("fails a truncated Responses answer as an incomplete response, on both entry points", async () => {
    const { fetchImpl } = recorder(() => ({ status: 200, body: TRUNCATED_RESPONSES_PAYLOAD }))
    const models = makeModelClient(
      makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    )
    const prose = await Effect.runPromise(
      Effect.result(models.generate("gpt-5.6-sol", "hi", { effort: "low", maxTokens: 1 }))
    )
    expect(prose._tag).toBe("Failure")
    if (prose._tag === "Failure") {
      expect(prose.failure._tag).toBe("ModelUnavailable")
      expect(prose.failure.reason).toBe("incomplete response: stop_reason=max_tokens")
    }
    const structured = await Effect.runPromise(
      Effect.result(
        models.generateObject({
          schema: Schema.Struct({ color: Schema.String }),
          prompt: "hi",
          modelKey: "gpt-5.6-terra",
          effort: "low"
        })
      )
    )
    expect(structured._tag).toBe("Failure")
    if (structured._tag === "Failure") {
      expect(structured.failure._tag).toBe("ModelUnavailable")
    }
  })

  /** A Responses answer that is not the schema's JSON is the contract violation it is directly. */
  it("reports a completed Responses answer with no parseable JSON as a contract violation", async () => {
    const { fetchImpl } = recorder(() => ({ status: 200, body: responsesPayload("not json") }))
    const models = makeModelClient(
      makeProxyClient(CONFIG, { fetch: fetchImpl, schedule: IMMEDIATE })
    )
    const outcome = await Effect.runPromise(
      Effect.result(
        models.generateObject({
          schema: Schema.Struct({ color: Schema.String }),
          prompt: "hi",
          modelKey: "gpt-5.6-terra",
          effort: "low"
        })
      )
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("LlmContractViolation")
  })

  it("retries a throttled Responses call and fails a 400 once with the proxy's body", async () => {
    const throttled = recorder((offset) =>
      offset === 0
        ? { status: 429, body: { error: "slow down" } }
        : { status: 200, body: responsesPayload("ok") }
    )
    const generation = await Effect.runPromise(
      makeModelClient(
        makeProxyClient(CONFIG, { fetch: throttled.fetchImpl, schedule: IMMEDIATE })
      ).generate("gpt-5.6-sol", "hi", { effort: "low" })
    )
    expect(throttled.calls).toHaveLength(2)
    expect(generation.text).toBe("ok")

    const refused = recorder(() => ({
      status: 400,
      body: { error: { code: "integer_below_min_value", param: "max_output_tokens" } }
    }))
    const outcome = await Effect.runPromise(
      Effect.result(
        makeModelClient(
          makeProxyClient(CONFIG, { fetch: refused.fetchImpl, schedule: IMMEDIATE })
        ).generate("gpt-5.6-sol", "hi", { effort: "low" })
      )
    )
    expect(refused.calls).toHaveLength(1)
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason).toContain("ProxyHttpError: proxy 400")
      expect(outcome.failure.reason).toContain("integer_below_min_value")
    }
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

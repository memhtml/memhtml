import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { Effect, Result, Schedule } from "effect"

import {
  type InvokeClient,
  type LlmConfigShape,
  makeBedrockClient,
  REQUEST_HANDLER_OPTIONS
} from "./client.js"
import { EMBED_MODEL_ID } from "./constants.js"
import { MODELS } from "./models.js"
import { type ProxyConfig, proxyModelId } from "./proxy-config.js"

/**
 * An {@link InvokeClient} over an OpenAI- and Anthropic-compatible LLM proxy.
 *
 * The shape is the point. Every lane in this package — the model client and the embedder — is
 * written against `InvokeClient`, whose one method takes a Bedrock `InvokeModelCommand` and answers
 * with the response bytes. Satisfying that same interface from a proxy means neither lane, nor
 * any of their tests, learns that a second transport exists: `buildInvokeBody` still emits the
 * Bedrock body, the recorder fakes still see it, and the translation to the proxy's routes happens
 * here, once, at the wire.
 *
 * Each provider is called on its own native API. Bedrock's InvokeModel body for an Anthropic model
 * IS the Anthropic Messages body (minus a `model` field and plus an `anthropic_version`), so that
 * lane passes through. An OpenAI model's native API is Responses, while Bedrock's InvokeModel body
 * for it is the chat-completions body, so that lane is translated in both directions: the request
 * becomes a Responses request and the Responses answer is folded back into the chat-completions
 * payload `normalizeOpenAiResponse` reads. The embedding lane is translated the same way: Cohere's
 * native request becomes an OpenAI embeddings request and the response is folded back into the
 * Cohere shape `readEmbeddings` reads.
 *
 * Routes are selected by MODEL ID rather than by sniffing the body, so a request for a model this
 * package does not know fails here, by name, instead of reaching the proxy on a guessed route.
 */

/** Which of the proxy's routes a model id is served on. */
export type ProxyRoute = "messages" | "responses" | "embeddings"

export const PROXY_ROUTE_PATHS: Readonly<Record<ProxyRoute, string>> = {
  messages: "/v1/messages",
  responses: "/v1/responses",
  embeddings: "/v1/embeddings"
}

/**
 * The route for a model id, or `null` for an id this package does not call. Anthropic models speak
 * Messages, OpenAI models speak Responses, and the one embedding model is its own lane.
 */
export const proxyRouteFor = (modelId: string): ProxyRoute | null => {
  if (modelId === EMBED_MODEL_ID) return "embeddings"
  const model = MODELS.find((candidate) => candidate.modelId === modelId)
  if (model === undefined) return null
  return model.provider === "openai" ? "responses" : "messages"
}

export interface ProxyRequest {
  readonly route: ProxyRoute
  readonly path: string
  readonly body: Record<string, unknown>
}

/**
 * Translate one InvokeModel request into the proxy's request for it. Pure, so the wire test pins
 * every field against the bytes that would go out.
 *
 * `model` is the proxy's name for the Bedrock id (`proxyModelId`: `bedrock/<id>` by default, or the
 * map's exact name).
 *
 * - Messages: `anthropic_version` is Bedrock's field and the Messages API has no such key, so it is
 *   dropped; `model` is added. Everything else — `max_tokens`, `system` (with any cache marker),
 *   `thinking`, `output_config`, `tools`, `tool_choice` — is already the Messages dialect.
 * - Responses: {@link toResponsesBody} rewrites the chat-completions body field by field.
 * - Embeddings: Cohere's `texts` becomes `input`, `output_dimension` becomes `dimensions`, and
 *   `input_type` rides through under its own name — the proxy forwards it to Cohere, and it is the
 *   field the retrieval asymmetry depends on (`embeddings.ts`). `encoding_format: "float"` asks
 *   for the plain arrays the fold below reads.
 */
export const toProxyRequest = (
  config: ProxyConfig,
  modelId: string,
  body: Record<string, unknown>
): ProxyRequest | null => {
  const route = proxyRouteFor(modelId)
  if (route === null) return null
  const model = proxyModelId(config, modelId)
  if (route === "messages") {
    const { anthropic_version: _dropped, ...rest } = body
    return { route, path: PROXY_ROUTE_PATHS[route], body: { model, ...rest } }
  }
  if (route === "responses") {
    return { route, path: PROXY_ROUTE_PATHS[route], body: toResponsesBody(model, body) }
  }
  return {
    route,
    path: PROXY_ROUTE_PATHS[route],
    body: {
      model,
      input: body.texts,
      ...(body.input_type === undefined ? {} : { input_type: body.input_type }),
      ...(body.output_dimension === undefined ? {} : { dimensions: body.output_dimension }),
      encoding_format: "float"
    }
  }
}

/**
 * The smallest `max_output_tokens` the Responses API accepts. Probed live 2026-11-23 against an LLM
 * gateway fronting bedrock-runtime's `/openai/v1/responses` with `global.openai.gpt-5.6-terra`: a
 * budget of 1 answers 400 `integer_below_min_value` ("Expected a value >= 16"), and 16 answers 200
 * with `status: "incomplete"`.
 */
export const RESPONSES_MIN_OUTPUT_TOKENS = 16

/** The chat-completions fields `buildInvokeBody` writes, as {@link toResponsesBody} reads them. */
interface ChatCompletionsRequest {
  readonly messages?: ReadonlyArray<{ readonly role?: unknown; readonly content?: unknown }>
  readonly max_completion_tokens?: unknown
  readonly reasoning_effort?: unknown
  readonly response_format?: {
    readonly type?: unknown
    readonly json_schema?: Readonly<Record<string, unknown>>
  }
}

/**
 * Rewrite the OpenAI lane's InvokeModel body, which is chat completions, as a Responses request
 * (every field probed live 2026-11-23 against a gateway fronting bedrock-runtime's
 * `/openai/v1/responses`, with `global.openai.gpt-5.6-sol` and `global.openai.gpt-5.6-terra`).
 *
 * - `messages` splits in two: the system messages become `instructions`, omitted when there are
 *   none, and the rest become `input` as the same `{role, content}` items.
 * - `max_completion_tokens` becomes `max_output_tokens`, which also bounds reasoning and answer
 *   together, raised to {@link RESPONSES_MIN_OUTPUT_TOKENS} because this API refuses a smaller
 *   budget where chat completions accepts 1. A budget that small still truncates, so the request
 *   reaches the truncation gate as an incomplete response and not the caller as a malformed one.
 * - `reasoning_effort` becomes `reasoning.effort`, taking the same four values.
 * - `response_format.json_schema` becomes `text.format`, which carries the same `name`, `strict`
 *   and `schema` flattened beside `type: "json_schema"` instead of nested under a key.
 * - `store: false`, because Responses keeps each response server-side by default and this lane is
 *   one stateless call that never reads one back; chat completions stores nothing.
 * - Every other key rides through under its own name. `prompt_cache_options` is the one
 *   `buildInvokeBody` writes today, and Bedrock accepts and echoes it on this route as it does on
 *   chat completions.
 */
export const toResponsesBody = (
  model: string,
  body: Record<string, unknown>
): Record<string, unknown> => {
  const {
    messages,
    max_completion_tokens: budget,
    reasoning_effort: effort,
    response_format: format,
    ...rest
  } = body as ChatCompletionsRequest & Record<string, unknown>
  const turns = messages ?? []
  const instructions = turns
    .flatMap((turn) =>
      turn.role === "system" && typeof turn.content === "string" ? [turn.content] : []
    )
    .join("\n\n")
  return {
    model,
    ...(instructions.length === 0 ? {} : { instructions }),
    input: turns.filter((turn) => turn.role !== "system"),
    ...(typeof budget === "number"
      ? { max_output_tokens: Math.max(RESPONSES_MIN_OUTPUT_TOKENS, budget) }
      : {}),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...rest,
    store: false,
    ...(format?.type === "json_schema" && format.json_schema !== undefined
      ? { text: { format: { type: "json_schema", ...format.json_schema } } }
      : {})
  }
}

/** The Responses payload, narrowed to the fields {@link fromResponsesPayload} reads. */
interface ResponsesPayload {
  readonly status?: unknown
  readonly incomplete_details?: { readonly reason?: unknown } | null
  readonly output?: ReadonlyArray<{
    readonly type?: unknown
    readonly content?: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }> | null
  }>
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown }
}

/**
 * Fold a Responses payload into the chat-completions payload `normalizeOpenAiResponse` reads, so
 * the OpenAI lane's read side is the same over Bedrock directly and over the proxy.
 *
 * The answer is every `output_text` part of every `message` item, concatenated. A reasoning item
 * precedes the message on these models and a refusal is its own part type, so neither is read as
 * the answer; a response with no `output_text` folds to `content: null`, which the lane reports
 * as it reports an empty chat-completions message.
 *
 * `status` becomes `finish_reason`. `completed` is `stop`. `incomplete` is `length`, the stop the
 * truncation gate refuses, unless `incomplete_details.reason` is `content_filter`, which is the
 * refusal stop under its chat-completions name. Any other status passes through as itself, which
 * no gate treats as a truncation, so a response that carries no text fails on its missing content.
 * Usage keeps its counts under the chat-completions names.
 */
export const fromResponsesPayload = (payload: unknown): unknown => {
  const body = (payload ?? {}) as ResponsesPayload
  const text = (Array.isArray(body.output) ? body.output : [])
    .flatMap((item) => (item.type === "message" && Array.isArray(item.content) ? item.content : []))
    .flatMap((part) =>
      part.type === "output_text" && typeof part.text === "string" ? [part.text] : []
    )
    .join("")
  const finish =
    body.status === "completed"
      ? "stop"
      : body.status === "incomplete"
        ? body.incomplete_details?.reason === "content_filter"
          ? "content_filter"
          : "length"
        : typeof body.status === "string"
          ? body.status
          : null
  const input = body.usage?.input_tokens
  const output = body.usage?.output_tokens
  return {
    choices: [
      {
        finish_reason: finish,
        message: { role: "assistant", content: text.length === 0 ? null : text }
      }
    ],
    usage: {
      ...(typeof input === "number" ? { prompt_tokens: input } : {}),
      ...(typeof output === "number" ? { completion_tokens: output } : {})
    }
  }
}

/**
 * Fold a proxy response into the InvokeModel payload the lane expects.
 *
 * A Messages response is already the payload `asResponseBody` reads, so it passes through
 * untouched. A Responses payload becomes the chat-completions payload
 * ({@link fromResponsesPayload}). An OpenAI embeddings response (`data: [{index, embedding}]`)
 * becomes Cohere's `embeddings.float`, ordered by `index` because the OpenAI shape permits any
 * order and `readEmbeddings` pairs vectors with texts positionally.
 * An off-shape embeddings payload folds to an empty `float`, which `readEmbeddings` then reports
 * as a count mismatch — the same typed failure a short Cohere answer produces.
 */
export const fromProxyResponse = (route: ProxyRoute, payload: unknown): unknown => {
  if (route === "messages") return payload
  if (route === "responses") return fromResponsesPayload(payload)
  const data = (payload as { readonly data?: unknown }).data
  if (!Array.isArray(data)) return { embeddings: { float: [] } }
  const vectors = data
    .map((entry, position) => {
      const item = entry as { readonly index?: unknown; readonly embedding?: unknown }
      return {
        index: typeof item.index === "number" ? item.index : position,
        embedding: Array.isArray(item.embedding) ? item.embedding : []
      }
    })
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding)
  return { embeddings: { float: vectors } }
}

/** The minimal `fetch` this client needs, so a test can hand it a recorder. */
export type ProxyFetch = (
  url: string,
  init: {
    readonly method: "POST"
    readonly headers: Record<string, string>
    readonly body: string
    readonly signal: AbortSignal
  }
) => Promise<ProxyFetchResponse>

/** The part of a `fetch` `Response` the proxy client reads; the platform `Response` satisfies it. */
export interface ProxyFetchResponse {
  /** `true` for a 2xx status, as the platform `fetch` reports it. */
  readonly ok: boolean
  /** The HTTP status code the proxy answered with. */
  readonly status: number
  /** Reads the whole response body as text, once. */
  readonly text: () => Promise<string>
}

/**
 * A non-2xx answer, carrying the status and the body's first 200 characters. The body is kept
 * because a proxy reports routing and quota failures as structured JSON an operator needs verbatim
 * — `{"error":{"code":"model_not_found"}}` names the fix, where a bare status does not.
 */
export class ProxyHttpError extends Error {
  override readonly name = "ProxyHttpError"
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`proxy ${String(status)}: ${body.replace(/\s+/g, " ").slice(0, 200)}`)
  }
}

/**
 * Which failures are worth a second attempt: a throttle, a timeout at the proxy, an upstream that
 * fell over, and a socket that never answered. A 4xx other than those is the request's fault and
 * repeats identically; an abort is the caller's decision.
 */
export const isRetryableProxyFailure = (cause: unknown): boolean => {
  if (cause instanceof ProxyHttpError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500
  }
  if (cause instanceof Error) return cause.name !== "AbortError" && cause.name !== "TimeoutError"
  return false
}

/**
 * The backoff for {@link isRetryableProxyFailure}. Half a second doubling, jittered so a batch of
 * concurrent embedding calls does not retry in lockstep, bounded by elapsed time rather than by a
 * count so a proxy that is briefly failing over gets about two minutes of patience and one that is
 * down gets a typed failure rather than a stuck phase. The Bedrock client's `maxAttempts: 10`
 * adaptive retry is the direct-path counterpart.
 */
const PROXY_BACKOFF = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ duration: "2 minutes" })
)

export interface ProxyClientOptions {
  readonly fetch?: ProxyFetch | undefined
  /** The retry schedule; a test substitutes one with no delay. */
  readonly schedule?: Schedule.Schedule<unknown, unknown> | undefined
}

const decodeBody = (command: InvokeModelCommand): Record<string, unknown> => {
  const body = command.input.body
  const text =
    typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array | undefined)
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * The client. `send` mirrors `BedrockRuntimeClient.send` closely enough that `invokeJson` cannot
 * tell them apart: it resolves with the response bytes and rejects with an `Error` whose
 * `name: message` `modelFailure` renders.
 *
 * Each attempt is bounded by the same per-request inactivity window the Bedrock client uses
 * (`REQUEST_HANDLER_OPTIONS.requestTimeout`), composed with the caller's own signal, and a
 * rejected attempt is retried under `PROXY_BACKOFF` when {@link isRetryableProxyFailure}
 * says so. The proxy's response bytes are returned verbatim for the Messages lane and re-encoded
 * for the Responses and embedding lanes after {@link fromProxyResponse}.
 */
export const makeProxyClient = (
  config: ProxyConfig,
  options: ProxyClientOptions = {}
): InvokeClient => {
  const fetchImpl: ProxyFetch = options.fetch ?? (fetch as unknown as ProxyFetch)
  const schedule = options.schedule ?? PROXY_BACKOFF
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey === null ? {} : { authorization: `Bearer ${config.apiKey}` })
  }

  return {
    send: (command, { abortSignal }) => {
      const modelId = command.input.modelId ?? ""
      const request = toProxyRequest(config, modelId, decodeBody(command))
      if (request === null) {
        return Promise.reject(
          new Error(
            `no LLM-proxy route for model ${JSON.stringify(modelId)}; this package does not call it`
          )
        )
      }
      const url = `${config.baseUrl}${request.path}`
      const body = JSON.stringify(request.body)

      const attempt = Effect.tryPromise({
        try: async () => {
          const timeout = AbortSignal.timeout(REQUEST_HANDLER_OPTIONS.requestTimeout)
          const response = await fetchImpl(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.any([abortSignal, timeout])
          })
          const text = await response.text()
          if (!response.ok) throw new ProxyHttpError(response.status, text)
          return text
        },
        catch: (cause) => cause
      })

      /**
       * Run to a `Result` and rethrow the failure VALUE, so the caller's `catch` sees the same
       * `Error` the attempt threw — `ProxyHttpError` with its status and body, or fetch's own
       * `TypeError` — rather than the runtime's wrapper around it. `modelFailure` renders
       * `name: message` off that object, and the rendering is what an operator reads.
       */
      return Effect.runPromise(
        Effect.result(Effect.retry(attempt, { while: isRetryableProxyFailure, schedule })),
        { signal: abortSignal }
      ).then((outcome) => {
        if (Result.isFailure(outcome)) throw outcome.failure
        const text = outcome.success
        if (request.route === "messages") return { body: new TextEncoder().encode(text) }
        const folded = fromProxyResponse(request.route, JSON.parse(text) as unknown)
        return { body: new TextEncoder().encode(JSON.stringify(folded)) }
      })
    }
  }
}

/**
 * The one construction site for a lane's transport: the proxy when the configuration names one,
 * Bedrock directly otherwise. Both `ModelClientLive` and `EmbeddingsLive` call this, so the two
 * lanes cannot disagree about where a night's traffic goes.
 */
export const invokeClientFor = (config: LlmConfigShape): InvokeClient =>
  config.proxy === null ? makeBedrockClient(config.region) : makeProxyClient(config.proxy)

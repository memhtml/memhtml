import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { ModelUnavailable } from "@memhtml/contracts/errors"
import { Config, Effect } from "effect"

/**
 * The one Bedrock call this package makes, named as a structural type instead of the
 * SDK class. `BedrockRuntimeClient` satisfies it, and so does a fake that records the
 * request body and returns a canned payload. That fake lets every wire assertion
 * (batch boundaries, `output_dimension`, the `thinking` key, a truncated `stop_reason`)
 * run with no network and no credential. The response is narrowed to `body` because
 * that is the only field either lane reads.
 */
export interface InvokeClient {
  readonly send: (
    command: InvokeModelCommand,
    options: { readonly abortSignal: AbortSignal }
  ) => Promise<{ readonly body?: Uint8Array | undefined }>
}

/**
 * A Bedrock rejection reduced to the model and the driver's own summary. The reason
 * carries no prompt and no memory body, because a `ModelUnavailable` goes back to an
 * agent through a tool response, and the corpus content that produced it does not need
 * to be repeated there.
 */
export const modelFailure = (modelId: string, cause: unknown): ModelUnavailable =>
  ModelUnavailable.make({
    modelId,
    reason: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  })

/**
 * One InvokeModel round trip: send the body, decode the JSON payload. Both the transport
 * rejection and an unparseable payload land on `ModelUnavailable`, because neither one
 * says anything about the model's answer. They say only that no answer arrived. Reading
 * the answer, and judging whether it honors its contract, is the caller's job.
 */
export const invokeJson = (
  client: InvokeClient,
  modelId: string,
  body: string
): Effect.Effect<unknown, ModelUnavailable> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        client.send(
          new InvokeModelCommand({
            modelId,
            contentType: "application/json",
            accept: "application/json",
            body
          }),
          { abortSignal: signal }
        ),
      catch: (cause) => modelFailure(modelId, cause)
    })

    return yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(response.body)) as unknown,
      catch: (cause) => modelFailure(modelId, cause)
    })
  })

/**
 * Request-handler options for every Bedrock client this package constructs.
 *
 * The SDK's default request timeout is 0 — no bound at all — so a socket that hangs after
 * the request is written never errors, and the call holding it stalls its caller forever.
 * A sleep phase runs its calls sequentially, so one hung socket stalls the whole night.
 *
 * This client's default handler is `NodeHttp2Handler` (pinned SDK 3.1111.0, resolved at
 * `dist-es/runtimeConfig.js`), and a plain options object here is passed to that handler's
 * constructor, so every key must be one that handler reads: `requestTimeout`,
 * `sessionTimeout`, `disableConcurrentStreams`, `maxConcurrentStreams`, and
 * `nodeHttp2ConnectOptions`. There is no connect timeout among them — a `connectionTimeout`
 * is accepted by the type and never read.
 *
 * `requestTimeout` is the one bound, and it is per-STREAM: the handler arms it with
 * `clientHttp2Stream.setTimeout`, so it fires after that long with no activity ON THE CALL
 * and rejects with a `TimeoutError`. That name is what @smithy/core's
 * service-error-classification matches, so the rejection is retryable and `maxAttempts: 10`
 * re-attempts it. 300s of inactivity is far above any legitimate single-token gap — a
 * high-effort structured call streams nothing until it answers, and the slowest observed
 * answers are minutes, not five — so the bound turns only genuinely dead sockets into typed
 * failures.
 *
 * `sessionTimeout` is deliberately absent, because it does not bound only an idle session.
 * Probed 2026-08-25 against a loopback h2 server: `NodeHttp2Handler` passes `sessionTimeout`
 * as the connection manager's `connectionConfiguration.requestTimeout`, which arms
 * `session.setTimeout(value, ensureDestroyed)`, and `ClientHttp2SessionRef.destroy()` tears
 * the session down with no in-flight check. Waiting for a slow answer IS "no activity" on
 * the session, so the timer fires mid-request: against a server answering at 400 ms, a 50 ms
 * `sessionTimeout` rejected the call at 71 ms with a bare
 * `Error: Unexpected error: http2 request did not get a response` carrying no `code` and no
 * `$metadata` — a shape no retry predicate matches, so `$metadata.attempts` was 1. With the
 * key absent the same call answered at 414 ms. Any session bound below the slowest legitimate
 * answer therefore converts a working call into an unretryable failure, and one above it
 * bounds nothing `requestTimeout` does not already bound at the stream.
 *
 * `disableConcurrentStreams: true` is restated because naming a `requestHandler` REPLACES
 * bedrock-runtime's own default provider, which resolves to exactly
 * `{disableConcurrentStreams: true}` (the defaults mode is `legacy`, so the mode's config is
 * empty). Without it the client silently changes connection model, from one isolated session
 * per request to a pooled multiplexed one.
 */
export const REQUEST_HANDLER_OPTIONS = {
  requestTimeout: 300_000,
  disableConcurrentStreams: true
} as const

/**
 * One construction for both lanes: `maxAttempts: 10` with adaptive retry absorbs
 * throttles below Effect, and {@link REQUEST_HANDLER_OPTIONS} bounds a hung socket.
 */
export const makeBedrockClient = (region: string): BedrockRuntimeClient =>
  new BedrockRuntimeClient({
    region,
    maxAttempts: 10,
    retryMode: "adaptive",
    requestHandler: REQUEST_HANDLER_OPTIONS
  })

/**
 * The region every lane resolves against. `us-east-1` is the default because it is where
 * both `cohere.embed-v4:0` and the `global.anthropic.*` inference profiles are reachable.
 *
 * Auth is deliberately absent: the SDK's default chain picks up `AWS_BEARER_TOKEN_BEDROCK`
 * from the environment when it is set, and falls back to the standard credential chain
 * (instance role, profile, environment keys) otherwise. Naming a profile or a key here
 * would break both paths.
 */
export const LlmConfig = Config.all({
  region: Config.string("MEMHTML_AWS_REGION").pipe(Config.withDefault("us-east-1"))
})

export interface LlmConfigShape {
  readonly region: string
}

import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { ModelUnavailable } from "@memhtml/contracts/errors"
import { Config, Effect } from "effect"

/**
 * The one Bedrock call this package makes, named as a structural type rather than the
 * SDK class. `BedrockRuntimeClient` satisfies it, and so does a fake that records the
 * request body and returns a canned payload — which is what lets every wire assertion
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
 * carries no prompt and no memory body: a `ModelUnavailable` is returned to an agent
 * through a tool response, and the corpus content that produced it is not the agent's
 * to see twice.
 */
export const modelFailure = (modelId: string, cause: unknown): ModelUnavailable =>
  ModelUnavailable.make({
    modelId,
    reason: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  })

/**
 * One InvokeModel round trip: send the body, decode the JSON payload. Both the transport
 * rejection and an unparseable payload land on `ModelUnavailable`, because neither one
 * tells us anything about the model's answer — only that we never got one. Reading the
 * answer, and judging whether it honours its contract, is the caller's job.
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
 * The region every lane resolves against. `us-east-1` is the default because it is where
 * both `cohere.embed-v4:0` and the `global.anthropic.*` inference profiles are reachable.
 *
 * Auth is deliberately absent: the SDK's default chain picks up `AWS_BEARER_TOKEN_BEDROCK`
 * from the environment, which is the fleet's rotated Bedrock path, and falls back to the
 * instance role for every other call. Naming a profile or a key here would break both.
 */
export const LlmConfig = Config.all({
  region: Config.string("MEMHTML_AWS_REGION").pipe(Config.withDefault("us-east-1"))
})

export interface LlmConfigShape {
  readonly region: string
}

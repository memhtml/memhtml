import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime"
import { ModelUnavailable } from "@memhtml/contracts/errors"
import { Context, Effect, Layer } from "effect"

import { type InvokeClient, invokeJson, LlmConfig } from "./client.js"
import { EMBED_BATCH_LIMIT, EMBED_CONCURRENCY, EMBED_DIM, EMBED_MODEL_ID } from "./constants.js"

/**
 * Cohere Embed v4 on `bedrock-runtime` InvokeModel.
 *
 * Two entry points, and the difference is not cosmetic: Cohere embeds documents and
 * queries into deliberately different regions of the same space, so a corpus indexed
 * with `search_document` must be queried with `search_query` for the cosine to mean
 * what the retrieval arm assumes. Reusing one `input_type` for both silently degrades
 * every vector hit without failing anything.
 */

export interface EmbeddingsShape {
  /** Embed documents for storage, in order, chunking requests at Cohere's ceiling. */
  readonly embed: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Float32Array>, ModelUnavailable>
  /** Embed one retrieval query. Same space as {@link embed}, different `input_type`. */
  readonly embedQuery: (text: string) => Effect.Effect<Float32Array, ModelUnavailable>
}

export const Embeddings = Context.Service<EmbeddingsShape>("memhtml/Embeddings")

/**
 * Slice `texts` into request-sized chunks, order-preserving. Exported so a test can pin
 * the boundary arithmetic without a client: an off-by-one here is a silently dropped or
 * duplicated vector, which lands in the index as a chunk pointing at the wrong body.
 */
export const chunkTexts = (
  texts: ReadonlyArray<string>,
  size: number = EMBED_BATCH_LIMIT
): ReadonlyArray<ReadonlyArray<string>> => {
  const chunks: Array<ReadonlyArray<string>> = []
  for (let index = 0; index < texts.length; index += size) {
    chunks.push(texts.slice(index, index + size))
  }
  return chunks
}

/**
 * The InvokeModel body for one embed request.
 *
 * `output_dimension` is named rather than defaulted. Probed live 2026-08-02: the model
 * returns 1536 floats when the field is absent and exactly 1024 when it is present, while
 * the `embeddings` table stores a fixed-width F32 blob. A default that changed under us
 * would produce vectors of the wrong width against a schema that cannot hold them, and
 * the failure would surface as a distance function returning nonsense rather than an error.
 *
 * `embedding_types: ["float"]` is what puts the vectors under `embeddings.float`; without
 * it the response nests them elsewhere and the reader below finds nothing.
 */
export const buildEmbedBody = (
  texts: ReadonlyArray<string>,
  inputType: "search_document" | "search_query"
): string =>
  JSON.stringify({
    texts,
    input_type: inputType,
    embedding_types: ["float"],
    output_dimension: EMBED_DIM
  })

interface EmbedResponseBody {
  readonly embeddings?: {
    readonly float?: ReadonlyArray<ReadonlyArray<number>>
  }
}

/**
 * Read the vectors out of a decoded payload, or say why they are unusable.
 *
 * A count mismatch is a typed failure rather than a short array, because the caller pairs
 * vectors with chunk ids positionally: a response one vector short would shift every
 * subsequent pairing and store each embedding against the wrong body. A width mismatch is
 * the same refusal one axis over — the `embed_model` watermark records `id@dim`, so a
 * vector of another width can never be compared against the stored ones.
 */
export const readEmbeddings = (
  payload: unknown,
  expected: number
): ReadonlyArray<Float32Array> | ModelUnavailable => {
  const vectors = (payload as EmbedResponseBody).embeddings?.float
  if (vectors === undefined || vectors.length !== expected) {
    return ModelUnavailable.make({
      modelId: EMBED_MODEL_ID,
      reason: `embedding response carried ${vectors?.length ?? 0} vectors for ${expected} texts`
    })
  }
  const wrong = vectors.findIndex((vector) => vector.length !== EMBED_DIM)
  if (wrong !== -1) {
    return ModelUnavailable.make({
      modelId: EMBED_MODEL_ID,
      reason: `embedding ${wrong} carried ${vectors[wrong]?.length ?? 0} dimensions, expected ${EMBED_DIM}`
    })
  }
  return vectors.map((vector) => Float32Array.from(vector))
}

/**
 * The service over an already-built client. Exported as the seam every test uses: a fake
 * `InvokeClient` records each request body, so the batch boundaries and the wire fields
 * are asserted against the bytes that would go to Bedrock rather than against a mock's
 * recollection of them.
 */
export const makeEmbeddings = (client: InvokeClient): EmbeddingsShape => {
  const embedChunk = (
    texts: ReadonlyArray<string>,
    inputType: "search_document" | "search_query"
  ): Effect.Effect<ReadonlyArray<Float32Array>, ModelUnavailable> =>
    Effect.gen(function* () {
      const payload = yield* invokeJson(client, EMBED_MODEL_ID, buildEmbedBody(texts, inputType))
      const vectors = readEmbeddings(payload, texts.length)
      return vectors instanceof ModelUnavailable ? yield* Effect.fail(vectors) : vectors
    }).pipe(Effect.withSpan("llm.embed", { attributes: { count: texts.length, inputType } }))

  return {
    /**
     * Every batch concurrently, bounded by {@link EMBED_CONCURRENCY}, results flattened in order.
     *
     * `Effect.forEach` preserves input order in its collected results regardless of completion
     * order, which this port depends on absolutely: `embed`'s contract is one vector per input text
     * at the SAME index, and the indexer writes each vector against the chunk at that position. A
     * fan-out that returned completion-ordered results would attach every vector to the wrong chunk
     * — a corruption that no type would catch and that reads as poor retrieval quality rather than
     * as a bug.
     *
     * Short-circuiting is the right failure mode here too: one batch failing fails the pass, and the
     * caller re-runs it. Vectors key on content hash, so the batches that did land are not re-paid
     * for on the retry.
     */
    embed: (texts) =>
      texts.length === 0
        ? Effect.succeed([])
        : Effect.forEach(chunkTexts(texts), (chunk) => embedChunk(chunk, "search_document"), {
            concurrency: EMBED_CONCURRENCY
          }).pipe(Effect.map((batches) => batches.flat())),
    embedQuery: (text) =>
      Effect.gen(function* () {
        const vectors = yield* embedChunk([text], "search_query")
        const first = vectors[0]
        return first === undefined
          ? yield* Effect.fail(
              ModelUnavailable.make({
                modelId: EMBED_MODEL_ID,
                reason: "query embedding response carried no vector"
              })
            )
          : first
      })
  }
}

/**
 * `maxAttempts: 10` with adaptive retry, matching croq's botocore configuration: the
 * embed lane is the one that issues hundreds of calls per index run, so a throttle that
 * fails the run instead of backing off would make a full rebuild unreliable at exactly
 * the size where it matters.
 */
export const EmbeddingsLive = Layer.effect(
  Embeddings,
  Effect.gen(function* () {
    const config = yield* LlmConfig
    return makeEmbeddings(
      new BedrockRuntimeClient({
        region: config.region,
        maxAttempts: 10,
        retryMode: "adaptive"
      })
    )
  })
)

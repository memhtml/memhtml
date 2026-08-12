import { ModelUnavailable } from "@memhtml/contracts/errors"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { EMBED_BATCH_LIMIT, EMBED_DIM, EMBED_MODEL_ID } from "../src/constants.js"
import { buildEmbedBody, chunkTexts, makeEmbeddings, readEmbeddings } from "../src/embeddings.js"
import { embedReply, recorder, rejecting } from "./fake-client.js"

const texts = (count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => `text ${index}`)

describe("chunkTexts", () => {
  it("splits 200 texts into 96 / 96 / 8 preserving order", () => {
    const chunks = chunkTexts(texts(200))
    expect(chunks.map((chunk) => chunk.length)).toEqual([96, 96, 8])
    expect(chunks.flat()).toEqual(texts(200))
  })

  it("returns one chunk exactly at the limit and never an empty trailing chunk", () => {
    expect(chunkTexts(texts(EMBED_BATCH_LIMIT)).map((chunk) => chunk.length)).toEqual([96])
    expect(chunkTexts([])).toEqual([])
  })
})

describe("buildEmbedBody", () => {
  it("names output_dimension and the float embedding type", () => {
    const body = JSON.parse(buildEmbedBody(["a"], "search_document")) as Record<string, unknown>
    expect(body.output_dimension).toBe(EMBED_DIM)
    expect(body.embedding_types).toEqual(["float"])
    expect(body.input_type).toBe("search_document")
  })
})

describe("makeEmbeddings.embed", () => {
  it("issues 3 requests for 200 texts and returns the vectors in submission order", async () => {
    const client = recorder((body) =>
      embedReply((body.texts as ReadonlyArray<string>).length, EMBED_DIM)
    )
    const vectors = await Effect.runPromise(makeEmbeddings(client).embed(texts(200)))

    expect(client.bodies.length).toBe(3)
    expect(client.modelIds).toEqual([EMBED_MODEL_ID, EMBED_MODEL_ID, EMBED_MODEL_ID])
    expect(client.bodies.map((body) => (body.texts as ReadonlyArray<string>).length)).toEqual([
      96, 96, 8
    ])
    // The concatenated request texts are the input, in order: no chunk was dropped,
    // reordered, or sent twice.
    expect(client.bodies.flatMap((body) => body.texts as ReadonlyArray<string>)).toEqual(texts(200))
    expect(vectors.length).toBe(200)
    expect(vectors[0]).toBeInstanceOf(Float32Array)
    expect(vectors[0]?.length).toBe(EMBED_DIM)
  })

  it("carries output_dimension and search_document on every chunk, not just the first", async () => {
    const client = recorder((body) =>
      embedReply((body.texts as ReadonlyArray<string>).length, EMBED_DIM)
    )
    await Effect.runPromise(makeEmbeddings(client).embed(texts(200)))

    for (const body of client.bodies) {
      expect(body.output_dimension).toBe(EMBED_DIM)
      expect(body.embedding_types).toEqual(["float"])
      expect(body.input_type).toBe("search_document")
    }
  })

  it("issues no request at all for an empty input", async () => {
    const client = recorder(() => embedReply(0, EMBED_DIM))
    const vectors = await Effect.runPromise(makeEmbeddings(client).embed([]))
    expect(vectors).toEqual([])
    expect(client.bodies.length).toBe(0)
  })

  it("fails typed when a response carries fewer vectors than texts", async () => {
    const client = recorder((body) =>
      embedReply((body.texts as ReadonlyArray<string>).length - 1, EMBED_DIM)
    )
    const result = await Effect.runPromise(Effect.result(makeEmbeddings(client).embed(texts(3))))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ModelUnavailable)
      expect(result.failure.reason).toContain("2 vectors for 3 texts")
    }
  })

  it("fails on a short chunk in the MIDDLE of a batched call, not only the first", async () => {
    // The contaminating case: the first chunk is well-formed, so a check that only ran
    // once would pass and pair 96 good vectors with 200 chunk ids.
    const client = recorder((body, offset) =>
      embedReply((body.texts as ReadonlyArray<string>).length - (offset === 1 ? 1 : 0), EMBED_DIM)
    )
    const result = await Effect.runPromise(Effect.result(makeEmbeddings(client).embed(texts(200))))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      // The SECOND batch is the one that came back short, and the reason names its arithmetic.
      expect(result.failure.reason).toContain("95 vectors for 96 texts")
    }
    /**
     * All three batches are issued, not two.
     *
     * The batches run concurrently up to `EMBED_CONCURRENCY`, so a sibling's failure does not
     * un-send a request already in flight — 200 texts is three batches and all three start before
     * the second one's short response is observed. That is the cost of the fan-out, and it is
     * bounded: at most `EMBED_CONCURRENCY - 1` requests are wasted per failure. Asserting the
     * count pins that the bound is the concurrency limit rather than the whole input.
     */
    expect(client.bodies.length).toBe(3)
  })

  it("fails typed when a vector carries the wrong width", async () => {
    const client = recorder(() => embedReply(1, 1536))
    const result = await Effect.runPromise(Effect.result(makeEmbeddings(client).embed(["a"])))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toContain(`1536 dimensions, expected ${EMBED_DIM}`)
    }
  })

  it("maps a transport rejection onto ModelUnavailable carrying the embed model id", async () => {
    const service = makeEmbeddings(rejecting(new Error("throttled")))
    const result = await Effect.runPromise(Effect.result(service.embed(["a"])))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.modelId).toBe(EMBED_MODEL_ID)
      expect(result.failure.reason).toContain("throttled")
    }
  })
})

describe("makeEmbeddings.embedQuery", () => {
  it("sends input_type search_query for exactly one text", async () => {
    const client = recorder(() => embedReply(1, EMBED_DIM))
    const vector = await Effect.runPromise(makeEmbeddings(client).embedQuery("how do I roll back"))

    expect(client.bodies.length).toBe(1)
    const body = client.bodies[0]
    expect(body?.input_type).toBe("search_query")
    expect(body?.texts).toEqual(["how do I roll back"])
    expect(body?.output_dimension).toBe(EMBED_DIM)
    expect(vector).toBeInstanceOf(Float32Array)
    expect(vector.length).toBe(EMBED_DIM)
  })

  it("is a different input_type from embed, so the two never share a wire body", async () => {
    const client = recorder((body) =>
      embedReply((body.texts as ReadonlyArray<string>).length, EMBED_DIM)
    )
    const service = makeEmbeddings(client)
    await Effect.runPromise(service.embed(["a"]))
    await Effect.runPromise(service.embedQuery("a"))

    expect(client.bodies[0]?.input_type).toBe("search_document")
    expect(client.bodies[1]?.input_type).toBe("search_query")
  })
})

describe("readEmbeddings", () => {
  it("rejects a payload with no embeddings key rather than returning an empty list", () => {
    const result = readEmbeddings({}, 2)
    expect(result).toBeInstanceOf(ModelUnavailable)
  })

  it("converts to Float32Array so the index can bind the underlying buffer", () => {
    const result = readEmbeddings(embedReply(1, EMBED_DIM), 1)
    expect(Array.isArray(result)).toBe(true)
    if (!(result instanceof ModelUnavailable)) {
      const first = result[0]
      expect(first).toBeInstanceOf(Float32Array)
      expect(first?.buffer.byteLength).toBe(EMBED_DIM * 4)
    }
  })
})

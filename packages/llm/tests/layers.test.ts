import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { LlmConfig } from "../src/client.js"
import { Embeddings, EmbeddingsLive } from "../src/embeddings.js"
import { ModelClient, ModelClientLive } from "../src/model-client.js"

/**
 * A declared service that nothing constructs is worse than a missing one: the fleet has
 * shipped a port whose claimed implementation defined none of its methods, so three tools
 * would `AttributeError` at the first call with no covering test. These build the real
 * layers and read every method off the resulting service — no Bedrock call is made, but a
 * layer that fails to construct, or a shape missing a method, fails here.
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
  it("defaults the region to where both model families are reachable", async () => {
    expect(await withEnv({}, LlmConfig)).toEqual({ region: "us-east-1" })
  })

  it("honours MEMHTML_AWS_REGION", async () => {
    expect(await withEnv({ MEMHTML_AWS_REGION: "us-west-2" }, LlmConfig)).toEqual({
      region: "us-west-2"
    })
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

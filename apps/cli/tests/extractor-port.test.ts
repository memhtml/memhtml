import { ModelClient, type ModelClientShape } from "@memhtml/llm"
import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { ExtractorPort, layerExtractorPort } from "../src/api-layer.js"

/**
 * The extractor port's switches. On by default since 2026-09-02, so what needs pinning is every way
 * it goes ABSENT: the explicit `off`, and the global `MEMHTML_LLM=off` (which is what keeps the
 * credential-free tiers from placing a live call now that the default is on). Every case injects
 * its environment through `ConfigProvider`, because the layer reads config and `effect/Config`
 * snapshots `process.env` at module load.
 *
 * The model client is a stub that is never called: the port only BINDS the extractor over it.
 */

const never: ModelClientShape = {
  generate: () => Effect.die(new Error("the port test never calls the model")),
  generateObject: () => Effect.die(new Error("the port test never calls the model"))
}

const portUnder = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.provideService(
      Effect.gen(function* () {
        return yield* ExtractorPort
      }).pipe(
        Effect.provide(layerExtractorPort.pipe(Layer.provide(Layer.succeed(ModelClient)(never))))
      ),
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env })
    ) as Effect.Effect<{ readonly extractor: unknown }, never, never>
  )

describe("layerExtractorPort", () => {
  it("binds by default", async () => {
    expect((await portUnder({})).extractor).toBeDefined()
  })

  it("is absent under MEMHTML_EXTRACT_ENTITIES=off, case-insensitively", async () => {
    expect((await portUnder({ MEMHTML_EXTRACT_ENTITIES: "off" })).extractor).toBeUndefined()
    expect((await portUnder({ MEMHTML_EXTRACT_ENTITIES: " OFF " })).extractor).toBeUndefined()
  })

  /**
   * (Mutation: dropping the `MEMHTML_LLM` read in `layerExtractorPort` fails this case alone — and
   * would let `mise run check` place a live extraction call on any box with a Bedrock credential.)
   */
  it("is absent under MEMHTML_LLM=off, like every other model call", async () => {
    expect((await portUnder({ MEMHTML_LLM: "off" })).extractor).toBeUndefined()
  })

  it("any other value leaves it on", async () => {
    expect((await portUnder({ MEMHTML_EXTRACT_ENTITIES: "yes" })).extractor).toBeDefined()
  })
})

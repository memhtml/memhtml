import { ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"

import { ExtractorPort, layerExtractorPort } from "../src/api-layer.js"

/**
 * The extractor port's switches. On by default since 2026-09-02, so what needs pinning is every way
 * it goes ABSENT: the explicit `off`, the global `MEMHTML_LLM=off` (which is what keeps the
 * credential-free tiers from placing a live call now that the default is on), and an environment
 * with no route to a model at all. Every case injects its environment through `ConfigProvider`,
 * because the layer reads config and `effect/Config` snapshots `process.env` at module load.
 *
 * A proxy origin is the route in the "on" cases: it makes the port bind without a Bedrock
 * credential and without any network call — the transport is only built, never used.
 */

const portUnder = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.provideService(
      Effect.gen(function* () {
        return yield* ExtractorPort
      }).pipe(Effect.provide(layerExtractorPort)),
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env })
    ) as Effect.Effect<{ readonly extractor: unknown }, never, never>
  )

const ROUTE = { MEMHTML_LLM_BASE_URL: "http://127.0.0.1:4000" }

describe("layerExtractorPort", () => {
  it("binds by default when a route to a model exists", async () => {
    expect((await portUnder(ROUTE)).extractor).toBeDefined()
  })

  it("is absent under MEMHTML_EXTRACT_ENTITIES=off, case-insensitively", async () => {
    expect(
      (await portUnder({ ...ROUTE, MEMHTML_EXTRACT_ENTITIES: "off" })).extractor
    ).toBeUndefined()
    expect(
      (await portUnder({ ...ROUTE, MEMHTML_EXTRACT_ENTITIES: " OFF " })).extractor
    ).toBeUndefined()
  })

  /**
   * (Mutation: dropping the `MEMHTML_LLM` read in `layerExtractorPort` fails this case alone — and
   * would let `mise run check` place a live extraction call on any box with a Bedrock credential.)
   */
  it("is absent under MEMHTML_LLM=off, like every other model call", async () => {
    expect((await portUnder({ ...ROUTE, MEMHTML_LLM: "off" })).extractor).toBeUndefined()
  })

  it("is absent, with a warning rather than a failure, when nothing can reach a model", async () => {
    expect((await portUnder({})).extractor).toBeUndefined()
  })

  it("any other value leaves it on", async () => {
    expect((await portUnder({ ...ROUTE, MEMHTML_EXTRACT_ENTITIES: "yes" })).extractor).toBeDefined()
  })
})

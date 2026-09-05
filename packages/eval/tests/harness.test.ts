import { Effect, Logger, References } from "effect"
import { describe, expect, it } from "vitest"

import { EVAL_LOG_ANNOTATIONS, withStack } from "../src/harness.js"

/**
 * The eval stack's log lines name the throwaway they describe (issue #145).
 *
 * `memhtml sleep merge` runs this stack as its gate, so its migrations and its `indexer.rebuild` land
 * in the operator's sleep log beside the store's own index lines, where "indexer.rebuild: 304 files"
 * reads as the store being rebuilt. Captured through a logger rather than by grepping stderr, and
 * read off the fiber's annotations rather than the rendered text, so the assertion is about the
 * annotation itself and not one formatter's spelling of it.
 */

interface Entry {
  readonly message: string
  readonly annotations: Readonly<Record<string, unknown>>
}

describe("eval stack log lines", () => {
  it("annotates the fixture's migrations and its rebuild as the eval's :memory: corpus", async () => {
    const entries: Array<Entry> = []
    const captured = Logger.make((options) => {
      entries.push({
        message: String(options.message),
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    })

    const indexed = await Effect.runPromise(
      withStack((stack) => Effect.succeed(stack.indexed)).pipe(
        Effect.provide(Logger.layer([captured]))
      )
    )
    expect(indexed).toBeGreaterThan(0)

    // Census first: a probe over zero lines would pass the loop below vacuously.
    const rebuilds = entries.filter((entry) => entry.message.startsWith("indexer.rebuild:"))
    expect(rebuilds).toHaveLength(1)
    expect(rebuilds[0]?.message).toContain(`${String(indexed)} files`)
    const migrations = entries.filter((entry) => entry.message.startsWith("applied migration"))
    expect(migrations.length).toBeGreaterThan(0)

    for (const entry of [...rebuilds, ...migrations]) {
      expect(entry.annotations, entry.message).toMatchObject(EVAL_LOG_ANNOTATIONS)
    }
    expect(EVAL_LOG_ANNOTATIONS).toMatchObject({ database: ":memory:" })
  })
})

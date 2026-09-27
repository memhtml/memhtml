import type { MemoryRecord } from "@memhtml/contracts"
import { fakeEmbedder, fakeVector } from "@memhtml/eval"
import { renderTemplate } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  emptyVectorCache,
  fillVectors,
  VECTOR_TEXT_MAX_CHARS,
  type VectorSpace,
  vectorTextOf
} from "../src/index.js"
import { mapView, recordOf, run } from "./helpers.js"

/**
 * The vector arm's text rule and the fill that pays for vectors, over `@memhtml/eval`'s
 * deterministic embedder, so every stored vector is checkable against the text it came from.
 *
 * Guard mutations (each run once, see the report):
 * - `fillVectors`: drop `if (record.archived) continue`, and "embeds active records only" fails
 *   because the archived record's text is sent.
 * - `fillVectors`: drop the `cache.vectors.has(...)` reuse check, and "embeds only what the cache
 *   lacks" fails because the second fill sends every text again.
 * - `fillVectors`: key the batch by path instead of content hash (`missing.set(record.path, text)`),
 *   and "two records sharing a content hash cost one text" fails on the embedded count.
 * - `fillVectors`: drop the `text === ""` skip, and "a record with no article text is counted
 *   empty" fails because an empty string is sent to `embed`.
 * - `fillVectors`: drop the width check, and "a vector of the wrong width is a defect" fails
 *   because the short vector is stored.
 * - `vectorTextOf`: drop `.slice(0, VECTOR_TEXT_MAX_CHARS)`, and "cuts a long article" fails.
 */

const SPACE: VectorSpace = { modelId: "fake", dimension: fakeVector("x").length }

const memory = (
  path: string,
  claim: string,
  options: { readonly body?: string; readonly title?: string } = {}
): Promise<MemoryRecord> =>
  recordOf({
    path,
    html: renderTemplate({
      title: options.title ?? `About ${path}`,
      claim,
      ...(options.body === undefined ? {} : { body: [options.body] }),
      memoryType: "semantic",
      at: "2026-01-01T00:00:00Z"
    })
  })

/** A recording embedder over `fakeVector`: every batch it was sent, in order. */
const recording = () => {
  const batches: Array<ReadonlyArray<string>> = []
  const inner = fakeEmbedder()
  return {
    batches,
    embed: (texts: ReadonlyArray<string>) =>
      Effect.suspend(() => {
        batches.push([...texts])
        return inner.embed(texts)
      })
  }
}

describe("vectorTextOf", () => {
  it("is the article's text, which opens with the claim, and leaves the title out", async () => {
    const record = await memory("areas/inbox/a.html", "Quorum was lost twice.", {
      title: "A title that is not in the article",
      body: "The second loss followed a network partition."
    })
    const text = vectorTextOf(record)
    expect(text.startsWith("Quorum was lost twice.")).toBe(true)
    expect(text).toContain("network partition")
    expect(text).not.toContain("A title that is not in the article")
    expect(text).toBe(record.bodyText.trim())
  })

  it("cuts a long article at the ceiling, keeping its opening", async () => {
    const long = "word ".repeat(1_000)
    const record = await memory("areas/inbox/long.html", "The claim comes first.", { body: long })
    expect(record.bodyText.length).toBeGreaterThan(VECTOR_TEXT_MAX_CHARS)
    const text = vectorTextOf(record)
    expect(text).toHaveLength(VECTOR_TEXT_MAX_CHARS)
    expect(text.startsWith("The claim comes first.")).toBe(true)
    expect(VECTOR_TEXT_MAX_CHARS).toBe(1_800)
  })

  it("is the same for two records with one article and different titles, so one key serves both", async () => {
    const first = await memory("areas/inbox/one.html", "Same fact.", { title: "One" })
    const second = await memory("areas/inbox/two.html", "Same fact.", { title: "Two" })
    expect(first.contentHash).toBe(second.contentHash)
    expect(vectorTextOf(first)).toBe(vectorTextOf(second))
  })
})

describe("fillVectors", () => {
  it("embeds every active record once, in one call, keyed by content hash", async () => {
    const records = await Promise.all([
      memory("areas/inbox/a.html", "Alpha is first."),
      memory("areas/inbox/b.html", "Beta is second.")
    ])
    const embedder = recording()
    const filled = await run(
      fillVectors({ view: mapView(records), cache: emptyVectorCache(SPACE), embedder })
    )
    expect(filled.counts).toEqual({ records: 2, reused: 0, embedded: 2, empty: 0 })
    expect(embedder.batches).toHaveLength(1)
    for (const record of records) {
      expect(filled.cache.vectors.get(record.contentHash)).toEqual(fakeVector(vectorTextOf(record)))
    }
    expect(filled.cache.space).toBe(SPACE)
  })

  it("embeds only what the cache lacks, and keeps what it held", async () => {
    const first = await memory("areas/inbox/a.html", "Alpha is first.")
    const second = await memory("areas/inbox/b.html", "Beta is second.")
    const once = await run(
      fillVectors({
        view: mapView([first]),
        cache: emptyVectorCache(SPACE),
        embedder: recording()
      })
    )
    const embedder = recording()
    // The second version drops `first` and adds `second`: only `second` is paid for, and the
    // vector for `first` stays in the cache for any version that still holds it.
    const twice = await run(fillVectors({ view: mapView([second]), cache: once.cache, embedder }))
    expect(embedder.batches).toEqual([[vectorTextOf(second)]])
    expect(twice.counts).toEqual({ records: 1, reused: 0, embedded: 1, empty: 0 })
    expect([...twice.cache.vectors.keys()].sort()).toEqual(
      [first.contentHash, second.contentHash].sort()
    )
    const again = recording()
    const thrice = await run(
      fillVectors({ view: mapView([first, second]), cache: twice.cache, embedder: again })
    )
    expect(again.batches).toEqual([])
    expect(thrice.counts).toEqual({ records: 2, reused: 2, embedded: 0, empty: 0 })
    expect(thrice.cache).toBe(twice.cache)
  })

  it("embeds active records only", async () => {
    const active = await memory("areas/inbox/a.html", "Alpha is first.")
    const archived = await memory("archive/2026/areas/inbox/old.html", "Old news is old.")
    const embedder = recording()
    const filled = await run(
      fillVectors({ view: mapView([active, archived]), cache: emptyVectorCache(SPACE), embedder })
    )
    expect(embedder.batches).toEqual([[vectorTextOf(active)]])
    expect(filled.counts).toEqual({ records: 1, reused: 0, embedded: 1, empty: 0 })
    expect(filled.cache.vectors.has(archived.contentHash)).toBe(false)
  })

  it("two records sharing a content hash cost one text", async () => {
    const first = await memory("areas/inbox/one.html", "Same fact.", { title: "One" })
    const second = await memory("projects/x/two.html", "Same fact.", { title: "Two" })
    const embedder = recording()
    const filled = await run(
      fillVectors({ view: mapView([first, second]), cache: emptyVectorCache(SPACE), embedder })
    )
    expect(embedder.batches).toEqual([[vectorTextOf(first)]])
    expect(filled.counts).toEqual({ records: 2, reused: 0, embedded: 1, empty: 0 })
    expect(filled.cache.vectors.size).toBe(1)
  })

  it("a record with no article text is counted empty and never sent", async () => {
    const real = await memory("areas/inbox/a.html", "Alpha is first.")
    const blank: MemoryRecord = {
      ...real,
      path: "areas/inbox/blank.html",
      bodyText: "  ",
      contentHash: "sha256:blank"
    }
    const embedder = recording()
    const filled = await run(
      fillVectors({ view: mapView([real, blank]), cache: emptyVectorCache(SPACE), embedder })
    )
    expect(embedder.batches).toEqual([[vectorTextOf(real)]])
    expect(filled.counts).toEqual({ records: 2, reused: 0, embedded: 1, empty: 1 })
  })

  it("an empty view or a covered one makes no call", async () => {
    const embedder = recording()
    const filled = await run(
      fillVectors({ view: mapView([]), cache: emptyVectorCache(SPACE), embedder })
    )
    expect(embedder.batches).toEqual([])
    expect(filled.counts).toEqual({ records: 0, reused: 0, embedded: 0, empty: 0 })
  })

  it("a vector of the wrong width is a defect, not a cache entry", async () => {
    const record = await memory("areas/inbox/a.html", "Alpha is first.")
    const short = {
      embed: (texts: ReadonlyArray<string>) =>
        Effect.succeed(texts.map(() => new Float32Array(SPACE.dimension - 1)))
    }
    const exit = await Effect.runPromiseExit(
      fillVectors({ view: mapView([record]), cache: emptyVectorCache(SPACE), embedder: short })
    )
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("dimensions")
  })

  it("an embed failure is the fill's failure, and the cache passed in is untouched", async () => {
    const record = await memory("areas/inbox/a.html", "Alpha is first.")
    const cache = emptyVectorCache(SPACE)
    const failing = { embed: () => Effect.fail("outage" as const) }
    const result = await run(
      Effect.result(fillVectors({ view: mapView([record]), cache, embedder: failing }))
    )
    expect(result._tag).toBe("Failure")
    expect(cache.vectors.size).toBe(0)
  })
})

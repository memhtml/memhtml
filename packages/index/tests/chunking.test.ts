import { contentHash } from "@memhtml/html"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { chunkIdFor, chunkText } from "../src/chunking.js"
import { CHUNK_MAX_CHARS } from "../src/schema-const.js"

/**
 * Chunking and the chunk id.
 *
 * The chunk id is a corpus-wide dedup key for embeddings, so its properties are load-bearing: an id
 * that varied with the path would re-embed every archive move, and an ambiguous id would let two
 * different bodies share one vector.
 */

describe("chunkIdFor", () => {
  it("is a function of the content hash and the ordinal alone", () => {
    expect(chunkIdFor("sha256:aaa", 0)).toBe(chunkIdFor("sha256:aaa", 0))
    expect(chunkIdFor("sha256:aaa", 0)).not.toBe(chunkIdFor("sha256:aaa", 1))
    expect(chunkIdFor("sha256:aaa", 0)).not.toBe(chunkIdFor("sha256:bbb", 0))
  })

  it("keeps the mapping injective across the hash/ordinal boundary", () => {
    // Without the separator, hash `…ab` at ordinal 1 and hash `…ab1` at ordinal "" would collide.
    expect(chunkIdFor("sha256:ab", 1)).not.toBe(chunkIdFor("sha256:ab1", 0))
  })

  it("is a 64-character hex digest", () => {
    expect(chunkIdFor("sha256:aaa", 0)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("chunkText", () => {
  it("returns one chunk holding the whole article when it fits", () => {
    const text = "One short fact about draining the VIP before a rollback."
    const chunks = chunkText(text, "sha256:aaa")
    // The overwhelmingly common case: one fact per file. The embedding is then a function of the
    // article, not of an arbitrary window.
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toBe(text)
    expect(chunks[0]?.ordinal).toBe(0)
    expect(chunks[0]?.charCount).toBe(text.length)
  })

  it("returns nothing for empty or whitespace-only text", () => {
    expect(chunkText("", "sha256:aaa")).toEqual([])
    expect(chunkText("   \n\t ", "sha256:aaa")).toEqual([])
  })

  it("numbers chunks from 0 with no gaps", () => {
    const text = Array.from({ length: 60 }, (_, index) => `Sentence number ${index} here.`).join(
      " "
    )
    const chunks = chunkText(text, "sha256:aaa", 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, offset) => offset))
  })

  it("keeps every chunk within the ceiling, including a sentence longer than it", () => {
    const long = `${"word ".repeat(400)}and one enormous unpunctuated run ${"x".repeat(500)}`
    for (const chunk of chunkText(long, "sha256:aaa", 120)) {
      expect(chunk.charCount).toBeLessThanOrEqual(120)
      expect(chunk.text.length).toBe(chunk.charCount)
    }
  })

  it("loses no word when it splits", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Fact ${index} about zebra.`).join(" ")
    const chunks = chunkText(text, "sha256:aaa", 90)
    const rejoined = chunks.map((chunk) => chunk.text).join(" ")
    expect(rejoined.split(/\s+/).sort()).toEqual(text.split(/\s+/).sort())
  })

  it("gives two identical bodies the same chunk ids, whatever their paths", () => {
    const text = "The very same fact, written in two places."
    const hash = contentHash(`<p><mark>${text}</mark></p>`)
    expect(chunkText(text, hash).map((chunk) => chunk.chunkId)).toEqual(
      chunkText(text, hash).map((chunk) => chunk.chunkId)
    )
  })

  it("defaults to the 1800-character ceiling the design names", () => {
    expect(CHUNK_MAX_CHARS).toBe(1_800)
    const under = "y".repeat(CHUNK_MAX_CHARS)
    expect(chunkText(under, "sha256:aaa")).toHaveLength(1)
  })
})

describe("chunkText properties", () => {
  it("always produces gapless 0-based ordinals within the ceiling", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 900 }),
        fc.integer({ min: 20, max: 200 }),
        (text, ceiling) => {
          const chunks = chunkText(text, "sha256:aaa", ceiling)
          expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, offset) => offset))
          for (const chunk of chunks) expect(chunk.charCount).toBeLessThanOrEqual(ceiling)
        }
      ),
      { numRuns: 400 }
    )
  })

  it("gives every chunk of one body a distinct id", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 900 }),
        fc.integer({ min: 20, max: 200 }),
        (text, ceiling) => {
          const ids = chunkText(text, "sha256:aaa", ceiling).map((chunk) => chunk.chunkId)
          expect(new Set(ids).size).toBe(ids.length)
        }
      ),
      { numRuns: 400 }
    )
  })

  it("is deterministic", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 900 }), (text) => {
        expect(chunkText(text, "sha256:aaa")).toEqual(chunkText(text, "sha256:aaa"))
      }),
      { numRuns: 200 }
    )
  })

  it("emits no empty chunk", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 900 }),
        fc.integer({ min: 20, max: 200 }),
        (text, ceiling) => {
          for (const chunk of chunkText(text, "sha256:aaa", ceiling)) {
            expect(chunk.text.length).toBeGreaterThan(0)
          }
        }
      ),
      { numRuns: 400 }
    )
  })
})

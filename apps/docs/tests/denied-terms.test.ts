import { describe, expect, it } from "vitest"

import { DENIED_TERMS } from "../src/gates.js"
import { deniedTermHits, normalizeTerm, termDigest } from "./denied-terms.js"

/**
 * The digest matcher, tried on placeholder terms that name nothing. `tests/built-site.test.ts` runs
 * the same matcher over `dist/` with the real list; this file shows what it does and doesn't catch.
 */

const ONE_WORD = new Set([termDigest("zorblax")])
const TWO_WORDS = new Set([termDigest("quux-frob")])

const linesOf = (text: string, denied: ReadonlySet<string>): ReadonlyArray<number> =>
  deniedTermHits(text, denied).map((hit) => hit.line)

describe("the denied-term matcher", () => {
  it("hashes the lowercase letters and digits of a term and nothing else", () => {
    expect(normalizeTerm("Quux-Frob_2")).toBe("quuxfrob2")
    expect(termDigest("Zorblax")).toBe(termDigest("zorblax"))
    expect(termDigest("zorblax")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("finds a one-word term in any case, inside paths, URLs, and entity references", () => {
    for (const text of [
      "Zorblax",
      "ZORBLAX wrote it",
      "/home/zorblax/notes",
      "person:zorblax",
      "https://example.com/zorblax/x"
    ]) {
      expect(linesOf(text, ONE_WORD), text).toEqual([1])
    }
  })

  it("leaves a longer word that only contains the term alone", () => {
    for (const text of ["zorblaxes", "prezorblax", "zorblax2", "zorbla-xes"]) {
      expect(linesOf(text, ONE_WORD), text).toEqual([])
    }
  })

  it("finds a two-word term written as one word, kebab, snake, or two words", () => {
    for (const text of ["quuxfrob", "Quux-Frob", "quux_frob", "Quux Frob", "project:quux-frob"]) {
      expect(linesOf(text, TWO_WORDS), text).toEqual([1])
    }
  })

  it("joins any two adjacent runs, so a one-word term split by one separator still matches", () => {
    for (const text of ["zorbla x", "zorbl-ax", "zor_blax"]) {
      expect(linesOf(text, ONE_WORD), text).toEqual([1])
    }
    // Three runs make two pairs, and neither pair is the whole term.
    expect(linesOf("zor bl ax", ONE_WORD)).toEqual([])
  })

  it("doesn't join two words across more than one separator", () => {
    for (const text of ["quux--frob", "quux, frob", "quux\nfrob", "quux. frob"]) {
      expect(linesOf(text, TWO_WORDS), text).toEqual([])
    }
  })

  it("reports every occurrence by line", () => {
    expect(linesOf("a\nzorblax\nb\nc zorblax d zorblax", ONE_WORD)).toEqual([2, 4, 4])
  })

  it("holds every entry of DENIED_TERMS as a well-formed digest, listed once, with a reason", () => {
    expect(DENIED_TERMS.length).toBeGreaterThan(0)
    for (const { digest, why } of DENIED_TERMS) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      expect(why.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(DENIED_TERMS.map((entry) => entry.digest)).size).toBe(DENIED_TERMS.length)
  })
})

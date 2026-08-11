import { ALL_RELS, relForToken, relTokenFor } from "@memhtml/contracts/edges"
import { describe, expect, it } from "vitest"

import {
  ARTICLE_ELEMENTS,
  DOCUMENT_ELEMENTS,
  FIGURE_SCOPED_ELEMENTS,
  isMemoryMetaName,
  isRepeatableMeta,
  KNOWN_ELEMENTS,
  LINK_REL_PREFIX,
  META_ORDER,
  META_PREFIX,
  PERSON_ELEMENTS,
  REPEATABLE_META,
  REQUIRED_META
} from "../src/vocabulary.js"

/**
 * The closed vocabulary itself: naming conventions, and that the element and metadata sets say
 * exactly what `docs/format.md` says. These are the design constants every other module reads,
 * so a drift here is a format change and should have to be stated deliberately.
 */

describe("format naming", () => {
  it("prefixes meta and rel tokens identically and without a colon", () => {
    expect(META_PREFIX).toBe("memhtml-")
    expect(LINK_REL_PREFIX).toBe(META_PREFIX)
    expect(META_PREFIX).not.toContain(":")
  })

  it("declares every repeatable meta key under the prefix", () => {
    expect(REPEATABLE_META.length).toBeGreaterThan(0)
    for (const key of REPEATABLE_META) {
      expect(key.startsWith(META_PREFIX)).toBe(true)
    }
  })

  it("prefixes every metadata name in the closed vocabulary", () => {
    for (const name of META_ORDER) {
      expect(name.startsWith(META_PREFIX), name).toBe(true)
      expect(name).not.toContain(":")
    }
  })

  it("carries no colon in any rel token, which HTML forbids there", () => {
    for (const rel of ALL_RELS) {
      const token = relTokenFor(rel)
      expect(token, rel).not.toContain(":")
      expect(token.startsWith(LINK_REL_PREFIX), rel).toBe(true)
    }
  })

  it("round-trips every rel through its token", () => {
    for (const rel of ALL_RELS) {
      expect(relForToken(relTokenFor(rel)), rel).toBe(rel)
    }
  })
})

describe("the metadata vocabulary", () => {
  it("names the four metas no pure function could invent as required", () => {
    expect([...REQUIRED_META]).toEqual([
      "memhtml-type",
      "memhtml-status",
      "memhtml-created",
      "memhtml-updated"
    ])
  })

  it("includes every required meta in the emission order", () => {
    for (const name of REQUIRED_META) {
      expect((META_ORDER as ReadonlyArray<string>).includes(name), name).toBe(true)
    }
  })

  it("includes every repeatable meta in the emission order", () => {
    for (const name of REPEATABLE_META) {
      expect((META_ORDER as ReadonlyArray<string>).includes(name), name).toBe(true)
    }
  })

  it("names exactly the optional metas format.md lists, plus memhtml-turn", () => {
    const optional = META_ORDER.filter(
      (name) =>
        !(REQUIRED_META as ReadonlyArray<string>).includes(name) &&
        !(REPEATABLE_META as ReadonlyArray<string>).includes(name)
    )
    expect([...optional]).toEqual([
      "memhtml-confidence",
      "memhtml-importance",
      "memhtml-content-hash",
      "memhtml-author",
      "memhtml-session",
      "memhtml-prompt",
      "memhtml-turn",
      "memhtml-valid-from",
      "memhtml-valid-until",
      "memhtml-reprieves",
      "memhtml-archived",
      "memhtml-superseded-by",
      "memhtml-needs-revision",
      "memhtml-task-status",
      "memhtml-due"
    ])
  })

  it("appends a new scalar meta at the end of the scalar block", () => {
    /**
     * Position in `META_ORDER` is a diff-stability contract: the serializer emits one meta per
     * line in this order, so inserting a name mid-list moves every line below it in every file
     * the next bookkeeping pass rewrites. The two task metas are therefore the LAST scalars,
     * immediately before the repeatables.
     */
    const scalars = META_ORDER.filter(
      (name) => !(REPEATABLE_META as ReadonlyArray<string>).includes(name)
    )
    expect(scalars.slice(-2)).toEqual(["memhtml-task-status", "memhtml-due"])
  })

  it("orders emission with the required metas first, so a head reads top-down", () => {
    const firstFour = META_ORDER.slice(0, REQUIRED_META.length)
    expect([...firstFour]).toEqual([...REQUIRED_META])
  })

  it("puts the repeatable metas last, so appending one never splits a scalar block", () => {
    const tail = META_ORDER.slice(-REPEATABLE_META.length)
    expect(new Set(tail)).toEqual(new Set(REPEATABLE_META))
  })

  it("lists every name exactly once", () => {
    expect(new Set(META_ORDER).size).toBe(META_ORDER.length)
  })

  it("narrows a name with isMemoryMetaName and refuses anything else", () => {
    expect(isMemoryMetaName("memhtml-type")).toBe(true)
    expect(isMemoryMetaName("memhtml-vibe")).toBe(false)
    expect(isMemoryMetaName("description")).toBe(false)
  })

  it("marks exactly memhtml-entity and memhtml-tag repeatable", () => {
    expect(isRepeatableMeta("memhtml-entity")).toBe(true)
    expect(isRepeatableMeta("memhtml-tag")).toBe(true)
    expect(isRepeatableMeta("memhtml-type")).toBe(false)
  })
})

describe("the element vocabulary", () => {
  it("names every element format.md's table lists", () => {
    for (const element of [
      "article",
      "mark",
      "time",
      "dl",
      "dt",
      "dd",
      "data",
      "cite",
      "q",
      "dfn",
      "figure",
      "figcaption",
      "details",
      "summary",
      "aside",
      "section",
      "abbr",
      "pre",
      "code",
      "kbd",
      "samp",
      "var",
      "table",
      "caption",
      "thead",
      "tbody",
      "th",
      "td",
      "p",
      "ul",
      "ol",
      "li",
      "a",
      "strong",
      "em"
    ]) {
      expect((ARTICLE_ELEMENTS as ReadonlyArray<string>).includes(element), element).toBe(true)
    }
  })

  it("admits <tr>, without which no table in the vocabulary could hold a cell", () => {
    expect((ARTICLE_ELEMENTS as ReadonlyArray<string>).includes("tr")).toBe(true)
  })

  it("admits <address> for the person plane", () => {
    expect([...PERSON_ELEMENTS]).toEqual(["address"])
  })

  it("scopes exactly <div> and <span> to a figure", () => {
    expect([...FIGURE_SCOPED_ELEMENTS]).toEqual(["div", "span"])
  })

  it("excludes the generic containers from the article vocabulary", () => {
    for (const element of ["div", "span", "script", "style", "main", "header", "footer", "nav"]) {
      expect((ARTICLE_ELEMENTS as ReadonlyArray<string>).includes(element), element).toBe(false)
    }
  })

  it("unions the four sets into KNOWN_ELEMENTS with no name lost", () => {
    for (const element of [
      ...DOCUMENT_ELEMENTS,
      ...ARTICLE_ELEMENTS,
      ...PERSON_ELEMENTS,
      ...FIGURE_SCOPED_ELEMENTS
    ]) {
      expect(KNOWN_ELEMENTS.has(element), element).toBe(true)
    }
  })

  it("keeps <main> outside the vocabulary — <article> replaced it as the hash scope", () => {
    expect(KNOWN_ELEMENTS.has("main")).toBe(false)
    expect(KNOWN_ELEMENTS.has("article")).toBe(true)
  })
})

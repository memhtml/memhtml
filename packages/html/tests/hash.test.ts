import { describe, expect, it } from "vitest"

import { addLink, addMeta, removeMeta, setMeta } from "../src/editors.js"
import { canonicalArticleText, contentHash, isContentHash } from "../src/hash.js"
import { serializeMemory } from "../src/serialize.js"
import { parseArticleFragment } from "../src/tree.js"
import { META_ORDER, REPEATABLE_META } from "../src/vocabulary.js"
import { FORMAT_MD_EXAMPLE, fileWith, MINIMAL_ARTICLE, parseOk } from "./fixtures.js"

/**
 * The content hash. Meta-invariance is the single most load-bearing property here: it is what
 * makes confidence decay and access bookkeeping not look like content changes, so a hash that
 * moved on a nightly decay pass would present the whole corpus as new content and collapse
 * dedup.
 */

describe("shape", () => {
  it("is a self-describing sha256 digest", () => {
    const hash = contentHash(FORMAT_MD_EXAMPLE)
    expect(hash.startsWith("sha256:")).toBe(true)
    expect(isContentHash(hash)).toBe(true)
  })

  it("rejects a malformed digest", () => {
    for (const value of ["sha256:zz", "1f4b9c", "md5:abc", "sha256:1F4B9C"]) {
      expect(isContentHash(value), value).toBe(false)
    }
  })

  it("agrees across whole-file HTML, a parsed doc, and bare article markup", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(contentHash(doc)).toBe(contentHash(FORMAT_MD_EXAMPLE))
    expect(contentHash(doc.article.html)).toBe(contentHash(FORMAT_MD_EXAMPLE))
  })
})

describe("meta invariance — the dedup key never moves on a head edit", () => {
  const baseline = contentHash(FORMAT_MD_EXAMPLE)

  it("is invariant under setMeta for every key in the closed vocabulary", () => {
    for (const name of META_ORDER) {
      const edited = setMeta(FORMAT_MD_EXAMPLE, name, "probe-value")
      expect(contentHash(edited), name).toBe(baseline)
    }
  })

  it("actually changed the head for every key, so the invariance is not vacuous", () => {
    for (const name of META_ORDER) {
      const edited = setMeta(FORMAT_MD_EXAMPLE, name, "probe-value")
      expect(edited, name).not.toBe(FORMAT_MD_EXAMPLE)
      expect(edited, name).toContain(`name="${name}" content="probe-value"`)
    }
  })

  it("is invariant under addMeta for every repeatable key", () => {
    for (const name of REPEATABLE_META) {
      const edited = addMeta(FORMAT_MD_EXAMPLE, name, "another:value")
      expect(edited, name).not.toBe(FORMAT_MD_EXAMPLE)
      expect(contentHash(edited), name).toBe(baseline)
    }
  })

  it("is invariant under removeMeta", () => {
    for (const name of ["memhtml-confidence", "memhtml-tag", "memhtml-entity"]) {
      const edited = removeMeta(FORMAT_MD_EXAMPLE, name)
      expect(edited, name).not.toBe(FORMAT_MD_EXAMPLE)
      expect(contentHash(edited), name).toBe(baseline)
    }
  })

  it("is invariant under addLink", () => {
    const edited = addLink(FORMAT_MD_EXAMPLE, "contradicts", "/areas/oncall/other.html")
    expect(edited).not.toBe(FORMAT_MD_EXAMPLE)
    expect(contentHash(edited)).toBe(baseline)
  })

  it("is invariant under the title changing, which is head metadata too", () => {
    const edited = FORMAT_MD_EXAMPLE.replace("<title>Prod rollbacks", "<title>Renamed rollbacks")
    expect(edited).not.toBe(FORMAT_MD_EXAMPLE)
    expect(contentHash(edited)).toBe(baseline)
  })

  it("survives a serialize round trip, which is what a sleep write does", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    const written = serializeMemory(doc)
    expect(contentHash(written)).toBe(baseline)
    expect(contentHash(serializeMemory(parseOk(written)))).toBe(baseline)
  })
})

describe("content sensitivity — a real edit does move the hash", () => {
  it("changes when article text changes", () => {
    const before = contentHash(fileWith("<p><mark>Retry three times.</mark></p>"))
    const after = contentHash(fileWith("<p><mark>Retry thirteen times.</mark></p>"))
    expect(after).not.toBe(before)
  })

  it("changes when a number inside the article changes", () => {
    const before = contentHash(
      fileWith(
        '<p><mark>A claim.</mark></p><dl><dt>N</dt><dd><data value="120">two min</data></dd></dl>'
      )
    )
    const after = contentHash(
      fileWith(
        '<p><mark>A claim.</mark></p><dl><dt>N</dt><dd><data value="120">three min</data></dd></dl>'
      )
    )
    expect(after).not.toBe(before)
  })

  it("changes when article text is deleted", () => {
    const before = contentHash(fileWith("<p><mark>A claim.</mark> With a tail.</p>"))
    const after = contentHash(fileWith("<p><mark>A claim.</mark></p>"))
    expect(after).not.toBe(before)
  })
})

describe("whitespace — collapsed in prose, verbatim in <pre>", () => {
  it("ignores collapsed whitespace differences outside <pre>", () => {
    const tight = contentHash(fileWith("<p><mark>A claim.</mark> Some prose here.</p>"))
    const loose = contentHash(
      fileWith("<p><mark>A   claim.</mark>\n\n   Some\tprose\n   here.</p>")
    )
    expect(loose).toBe(tight)
  })

  it("ignores indentation differences in the markup", () => {
    const flat = contentHash(
      fileWith("<p><mark>A claim.</mark></p><ul><li>one</li><li>two</li></ul>")
    )
    const indented = contentHash(
      fileWith(
        "  <p><mark>A claim.</mark></p>\n  <ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>"
      )
    )
    expect(indented).toBe(flat)
  })

  it("honors an interior whitespace change inside <pre>", () => {
    const one = contentHash(fileWith("<p><mark>A claim.</mark></p><pre>a  b</pre>"))
    const two = contentHash(fileWith("<p><mark>A claim.</mark></p><pre>a b</pre>"))
    expect(two).not.toBe(one)
  })

  it("honors a newline change inside <pre>", () => {
    const one = contentHash(fileWith("<p><mark>A claim.</mark></p><pre>a\nb</pre>"))
    const two = contentHash(fileWith("<p><mark>A claim.</mark></p><pre>a b</pre>"))
    expect(two).not.toBe(one)
  })

  it("honors leading whitespace inside <pre>, which the outer trim must not eat", () => {
    const indented = contentHash(fileWith("<pre>  code</pre><p><mark>A claim.</mark></p>"))
    const bare = contentHash(fileWith("<pre>code</pre><p><mark>A claim.</mark></p>"))
    expect(indented).not.toBe(bare)
  })

  it("preserves a <pre> leading newline across a serialize round trip", () => {
    const html = fileWith("<p><mark>A claim.</mark></p><pre>\n\nindented start</pre>")
    const first = contentHash(html)
    let written = serializeMemory(parseOk(html))
    for (let pass = 0; pass < 3; pass += 1) {
      expect(contentHash(written), `pass ${pass}`).toBe(first)
      written = serializeMemory(parseOk(written))
    }
  })

  it("collapses prose and preserves <pre> in one article", () => {
    const text = canonicalArticleText(
      parseArticleFragment("<p><mark>A   claim.</mark></p><pre>a  b</pre><p>tail   text</p>")
    )
    expect(text).toContain("a  b")
    expect(text).toContain("A claim.")
    expect(text).not.toContain("A   claim")
    expect(text).not.toContain("tail   text")
  })

  it("does not let a collapse run across a <pre> boundary", () => {
    const withPre = canonicalArticleText(parseArticleFragment("<p>a </p><pre> b</pre>"))
    expect(withPre).toBe("a  b")
  })
})

describe("hash scope excludes the head structurally", () => {
  it("hashes two files with identical articles and different heads identically", () => {
    const article = "<p><mark>The same claim.</mark></p>"
    const first = fileWith(article, '<meta name="memhtml-confidence" content="1.00">')
    const second = fileWith(article, '<meta name="memhtml-confidence" content="0.10">')
    expect(first).not.toBe(second)
    expect(contentHash(second)).toBe(contentHash(first))
  })

  it("hashes the minimal article the same whether or not a head states extras", () => {
    expect(contentHash(fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-turn" content="x">'))).toBe(
      contentHash(fileWith(MINIMAL_ARTICLE))
    )
  })
})

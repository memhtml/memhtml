import { describe, expect, it } from "vitest"

import { blockTagInArticle, blockTagInText } from "../src/block-tags.js"
import { renderTemplate } from "../src/template.js"

/**
 * Block-tag-shaped text: the check both prose doors run on a `body` and `validateOps` runs on a
 * put's `<p>` and `<mark>` text. The properties that matter: a block tag written as text is found
 * in either spelling with the line it sits on, code is exempt however it is written (a fence, a
 * backtick span, a `<code>` element), and nothing that is not a block tag is found.
 */

describe("blockTagInText", () => {
  it("finds a block tag and its escaped form, naming the 1-based line and the text", () => {
    expect(blockTagInText("<p>One.</p><p>Two.</p>")).toEqual({ line: 1, tag: "<p>" })
    expect(blockTagInText("First line.\n\nThen </ul> on line three.")).toEqual({
      line: 3,
      tag: "</ul>"
    })
    expect(blockTagInText('A heading <h2 id="x"> here.')).toEqual({
      line: 1,
      tag: '<h2 id="x">'
    })
    expect(blockTagInText("Upper case <LI> is the same element.")?.tag).toBe("<LI>")
    expect(blockTagInText("&lt;p&gt;One.&lt;/p&gt;")).toEqual({ line: 1, tag: "&lt;p&gt;" })
    expect(blockTagInText("Rows:\n&lt;/table&gt;")).toEqual({ line: 2, tag: "&lt;/table&gt;" })
  })

  it("finds every element in the block list", () => {
    const names = ["p", "ul", "ol", "li", "dl", "dt", "dd", "figure", "table", "article"]
    for (const name of [...names, "section", "h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(blockTagInText(`x <${name}> y`)?.tag, name).toBe(`<${name}>`)
      expect(blockTagInText(`x &lt;/${name}&gt; y`)?.tag, name).toBe(`&lt;/${name}&gt;`)
    }
  })

  it("finds nothing in prose that holds no block tag", () => {
    for (const prose of [
      "The build finished. Nothing else happened.",
      // Inline elements are not block tags: the prose path escapes them as text, as it always has.
      '<time datetime="2031-01-01">New year</time> and <em>emphasis</em> and <code>x</code>.',
      // Names that start with a block name but are other elements.
      "A <pre> block, a <param>, a <details> fold, a <dfn>, and <header>.",
      // Comparisons and arrows.
      "p < 0.05 and q > 1, so a<b>c is not a tag either: 3 <p 4",
      "&lt; and &gt; on their own, and &lt;pre&gt; is not in the list."
    ]) {
      expect(blockTagInText(prose), prose).toBeUndefined()
    }
  })

  it("treats a fenced block as code, blank lines and an unclosed fence included", () => {
    expect(blockTagInText("Markup:\n\n```html\n<ul>\n\n  <li>x</li>\n</ul>\n```")).toBeUndefined()
    // A fence that never closes runs to the end of the prose, as CommonMark reads it.
    expect(blockTagInText("Markup:\n\n```html\n<p>x</p>")).toBeUndefined()
    // A fence closes on a run at least as long as the one that opened it, and text after is prose.
    expect(blockTagInText("````\n```\n<p>\n````\nAfter </p> the fence.")).toEqual({
      line: 5,
      tag: "</p>"
    })
  })

  it("treats a backtick span as code, and only a closed one", () => {
    expect(blockTagInText("The `<p>` element holds one paragraph.")).toBeUndefined()
    expect(blockTagInText("Escaped it reads `&lt;p&gt;`.")).toBeUndefined()
    // A double-backtick span may hold a single backtick, and its end is the matching double run.
    expect(blockTagInText("Write `` `<li>` `` to show the backticks.")).toBeUndefined()
    // A run with no matching run is literal text, so a tag after it is still prose.
    expect(blockTagInText("An odd ` tick, then <p> as prose.")?.tag).toBe("<p>")
    // A span ends on the line it opened on: a backtick on the next line does not close it.
    expect(blockTagInText("Open ` here <p>\nand ` close here.")?.tag).toBe("<p>")
    // Splitting the tag around a span does not make one.
    expect(blockTagInText("<`x`p>")).toBeUndefined()
    // A tag beside a span is still found.
    expect(blockTagInText("The `x` value and a </li> after it.")?.tag).toBe("</li>")
  })

  it("stays linear on the shapes that would make a tag pattern backtrack", () => {
    /**
     * A cost-curve assertion, because the defect it locks is invisible to output: a body is
     * unbounded caller input on the write path, and the obvious `<p\b[^>]*>` scans to the end of the
     * text from every `<p` when no `>` follows, which is quadratic. Measured on the raw shape below,
     * that pattern took 181 ms, 742 ms, and 2967 ms at 10k, 20k, and 40k openers (the escaped one,
     * with `.*?&gt;`, 169, 681, and 2818 ms), where the pattern that ships took under 1 ms at each.
     * It stops each attempt at the next `<` (escaped, the next `&lt;`), so a run of openers is one
     * pass. The bound sits an order of magnitude below the quadratic cost at 40k, so a loaded host
     * cannot turn a pass into a fail.
     */
    const shapes = [
      { name: "raw openers", text: "<p ".repeat(40_000) },
      { name: "escaped openers", text: "&lt;p ".repeat(40_000) },
      { name: "backtick runs", text: "` ``".repeat(30_000) },
      { name: "one long line of words", text: "word ".repeat(40_000) }
    ]
    for (const { name, text } of shapes) {
      expect(blockTagInText(text), name).toBeUndefined()
      const started = process.hrtime.bigint()
      for (let i = 0; i < 5; i++) blockTagInText(text)
      const perCallMs = Number(process.hrtime.bigint() - started) / 5e6
      expect(perCallMs, `blockTagInText took ${perCallMs.toFixed(1)}ms on ${name}`).toBeLessThan(
        250
      )
    }
  })
})

/** A file whose article is `article`, through the template's markup path. */
const withArticle = (article: string): string =>
  renderTemplate({
    title: "A fact",
    claim: "",
    articleHtml: article,
    memoryType: "semantic",
    at: "2031-01-01T00:00:00Z"
  })

/** A file the prose path renders from a claim and body paragraphs. */
const fromProse = (claim: string, body: ReadonlyArray<string> = []): string =>
  renderTemplate({
    title: "A fact",
    claim,
    body,
    memoryType: "semantic",
    at: "2031-01-01T00:00:00Z"
  })

describe("blockTagInArticle", () => {
  it("finds an escaped block tag in a <mark> or a <p>, naming the element", () => {
    expect(blockTagInArticle(fromProse("<p>One.", ["Two.</p>"]))).toEqual({
      element: "p",
      tag: "<p>"
    })
    expect(blockTagInArticle(fromProse("A claim.", ["Then a list: <ul> here."]))).toEqual({
      element: "p",
      tag: "<ul>"
    })
    // Escaped once more on the way in, so the text itself reads `&lt;li&gt;`.
    expect(blockTagInArticle(fromProse("A claim with &lt;li&gt; in it."))?.tag).toBe("&lt;li&gt;")
    // A `<mark>` in the first `<li>` is checked on its own, since no `<p>` holds it.
    expect(
      blockTagInArticle(withArticle("<ul><li><mark>The &lt;dl&gt; claim.</mark></li></ul>"))
    ).toEqual({ element: "mark", tag: "<dl>" })
  })

  it("finds nothing in an article whose tags are elements or code", () => {
    expect(
      blockTagInArticle(withArticle("<p><mark>A claim.</mark></p><ul><li>An item.</li></ul>"))
    ).toBeUndefined()
    expect(
      blockTagInArticle(
        withArticle("<p><mark>The <code>&lt;p&gt;</code> element holds a paragraph.</mark></p>")
      )
    ).toBeUndefined()
    expect(
      blockTagInArticle(withArticle("<p><mark>Press <kbd>&lt;li&gt;</kbd> then.</mark></p>"))
    ).toBeUndefined()
    // The prose path's own output for a body that discusses a tag in backticks or a fence.
    expect(blockTagInArticle(fromProse("The `<p>` element holds a paragraph."))).toBeUndefined()
    expect(
      blockTagInArticle(fromProse("A claim.", ["```html\n<ul>\n  <li>x</li>\n</ul>\n```"]))
    ).toBeUndefined()
  })

  it("reads only the article, so a head or a missing article holds nothing", () => {
    expect(blockTagInArticle("<html><head><title>&lt;p&gt;</title></head></html>")).toBeUndefined()
  })
})

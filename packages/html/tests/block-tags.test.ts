import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { blockTagInArticle, blockTagInRun } from "../src/block-tags.js"
import { proseParagraphs, proseParagraphText, renderTemplate } from "../src/template.js"

/**
 * Block-tag-shaped text: the check both prose doors run on the paragraphs a `body` renders to, and
 * `validateOps` and the store's render gate run on an article's `<p>` and `<mark>` text. The
 * properties that matter: a block tag written as text is found in either spelling, as written,
 * with its position; code is exempt (a backtick span on one line, a `<code>` element, a fenced
 * block that renders as a `<figure>`); nothing that is not a block tag is found; and the doors'
 * reading of a body is the same as the reading of the file it renders.
 */

describe("blockTagInRun", () => {
  it("finds a block tag and its escaped form, with its position and the tag as written", () => {
    expect(blockTagInRun("<p>One.</p><p>Two.</p>")).toEqual({ offset: 0, tag: "<p>" })
    expect(blockTagInRun("First line.\n\nThen </ul> on line three.")).toEqual({
      offset: 18,
      tag: "</ul>"
    })
    expect(blockTagInRun('A heading <h2 id="x"> here.')).toEqual({
      offset: 10,
      tag: '<h2 id="x">'
    })
    expect(blockTagInRun("&lt;p&gt;One.&lt;/p&gt;")).toEqual({ offset: 0, tag: "&lt;p&gt;" })
    expect(blockTagInRun("Rows:\n&lt;/table&gt;")).toEqual({ offset: 6, tag: "&lt;/table&gt;" })
  })

  it("finds every element in the block list", () => {
    const names = ["p", "ul", "ol", "li", "dl", "dt", "dd", "figure", "table", "article"]
    for (const name of [...names, "section", "h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(blockTagInRun(`x <${name}> y`)?.tag, name).toBe(`<${name}>`)
      expect(blockTagInRun(`x &lt;/${name}&gt; y`)?.tag, name).toBe(`&lt;/${name}&gt;`)
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
      expect(blockTagInRun(prose), prose).toBeUndefined()
    }
  })

  it("matches lowercase names only, and no opening tag right after a letter, digit, or _", () => {
    for (const prose of [
      "A <Table> component renders the rows.",
      "Typed as React.FC<P> in the view.",
      "It returns List<Article> sorted by date.",
      "Upper case <LI> and &lt;UL&gt; are not how markup is written.",
      "So x<p and q>0 holds for every row.",
      "A List<li> type and a Map<p, q> type.",
      "Call f_<p> once."
    ]) {
      expect(blockTagInRun(prose), prose).toBeUndefined()
    }
    // A closing tag after a word is how markup is written, and an opening one after punctuation.
    expect(blockTagInRun("It ends here</p>")?.tag).toBe("</p>")
    expect(blockTagInRun("Items:(<ul>)")?.tag).toBe("<ul>")
  })

  it("reads a letter as a letter in any script, before an opening tag", () => {
    // Accented and Greek letters, a letter outside the Basic Multilingual Plane, a combining mark.
    for (const prose of [
      "Café<p> menu.",
      "Ω<p> as a symbol.",
      "Let \u{1d465}<p> be small.",
      "e\u0301<li>"
    ]) {
      expect(blockTagInRun(prose), prose).toBeUndefined()
    }
    expect(blockTagInRun("Then «<p>» quoted.")?.tag).toBe("<p>")
  })

  it("takes a slash after an opening name only where it ends the tag", () => {
    expect(blockTagInRun("Dates as <dd/mm/yyyy> in the form.")).toBeUndefined()
    expect(blockTagInRun("A <p/x> value.")).toBeUndefined()
    expect(blockTagInRun("An empty <p/> here.")?.tag).toBe("<p/>")
    expect(blockTagInRun("An empty <li /> here.")?.tag).toBe("<li />")
    expect(blockTagInRun("Escaped &lt;p/&gt; too.")?.tag).toBe("&lt;p/&gt;")
  })

  it("finds a tag whose spelling mixes raw and escaped brackets", () => {
    expect(blockTagInRun("Half escaped &lt;p> here.")?.tag).toBe("&lt;p>")
    expect(blockTagInRun("Half escaped <p&gt; here.")?.tag).toBe("<p&gt;")
  })

  it("quotes the tag sliced from the text, cut to 80 characters", () => {
    // A backtick span inside the tag is quoted as written, not as the blank the scan read.
    expect(blockTagInRun("A <p data-x=`v`> tag.")).toEqual({ offset: 2, tag: "<p data-x=`v`>" })
    const found = blockTagInRun(`See <p ${"a".repeat(1_000_000)}> here.`)
    expect(found?.offset).toBe(4)
    expect(found?.tag).toHaveLength(80)
    expect(found?.tag).toBe(`<p ${"a".repeat(74)}...`)
  })

  it("reads text as the HTML parser holds it: three line-break spellings, NULs dropped", () => {
    // A span ends on the line it opened on, and CR LF and a lone CR end a line as LF does.
    for (const lineBreak of ["\n", "\r\n", "\r"]) {
      expect(blockTagInRun(`Open \` here <p>${lineBreak}and \` close.`)?.tag).toBe("<p>")
      expect(blockTagInRun(`Open \` here${lineBreak}<p>\` close.`)?.tag).toBe("<p>")
    }
    // The parser drops a NUL from body text, so `<\0p>` reads as `<p>`. The offset counts the NUL.
    expect(blockTagInRun("Then <\0p> here.")).toEqual({ offset: 5, tag: "<p>" })
    expect(blockTagInRun("\0\0<ul>")).toEqual({ offset: 2, tag: "<ul>" })
  })

  it("treats a closed backtick span on one line as code, and nothing else", () => {
    expect(blockTagInRun("The `<p>` element holds one paragraph.")).toBeUndefined()
    expect(blockTagInRun("Escaped it reads `&lt;p&gt;`.")).toBeUndefined()
    // A double-backtick span may hold a single backtick, and its end is the matching double run.
    expect(blockTagInRun("Write `` `<li>` `` to show the backticks.")).toBeUndefined()
    // A run with no matching run is literal text, so a tag after it is still prose.
    expect(blockTagInRun("An odd ` tick, then <p> as prose.")?.tag).toBe("<p>")
    // Splitting the tag around a span does not make one.
    expect(blockTagInRun("<`x`p>")).toBeUndefined()
    // A tag beside a span is still found.
    expect(blockTagInRun("The `x` value and a </li> after it.")?.tag).toBe("</li>")
    // Fence lines in a paragraph's text are text: a fence is code only as a paragraph of its own.
    expect(blockTagInRun("```html\n<ul>\n```")?.tag).toBe("<ul>")
  })

  it("grows linearly with the text on the shapes that would make a scan backtrack", () => {
    /**
     * A cost-curve assertion, because the defect it locks is invisible to output: a body is
     * unbounded caller input on the write path, and the obvious `<p\b[^>]*>` scans to the end of the
     * text from every `<p` when no `>` follows, which is quadratic. Measured on the raw shape below,
     * that pattern took 181 ms, 742 ms, and 2967 ms at 10k, 20k, and 40k openers (the escaped one,
     * with `.*?&gt;`, 169, 681, and 2818 ms). The scan stops each attempt at the next `<` or
     * `&lt;`, where the next attempt starts, so a run of openers is one pass.
     *
     * The assertion is on growth, not on a clock: each shape is timed at n and at 8n characters,
     * and the larger may cost at most 32 times the smaller. A linear scan costs about 8 times as
     * much and a quadratic one about 64. The time is the process's CPU time, which a slow host
     * raises at both sizes alike and which leaves out the time other work holds the CPU.
     * Measured, the ratio ran from 5.6 to 12.3 across the shapes, with one core shared three ways
     * or not. The highest is the backtick shape, which builds a list of spans and so pays the
     * collector at both sizes.
     */
    const n = 16_000
    const shapes = [
      { name: "raw openers", make: (size: number) => "<p ".repeat(size / 3) },
      { name: "escaped openers", make: (size: number) => "&lt;p ".repeat(size / 6) },
      { name: "escaped opener, then letters", make: (size: number) => `&lt;p ${"a".repeat(size)}` },
      {
        name: "escaped opener, then ampersands",
        make: (size: number) => `&lt;p ${"&".repeat(size)}`
      },
      { name: "ampersands", make: (size: number) => "&".repeat(size) },
      { name: "backtick runs", make: (size: number) => "` ``".repeat(size / 4) },
      { name: "lines of openers", make: (size: number) => "a <p\n".repeat(size / 5) },
      { name: "one long line of words", make: (size: number) => "word ".repeat(size / 5) }
    ]
    for (const { name, make } of shapes) {
      const large = make(8 * n)
      expect(blockTagInRun(large), name).toBeUndefined()
      const growth = growthOf(make(n), large)
      expect(
        growth,
        `blockTagInRun cost ${growth.toFixed(1)} times as much at 8n on ${name}`
      ).toBeLessThan(32)
    }
  }, 120_000)

  it("reads a line of 10M characters without running out of stack", () => {
    /**
     * A regular expression over the escaped spelling, `(?:[^&<>]|&(?!lt;|gt;))*`, keeps one
     * backtrack frame per character and throws `RangeError: Maximum call stack size exceeded`
     * from about 8.5M characters after an `&lt;p` opener, on a run of letters or of `&`. The scan
     * is a loop and keeps none. Only finishing is asserted; the growth test above holds its cost.
     */
    const size = 10_000_000
    expect(() => blockTagInRun(`&lt;p ${"a".repeat(size)}`)).not.toThrow()
    expect(() => blockTagInRun(`&lt;p ${"&".repeat(size)}`)).not.toThrow()
  }, 120_000)
})

/** CPU time the process has spent, in microseconds. */
const cpuMicros = (): number => {
  const { user, system } = process.cpuUsage()
  return user + system
}

/**
 * How much more the scan costs on `large` than on `small`, in CPU time. Each timing is as many
 * calls as make about 10 ms of work on `small`, the same count on `large`; the sizes are timed in
 * turn for five rounds, and the cheapest of each is kept, because a pause from the collector only
 * ever adds time.
 */
const growthOf = (small: string, large: string): number => {
  let found = 0
  const timed = (text: string, calls: number): number => {
    const started = cpuMicros()
    for (let call = 0; call < calls; call += 1) {
      if (blockTagInRun(text) !== undefined) found += 1
    }
    return cpuMicros() - started
  }
  timed(large, 1)
  let calls = 1
  while (timed(small, calls) < 10_000) calls *= 2
  let cheapestSmall = Number.POSITIVE_INFINITY
  let cheapestLarge = Number.POSITIVE_INFINITY
  for (let round = 0; round < 5; round += 1) {
    cheapestSmall = Math.min(cheapestSmall, timed(small, calls))
    cheapestLarge = Math.min(cheapestLarge, timed(large, calls))
  }
  expect(found).toBe(0)
  return cheapestLarge / Math.max(cheapestSmall, 1)
}

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

  it("reads a code element as one space, so the text around it does not join into a tag", () => {
    expect(
      blockTagInArticle(
        withArticle("<p><mark>Type a &lt;<code>Tab</code>p&gt; to indent.</mark></p>")
      )
    ).toBeUndefined()
    expect(
      blockTagInArticle(withArticle("<p><mark>Run <code>make</code>, then &lt;ul&gt;.</mark></p>"))
    ).toEqual({ element: "p", tag: "<ul>" })
  })

  it("reads a fence that shares its paragraph with prose as that paragraph's text", () => {
    const body = ["```html\n<ul>\n  <li>x</li>\n</ul>\n```\nIt renders one item."]
    expect(blockTagInArticle(fromProse("The list markup is below.", body))).toEqual({
      element: "p",
      tag: "<ul>"
    })
  })

  it("reads only the article, so a head or a missing article holds nothing", () => {
    expect(blockTagInArticle("<html><head><title>&lt;p&gt;</title></head></html>")).toBeUndefined()
  })
})

/**
 * Prose built from the pieces that move a tag in or out of code: backticks, fences, line breaks
 * in three spellings, NULs, both spellings of a tag, and names that only look like one.
 */
const piece = fc.constantFrom(
  "word",
  "List",
  "x",
  " ",
  ".",
  "!",
  "\n",
  "\n\n",
  "\r",
  "\r\n",
  "\0",
  "\t",
  "`",
  "``",
  "```",
  "```html",
  "<",
  ">",
  "/",
  "&",
  "&lt;",
  "&gt;",
  "p",
  "ul",
  "li",
  "h2",
  "pre",
  "Table",
  "<p>",
  "</p>",
  "<li ",
  "&lt;p&gt;",
  "a=`v`"
)
const prose = fc.array(piece, { maxLength: 24 }).map((pieces) => pieces.join(""))

describe("proseParagraphs", () => {
  it("joins the claim and the first body paragraph with a space, and keeps a whole fence apart", () => {
    expect(
      proseParagraphs("Run `make.", ["`<p>` is the paragraph element.", "```\n<p>\n```"])
    ).toEqual([
      { kind: "p", claim: "Run `make.", text: "`<p>` is the paragraph element.", index: 0 },
      { kind: "figure", block: { code: "<p>" }, index: 1 }
    ])
    const [first] = proseParagraphs("Run `make.", ["`<p>` is the paragraph element."])
    expect(first?.kind === "p" && proseParagraphText(first)).toBe(
      "Run `make. `<p>` is the paragraph element."
    )
  })

  it("plans the paragraphs the template renders, so reading the plan reads the file", () => {
    fc.assert(
      fc.property(prose, fc.array(prose, { maxLength: 4 }), (claim, body) => {
        const planned = proseParagraphs(claim, body)
          .map((paragraph) =>
            paragraph.kind === "p" ? blockTagInRun(proseParagraphText(paragraph))?.tag : undefined
          )
          .find((tag) => tag !== undefined)
        expect(planned).toBe(blockTagInArticle(fromProse(claim, body))?.tag)
      }),
      { numRuns: 3000 }
    )
  })
})

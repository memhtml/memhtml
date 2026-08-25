import { describe, expect, it } from "vitest"

import { isRootRelativeHref, isValidDatetime } from "../src/constraints.js"
import { checkMemory } from "../src/parse.js"
import { fileWith, MINIMAL_ARTICLE, MINIMAL_FILE, parseErr, parseOk } from "./fixtures.js"

/**
 * The six format constraints. Each rejection is asserted by the violation it names, not merely
 * by "it failed" — a test that only checks failure passes when the wrong constraint fires.
 */

describe("constraint 1 — exactly one <article> and one <mark>", () => {
  it("rejects a file with no <article>", () => {
    expect(
      parseErr(`<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>`)
    ).toContain("no <article>")
  })

  it("rejects two <article> elements", () => {
    const html = MINIMAL_FILE.replace(
      "</article>",
      "</article>\n<article><p><mark>Second.</mark></p></article>"
    )
    expect(parseErr(html)).toContain("2 <article> elements")
  })

  it("rejects a file with no <mark>", () => {
    expect(parseErr(fileWith("<p>Prose with no claim.</p>"))).toContain("no <mark>")
  })

  it("rejects two <mark> elements", () => {
    expect(parseErr(fileWith("<p><mark>One.</mark> <mark>Two.</mark></p>"))).toContain(
      "2 <mark> elements"
    )
  })

  it("rejects a <mark> outside the first <p>", () => {
    expect(parseErr(fileWith("<p>Lead paragraph.</p><p><mark>Buried claim.</mark></p>"))).toContain(
      "not in the first <p>"
    )
  })

  it("accepts a <mark> leading the first <li>", () => {
    const doc = parseOk(
      fileWith("<ul><li><mark>A listed claim.</mark></li><li>Another item.</li></ul>")
    )
    expect(doc.article.gist).toBe("A listed claim.")
  })

  it("rejects a <mark> outside every <p> and <li>", () => {
    expect(parseErr(fileWith("<mark>Bare claim.</mark>"))).toContain("outside any <p> or <li>")
  })

  /**
   * The claim span must SAY something. An empty `<mark>` satisfies the count and the placement
   * rules, so before this the gate passed `<p><mark></mark> the prose</p>` — a file that commits
   * and indexes with an empty `files.gist`, absent from every disclosure tier and from the recall
   * pack's quoted body. Invisible rather than wrong, which is worse.
   *
   * Emptiness is the GIST rule, not raw text: `parse.ts`'s `gist` excludes `<pre>`/`<code>`, so a
   * mark whose only content is a command line has an empty gist and must fail here too — the
   * constraint and the extraction have to agree, or the gate would pass a file whose indexed gist
   * is empty anyway.
   */
  it("rejects an empty <mark>", () => {
    expect(parseErr(fileWith("<p><mark></mark> The prose that has no claim.</p>"))).toContain(
      "empty <mark>"
    )
  })

  it("rejects a whitespace-only <mark>, including a non-breaking space", () => {
    for (const inner of [" ", "\n  \t ", "&nbsp;", "&#160;"]) {
      expect(parseErr(fileWith(`<p><mark>${inner}</mark> Prose.</p>`)), inner).toContain(
        "empty <mark>"
      )
    }
  })

  it("rejects a <mark> whose only content is code, which the gist rule excludes", () => {
    expect(parseErr(fileWith("<p><mark><code>drain --vip</code></mark> Prose.</p>"))).toContain(
      "empty <mark>"
    )
  })

  it("accepts a <mark> whose text arrives through a nested inline element", () => {
    // The mutation-proof pair: a check reading only DIRECT text (like `textOf`) would call this
    // empty and refuse a legitimate claim.
    const doc = parseOk(fileWith("<p><mark>A <strong>bold</strong> claim.</mark></p>"))
    expect(doc.article.gist).toBe("A bold claim.")
  })

  it("ties the violation to an empty gist exactly", () => {
    // The constraint and the extraction agree by construction: whatever `checkMemory` refuses as
    // empty is what `parseMemory` would have stored as `gist: ""`. Asserted on the pair, because
    // a constraint stricter than the extraction would refuse files that index fine.
    const nonEmpty = parseOk(fileWith("<p><mark>Words.</mark> <code>x</code></p>"))
    expect(nonEmpty.article.gist).not.toBe("")
    expect(checkMemory(fileWith("<p><mark> </mark> Words.</p>")).violations).toContain(
      "empty <mark>: the claim span must say something"
    )
  })
})

describe("constraint 2 — <time> carries a sortable datetime", () => {
  it("rejects a <time> with no datetime", () => {
    expect(parseErr(fileWith("<p><mark>A claim.</mark> On <time>July 28</time>.</p>"))).toContain(
      "<time> without datetime"
    )
  })

  it("rejects a datetime that is not an ISO date", () => {
    expect(
      parseErr(fileWith('<p><mark>A claim.</mark> On <time datetime="July 28">then</time>.</p>'))
    ).toContain("is not an ISO date")
  })

  it("rejects an out-of-range date that would sort unpredictably", () => {
    expect(
      parseErr(fileWith('<p><mark>A claim.</mark> <time datetime="2026-13-45">x</time></p>'))
    ).toContain("is not an ISO date")
  })

  it("accepts a bare date and a canonical UTC instant", () => {
    for (const value of ["2026-07-28", "2026-07-28T14:03:11Z"]) {
      expect(isValidDatetime(value), value).toBe(true)
    }
  })

  it("refuses the HTML datetime forms that do not sort as dates", () => {
    for (const value of ["2026-W31", "14:03", "P3D", "2026-07", "2026"]) {
      expect(isValidDatetime(value), value).toBe(false)
    }
  })

  /**
   * `files.event_at`, `files.due_at`, and `files.valid_until` are compared as RAW strings, so
   * every admitted value must sort lexicographically as it sorts chronologically. Each of these
   * is a real ISO-8601 or HTML `datetime` form whose admission would corrupt that ordering:
   * the space separator sorts before `T` (`"2026-08-24 13:00" < "2026-08-24T12:00"` while being
   * an hour later), an offset sorts by clock face rather than instant, and variable precision
   * makes a longer string sort after the shorter one it merely refines.
   */
  it("refuses the ISO variants whose string order disagrees with their instant order", () => {
    for (const value of [
      "2026-08-24 13:00:00Z", // space separator sorts before every T-form on the same day
      "2026-07-28T14:03+02:00", // non-UTC offset sorts by clock face, not instant
      "2026-07-28T14:03:11+05:00",
      "2026-07-28T14:03:11-0500",
      "2026-07-28T14:03Z", // minute precision sorts before its own :00 second
      "2026-07-28T14:03:11", // zoneless is not comparable with a Z instant
      "2026-07-28T14:03:11.500Z" // fractional seconds sort after the instant they refine
    ]) {
      expect(isValidDatetime(value), value).toBe(false)
    }
  })

  it("refuses a mis-sorting variant end to end, through the <time> constraint", () => {
    expect(
      parseErr(
        fileWith('<p><mark>A claim.</mark> <time datetime="2026-08-24 13:00:00Z">x</time></p>')
      )
    ).toContain("is not an ISO date")
  })

  it("refuses a day that does not exist in its month", () => {
    expect(isValidDatetime("2026-02-30")).toBe(false)
    expect(isValidDatetime("2024-02-29")).toBe(true)
  })

  it("refuses a clock time no clock shows, which would not sort as an instant", () => {
    for (const value of [
      "2026-07-28T25:00:00Z",
      "2026-07-28T24:00",
      "2026-07-28T12:60",
      "2026-07-28T12:00:99",
      "2026-07-28T12:00:00+25:00"
    ]) {
      expect(isValidDatetime(value), value).toBe(false)
    }
    // A leap second is a real instant and sorts correctly, so it stays admissible.
    expect(isValidDatetime("2026-06-30T23:59:60Z")).toBe(true)
  })
})

describe("constraint 3 — no presentation, no execution", () => {
  it("rejects a class attribute", () => {
    expect(parseErr(fileWith('<p class="lead"><mark>A claim.</mark></p>'))).toContain(
      "class attribute"
    )
  })

  it("rejects a style attribute", () => {
    expect(parseErr(fileWith('<p style="color:red"><mark>A claim.</mark></p>'))).toContain(
      "style attribute"
    )
  })

  it("rejects a <script> in the body", () => {
    expect(parseErr(fileWith("<p><mark>A claim.</mark></p><script>alert(1)</script>"))).toContain(
      "<script> is forbidden"
    )
  })

  it("rejects a <script> in the head", () => {
    expect(parseErr(fileWith(MINIMAL_ARTICLE, "<script>alert(1)</script>"))).toContain(
      "<script> is forbidden"
    )
  })

  it("rejects an event handler", () => {
    expect(parseErr(fileWith('<p><mark onclick="go()">A claim.</mark></p>'))).toContain(
      "onclick handler"
    )
  })

  it("rejects a <style> element", () => {
    expect(parseErr(fileWith(MINIMAL_ARTICLE, "<style>p{color:red}</style>"))).toContain(
      "<style> is forbidden"
    )
  })
})

describe("constraint 4 — link rels and hrefs", () => {
  it("rejects a rel outside the closed edge vocabulary", () => {
    expect(
      parseErr(fileWith(MINIMAL_ARTICLE, '<link rel="memhtml-inspires" href="/areas/x.html">'))
    ).toContain("outside the closed edge vocabulary")
  })

  it("rejects a relative href", () => {
    expect(
      parseErr(fileWith(MINIMAL_ARTICLE, '<link rel="memhtml-part-of" href="../areas/x.html">'))
    ).toContain("not repo-root-relative")
  })

  it("rejects an absolute href that leaves the repo", () => {
    expect(
      parseErr(
        fileWith(MINIMAL_ARTICLE, '<link rel="memhtml-part-of" href="https://x.test/a.html">')
      )
    ).toContain("not repo-root-relative")
  })

  it("rejects a traversal segment", () => {
    expect(isRootRelativeHref("/areas/../../etc/passwd")).toBe(false)
    expect(isRootRelativeHref("//evil.test/x.html")).toBe(false)
    expect(isRootRelativeHref("/areas/arcs/x.html")).toBe(true)
  })

  it("rejects a memhtml- link with no href", () => {
    expect(parseErr(fileWith(MINIMAL_ARTICLE, '<link rel="memhtml-part-of">'))).toContain(
      "without href"
    )
  })

  it("ignores a non-memhtml link entirely", () => {
    const doc = parseOk(fileWith(MINIMAL_ARTICLE, '<link rel="stylesheet" href="../style.css">'))
    expect(doc.links).toEqual([])
  })

  it("accepts every rel of the closed vocabulary", () => {
    const links = [
      '<link rel="memhtml-supersedes" href="/archive/2026/a.html">',
      '<link rel="memhtml-laterally-related" href="/areas/b.html">',
      '<link rel="memhtml-about-person" href="/resources/people/sanju.html">',
      '<link rel="memhtml-from-session" href="/resources/sessions/s.html">'
    ].join("\n")
    const doc = parseOk(fileWith(MINIMAL_ARTICLE, links))
    expect(doc.links.map((link) => link.rel)).toEqual([
      "supersedes",
      "laterally_related",
      "about_person",
      "from_session"
    ])
  })
})

describe("constraint 5 — the claim is never behind a fold or in a caveat", () => {
  it("rejects a <mark> inside an <aside>", () => {
    expect(parseErr(fileWith("<aside><p><mark>A caveat claim.</mark></p></aside>"))).toContain(
      "<mark> inside <aside>"
    )
  })

  it("rejects a <mark> inside a <details>", () => {
    expect(
      parseErr(
        fileWith("<details><summary>s</summary><p><mark>A hidden claim.</mark></p></details>")
      )
    ).toContain("<mark> inside <details>")
  })

  it("rejects a <mark> inside a <summary>", () => {
    expect(
      parseErr(fileWith("<details><summary><mark>x</mark></summary><p>b</p></details>"))
    ).toContain("<mark> inside <details>")
  })
})

describe("constraint 6 — an unknown element warns, it does not fail", () => {
  it("parses a file with an unknown element and reports a warning", () => {
    const doc = parseOk(fileWith("<p><mark>A claim.</mark></p><blink>legacy</blink>"))
    expect(doc.warnings).toEqual(["<blink> is outside the closed vocabulary"])
  })

  it("still extracts body text from the unknown element", () => {
    const doc = parseOk(fileWith("<p><mark>A claim.</mark></p><blink>legacy prose</blink>"))
    expect(doc.article.bodyText).toContain("legacy prose")
  })

  it("warns once per element name however many times it appears", () => {
    const doc = parseOk(
      fileWith("<p><mark>A claim.</mark></p><blink>a</blink><blink>b</blink><marquee>c</marquee>")
    )
    expect(doc.warnings).toHaveLength(2)
  })

  it("warns on a <div> outside a <figure> but not inside one", () => {
    const outside = parseOk(fileWith("<p><mark>A claim.</mark></p><div>box</div>"))
    expect(outside.warnings).toEqual(["<div> outside a <figure>: use a semantic element instead"])

    const inside = parseOk(
      fileWith("<p><mark>A claim.</mark></p><figure><div><span>x</span></div></figure>")
    )
    expect(inside.warnings).toEqual([])
  })

  it("accepts <address> for a person file", () => {
    const doc = parseOk(
      fileWith("<p><mark>Sanju reviews the deploy path.</mark></p><address>sanju@x</address>")
    )
    expect(doc.warnings).toEqual([])
  })

  it("accepts a well-formed data-lang silently", () => {
    const doc = parseOk(
      fileWith(
        '<p><mark>A claim.</mark></p><figure><pre><code data-lang="c++">x</code></pre></figure>'
      )
    )
    expect(doc.warnings).toEqual([])
  })

  it("warns on a data-lang outside the token grammar, and still parses", () => {
    // Retrieval decoration degrades gracefully; refusing the file over it would violate the
    // hand-authored-file rule constraint 6 exists for.
    const doc = parseOk(
      fileWith(
        '<p><mark>A claim.</mark></p><figure><pre><code data-lang="not a lang">x</code></pre></figure>'
      )
    )
    expect(doc.warnings).toEqual(['data-lang="not a lang" is not a language token'])
  })
})

describe("head well-formedness", () => {
  it("rejects each missing required meta by name", () => {
    for (const name of ["memhtml-type", "memhtml-status", "memhtml-created", "memhtml-updated"]) {
      const html = MINIMAL_FILE.split("\n")
        .filter((line) => !line.includes(`name="${name}"`))
        .join("\n")
      expect(parseErr(html), name).toContain(`missing required <meta name="${name}">`)
    }
  })

  it("rejects an empty title", () => {
    expect(
      parseErr(MINIMAL_FILE.replace("<title>A test memory</title>", "<title></title>"))
    ).toContain("empty <title>")
  })

  it("rejects a duplicated non-repeatable meta", () => {
    expect(
      parseErr(fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-type" content="episodic">'))
    ).toContain("appears 2 times but is not repeatable")
  })

  it("accepts repeated memhtml-entity, memhtml-tag, and memhtml-alias", () => {
    const doc = parseOk(
      fileWith(
        MINIMAL_ARTICLE,
        [
          '<meta name="memhtml-entity" content="service:a">',
          '<meta name="memhtml-entity" content="person:b">',
          '<meta name="memhtml-tag" content="one">',
          '<meta name="memhtml-tag" content="two">',
          '<meta name="memhtml-alias" content="b short">',
          '<meta name="memhtml-alias" content="b.short">'
        ].join("\n")
      )
    )
    expect(doc.entities).toEqual(["service:a", "person:b"])
    expect(doc.tags).toEqual(["one", "two"])
    /**
     * Repeated and in DOCUMENT ORDER, which is what a person file's declaration needs: a subject may be
     * recorded under several names and each is its own line, so correcting one is a one-line diff in a
     * file a human edits. A parse that kept only the first would silently discard every alias but one,
     * and the merges those aliases authorize would then wait two nights instead of applying.
     */
    expect(doc.aliases).toEqual(["b short", "b.short"])
  })

  it("carries no aliases on a file that declares none, rather than an absent field", () => {
    // Sleep iterates `doc.aliases`, so an absent field would be a crash in a phase reading an ordinary
    // memory rather than a person file.
    expect(parseOk(fileWith(MINIMAL_ARTICLE, "")).aliases).toEqual([])
  })

  it("rejects a memhtml- meta outside the closed metadata vocabulary", () => {
    expect(
      parseErr(fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-vibe" content="good">'))
    ).toContain("outside the closed metadata vocabulary")
  })

  it("rejects a type outside the memory-type vocabulary", () => {
    expect(parseErr(MINIMAL_FILE.replace('content="semantic"', 'content="folklore"'))).toContain(
      "outside the type vocabulary"
    )
  })

  it("rejects a status that is neither active nor archived", () => {
    expect(
      parseErr(
        MINIMAL_FILE.replace('memhtml-status" content="active"', 'memhtml-status" content="draft"')
      )
    ).toContain("neither active nor archived")
  })
})

describe("checkMemory", () => {
  it("reports every violation at once rather than the first", () => {
    const { violations } = checkMemory(fileWith('<p class="x">Prose with no claim.</p>'))
    expect(violations.length).toBeGreaterThan(1)
    expect(violations.some((violation) => violation.includes("no <mark>"))).toBe(true)
    expect(violations.some((violation) => violation.includes("class attribute"))).toBe(true)
  })

  it("is total on input that is not a document at all", () => {
    const { violations } = checkMemory("not html")
    expect(violations.length).toBeGreaterThan(0)
  })

  it("reports a clean file as clean", () => {
    expect(checkMemory(MINIMAL_FILE)).toEqual({ violations: [], warnings: [] })
  })

  /**
   * `checkMemory` REPORTING is not the same guarantee as `parseMemory` REFUSING, and the store's
   * render gate (`packages/store/src/store.ts`) calls `checkMemory` while every read calls
   * `parseMemory`. Both are asserted on the same bytes, so a constraint wired into one and not the
   * other — which would let a file pass the write gate and then fail every read — cannot ship.
   */
  it("refuses an empty <mark> on both entry points, on the same bytes", () => {
    const html = fileWith("<p><mark></mark> Prose with no claim.</p>")
    expect(checkMemory(html).violations).toContain(
      "empty <mark>: the claim span must say something"
    )
    expect(parseErr(html)).toContain("empty <mark>")
  })
})

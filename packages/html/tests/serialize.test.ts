import { describe, expect, it } from "vitest"

import { metaPairs, serializeMemory } from "../src/serialize.js"
import { META_ORDER, REPEATABLE_META } from "../src/vocabulary.js"
import { FORMAT_MD_EXAMPLE, fileWith, MINIMAL_ARTICLE, parseOk } from "./fixtures.js"

/**
 * Serialization determinism. The reason it matters is git: a head whose line order depended on
 * anything but {@link META_ORDER} would turn a one-key stamp into a whole-head diff, and a
 * whole-head diff is one nobody reads twice.
 */

describe("determinism", () => {
  it("is a fixed point — serializing a parsed file twice yields identical bytes", () => {
    const first = serializeMemory(parseOk(FORMAT_MD_EXAMPLE))
    const second = serializeMemory(parseOk(first))
    expect(second).toBe(first)
  })

  it("reaches the fixed point after one pass, however many follow", () => {
    let html = serializeMemory(parseOk(FORMAT_MD_EXAMPLE))
    for (let pass = 0; pass < 5; pass += 1) {
      const next = serializeMemory(parseOk(html))
      expect(next, `pass ${pass}`).toBe(html)
      html = next
    }
  })

  it("emits one meta per line", () => {
    const html = serializeMemory(parseOk(FORMAT_MD_EXAMPLE))
    for (const line of html.split("\n")) {
      expect(line.split("<meta").length - 1).toBeLessThanOrEqual(1)
    }
  })

  it("emits one link per line", () => {
    const html = serializeMemory(parseOk(FORMAT_MD_EXAMPLE))
    for (const line of html.split("\n")) {
      expect(line.split("<link").length - 1).toBeLessThanOrEqual(1)
    }
  })

  it("orders metas by META_ORDER regardless of source order", () => {
    const scrambled = fileWith(
      MINIMAL_ARTICLE,
      [
        '<meta name="memhtml-tag" content="z">',
        '<meta name="memhtml-importance" content="3">',
        '<meta name="memhtml-author" content="agent:x">',
        '<meta name="memhtml-confidence" content="0.50">'
      ].join("\n")
    )
    const names = serializeMemory(parseOk(scrambled))
      .split("\n")
      .flatMap((line) => {
        const match = /<meta name="(memhtml-[^"]+)"/.exec(line)
        return match?.[1] === undefined ? [] : [match[1]]
      })
    const expected = [...names].sort(
      (left, right) =>
        (META_ORDER as ReadonlyArray<string>).indexOf(left) -
        (META_ORDER as ReadonlyArray<string>).indexOf(right)
    )
    expect(names).toEqual(expected)
  })

  it("puts every link after every meta", () => {
    const lines = serializeMemory(parseOk(FORMAT_MD_EXAMPLE)).split("\n")
    const lastMeta = lines.findLastIndex((line) => line.startsWith('<meta name="memhtml-'))
    const firstLink = lines.findIndex((line) => line.startsWith("<link"))
    expect(firstLink).toBeGreaterThan(lastMeta)
  })

  it("writes name before content on every meta line", () => {
    for (const line of serializeMemory(parseOk(FORMAT_MD_EXAMPLE)).split("\n")) {
      if (!line.startsWith('<meta name="memhtml-')) continue
      expect(line.indexOf("name=")).toBeLessThan(line.indexOf("content="))
    }
  })

  it("ends with exactly one trailing newline, so the file is POSIX-clean", () => {
    const html = serializeMemory(parseOk(FORMAT_MD_EXAMPLE))
    expect(html.endsWith("\n")).toBe(true)
    expect(html.endsWith("\n\n")).toBe(false)
  })

  it("canonicalizes attribute order in the article", () => {
    const one = serializeMemory(
      parseOk(fileWith('<p><mark>A claim.</mark> <a href="/x.html" title="T">l</a></p>'))
    )
    const two = serializeMemory(
      parseOk(fileWith('<p><mark>A claim.</mark> <a title="T" href="/x.html">l</a></p>'))
    )
    expect(two).toBe(one)
  })
})

describe("round trip", () => {
  it("parse(serialize(doc)) equals doc for the format.md example", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(parseOk(serializeMemory(doc))).toEqual(doc)
  })

  it("preserves every meta value across the round trip", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    expect(parseOk(serializeMemory(doc)).metas).toEqual(doc.metas)
  })

  it("preserves links, entities, and tags in order", () => {
    const doc = parseOk(FORMAT_MD_EXAMPLE)
    const again = parseOk(serializeMemory(doc))
    expect(again.links).toEqual(doc.links)
    expect(again.entities).toEqual(doc.entities)
    expect(again.tags).toEqual(doc.tags)
  })

  it("preserves every REPEATABLE meta, including the one the shared example does not carry", () => {
    /**
     * The round trip above is asserted against `FORMAT_MD_EXAMPLE`, which carries entities and tags and
     * no `memhtml-alias` — so a serializer that silently dropped aliases would pass every case in this
     * file. That is the shape of loss this format's own guarantee exists to refuse: sleep reads a
     * person file, edits it, and writes it back, and an alias lost on that pass would un-declare an
     * identity a human wrote down, with no error anywhere.
     *
     * The assertion is derived from `REPEATABLE_META` rather than listing the three names, so a fourth
     * repeatable is covered here the day it is added instead of the day someone remembers.
     *
     * (Verified by mutation: removing the `memhtml-alias` entry from `serialize.ts`'s `repeatables` map
     * fails this case and NOTHING else in the package.)
     */
    const html = fileWith(
      MINIMAL_ARTICLE,
      [
        '<meta name="memhtml-entity" content="person:laith al-saadoon">',
        '<meta name="memhtml-tag" content="team">',
        '<meta name="memhtml-alias" content="laith">',
        '<meta name="memhtml-alias" content="l.alsaadoon">'
      ].join("\n")
    )
    const doc = parseOk(html)
    const again = parseOk(serializeMemory(doc))

    for (const name of REPEATABLE_META) {
      const emitted = metaPairs(again)
        .filter(([key]) => key === name)
        .map(([, value]) => value)
      const authored = metaPairs(doc)
        .filter(([key]) => key === name)
        .map(([, value]) => value)
      expect(emitted.length, `${name} lost values`).toBeGreaterThan(0)
      expect(emitted, name).toEqual(authored)
    }
    expect(again.aliases).toEqual(["laith", "l.alsaadoon"])
  })

  it("emits a new repeatable AFTER the established ones, so no existing head line moves", () => {
    // Position in `META_ORDER` is the diff-stability contract, asserted on the emitted bytes rather than
    // on the constant: appending `memhtml-alias` must not push `memhtml-entity` or `memhtml-tag` down.
    const html = serializeMemory(
      parseOk(
        fileWith(
          MINIMAL_ARTICLE,
          [
            '<meta name="memhtml-alias" content="laith">',
            '<meta name="memhtml-entity" content="person:laith al-saadoon">',
            '<meta name="memhtml-tag" content="team">'
          ].join("\n")
        )
      )
    )
    const lines = html.split("\n")
    const at = (name: string) => lines.findIndex((line) => line.startsWith(`<meta name="${name}"`))
    expect(at("memhtml-entity")).toBeLessThan(at("memhtml-tag"))
    expect(at("memhtml-tag")).toBeLessThan(at("memhtml-alias"))
  })
})

describe("escaping", () => {
  it("round-trips a title carrying markup characters", () => {
    const html = fileWith(MINIMAL_ARTICLE).replace(
      "<title>A test memory</title>",
      "<title>Use &lt;pre&gt; &amp; not &quot;code&quot;</title>"
    )
    const doc = parseOk(html)
    expect(doc.title).toBe('Use <pre> & not "code"')
    expect(parseOk(serializeMemory(doc)).title).toBe(doc.title)
  })

  it("round-trips a meta value carrying a double quote", () => {
    const doc = parseOk(
      fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-author" content="human:a&quot;b">')
    )
    expect(doc.metas.author).toBe('human:a"b')
    expect(parseOk(serializeMemory(doc)).metas.author).toBe('human:a"b')
  })

  it("round-trips an href carrying an ampersand", () => {
    const doc = parseOk(
      fileWith(MINIMAL_ARTICLE, '<link rel="memhtml-part-of" href="/areas/a.html?x=1&amp;y=2">')
    )
    expect(doc.links[0]?.href).toBe("/areas/a.html?x=1&y=2")
    expect(parseOk(serializeMemory(doc)).links).toEqual(doc.links)
  })

  it("names a no-break space rather than leaving it invisible", () => {
    const html = serializeMemory(parseOk(fileWith("<p><mark>A claim.</mark></p>")))
    expect(html).toContain("&nbsp;")
    expect(parseOk(html).article.gist).toBe("A claim.")
  })

  it("round-trips article text carrying markup characters", () => {
    const doc = parseOk(fileWith("<p><mark>Use 3 &lt; 5 &amp;&amp; 7 &gt; 2.</mark></p>"))
    expect(doc.article.gist).toBe("Use 3 < 5 && 7 > 2.")
    expect(parseOk(serializeMemory(doc)).article.gist).toBe(doc.article.gist)
  })
})

describe("metaPairs", () => {
  it("expands a repeatable key to one pair per value", () => {
    const pairs = metaPairs(parseOk(FORMAT_MD_EXAMPLE))
    expect(pairs.filter(([name]) => name === "memhtml-entity")).toEqual([
      ["memhtml-entity", "service:checkout-api"]
    ])
  })

  it("omits an absent optional entirely", () => {
    const pairs = metaPairs(parseOk(fileWith(MINIMAL_ARTICLE)))
    expect(pairs.map(([name]) => name)).toEqual([
      "memhtml-type",
      "memhtml-status",
      "memhtml-created",
      "memhtml-updated"
    ])
  })

  it("formats confidence with two decimals and importance as an integer", () => {
    const doc = parseOk(
      fileWith(
        MINIMAL_ARTICLE,
        '<meta name="memhtml-confidence" content="0.9">\n<meta name="memhtml-importance" content="8">'
      )
    )
    const pairs = new Map(metaPairs(doc))
    expect(pairs.get("memhtml-confidence")).toBe("0.90")
    expect(pairs.get("memhtml-importance")).toBe("8")
  })

  it("renders a boolean meta as true or false", () => {
    const doc = parseOk(
      fileWith(MINIMAL_ARTICLE, '<meta name="memhtml-needs-revision" content="yes">')
    )
    expect(new Map(metaPairs(doc)).get("memhtml-needs-revision")).toBe("true")
  })
})

describe("void and raw-text elements", () => {
  it("never emits a closing tag for a void element", () => {
    const html = serializeMemory(parseOk(FORMAT_MD_EXAMPLE))
    expect(html).not.toContain("</meta>")
    expect(html).not.toContain("</link>")
  })

  it("round-trips a comment in the article", () => {
    const doc = parseOk(fileWith("<p><mark>A claim.</mark></p><!-- an authoring note -->"))
    const html = serializeMemory(doc)
    expect(html).toContain("<!-- an authoring note -->")
    expect(parseOk(html).article.html).toBe(doc.article.html)
  })

  it("round-trips a table, whose tbody the parser inserts", () => {
    const doc = parseOk(fileWith("<p><mark>A claim.</mark></p><table><tr><td>a</td></tr></table>"))
    expect(doc.article.html).toContain("<tbody>")
    expect(parseOk(serializeMemory(doc)).article.html).toBe(doc.article.html)
  })
})

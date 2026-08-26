import { describe, expect, it } from "vitest"

import { addLink, addMeta, readMeta, removeLink, removeMeta, setMeta } from "../src/editors.js"
import { contentHash } from "../src/hash.js"
import { META_ORDER } from "../src/vocabulary.js"
import { FORMAT_MD_EXAMPLE, fileWith, MINIMAL_ARTICLE, parseOk } from "./fixtures.js"

/**
 * The surgical head editors. Two properties are asserted throughout: exactly one line changes,
 * and the article's bytes are untouched. Both are what let a corpus-wide decay pass over the whole
 * corpus produce a reviewable diff instead of a rewrite.
 */

/** Lines that differ between two versions of a file, as `[before, after]` counts. */
const lineDelta = (before: string, after: string): { changed: number; added: number } => {
  const left = before.split("\n")
  const right = after.split("\n")
  const added = right.length - left.length
  let changed = 0
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      changed += 1
      break
    }
  }
  return { changed, added }
}

/** The article region of a file, as bytes, for an untouched-article assertion. */
const articleRegion = (html: string): string => html.slice(html.indexOf("<article>"))

describe("setMeta — replace in place", () => {
  it("changes exactly one line when the meta is present", () => {
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-confidence", "0.75")
    expect(lineDelta(FORMAT_MD_EXAMPLE, after)).toEqual({ changed: 1, added: 0 })
    expect(after).toContain('<meta name="memhtml-confidence" content="0.75">')
  })

  it("leaves the article bytes identical", () => {
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-updated", "2027-01-01T00:00:00Z")
    expect(articleRegion(after)).toBe(articleRegion(FORMAT_MD_EXAMPLE))
  })

  it("adds exactly one line when the meta is absent", () => {
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-needs-revision", "true")
    expect(lineDelta(FORMAT_MD_EXAMPLE, after).added).toBe(1)
    expect(after).toContain('<meta name="memhtml-needs-revision" content="true">')
  })

  it("inserts a new meta in META_ORDER position", () => {
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-reprieves", "1")
    const lines = after.split("\n")
    const reprieves = lines.findIndex((line) => line.includes('name="memhtml-reprieves"'))
    const prompt = lines.findIndex((line) => line.includes('name="memhtml-prompt"'))
    const entity = lines.findIndex((line) => line.includes('name="memhtml-entity"'))
    expect(reprieves).toBeGreaterThan(prompt)
    expect(reprieves).toBeLessThan(entity)
  })

  it("keeps the head ordered after inserting every absent meta in turn", () => {
    let html = fileWith(MINIMAL_ARTICLE)
    for (const name of [...META_ORDER].reverse()) {
      html = setMeta(html, name, `v-${name}`)
    }
    const names = html.split("\n").flatMap((line) => {
      const match = /<meta name="(memhtml-[^"]+)"/.exec(line)
      return match?.[1] === undefined ? [] : [match[1]]
    })
    const indices = names.map((name) => (META_ORDER as ReadonlyArray<string>).indexOf(name))
    expect(indices).toEqual([...indices].sort((left, right) => left - right))
  })

  it("refuses a name outside the closed vocabulary", () => {
    expect(setMeta(FORMAT_MD_EXAMPLE, "memhtml-vibe", "good")).toBe(FORMAT_MD_EXAMPLE)
    expect(setMeta(FORMAT_MD_EXAMPLE, "description", "x")).toBe(FORMAT_MD_EXAMPLE)
  })

  it("sets the FIRST value of a repeatable key, leaving the others", () => {
    const before = fileWith(
      MINIMAL_ARTICLE,
      '<meta name="memhtml-tag" content="a">\n<meta name="memhtml-tag" content="b">'
    )
    const doc = parseOk(setMeta(before, "memhtml-tag", "z"))
    expect(doc.tags).toEqual(["z", "b"])
  })

  it("produces a file that still parses", () => {
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-status", "archived")
    expect(parseOk(after).metas.status).toBe("archived")
  })

  it("escapes a value carrying a double quote", () => {
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-author", 'human:a"b')
    expect(parseOk(after).metas.author).toBe('human:a"b')
  })

  it("keeps a value carrying a newline on one line, which the byte splicers depend on", () => {
    // The editors locate a meta by its line boundaries, so a literal newline inside an
    // attribute would split one head entry across two of their lines and the next splice
    // would cut a line in half.
    const after = setMeta(FORMAT_MD_EXAMPLE, "memhtml-author", "human:a\nb")
    for (const line of after.split("\n")) {
      expect(line.split("<meta").length - 1).toBeLessThanOrEqual(1)
    }
    expect(lineDelta(FORMAT_MD_EXAMPLE, after).added).toBe(0)
    expect(parseOk(after).metas.author).toBe("human:a\nb")
  })
})

describe("addMeta — append a repeatable value", () => {
  it("appends after the last meta of that name", () => {
    const after = addMeta(FORMAT_MD_EXAMPLE, "memhtml-tag", "oncall")
    expect(parseOk(after).tags).toEqual(["deploy", "oncall"])
    expect(lineDelta(FORMAT_MD_EXAMPLE, after).added).toBe(1)
  })

  it("is idempotent on a value already present", () => {
    const once = addMeta(FORMAT_MD_EXAMPLE, "memhtml-tag", "oncall")
    expect(addMeta(once, "memhtml-tag", "oncall")).toBe(once)
  })

  it("inserts in META_ORDER position when no meta of that name exists", () => {
    const before = fileWith(MINIMAL_ARTICLE)
    const after = addMeta(before, "memhtml-entity", "service:a")
    expect(parseOk(after).entities).toEqual(["service:a"])
  })

  it("leaves the article bytes identical", () => {
    const after = addMeta(FORMAT_MD_EXAMPLE, "memhtml-entity", "person:sanju")
    expect(articleRegion(after)).toBe(articleRegion(FORMAT_MD_EXAMPLE))
  })
})

describe("removeMeta", () => {
  it("removes one whole line", () => {
    const after = removeMeta(FORMAT_MD_EXAMPLE, "memhtml-confidence")
    expect(after.split("\n").length).toBe(FORMAT_MD_EXAMPLE.split("\n").length - 1)
    expect(after).not.toContain("memhtml-confidence")
  })

  it("removes every occurrence of a repeatable key", () => {
    const two = addMeta(FORMAT_MD_EXAMPLE, "memhtml-tag", "oncall")
    expect(parseOk(removeMeta(two, "memhtml-tag")).tags).toEqual([])
  })

  it("is a no-op on an absent name", () => {
    expect(removeMeta(FORMAT_MD_EXAMPLE, "memhtml-reprieves")).toBe(FORMAT_MD_EXAMPLE)
  })
})

describe("addLink", () => {
  it("appends after the last existing memhtml- link", () => {
    const after = addLink(FORMAT_MD_EXAMPLE, "contradicts", "/areas/oncall/other.html")
    expect(parseOk(after).links.map((link) => link.rel)).toEqual([
      "supersedes",
      "part_of",
      "contradicts"
    ])
  })

  it("writes the hyphenated rel token, not the underscored rel", () => {
    const after = addLink(FORMAT_MD_EXAMPLE, "laterally_related", "/areas/x.html")
    expect(after).toContain('<link rel="memhtml-laterally-related" href="/areas/x.html">')
    expect(after).not.toContain("memhtml-laterally_related")
  })

  it("is idempotent on the same rel and href", () => {
    const once = addLink(FORMAT_MD_EXAMPLE, "supports", "/areas/x.html")
    expect(addLink(once, "supports", "/areas/x.html")).toBe(once)
  })

  it("adds a second href under the same rel", () => {
    const twice = addLink(addLink(FORMAT_MD_EXAMPLE, "supports", "/a.html"), "supports", "/b.html")
    expect(parseOk(twice).links.filter((link) => link.rel === "supports")).toHaveLength(2)
  })

  it("adds a link to a file that has none", () => {
    const after = addLink(fileWith(MINIMAL_ARTICLE), "part_of", "/areas/arcs/a.html")
    expect(parseOk(after).links).toEqual([{ rel: "part_of", href: "/areas/arcs/a.html" }])
  })

  it("leaves the article bytes identical", () => {
    const after = addLink(FORMAT_MD_EXAMPLE, "supports", "/areas/x.html")
    expect(articleRegion(after)).toBe(articleRegion(FORMAT_MD_EXAMPLE))
  })
})

describe("removeLink", () => {
  it("removes one specific rel and href pair", () => {
    const after = removeLink(FORMAT_MD_EXAMPLE, "part_of", "/areas/arcs/reversibility-first.html")
    expect(parseOk(after).links.map((link) => link.rel)).toEqual(["supersedes"])
  })

  it("removes every href of a rel when none is named", () => {
    const two = addLink(FORMAT_MD_EXAMPLE, "supports", "/a.html")
    const three = addLink(two, "supports", "/b.html")
    expect(
      parseOk(removeLink(three, "supports")).links.some((link) => link.rel === "supports")
    ).toBe(false)
  })

  it("leaves a non-matching href alone", () => {
    const after = removeLink(FORMAT_MD_EXAMPLE, "part_of", "/areas/arcs/other.html")
    expect(parseOk(after).links).toHaveLength(2)
  })

  it("supports the integrity phase's repoint — remove then add", () => {
    const moved = addLink(
      removeLink(FORMAT_MD_EXAMPLE, "part_of", "/areas/arcs/reversibility-first.html"),
      "part_of",
      "/archive/2026/areas/arcs/reversibility-first.html"
    )
    expect(parseOk(moved).links).toEqual([
      { rel: "supersedes", href: "/archive/2026/areas/oncall/rollback-order.html" },
      { rel: "part_of", href: "/archive/2026/areas/arcs/reversibility-first.html" }
    ])
    expect(contentHash(moved)).toBe(contentHash(FORMAT_MD_EXAMPLE))
  })
})

describe("readMeta", () => {
  it("reads a value without a full parse", () => {
    expect(readMeta(FORMAT_MD_EXAMPLE, "memhtml-type")).toBe("procedural")
    expect(readMeta(FORMAT_MD_EXAMPLE, "memhtml-confidence")).toBe("0.90")
  })

  it("returns undefined for an absent name", () => {
    expect(readMeta(FORMAT_MD_EXAMPLE, "memhtml-reprieves")).toBeUndefined()
  })

  it("round-trips with setMeta", () => {
    expect(
      readMeta(setMeta(FORMAT_MD_EXAMPLE, "memhtml-reprieves", "3"), "memhtml-reprieves")
    ).toBe("3")
  })
})

describe("a whole sleep bookkeeping pass", () => {
  it("decays, stamps, and reprieves without moving the dedup key", () => {
    let html = FORMAT_MD_EXAMPLE
    html = setMeta(html, "memhtml-confidence", "0.81")
    html = setMeta(html, "memhtml-updated", "2026-09-01T02:00:00Z")
    html = setMeta(html, "memhtml-reprieves", "1")
    html = addMeta(html, "memhtml-tag", "reviewed")
    html = addLink(html, "relates_to", "/areas/oncall/drain.html")

    expect(contentHash(html)).toBe(contentHash(FORMAT_MD_EXAMPLE))
    expect(articleRegion(html)).toBe(articleRegion(FORMAT_MD_EXAMPLE))

    const doc = parseOk(html)
    expect(doc.metas.confidence).toBe(0.81)
    expect(doc.metas.reprieves).toBe(1)
    expect(doc.tags).toEqual(["deploy", "reviewed"])
    expect(doc.links).toHaveLength(3)
  })
})

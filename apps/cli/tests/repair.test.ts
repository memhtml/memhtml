import { addLink, contentHash, setMeta } from "@memhtml/html"
import { describe, expect, it } from "vitest"

import { applyHeadEdits, archivedFormOf, hrefFor, link, meta, unlink } from "../src/repair.js"

/**
 * A valid memory file as bytes, hand-written rather than produced by `@memhtml/html`'s template: these
 * are the INPUT the head editors operate on, and generating them with the same package that edits them
 * would let a template-and-editor pair agree on something the format does not say.
 */
const memoryHtml = (fixture: {
  readonly title: string
  readonly claim: string
  readonly body?: string | undefined
  readonly confidence?: string | undefined
  readonly entities?: ReadonlyArray<string> | undefined
}): string => {
  const at = "2026-06-01T00:00:00Z"
  const metas = [
    `<meta name="memhtml-type" content="semantic">`,
    `<meta name="memhtml-status" content="active">`,
    `<meta name="memhtml-created" content="${at}">`,
    `<meta name="memhtml-updated" content="${at}">`,
    ...(fixture.confidence === undefined
      ? []
      : [`<meta name="memhtml-confidence" content="${fixture.confidence}">`]),
    ...(fixture.entities ?? []).map((entity) => `<meta name="memhtml-entity" content="${entity}">`)
  ]
  const body = fixture.body === undefined ? "" : ` ${fixture.body}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${fixture.title}</title>
${metas.join("\n")}
</head>
<body>
<article>
<p><mark>${fixture.claim}</mark>${body}</p>
</article>
</body>
</html>
`
}

describe("head edits", () => {
  const html = memoryHtml({
    title: "A fact",
    claim: "The claim.",
    body: "Some prose.",
    confidence: "0.90",
    entities: ["service:checkout-api", "service:checkout_api"]
  })

  it("leaves the article hash invariant under every kind of head edit", () => {
    const before = contentHash(html)
    const edited = applyHeadEdits(html, [
      meta("memhtml-confidence", "0.810"),
      meta("memhtml-updated", "2026-08-02T00:00:00Z"),
      meta("memhtml-reprieves", "1"),
      link("supersedes", "/archive/2026/areas/x.html"),
      link("contradicts", "/areas/y.html")
    ])
    expect(edited).not.toBe(html)
    expect(contentHash(edited)).toBe(before)
  })

  it("is idempotent: re-applying the same edits changes nothing", () => {
    const edits = [
      meta("memhtml-confidence", "0.810"),
      link("supersedes", "/archive/2026/areas/x.html")
    ]
    const once = applyHeadEdits(html, edits)
    expect(applyHeadEdits(once, edits)).toBe(once)
  })

  it("removes a link by exact href and leaves the others", () => {
    const linked = applyHeadEdits(html, [
      link("supersedes", "/areas/a.html"),
      link("supersedes", "/areas/b.html")
    ])
    const pruned = applyHeadEdits(linked, [unlink("supersedes", "/areas/a.html")])
    expect(pruned).not.toContain('href="/areas/a.html"')
    expect(pruned).toContain('href="/areas/b.html"')
  })

  it("agrees with @memhtml/html's own editors, since it is only a fold over them", () => {
    expect(applyHeadEdits(html, [meta("memhtml-confidence", "0.5")])).toBe(
      setMeta(html, "memhtml-confidence", "0.5")
    )
    expect(applyHeadEdits(html, [link("supersedes", "/areas/a.html")])).toBe(
      addLink(html, "supersedes", "/areas/a.html")
    )
  })

  it("renders the document-reference form of a tree path", () => {
    expect(hrefFor("areas/x.html")).toBe("/areas/x.html")
    expect(hrefFor("/areas/x.html")).toBe("/areas/x.html")
  })
})

describe("the archive lookup", () => {
  it("finds a target archived in a previous year, newest first", () => {
    const known = new Set(["archive/2024/areas/x.html", "archive/2026/areas/x.html"])
    // The most recent archiving wins: an earlier one was superseded by a later restore.
    expect(archivedFormOf("areas/x.html", known, 2026)).toBe("archive/2026/areas/x.html")
    expect(archivedFormOf("areas/x.html", new Set(["archive/2024/areas/x.html"]), 2026)).toBe(
      "archive/2024/areas/x.html"
    )
  })

  it("returns undefined for a target that is genuinely gone", () => {
    expect(archivedFormOf("areas/x.html", new Set(), 2026)).toBeUndefined()
  })
})

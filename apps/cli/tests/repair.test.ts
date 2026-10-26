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

  it("prefers a year's newest generation, in this year or an earlier one", () => {
    // The string order of these paths is the wrong order: `.` sorts before `/`, and `2031.10`
    // before `2031.9`.
    const run = Array.from({ length: 10 }, (_, index) =>
      index === 0 ? "archive/2031/areas/x.html" : `archive/2031.${String(index + 1)}/areas/x.html`
    )
    expect(archivedFormOf("areas/x.html", new Set(run), 2031)).toBe("archive/2031.10/areas/x.html")
    expect(
      archivedFormOf(
        "areas/x.html",
        new Set(["archive/2030/areas/x.html", "archive/2030.2/areas/x.html"]),
        2031
      )
    ).toBe("archive/2030.2/areas/x.html")
  })

  it("takes a year's highest generation even when a lower slot is missing from the index", () => {
    // The bare slot can hold a file the index skipped because it fails to parse, so the index
    // lists only the later copy. A walk from the bare year that stopped at the first gap would
    // call the target gone and have doctor --fix drop the link.
    expect(archivedFormOf("areas/x.html", new Set(["archive/2031.2/areas/x.html"]), 2031)).toBe(
      "archive/2031.2/areas/x.html"
    )
    expect(
      archivedFormOf(
        "areas/x.html",
        new Set(["archive/2031.2/areas/x.html", "archive/2031.4/areas/x.html"]),
        2031
      )
    ).toBe("archive/2031.4/areas/x.html")
    // Outside the lookback window, and in a year after the run's, nothing is taken.
    expect(
      archivedFormOf("areas/x.html", new Set(["archive/2032.2/areas/x.html"]), 2031)
    ).toBeUndefined()
    expect(
      archivedFormOf("areas/x.html", new Set(["archive/2020.2/areas/x.html"]), 2031)
    ).toBeUndefined()
  })

  it("returns undefined for a target that is genuinely gone", () => {
    expect(archivedFormOf("areas/x.html", new Set(), 2026)).toBeUndefined()
  })
})

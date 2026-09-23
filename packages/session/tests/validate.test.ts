import type { OverlayOp } from "@memhtml/contracts"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"

import { BATCH_CAP, isReservedPath, touchedPaths, validateOps } from "../src/validate.js"
import { mapHead, memory, recordFrom } from "./helpers.js"

/**
 * The mechanical checks, over a `Map`-backed head. Pure, so no repo.
 *
 * Mutation notes, one per guard, each run once with the change applied and the named test red:
 * - batch-cap: `ops.length > BATCH_CAP` -> `ops.length > Infinity` -> "refuses more than 200 ops".
 * - reserved-path: `isReservedPath` returns false -> "refuses every reserved surface".
 * - scope: the `scope !== "curate"` guard on the curation prefixes removed -> "the curate scope
 *   opens areas/arcs/ and resources/people/ and nothing else" (the curator is refused its own paths);
 *   `.memhtml/` moved under that guard -> the same case (`.memhtml/` lands under curate).
 * - duplicate: drop the `existing !== undefined` branch -> "names the existing path of a duplicate".
 * - claim-edit: drop the `isActiveIn` branch -> "refuses a put over an active path with a new claim".
 * - format: skip `checkMemory` -> "collects format violations".
 * - archive hash: drop the `contentHash(op.html) !== sourceHash` reason -> "refuses an archive op
 *   whose article is not the source's".
 */

const CAPITAL = memory("Capital", "The capital of India is New Delhi.")
const ALPHA = memory("Alpha", "Alpha is the first letter of the Greek alphabet.")

const head = async () =>
  mapHead("0".repeat(40), [
    await recordFrom("areas/inbox/capital.html", CAPITAL),
    await recordFrom("areas/inbox/alpha.html", ALPHA),
    await recordFrom("archive/2025/areas/inbox/old.html", memory("Old", "An old fact."))
  ])

const put = (path: string, html: string): OverlayOp => ({ kind: "put", path, html })

describe("validateOps", () => {
  it("accepts a fresh put and a link to it in one batch", async () => {
    const ops: ReadonlyArray<OverlayOp> = [
      put("areas/inbox/beta.html", memory("Beta", "Beta is the second letter.")),
      {
        kind: "link",
        path: "areas/inbox/beta.html",
        rel: "relates_to",
        href: "/areas/inbox/alpha.html"
      }
    ]
    expect(validateOps(await head(), ops)).toEqual([])
  })

  it("refuses more than 200 ops with one batch-cap violation", async () => {
    const view = await head()
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: BATCH_CAP + 1, max: BATCH_CAP + 50 }), async (count) => {
        const ops = Array.from({ length: count }, (_, index) =>
          put(`areas/inbox/n${index}.html`, memory(`N${index}`, `Fact number ${index}.`))
        )
        expect(validateOps(view, ops)).toEqual([{ kind: "batch-cap", count, cap: BATCH_CAP }])
      }),
      { numRuns: 5 }
    )
    expect(validateOps(view, [put("areas/inbox/one.html", memory("One", "One fact."))])).toEqual([])
  })

  it("refuses every reserved surface", async () => {
    const view = await head()
    const reserved = [
      "areas/arcs/reversibility.html",
      "resources/people/laith.html",
      ".memhtml/sessions/x.html",
      "areas/inbox/index.html",
      "projects/x/sitemap.xml"
    ]
    for (const path of reserved) {
      expect(isReservedPath(path)).toBe(true)
      expect(validateOps(view, [put(path, memory("R", "Reserved."))])).toContainEqual({
        kind: "reserved-path",
        path
      })
    }
    expect(isReservedPath("areas/inbox/arcs-note.html")).toBe(false)
  })

  it("the curate scope opens areas/arcs/ and resources/people/ and nothing else", async () => {
    const view = await head()
    const curation = ["areas/arcs/reversibility.html", "resources/people/laith.html"]
    const everyone = [".memhtml/sessions/x.html", "areas/index.html", "projects/x/sitemap.xml"]
    for (const path of curation) {
      // The default scope is `session`, stated or not.
      expect(isReservedPath(path)).toBe(true)
      expect(isReservedPath(path, "session")).toBe(true)
      expect(validateOps(view, [put(path, memory("R", `Reserved at ${path}.`))])).toEqual([
        { kind: "reserved-path", path }
      ])
      expect(validateOps(view, [put(path, memory("R", `Reserved at ${path}.`))], {})).toEqual([
        { kind: "reserved-path", path }
      ])
      // Under `curate` the same put is clean.
      expect(isReservedPath(path, "curate")).toBe(false)
      expect(
        validateOps(view, [put(path, memory("R", `Reserved at ${path}.`))], { scope: "curate" })
      ).toEqual([])
    }
    for (const path of everyone) {
      for (const scope of ["session", "curate"] as const) {
        expect(isReservedPath(path, scope), `${path} under ${scope}`).toBe(true)
        expect(
          validateOps(view, [put(path, memory("R", "Reserved."))], { scope }),
          `${path} under ${scope}`
        ).toContainEqual({ kind: "reserved-path", path })
      }
    }
    // A link op on a people record is judged under the same scope as a put.
    const link = {
      kind: "link" as const,
      path: "resources/people/laith.html",
      rel: "relates_to",
      href: "/areas/inbox/alpha.html"
    }
    expect(validateOps(view, [put(link.path, memory("L", "Laith.")), link])).toEqual([
      { kind: "reserved-path", path: link.path },
      { kind: "reserved-path", path: link.path }
    ])
    expect(
      validateOps(view, [put(link.path, memory("L", "Laith.")), link], { scope: "curate" })
    ).toEqual([])
  })

  it("names the existing path of a duplicate, in the head or earlier in the batch", async () => {
    const view = await head()
    expect(validateOps(view, [put("areas/inbox/capital-2.html", CAPITAL)])).toEqual([
      {
        kind: "duplicate",
        path: "areas/inbox/capital-2.html",
        existing: "areas/inbox/capital.html"
      }
    ])
    const twice = memory("Gamma", "Gamma is the third letter.")
    expect(
      validateOps(view, [put("areas/inbox/g1.html", twice), put("areas/inbox/g2.html", twice)])
    ).toEqual([{ kind: "duplicate", path: "areas/inbox/g2.html", existing: "areas/inbox/g1.html" }])
  })

  it("refuses a put over an active path with a new claim, and allows one over an archived path", async () => {
    const view = await head()
    const edited = memory("Capital", "The capital of India is Mumbai.")
    expect(validateOps(view, [put("areas/inbox/capital.html", edited)])).toEqual([
      { kind: "claim-edit", path: "areas/inbox/capital.html" }
    ])
    // Identical content over the same path is a duplicate of itself, not an edit.
    expect(validateOps(view, [put("areas/inbox/capital.html", CAPITAL)])).toEqual([
      { kind: "duplicate", path: "areas/inbox/capital.html", existing: "areas/inbox/capital.html" }
    ])
  })

  it("collects format violations for a bad path and a bad file", async () => {
    const view = await head()
    const [violation] = validateOps(view, [put("notes/x.html", "<html><body>nope</body></html>")])
    expect(violation?.kind).toBe("format")
    if (violation?.kind === "format") {
      expect(violation.reasons.some((reason) => reason.startsWith("path:"))).toBe(true)
      expect(violation.reasons.length).toBeGreaterThan(1)
    }
  })

  it("checks an archive op's source, destination shape, and a link op's source and rel", async () => {
    const view = await head()
    const archive: OverlayOp = {
      kind: "archive",
      path: "areas/inbox/capital.html",
      to: "archive/2026/areas/inbox/capital.html",
      html: CAPITAL
    }
    expect(validateOps(view, [archive])).toEqual([])
    expect(validateOps(view, [{ ...archive, to: "archive/2026/areas/inbox/other.html" }])).toEqual([
      {
        kind: "format",
        path: "areas/inbox/capital.html",
        reasons: ["archive destination is not archive/<YYYY>/<original path>"]
      }
    ])
    expect(
      validateOps(view, [
        {
          ...archive,
          path: "areas/inbox/missing.html",
          to: "archive/2026/areas/inbox/missing.html"
        }
      ])
    ).toEqual([
      {
        kind: "format",
        path: "areas/inbox/missing.html",
        reasons: ["archive source is not an active record in the head"]
      }
    ])
    expect(
      validateOps(view, [{ kind: "link", path: "areas/inbox/alpha.html", rel: "bogus", href: "x" }])
    ).toEqual([
      {
        kind: "format",
        path: "areas/inbox/alpha.html",
        reasons: ["rel `bogus` is outside the edge vocabulary", "href is not root-relative"]
      }
    ])
  })

  it("refuses an archive op whose article is not the source's, and takes one whose head differs", async () => {
    const view = await head()
    const to = "archive/2026/areas/inbox/alpha.html"
    // A different article at the source's path: the op names an article the head does not hold.
    const wrong = validateOps(view, [
      { kind: "archive", path: "areas/inbox/alpha.html", to, html: CAPITAL }
    ])
    expect(wrong).toEqual([
      {
        kind: "format",
        path: "areas/inbox/alpha.html",
        reasons: ["archive op's article differs from the source record's"]
      }
    ])
    // The same article under a head that gained a link: the hash is the article's, so it passes.
    const linked = ALPHA.replace(
      "</head>",
      '<link rel="memhtml-supports" href="/areas/inbox/capital.html"></head>'
    )
    expect(
      validateOps(view, [{ kind: "archive", path: "areas/inbox/alpha.html", to, html: linked }])
    ).toEqual([])
    // An archive of a put earlier in the batch is judged against that put's article.
    const fresh = memory("Fresh", "A fresh fact to archive at once.")
    expect(
      validateOps(view, [
        put("areas/inbox/fresh.html", fresh),
        {
          kind: "archive",
          path: "areas/inbox/fresh.html",
          to: "archive/2026/areas/inbox/fresh.html",
          html: fresh
        }
      ])
    ).toEqual([])
    expect(
      validateOps(view, [
        put("areas/inbox/fresh.html", fresh),
        {
          kind: "archive",
          path: "areas/inbox/fresh.html",
          to: "archive/2026/areas/inbox/fresh.html",
          html: CAPITAL
        }
      ])
    ).toEqual([
      {
        kind: "format",
        path: "areas/inbox/fresh.html",
        reasons: ["archive op's article differs from the source record's"]
      }
    ])
  })

  it("touchedPaths names every path an op reads or writes", () => {
    expect(touchedPaths(put("a.html", ""))).toEqual(["a.html"])
    expect(
      touchedPaths({ kind: "archive", path: "a.html", to: "archive/2026/a.html", html: "" })
    ).toEqual(["a.html", "archive/2026/a.html"])
    expect(
      touchedPaths({ kind: "link", path: "a.html", rel: "relates_to", href: "/b.html" })
    ).toEqual(["a.html"])
  })
})

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
 * - duplicate: drop the `existing !== undefined` branch -> "names the existing path of a duplicate".
 * - claim-edit: drop the `isActiveIn` branch -> "refuses a put over an active path with a new claim".
 * - format: skip `checkMemory` -> "collects format violations".
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

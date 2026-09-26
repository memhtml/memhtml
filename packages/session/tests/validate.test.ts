import type { OverlayOp } from "@memhtml/contracts"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  BATCH_CAP,
  isReservedPath,
  touchedPaths,
  validateOps,
  writeBarReasons
} from "../src/validate.js"
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
 * - link target: drop the `view.get(target) === undefined` check -> "a link must point at a record
 *   in the head or in the batch" (the missing target passes).
 * - unlink edge: drop the `!edgesOf(op.path).has(...)` reason -> "an unlink must name an edge the
 *   source carries as the batch sees it" (the absent edge and the second drop both pass).
 * - unlink source: drop the `isActiveIn` clause -> the same case (the archived source passes).
 * - unlink batch view: `edgesOf(op.path).add(...)` after a link removed -> the same case (an unlink
 *   of an edge this batch added is refused).
 * - write bar, type: `REFUSED_TYPES.get(type)` -> `undefined` -> "the write bar refuses a run
 *   narrative and review output from a session" (both types pass).
 * - write bar, anchor: `anchored` forced to `true` -> "the write bar refuses a record that names
 *   nothing, and takes an entity or a workspace as its anchor" (the bare record passes).
 * - write bar, scope: the `scope === "session"` guard removed -> "the curate scope and tasks are
 *   exempt from the write bar" (the curator's unanchored canonical is refused).
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

  it("a link must point at a record in the head or in the batch", async () => {
    const view = await head()
    const link = (href: string): OverlayOp => ({
      kind: "link",
      path: "areas/inbox/alpha.html",
      rel: "supports",
      href
    })
    // Active and archived targets in the head both count: a `supersedes` edge points at an archive
    // by design, and the repair of a dangling link points at the archived form.
    expect(validateOps(view, [link("/areas/inbox/capital.html")])).toEqual([])
    expect(validateOps(view, [link("/archive/2025/areas/inbox/old.html")])).toEqual([])
    expect(validateOps(view, [link("/areas/inbox/nowhere.html")])).toEqual([
      {
        kind: "format",
        path: "areas/inbox/alpha.html",
        reasons: ["link target is not a record in the head or this batch"]
      }
    ])
    // A target this batch creates counts too: a put, and an archive's destination, in either order.
    // The harvester emits links before archives, so the archive a `supersedes` edge names comes
    // after the edge; the first cut of this check walked in order and refused every such harvest.
    expect(
      validateOps(view, [
        put("areas/inbox/fresh.html", memory("Fresh", "A fresh fact.")),
        link("/areas/inbox/fresh.html")
      ])
    ).toEqual([])
    const supersedes: OverlayOp = {
      kind: "link",
      path: "areas/inbox/alpha.html",
      rel: "supersedes",
      href: "/archive/2026/areas/inbox/capital.html"
    }
    const archive: OverlayOp = {
      kind: "archive",
      path: "areas/inbox/capital.html",
      to: "archive/2026/areas/inbox/capital.html",
      html: CAPITAL
    }
    expect(validateOps(view, [archive, supersedes])).toEqual([])
    expect(validateOps(view, [supersedes, archive])).toEqual([])
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

  it("an unlink must name an edge the source carries as the batch sees it", async () => {
    const view = await head()
    const unlink = (path: string, href: string, rel = "supports"): OverlayOp => ({
      kind: "unlink",
      path,
      rel,
      href
    })
    const carried = "/areas/inbox/capital.html"
    // ALPHA carries no edge, so an unlink on it is refused as such, alone.
    expect(validateOps(view, [unlink("areas/inbox/alpha.html", carried)])).toEqual([
      {
        kind: "format",
        path: "areas/inbox/alpha.html",
        reasons: ["unlink names an edge the source does not carry"]
      }
    ])
    // An edge the head holds can be dropped once, not twice.
    const linkedView = mapHead("0".repeat(40), [
      await recordFrom(
        "areas/inbox/alpha.html",
        ALPHA.replace("</head>", `<link rel="memhtml-supports" href="${carried}"></head>`)
      ),
      await recordFrom("areas/inbox/capital.html", CAPITAL)
    ])
    expect(validateOps(linkedView, [unlink("areas/inbox/alpha.html", carried)])).toEqual([])
    expect(
      validateOps(linkedView, [
        unlink("areas/inbox/alpha.html", carried),
        unlink("areas/inbox/alpha.html", carried)
      ])
    ).toEqual([
      {
        kind: "format",
        path: "areas/inbox/alpha.html",
        reasons: ["unlink names an edge the source does not carry"]
      }
    ])
    // An edge this batch adds can be dropped by the same batch; a put's own edges count too.
    expect(
      validateOps(view, [
        { kind: "link", path: "areas/inbox/alpha.html", rel: "supports", href: carried },
        unlink("areas/inbox/alpha.html", carried)
      ])
    ).toEqual([])
    const linkedPut = memory("Beta", "Beta is the second letter.").replace(
      "</head>",
      `<link rel="memhtml-supports" href="${carried}"></head>`
    )
    expect(
      validateOps(view, [
        put("areas/inbox/beta.html", linkedPut),
        unlink("areas/inbox/beta.html", carried)
      ])
    ).toEqual([])
    // The source must be active, and the rel in the vocabulary.
    expect(validateOps(linkedView, [unlink("archive/2025/areas/inbox/old.html", carried)])).toEqual(
      [
        {
          kind: "format",
          path: "archive/2025/areas/inbox/old.html",
          reasons: ["unlink source is not an active record in the head"]
        }
      ]
    )
    expect(validateOps(linkedView, [unlink("areas/inbox/alpha.html", carried, "bogus")])).toEqual([
      {
        kind: "format",
        path: "areas/inbox/alpha.html",
        reasons: ["rel `bogus` is outside the edge vocabulary"]
      }
    ])
    // Reserved paths are refused under the same rule as every other op.
    expect(validateOps(linkedView, [unlink(".memhtml/x.html", carried)])).toContainEqual({
      kind: "reserved-path",
      path: ".memhtml/x.html"
    })
  })

  it("the write bar refuses a run narrative and review output from a session", async () => {
    const view = await head()
    const narrative = memory("Run 42", "Run 42 read three files and wrote a report.", {
      memoryType: "episodic"
    })
    const verdict = memory("Review of run 42", "Run 42 was marked unsupported_claim.", {
      memoryType: "verdict"
    })
    const found = validateOps(view, [
      put("areas/inbox/run-42.html", narrative),
      put("areas/inbox/review-42.html", verdict)
    ])
    expect(
      found.map((violation) => [violation.kind, "path" in violation && violation.path])
    ).toEqual([
      ["write-bar", "areas/inbox/run-42.html"],
      ["write-bar", "areas/inbox/review-42.html"]
    ])
    expect(writeBarReasons("areas/inbox/run-42.html", narrative)).toEqual([
      "an episodic record narrates one run; runs belong in the trace index, not the store"
    ])
    expect(writeBarReasons("areas/inbox/review-42.html", verdict)).toEqual([
      "a verdict is review output, not a memory"
    ])
  })

  it("the write bar refuses a record that names nothing, and takes an entity or a workspace as its anchor", async () => {
    const view = await head()
    const bare = memory("Run the formatter", "Run the formatter before committing.", {
      entities: []
    })
    expect(validateOps(view, [put("areas/inbox/formatter.html", bare)])).toEqual([
      {
        kind: "write-bar",
        path: "areas/inbox/formatter.html",
        reasons: [
          "names no system, project, or person: add a memhtml-entity or write it in a workspace (projects/<slug>/)"
        ]
      }
    ])
    const named = memory("Run the formatter", "memhtml runs Biome before every commit.", {
      entities: ["system:memhtml"]
    })
    expect(validateOps(view, [put("areas/inbox/formatter.html", named)])).toEqual([])
    expect(validateOps(view, [put("projects/memhtml/formatter.html", bare)])).toEqual([])
  })

  it("the curate scope and tasks are exempt from the write bar", async () => {
    const view = await head()
    const canonical = memory("Canonical", "One canonical record the curator folded.", {
      entities: []
    })
    expect(
      validateOps(view, [put("areas/inbox/canonical.html", canonical)], { scope: "curate" })
    ).toEqual([])
    const task = memory("Rotate the key", "Rotate the signing key.", {
      entities: [],
      memoryType: "task"
    })
    expect(writeBarReasons("areas/inbox/tasks/rotate.html", task)).toEqual([])
    expect(writeBarReasons("archive/2026/areas/inbox/formatter.html", canonical)).toEqual([])
  })

  it("touchedPaths names every path an op reads or writes", () => {
    expect(touchedPaths(put("a.html", ""))).toEqual(["a.html"])
    expect(
      touchedPaths({ kind: "archive", path: "a.html", to: "archive/2026/a.html", html: "" })
    ).toEqual(["a.html", "archive/2026/a.html"])
    expect(
      touchedPaths({ kind: "link", path: "a.html", rel: "relates_to", href: "/b.html" })
    ).toEqual(["a.html"])
    expect(
      touchedPaths({ kind: "unlink", path: "a.html", rel: "relates_to", href: "/b.html" })
    ).toEqual(["a.html"])
  })
})

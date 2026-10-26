import { archivePathFor, type OverlayOp } from "@memhtml/contracts"
import { addLink } from "@memhtml/html"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  BATCH_CAP,
  isReservedPath,
  touchedPaths,
  UNANCHORED_REASON,
  validateOps,
  writeBarReasons
} from "../src/validate.js"
import { mapHead, memory, recordFrom, STRICT_BAR } from "./helpers.js"

/**
 * The mechanical checks, over a `Map`-backed head. Pure, so no repo.
 *
 * Mutation notes, one per guard, each run once with the change applied and the named test red:
 * - batch-cap: `ops.length > BATCH_CAP` -> `ops.length > Infinity` -> "refuses more than 200 ops".
 * - batch-cap option: `options.batchCap ?? BATCH_CAP` -> `BATCH_CAP` -> "takes its cap from batchCap".
 * - reserved-path: `isReservedPath` returns false -> "refuses every reserved surface".
 * - scope: the `scope !== "curate"` guard on the curation prefixes removed -> "the curate scope
 *   opens areas/arcs/ and resources/people/ and nothing else" (the curator is refused its own paths);
 *   `.memhtml/` moved under that guard -> the same case (`.memhtml/` lands under curate).
 * - duplicate: drop the `existing !== undefined` branch -> "names the existing path of a duplicate".
 * - claim-edit: drop the `isActiveIn` branch -> "refuses a put over an active path with a new claim".
 * - format: skip `checkMemory` -> "collects format violations".
 * - archive hash: drop the `contentHash(op.html) !== sourceHash` reason -> "refuses an archive op
 *   whose article is not the source's".
 * - archive slot twice: drop the `archiveDestinations.has(...)` reason -> "archives over an earlier
 *   archived copy of its own path, and writes one slot once per batch" (the doubled archive passes).
 * - link target: drop the `view.get(target) === undefined` check -> "a link must point at a record
 *   in the head or in the batch" (the missing target passes).
 * - unlink edge: drop the `!edgesOf(op.path).has(...)` reason -> "an unlink must name an edge the
 *   source carries as the batch sees it" (the absent edge and the second drop both pass).
 * - unlink source: drop the `isActiveIn` clause -> the same case (the archived source passes).
 * - unlink batch view: `edgesOf(op.path).add(...)` after a link removed -> the same case (an unlink
 *   of an edge this batch added is refused).
 * - write bar, type: `policy.refusedTypes.get(type)` -> `undefined` -> "the write bar refuses a run
 *   narrative and review output from a session" (both types pass).
 * - write bar, anchor: `isAnchored(...)` forced to `true` in `writeBarReasons` -> "the write bar
 *   refuses a record that names nothing, and takes an entity or a workspace as its anchor" (the bare
 *   record passes).
 * - write bar, policy (2026-10-18): `options.writeBar ?? DEFAULT_WRITE_BAR` -> `STRICT`-shaped
 *   constant -> "the library default bar refuses no type and anchors nothing" (the bare episodic
 *   put is refused); `policy.requireAnchor &&` dropped from `writeBarReasons` -> the same case and
 *   "a store's bar refuses only what it names" (the bare record is refused with the anchor off);
 *   `bar.requireAnchor &&` dropped from the closing unlabel loop -> "the library default bar ..."
 *   (the last label comes off with a violation).
 * - write bar, every scope (2026-09-26): the `scope === "session"` guard put back around the
 *   `writeBarReasons` call -> "the curate scope is held to the write bar: an unlabeled canonical
 *   and an episodic put are refused" (the curator's puts pass with no violation).
 * - write bar, tasks (2026-09-26): `if (doc.metas.memoryType === "task") return []` put back at
 *   the top of `writeBarReasons` -> "a task must be anchored: its workspace path anchors it, an
 *   inbox task needs an entity" (the unlabeled inbox task passes).
 * - write bar, archive destinations: the `isArchivePath(path)` early return removed -> "an archive
 *   destination is never judged by the write bar, under either scope" (the unlabeled record at its
 *   archive path is refused).
 * - label value: the `isWellFormedEntity` reason dropped -> "a label must name a well-formed entity
 *   the source does not carry yet, as the batch sees it" (the malformed value passes).
 * - label carried: the `entitiesOf(op.path).has(op.entity)` reason dropped -> the same case (the
 *   carried value passes).
 * - label source: the `isActiveIn` clause dropped -> the same case (the archived source passes).
 * - label batch view: `entitiesOf(op.path).add(...)` removed -> the same case (the second label of
 *   one value passes).
 * - label over a put: `batchEntities.set(...)` removed from the put case -> the same case (a label
 *   of a value the batch's own put carries passes).
 * - unlabel carried: the `!entitiesOf(op.path).has(op.entity)` reason dropped -> "an unlabel must
 *   name an entity the source carries as the batch sees it" (the absent value passes).
 * - unlabel source: the `isActiveIn` clause dropped -> the same case (the archived source passes).
 * - unlabel batch view: `entitiesOf(op.path).delete(...)` removed -> the same case (the second drop
 *   of one value passes).
 * - unlabel anchor: `isAnchored(...)` in the closing loop forced to `true` -> "an unlabel that
 *   leaves a record with no entity and no workspace path fails the write bar" (the last label
 *   comes off with no violation).
 * - unlabel anchor, archives: the `archived.has(...)` exemption removed -> the same case (an
 *   unlabel followed by an archive of its record is refused).
 * - archive inbound (2026-10-26): the closing `danglingAt(archive, "archived")` loop dropped -> "an
 *   archive that leaves a live edge to its path behind is refused, naming the holder" (the bare
 *   archive passes).
 * - archive scope (2026-10-26): the `verb === "archived" && isReservedPath(...)` skip dropped -> "an
 *   archive leaves the edge of a holder its scope may not write, and a move does not" (the
 *   session-scope archive is refused on the arc).
 * - archive of a batch put (2026-10-26): the `verb === "moved"` guard dropped from the put and
 *   move-in exemption -> "an archive of a record the batch put is held to the edges the batch aimed
 *   at it" (the dangling link passes).
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

  it("takes its cap from batchCap when one is given, so a replay can lift it", async () => {
    const view = await head()
    const ops = Array.from({ length: BATCH_CAP + 1 }, (_, index) =>
      put(`areas/inbox/m${index}.html`, memory(`M${index}`, `Fact number ${index}.`))
    )
    const lifted = validateOps(view, ops, { batchCap: Number.POSITIVE_INFINITY })
    expect(lifted.filter((violation) => violation.kind === "batch-cap")).toEqual([])
    expect(validateOps(view, ops.slice(0, 4), { batchCap: 3 })).toEqual([
      { kind: "batch-cap", count: 4, cap: 3 }
    ])
  })

  it("refuses every reserved surface", async () => {
    const view = await head()
    const reserved = [
      "areas/arcs/reversibility.html",
      "resources/people/laura.html",
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
    const curation = ["areas/arcs/reversibility.html", "resources/people/laura.html"]
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
      path: "resources/people/laura.html",
      rel: "relates_to",
      href: "/areas/inbox/alpha.html"
    }
    expect(validateOps(view, [put(link.path, memory("L", "Laura.")), link])).toEqual([
      { kind: "reserved-path", path: link.path },
      { kind: "reserved-path", path: link.path }
    ])
    expect(
      validateOps(view, [put(link.path, memory("L", "Laura.")), link], { scope: "curate" })
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

  it("archives over an earlier archived copy of its own path, and writes one slot once per batch", async () => {
    // A record archived once, recreated at its path, and archived again (the 64 people stubs on
    // the live store, 2026-09-28): the destination holds the earlier copy, which the new one replaces.
    const view = await mapHead("0".repeat(40), [
      await recordFrom("areas/inbox/capital.html", CAPITAL),
      await recordFrom(
        "archive/2026/areas/inbox/capital.html",
        memory("Capital", "The capital of india is new delhi.")
      )
    ])
    const archive: OverlayOp = {
      kind: "archive",
      path: "areas/inbox/capital.html",
      to: "archive/2026/areas/inbox/capital.html",
      html: CAPITAL
    }
    expect(validateOps(view, [archive])).toEqual([])
    expect(validateOps(view, [archive, archive])).toEqual([
      {
        kind: "format",
        path: "areas/inbox/capital.html",
        reasons: ["archive destination is written twice in this batch"]
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

  it("an archive that leaves a live edge to its path behind is refused, naming the holder", async () => {
    const retired = "resources/acme-widget/b.html"
    const successor = "resources/acme-widget/a.html"
    const slot = archivePathFor(retired, 2031)
    const retiredHtml = memory("Widget batch size", "The acme widget ships in batches of twelve.")
    const view = mapHead("0".repeat(40), [
      await recordFrom(retired, retiredHtml),
      await recordFrom(
        successor,
        addLink(
          memory("Widget batch size, revised", "The acme widget ships in batches of twenty."),
          "supersedes",
          `/${retired}`
        )
      ),
      await recordFrom(
        archivePathFor("resources/acme-widget/c.html", 2030),
        addLink(memory("Old widget note", "An older widget fact."), "relates_to", `/${retired}`)
      )
    ])
    const archive: OverlayOp = { kind: "archive", path: retired, to: slot, html: retiredHtml }
    const dangling = (holder: string, rel: string) => ({
      kind: "format",
      path: retired,
      reasons: [
        `archived to ${slot}, but ${holder} still carries ${rel} -> /${retired}: repoint it with an unlink of that edge and a link of the same rel to /${slot} in the same batch`
      ]
    })
    // The bare archive: the live successor's edge would dangle. The archived holder keeps its edge
    // as history and is never asked to move it.
    expect(validateOps(view, [archive])).toEqual([dangling(successor, "supersedes")])
    // The repoint may come before or after the archive in the order.
    const repoint: ReadonlyArray<OverlayOp> = [
      { kind: "unlink", path: successor, rel: "supersedes", href: `/${retired}` },
      { kind: "link", path: successor, rel: "supersedes", href: `/${slot}` }
    ]
    expect(validateOps(view, [...repoint, archive])).toEqual([])
    expect(validateOps(view, [archive, ...repoint])).toEqual([])
    // A holder the batch archives too keeps the edge in its archived copy.
    const both: OverlayOp = {
      kind: "archive",
      path: successor,
      to: archivePathFor(successor, 2031),
      html: view.get(successor)?.html ?? ""
    }
    expect(validateOps(view, [both, archive])).toEqual([])
    // An edge the batch's own put or link aims at the archived path dangles the same way.
    const fresh = "resources/acme-widget/e.html"
    const aimed = addLink(
      memory("Widget crate", "A widget crate holds four batches."),
      "relates_to",
      `/${retired}`
    )
    expect(validateOps(view, [...repoint, put(fresh, aimed), archive])).toEqual([
      dangling(fresh, "relates_to")
    ])
    expect(
      validateOps(view, [
        ...repoint,
        { kind: "link", path: successor, rel: "relates_to", href: `/${retired}` },
        archive
      ])
    ).toEqual([dangling(successor, "relates_to")])
  })

  it("an archive of a record the batch put is held to the edges the batch aimed at it", async () => {
    const holder = "resources/acme-widget/a.html"
    const fresh = "resources/acme-widget/f.html"
    const slot = archivePathFor(fresh, 2031)
    const freshHtml = memory("Widget pallet load", "A widget pallet carries six crates.")
    const view = mapHead("0".repeat(40), [
      await recordFrom(holder, memory("Widget pallet note", "Widget pallets are wrapped twice."))
    ])
    const archive: OverlayOp = { kind: "archive", path: fresh, to: slot, html: freshHtml }
    // The put is the record the archive moves, so the path ends empty and the edge to it dangles.
    expect(
      validateOps(view, [
        put(fresh, freshHtml),
        { kind: "link", path: holder, rel: "relates_to", href: `/${fresh}` },
        archive
      ])
    ).toEqual([
      {
        kind: "format",
        path: fresh,
        reasons: [
          `archived to ${slot}, but ${holder} still carries relates_to -> /${fresh}: repoint it with an unlink of that edge and a link of the same rel to /${slot} in the same batch`
        ]
      }
    ])
    // Linked to the slot instead, the batch passes.
    expect(
      validateOps(view, [
        put(fresh, freshHtml),
        { kind: "link", path: holder, rel: "relates_to", href: `/${slot}` },
        archive
      ])
    ).toEqual([])
  })

  it("an archive leaves the edge of a holder its scope may not write, and a move does not", async () => {
    const retired = "resources/acme-widget/b.html"
    const slot = archivePathFor(retired, 2031)
    const arc = "areas/arcs/acme-widget-arc.html"
    const retiredHtml = memory("Widget batch size", "The acme widget ships in batches of twelve.")
    const view = mapHead("0".repeat(40), [
      await recordFrom(retired, retiredHtml),
      await recordFrom(
        arc,
        addLink(
          memory("Widget arc", "Four widget facts show how batches grew."),
          "part_of",
          `/${retired}`
        )
      )
    ])
    const archive: OverlayOp = { kind: "archive", path: retired, to: slot, html: retiredHtml }
    // Under `session` no batch can edit the arc, so the archive leaves its edge to the curator.
    expect(validateOps(view, [archive])).toEqual([])
    // Under `curate` the arc is writable, and its edge is held like any other.
    expect(validateOps(view, [archive], { scope: "curate" })).toEqual([
      {
        kind: "format",
        path: retired,
        reasons: [
          `archived to ${slot}, but ${arc} still carries part_of -> /${retired}: repoint it with an unlink of that edge and a link of the same rel to /${slot} in the same batch`
        ]
      }
    ])
    // A move is placement, and is held to the arc under either scope.
    const moved = "resources/acme-gadget/b.html"
    expect(
      validateOps(view, [{ kind: "move", path: retired, to: moved, html: retiredHtml }])
    ).toEqual([
      {
        kind: "format",
        path: retired,
        reasons: [
          `moved to ${moved}, but ${arc} still carries part_of -> /${retired}: repoint it with an unlink of that edge and a link of the same rel to /${moved} in the same batch`
        ]
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
    const found = validateOps(
      view,
      [put("areas/inbox/run-42.html", narrative), put("areas/inbox/review-42.html", verdict)],
      { writeBar: STRICT_BAR }
    )
    expect(
      found.map((violation) => [violation.kind, "path" in violation && violation.path])
    ).toEqual([
      ["write-bar", "areas/inbox/run-42.html"],
      ["write-bar", "areas/inbox/review-42.html"]
    ])
    expect(writeBarReasons("areas/inbox/run-42.html", narrative, STRICT_BAR)).toEqual([
      "an episodic record narrates one run; runs belong in the trace index, not the store"
    ])
    expect(writeBarReasons("areas/inbox/review-42.html", verdict, STRICT_BAR)).toEqual([
      "a verdict is review output, not a memory"
    ])
  })

  it("the write bar refuses a record that names nothing, and takes an entity or a workspace as its anchor", async () => {
    const view = await head()
    const bare = memory("Run the formatter", "Run the formatter before committing.", {
      entities: []
    })
    expect(
      validateOps(view, [put("areas/inbox/formatter.html", bare)], { writeBar: STRICT_BAR })
    ).toEqual([
      {
        kind: "write-bar",
        path: "areas/inbox/formatter.html",
        reasons: [UNANCHORED_REASON]
      }
    ])
    // The reason says what to add, so a model reading a refused proposal can fix it.
    expect(UNANCHORED_REASON).toContain('<meta name="memhtml-entity"')
    expect(UNANCHORED_REASON).toContain("projects/<slug>/")
    const named = memory("Run the formatter", "memhtml runs Biome before every commit.", {
      entities: ["system:memhtml"]
    })
    expect(
      validateOps(view, [put("areas/inbox/formatter.html", named)], { writeBar: STRICT_BAR })
    ).toEqual([])
    expect(
      validateOps(view, [put("projects/memhtml/formatter.html", bare)], { writeBar: STRICT_BAR })
    ).toEqual([])
  })

  it("the curate scope is held to the write bar: an unlabeled canonical and an episodic put are refused", async () => {
    const view = await head()
    const canonical = memory("Canonical", "One canonical record the curator folded.", {
      entities: []
    })
    const narrative = memory("Run 43", "Run 43 folded three records into one.", {
      memoryType: "episodic"
    })
    expect(
      validateOps(
        view,
        [put("areas/inbox/canonical.html", canonical), put("areas/arcs/run-43.html", narrative)],
        { scope: "curate", writeBar: STRICT_BAR }
      )
    ).toEqual([
      { kind: "write-bar", path: "areas/inbox/canonical.html", reasons: [UNANCHORED_REASON] },
      {
        kind: "write-bar",
        path: "areas/arcs/run-43.html",
        reasons: [
          "an episodic record narrates one run; runs belong in the trace index, not the store"
        ]
      }
    ])
    // The same canonical with one entity clears the bar under the curator's scope.
    const labeled = memory("Canonical", "One canonical record the curator folded.", {
      entities: ["system:memhtml"]
    })
    expect(
      validateOps(view, [put("areas/inbox/canonical.html", labeled)], {
        scope: "curate",
        writeBar: STRICT_BAR
      })
    ).toEqual([])
  })

  it("a task must be anchored: its workspace path anchors it, an inbox task needs an entity", async () => {
    const view = await head()
    const task = memory("Rotate the key", "Rotate the signing key.", {
      entities: [],
      memoryType: "task"
    })
    expect(writeBarReasons("areas/inbox/tasks/rotate.html", task, STRICT_BAR)).toEqual([
      UNANCHORED_REASON
    ])
    expect(writeBarReasons("projects/memhtml/tasks/rotate.html", task, STRICT_BAR)).toEqual([])
    const named = memory("Rotate the key", "Rotate the signing key.", {
      entities: ["system:memhtml"],
      memoryType: "task"
    })
    expect(writeBarReasons("areas/inbox/tasks/rotate.html", named, STRICT_BAR)).toEqual([])
    // Through `validateOps` too, under both scopes: the bar is the only thing that differs.
    for (const scope of ["session", "curate"] as const) {
      expect(
        validateOps(view, [put("areas/inbox/tasks/rotate.html", task)], {
          scope,
          writeBar: STRICT_BAR
        }),
        scope
      ).toEqual([
        { kind: "write-bar", path: "areas/inbox/tasks/rotate.html", reasons: [UNANCHORED_REASON] }
      ])
      expect(
        validateOps(view, [put("projects/memhtml/tasks/rotate.html", task)], {
          scope,
          writeBar: STRICT_BAR
        }),
        scope
      ).toEqual([])
    }
  })

  it("an archive destination is never judged by the write bar, under either scope", async () => {
    const bare = memory("Old lesson", "An old lesson that names nothing.", { entities: [] })
    const view = mapHead("0".repeat(40), [await recordFrom("areas/inbox/old-lesson.html", bare)])
    const archive: OverlayOp = {
      kind: "archive",
      path: "areas/inbox/old-lesson.html",
      to: "archive/2026/areas/inbox/old-lesson.html",
      html: bare
    }
    expect(writeBarReasons("archive/2026/areas/inbox/old-lesson.html", bare, STRICT_BAR)).toEqual(
      []
    )
    for (const scope of ["session", "curate"] as const) {
      expect(validateOps(view, [archive], { scope, writeBar: STRICT_BAR }), scope).toEqual([])
    }
  })

  it("a label must name a well-formed entity the source does not carry yet, as the batch sees it", async () => {
    const view = await head()
    const label = (path: string, entity: string): OverlayOp => ({ kind: "label", path, entity })
    const refused = (path: string, reason: string) => [{ kind: "format", path, reasons: [reason] }]
    // ALPHA carries `system:fixture` from the helper.
    expect(validateOps(view, [label("areas/inbox/alpha.html", "system:memhtml")])).toEqual([])
    expect(validateOps(view, [label("areas/inbox/alpha.html", "system:fixture")])).toEqual(
      refused("areas/inbox/alpha.html", "label names an entity the source already carries")
    )
    // One value, once: the second label of it in one batch is refused.
    expect(
      validateOps(view, [
        label("areas/inbox/alpha.html", "system:memhtml"),
        label("areas/inbox/alpha.html", "system:memhtml")
      ])
    ).toEqual(refused("areas/inbox/alpha.html", "label names an entity the source already carries"))
    // A value the batch took off can go back on.
    expect(
      validateOps(view, [
        { kind: "unlabel", path: "areas/inbox/alpha.html", entity: "system:fixture" },
        label("areas/inbox/alpha.html", "system:fixture")
      ])
    ).toEqual([])
    // The value must be a normalized `type:name`.
    for (const entity of ["memhtml", "System:Memhtml", "system: memhtml", ""]) {
      expect(validateOps(view, [label("areas/inbox/alpha.html", entity)]), entity).toEqual(
        refused(
          "areas/inbox/alpha.html",
          `entity \`${entity}\` is not a normalized type:name value (lowercase, e.g. system:memhtml)`
        )
      )
    }
    // The source must be active in the head or put by this batch, whose own entities count.
    expect(
      validateOps(view, [label("archive/2025/areas/inbox/old.html", "system:memhtml")])
    ).toEqual(
      refused(
        "archive/2025/areas/inbox/old.html",
        "label source is not an active record in the head"
      )
    )
    const beta = memory("Beta", "Beta is the second letter.")
    expect(
      validateOps(view, [
        put("areas/inbox/beta.html", beta),
        label("areas/inbox/beta.html", "system:memhtml")
      ])
    ).toEqual([])
    expect(
      validateOps(view, [
        put("areas/inbox/beta.html", beta),
        label("areas/inbox/beta.html", "system:fixture")
      ])
    ).toEqual(refused("areas/inbox/beta.html", "label names an entity the source already carries"))
    // Reserved paths and the batch cap count a label like any other op.
    expect(validateOps(view, [label(".memhtml/x.html", "system:memhtml")])).toContainEqual({
      kind: "reserved-path",
      path: ".memhtml/x.html"
    })
    const many = Array.from({ length: BATCH_CAP + 1 }, (_, index) =>
      label("areas/inbox/alpha.html", `topic:t${String(index)}`)
    )
    expect(validateOps(view, many)).toEqual([
      { kind: "batch-cap", count: BATCH_CAP + 1, cap: BATCH_CAP }
    ])
  })

  it("an unlabel must name an entity the source carries as the batch sees it", async () => {
    const two = memory("Two", "Two labels sit on this record.", {
      entities: ["system:fixture", "Service:Legacy"]
    })
    const view = mapHead("0".repeat(40), [
      await recordFrom("areas/inbox/two.html", two),
      await recordFrom("archive/2025/areas/inbox/old.html", two)
    ])
    const unlabel = (path: string, entity: string): OverlayOp => ({
      kind: "unlabel",
      path,
      entity
    })
    const refused = (path: string, reason: string) => [{ kind: "format", path, reasons: [reason] }]
    const missing = "unlabel names an entity the source does not carry"
    expect(validateOps(view, [unlabel("areas/inbox/two.html", "system:memhtml")])).toEqual(
      refused("areas/inbox/two.html", missing)
    )
    // A legacy spelling the record carries comes off as authored; that is how one is repaired.
    expect(validateOps(view, [unlabel("areas/inbox/two.html", "Service:Legacy")])).toEqual([])
    // Once, not twice.
    expect(
      validateOps(view, [
        unlabel("areas/inbox/two.html", "Service:Legacy"),
        unlabel("areas/inbox/two.html", "Service:Legacy")
      ])
    ).toEqual(refused("areas/inbox/two.html", missing))
    // A value this batch labeled can be taken off by the same batch.
    expect(
      validateOps(view, [
        { kind: "label", path: "areas/inbox/two.html", entity: "system:memhtml" },
        unlabel("areas/inbox/two.html", "system:memhtml")
      ])
    ).toEqual([])
    expect(
      validateOps(view, [unlabel("archive/2025/areas/inbox/old.html", "system:fixture")])
    ).toEqual(
      refused(
        "archive/2025/areas/inbox/old.html",
        "unlabel source is not an active record in the head"
      )
    )
  })

  it("an unlabel that leaves a record with no entity and no workspace path fails the write bar", async () => {
    const view = mapHead("0".repeat(40), [
      await recordFrom("areas/inbox/alpha.html", ALPHA),
      await recordFrom("projects/memhtml/alpha.html", ALPHA)
    ])
    const last: OverlayOp = {
      kind: "unlabel",
      path: "areas/inbox/alpha.html",
      entity: "system:fixture"
    }
    const relabel: OverlayOp = {
      kind: "label",
      path: "areas/inbox/alpha.html",
      entity: "system:memhtml"
    }
    const bar = [
      { kind: "write-bar", path: "areas/inbox/alpha.html", reasons: [UNANCHORED_REASON] }
    ]
    for (const scope of ["session", "curate"] as const) {
      expect(validateOps(view, [last], { scope, writeBar: STRICT_BAR }), scope).toEqual(bar)
    }
    // Judged once the batch is walked, so swapping one label for another passes in either order.
    expect(validateOps(view, [last, relabel], { writeBar: STRICT_BAR })).toEqual([])
    expect(validateOps(view, [relabel, last], { writeBar: STRICT_BAR })).toEqual([])
    // A workspace path anchors the record without an entity.
    expect(
      validateOps(
        view,
        [{ kind: "unlabel", path: "projects/memhtml/alpha.html", entity: "system:fixture" }],
        { writeBar: STRICT_BAR }
      )
    ).toEqual([])
    // An archive after the unlabel moves the record, and an archive destination is not judged.
    expect(
      validateOps(
        view,
        [
          last,
          {
            kind: "archive",
            path: "areas/inbox/alpha.html",
            to: "archive/2026/areas/inbox/alpha.html",
            html: ALPHA
          }
        ],
        { writeBar: STRICT_BAR }
      )
    ).toEqual([])
  })

  it("the library default bar refuses no type and anchors nothing", async () => {
    const view = mapHead("0".repeat(40), [await recordFrom("areas/inbox/alpha.html", ALPHA)])
    const narrative = memory("Run 44", "Run 44 read two files.", {
      memoryType: "episodic",
      entities: []
    })
    const verdict = memory("Review of run 44", "Run 44 was marked supported.", {
      memoryType: "verdict",
      entities: []
    })
    const task = memory("Rotate the key", "Rotate the signing key.", {
      memoryType: "task",
      entities: []
    })
    const ops: ReadonlyArray<OverlayOp> = [
      put("areas/inbox/run-44.html", narrative),
      put("areas/inbox/review-44.html", verdict),
      put("areas/inbox/tasks/rotate.html", task),
      { kind: "unlabel", path: "areas/inbox/alpha.html", entity: "system:fixture" }
    ]
    for (const scope of ["session", "curate"] as const) {
      expect(validateOps(view, ops, { scope }), scope).toEqual([])
    }
    expect(writeBarReasons("areas/inbox/run-44.html", narrative)).toEqual([])
    // The same batch under the strict bar: three refused puts and one unanchored unlabel.
    expect(
      validateOps(view, ops, { writeBar: STRICT_BAR }).map((violation) => [
        violation.kind,
        "path" in violation ? violation.path : null
      ])
    ).toEqual([
      ["write-bar", "areas/inbox/run-44.html"],
      ["write-bar", "areas/inbox/review-44.html"],
      ["write-bar", "areas/inbox/tasks/rotate.html"],
      ["write-bar", "areas/inbox/alpha.html"]
    ])
  })

  it("a store's bar refuses only what it names, with the reason it gives or the default one", async () => {
    const view = await head()
    const bare = memory("Bare", "This record names nothing.", { entities: [] })
    const task = memory("Rotate", "Rotate the key.", { memoryType: "task" })
    const narrative = memory("Run 45", "Run 45 read a file.", { memoryType: "episodic" })
    const onlyTasks = {
      refusedTypes: new Map([["task", "tasks live in the tracker"]]),
      requireAnchor: false
    }
    expect(
      validateOps(
        view,
        [
          put("areas/inbox/bare.html", bare),
          put("areas/inbox/tasks/rotate.html", task),
          put("areas/inbox/run-45.html", narrative)
        ],
        { writeBar: onlyTasks }
      )
    ).toEqual([
      {
        kind: "write-bar",
        path: "areas/inbox/tasks/rotate.html",
        reasons: ["tasks live in the tracker"]
      }
    ])
    // The anchor rule alone refuses the bare record and no type.
    expect(
      validateOps(
        view,
        [put("areas/inbox/bare.html", bare), put("areas/inbox/run-45.html", narrative)],
        { writeBar: { refusedTypes: new Map(), requireAnchor: true } }
      )
    ).toEqual([{ kind: "write-bar", path: "areas/inbox/bare.html", reasons: [UNANCHORED_REASON] }])
  })

  it("the store's config file is reserved under every scope", () => {
    for (const scope of ["session", "curate"] as const) {
      expect(isReservedPath("memhtml.config.json", scope), scope).toBe(true)
    }
    // Only at the root: the name says nothing about a file deeper in the tree.
    expect(isReservedPath("areas/inbox/memhtml.config.json")).toBe(false)
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
    expect(touchedPaths({ kind: "label", path: "a.html", entity: "system:memhtml" })).toEqual([
      "a.html"
    ])
    expect(touchedPaths({ kind: "unlabel", path: "a.html", entity: "system:memhtml" })).toEqual([
      "a.html"
    ])
  })
})

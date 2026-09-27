import type { OverlayOp } from "@memhtml/contracts"
import { contentHash } from "@memhtml/html"
import { describe, expect, it } from "vitest"

import { withOverlay } from "../src/index.js"
import { BROKEN_HTML, mapView, memoryFor, recordOf, run, runErr } from "./helpers.js"

/**
 * Overlay semantics over a `Map`-backed base, so the fallback in `indexesOf` is what these exercise
 * and no git repo is needed.
 *
 * Guard mutations (each run once, see the report):
 * - `applyOp` link: drop the `isEdgeRel` check, and "refuses a link with a rel outside the
 *   vocabulary" fails (addLink would throw or emit an unknown token instead of a typed error).
 * - `applyOp` archive: drop `archived: true`, and "archive moves the record" fails on `archived`.
 * - `applyOp` unlink: drop the `existing.links.some(...)` check, and "refuses an unlink of an edge
 *   the file does not carry" fails (the op is applied as a no-op instead of a typed error).
 * - `applyOp` unlink: call `addLink` instead of `removeLink`, and "unlink re-parses the file with
 *   the edge removed" fails on `links`.
 * - `applyOp` label: drop the `isWellFormedEntity` check, and "refuses a label whose path the view
 *   does not hold, or whose value is not type:name" fails (the malformed value is written).
 * - `applyOp` unlabel: drop the `existing.entities.includes(...)` check, and "refuses an unlabel of
 *   an entity the file does not carry" fails (the op is applied as a no-op instead of a typed error).
 * - `applyOp` unlabel: call `addMeta` instead of `removeMeta`, and "unlabel re-parses the file with
 *   the entity removed" fails on `entities`.
 */

const base = async () => {
  const records = await Promise.all([0, 1, 2, 3].map((index) => recordOf(memoryFor(index))))
  return { view: mapView(records, "basesha"), records }
}

describe("withOverlay", () => {
  it("put inserts a new record and the result carries the base's sha", async () => {
    const { view } = await base()
    const fresh = { path: "areas/inbox/fresh.html", html: memoryFor(50).html }
    const overlay = await run(withOverlay(view, [{ kind: "put", ...fresh }]))
    expect(overlay.sha).toBe("basesha")
    expect(overlay.size).toBe(5)
    expect(overlay.get(fresh.path)?.claim).toBe("The capital of Country50 is City50.")
    expect(overlay.byContentHash(contentHash(fresh.html))).toBe(fresh.path)
    expect(overlay.byFrameKey("the capital of country50 is")).toEqual([fresh.path])
    // The base is untouched.
    expect(view.size).toBe(4)
    expect(view.get(fresh.path)).toBeUndefined()
  })

  it("put over an existing path replaces the record and re-points every index", async () => {
    const { view } = await base()
    const two = memoryFor(2)
    const replaced = memoryFor(60).html
    const overlay = await run(withOverlay(view, [{ kind: "put", path: two.path, html: replaced }]))
    expect(overlay.size).toBe(4)
    expect(overlay.get(two.path)?.claim).toBe("The capital of Country60 is City60.")
    expect(overlay.byContentHash(contentHash(two.html))).toBeUndefined()
    expect(overlay.byContentHash(contentHash(replaced))).toBe(two.path)
    expect(overlay.byFrameKey("the capital of country2 is")).toEqual([])
    expect(overlay.byEntity("place:country2")).toEqual([])
    expect(overlay.byEntity("place:country60")).toEqual([two.path])
  })

  it("archive moves the record to `to` with archived true and drops it from the active indexes", async () => {
    const { view } = await base()
    const one = memoryFor(1)
    const to = "archive/2026/areas/inbox/fact-1.html"
    const overlay = await run(
      withOverlay(view, [{ kind: "archive", path: one.path, to, html: one.html }])
    )
    expect(overlay.get(one.path)).toBeUndefined()
    const moved = overlay.get(to)
    expect(moved?.archived).toBe(true)
    expect(moved?.path).toBe(to)
    expect(overlay.size).toBe(4)
    expect(overlay.byContentHash(contentHash(one.html))).toBeUndefined()
    expect(overlay.byFrameKey("the capital of country1 is")).toEqual([])
    // Edges and entities of an archived record stay visible.
    expect(overlay.byEntity("place:country1")).toEqual([to])
    expect(overlay.inbound(`/${memoryFor(0).path}`)).toEqual([to])
  })

  it("archive to a path outside archive/ still marks the record archived", async () => {
    const { view } = await base()
    const one = memoryFor(1)
    const overlay = await run(
      withOverlay(view, [
        { kind: "archive", path: one.path, to: "areas/inbox/fact-1-old.html", html: one.html }
      ])
    )
    expect(overlay.get("areas/inbox/fact-1-old.html")?.archived).toBe(true)
  })

  it("link re-parses the file with the edge added and leaves the content hash unchanged", async () => {
    const { view } = await base()
    const three = memoryFor(3)
    const overlay = await run(
      withOverlay(view, [
        { kind: "link", path: three.path, rel: "contradicts", href: "/areas/inbox/fact-1.html" }
      ])
    )
    const linked = overlay.get(three.path)
    expect(linked?.links).toContainEqual({ rel: "contradicts", href: "/areas/inbox/fact-1.html" })
    expect(linked?.contentHash).toBe(contentHash(three.html))
    expect(linked?.blobSha).not.toBe(view.get(three.path)?.blobSha)
    expect(linked?.html).toContain(
      '<link rel="memhtml-contradicts" href="/areas/inbox/fact-1.html">'
    )
    expect([...overlay.inbound("/areas/inbox/fact-1.html")].sort()).toEqual(
      [three.path, memoryFor(2).path].sort()
    )
    // Idempotent on the pair.
    const twice = await run(
      withOverlay(overlay, [
        { kind: "link", path: three.path, rel: "contradicts", href: "/areas/inbox/fact-1.html" }
      ])
    )
    expect(twice.get(three.path)?.html).toBe(linked?.html)
  })

  it("applies ops in order, so a link can target a put from the same batch", async () => {
    const { view } = await base()
    const fresh = { path: "areas/inbox/fresh.html", html: memoryFor(70).html }
    const ops: ReadonlyArray<OverlayOp> = [
      { kind: "put", ...fresh },
      { kind: "link", path: fresh.path, rel: "supersedes", href: `/${memoryFor(0).path}` }
    ]
    const overlay = await run(withOverlay(view, ops))
    expect(overlay.get(fresh.path)?.links).toContainEqual({
      rel: "supersedes",
      href: `/${memoryFor(0).path}`
    })
    expect([...overlay.inbound(`/${memoryFor(0).path}`)].sort()).toEqual(
      [fresh.path, memoryFor(1).path].sort()
    )
  })

  it("unlink re-parses the file with the edge removed and leaves the content hash unchanged", async () => {
    const { view } = await base()
    // memoryFor(2) carries `relates_to -> /<memoryFor(1).path>` from the fixture.
    const two = memoryFor(2)
    const href = `/${memoryFor(1).path}`
    expect(view.get(two.path)?.links).toContainEqual({ rel: "relates_to", href })
    const overlay = await run(
      withOverlay(view, [{ kind: "unlink", path: two.path, rel: "relates_to", href }])
    )
    const unlinked = overlay.get(two.path)
    expect(unlinked?.links).toEqual([])
    expect(unlinked?.contentHash).toBe(contentHash(two.html))
    expect(unlinked?.blobSha).not.toBe(view.get(two.path)?.blobSha)
    expect(unlinked?.html).not.toContain(`href="${href}"`)
    expect(overlay.inbound(href)).toEqual([])
    // The base is untouched.
    expect(view.get(two.path)?.links).toHaveLength(1)
  })

  it("applies ops in order, so a link added earlier in the batch can be unlinked later", async () => {
    const { view } = await base()
    const three = memoryFor(3)
    const href = "/areas/inbox/fact-1.html"
    const overlay = await run(
      withOverlay(view, [
        { kind: "link", path: three.path, rel: "contradicts", href },
        { kind: "unlink", path: three.path, rel: "contradicts", href }
      ])
    )
    expect(overlay.get(three.path)?.html).toBe(three.html)
  })

  it("refuses an unlink whose path the view does not hold, or whose rel is unknown", async () => {
    const { view } = await base()
    const ghost = await runErr(
      withOverlay(view, [
        { kind: "unlink", path: "areas/inbox/ghost.html", rel: "relates_to", href: "/x.html" }
      ])
    )
    expect(ghost._tag).toBe("InvalidMemory")
    expect(ghost.reason).toContain("ghost")
    const rel = await runErr(
      withOverlay(view, [
        { kind: "unlink", path: memoryFor(2).path, rel: "friends-with", href: "/x.html" }
      ])
    )
    expect(rel.reason).toBe("unknown link rel: friends-with")
  })

  it("refuses an unlink of an edge the file does not carry", async () => {
    const { view } = await base()
    const error = await runErr(
      withOverlay(view, [
        { kind: "unlink", path: memoryFor(0).path, rel: "relates_to", href: "/areas/inbox/x.html" }
      ])
    )
    expect(error._tag).toBe("InvalidMemory")
    expect(error.reason).toBe(
      `unlink op names an edge ${memoryFor(0).path} does not carry: relates_to -> /areas/inbox/x.html`
    )
  })

  it("label re-parses the file with the entity added, re-points byEntity, and keeps the hash", async () => {
    const { view } = await base()
    const one = memoryFor(1)
    const overlay = await run(
      withOverlay(view, [{ kind: "label", path: one.path, entity: "system:memhtml" }])
    )
    const labeled = overlay.get(one.path)
    expect(labeled?.entities).toEqual(["place:country1", "topic:crop1", "system:memhtml"])
    expect(labeled?.contentHash).toBe(contentHash(one.html))
    expect(labeled?.blobSha).not.toBe(view.get(one.path)?.blobSha)
    expect(overlay.byEntity("system:memhtml")).toEqual([one.path])
    expect(overlay.byEntity("place:country1")).toEqual([one.path])
    // Every other index still answers for the record.
    expect(overlay.byContentHash(contentHash(one.html))).toBe(one.path)
    expect(overlay.byFrameKey("the capital of country1 is")).toEqual([one.path])
    // The base is untouched.
    expect(view.byEntity("system:memhtml")).toEqual([])
    expect(view.get(one.path)?.entities).toHaveLength(2)
  })

  it("unlabel re-parses the file with the entity removed and leaves the content hash unchanged", async () => {
    const { view } = await base()
    const two = memoryFor(2)
    const overlay = await run(
      withOverlay(view, [{ kind: "unlabel", path: two.path, entity: "place:country2" }])
    )
    const unlabeled = overlay.get(two.path)
    expect(unlabeled?.entities).toEqual(["topic:crop2"])
    expect(unlabeled?.contentHash).toBe(contentHash(two.html))
    expect(unlabeled?.html).not.toContain('content="place:country2"')
    expect(overlay.byEntity("place:country2")).toEqual([])
    expect(overlay.byEntity("topic:crop2")).toContain(two.path)
    expect(view.byEntity("place:country2")).toEqual([two.path])
  })

  it("applies ops in order, so a label added earlier in the batch can be removed later", async () => {
    const { view } = await base()
    const three = memoryFor(3)
    const overlay = await run(
      withOverlay(view, [
        { kind: "label", path: three.path, entity: "system:memhtml" },
        { kind: "unlabel", path: three.path, entity: "system:memhtml" }
      ])
    )
    expect(overlay.get(three.path)?.html).toBe(three.html)
    expect(overlay.byEntity("system:memhtml")).toEqual([])
  })

  it("refuses a label whose path the view does not hold, or whose value is not type:name", async () => {
    const { view } = await base()
    const ghost = await runErr(
      withOverlay(view, [
        { kind: "label", path: "areas/inbox/ghost.html", entity: "system:memhtml" }
      ])
    )
    expect(ghost._tag).toBe("InvalidMemory")
    expect(ghost.reason).toContain("ghost")
    const malformed = await runErr(
      withOverlay(view, [{ kind: "label", path: memoryFor(1).path, entity: "Memhtml" }])
    )
    expect(malformed.reason).toBe("malformed entity: Memhtml")
  })

  it("refuses an unlabel of an entity the file does not carry", async () => {
    const { view } = await base()
    const ghost = await runErr(
      withOverlay(view, [
        { kind: "unlabel", path: "areas/inbox/ghost.html", entity: "system:memhtml" }
      ])
    )
    expect(ghost.reason).toContain("ghost")
    const error = await runErr(
      withOverlay(view, [{ kind: "unlabel", path: memoryFor(1).path, entity: "system:memhtml" }])
    )
    expect(error._tag).toBe("InvalidMemory")
    expect(error.reason).toBe(
      `unlabel op names an entity ${memoryFor(1).path} does not carry: system:memhtml`
    )
  })

  it("refuses a put that does not parse, with the parser's reason", async () => {
    const { view } = await base()
    const error = await runErr(
      withOverlay(view, [{ kind: "put", path: "areas/inbox/bad.html", html: BROKEN_HTML }])
    )
    expect(error._tag).toBe("InvalidMemory")
  })

  it("refuses a link whose path the view does not hold", async () => {
    const { view } = await base()
    const error = await runErr(
      withOverlay(view, [
        { kind: "link", path: "areas/inbox/ghost.html", rel: "relates_to", href: "/x.html" }
      ])
    )
    expect(error._tag).toBe("InvalidMemory")
    expect(error.reason).toContain("ghost")
  })

  it("refuses a link with a rel outside the vocabulary", async () => {
    const { view } = await base()
    const error = await runErr(
      withOverlay(view, [
        {
          kind: "link",
          path: memoryFor(0).path,
          rel: "friends-with",
          href: "/areas/inbox/fact-1.html"
        }
      ])
    )
    expect(error._tag).toBe("InvalidMemory")
    // The head's own refusal, not the parser's: the rel is checked before any HTML is spliced.
    expect(error.reason).toBe("unknown link rel: friends-with")
  })

  it("an empty op list yields a view equal to the base", async () => {
    const { view, records } = await base()
    const overlay = await run(withOverlay(view, []))
    expect(overlay.sha).toBe(view.sha)
    expect([...overlay.paths()].sort()).toEqual(records.map((record) => record.path).sort())
    for (const record of records) expect(overlay.get(record.path)).toBe(record)
  })
})

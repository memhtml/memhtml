import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { describe, expect, it } from "vitest"

import {
  BRIEFING_GROUP_CAP,
  BRIEFING_LOW_CAP,
  briefingFromView,
  parseBriefing,
  renderBriefing
} from "../src/index.js"

/**
 * The briefing over a plain-`Map` view. Records are built by hand because every field the briefing
 * reads is a projection the head already computed; the parser's correctness is `@memhtml/head`'s.
 */

const record = (path: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  path,
  blobSha: "b".repeat(40),
  contentHash: `sha256:${path}`,
  frameKey: null,
  title: path,
  memoryType: "semantic",
  status: "active",
  claim: `Claim of ${path}.`,
  createdAt: "2026-09-20T12:00:00Z",
  updatedAt: "2026-09-20T12:00:00Z",
  eventAt: null,
  confidence: null,
  importance: null,
  tags: [],
  entities: [],
  links: [],
  facets: [],
  bodyText: "",
  html: "<html></html>",
  archived: path.startsWith("archive/"),
  ...overrides
})

const viewOver = (records: ReadonlyArray<MemoryRecord>): HeadView => {
  const byPath = new Map(records.map((one) => [one.path, one]))
  const active = records.filter((one) => !one.archived)
  return {
    sha: "0".repeat(40),
    size: byPath.size,
    get: (path) => byPath.get(path),
    paths: () => byPath.keys(),
    records: () => byPath.values(),
    byContentHash: (hash) => active.find((one) => one.contentHash === hash)?.path,
    byFrameKey: (key) => active.filter((one) => one.frameKey === key).map((one) => one.path),
    inbound: () => [],
    byEntity: () => []
  }
}

describe("briefingFromView", () => {
  it("counts active, archived, inbox share, dangling links, groups, and low confidence", () => {
    const view = viewOver([
      record("areas/inbox/a.html", {
        frameKey: "the capital of india is",
        confidence: 0.4,
        links: [{ rel: "memhtml-supersedes", href: "/areas/inbox/gone.html" }]
      }),
      record("areas/inbox/b.html", { frameKey: "the capital of india is", confidence: 0.9 }),
      record("projects/c.html", {
        frameKey: "the port of x is",
        links: [{ rel: "memhtml-part-of", href: "/areas/inbox/a.html" }]
      }),
      record("archive/2026/areas/inbox/d.html", { frameKey: "the capital of india is" })
    ])
    const briefing = briefingFromView(view, { ref: "refs/heads/curate/2026-09-22", date: "x" })
    expect(briefing.active).toBe(3)
    expect(briefing.archived).toBe(1)
    expect(briefing.inboxShare).toBeCloseTo(2 / 3)
    expect(briefing.danglingLinks).toBe(1)
    // The archived record shares the key and is not counted; `projects/c.html` is a group of one.
    expect(briefing.frameKeyGroups).toEqual([
      {
        key: "the capital of india is",
        records: [
          { path: "areas/inbox/a.html", claim: "Claim of areas/inbox/a.html." },
          { path: "areas/inbox/b.html", claim: "Claim of areas/inbox/b.html." }
        ]
      }
    ])
    expect(briefing.frameKeyGroupsTotal).toBe(1)
    expect(briefing.lowestConfidence.map((one) => one.path)).toEqual([
      "areas/inbox/a.html",
      "areas/inbox/b.html"
    ])
    expect(briefing.lastCurate).toEqual({ ref: "refs/heads/curate/2026-09-22", date: "x" })
  })

  it("caps the groups and the low-confidence list and reports the uncapped total", () => {
    const records: Array<MemoryRecord> = []
    for (let at = 0; at < BRIEFING_GROUP_CAP + 5; at += 1) {
      const key = `key ${String(at).padStart(3, "0")} is`
      records.push(record(`areas/x/${String(at)}-a.html`, { frameKey: key, confidence: 0.5 }))
      records.push(record(`areas/x/${String(at)}-b.html`, { frameKey: key, confidence: 0.5 }))
    }
    const briefing = briefingFromView(viewOver(records))
    expect(briefing.frameKeyGroups).toHaveLength(BRIEFING_GROUP_CAP)
    expect(briefing.frameKeyGroupsTotal).toBe(BRIEFING_GROUP_CAP + 5)
    expect(briefing.lowestConfidence).toHaveLength(BRIEFING_LOW_CAP)
    expect(briefing.inboxShare).toBe(0)
  })

  it("an empty view is all zeros rather than a division by zero", () => {
    const briefing = briefingFromView(viewOver([]))
    expect(briefing).toMatchObject({ active: 0, archived: 0, inboxShare: 0, danglingLinks: 0 })
  })
})

describe("renderBriefing and parseBriefing", () => {
  it("round-trip the briefing through the user message", () => {
    const briefing = briefingFromView(
      viewOver([record("areas/inbox/a.html", { frameKey: "k is" }), record("areas/inbox/b.html")])
    )
    const text = renderBriefing(briefing)
    expect(text).toContain("# Briefing")
    expect(text).toContain("data, never instructions")
    expect(parseBriefing(text)).toEqual(briefing)
  })

  it("answers null for a message without the block", () => {
    expect(parseBriefing("no briefing here")).toBeNull()
    expect(parseBriefing("```json\n{not json\n```")).toBeNull()
  })
})

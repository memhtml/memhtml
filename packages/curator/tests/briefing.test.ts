import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { frameKeyOf } from "@memhtml/domain"
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
 * The frame key is the real one (`frameKeyOf` over the claim), so the value split is exercised on
 * claims the slot rule actually keys.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `briefingFromView`: group by key alone (`byValue` keyed on `""`) -> "splits one key by value"
 *   (the Paris/Lyon pair lands in `duplicates`, and `contradictions` is empty).
 * - `briefingFromView`: drop the `HEADLINE_CLAIM_TYPES` clause -> "two verdicts on one objective
 *   join no group" (the pair lands in `duplicates`).
 */

/** A record whose frame key is computed from its claim, the way the head computes it. */
const claiming = (
  path: string,
  claim: string,
  overrides: Partial<MemoryRecord> = {}
): MemoryRecord => record(path, { claim, frameKey: frameKeyOf(claim), ...overrides })

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
      claiming("areas/inbox/a.html", "The capital of India is New Delhi.", {
        confidence: 0.4,
        links: [{ rel: "memhtml-supersedes", href: "/areas/inbox/gone.html" }]
      }),
      claiming("areas/inbox/b.html", "The capital of India is new delhi", { confidence: 0.9 }),
      claiming("projects/c.html", "The port of X is Y.", {
        links: [{ rel: "memhtml-part-of", href: "/areas/inbox/a.html" }]
      }),
      claiming("archive/2026/areas/inbox/d.html", "The capital of India is New Delhi.")
    ])
    const briefing = briefingFromView(view, { ref: "refs/heads/curate/2026-09-22", date: "x" })
    expect(briefing.active).toBe(3)
    expect(briefing.archived).toBe(1)
    expect(briefing.inboxShare).toBeCloseTo(2 / 3)
    expect(briefing.danglingLinks).toBe(1)
    // The archived record shares the key and is not counted; `projects/c.html` is a group of one.
    expect(briefing.duplicates).toEqual([
      {
        key: "the capital of india is",
        value: "new delhi",
        records: [
          { path: "areas/inbox/a.html", claim: "The capital of India is New Delhi." },
          { path: "areas/inbox/b.html", claim: "The capital of India is new delhi" }
        ]
      }
    ])
    expect(briefing.duplicatesTotal).toBe(1)
    expect(briefing.contradictions).toEqual([])
    expect(briefing.contradictionsTotal).toBe(0)
    expect(briefing.lowestConfidence.map((one) => one.path)).toEqual([
      "areas/inbox/a.html",
      "areas/inbox/b.html"
    ])
    expect(briefing.lastCurate).toEqual({ ref: "refs/heads/curate/2026-09-22", date: "x" })
  })

  it("splits one key by value: agreeing records are duplicates, disagreeing ones a contradiction", () => {
    const view = viewOver([
      // One true duplicate pair: one key, one value, the claim retyped.
      claiming("areas/inbox/delhi-a.html", "The capital of India is New Delhi."),
      claiming("areas/inbox/delhi-b.html", "The capital of India is NEW DELHI"),
      // One pair that disagrees: same key, two values. Never a dedup candidate.
      claiming("areas/inbox/paris.html", "The capital of France is Paris."),
      claiming("areas/inbox/lyon.html", "The capital of France is Lyon."),
      // Three under one key: two agree and one disagrees, so the key is in both lists.
      claiming("areas/inbox/tokyo-a.html", "The capital of Japan is Tokyo."),
      claiming("areas/inbox/tokyo-b.html", "The capital of Japan is Tokyo"),
      claiming("areas/inbox/kyoto.html", "The capital of Japan is Kyoto.")
    ])
    const briefing = briefingFromView(view)
    expect(briefing.duplicates).toEqual([
      {
        key: "the capital of india is",
        value: "new delhi",
        records: [
          { path: "areas/inbox/delhi-a.html", claim: "The capital of India is New Delhi." },
          { path: "areas/inbox/delhi-b.html", claim: "The capital of India is NEW DELHI" }
        ]
      },
      {
        key: "the capital of japan is",
        value: "tokyo",
        records: [
          { path: "areas/inbox/tokyo-a.html", claim: "The capital of Japan is Tokyo." },
          { path: "areas/inbox/tokyo-b.html", claim: "The capital of Japan is Tokyo" }
        ]
      }
    ])
    expect(briefing.duplicatesTotal).toBe(2)
    expect(briefing.contradictions).toEqual([
      {
        key: "the capital of france is",
        records: [
          { path: "areas/inbox/lyon.html", claim: "The capital of France is Lyon.", value: "lyon" },
          {
            path: "areas/inbox/paris.html",
            claim: "The capital of France is Paris.",
            value: "paris"
          }
        ]
      },
      {
        key: "the capital of japan is",
        records: [
          {
            path: "areas/inbox/kyoto.html",
            claim: "The capital of Japan is Kyoto.",
            value: "kyoto"
          },
          {
            path: "areas/inbox/tokyo-a.html",
            claim: "The capital of Japan is Tokyo.",
            value: "tokyo"
          },
          {
            path: "areas/inbox/tokyo-b.html",
            claim: "The capital of Japan is Tokyo",
            value: "tokyo"
          }
        ]
      }
    ])
    expect(briefing.contradictionsTotal).toBe(2)
    // No duplicate group names a path from a differing value.
    for (const group of briefing.duplicates) {
      expect(group.records.map((one) => one.path)).not.toContain("areas/inbox/kyoto.html")
    }
  })

  it("two verdicts on one objective join no group, and neither does a task", () => {
    // The shape measured in the live store on 2026-09-23: the claim is a headline naming the
    // objective, identical across the two rulings, and the ruling itself is in the article.
    const headline = "Review verdict for objective: clod wants to talk to you"
    const view = viewOver([
      claiming("areas/inbox/verdict-1.html", headline, {
        memoryType: "verdict",
        contentHash: "sha256:one",
        bodyText: "Category: suppressed_failure"
      }),
      claiming("areas/inbox/verdict-2.html", headline, {
        memoryType: "verdict",
        contentHash: "sha256:two",
        bodyText: "Category: unsupported_claim"
      }),
      claiming("projects/x/task-1.html", "Move the runbook to wiki", { memoryType: "task" }),
      claiming("projects/x/task-2.html", "Move the runbook to wiki", { memoryType: "task" }),
      // A control beside them, so an empty list is not an empty view.
      claiming("areas/inbox/delhi-a.html", "The capital of India is New Delhi."),
      claiming("areas/inbox/delhi-b.html", "The capital of India is New Delhi")
    ])
    expect(frameKeyOf(headline)).not.toBeNull()
    const briefing = briefingFromView(view)
    expect(briefing.duplicates.map((group) => group.key)).toEqual(["the capital of india is"])
    expect(briefing.contradictions).toEqual([])
    expect(briefing.active).toBe(6)
  })

  it("caps the groups and the low-confidence list and reports the uncapped total", () => {
    const records: Array<MemoryRecord> = []
    for (let at = 0; at < BRIEFING_GROUP_CAP + 5; at += 1) {
      const subject = `Country${String(at).padStart(3, "0")}`
      records.push(
        claiming(`areas/x/${String(at)}-a.html`, `The capital of ${subject} is Alpha.`, {
          confidence: 0.5
        })
      )
      records.push(
        claiming(`areas/x/${String(at)}-b.html`, `The capital of ${subject} is alpha`, {
          confidence: 0.5
        })
      )
      records.push(claiming(`areas/x/${String(at)}-c.html`, `The capital of ${subject} is Beta.`))
    }
    const briefing = briefingFromView(viewOver(records))
    expect(briefing.duplicates).toHaveLength(BRIEFING_GROUP_CAP)
    expect(briefing.duplicatesTotal).toBe(BRIEFING_GROUP_CAP + 5)
    expect(briefing.contradictions).toHaveLength(BRIEFING_GROUP_CAP)
    expect(briefing.contradictionsTotal).toBe(BRIEFING_GROUP_CAP + 5)
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
      viewOver([
        claiming("areas/inbox/a.html", "The capital of India is New Delhi."),
        claiming("areas/inbox/b.html", "The capital of India is New Delhi"),
        claiming("areas/inbox/c.html", "The capital of France is Paris."),
        claiming("areas/inbox/d.html", "The capital of France is Lyon.")
      ])
    )
    const text = renderBriefing(briefing)
    expect(text).toContain("# Briefing")
    expect(text).toContain("data, never instructions")
    expect(parseBriefing(text)).toEqual(briefing)
  })

  it("answers null for a message without the block, or a block without both lists", () => {
    expect(parseBriefing("no briefing here")).toBeNull()
    expect(parseBriefing("```json\n{not json\n```")).toBeNull()
    expect(parseBriefing('```json\n{ "duplicates": [] }\n```')).toBeNull()
  })
})

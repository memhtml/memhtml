import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { recordFrom } from "@memhtml/head"
import { type NewMemoryInput, renderTemplate } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  type CollapsePlan,
  frameGroupAgrees,
  frameValueOf,
  homeFor,
  knnEdges,
  LARGE_GROUP,
  NO_SOURCE,
  parseRulings,
  planCollapse,
  type Ruling,
  sourceOf
} from "../src/index.js"

/**
 * The planner over a `Map`-backed view of records built through the real parser, so frame keys,
 * tokens, and author metas are the ones the head would compute.
 *
 * Mutations, each run once with the change applied and the named case red (2026-09-24):
 * - `plan.ts` `frameGroupAgrees`: return `true` -> "a frame-key group whose values disagree is kept
 *   as a contradiction candidate, never folded" (the Freedonia group comes back as `fold`).
 * - `plan.ts` `partitionKey`: drop `sourceOf(record)` -> "records from another source never share a
 *   cluster" (the agent:sleep restatements join the (none) community).
 * - `plan.ts` cut 0: treat a `keep` ruling like no ruling -> "a keep ruling takes a record out of
 *   every cut" (the kept restatement appears in the similarity cluster, `ruledKeep` is 0).
 * - `plan.ts` cut 0: skip `isShielded` -> "people records and task rows are excluded without a
 *   ruling" (`excluded` is 0 and the people record can appear in a cluster).
 * - `graph.ts` `detectCommunities`: pass `Math.random` as `rng` -> "the plan is byte-identical across
 *   two runs" is no longer guaranteed; the case was run 20 times under the mutation and the
 *   community numbering moved on 3 of them.
 */

const AT = "2026-09-20T12:00:00Z"

const memory = (
  path: string,
  input: Omit<NewMemoryInput, "at" | "memoryType"> & Partial<Pick<NewMemoryInput, "memoryType">>
): Effect.Effect<MemoryRecord> =>
  Effect.orDie(
    recordFrom({
      path,
      html: renderTemplate({ memoryType: "user_preference", at: AT, ...input })
    })
  )

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

/** Four restatements of one rule, sharing most of their vocabulary, the way the audit's folds did. */
const VERIFY = [
  "Verify against the primary source before asserting a result or claiming completion.",
  "Always verify the primary source before asserting completion of a result.",
  "Before claiming completion, verify the result against its primary source.",
  "Assert a result only after verifying it against the primary source."
]

const PKILL = [
  "pkill -f matching the shell's own command line kills the shell that ran it.",
  "A pkill -f pattern that matches its own shell command line kills the running shell.",
  "Never run pkill -f with a pattern the invoking shell command line also matches."
]

/** Unrelated records with disjoint vocabulary: singletons by construction. */
const SINGLETONS = [
  "The docs site renders diagrams through d2 at build time.",
  "Lighthouse scores a static page pessimistically under host contention.",
  "The snapshot file is one Arrow IPC table per commit.",
  "Biome formats every TypeScript file with double quotes and no semicolons.",
  "The store's archive year comes from the commit clock in UTC."
]

const fixture = async (): Promise<ReadonlyArray<MemoryRecord>> =>
  Effect.runPromise(
    Effect.all([
      ...VERIFY.map((claim, index) =>
        memory(`areas/inbox/verify-${String(index)}.html`, {
          title: `Verify before asserting ${String(index)}`,
          claim,
          body: [`Seen on run ${String(index)}.`],
          tags: ["verification"],
          entities: index === 0 ? ["person:laith"] : []
        })
      ),
      ...PKILL.map((claim, index) =>
        memory(`areas/inbox/pkill-${String(index)}.html`, {
          title: `pkill self match ${String(index)}`,
          claim,
          body: [`Exit code 144 on attempt ${String(index)}.`]
        })
      ),
      ...SINGLETONS.map((claim, index) =>
        memory(`areas/inbox/single-${String(index)}.html`, {
          title: `Singleton ${String(index)}`,
          claim
        })
      ),
      // The same restatements from another source: same words, different author, never one cluster.
      ...VERIFY.slice(0, 3).map((claim, index) =>
        memory(`resources/wiki-kernel-import/verify-sleep-${String(index)}.html`, {
          title: `Verify before asserting, imported ${String(index)}`,
          claim,
          author: "agent:sleep"
        })
      ),
      // A frame-key group that agrees: one value said with two bodies.
      memory("areas/inbox/capital-a.html", {
        title: "Capital of India",
        claim: "The capital of India is New Delhi.",
        memoryType: "semantic"
      }),
      memory("areas/inbox/capital-b.html", {
        title: "Capital of India, again",
        claim: "The capital of India is New Delhi.",
        body: ["Restated with a body."],
        memoryType: "semantic"
      }),
      // A frame-key group that disagrees: two values in one slot, a contradiction candidate.
      memory("areas/inbox/freedonia-a.html", {
        title: "Capital of Freedonia",
        claim: "The capital of Freedonia is Fredville.",
        memoryType: "semantic"
      }),
      memory("areas/inbox/freedonia-b.html", {
        title: "Capital of Freedonia, disputed",
        claim: "The capital of Freedonia is Chicolini.",
        memoryType: "semantic"
      }),
      // Shielded without a ruling: an identity record and a task row.
      memory("resources/people/laith.html", {
        title: "Laith",
        claim: "Laith verifies every primary source before asserting completion.",
        memoryType: "semantic"
      }),
      memory("areas/inbox/tasks/verify-task.html", {
        title: "Verify the primary source",
        claim: "Verify the primary source before asserting completion of this task.",
        memoryType: "task"
      })
    ])
  )

const clusterOf = (plan: CollapsePlan, path: string) =>
  plan.clusters.find((cluster) => cluster.members.some((member) => member.path === path))

describe("planCollapse without rulings", () => {
  it("cuts by source and type, then frame key, then similarity, and is byte-identical across runs", async () => {
    const view = viewOver(await fixture())
    const now = new Date("2026-09-24T10:00:00Z")
    const plan = planCollapse(view, { now })
    expect(JSON.stringify(planCollapse(view, { now }))).toBe(JSON.stringify(plan))
    expect(plan.tag).toBe("collapse-2026-09-24")
    expect(plan.archiveYear).toBe("2026")

    // The four restatements are one fold; the three pkill notes another.
    const verify = clusterOf(plan, "areas/inbox/verify-0.html")
    expect(verify?.kind).toBe("fold")
    expect(verify?.cut).toBe("similarity")
    expect(verify?.members.map((member) => member.path).sort()).toEqual(
      VERIFY.map((_, index) => `areas/inbox/verify-${String(index)}.html`)
    )
    expect(verify?.members.map((m) => m.path)).toContain(verify?.anchor)
    expect(verify?.memoryType).toBe("user_preference")
    expect(verify?.source).toBe(NO_SOURCE)
    // Inbox is a bucket, so the home is a new directory named after the anchor's title.
    expect(verify?.home.startsWith("areas/")).toBe(true)
    expect(verify?.home.startsWith("areas/inbox")).toBe(false)
    expect(verify?.large).toBe(false)
    const pkill = clusterOf(plan, "areas/inbox/pkill-0.html")
    expect(pkill?.kind).toBe("fold")
    expect(pkill?.members).toHaveLength(3)
    expect(pkill?.id).not.toBe(verify?.id)

    for (const index of SINGLETONS.keys()) {
      expect(clusterOf(plan, `areas/inbox/single-${String(index)}.html`)).toBeUndefined()
    }
    expect(plan.totals.singletons).toBe(SINGLETONS.length)
  })

  it("records from another source never share a cluster", async () => {
    const plan = planCollapse(viewOver(await fixture()))
    const imported = clusterOf(plan, "resources/wiki-kernel-import/verify-sleep-0.html")
    expect(imported?.source).toBe("agent:sleep")
    expect(imported?.members.every((member) => member.path.includes("verify-sleep"))).toBe(true)
    expect(imported?.members).toHaveLength(3)
    // Three members under one real prefix keep that prefix as the home only when it is not a bucket;
    // `*-import` is a bucket, so the canonical moves out of it.
    expect(imported?.home.startsWith("resources/wiki-kernel-import")).toBe(false)
    expect(plan.totals.partitions).toBe(3)
  })

  it("a frame-key group with one value folds; one whose values disagree is kept as a contradiction candidate, never folded", async () => {
    const plan = planCollapse(viewOver(await fixture()))
    const india = clusterOf(plan, "areas/inbox/capital-a.html")
    expect(india?.kind).toBe("fold")
    expect(india?.cut).toBe("frame-key")
    expect(india?.members.map((member) => member.path)).toEqual([
      "areas/inbox/capital-a.html",
      "areas/inbox/capital-b.html"
    ])
    expect(india?.rationale).toContain("one value")
    const freedonia = clusterOf(plan, "areas/inbox/freedonia-a.html")
    expect(freedonia?.kind).toBe("keep")
    expect(freedonia?.cut).toBe("frame-key")
    expect(freedonia?.rationale).toContain("contradiction")
    expect(freedonia?.rationale).toContain("2 different values")
    expect(plan.totals.clusters.keep).toBe(1)
    expect(plan.totals.members.keep).toBe(2)
  })

  it("people records and task rows are excluded without a ruling", async () => {
    const plan = planCollapse(viewOver(await fixture()))
    expect(plan.totals.excluded).toBe(2)
    expect(clusterOf(plan, "resources/people/laith.html")).toBeUndefined()
    expect(clusterOf(plan, "areas/inbox/tasks/verify-task.html")).toBeUndefined()
    expect(plan.totals.clusters.archive).toBe(0)
  })

  it("flags a fold over the large-group cap and keeps a community over maxFold", async () => {
    const view = viewOver(await fixture())
    const large = planCollapse(view, { options: { largeGroup: 3 } })
    expect(clusterOf(large, "areas/inbox/verify-0.html")?.large).toBe(true)
    expect(clusterOf(large, "areas/inbox/pkill-0.html")?.large).toBe(false)
    expect(LARGE_GROUP).toBe(30)
    const capped = planCollapse(view, { options: { maxFold: 3 } })
    const verify = clusterOf(capped, "areas/inbox/verify-0.html")
    expect(verify?.kind).toBe("keep")
    expect(verify?.rationale).toContain("maxFold")
    expect(clusterOf(capped, "areas/inbox/pkill-0.html")?.kind).toBe("fold")
  })

  it("sorts clusters archive, fold, keep, then by size, and serializes to plain JSON", async () => {
    const plan = planCollapse(viewOver(await fixture()))
    const kinds = plan.clusters.map((cluster) => cluster.kind)
    const order = { archive: 0, fold: 1, keep: 2 }
    for (let at = 1; at < kinds.length; at += 1) {
      const previous = kinds[at - 1] ?? "keep"
      const current = kinds[at] ?? "keep"
      expect(order[previous] <= order[current]).toBe(true)
      if (previous === current) {
        expect(
          (plan.clusters[at - 1]?.members.length ?? 0) >= (plan.clusters[at]?.members.length ?? 0)
        ).toBe(true)
      }
    }
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })
})

describe("planCollapse with rulings", () => {
  const RULINGS: ReadonlyArray<Ruling> = [
    { path: "areas/inbox/single-0.html", verdict: "archive", reason: "stub" },
    { path: "areas/inbox/single-1.html", verdict: "trace", reason: "run narrative" },
    { path: "areas/inbox/pkill-0.html", verdict: "fold", theme: "shell-traps" },
    { path: "areas/inbox/pkill-1.html", verdict: "fold", theme: "shell-traps" },
    { path: "areas/inbox/verify-3.html", verdict: "keep", reason: "the best statement" },
    { path: "resources/people/laith.html", verdict: "archive", reason: "an empty stub" },
    { path: "areas/inbox/gone.html", verdict: "archive" }
  ]

  it("archive and trace rulings become archive clusters per partition, needing no model", async () => {
    const plan = planCollapse(viewOver(await fixture()), { rulings: RULINGS })
    const archives = plan.clusters.filter((cluster) => cluster.kind === "archive")
    expect(archives.map((cluster) => cluster.id).sort()).toEqual([
      "archive-none-semantic",
      "archive-none-user-preference"
    ])
    const inbox = archives.find((cluster) => cluster.id === "archive-none-user-preference")
    expect(inbox?.members.map((member) => member.path)).toEqual([
      "areas/inbox/single-0.html",
      "areas/inbox/single-1.html"
    ])
    expect(inbox?.members[0]?.ruling?.verdict).toBe("archive")
    // A ruling admits a shielded record; without one it stays excluded.
    expect(clusterOf(plan, "resources/people/laith.html")?.kind).toBe("archive")
    expect(plan.totals.excluded).toBe(1)
    expect(plan.totals.rulingsUnmatched).toBe(1)
    expect(plan.totals.members.archive).toBe(3)
  })

  it("fold rulings group by theme and carry the theme as the title", async () => {
    const plan = planCollapse(viewOver(await fixture()), { rulings: RULINGS })
    const theme = plan.clusters.find((cluster) => cluster.id === "theme-shell-traps")
    expect(theme?.kind).toBe("fold")
    expect(theme?.cut).toBe("ruling")
    expect(theme?.title).toBe("shell traps")
    expect(theme?.home).toBe("areas/shell-traps")
    expect(theme?.members.map((member) => member.path)).toEqual([
      "areas/inbox/pkill-0.html",
      "areas/inbox/pkill-1.html"
    ])
    // The third pkill note, unruled, is left alone: one record is no community.
    expect(clusterOf(plan, "areas/inbox/pkill-2.html")).toBeUndefined()
  })

  it("a keep ruling takes a record out of every cut", async () => {
    const plan = planCollapse(viewOver(await fixture()), { rulings: RULINGS })
    expect(clusterOf(plan, "areas/inbox/verify-3.html")).toBeUndefined()
    const verify = clusterOf(plan, "areas/inbox/verify-0.html")
    expect(verify?.members).toHaveLength(3)
    expect(plan.totals.ruledKeep).toBe(1)
  })
})

describe("the pieces", () => {
  it("reads the author meta as the source and spells its absence the way the analysis did", async () => {
    const records = await fixture()
    expect(sourceOf(records.find((r) => r.path.includes("verify-sleep-0")) as MemoryRecord)).toBe(
      "agent:sleep"
    )
    expect(sourceOf(records[0] as MemoryRecord)).toBe(NO_SOURCE)
  })

  it("reads the frame value past the key and judges agreement on value or claim", async () => {
    const records = await fixture()
    const a = records.find((r) => r.path === "areas/inbox/freedonia-a.html") as MemoryRecord
    const b = records.find((r) => r.path === "areas/inbox/freedonia-b.html") as MemoryRecord
    expect(frameValueOf(a)).toBe("fredville")
    expect(frameValueOf(b)).toBe("chicolini")
    expect(frameGroupAgrees([a, b])).toBe(false)
    expect(frameGroupAgrees([a, a])).toBe(true)
  })

  it("places a canonical under a real prefix and moves it out of a bucket", async () => {
    const records = await fixture()
    const inbox = records.filter((r) => r.path.startsWith("areas/inbox/verify"))
    expect(homeFor(inbox, "Verify first", "areas")).toBe("areas/verify-first")
    const people = records.filter((r) => r.path.startsWith("resources/people/"))
    expect(homeFor(people, "Laith", "areas")).toBe("resources/people")
  })

  it("kNN edges are undirected, deduplicated, above the floor, and sorted", async () => {
    const records = (await fixture()).filter((r) => r.path.startsWith("areas/inbox/verify-"))
    const edges = knnEdges(records, { k: 10, floor: 0.2 })
    expect(edges.length).toBeGreaterThan(0)
    for (const edge of edges) {
      expect(edge.from < edge.to).toBe(true)
      expect(edge.weight).toBeGreaterThanOrEqual(0.2)
      expect(edge.weight).toBeLessThanOrEqual(1.000001)
    }
    const keys = edges.map((edge) => `${edge.from}|${edge.to}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(keys)
    expect(knnEdges(records, { k: 10, floor: 1.5 })).toEqual([])
  })

  it("parses rulings JSONL and refuses a bad verdict by line", () => {
    const parsed = parseRulings(
      [
        '{"path": "areas/inbox/a.html", "verdict": "fold", "theme": "x", "reason": "r"}',
        "",
        '{"path": "/areas/inbox/b.html", "verdict": "keep"}'
      ].join("\n")
    )
    expect(parsed).toEqual([
      { path: "areas/inbox/a.html", verdict: "fold", theme: "x", reason: "r" },
      { path: "areas/inbox/b.html", verdict: "keep" }
    ])
    expect(() => parseRulings('{"path": "a.html", "verdict": "burn"}')).toThrow(/line 1/)
    expect(() => parseRulings('{"verdict": "keep"}')).toThrow(/no path/)
    expect(() => parseRulings("not json")).toThrow(/not JSON/)
  })
})

import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { describe, expect, it } from "vitest"

import {
  BRIEFING_INBOX_CAP,
  briefingFromView,
  HEADLINE_CLAIM_TYPES,
  INBOX_CLAIM_CHARS,
  inboxWorkList,
  isBucketHome
} from "../src/index.js"

/**
 * The inbox work list (`inbox.ts`) over a plain-`Map` view: which home code names for an inbox
 * record, on what evidence, and when it names none.
 *
 * Mutations, each run once with the change applied and the named case red (2026-09-30):
 * - `inboxWorkList`: `specific` returns `true` for every entity -> "an entity most of the store
 *   carries places nothing" (`person:owner` names `resources/owner`).
 * - `inboxWorkList`: the `isBucketHome(name)` skip dropped from the homes loop -> "a writer's bucket
 *   is never a home" (the import bucket wins on shared records).
 * - `inboxWorkList`: `best.score > next.score` -> `>=` -> "a tie between two homes names neither".
 * - `inboxWorkList`: the `NEW_HOME_MIN` filter dropped -> "a new home opens only for an entity three
 *   inbox records share" (the pair opens `resources/pairthing`).
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
  return {
    sha: "0".repeat(40),
    size: byPath.size,
    get: (path) => byPath.get(path),
    paths: () => byPath.keys(),
    records: () => byPath.values(),
    byContentHash: () => undefined,
    byFrameKey: () => [],
    inbound: () => [],
    byEntity: (entity) =>
      records.filter((one) => one.entities.includes(entity)).map((one) => one.path)
  }
}

const list = (records: ReadonlyArray<MemoryRecord>) =>
  inboxWorkList(viewOver(records), HEADLINE_CLAIM_TYPES)

const entryFor = (records: ReadonlyArray<MemoryRecord>, path: string) =>
  list(records).inbox.find((entry) => entry.path === path)

/** Filler records outside the inbox, so a store's share rule has a population to measure against. */
const filler = (count: number): ReadonlyArray<MemoryRecord> =>
  Array.from({ length: count }, (_, at) => record(`projects/filler/f-${String(at)}.html`))

describe("inboxWorkList names a home and its evidence", () => {
  it("names a home an entity of the record names, with the destination under it", () => {
    const records = [
      record("resources/agentd/limits.html", { entities: ["system:other"] }),
      record("areas/inbox/timeout.html", { entities: ["project:agentd"], claim: "x".repeat(500) }),
      ...filler(10)
    ]
    const entry = entryFor(records, "areas/inbox/timeout.html")
    expect(entry?.home).toEqual({
      dir: "resources/agentd",
      to: "resources/agentd/timeout.html",
      kind: "existing",
      records: 1,
      score: 3,
      named: ["project:agentd"],
      tagged: [],
      shared: []
    })
    expect(entry?.claim.length).toBe(INBOX_CLAIM_CHARS)
    expect(entry?.entities).toEqual(["project:agentd"])
  })

  it("names a home whose records carry the record's entity, and not one with a single carrier", () => {
    const records = [
      record("areas/finance-brief/a.html", { entities: ["brief:daily"] }),
      record("areas/finance-brief/b.html", { entities: ["brief:daily"] }),
      record("resources/misc/c.html", { entities: ["org:acme"] }),
      record("areas/inbox/two.html", { entities: ["brief:daily"] }),
      record("areas/inbox/one.html", { entities: ["org:acme"] }),
      ...filler(10)
    ]
    expect(entryFor(records, "areas/inbox/two.html")?.home).toMatchObject({
      dir: "areas/finance-brief",
      shared: [{ entity: "brief:daily", records: 2 }],
      score: 2
    })
    const single = entryFor(records, "areas/inbox/one.html")
    expect(single?.home).toBeNull()
    expect(single?.alternative).toEqual({ dir: "resources/misc", score: 1 })
  })

  it("a tie between two homes names neither", () => {
    const records = [
      record("resources/alpha/a.html", { entities: ["topic:shared"] }),
      record("resources/alpha/b.html", { entities: ["topic:shared"] }),
      record("resources/beta/a.html", { entities: ["topic:shared"] }),
      record("resources/beta/b.html", { entities: ["topic:shared"] }),
      record("areas/inbox/torn.html", { entities: ["topic:shared"] }),
      ...filler(10)
    ]
    const entry = entryFor(records, "areas/inbox/torn.html")
    expect(entry?.home).toBeNull()
    expect(entry?.alternative).toEqual({ dir: "resources/alpha", score: 2 })
  })

  it("an entity most of the store carries places nothing", () => {
    // 11 of 21 active records carry `person:owner`: past both the floor of 10 and a fifth.
    const owned = Array.from({ length: 10 }, (_, at) =>
      record(`projects/owned/o-${String(at)}.html`, { entities: ["person:owner"] })
    )
    const records = [
      ...owned,
      record("resources/owner/one.html"),
      record("areas/inbox/preference.html", { entities: ["person:owner"] }),
      ...filler(9)
    ]
    expect(entryFor(records, "areas/inbox/preference.html")?.home).toBeNull()
  })

  it("a writer's bucket is never a home, and a tag alone is evidence rather than a home", () => {
    expect(isBucketHome("wiki-kernel-import")).toBe(true)
    expect(isBucketHome("working-thread-2026-09-10")).toBe(true)
    expect(isBucketHome("trace-consolidation")).toBe(true)
    expect(isBucketHome("hex-bonk")).toBe(false)
    const records = [
      record("resources/wiki-kernel-import/a.html", { entities: ["service:x"] }),
      record("resources/wiki-kernel-import/b.html", { entities: ["service:x"] }),
      record("resources/wiki-kernel-import/c.html", { entities: ["service:x"] }),
      record("resources/tagged/a.html"),
      record("areas/inbox/imported.html", { entities: ["service:x"] }),
      record("areas/inbox/tagged.html", { entities: ["system:none"], tags: ["Tagged"] }),
      ...filler(10)
    ]
    expect(entryFor(records, "areas/inbox/imported.html")?.home).toBeNull()
    const tagged = entryFor(records, "areas/inbox/tagged.html")
    expect(tagged?.home).toBeNull()
    expect(tagged?.alternative).toEqual({ dir: "resources/tagged", score: 1 })
  })

  it("a new home opens only for an entity three inbox records share, and never for a person", () => {
    const records = [
      ...["a", "b", "c"].map((name) =>
        record(`areas/inbox/new-${name}.html`, { entities: ["project:newthing"] })
      ),
      ...["a", "b"].map((name) =>
        record(`areas/inbox/pair-${name}.html`, { entities: ["project:pairthing"] })
      ),
      ...["a", "b", "c"].map((name) =>
        record(`areas/inbox/who-${name}.html`, { entities: ["person:sam"] })
      ),
      ...filler(10)
    ]
    const result = list(records)
    expect(entryFor(records, "areas/inbox/new-a.html")?.home).toEqual({
      dir: "resources/newthing",
      to: "resources/newthing/new-a.html",
      kind: "new",
      records: 0,
      score: 3,
      named: ["project:newthing"],
      tagged: [],
      shared: [],
      peers: 3
    })
    expect(entryFor(records, "areas/inbox/pair-a.html")?.home).toBeNull()
    expect(entryFor(records, "areas/inbox/who-a.html")?.home).toBeNull()
    expect(result.inboxHomes).toEqual([{ dir: "resources/newthing", kind: "new", inbox: 3 }])
  })

  it("takes a free filename when the home already holds one by that name", () => {
    const records = [
      record("resources/agentd/timeout.html", { entities: ["project:agentd"] }),
      record("areas/inbox/timeout.html", { entities: ["project:agentd"] }),
      ...filler(10)
    ]
    expect(entryFor(records, "areas/inbox/timeout.html")?.home?.to).toBe(
      "resources/agentd/timeout-2.html"
    )
  })
})

describe("inboxWorkList chooses and orders its records", () => {
  it("excludes tasks, verdicts, the tasks directory, and archived records", () => {
    const records = [
      record("areas/inbox/tasks/do-it.html", { memoryType: "task" }),
      record("areas/inbox/task-row.html", { memoryType: "task" }),
      record("areas/inbox/verdict-row.html", { memoryType: "verdict" }),
      record("archive/2026/areas/inbox/old.html"),
      record("areas/inbox/kept.html"),
      ...filler(10)
    ]
    const result = list(records)
    expect(result.inbox.map((entry) => entry.path)).toEqual(["areas/inbox/kept.html"])
    expect(result.inboxTotal).toBe(1)
    expect(result.inboxWithHome).toBe(0)
  })

  it("lists existing homes first, the fullest first, then new homes, then the rest, capped", () => {
    const homeless = Array.from({ length: BRIEFING_INBOX_CAP }, (_, at) =>
      record(`areas/inbox/homeless-${String(at).padStart(3, "0")}.html`)
    )
    const records = [
      record("resources/big/x.html"),
      record("resources/small/x.html"),
      ...["a", "b"].map((name) =>
        record(`areas/inbox/big-${name}.html`, { entities: ["system:big"] })
      ),
      record("areas/inbox/small-a.html", { entities: ["system:small"] }),
      ...["a", "b", "c"].map((name) =>
        record(`areas/inbox/fresh-${name}.html`, { entities: ["topic:fresh"] })
      ),
      ...homeless
    ]
    const result = list(records)
    expect(result.inbox.slice(0, 7).map((entry) => entry.path)).toEqual([
      "areas/inbox/big-a.html",
      "areas/inbox/big-b.html",
      "areas/inbox/small-a.html",
      "areas/inbox/fresh-a.html",
      "areas/inbox/fresh-b.html",
      "areas/inbox/fresh-c.html",
      "areas/inbox/homeless-000.html"
    ])
    expect(result.inbox).toHaveLength(BRIEFING_INBOX_CAP)
    expect(result.inboxTotal).toBe(BRIEFING_INBOX_CAP + 6)
    expect(result.inboxWithHome).toBe(6)
    expect(result.inboxHomes).toEqual([
      { dir: "resources/fresh", kind: "new", inbox: 3 },
      { dir: "resources/big", kind: "existing", inbox: 2 },
      { dir: "resources/small", kind: "existing", inbox: 1 }
    ])
    // The briefing carries the list as its fifth work list.
    const briefing = briefingFromView(viewOver(records))
    expect(briefing.inbox).toEqual(result.inbox)
    expect(briefing.inboxTotal).toBe(result.inboxTotal)
    expect(briefing.inboxWithHome).toBe(result.inboxWithHome)
  })
})

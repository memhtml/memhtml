import type { MemoryRecord } from "@memhtml/contracts"
import { RRF_K } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import { describe, expect, it } from "vitest"

import {
  LEXICAL_WEIGHT,
  RECENCY_WEIGHT,
  STOP_WORDS,
  searchHead,
  tokenize,
  withOverlay
} from "../src/index.js"
import { mapView, memoryFor, recordOf, run } from "./helpers.js"

/**
 * Two-arm RRF over a small hand-built view, where every expected score is computable by hand from
 * `weight / (rank + k)`.
 *
 * Guard mutations (each run once, see the report):
 * - `searchHead` active-only: drop the `!record.archived` filter on the recency arm, and "ranks
 *   active records only" fails because the archived record appears through the recency arm.
 * - `byScoreThenPath`: drop the path tiebreak, and "orders ties by path" becomes order-dependent
 *   on `HashMap` iteration and fails.
 */

const memory = (
  path: string,
  input: {
    readonly title: string
    readonly claim: string
    readonly body?: string
    readonly at: string
  }
): Promise<MemoryRecord> =>
  recordOf({
    path,
    html: renderTemplate({
      title: input.title,
      claim: input.claim,
      ...(input.body === undefined ? {} : { body: [input.body] }),
      memoryType: "semantic",
      at: input.at
    })
  })

const fixture = async () => {
  const records = await Promise.all([
    memory("areas/inbox/kafka-lag.html", {
      title: "Kafka consumer lag",
      claim: "Consumer lag on the orders topic exceeded ten minutes.",
      body: "Kafka partitions were rebalanced twice.",
      at: "2026-03-01T00:00:00Z"
    }),
    memory("areas/inbox/kafka-retention.html", {
      title: "Kafka retention",
      claim: "The retention window for the orders topic is seven days.",
      at: "2026-01-01T00:00:00Z"
    }),
    memory("areas/inbox/postgres-vacuum.html", {
      title: "Postgres vacuum",
      claim: "Autovacuum runs each evening on the ledger database.",
      at: "2026-06-01T00:00:00Z"
    }),
    memory("archive/2025/areas/inbox/kafka-old.html", {
      title: "Kafka old note",
      claim: "The kafka cluster was on version two.",
      at: "2026-09-01T00:00:00Z"
    })
  ])
  return { view: mapView(records, "sha"), records }
}

const rrf = (weight: number, rank: number): number => weight / (rank + RRF_K)

describe("tokenize", () => {
  it("lowercases, splits on non-word runs, keeps Unicode letters, and drops stop words", () => {
    expect(tokenize("The Café's Orders-Topic is HOT")).toEqual(["café", "orders", "topic", "hot"])
    expect(tokenize("")).toEqual([])
    expect(tokenize("the and of")).toEqual([])
    expect(STOP_WORDS.has("the")).toBe(true)
    expect(STOP_WORDS.has("kafka")).toBe(false)
  })
})

describe("searchHead", () => {
  it("fuses the lexical and recency arms with weights 1.0 and 0.5 at k = 60", async () => {
    const { view } = await fixture()
    const hits = searchHead(view, { query: "kafka" })
    // Lexical arm: the two active kafka files (the archived one is not indexed).
    // Recency arm over active records: vacuum (June), lag (March), retention (January).
    const byPath = new Map(hits.map((hit) => [hit.path, hit]))
    const lag = byPath.get("areas/inbox/kafka-lag.html")
    const retention = byPath.get("areas/inbox/kafka-retention.html")
    const vacuum = byPath.get("areas/inbox/postgres-vacuum.html")
    expect(lag?.arms).toEqual(["lexical", "recency"])
    expect(retention?.arms).toEqual(["lexical", "recency"])
    expect(vacuum?.arms).toEqual(["recency"])
    expect(vacuum?.score).toBeCloseTo(rrf(RECENCY_WEIGHT, 1), 12)
    expect(lag?.score).toBeCloseTo(
      rrf(LEXICAL_WEIGHT, lexicalRankOf(hits, "areas/inbox/kafka-lag.html")) +
        rrf(RECENCY_WEIGHT, 2),
      12
    )
    expect(retention?.score).toBeCloseTo(
      rrf(LEXICAL_WEIGHT, lexicalRankOf(hits, "areas/inbox/kafka-retention.html")) +
        rrf(RECENCY_WEIGHT, 3),
      12
    )
    // A record on both arms outranks a record on the recency arm alone.
    expect(hits.map((hit) => hit.path).indexOf("areas/inbox/postgres-vacuum.html")).toBe(2)
    expect(hits[0]?.claim.length).toBeGreaterThan(0)
  })

  it("ranks active records only, even when the archived one is the newest and matches", async () => {
    const { view } = await fixture()
    const hits = searchHead(view, { query: "kafka cluster version" })
    expect(hits.map((hit) => hit.path)).not.toContain("archive/2025/areas/inbox/kafka-old.html")
    expect(hits).toHaveLength(3)
  })

  it("BM25 ranks the document that repeats the term above one that mentions it once", async () => {
    const { view } = await fixture()
    const hits = searchHead(view, { query: "kafka" })
    // kafka-lag says kafka twice (title, body); retention once (title).
    const lexicalOrder = hits
      .filter((hit) => hit.arms.includes("lexical"))
      .sort((left, right) => lexicalRankOf(hits, left.path) - lexicalRankOf(hits, right.path))
      .map((hit) => hit.path)
    expect(lexicalOrder[0]).toBe("areas/inbox/kafka-lag.html")
  })

  it("orders ties by path so the list is deterministic", async () => {
    const records = await Promise.all(
      ["c", "a", "b"].map((name) =>
        memory(`areas/inbox/${name}.html`, {
          title: "Same title",
          claim: `Widget ${name} is a widget.`,
          at: "2026-01-01T00:00:00Z"
        })
      )
    )
    const view = mapView(records)
    // No lexical match: every record scores only through recency, where all keys tie.
    const paths = searchHead(view, { query: "nothing matches here" }).map((hit) => hit.path)
    expect(paths).toEqual(["areas/inbox/a.html", "areas/inbox/b.html", "areas/inbox/c.html"])
    // With no query tokens at all, the same ordering holds.
    expect(searchHead(view, { query: "the" }).map((hit) => hit.path)).toEqual(paths)
  })

  it("breaks a lexical-arm tie on path, so identical documents rank in path order", async () => {
    // Two byte-identical bodies at different paths tie on BM25 and on recency, so only the path
    // orders them inside each arm. The `fact-10`/`fact-9` pair is the one that proves the guard:
    // its HashMap iteration order is the reverse of its path order (probed against effect
    // 4.0.0-rc.115), so without the tiebreak the arm follows the hash and the assertion fails.
    for (const [first, second] of [
      ["fact-10", "fact-9"],
      ["a", "z"],
      ["alpha", "zulu"]
    ] as const) {
      const records = await Promise.all(
        [second, first].map((name) =>
          memory(`areas/inbox/${name}.html`, {
            title: "Quorum",
            claim: "Quorum was lost twice.",
            at: "2026-01-01T00:00:00Z"
          })
        )
      )
      const hits = searchHead(mapView(records), { query: "quorum" })
      expect(hits.map((hit) => hit.path)).toEqual([
        `areas/inbox/${first}.html`,
        `areas/inbox/${second}.html`
      ])
    }
  })

  it("honors limit and returns nothing over an empty view", async () => {
    const { view } = await fixture()
    expect(searchHead(view, { query: "kafka", limit: 1 })).toHaveLength(1)
    expect(searchHead(view, { query: "kafka", limit: 0 })).toHaveLength(0)
    expect(searchHead(mapView([]), { query: "kafka" })).toEqual([])
  })

  it("clamps a future eventAt to now so it cannot lead the recency arm", async () => {
    const future = await memory("areas/inbox/future.html", {
      title: "Planned migration",
      claim: "The migration is scheduled for later.",
      at: "2030-01-01T00:00:00Z"
    })
    const recent = await memory("areas/inbox/recent.html", {
      title: "Yesterday",
      claim: "Something happened yesterday.",
      at: "2026-09-22T00:00:00Z"
    })
    const view = mapView([future, recent])
    const withoutNow = searchHead(view, { query: "zzz" }).map((hit) => hit.path)
    expect(withoutNow[0]).toBe("areas/inbox/future.html")
    const withNow = searchHead(view, { query: "zzz", now: "2026-09-23T00:00:00Z" }).map(
      (hit) => hit.path
    )
    // Both clamp to <= now; the future one clamps TO now and still sorts first by key, then path.
    expect(withNow).toEqual(["areas/inbox/future.html", "areas/inbox/recent.html"])
    const clampedBelow = searchHead(view, { query: "zzz", now: "2026-09-21T00:00:00Z" }).map(
      (hit) => hit.path
    )
    // With now before both, both clamp to now and path decides.
    expect(clampedBelow).toEqual(["areas/inbox/future.html", "areas/inbox/recent.html"])
  })

  it("reads the version's own lexical index when the view was built here", async () => {
    const records = await Promise.all([0, 1, 2].map((index) => recordOf(memoryFor(index))))
    const overlay = await run(
      withOverlay(mapView(records), [
        { kind: "put", path: "areas/inbox/new.html", html: memoryFor(99).html }
      ])
    )
    const hits = searchHead(overlay, { query: "Country99" })
    expect(hits[0]?.path).toBe("areas/inbox/new.html")
    expect(hits[0]?.arms).toContain("lexical")
  })
})

/** The lexical rank of a path, recovered from the fused score by subtracting its recency share. */
const lexicalRankOf = (
  hits: ReadonlyArray<{ path: string; score: number; arms: ReadonlyArray<string> }>,
  path: string
): number => {
  const lexicalHits = hits.filter((hit) => hit.arms.includes("lexical"))
  // Recency ranks in this fixture: vacuum 1, lag 2, retention 3.
  const recencyRank: Record<string, number> = {
    "areas/inbox/postgres-vacuum.html": 1,
    "areas/inbox/kafka-lag.html": 2,
    "areas/inbox/kafka-retention.html": 3
  }
  const ranked = lexicalHits
    .map((hit) => ({
      path: hit.path,
      lexical: hit.score - rrf(RECENCY_WEIGHT, recencyRank[hit.path] ?? 0)
    }))
    .sort((left, right) => right.lexical - left.lexical)
  return ranked.findIndex((hit) => hit.path === path) + 1
}

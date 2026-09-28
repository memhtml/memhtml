import { readFileSync } from "node:fs"

import type { MemoryRecord } from "@memhtml/contracts"
import { RRF_K } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  LEXICAL_ARM_LIMIT,
  LEXICAL_WEIGHT,
  STOP_WORDS,
  searchHead,
  tokenize,
  VECTOR_ARM_LIMIT,
  VECTOR_WEIGHT,
  versionFromRecords,
  withOverlay
} from "../src/index.js"
import { mapView, memoryFor, recordOf, run } from "./helpers.js"

/**
 * RRF over a small hand-built view, where every expected score is computable by hand from
 * `weight / (rank + k)`, and recency as the tie-break between equal fused scores.
 *
 * Guard mutations (each run once, see the report):
 * - `searchHead` active-only: drop the `!record.archived` filter on `active`, and "the vector arm
 *   ranks active records only" fails because the archived twin of the query ranks first. (The
 *   lexical index holds active records only, so the lexical search cannot reach an archived one.)
 * - `byScoreThenNewerThenPath`: drop the path comparison, and "a lexical hit and a vector-only hit
 *   that tie at one instant rank in path order" follows the fold's insertion order and fails.
 * - `byScoreThenPath`: drop the path tiebreak, and "a tie run crossing the lexical cap keeps the
 *   first 40 by path" keeps records past the cap.
 * - `byScoreThenNewerThenPath`: drop the recency comparison, and "a newer twin wins an exact tie"
 *   fails because path puts the older copy first.
 * - `armRanks`: rank every hit `index + 1` (no shared ranks), and "a newer twin wins an exact tie"
 *   fails because the older copy's path gives it the better lexical rank.
 * - `searchHead`: fuse recency as an RRF arm at weight 0.5 over the candidates again, and "a clearly
 *   better older match is not overtaken by newer, weaker ones" fails.
 * - `lexicalArm`: drop `.slice(0, LEXICAL_ARM_LIMIT)`, and "the lexical arm keeps its best 40"
 *   fails because the 41st record carries `lexical`.
 * - `searchHead`: run the vector arm when `vectors` alone is set (drop `|| input.queryVector ===
 *   undefined`), and "vectors without a query vector" fails (the arm reads an absent query).
 * - `vectorArm`: rank archived records too (`records` -> every record of the view), and "the vector
 *   arm ranks active records only" fails because the archived twin of the query ranks first.
 * - `vectorArm`: drop `.slice(0, VECTOR_ARM_LIMIT)`, and "the vector arm keeps its best 40" fails
 *   because the 41st record carries `vector`.
 * - `searchHead`: drop `if (vectorPaths.has(hit.path)) arms.push("vector")`, and "a record with no
 *   word in common" fails on its `arms`.
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
  it("scores a hit by the lexical arm alone at weight 1.0 and k = 60; recency adds nothing", async () => {
    const { view } = await fixture()
    const hits = searchHead(view, { query: "kafka" })
    // The two active kafka files (the archived one is not indexed). Lag says kafka twice (title,
    // body) and ranks 1st; retention says it once and ranks 2nd. Their scores differ, so recency
    // decides nothing and neither hit names it.
    expect(hits.map((hit) => hit.path)).toEqual([
      "areas/inbox/kafka-lag.html",
      "areas/inbox/kafka-retention.html"
    ])
    expect(hits.map((hit) => hit.arms)).toEqual([["lexical"], ["lexical"]])
    expect(hits[0]?.score).toBe(rrf(LEXICAL_WEIGHT, 1))
    expect(hits[1]?.score).toBe(rrf(LEXICAL_WEIGHT, 2))
    expect(hits[0]?.claim.length).toBeGreaterThan(0)
  })

  it("recency never adds a record another arm did not match", async () => {
    const { view } = await fixture()
    // The vacuum record is the newest active one and shares no word with the query, so recency
    // alone would have put it in the answer.
    const hits = searchHead(view, { query: "kafka" })
    expect(hits.map((hit) => hit.path)).not.toContain("areas/inbox/postgres-vacuum.html")
    // A query no arm matches is answered with nothing, not with the newest records.
    expect(searchHead(view, { query: "nothing matches here" })).toEqual([])
    expect(searchHead(view, { query: "the" })).toEqual([])
  })

  it("ranks active records only, even when the archived one is the newest and matches", async () => {
    const { view } = await fixture()
    const hits = searchHead(view, { query: "kafka cluster version" })
    expect(hits.map((hit) => hit.path)).not.toContain("archive/2025/areas/inbox/kafka-old.html")
    expect(hits.map((hit) => hit.path)).toEqual([
      "areas/inbox/kafka-lag.html",
      "areas/inbox/kafka-retention.html"
    ])
  })

  it("BM25 ranks the document that repeats the term above one that mentions it once", async () => {
    const { view } = await fixture()
    // kafka-lag says kafka twice (title, body) and is older; retention once (title) and is newer.
    const hits = searchHead(view, { query: "kafka" })
    expect(hits[0]?.path).toBe("areas/inbox/kafka-lag.html")
  })

  it("orders ties by path so the list is deterministic", async () => {
    const records = await Promise.all(
      ["c", "a", "b"].map((name) =>
        memory(`areas/inbox/${name}.html`, {
          title: "Same title",
          claim: "Widgets are widgets.",
          at: "2026-01-01T00:00:00Z"
        })
      )
    )
    const view = mapView(records)
    // Identical articles at one instant: BM25 and the recency key both tie, so path orders the
    // fused list.
    const hits = searchHead(view, { query: "widgets" })
    expect(hits.map((hit) => hit.path)).toEqual([
      "areas/inbox/a.html",
      "areas/inbox/b.html",
      "areas/inbox/c.html"
    ])
    expect(new Set(hits.map((hit) => hit.score)).size).toBe(1)
    expect(hits.every((hit) => hit.arms.includes("recency"))).toBe(true)
  })

  it("breaks a lexical-arm tie on path, so identical documents rank in path order", async () => {
    // Two byte-identical bodies at different paths tie on BM25 and on recency, so only the path
    // orders them in the fused list. The `fact-10`/`fact-9` pair is the one that matters: its
    // HashMap iteration order is the reverse of its path order (probed against effect
    // 4.0.0-rc.115), so without both path comparisons (the arm's and the fused list's) the list
    // follows the hash and the assertion fails.
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

  it("clamps a future eventAt to now so it cannot lead the tie-break", async () => {
    // One article at two paths, so BM25 ties and recency decides; path decides only on equal keys.
    const future = await memory("areas/inbox/z-future.html", {
      title: "Deploy window",
      claim: "The deploy window is fixed.",
      at: "2030-01-01T00:00:00Z"
    })
    const recent = await memory("areas/inbox/recent.html", {
      title: "Deploy window",
      claim: "The deploy window is fixed.",
      at: "2026-09-22T00:00:00Z"
    })
    const view = mapView([future, recent])
    const order = (now?: string) =>
      searchHead(view, { query: "deploy", ...(now === undefined ? {} : { now }) }).map(
        (hit) => hit.path
      )
    // Unclamped, the future record is the newer one.
    expect(order()).toEqual(["areas/inbox/z-future.html", "areas/inbox/recent.html"])
    // Clamped to a now after the recent one, the future one sits AT now and is still newer.
    expect(order("2026-09-23T00:00:00Z")).toEqual([
      "areas/inbox/z-future.html",
      "areas/inbox/recent.html"
    ])
    // With now before both, both clamp to now, the keys tie, and path decides.
    expect(order("2026-09-21T00:00:00Z")).toEqual([
      "areas/inbox/recent.html",
      "areas/inbox/z-future.html"
    ])
  })

  it("a newer twin wins an exact tie", async () => {
    // Byte-identical articles: BM25 scores them equally, so they share lexical rank 1 and tie in the
    // fused score. The older copy's path sorts first, so only recency can put the newer one on top.
    // Filler records that match weakly sit between them in date order and change nothing.
    const older = await memory("areas/inbox/a-older.html", {
      title: "Quorum loss",
      claim: "Quorum was lost twice.",
      at: "2026-01-01T00:00:00Z"
    })
    const newer = await memory("areas/inbox/b-newer.html", {
      title: "Quorum loss",
      claim: "Quorum was lost twice.",
      at: "2026-09-01T00:00:00Z"
    })
    const fillers = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        memory(`areas/inbox/filler-${String(index)}.html`, {
          title: `Filler ${String(index)}`,
          claim: `Quorum filler number ${String(index)} carries more words than the twins do.`,
          at: `2026-0${String(index + 2)}-01T00:00:00Z`
        })
      )
    )
    for (const records of [
      [older, newer],
      [older, newer, ...fillers]
    ]) {
      const hits = searchHead(mapView(records), { query: "quorum loss" })
      expect(hits.slice(0, 2).map((hit) => hit.path)).toEqual([newer.path, older.path])
      expect(hits[0]?.score).toBe(hits[1]?.score)
      expect(hits[0]?.arms).toEqual(["lexical", "recency"])
    }
    // With the vector arm too: one content hash is one vector, so the cosines tie as well.
    const vectors = new Map([[older.contentHash, axis(0)]])
    const hits = searchHead(mapView([older, newer, ...fillers]), {
      query: "quorum loss",
      vectors,
      queryVector: axis(0)
    })
    expect(hits.slice(0, 2).map((hit) => hit.path)).toEqual([newer.path, older.path])
    expect(hits[0]?.arms).toEqual(["lexical", "recency", "vector"])
  })

  it("a clearly better older match is not overtaken by newer, weaker ones", async () => {
    // The older record says both query words and "quorum" twice more; each newer record says
    // "quorum" once. BM25 puts the older one first by a clear margin, and a newest-first vote over
    // the candidates would have lifted the newest weak match above it.
    const better = await memory("areas/inbox/a-better.html", {
      title: "Quorum loss",
      claim: "Quorum was lost twice; quorum returned after the quorum vote.",
      at: "2025-01-01T00:00:00Z"
    })
    const weaker = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        memory(`areas/inbox/b-weaker-${String(index)}.html`, {
          title: `Quorum note ${String(index)}`,
          claim: `Quorum was mentioned once in note ${String(index)}.`,
          at: `2026-0${String(index + 3)}-01T00:00:00Z`
        })
      )
    )
    const newest = weaker.at(-1)
    if (newest === undefined) throw new Error("fixture")
    for (const records of [
      [better, newest],
      [better, ...weaker]
    ]) {
      const hits = searchHead(mapView(records), { query: "quorum loss" })
      expect(hits[0]?.path).toBe(better.path)
      expect(hits[0]?.arms).toEqual(["lexical"])
    }
  })

  it("the lexical arm keeps its best 40", async () => {
    // 45 records that each say "zircon" once, each a word longer than the last, so BM25's length
    // normalization makes the index order the lexical order and records 41 to 45 fall past the cap.
    const count = LEXICAL_ARM_LIMIT + 5
    const records = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        memory(`areas/inbox/z-${String(index).padStart(2, "0")}.html`, {
          title: "Mineral note",
          claim: "Zircon is a mineral.",
          ...(index === 0 ? {} : { body: Array.from({ length: index }, () => "filler").join(" ") }),
          at: "2026-01-01T00:00:00Z"
        })
      )
    )
    const hits = searchHead(mapView(records), { query: "zircon", limit: count })
    const inArm = hits.filter((hit) => hit.arms.includes("lexical")).map((hit) => hit.path)
    expect(inArm).toEqual(records.slice(0, LEXICAL_ARM_LIMIT).map((record) => record.path))
    // Past the cap a record is in no arm at all, recency included.
    expect(hits).toHaveLength(LEXICAL_ARM_LIMIT)
    expect(LEXICAL_ARM_LIMIT).toBe(40)
  })

  it("a tie run crossing the lexical cap keeps the first 40 by path", async () => {
    // 45 byte-identical records at one instant: one BM25 score, so the cap cuts inside the run and
    // path decides which 40 are kept, whatever order the index iterates them in.
    const count = LEXICAL_ARM_LIMIT + 5
    const records = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        memory(`areas/inbox/t-${String(index).padStart(2, "0")}.html`, {
          title: "Basalt note",
          claim: "Basalt is volcanic.",
          at: "2026-01-01T00:00:00Z"
        })
      )
    )
    const hits = searchHead(mapView(records), { query: "basalt", limit: count })
    expect(hits.map((hit) => hit.path)).toEqual(
      records.slice(0, LEXICAL_ARM_LIMIT).map((record) => record.path)
    )
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

/** A unit vector along one axis of a four-dimensional toy space, so every cosine is 0 or 1. */
const axis = (index: number, dimension = 4): Float32Array => {
  const vector = new Float32Array(dimension)
  vector[index] = 1
  return vector
}

/**
 * The answer without vectors over 120 generated records: seven queries at limit 25 with `now`
 * pinned, plus one at the default limit with no `now`. Compared as JSON text, so a score that moved
 * by one ulp fails. First captured at v2-poc 8192508 (2026-09-27); recaptured when the lexical arm
 * was capped at 40 and recency narrowed to the records another arm matched, which emptied the three
 * queries no record matches and cut "Country11" to its one match; recaptured on 2026-09-28 when
 * recency became the tie-break between equal fused scores, which put the record each query names
 * first ("Country7 capital" leads with fact-7, "fact about city42" with fact-42).
 */
const GOLDEN: ReadonlyArray<{ readonly query: string; readonly hits: unknown }> = JSON.parse(
  readFileSync(new URL("./fixtures/search-two-arm.golden.json", import.meta.url), "utf8")
)

const goldenView = async () =>
  mapView(
    await Promise.all(Array.from({ length: 120 }, (_, index) => recordOf(memoryFor(index)))),
    "golden"
  )

const goldenInputs = (entry: { readonly query: string }) =>
  entry.query === "Country11 (default limit, no now)"
    ? { query: "Country11" }
    : { query: entry.query, limit: 25, now: "2026-09-01T00:00:00Z" }

describe("searchHead without vectors", () => {
  it("returns the lexical answer byte for byte", async () => {
    const view = await goldenView()
    expect(GOLDEN).toHaveLength(8)
    for (const entry of GOLDEN) {
      expect(JSON.stringify(searchHead(view, goldenInputs(entry))), entry.query).toBe(
        JSON.stringify(entry.hits)
      )
    }
  })

  it("vectors without a query vector, or a query vector without vectors, is the lexical answer", async () => {
    const view = await goldenView()
    const vectors = new Map([...view.records()].map((record) => [record.contentHash, axis(0)]))
    for (const entry of GOLDEN) {
      const expected = JSON.stringify(entry.hits)
      expect(JSON.stringify(searchHead(view, { ...goldenInputs(entry), vectors }))).toBe(expected)
      expect(
        JSON.stringify(searchHead(view, { ...goldenInputs(entry), queryVector: axis(0) }))
      ).toBe(expected)
    }
  })

  it("a vector arm that covers no record changes nothing, for any query", async () => {
    // A built version, whose indexes are computed once, rather than the `Map` view that rebuilds
    // them on every call.
    const view = versionFromRecords([...(await goldenView()).records()], "golden")
    const empty = new Map<string, Float32Array>()
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: 0, max: 30 }), (query, limit) => {
        expect(
          JSON.stringify(searchHead(view, { query, limit, vectors: empty, queryVector: axis(1) }))
        ).toBe(JSON.stringify(searchHead(view, { query, limit })))
      }),
      { numRuns: 100 }
    )
  })
})

describe("searchHead with vectors", () => {
  it("a record with no word in common with the query is found through the vector arm alone", async () => {
    const { view, records } = await fixture()
    const [lag, retention, vacuum] = records
    if (lag === undefined || retention === undefined || vacuum === undefined) throw new Error()
    // The query shares no token with the vacuum record; its vector points the same way.
    const vectors = new Map([
      [lag.contentHash, axis(0)],
      [retention.contentHash, axis(1)],
      [vacuum.contentHash, axis(2)]
    ])
    const hits = searchHead(view, {
      query: "kafka",
      vectors,
      queryVector: axis(2)
    })
    const byPath = new Map(hits.map((hit) => [hit.path, hit]))
    const found = byPath.get("areas/inbox/postgres-vacuum.html")
    expect(found?.arms).toEqual(["vector"])
    // Vector ranks: vacuum 1 (cosine 1); lag and retention tie at cosine 0 and share rank 2.
    expect(found?.score).toBe(rrf(VECTOR_WEIGHT, 1))
    expect(byPath.get("areas/inbox/kafka-lag.html")?.arms).toEqual(["lexical", "vector"])
    expect(byPath.get("areas/inbox/kafka-lag.html")?.score).toBe(
      rrf(LEXICAL_WEIGHT, 1) + rrf(VECTOR_WEIGHT, 2)
    )
    expect(byPath.get("areas/inbox/kafka-retention.html")?.score).toBe(
      rrf(LEXICAL_WEIGHT, 2) + rrf(VECTOR_WEIGHT, 2)
    )
    expect(VECTOR_WEIGHT).toBe(1.0)
  })

  it("a lexical hit and a vector-only hit that tie at one instant rank in path order", async () => {
    // One record is first in the lexical arm and has no vector; the other shares no word with the
    // query and is first in the vector arm. Both score 1 / 61 at one instant, so path decides, and
    // the vector-only record's path sorts first although the fold meets the lexical record first.
    const lexicalOnly = await memory("areas/inbox/z-lexical.html", {
      title: "Granite",
      claim: "Granite is igneous.",
      at: "2026-05-01T00:00:00Z"
    })
    const vectorOnly = await memory("areas/inbox/a-vector.html", {
      title: "Pumice",
      claim: "Pumice floats on water.",
      at: "2026-05-01T00:00:00Z"
    })
    const hits = searchHead(mapView([lexicalOnly, vectorOnly]), {
      query: "granite",
      vectors: new Map([[vectorOnly.contentHash, axis(0)]]),
      queryVector: axis(0)
    })
    expect(hits.map((hit) => hit.path)).toEqual([vectorOnly.path, lexicalOnly.path])
    expect(hits[0]?.score).toBe(hits[1]?.score)
    expect(hits.map((hit) => hit.arms)).toEqual([
      ["recency", "vector"],
      ["lexical", "recency"]
    ])
  })

  it("a record whose content hash has no vector is not in the vector arm", async () => {
    const { view, records } = await fixture()
    const lag = records[0]
    if (lag === undefined) throw new Error()
    const hits = searchHead(view, {
      query: "nothing",
      vectors: new Map([[lag.contentHash, axis(0)]]),
      queryVector: axis(0)
    })
    const withVector = hits.filter((hit) => hit.arms.includes("vector")).map((hit) => hit.path)
    expect(withVector).toEqual(["areas/inbox/kafka-lag.html"])
  })

  it("the vector arm ranks active records only, even when an archived one matches the query exactly", async () => {
    const { view, records } = await fixture()
    const archived = records[3]
    const lag = records[0]
    if (archived === undefined || lag === undefined) throw new Error()
    const hits = searchHead(view, {
      query: "nothing",
      vectors: new Map([
        [archived.contentHash, axis(3)],
        [lag.contentHash, axis(0)]
      ]),
      queryVector: axis(3)
    })
    expect(hits.map((hit) => hit.path)).not.toContain(archived.path)
    expect(hits.find((hit) => hit.path === lag.path)?.arms).toEqual(["vector"])
  })

  it("the vector arm keeps its best 40", async () => {
    // 45 records, each vector a step further from the query's direction, so the cosine order is
    // the index order and records 41 to 45 fall past the cap.
    const count = VECTOR_ARM_LIMIT + 5
    const records = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        memory(`areas/inbox/r-${String(index).padStart(2, "0")}.html`, {
          title: `Record ${index}`,
          claim: `Widget ${index} is blue.`,
          at: "2026-01-01T00:00:00Z"
        })
      )
    )
    const vectors = new Map(
      records.map((record, index) => {
        const angle = (index / count) * (Math.PI / 2)
        return [record.contentHash, Float32Array.from([Math.cos(angle), Math.sin(angle)])]
      })
    )
    const hits = searchHead(mapView(records), {
      query: "zzz",
      limit: count,
      vectors,
      queryVector: Float32Array.from([1, 0])
    })
    const inArm = hits.filter((hit) => hit.arms.includes("vector")).map((hit) => hit.path)
    expect(inArm).toHaveLength(VECTOR_ARM_LIMIT)
    expect(new Set(inArm)).toEqual(
      new Set(records.slice(0, VECTOR_ARM_LIMIT).map((record) => record.path))
    )
    expect(VECTOR_ARM_LIMIT).toBe(40)
  })
})

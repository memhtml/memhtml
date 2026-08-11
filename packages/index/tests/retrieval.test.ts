import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DatabaseShape } from "../src/database.js"
import { makeIndexer } from "../src/indexer.js"
import { DEFAULT_ARM_LIMIT, makeRetrieval, type RetrievalShape } from "../src/retrieval.js"
import { buildRrfSql, RANK_ARMS } from "../src/retrieval-sql.js"
import { SNIPPET_MAX_CHARS } from "../src/schema-const.js"
import { assembleScope } from "../src/scope.js"
import { type FixtureRepo, makeFixtureRepo, type SeedFile } from "./fixture-repo.js"
import {
  type FakeEmbedder,
  failingEmbedder,
  makeFakeEmbedder,
  memoryHtml,
  withDb,
  withDbNoState
} from "./harness.js"

/**
 * Retrieval end to end: a real repo indexed into a real database, then queried through the assembled
 * four-arm statement.
 *
 * The corpus is built so the ranking assertions are about the RANKING and not about the corpus being
 * trivially small: a target, a lexical near-miss, a vocabulary-sharing neighbour, and a set of
 * unrelated filler entries the arms must rank below all of them.
 */

const AT = "2026-08-01T12:00:00Z"

const corpus = (): ReadonlyArray<SeedFile> => [
  {
    path: "areas/oncall/vip-drain-before-rollback.html",
    html: memoryHtml({
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "If a prod rollback is issued, drain the VIP before reverting the deploy.",
      body: "The revert alone leaves in-flight connections pinned to the old target group.",
      memoryType: "procedural",
      tags: ["deploy", "oncall"],
      entities: ["service:checkout-api"],
      updatedAt: "2026-07-20T00:00:00Z",
      eventAt: "2026-07-28"
    })
  },
  {
    path: "areas/oncall/vip-drain-not-needed.html",
    html: memoryHtml({
      title: "Managed platforms drain the VIP automatically",
      claim:
        "On a managed platform the VIP drain is automatic and the rollback needs no drain step.",
      memoryType: "semantic",
      tags: ["deploy"],
      entities: ["service:checkout-api"],
      updatedAt: "2026-07-21T00:00:00Z"
    })
  },
  {
    path: "projects/memhtml/turso-fts.html",
    html: memoryHtml({
      title: "Turso FTS exposes no bm25",
      claim: "Turso returns MATCH rows already ordered by relevance and exposes no rank column.",
      memoryType: "error_pattern",
      tags: ["turso"],
      entities: ["service:turso"],
      updatedAt: "2026-07-31T00:00:00Z"
    })
  },
  {
    path: "areas/arcs/reversibility-first.html",
    html: memoryHtml({
      title: "Reversibility first",
      claim: "Prefer the rollback you can undo over the deploy you can explain.",
      memoryType: "arc",
      tags: ["arc"],
      details: {
        summary: "Where this arc came from",
        body: "Synthesized from eleven oncall entries."
      },
      aside: "Not a rule for one-way migrations.",
      facets: [{ name: "Applies to", value: "every deploy decision" }],
      updatedAt: "2026-07-25T00:00:00Z"
    })
  },
  {
    /**
     * An open task sharing the target's whole vocabulary, so the default exclusion is tested
     * against a row every arm WOULD rank highly. A task on an unrelated topic would sit below the
     * result window regardless and the assertion would pass against no exclusion at all.
     */
    path: "areas/inbox/tasks/drain-the-vip-in-the-runbook.html",
    html: memoryHtml({
      title: "Write the VIP drain step into the rollback runbook",
      claim: "The rollback runbook still omits the VIP drain step before reverting the deploy.",
      body: "In-flight connections stay pinned to the old target group without it.",
      memoryType: "task",
      taskStatus: "doing",
      dueAt: "2026-08-09",
      tags: ["deploy", "oncall"],
      entities: ["service:checkout-api"],
      updatedAt: "2026-08-01T00:00:00Z"
    })
  },
  ...Array.from({ length: 12 }, (_, offset): SeedFile => {
    const index = offset + 1
    return {
      path: `resources/misc/filler-${String(index).padStart(2, "0")}.html`,
      html: memoryHtml({
        title: `Filler ${index}`,
        claim: `An unrelated claim about okapi and wildebeest number ${index}.`,
        memoryType: "episodic",
        tags: ["filler"],
        updatedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00Z`
      })
    }
  })
]

interface Rig {
  readonly db: DatabaseShape
  readonly retrieval: RetrievalShape
}

const indexInto = (db: DatabaseShape, repo: FixtureRepo, embedder: FakeEmbedder) =>
  makeIndexer({
    db,
    git: repo.git,
    embedWatermark: EMBED_WATERMARK,
    embedDim: EMBED_DIM,
    embeddings: embedder,
    now: () => AT
  }).rebuild({ embed: true })

/** Index the corpus, then run the body against a retrieval built on the same connection. */
const withIndexed = <A>(
  repo: FixtureRepo,
  body: (rig: Rig) => Effect.Effect<A, unknown>,
  options: {
    readonly indexEmbedder?: FakeEmbedder
    readonly queryEmbedder?: FakeEmbedder | null
    readonly state?: boolean
  } = {}
): Promise<A> => {
  const run = options.state === false ? withDbNoState : withDb
  return run((db) =>
    Effect.gen(function* () {
      yield* indexInto(db, repo, options.indexEmbedder ?? makeFakeEmbedder())
      const queryEmbedder =
        options.queryEmbedder === null ? undefined : (options.queryEmbedder ?? makeFakeEmbedder())
      return yield* body({
        db,
        retrieval: makeRetrieval(
          queryEmbedder === undefined ? { db } : { db, embeddings: queryEmbedder }
        )
      })
    })
  ) as Promise<A>
}

describe("search", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(corpus(), "seed the corpus")
  })

  afterEach(() => repo.cleanup())

  it("fires all four arms and returns fused hits", async () => {
    const result = await withIndexed(repo, ({ retrieval }) =>
      retrieval.search({ query: "drain the VIP before reverting the deploy" })
    )
    expect(result.arms).toEqual(["fts", "vector", "recency", "salience"])
    expect(result.degraded).toBe(false)
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.map((hit) => hit.path)).toContain(
      "areas/oncall/vip-drain-before-rollback.html"
    )
  })

  it("ranks a lexically and semantically matching memory above unrelated filler", async () => {
    const result = await withIndexed(repo, ({ retrieval }) =>
      retrieval.search({ query: "drain the VIP before reverting the deploy", limit: 6 })
    )
    const target = result.hits.findIndex(
      (hit) => hit.path === "areas/oncall/vip-drain-before-rollback.html"
    )
    const firstFiller = result.hits.findIndex((hit) => hit.path.includes("filler-"))
    expect(target).toBeGreaterThanOrEqual(0)
    if (firstFiller >= 0) expect(target).toBeLessThan(firstFiller)
  })

  it("returns hits carrying the fields the tool contract names", async () => {
    const hit = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({ query: "turso relevance rank column" })
        return result.hits.find((candidate) => candidate.path === "projects/memhtml/turso-fts.html")
      })
    )
    expect(hit).toBeDefined()
    expect(hit?.title).toBe("Turso FTS exposes no bm25")
    expect(hit?.memoryType).toBe("error_pattern")
    expect(hit?.gist).toContain("MATCH rows already ordered by relevance")
    expect(hit?.updatedAt).toBe("2026-07-31T00:00:00Z")
    expect(hit?.confidence).toBe(1)
  })

  it("carries the matched file's chunk text as the snippet on every hit", async () => {
    const result = await withIndexed(repo, ({ retrieval }) =>
      retrieval.search({ query: "drain the VIP before reverting the deploy" })
    )
    const target = result.hits.find(
      (hit) => hit.path === "areas/oncall/vip-drain-before-rollback.html"
    )
    expect(target).toBeDefined()
    // One-chunk file (the common case): the snippet IS the article text, so it carries both the
    // claim and the body prose the gist alone would drop.
    expect(target?.snippet).toContain("drain the VIP before reverting the deploy")
    expect(target?.snippet).toContain("in-flight connections pinned to the old target group")
    for (const hit of result.hits) expect(hit.snippet).not.toBe("")
  })

  it("selects the vector arm's winning chunk from a multi-chunk file", async () => {
    /**
     * A file long enough to split: chunk 0 is filler vocabulary, the tail chunk holds the query's
     * whole vocabulary. The snippet must be the TAIL's text — the chunk that actually matched —
     * not the file's opening, or the field is a preview rather than an explanation.
     */
    /**
     * Sized so the split leaves a SHORT tail chunk: ~1.9k chars of filler packs chunk 0 to the
     * 1,800 ceiling and spills only a couple of sentences into chunk 1 alongside the target text —
     * which keeps the winning chunk under the snippet ceiling, so no truncation can cut the
     * assertion target out of its own snippet.
     */
    const filler = Array.from(
      { length: 28 },
      (_, at) => `Unrelated filler sentence about pangolins and aardvarks number ${at}.`
    ).join(" ")
    const tail =
      "The quorum breaker trips when the zeppelin manifest drifts from the ratified ledger."
    await repo.commit(
      [
        {
          path: "areas/oncall/long-quorum-note.html",
          html: memoryHtml({
            title: "Quorum breaker behaviour",
            claim: "The quorum breaker is documented here.",
            body: `${filler} ${tail}`,
            memoryType: "semantic",
            updatedAt: "2026-07-30T00:00:00Z"
          })
        }
      ],
      "seed the long memory"
    )

    const hit = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({
          query: "quorum breaker zeppelin manifest ratified ledger",
          limit: 5
        })
        return result.hits.find(
          (candidate) => candidate.path === "areas/oncall/long-quorum-note.html"
        )
      })
    )
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain("zeppelin manifest drifts from the ratified ledger")
    expect(hit?.snippet).not.toContain("pangolins and aardvarks number 0")
  })

  it("truncates an oversized winning chunk to the snippet ceiling with a … marker", async () => {
    // One chunk (under CHUNK_MAX_CHARS) but over SNIPPET_MAX_CHARS, so the cut is the snippet's own.
    const longBody = Array.from(
      { length: 15 },
      (_, at) => `The marmoset registry replicates through the gossip tier, round ${at}.`
    ).join(" ")
    await repo.commit(
      [
        {
          path: "areas/oncall/marmoset-registry.html",
          html: memoryHtml({
            title: "Marmoset registry replication",
            claim: "The marmoset registry replicates through the gossip tier.",
            body: longBody,
            memoryType: "semantic",
            updatedAt: "2026-07-30T00:00:00Z"
          })
        }
      ],
      "seed the oversized memory"
    )

    const hit = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({
          query: "marmoset registry gossip tier replication"
        })
        return result.hits.find(
          (candidate) => candidate.path === "areas/oncall/marmoset-registry.html"
        )
      })
    )
    expect(hit).toBeDefined()
    expect(hit?.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS)
    expect(hit?.snippet.endsWith("…")).toBe(true)
  })

  it("falls back to the opening chunk's text as the snippet on the degraded path", async () => {
    const result = await withIndexed(
      repo,
      ({ retrieval }) => retrieval.search({ query: "drain the VIP before reverting the deploy" }),
      { queryEmbedder: failingEmbedder() }
    )
    expect(result.degraded).toBe(true)
    const target = result.hits.find(
      (hit) => hit.path === "areas/oncall/vip-drain-before-rollback.html"
    )
    expect(target).toBeDefined()
    // No query vector, so "best chunk" is undefined — the file's ordinal-0 text stands in, which
    // for a one-chunk file is the same article text the vector path would have chosen.
    expect(target?.snippet).toContain("drain the VIP before reverting the deploy")
  })

  it("honours the limit", async () => {
    const result = await withIndexed(repo, ({ retrieval }) =>
      retrieval.search({ query: "deploy rollback drain", limit: 3 })
    )
    expect(result.hits.length).toBeLessThanOrEqual(3)
  })

  it("degrades to the lexical floor when the embedder fails, with no error and no vector arm", async () => {
    const result = await withIndexed(
      repo,
      ({ retrieval }) => retrieval.search({ query: "drain the VIP before reverting the deploy" }),
      { queryEmbedder: failingEmbedder() }
    )
    // Retrieval never errors because Bedrock is down; it gets narrower, and it says so.
    expect(result.degraded).toBe(true)
    expect(result.arms).toEqual(["fts", "recency", "salience"])
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.map((hit) => hit.path)).toContain(
      "areas/oncall/vip-drain-before-rollback.html"
    )
  })

  it("drops the salience arm when no state plane is attached", async () => {
    const result = await withIndexed(
      repo,
      ({ retrieval }) => retrieval.search({ query: "drain the VIP" }),
      { state: false }
    )
    expect(result.arms).toEqual(["fts", "vector", "recency"])
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it("excludes archived memories by default and includes them when asked", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* indexInto(db, repo, makeFakeEmbedder())
        yield* Effect.promise(() =>
          repo.move(
            "areas/oncall/vip-drain-not-needed.html",
            "archive/2026/areas/oncall/vip-drain-not-needed.html",
            "archive it"
          )
        )
        const indexer = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: makeFakeEmbedder(),
          now: () => AT
        })
        yield* indexer.update({ embed: true })

        const retrieval = makeRetrieval({ db, embeddings: makeFakeEmbedder() })
        const active = yield* retrieval.search({ query: "managed platform automatic drain" })
        const all = yield* retrieval.search({
          query: "managed platform automatic drain",
          includeArchived: true
        })
        return { active: active.hits.map((hit) => hit.path), all: all.hits.map((hit) => hit.path) }
      })
    )
    expect(outcome.active).not.toContain("archive/2026/areas/oncall/vip-drain-not-needed.html")
    expect(outcome.all).toContain("archive/2026/areas/oncall/vip-drain-not-needed.html")
  })

  it("excludes an open task from an unscoped search that would otherwise rank it high", async () => {
    /**
     * The task in the corpus shares the target's whole vocabulary, so every arm would rank it — a
     * task on an unrelated topic would sit below the window anyway and this assertion would pass
     * against no exclusion at all. Asserted at the DATABASE, through the assembled four-arm
     * statement, not against the SQL string.
     */
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const query = "drain the VIP before reverting the deploy"
        const unscoped = yield* retrieval.search({ query, limit: 20 })
        const optedIn = yield* retrieval.search({ query, memoryTypes: ["task"], limit: 20 })
        const alongside = yield* retrieval.search({
          query,
          memoryTypes: ["task", "procedural"],
          limit: 20
        })
        return {
          unscoped: unscoped.hits.map((hit) => hit.path),
          optedIn: optedIn.hits.map((hit) => hit.path),
          alongside: alongside.hits.map((hit) => hit.path)
        }
      })
    )

    const task = "areas/inbox/tasks/drain-the-vip-in-the-runbook.html"
    expect(outcome.unscoped).not.toContain(task)
    // The memory it competes with IS returned, so the exclusion is type-scoped rather than the
    // whole query failing to match.
    expect(outcome.unscoped).toContain("areas/oncall/vip-drain-before-rollback.html")
    // Naming the type opts in, which is what keeps the default a default and not a firewall.
    expect(outcome.optedIn).toEqual([task])
    expect(outcome.alongside).toContain(task)
    expect(outcome.alongside).toContain("areas/oncall/vip-drain-before-rollback.html")
  })

  it("keeps a DONE task out of an includeArchived search as well", async () => {
    /**
     * The contaminating state a status filter alone would miss: finishing a task archives it, so a
     * caller widening the STATUS axis would start seeing every task ever completed. The two axes
     * are independent and the type exclusion holds across both.
     */
    const paths = await withDb((db) =>
      Effect.gen(function* () {
        yield* indexInto(db, repo, makeFakeEmbedder())
        yield* Effect.promise(() =>
          repo.move(
            "areas/inbox/tasks/drain-the-vip-in-the-runbook.html",
            "archive/2026/areas/inbox/tasks/drain-the-vip-in-the-runbook.html",
            "task done"
          )
        )
        yield* makeIndexer({
          db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: makeFakeEmbedder(),
          now: () => AT
        }).update({ embed: true })

        const result = yield* makeRetrieval({ db, embeddings: makeFakeEmbedder() }).search({
          query: "drain the VIP before reverting the deploy",
          includeArchived: true,
          limit: 20
        })
        return result.hits.map((hit) => hit.path)
      })
    )
    expect(paths.some((path) => path.includes("/tasks/"))).toBe(false)
    expect(paths).toContain("areas/oncall/vip-drain-before-rollback.html")
  })

  it("answers an as-of query with what was believed THEN, marked superseded, and today's answer otherwise", async () => {
    /**
     * The bi-temporal end-to-end: fact A (event time 2023-06-01) superseded by fact B (valid from
     * 2025-02-01), seeded as the exact tree a supersede leaves — the loser archived with
     * `memhtml-valid-until` == the winner's valid-from, the winner carrying `memhtml-valid-from`
     * and a `supersedes` link toward the loser's ARCHIVE path. A's window is read through the
     * coalesce's MIDDLE rung (its `<time datetime>`, no explicit valid-from), which is the rung a
     * memory written before this feature existed would use.
     */
    const aArchive = "archive/2026/areas/limits/pool-ceiling.html"
    await repo.commit(
      [
        {
          path: aArchive,
          html: memoryHtml({
            title: "The pool ceiling",
            claim: "The connection pool ceiling for the checkout database is 64 sockets.",
            memoryType: "semantic",
            status: "archived",
            createdAt: "2023-06-02T00:00:00Z",
            eventAt: "2023-06-01T00:00:00Z",
            validUntil: "2025-02-01T00:00:00Z",
            archivedAt: "2025-02-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z"
          })
        },
        {
          path: "areas/limits/pool-ceiling-raised.html",
          html: memoryHtml({
            title: "The pool ceiling, raised",
            claim: "The connection pool ceiling for the checkout database is 128 sockets.",
            memoryType: "semantic",
            createdAt: "2025-02-01T00:00:00Z",
            validFrom: "2025-02-01T00:00:00Z",
            links: [{ rel: "memhtml-supersedes", href: `/${aArchive}` }]
          })
        }
      ],
      "seed the superseded pair"
    )

    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const query = "checkout database connection pool ceiling sockets"
        const then = yield* retrieval.search({ query, asOf: "2024-01-01T00:00:00Z", limit: 20 })
        const now = yield* retrieval.search({ query, limit: 20 })
        const later = yield* retrieval.search({ query, asOf: "2026-01-01T00:00:00Z", limit: 20 })
        return { then, now, later }
      })
    )

    const thenPaths = outcome.then.hits.map((hit) => hit.path)
    // As of 2024: A was the belief — B's window has not opened, so B must be ABSENT, not merely
    // ranked lower; a not-yet-valid fact leaking into the past is the defect the lens exists for.
    expect(thenPaths).toContain(aArchive)
    expect(thenPaths).not.toContain("areas/limits/pool-ceiling-raised.html")
    // The superseded marker: the hit says what replaced it, so the answer is legible as history.
    const aHit = outcome.then.hits.find((hit) => hit.path === aArchive)
    expect(aHit?.supersededBy).toBe("areas/limits/pool-ceiling-raised.html")

    // No as_of: the present. B active, A archived and invisible, marker null on live hits.
    const nowPaths = outcome.now.hits.map((hit) => hit.path)
    expect(nowPaths).toContain("areas/limits/pool-ceiling-raised.html")
    expect(nowPaths).not.toContain(aArchive)
    for (const hit of outcome.now.hits) expect(hit.supersededBy).toBeNull()

    // As of 2026: B's window is open and A's is closed — same answer as the present, reached
    // through the window predicate rather than the archived flag.
    const laterPaths = outcome.later.hits.map((hit) => hit.path)
    expect(laterPaths).toContain("areas/limits/pool-ceiling-raised.html")
    expect(laterPaths).not.toContain(aArchive)
  })

  it("probes each window of an A→B→C supersede chain", async () => {
    // Three statements of one slot, each window closing where the next opens. One probe per
    // window proves the lens picks exactly one link of the chain at any instant.
    const aArchive = "archive/2026/areas/limits/quota-v1.html"
    const bArchive = "archive/2026/areas/limits/quota-v2.html"
    await repo.commit(
      [
        {
          path: aArchive,
          html: memoryHtml({
            title: "The tenant quota",
            claim: "The tenant quota for burst traffic is 10 requests per second.",
            memoryType: "semantic",
            status: "archived",
            createdAt: "2023-01-01T00:00:00Z",
            validFrom: "2023-01-01T00:00:00Z",
            validUntil: "2024-06-01T00:00:00Z",
            archivedAt: "2024-06-01T00:00:00Z"
          })
        },
        {
          path: bArchive,
          html: memoryHtml({
            title: "The tenant quota, revised",
            claim: "The tenant quota for burst traffic is 50 requests per second.",
            memoryType: "semantic",
            status: "archived",
            createdAt: "2024-06-01T00:00:00Z",
            validFrom: "2024-06-01T00:00:00Z",
            validUntil: "2026-02-01T00:00:00Z",
            archivedAt: "2026-02-01T00:00:00Z",
            links: [{ rel: "memhtml-supersedes", href: `/${aArchive}` }]
          })
        },
        {
          path: "areas/limits/quota-v3.html",
          html: memoryHtml({
            title: "The tenant quota, current",
            claim: "The tenant quota for burst traffic is 200 requests per second.",
            memoryType: "semantic",
            createdAt: "2026-02-01T00:00:00Z",
            validFrom: "2026-02-01T00:00:00Z",
            links: [{ rel: "memhtml-supersedes", href: `/${bArchive}` }]
          })
        }
      ],
      "seed the chain"
    )

    const windows = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const query = "tenant quota burst traffic requests per second"
        const probe = (asOf: string) =>
          Effect.map(retrieval.search({ query, asOf, limit: 20 }), (result) =>
            result.hits.flatMap((hit) =>
              hit.path.includes("quota") ? [{ path: hit.path, supersededBy: hit.supersededBy }] : []
            )
          )
        return {
          a: yield* probe("2023-07-01T00:00:00Z"),
          b: yield* probe("2025-01-01T00:00:00Z"),
          c: yield* probe("2026-06-01T00:00:00Z")
        }
      })
    )

    expect(windows.a.map((hit) => hit.path)).toEqual([aArchive])
    expect(windows.a[0]?.supersededBy).toBe(bArchive)
    expect(windows.b.map((hit) => hit.path)).toEqual([bArchive])
    expect(windows.b[0]?.supersededBy).toBe("areas/limits/quota-v3.html")
    expect(windows.c.map((hit) => hit.path)).toEqual(["areas/limits/quota-v3.html"])
    expect(windows.c[0]?.supersededBy).toBeNull()
  })

  it("restricts to the named memory types", async () => {
    const paths = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({
          query: "deploy rollback drain",
          memoryTypes: ["arc"]
        })
        return result.hits.map((hit) => hit.path)
      })
    )
    expect(paths).toEqual(["areas/arcs/reversibility-first.html"])
  })

  it("makes a workspace scope strict: it never returns a NULL-workspace page", async () => {
    const paths = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({ query: "turso relevance", workspace: "memhtml" })
        return result.hits.map((hit) => hit.path)
      })
    )
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(path.startsWith("projects/memhtml/")).toBe(true)
  })

  it("broadens on each additional tag", async () => {
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const narrow = yield* retrieval.search({ query: "drain deploy rollback", tags: ["oncall"] })
        const broad = yield* retrieval.search({
          query: "drain deploy rollback",
          tags: ["oncall", "turso"]
        })
        return {
          narrow: narrow.hits.map((hit) => hit.path),
          broad: broad.hits.map((hit) => hit.path)
        }
      })
    )
    // ANY-of overlap: adding a tag can only add candidates.
    expect(outcome.narrow.every((path) => outcome.broad.includes(path))).toBe(true)
    expect(outcome.broad.length).toBeGreaterThan(outcome.narrow.length)
  })

  /**
   * The entity scope, at the database, through the assembled four-arm statement.
   *
   * Every case here runs over input that WOULD light up: the memory the scope excludes is a strong
   * candidate for the same query, seeded and asserted PRESENT in the unscoped half of the same
   * fixture. A scope tested against a corpus where the excluded row was below the window anyway would
   * pass against no predicate at all — which is how this repo shipped a hardcoded flag through forty
   * green tests once already.
   */
  const RIVAL = "areas/oncall/payments-vip-drain.html"

  /** A second memory with the SAME vocabulary and a DIFFERENT entity. The row a scope must exclude. */
  const seedRival = () =>
    repo.commit(
      [
        {
          path: RIVAL,
          html: memoryHtml({
            title: "Payments rollbacks drain the VIP before reverting the deploy",
            claim: "If a payments rollback is issued, drain the VIP before reverting the deploy.",
            body: "The revert alone leaves in-flight connections pinned to the old target group.",
            memoryType: "procedural",
            tags: ["deploy", "oncall"],
            entities: ["service:payments-api"],
            updatedAt: "2026-07-24T00:00:00Z"
          })
        }
      ],
      "seed the rival service"
    )

  it("restricts to memories carrying the named entity, over a corpus where the excluded row ranks", async () => {
    const target = "areas/oncall/vip-drain-before-rollback.html"
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedRival)
        yield* indexInto(db, repo, makeFakeEmbedder())
        const retrieval = makeRetrieval({ db, embeddings: makeFakeEmbedder() })
        const query = "drain the VIP before reverting the deploy"
        const unscoped = yield* retrieval.search({ query, limit: 20 })
        const scoped = yield* retrieval.search({
          query,
          entity: "service:checkout-api",
          limit: 20
        })
        return {
          unscoped: unscoped.hits.map((hit) => hit.path),
          scoped: scoped.hits.map((hit) => hit.path),
          scopeEmpty: scoped.scopeEmpty,
          entityScope: scoped.entityScope
        }
      })
    )

    /**
     * The flag-on half FIRST: the rival is in the unscoped result for this very query, so the
     * exclusion below is a statement about the predicate rather than about the corpus.
     */
    expect(outcome.unscoped).toContain(RIVAL)
    expect(outcome.unscoped).toContain(target)
    // Scoped: the rival is gone, the target stays, and everything returned carries the entity.
    expect(outcome.scoped).not.toContain(RIVAL)
    expect(outcome.scoped).toContain(target)
    expect(outcome.scoped).toContain("areas/oncall/vip-drain-not-needed.html")
    // Nothing WITHOUT the entity survived: the filler entries rank on recency in the unscoped half
    // and carry no entity at all, so their absence here is the predicate reaching every arm.
    expect(outcome.scoped.some((path) => path.includes("filler-"))).toBe(false)
    expect(outcome.scopeEmpty).toBe(false)
    expect(outcome.entityScope).toBe("service:checkout-api")
  })

  it("carries every hit's entities in type:name form, sorted, empty array when it has none", async () => {
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({ query: "drain the VIP deploy", limit: 20 })
        return new Map(result.hits.map((hit) => [hit.path, hit.entities]))
      })
    )
    /**
     * The `type:` prefix is the contract, not decoration: `entity_names` — the column the recall fold
     * reads — carries the BARE name, so a hit reusing that projection would publish `checkout-api`
     * and the next hop's scope would match nothing.
     */
    expect(outcome.get("areas/oncall/vip-drain-before-rollback.html")).toEqual([
      "service:checkout-api"
    ])
    expect(outcome.get("projects/memhtml/turso-fts.html")).toEqual(["service:turso"])
    // Empty array rather than absent or null: a caller reading an absent key cannot tell "no
    // entities" from "this server does not report them".
    const filler = [...outcome].find(([path]) => path.includes("filler-"))
    expect(filler).toBeDefined()
    expect(filler?.[1]).toEqual([])
  })

  it("resolves a two-hop chain: a value read off one hit's entities scopes the next call", async () => {
    /**
     * HOP-2 made possible, demonstrated as the two calls it claims. Nothing here reconstructs a
     * reference — hop two passes hop one's own string VERBATIM, which is the whole reason the hit
     * publishes `type:name` rather than a name.
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedRival)
        yield* indexInto(db, repo, makeFakeEmbedder())
        const retrieval = makeRetrieval({ db, embeddings: makeFakeEmbedder() })

        const first = yield* retrieval.search({
          query: "payments rollback drain the VIP",
          limit: 20
        })
        const seed = first.hits.find((hit) => hit.path === RIVAL)
        const reference = seed?.entities[0]
        if (reference === undefined) throw new Error("hop one published no entity to chain on")

        const second = yield* retrieval.search({
          query: "drain the VIP before reverting the deploy",
          entity: reference,
          limit: 20
        })
        return {
          reference,
          first: first.hits.map((hit) => hit.path),
          second: second.hits.map((hit) => hit.path),
          entityScope: second.entityScope
        }
      })
    )

    expect(outcome.reference).toBe("service:payments-api")
    // Hop two NARROWS: the first call's result held both services' memories, the second holds only
    // the one the reference names.
    expect(outcome.first).toContain("areas/oncall/vip-drain-before-rollback.html")
    expect(outcome.second).toEqual([RIVAL])
    expect(outcome.entityScope).toBe(outcome.reference)
  })

  it("returns a VISIBLY empty result for an entity no memory carries, and never widens", async () => {
    /**
     * HOP-3. The requirement is attributable emptiness, so both halves are asserted: nothing comes
     * back, AND the response says which scope emptied it. The same query unscoped returns hits over
     * the same fixture, which is what makes "no hits" a fact about the scope rather than about the
     * corpus or the query.
     */
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const query = "drain the VIP before reverting the deploy"
        const missing = yield* retrieval.search({ query, entity: "service:nonexistent", limit: 20 })
        const unscoped = yield* retrieval.search({ query, limit: 20 })
        return {
          missing: missing.hits.map((hit) => hit.path),
          scopeEmpty: missing.scopeEmpty,
          entityScope: missing.entityScope,
          arms: missing.arms,
          degraded: missing.degraded,
          unscoped: unscoped.hits.length
        }
      })
    )

    expect(outcome.missing).toEqual([])
    // Not silently widened: the unscoped result over the SAME fixture is non-empty, so a fallback
    // would have had plenty to fall back to.
    expect(outcome.unscoped).toBeGreaterThan(0)
    // Attributable: the caller can tell an over-narrow scope from an empty corpus without guessing.
    expect(outcome.scopeEmpty).toBe(true)
    expect(outcome.entityScope).toBe("service:nonexistent")
    // Still a well-formed response rather than a degraded or errored one — the arms fired, they just
    // had no candidates.
    expect(outcome.degraded).toBe(false)
    expect(outcome.arms).toEqual(["fts", "vector", "recency", "salience"])
  })

  it("does not claim scopeEmpty when a scope returned hits", async () => {
    // The trivial direction, and the marker would be worse than useless without it: a caller told
    // their scope emptied a result that has ten hits in it would go re-run the query wider.
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const scoped = yield* retrieval.search({
          query: "drain the VIP",
          entity: "service:checkout-api"
        })
        return { count: scoped.hits.length, empty: scoped.scopeEmpty }
      })
    )
    expect(outcome.count).toBeGreaterThan(0)
    expect(outcome.empty).toBe(false)
  })

  it("does not claim scopeEmpty for an EMPTY RESULT the caller's scope did not cause", async () => {
    /**
     * The marker's other direction, and the reason it is not `hits.length === 0` renamed: a corpus
     * with no answer is not an over-narrow scope, and telling a caller to go fix a scope they never
     * set is a worse failure than saying nothing.
     *
     * **The fixture is the whole test.** This case has to run over input where the result really is
     * EMPTY — the main corpus cannot serve, because the recency arm ranks every file in it, so every
     * query there returns hits and a `hits.length === 0` marker would never evaluate its own guard.
     * (Found by mutation: the first version of this assertion ran over the main corpus and SURVIVED
     * replacing `ordered.length === 0 && scopeNarrows(input)` with `ordered.length === 0`.)
     *
     * Two shapes that reach zero hits with NO caller scope:
     * - a corpus holding no memories at all;
     * - a corpus holding only a task, which the default exclusion removes. A default is not a
     *   caller's scope, so this empty result is still not attributable to one.
     */
    const bare = await makeFixtureRepo()
    try {
      const outcome = await withDb((db) =>
        Effect.gen(function* () {
          // A commit with no memory in it: git has history, the index has no files.
          yield* Effect.promise(() =>
            bare.commit([{ path: "README.md", html: "# no memories here\n" }], "seed nothing")
          )
          yield* indexInto(db, bare, makeFakeEmbedder())
          const retrieval = makeRetrieval({ db, embeddings: makeFakeEmbedder() })
          const emptyCorpus = yield* retrieval.search({ query: "drain the VIP deploy" })
          const widened = yield* retrieval.search({
            query: "drain the VIP deploy",
            includeArchived: true,
            memoryTypes: []
          })

          yield* Effect.promise(() =>
            bare.commit(
              [
                {
                  path: "areas/inbox/tasks/only-a-task.html",
                  html: memoryHtml({
                    title: "Write the VIP drain step into the runbook",
                    claim: "The rollback runbook still omits the VIP drain step.",
                    memoryType: "task",
                    taskStatus: "doing",
                    updatedAt: "2026-08-01T00:00:00Z"
                  })
                }
              ],
              "seed one task"
            )
          )
          yield* makeIndexer({
            db,
            git: bare.git,
            embedWatermark: EMBED_WATERMARK,
            embedDim: EMBED_DIM,
            embeddings: makeFakeEmbedder(),
            now: () => AT
          }).update({ embed: true })
          const taskOnly = yield* retrieval.search({ query: "drain the VIP runbook step" })
          const optedIn = yield* retrieval.search({
            query: "drain the VIP runbook step",
            memoryTypes: ["task"]
          })

          return {
            emptyCorpus: { count: emptyCorpus.hits.length, empty: emptyCorpus.scopeEmpty },
            widened: {
              count: widened.hits.length,
              empty: widened.scopeEmpty,
              scope: widened.entityScope
            },
            taskOnly: { count: taskOnly.hits.length, empty: taskOnly.scopeEmpty },
            optedIn: { count: optedIn.hits.length, empty: optedIn.scopeEmpty }
          }
        })
      )

      // Empty because there is nothing, not because of a scope.
      expect(outcome.emptyCorpus.count).toBe(0)
      expect(outcome.emptyCorpus.empty).toBe(false)
      // `includeArchived` WIDENS and an empty type list is a flag nobody passed, so neither is a
      // narrowing and neither may claim the marker.
      expect(outcome.widened.count).toBe(0)
      expect(outcome.widened.empty).toBe(false)
      expect(outcome.widened.scope).toBeNull()
      // The default task exclusion emptied this one, and a default is not the caller's scope.
      expect(outcome.taskOnly.count).toBe(0)
      expect(outcome.taskOnly.empty).toBe(false)
      // The same corpus DOES answer once the caller names the type, so the zeroes above are the
      // exclusion rather than a corpus nothing could retrieve from.
      expect(outcome.optedIn.count).toBeGreaterThan(0)
      expect(outcome.optedIn.empty).toBe(false)
    } finally {
      await bare.cleanup()
    }
  })

  it("scopes by the FULL type:name, so a bare name and a wrong type both match nothing", async () => {
    /**
     * `file_entities` is keyed on `(type, name)`, which is why the reference is rebuilt from both
     * columns. A predicate comparing the name alone would make `service:checkout-api` and a
     * hypothetical `concept:checkout-api` one scope — and it would ALSO make the bare form below
     * succeed, which is the observable difference.
     */
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const query = "drain the VIP before reverting the deploy"
        const full = yield* retrieval.search({ query, entity: "service:checkout-api", limit: 20 })
        const bare = yield* retrieval.search({ query, entity: "checkout-api", limit: 20 })
        const wrongType = yield* retrieval.search({
          query,
          entity: "person:checkout-api",
          limit: 20
        })
        return {
          full: full.hits.length,
          bare: bare.hits.length,
          wrongType: wrongType.hits.length
        }
      })
    )
    expect(outcome.full).toBeGreaterThan(0)
    expect(outcome.bare).toBe(0)
    expect(outcome.wrongType).toBe(0)
  })

  it("treats an empty entity string as no scope rather than as a scope matching nothing", async () => {
    // The value a CLI flag nobody passed and an MCP client sending the key with no value both produce.
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const result = yield* retrieval.search({ query: "drain the VIP", entity: "", limit: 20 })
        return { count: result.hits.length, empty: result.scopeEmpty, scope: result.entityScope }
      })
    )
    expect(outcome.count).toBeGreaterThan(0)
    expect(outcome.empty).toBe(false)
    expect(outcome.scope).toBeNull()
  })

  it("combines the entity scope with the tag scope as an AND, not an OR", async () => {
    /**
     * Two EXISTS subqueries over two side tables, appended to one filter. `AND` binding tighter than
     * `OR` is how this repo already shipped a "scoped" query that was a full scan, so the composition
     * is asserted behaviorally as well as in the SQL: a tag the entity's memories do not carry must
     * empty the result rather than broaden it back.
     */
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const query = "drain the VIP deploy turso relevance"
        const both = yield* retrieval.search({
          query,
          entity: "service:checkout-api",
          tags: ["deploy"],
          limit: 20
        })
        const disjoint = yield* retrieval.search({
          query,
          entity: "service:checkout-api",
          tags: ["turso"],
          limit: 20
        })
        const tagAlone = yield* retrieval.search({ query, tags: ["turso"], limit: 20 })
        return {
          both: both.hits.map((hit) => hit.path),
          disjoint: disjoint.hits.map((hit) => hit.path),
          tagAlone: tagAlone.hits.map((hit) => hit.path)
        }
      })
    )
    expect(outcome.both).toContain("areas/oncall/vip-drain-before-rollback.html")
    // The `turso` tag alone DOES return a memory, so the empty intersection below is the AND doing
    // its job rather than the tag matching nothing.
    expect(outcome.tagAlone).toContain("projects/memhtml/turso-fts.html")
    expect(outcome.disjoint).toEqual([])
  })

  it("PROBES file_entities once per candidate rather than scanning it, in every arm", async () => {
    /**
     * The cost contract, at the planner, over the statement retrieval ITSELF issued.
     *
     * A correlated `EXISTS` is the one shape where correct results and acceptable cost diverge
     * completely: `SEARCH e USING INDEX … (path=?)` probes the `(path, entity_type, entity_name)`
     * primary key once per candidate row, while `SCAN e` re-reads the whole entity table once per
     * candidate row — quadratic, and returning exactly the same hits. No result assertion in this
     * file could tell the two apart at any corpus size a test will seed.
     *
     * The plan is taken of the CAPTURED sql, not of a pasted copy. This repo has already written that
     * test the other way and watched it keep passing while the clause it guarded was deleted from the
     * source, because it was explaining its own string.
     *
     * `ANALYZE` is deliberately NOT run: production does not run it, so its plan is the one that
     * matters. (Probed both ways 2026-08-08 — the chosen INDEX NAME differs, `ephemeral_file_entities_tN`
     * with stats against `sqlite_autoindex_file_entities_1` without, which is why the assertion is on
     * SEARCH-versus-SCAN and on the table, not on an index name.)
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* indexInto(db, repo, makeFakeEmbedder())

        let issued: { sql: string; params: ReadonlyArray<unknown> } | null = null
        const capturing: DatabaseShape = {
          ...db,
          all: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
            // The FUSED statement, which is the only one carrying the scope. Hydrate names
            // `file_entities` too, so the four-arm shape is what selects it.
            if (issued === null && sql.includes("file_entities") && sql.includes("rrf AS (")) {
              issued = { sql, params: params ?? [] }
            }
            return (db.all as never as (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<A>)(
              sql,
              params
            )
          }) as DatabaseShape["all"]
        }

        const result = yield* makeRetrieval({
          db: capturing,
          embeddings: makeFakeEmbedder()
        }).search({
          query: "drain the VIP before reverting the deploy",
          entity: "service:checkout-api",
          limit: 20
        })
        const captured = issued as { sql: string; params: ReadonlyArray<unknown> } | null
        if (captured === null) return { steps: [] as ReadonlyArray<string>, hits: 0, arms: 0 }

        const plan = yield* db.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${captured.sql}`,
          captured.params as never
        )
        return {
          steps: plan.map((row) => row.detail),
          hits: result.hits.length,
          arms: result.arms.length
        }
      })
    )

    // The statement really ran and really matched, so the plan describes a query that did the work.
    expect(outcome.hits).toBeGreaterThan(0)
    expect(outcome.arms).toBe(4)
    expect(outcome.steps.length).toBeGreaterThan(0)

    const probes = outcome.steps.filter(
      (step) => step.includes("SEARCH") && step.includes("file_entities") && step.includes("path=?")
    )
    // ONE probe per arm: four arms fired and each carries its own copy of the shared filter, so a
    // count below four is an arm that lost the scope and a count above four is a duplicated subquery.
    expect(probes.length).toBe(outcome.arms)
    // And no arm scans the entity table. Asserted over the whole plan rather than per step, because a
    // single scanning arm is the entire defect.
    const scans = outcome.steps.filter(
      (step) => step.includes("SCAN") && step.includes("file_entities")
    )
    expect(scans, `file_entities scanned: ${scans.join(" | ")}`).toEqual([])
  })

  it("returns nothing rather than failing on a query with no indexable terms", async () => {
    const result = await withIndexed(repo, ({ retrieval }) =>
      retrieval.search({ query: "!!! ???" })
    )
    // The lexical arm contributes nothing, but recency and salience still rank the corpus, so the
    // response is a valid narrow result rather than an error.
    expect(result.degraded).toBe(false)
    expect(Array.isArray(result.hits)).toBe(true)
  })

  /**
   * Salience invariance for the two shapes salience has no opinion about, asserted at the DATABASE
   * through the assembled statement rather than against a SQL string.
   *
   * The seed is deliberately absurd — an access count of 10,000 puts the row at salience rank 1 by
   * `ln(1 + n)` — so a leak is not a subtle score wobble but the strongest possible one. Both halves
   * run the SAME query over the SAME corpus, differing only in what the state plane holds, and the
   * claim is that the fused score of an excluded row is byte-identical across the two: the arm emits no
   * row for it at all, so there is nothing for a count to move.
   */
  const seedAccess = (db: DatabaseShape, path: string, count: number) =>
    db.run(
      `INSERT INTO state.access (path, access_count, last_accessed_at, updated_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(path) DO UPDATE SET access_count = ?2, last_accessed_at = ?3, updated_at = ?3`,
      [path, count, AT]
    )

  /** The salience CTE alone, run as a statement, so "emits no row" is directly observable. */
  const salienceRows = (db: DatabaseShape, scope: Parameters<typeof assembleScope>[0]) =>
    Effect.gen(function* () {
      const arm = RANK_ARMS.find((candidate) => candidate.name === "salience")
      if (arm === undefined) throw new Error("the salience arm left the registry")
      const assembled = assembleScope(scope)
      const rows = yield* db.all<{ path: string }>(arm.sql(assembled.holes), [
        "",
        DEFAULT_ARM_LIMIT,
        20,
        null,
        ...assembled.params
      ])
      return rows.map((row) => row.path)
    })

  /**
   * The fused RRF sum per path, from the assembled statement itself.
   *
   * `search`'s `hit.score` cannot serve here: it is `1/(offset + 1)`, the position proxy MMR consumes,
   * so it observes only a change of order. The sum below is where a `0.4/(rank + 60)` salience
   * contribution actually lands. The vector arm is deliberately absent (`?4` bound NULL and
   * `hasQueryVector: false`), because the fake embedder's cosines are not the subject and dropping the
   * arm keeps the sum a function of the three deterministic ones.
   */
  const fusedScores = (db: DatabaseShape, scope: Parameters<typeof assembleScope>[0]) =>
    Effect.gen(function* () {
      const assembled = assembleScope(scope)
      const sql = buildRrfSql({
        hasQueryVector: false,
        hasState: true,
        hasQueryTerms: true,
        holes: assembled.holes
      })
      if (sql === undefined) throw new Error("no arm assembled")
      const rows = yield* db.all<{ path: string; score: number }>(sql, [
        "drain OR VIP OR deploy OR rollback",
        DEFAULT_ARM_LIMIT,
        20,
        null,
        ...assembled.params
      ])
      return new Map(rows.map((row) => [row.path, row.score]))
    })

  it("emits no salience row for a task, however heavily accessed, even when the caller opts task in", async () => {
    const task = "areas/inbox/tasks/drain-the-vip-in-the-runbook.html"
    const outcome = await withIndexed(repo, ({ db }) =>
      Effect.gen(function* () {
        yield* seedAccess(db, task, 10_000)
        return {
          optedIn: yield* salienceRows(db, { memoryTypes: ["task"] }),
          alongside: yield* salienceRows(db, { memoryTypes: ["task", "procedural"] })
        }
      })
    )
    /**
     * `memory_types: ["task"]` is the load-bearing case: the shared filter's default `<> 'task'` is
     * replaced by an `IN` list there, so this is the one query where a task reaches every arm — and the
     * arm's own predicate is what makes its rank salience-invariant. An opted-in query is therefore the
     * query with NO salience candidates at all.
     */
    expect(outcome.optedIn).toEqual([])
    expect(outcome.alongside).not.toContain(task)
    // The memory competing with it does rank, so the arm is scoped rather than inert.
    expect(outcome.alongside).toContain("areas/oncall/vip-drain-before-rollback.html")
  })

  it("emits no salience row for a resources/people reference record", async () => {
    const person = "resources/people/sanju.html"
    const paths = await withDb((db) =>
      Effect.gen(function* () {
        /**
         * A person file is a `semantic` record that `placementFor` routes under `resources/people/` —
         * there is no `person` memory_type, so the PATH is the discriminator. The pair below is the
         * whole point of using a prefix: the reference record is excluded and an episodic memory ABOUT
         * the same person, filed elsewhere, keeps its salience.
         */
        yield* Effect.promise(() =>
          repo.commit(
            [
              {
                path: person,
                html: memoryHtml({
                  title: "Sanju",
                  claim: "Sanju owns the checkout-api deploy rotation.",
                  memoryType: "semantic",
                  entities: ["person:sanju"],
                  updatedAt: "2026-07-22T00:00:00Z"
                })
              },
              {
                path: "areas/oncall/sanju-called-the-rollback.html",
                html: memoryHtml({
                  title: "Sanju called the rollback on the second",
                  claim: "Sanju called the checkout-api rollback during the deploy incident.",
                  memoryType: "episodic",
                  entities: ["person:sanju"],
                  updatedAt: "2026-07-23T00:00:00Z"
                })
              }
            ],
            "seed the person plane"
          )
        )
        yield* indexInto(db, repo, makeFakeEmbedder())
        yield* seedAccess(db, person, 10_000)
        yield* seedAccess(db, "areas/oncall/sanju-called-the-rollback.html", 10_000)
        return yield* salienceRows(db, {})
      })
    )
    expect(paths).not.toContain(person)
    expect(paths).toContain("areas/oncall/sanju-called-the-rollback.html")
  })

  it("keeps an opted-in task's FUSED RRF score identical whatever its access count", async () => {
    /**
     * The behavioral half: the excluded row still earns its FTS, vector, and recency ranks, so it stays
     * in the fused result — only its score refuses to move.
     *
     * Asserted against the RRF statement's OWN score rather than `search`'s `hit.score`, and the
     * distinction is load-bearing (found by mutation, not by reading): `hit.score` is
     * `1/(offset + 1)`, a monotone position proxy MMR takes as its relevance input, so it can only
     * observe a change of ORDER. The RRF sum is what a salience contribution actually enters —
     * `0.4/(rank + 60)`, never zero — so it moves whenever the arm has an opinion at all, including
     * where the winner would have won anyway. A leak with the predicate removed flips this task from
     * salience rank 2 to rank 1, which the sum registers and the position proxy does not.
     */
    const task = "areas/inbox/tasks/drain-the-vip-in-the-runbook.html"
    const competitor = "areas/oncall/vip-drain-before-rollback.html"
    const scoreWith = (taskCount: number) =>
      withIndexed(repo, ({ db }) =>
        Effect.gen(function* () {
          // The competitor is seeded in BOTH runs so the arm's cold ordering is not already its hot
          // one: without it the task holds salience rank 1 regardless (it is the corpus's most
          // recently updated row, and the decay term falls back to `updated_at`) and no access count
          // could move anything.
          yield* seedAccess(db, competitor, 500)
          if (taskCount > 0) yield* seedAccess(db, task, taskCount)
          return yield* fusedScores(db, { memoryTypes: ["task", "procedural"] })
        })
      )

    const cold = await scoreWith(0)
    const hot = await scoreWith(10_000)
    expect(cold.get(task)).toBeDefined()
    expect(hot.get(task)).toBe(cold.get(task))
    // The competitor's score DOES move with its own seeded count, so the statement under test is
    // ranking on salience at all — an arm that had silently stopped firing would pass the line above.
    expect(cold.get(competitor)).toBeDefined()
  })

  it("is deterministic: the same query over an unchanged corpus yields the same order", async () => {
    const outcome = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const first = yield* retrieval.search({ query: "drain the VIP deploy", limit: 8 })
        const second = yield* retrieval.search({ query: "drain the VIP deploy", limit: 8 })
        return {
          first: first.hits.map((hit) => hit.path),
          second: second.hits.map((hit) => hit.path)
        }
      })
    )
    // The discrimination gate compares against this ordering, so a run-to-run reshuffle would make
    // the gate untrustworthy rather than merely noisy.
    expect(outcome.second).toEqual(outcome.first)
  })
})

describe("recall", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(corpus(), "seed the corpus")
  })

  afterEach(() => repo.cleanup())

  it("folds arcs under their own envelope, separate from ordinary memories", async () => {
    const pack = await withIndexed(repo, ({ retrieval }) =>
      retrieval.recall({ query: "rollback deploy drain reversibility" })
    )
    const arcPaths = pack.arcs.disclosed.map((entry) => entry.path)
    const memoryPaths = pack.memories.disclosed.map((entry) => entry.path)
    expect(arcPaths).toContain("areas/arcs/reversibility-first.html")
    // An arc must not consume the memories' budget: the pack would explain the pattern and cite
    // none of the evidence.
    expect(memoryPaths).not.toContain("areas/arcs/reversibility-first.html")
    expect(memoryPaths.length).toBeGreaterThan(0)
  })

  it("never quotes a <details> body or an <aside>, and does quote the <summary>", async () => {
    const bodies = await withIndexed(repo, ({ retrieval }) =>
      Effect.gen(function* () {
        const pack = yield* retrieval.recall({ query: "reversibility rollback undo" })
        return [...pack.arcs.disclosed, ...pack.memories.disclosed].map((entry) => entry.body)
      })
    )
    const joined = bodies.join("\n")
    expect(joined).toContain("Where this arc came from")
    expect(joined).not.toContain("Synthesized from eleven oncall entries")
    expect(joined).not.toContain("Not a rule for one-way migrations")
  })

  it("spends no more than the budget and reports the overflow as index lines", async () => {
    const pack = await withIndexed(repo, ({ retrieval }) =>
      retrieval.recall({ query: "okapi wildebeest filler", budgetChars: 120 })
    )
    expect(pack.memories.spentChars).toBeLessThanOrEqual(120)
    expect(pack.truncated).toBe(true)
    expect(pack.memories.indexLines.length).toBeGreaterThan(0)
    // An overflow entry still carries its claim and its path, so the agent can drill down.
    for (const line of pack.memories.indexLines) {
      expect(line.path).not.toBe("")
      expect(line.gist).not.toBe("")
    }
  })

  it("reports degradation the same way search does", async () => {
    const pack = await withIndexed(
      repo,
      ({ retrieval }) => retrieval.recall({ query: "drain the VIP" }),
      { queryEmbedder: failingEmbedder() }
    )
    expect(pack.degraded).toBe(true)
    expect(pack.memories.disclosed.length + pack.memories.indexLines.length).toBeGreaterThan(0)
  })
})

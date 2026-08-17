import { ModelUnavailable } from "@memhtml/contracts/errors"
import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { Effect, Result } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DatabaseShape, SqlValue } from "../src/database.js"
import {
  type IndexerShape,
  isIndexablePath,
  makeIndexer,
  PENDING_SCAN_ID_BATCH
} from "../src/indexer.js"
import { FTS_INDEX_NAME } from "../src/schema-const.js"
import { makeIndexRecorder } from "../src/traces-persist.js"
import { type FixtureRepo, makeFixtureRepo, type SeedFile } from "./fixture-repo.js"
import {
  type FakeEmbedder,
  failingEmbedder,
  fakeVector,
  makeFakeEmbedder,
  memoryHtml,
  withDb
} from "./harness.js"

/**
 * The indexer against a real temp-dir git repository and a real in-memory SQLite.
 *
 * The fleet's standing lesson is that a stateless fake masks a real state bug, and this is exactly a
 * mutate-then-read use case: the incremental path writes rows, advances a watermark, and then reads
 * both back on the next pass. A fake git returning canned tree entries would confirm the calls and
 * miss the facts that matter — that `diff -M` reports the archive move as a rename, that a parent-key
 * UPDATE needs `ON UPDATE CASCADE`, that a `cat-file --batch` blob's size header is authoritative.
 */

const AT = "2026-08-01T12:00:00Z"

/** A 20-file corpus spanning the buckets, the types, and every format element the indexer reads. */
const seedCorpus = (): ReadonlyArray<SeedFile> => [
  {
    path: "areas/oncall/vip-drain-before-rollback.html",
    html: memoryHtml({
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "If a prod rollback is issued, drain the VIP before reverting the deploy.",
      body: "The revert alone leaves in-flight connections pinned to the old target group.",
      memoryType: "procedural",
      confidence: "0.90",
      importance: "8",
      entities: ["service:checkout-api", "person:sanju"],
      tags: ["deploy", "oncall"],
      eventAt: "2026-07-28",
      facets: [
        { name: "Applies to", value: "ALB/NLB target-group deploys" },
        { name: "Failure window", value: "about two minutes", dataValue: "120" }
      ],
      citations: ["checkout-api sev2"],
      details: {
        summary: "How this was learned",
        body: "Three rollbacks in July replayed the spike."
      },
      aside: "Fly.io and Cloud Run drain automatically; this is AWS-target-group specific.",
      links: [{ rel: "memhtml-part-of", href: "/areas/arcs/reversibility-first.html" }]
    })
  },
  {
    path: "areas/arcs/reversibility-first.html",
    html: memoryHtml({
      title: "Reversibility first",
      claim: "Prefer the change you can undo over the change you can explain.",
      memoryType: "arc",
      importance: "9",
      tags: ["arc"]
    })
  },
  {
    path: "resources/people/sanju.html",
    html: memoryHtml({
      title: "Sanju",
      claim: "Sanju owns the astrolabe paper and reviews via merge requests.",
      memoryType: "semantic",
      entities: ["person:sanju"],
      tags: ["people"]
    })
  },
  {
    path: "resources/fts/multi-column-relevance-order.html",
    html: memoryHtml({
      title: "A multi-column FTS index loses relevance order",
      claim: "A multi-column FTS index returns MATCH rows in rowid order, not relevance order.",
      memoryType: "error_pattern",
      definedTerms: ["relevance order"],
      tags: ["fts", "sqlite"]
    })
  },
  ...Array.from({ length: 16 }, (_, offset): SeedFile => {
    const index = offset + 1
    const bucket =
      index % 3 === 0 ? "projects/memhtml" : index % 3 === 1 ? "areas/notes" : "resources/misc"
    return {
      path: `${bucket}/entry-${String(index).padStart(2, "0")}.html`,
      html: memoryHtml({
        title: `Entry ${index}`,
        claim: `Claim number ${index} about zebra topic ${index % 4}.`,
        body: `Supporting prose for entry ${index}, mentioning giraffe and antelope.`,
        memoryType: index % 2 === 0 ? "semantic" : "episodic",
        tags: [`topic-${index % 4}`],
        entities: [`service:svc-${index % 5}`],
        updatedAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`
      })
    }
  }),
  /** Generated artifacts, which the indexer must skip: they are `memhtml publish` output, not memories. */
  {
    path: "areas/notes/index.html",
    html: "<!doctype html><html><body>generated listing</body></html>"
  },
  { path: "sitemap.xml", html: '<?xml version="1.0"?><urlset></urlset>' }
]

describe("isIndexablePath", () => {
  it("takes a memory file rooted in a PARA bucket", () => {
    expect(isIndexablePath("areas/oncall/a.html")).toBe(true)
    expect(isIndexablePath("archive/2026/areas/oncall/a.html")).toBe(true)
  })

  it("skips the generated artifacts, which are publish output rather than memories", () => {
    expect(isIndexablePath("areas/notes/index.html")).toBe(false)
    expect(isIndexablePath("sitemap.xml")).toBe(false)
  })

  it("skips anything outside the four buckets", () => {
    expect(isIndexablePath(".memhtml/sleep/run.html")).toBe(false)
    expect(isIndexablePath("README.html")).toBe(false)
  })
})

/** One indexer over one fixture repo and one database, plus the pieces a test asserts against. */
interface Rig {
  readonly db: DatabaseShape
  readonly indexer: IndexerShape
  readonly embedder: FakeEmbedder
}

const withRig = <A>(
  repo: FixtureRepo,
  body: (rig: Rig) => Effect.Effect<A, unknown>,
  embedder: FakeEmbedder = makeFakeEmbedder()
): Promise<A> =>
  withDb((db) =>
    body({
      db,
      embedder,
      indexer: makeIndexer({
        db,
        git: repo.git,
        embedWatermark: EMBED_WATERMARK,
        embedDim: EMBED_DIM,
        embeddings: embedder,
        now: () => AT
      })
    })
  ) as Promise<A>

describe("rebuild", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(seedCorpus(), "seed the corpus")
  })

  afterEach(() => repo.cleanup())

  it("indexes the whole corpus and skips the generated artifacts", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        const report = yield* indexer.rebuild({ embed: false })
        const counts = yield* db.get<{
          files: number
          tags: number
          entities: number
          facets: number
          citations: number
          chunks: number
          edges: number
        }>(
          `SELECT (SELECT count(*) FROM files) AS files,
                  (SELECT count(*) FROM file_tags) AS tags,
                  (SELECT count(*) FROM file_entities) AS entities,
                  (SELECT count(*) FROM file_facets) AS facets,
                  (SELECT count(*) FROM file_citations) AS citations,
                  (SELECT count(*) FROM chunks) AS chunks,
                  (SELECT count(*) FROM edges) AS edges`
        )
        const generated = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM files WHERE path LIKE '%index.html' OR path LIKE '%sitemap.xml'"
        )
        return { report, counts, generated }
      })
    )

    expect(outcome.report.filesIndexed).toBe(20)
    expect(outcome.report.skipped).toEqual([])
    expect(outcome.counts?.files).toBe(20)
    expect(outcome.generated?.n).toBe(0)
    // One chunk per file: the format is one fact per file and every fixture is under the ceiling.
    expect(outcome.counts?.chunks).toBe(20)
    expect(outcome.counts?.edges).toBe(1)
    expect(outcome.counts?.facets).toBe(2)
    expect(outcome.counts?.citations).toBe(1)
  })

  it("records the head sha it indexed and the configured vector space", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* db.get<{ head_sha: string; embed_model: string; embed_dim: number }>(
          "SELECT head_sha, embed_model, embed_dim FROM index_state WHERE id = 1"
        )
      })
    )
    expect(outcome?.head_sha).toBe(await repo.head())
    // findings-t1.md:13 — the watermark comes from @memhtml/llm's export, never re-concatenated here.
    expect(outcome?.embed_model).toBe(EMBED_WATERMARK)
    expect(outcome?.embed_dim).toBe(EMBED_DIM)
  })

  it("projects every article field the format promises the indexer", async () => {
    const row = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        const file = yield* db.get<{
          title: string
          gist: string
          memory_type: string
          para: string
          workspace: string | null
          confidence: number
          importance: number
          event_at: string | null
          word_count: number
          archived: number
          fts_text: string
          disclosure_text: string
          body_text: string
        }>("SELECT * FROM files WHERE path = ?", ["areas/oncall/vip-drain-before-rollback.html"])
        const tags = yield* db.all<{ tag: string }>(
          "SELECT tag FROM file_tags WHERE path = ? ORDER BY tag",
          ["areas/oncall/vip-drain-before-rollback.html"]
        )
        const facets = yield* db.all<{ name: string; value: string; numeric_value: number | null }>(
          "SELECT name, value, numeric_value FROM file_facets WHERE path = ? ORDER BY name",
          ["areas/oncall/vip-drain-before-rollback.html"]
        )
        const citations = yield* db.all<{ text: string }>(
          "SELECT text FROM file_citations WHERE path = ?",
          ["areas/oncall/vip-drain-before-rollback.html"]
        )
        return { file, tags: tags.map((row) => row.tag), facets, citations }
      })
    )

    expect(row.file?.memory_type).toBe("procedural")
    expect(row.file?.para).toBe("areas")
    expect(row.file?.workspace).toBeNull()
    expect(row.file?.confidence).toBeCloseTo(0.9)
    expect(row.file?.importance).toBe(8)
    expect(row.file?.gist).toBe(
      "If a prod rollback is issued, drain the VIP before reverting the deploy."
    )
    // <time datetime> is EVENT time — when the fact happened, not when it was written.
    expect(row.file?.event_at).toBe("2026-07-28")
    expect(row.file?.archived).toBe(0)
    expect(row.tags).toEqual(["deploy", "oncall"])
    expect(row.facets).toEqual([
      { name: "Applies to", value: "ALB/NLB target-group deploys", numeric_value: null },
      { name: "Failure window", value: "about two minutes", numeric_value: 120 }
    ])
    expect(row.citations).toEqual([{ text: "checkout-api sev2" }])
  })

  it("stamps workspace from the projects/<slug> directory", async () => {
    const rows = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* db.all<{ path: string; workspace: string }>(
          "SELECT path, workspace FROM files WHERE workspace IS NOT NULL ORDER BY path"
        )
      })
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.workspace).toBe("memhtml")
      expect(row.path.startsWith("projects/memhtml/")).toBe(true)
    }
  })

  it("promotes a <dfn> term to a concept: entity", async () => {
    const entities = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* db.all<{ entity_type: string; entity_name: string }>(
          "SELECT entity_type, entity_name FROM file_entities WHERE path = ? ORDER BY entity_type",
          ["resources/fts/multi-column-relevance-order.html"]
        )
      })
    )
    // findings-t1.md:22 — the <dfn> already said it; asking the author for a memhtml-entity too is how
    // the two drift apart.
    expect(entities).toContainEqual({ entity_type: "concept", entity_name: "relevance order" })
  })

  it("splits a type:name entity at the first colon", async () => {
    const entities = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* db.all<{ entity_type: string; entity_name: string }>(
          "SELECT entity_type, entity_name FROM file_entities WHERE path = ? ORDER BY entity_type",
          ["areas/oncall/vip-drain-before-rollback.html"]
        )
      })
    )
    expect(entities).toEqual([
      { entity_type: "person", entity_name: "sanju" },
      { entity_type: "service", entity_name: "checkout-api" }
    ])
  })

  it("stores an authored edge with the leading slash stripped from the href", async () => {
    const edges = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* db.all<{
          src_path: string
          rel: string
          dst_path: string
          edge_class: string
          derived: number
          provenance: string
        }>("SELECT src_path, rel, dst_path, edge_class, derived, provenance FROM edges")
      })
    )
    // findings-t1.md:22 — the href is the document-reference form; `edges` stores the git-tree form,
    // and storing the slashed one makes every join against files.path silently return nothing.
    expect(edges).toEqual([
      {
        src_path: "areas/oncall/vip-drain-before-rollback.html",
        rel: "part_of",
        dst_path: "areas/arcs/reversibility-first.html",
        edge_class: "memory",
        derived: 0,
        provenance: "authored"
      }
    ])
  })

  it("keeps the <details> body out of disclosure_text while leaving it searchable", async () => {
    const row = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* db.get<{ body_text: string; disclosure_text: string; fts_text: string }>(
          "SELECT body_text, disclosure_text, fts_text FROM files WHERE path = ?",
          ["areas/oncall/vip-drain-before-rollback.html"]
        )
      })
    )
    // Tier 3 is searchable but never quoted; the <summary> headline is Tier 2 and is quoted.
    expect(row?.body_text).toContain("Three rollbacks in July")
    expect(row?.disclosure_text).not.toContain("Three rollbacks in July")
    expect(row?.disclosure_text).toContain("How this was learned")
    // An aside is a scope caveat: in body_text, never in a disclosure line.
    expect(row?.body_text).toContain("Fly.io and Cloud Run")
    expect(row?.disclosure_text).not.toContain("Fly.io")
    expect(row?.fts_text).toContain("Fly.io")
  })

  it("counts a file that fails to parse without failing the pass", async () => {
    await repo.commit(
      [
        {
          path: "areas/notes/broken.html",
          html: "<!doctype html><html><body><p>no head</p></body></html>"
        }
      ],
      "add an invalid memory"
    )
    const report = await withRig(repo, ({ indexer }) => indexer.rebuild({ embed: false }))
    expect(report.filesIndexed).toBe(20)
    expect(report.skipped.map((entry) => entry.path)).toEqual(["areas/notes/broken.html"])
  })

  it("embeds every chunk exactly once when asked", async () => {
    const outcome = await withRig(repo, ({ db, indexer, embedder }) =>
      Effect.gen(function* () {
        const report = yield* indexer.rebuild({ embed: true })
        const rows = yield* db.get<{ n: number; models: number }>(
          "SELECT count(*) AS n, count(DISTINCT model) AS models FROM embeddings"
        )
        return { report, rows, texts: embedder.textsEmbedded().length }
      })
    )
    expect(outcome.report.embeddingsWritten).toBe(20)
    expect(outcome.rows?.n).toBe(20)
    expect(outcome.rows?.models).toBe(1)
    expect(outcome.texts).toBe(20)
  })

  it("leaves embeddings empty with --no-embed and backfills them later", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        const before = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        const filled = yield* indexer.embedMissing()
        const after = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        const again = yield* indexer.embedMissing()
        return { before: before?.n, filled, after: after?.n, again }
      })
    )
    expect(outcome.before).toBe(0)
    expect(outcome.filled).toBe(20)
    expect(outcome.after).toBe(20)
    // Idempotent: a second backfill finds nothing missing and issues no model call.
    expect(outcome.again).toBe(0)
  })

  it("keeps the slices that landed when the embedder fails partway, and a re-run finishes the rest", async () => {
    // Succeeds once, then throttles. With embedPersistEvery: 8 over the 20-chunk corpus the pass
    // is slices of 8, 8, 4 — so the first 8 vectors must be PERSISTED and reported, not rolled
    // back with the failure. This is the shape a Bedrock token throttle produces on a large
    // corpus, where an all-or-nothing pass re-pays every landed batch on every retry and never
    // completes.
    const partial = (): FakeEmbedder => {
      let calls = 0
      return {
        embed: (input) => {
          calls += 1
          return calls === 1
            ? Effect.sync(() => input.map(fakeVector))
            : Effect.fail(
                ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake throttle" })
              )
        },
        embedQuery: () =>
          Effect.fail(ModelUnavailable.make({ modelId: EMBED_WATERMARK, reason: "fake throttle" })),
        calls: () => calls,
        textsEmbedded: () => []
      }
    }
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const throttled = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: partial(),
          embedPersistEvery: 8,
          now: () => AT
        })
        yield* throttled.rebuild({ embed: false })
        const firstPass = yield* throttled.embedMissing()
        const kept = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")

        const healthy = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: makeFakeEmbedder(),
          embedPersistEvery: 8,
          now: () => AT
        })
        const secondPass = yield* healthy.embedMissing()
        const after = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        return { firstPass, kept: kept?.n, secondPass, after: after?.n }
      })
    )
    expect(outcome.firstPass).toBe(8)
    expect(outcome.kept).toBe(8)
    // The re-run finds exactly the remainder: the landed slices are not re-embedded or re-paid.
    expect(outcome.secondPass).toBe(12)
    expect(outcome.after).toBe(20)
  })

  it("keeps the lexical index usable when the embedder fails outright", async () => {
    const outcome = await withRig(
      repo,
      ({ db, indexer }) =>
        Effect.gen(function* () {
          const report = yield* indexer.rebuild({ embed: true })
          const embeddings = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
          const files = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM files")
          return { report, embeddings: embeddings?.n, files: files?.n }
        }),
      failingEmbedder()
    )
    // A Bedrock outage narrows the index; it does not fail the rebuild.
    expect(outcome.report.filesIndexed).toBe(20)
    expect(outcome.files).toBe(20)
    expect(outcome.embeddings).toBe(0)
  })

  it("refuses to touch an index built under a different vector space", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const first = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: "cohere.embed-v4:0@1024",
          embedDim: 1024,
          now: () => AT
        })
        yield* first.rebuild({ embed: false })

        const second = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: "cohere.embed-v4:0@1536",
          embedDim: 1536,
          now: () => AT
        })
        return yield* Effect.result(second.rebuild({ embed: false }))
      })
    )
    // A hard refusal, never a silent reindex: half a vector space degrades every cosine while each
    // individual vector still looks well-formed.
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("EmbedModelMismatch")
    }
  })

  it("is idempotent: a second rebuild yields the same row set", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        const first = yield* snapshot(db)
        yield* indexer.rebuild({ embed: false })
        const second = yield* snapshot(db)
        return { first, second }
      })
    )
    expect(outcome.second).toEqual(outcome.first)
  })
})

describe("update", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(seedCorpus(), "seed the corpus")
  })

  afterEach(() => repo.cleanup())

  it("touches nothing when HEAD has not moved and the tree is clean", async () => {
    const report = await withRig(repo, ({ indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* indexer.update({ embed: false })
      })
    )
    expect(report).toMatchObject({
      unchanged: true,
      added: 0,
      modified: 0,
      removed: 0,
      renamed: 0,
      dirty: 0
    })
  })

  it("rebuilds from scratch when no watermark exists", async () => {
    const report = await withRig(repo, ({ indexer }) => indexer.update({ embed: false }))
    expect(report.unchanged).toBe(false)
    expect(report.added).toBe(20)
  })

  it("re-indexes only the edited file and advances the watermark", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: true })
        const beforeSha = yield* db.get<{ head_sha: string }>(
          "SELECT head_sha FROM index_state WHERE id = 1"
        )
        const before = yield* db.get<{ indexed: string; gist: string }>(
          "SELECT indexed_at AS indexed, gist FROM files WHERE path = ?",
          ["areas/notes/entry-01.html"]
        )

        yield* Effect.promise(() =>
          repo.commit(
            [
              {
                path: "areas/notes/entry-01.html",
                html: memoryHtml({
                  title: "Entry 1",
                  claim: "The claim for entry one was corrected to mention wildebeest.",
                  memoryType: "episodic",
                  tags: ["topic-1"]
                })
              }
            ],
            "edit entry 1"
          )
        )
        const report = yield* indexer.update({ embed: true })
        const afterSha = yield* db.get<{ head_sha: string }>(
          "SELECT head_sha FROM index_state WHERE id = 1"
        )
        const after = yield* db.get<{ gist: string }>("SELECT gist FROM files WHERE path = ?", [
          "areas/notes/entry-01.html"
        ])
        const untouched = yield* db.get<{ gist: string }>("SELECT gist FROM files WHERE path = ?", [
          "areas/notes/entry-04.html"
        ])
        const total = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM files")
        return { beforeSha, afterSha, before, after, untouched, report, total }
      })
    )

    expect(outcome.report.modified).toBe(1)
    expect(outcome.report.added).toBe(0)
    expect(outcome.report.removed).toBe(0)
    expect(outcome.beforeSha?.head_sha).not.toBe(outcome.afterSha?.head_sha)
    expect(outcome.afterSha?.head_sha).toBe(await repo.head())
    expect(outcome.after?.gist).toContain("wildebeest")
    expect(outcome.untouched?.gist).toBe(outcome.untouched?.gist)
    expect(outcome.total?.n).toBe(20)
  })

  it("handles the archive move as a rename, keeping the embedding", async () => {
    const outcome = await withRig(repo, ({ db, indexer, embedder }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: true })
        const callsAfterRebuild = embedder.calls()
        const chunkBefore = yield* db.get<{ chunk_id: string }>(
          "SELECT chunk_id FROM chunks WHERE path = ?",
          ["resources/people/sanju.html"]
        )

        // The eviction: git mv into archive/<YYYY>/, path-preserving. `diff -M` reports it as R100.
        yield* Effect.promise(() =>
          repo.move(
            "resources/people/sanju.html",
            "archive/2026/resources/people/sanju.html",
            "archive sanju"
          )
        )
        const report = yield* indexer.update({ embed: true })

        const moved = yield* db.get<{ path: string; archived: number; origin_path: string | null }>(
          "SELECT path, archived, origin_path FROM files WHERE path = ?",
          ["archive/2026/resources/people/sanju.html"]
        )
        const gone = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM files WHERE path = ?",
          ["resources/people/sanju.html"]
        )
        const chunkAfter = yield* db.get<{ chunk_id: string; path: string }>(
          "SELECT chunk_id, path FROM chunks WHERE chunk_id = ?",
          [chunkBefore?.chunk_id ?? ""]
        )
        const embedding = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM embeddings WHERE chunk_id = ?",
          [chunkBefore?.chunk_id ?? ""]
        )
        const total = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM files")
        return {
          report,
          moved,
          gone: gone?.n,
          chunkAfter,
          embedding: embedding?.n,
          total: total?.n,
          callsAfterRebuild,
          callsAfterMove: embedder.calls()
        }
      })
    )

    expect(outcome.report.renamed).toBe(1)
    expect(outcome.moved?.archived).toBe(1)
    expect(outcome.moved?.origin_path).toBe("resources/people/sanju.html")
    expect(outcome.gone).toBe(0)
    expect(outcome.total).toBe(20)
    // The whole reason chunks key on content_hash: a git mv costs ZERO Bedrock calls.
    expect(outcome.chunkAfter?.path).toBe("archive/2026/resources/people/sanju.html")
    expect(outcome.embedding).toBe(1)
    expect(outcome.callsAfterMove).toBe(outcome.callsAfterRebuild)
  })

  it("re-indexes an edit and an archive together, touching only those two", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: true })
        const before = yield* db.all<{ path: string; blob_sha: string; indexed_at: string }>(
          "SELECT path, blob_sha, indexed_at FROM files ORDER BY path"
        )

        yield* Effect.promise(async () => {
          await repo.commit(
            [
              {
                path: "areas/notes/entry-01.html",
                html: memoryHtml({
                  title: "Entry 1",
                  claim: "Entry one now mentions wildebeest instead.",
                  memoryType: "episodic",
                  tags: ["topic-1"]
                })
              }
            ],
            "edit entry 1"
          )
          await repo.move(
            "resources/misc/entry-02.html",
            "archive/2026/resources/misc/entry-02.html",
            "archive entry 2"
          )
        })

        const report = yield* indexer.update({ embed: true })
        const after = yield* db.all<{ path: string; blob_sha: string }>(
          "SELECT path, blob_sha FROM files ORDER BY path"
        )
        return { before, after, report }
      })
    )

    expect(outcome.report.modified).toBe(1)
    expect(outcome.report.renamed).toBe(1)
    const beforePaths = new Set(outcome.before.map((row) => row.path))
    const afterPaths = new Set(outcome.after.map((row) => row.path))
    expect([...afterPaths].filter((path) => !beforePaths.has(path))).toEqual([
      "archive/2026/resources/misc/entry-02.html"
    ])
    expect([...beforePaths].filter((path) => !afterPaths.has(path))).toEqual([
      "resources/misc/entry-02.html"
    ])
  })

  it("removes a deleted file's rows", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        yield* Effect.promise(() => repo.remove("areas/notes/entry-04.html", "delete entry 4"))
        const report = yield* indexer.update({ embed: false })
        const total = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM files")
        return { report, total: total?.n }
      })
    )
    expect(outcome.report.removed).toBe(1)
    expect(outcome.total).toBe(19)
  })

  /**
   * A bulk pass writes straight through the live FTS index — no drop/recreate bracket — so the
   * triggers are the only thing keeping the lexical index in step with 16 new files at once. This is
   * the test that fails if `files_fts_insert` is dropped or scoped to the wrong column.
   */
  it("indexes a bulk pass through the triggers, leaving new and old rows both findable", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        yield* Effect.promise(() =>
          repo.commit(
            Array.from({ length: 16 }, (_, i) => ({
              path: `areas/notes/bulk-${String(i).padStart(2, "0")}.html`,
              html: memoryHtml({
                title: `Bulk entry ${i}`,
                claim: `Bulk claim ${i} concerning the quokka migration.`,
                memoryType: "semantic",
                tags: ["bulk"]
              })
            })),
            "bulk add 16 files"
          )
        )
        const report = yield* indexer.update({ embed: false })
        const matching = (term: string) =>
          db.all<{ path: string }>(
            `SELECT files.path AS path FROM ${FTS_INDEX_NAME}
             JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
             WHERE ${FTS_INDEX_NAME} MATCH ?`,
            [term]
          )
        const hits = yield* matching("quokka")
        const old = yield* matching("wildebeest OR giraffe")
        return { report, hits: hits.length, old: old.length }
      })
    )
    expect(outcome.report.added).toBe(16)
    // Every new row is findable, and the old rows stayed indexed.
    expect(outcome.hits).toBe(16)
    expect(outcome.old).toBeGreaterThan(0)
  })

  it("indexes an uncommitted working-tree edit at its real blob sha", async () => {
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        yield* Effect.promise(() =>
          repo.writeDirty([
            {
              path: "areas/notes/entry-01.html",
              html: memoryHtml({
                title: "Entry 1",
                claim: "An uncommitted edit mentioning okapi.",
                memoryType: "episodic",
                tags: ["topic-1"]
              })
            }
          ])
        )
        const report = yield* indexer.update({ embed: false })
        const row = yield* db.get<{ gist: string; blob_sha: string }>(
          "SELECT gist, blob_sha FROM files WHERE path = ?",
          ["areas/notes/entry-01.html"]
        )
        const realSha = yield* Effect.promise(() =>
          repo.raw("hash-object", "areas/notes/entry-01.html")
        )
        return { report, row, realSha: realSha.trim() }
      })
    )
    expect(outcome.report.dirty).toBe(1)
    expect(outcome.row?.gist).toContain("okapi")
    // The dirty path's change key is `hash-object`, so the next update compares against the real blob.
    expect(outcome.row?.blob_sha).toBe(outcome.realSha)
  })
})

/**
 * The pending scan's SHAPE, not just its result.
 *
 * These tests assert on the SQL and the bound parameters as well as on the rows, and that is
 * deliberate: the whole point of AC-3-1 is a cost property, and a cost property is invisible to an
 * assertion that only checks which chunks ended up embedded. A full scan and a scoped scan return the
 * SAME rows on a small fixture — they differ only in how many rows they read to get there — so a
 * result-only test would pass with the scoping removed and the store-scaled term back.
 */
describe("embedMissing scan scope", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(seedCorpus(), "seed the corpus")
  })

  afterEach(() => repo.cleanup())

  /** One recorded pending-scan statement: the SQL as issued and the values bound to it. */
  interface Scan {
    readonly sql: string
    readonly params: ReadonlyArray<SqlValue>
  }

  /**
   * A `DatabaseShape` that records the pending scans passing through it, and nothing else.
   *
   * Matched on `LEFT JOIN embeddings`, the same predicate `probe-embed-cost.mjs` uses to attribute
   * `db.all.pending` — so what these tests assert and what the probe measures are the same statement.
   */
  const spyOn = (
    db: DatabaseShape
  ): { readonly db: DatabaseShape; readonly scans: Array<Scan> } => {
    const scans: Array<Scan> = []
    return {
      scans,
      db: {
        ...db,
        all: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) => {
          if (sql.includes("LEFT JOIN embeddings")) scans.push({ sql, params: [...params] })
          return db.all<A>(sql, params)
        }
      }
    }
  }

  /** The scoped scans' bound chunk ids, in bind order, across however many batches were issued. */
  const scopedIds = (scans: ReadonlyArray<Scan>): ReadonlyArray<string> =>
    scans.flatMap((scan) => scan.params.slice(1).map(String))

  it("scopes the update path's pending scan to the batch's own projected chunk ids", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const spy = spyOn(db)
        const indexer = makeIndexer({
          db: spy.db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: makeFakeEmbedder(),
          now: () => AT
        })
        yield* indexer.rebuild({ embed: true })
        spy.scans.length = 0

        yield* Effect.promise(() =>
          repo.commit(
            [
              {
                path: "areas/notes/entry-01.html",
                html: memoryHtml({
                  title: "Entry 1",
                  claim: "Entry one was corrected to mention the numbat.",
                  memoryType: "episodic",
                  tags: ["topic-1"]
                })
              }
            ],
            "edit entry 1"
          )
        )
        const report = yield* indexer.update({ embed: true })
        const edited = yield* db.all<{ chunk_id: string }>(
          "SELECT chunk_id FROM chunks WHERE path = ? ORDER BY ordinal",
          ["areas/notes/entry-01.html"]
        )
        const total = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM chunks")
        return {
          report,
          scans: spy.scans,
          edited: edited.map((row) => row.chunk_id),
          total: total?.n
        }
      })
    )

    // One changed file out of twenty, so the store holds 20 chunks and the batch projected exactly 1.
    expect(outcome.total).toBe(20)
    expect(outcome.edited).toHaveLength(1)
    expect(outcome.report.embeddingsWritten).toBe(1)

    // The scan is RESTRICTED, and restricted to precisely this batch's ids — this is the assertion
    // that fails when the call site reverts to the full scan.
    expect(outcome.scans).toHaveLength(1)
    expect(outcome.scans[0]?.sql).toContain("c.chunk_id IN (?)")
    expect(scopedIds(outcome.scans)).toEqual(outcome.edited)
    // Bound, never interpolated: the id appears in the parameters and never in the SQL text.
    expect(outcome.scans[0]?.sql).not.toContain(outcome.edited[0] ?? "unreachable")
  })

  it("never embeds a pending chunk outside the candidate list", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const embedder = makeFakeEmbedder()
        const indexer = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: embedder,
          now: () => AT
        })
        yield* indexer.rebuild({ embed: true })

        /**
         * Open a gap the batch does NOT own: strip the vectors off two other files' chunks. Before
         * scoping, any `update --embed` would incidentally backfill these; after it, only a full scan
         * closes them, and that difference is the behavior change this task accepts on purpose.
         */
        const strandedPaths = ["resources/people/sanju.html", "areas/arcs/reversibility-first.html"]
        const stranded = yield* db.all<{ chunk_id: string }>(
          `SELECT chunk_id FROM chunks WHERE path IN (?, ?)`,
          strandedPaths
        )
        yield* db.run(
          `DELETE FROM embeddings WHERE chunk_id IN (${stranded.map(() => "?").join(", ")})`,
          stranded.map((row) => row.chunk_id)
        )

        yield* Effect.promise(() =>
          repo.commit(
            [
              {
                path: "areas/notes/entry-01.html",
                html: memoryHtml({
                  title: "Entry 1",
                  claim: "Entry one was corrected to mention the numbat.",
                  memoryType: "episodic",
                  tags: ["topic-1"]
                })
              }
            ],
            "edit entry 1"
          )
        )
        const report = yield* indexer.update({ embed: true })
        const stillMissing = yield* db.get<{ n: number }>(
          `SELECT count(*) AS n FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.chunk_id
           WHERE e.chunk_id IS NULL`
        )

        /** The full scan is still the way back: it closes the gap the scoped pass declined to see. */
        const backfilled = yield* indexer.embedMissing()
        const afterBackfill = yield* db.get<{ n: number }>(
          `SELECT count(*) AS n FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.chunk_id
           WHERE e.chunk_id IS NULL`
        )
        return {
          report,
          stranded: stranded.length,
          stillMissing: stillMissing?.n,
          backfilled,
          afterBackfill: afterBackfill?.n
        }
      })
    )

    expect(outcome.stranded).toBe(2)
    // The scoped pass embedded ITS chunk and left the two stranded ones alone.
    expect(outcome.report.embeddingsWritten).toBe(1)
    expect(outcome.stillMissing).toBe(2)
    // And the unscoped call still finds them, so nothing is unrecoverable.
    expect(outcome.backfilled).toBe(2)
    expect(outcome.afterBackfill).toBe(0)
  })

  it("keeps the full scan unscoped, so the model migration still sees the whole store", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const spy = spyOn(db)
        const indexer = makeIndexer({
          db: spy.db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: makeFakeEmbedder(),
          now: () => AT
        })
        yield* indexer.rebuild({ embed: true })

        /**
         * A vector left behind by a superseded model. Only the `e.model <> ?` disjunct finds it, and
         * only over the whole table — a candidate list from one batch never names this chunk.
         */
        const stale = yield* db.get<{ chunk_id: string }>(
          "SELECT chunk_id FROM chunks WHERE path = ?",
          ["resources/people/sanju.html"]
        )
        yield* db.run("UPDATE embeddings SET model = ? WHERE chunk_id = ?", [
          "superseded.model@8",
          stale?.chunk_id ?? ""
        ])

        /** Scoped to a DIFFERENT chunk: the stale vector must stay stale. */
        const other = yield* db.get<{ chunk_id: string }>(
          "SELECT chunk_id FROM chunks WHERE path = ?",
          ["areas/arcs/reversibility-first.html"]
        )
        spy.scans.length = 0
        const scoped = yield* indexer.embedMissing({
          candidateChunkIds: [other?.chunk_id ?? ""]
        })
        const afterScoped = yield* db.get<{ model: string }>(
          "SELECT model FROM embeddings WHERE chunk_id = ?",
          [stale?.chunk_id ?? ""]
        )

        /** Unscoped: the migration path. */
        spy.scans.length = 0
        const migrated = yield* indexer.embedMissing()
        const fullScans = [...spy.scans]
        const afterFull = yield* db.get<{ model: string }>(
          "SELECT model FROM embeddings WHERE chunk_id = ?",
          [stale?.chunk_id ?? ""]
        )
        const spaces = yield* db.get<{ n: number }>(
          "SELECT count(DISTINCT model) AS n FROM embeddings"
        )
        return {
          scoped,
          afterScoped: afterScoped?.model,
          migrated,
          fullScans,
          afterFull: afterFull?.model,
          spaces: spaces?.n
        }
      })
    )

    // A scoped pass over an already-current chunk does nothing and cannot reach the stale one.
    expect(outcome.scoped).toBe(0)
    expect(outcome.afterScoped).toBe("superseded.model@8")

    // The unscoped scan finds it by model mismatch and rewrites it into the configured space.
    expect(outcome.migrated).toBe(1)
    expect(outcome.afterFull).toBe(EMBED_WATERMARK)
    expect(outcome.spaces).toBe(1)
    expect(outcome.fullScans).toHaveLength(1)
    expect(outcome.fullScans[0]?.sql).not.toContain("IN (")
    expect(outcome.fullScans[0]?.params).toEqual([EMBED_WATERMARK])
  })

  it("splits a candidate list wider than the bind ceiling and asks nothing for an empty one", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const spy = spyOn(db)
        const indexer = makeIndexer({
          db: spy.db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          embeddings: makeFakeEmbedder(),
          now: () => AT
        })
        yield* indexer.rebuild({ embed: true })

        /** An empty list is a real answer: no work, and therefore no statement at all. */
        spy.scans.length = 0
        const empty = yield* indexer.embedMissing({ candidateChunkIds: [] })
        const emptyScans = spy.scans.length

        /**
         * Ids that match nothing, purely to measure the statement split. `PENDING_SCAN_ID_BATCH + 1`
         * ids must arrive as two statements, and the duplicate must be deduped away — two identical
         * ids in one `IN` list would return the row twice and pay the embedder twice for one text.
         */
        const wide = Array.from(
          { length: PENDING_SCAN_ID_BATCH + 1 },
          (_, at) => `absent-${String(at).padStart(6, "0")}`
        )
        spy.scans.length = 0
        const widened = yield* indexer.embedMissing({
          candidateChunkIds: [...wide, wide[0] ?? "unreachable"]
        })
        return { empty, emptyScans, widened, scans: [...spy.scans] }
      })
    )

    expect(outcome.empty).toBe(0)
    expect(outcome.emptyScans).toBe(0)

    // 501 distinct ids at a 500-wide ceiling: two statements, and no batch over the ceiling.
    expect(outcome.widened).toBe(0)
    expect(outcome.scans).toHaveLength(2)
    expect(outcome.scans.map((scan) => scan.params.length - 1)).toEqual([PENDING_SCAN_ID_BATCH, 1])
    for (const scan of outcome.scans) {
      expect(scan.params.length).toBeLessThanOrEqual(PENDING_SCAN_ID_BATCH + 1)
    }
  })
})

describe("rebuild reproducibility", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(seedCorpus(), "seed the corpus")
  })

  afterEach(() => repo.cleanup())

  /**
   * The load-bearing contract: `index rebuild` on a clean checkout reproduces the row set the
   * incremental path arrived at.
   *
   * The incremental database is walked to the same tree state through edits, an archive move, and a
   * delete, then a FRESH database is rebuilt at the final HEAD and the two snapshots are compared. A
   * mismatch means the two paths disagree about what the tree says, which is exactly the failure that
   * makes `rm index.db` unsafe — the thing the whole design rests on.
   */
  it("reaches the same row set incrementally as a fresh rebuild does", async () => {
    const incremental = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })

        yield* Effect.promise(async () => {
          await repo.commit(
            [
              {
                path: "areas/notes/entry-01.html",
                html: memoryHtml({
                  title: "Entry 1",
                  claim: "Entry one now mentions wildebeest.",
                  memoryType: "episodic",
                  tags: ["topic-1", "revised"],
                  entities: ["service:svc-1", "person:sanju"]
                })
              },
              {
                path: "projects/memhtml/new-entry.html",
                html: memoryHtml({
                  title: "A new entry",
                  claim: "A file that did not exist at the first rebuild.",
                  memoryType: "agent_insight",
                  tags: ["new"]
                })
              }
            ],
            "edit one and add one"
          )
          await repo.move(
            "resources/misc/entry-02.html",
            "archive/2026/resources/misc/entry-02.html",
            "archive entry 2"
          )
          await repo.remove("areas/notes/entry-04.html", "delete entry 4")
        })

        yield* indexer.update({ embed: false })
        return yield* snapshot(db)
      })
    )

    const fresh = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* snapshot(db)
      })
    )

    expect(incremental).toEqual(fresh)
  })
})

/**
 * `frame_key` over a real repo and a real database, end to end.
 *
 * A purpose-built corpus rather than `seedCorpus()`, because only ONE of that corpus's twenty claims
 * has a frame shape — a determinism assertion over nineteen NULLs and one key would pass with the
 * projection wired to a constant, which is the vacuous-oracle trap. This corpus keys deliberately: a
 * conflict PAIR sharing one key, an archived row holding that same key, a task holding it, and two
 * no-frame claims, so both branches and every exclusion appear in the rows.
 */
describe("frame_key end to end", () => {
  /** Claims chosen so the keyed/NULL split and the two exclusions are all present in `files`. */
  const frameCorpus = (): ReadonlyArray<SeedFile> => [
    {
      path: "areas/facts/capital-a.html",
      html: memoryHtml({
        title: "Capital A",
        claim: "The capital of India is New Delhi.",
        tags: ["geo"]
      })
    },
    {
      // The conflict's other half: same frame, different value, both active.
      path: "areas/facts/capital-b.html",
      html: memoryHtml({
        title: "Capital B",
        claim: "The capital of India is Grosseto.",
        tags: ["geo"]
      })
    },
    {
      // Same key, but evicted — so the lookup's `archived = 0` has something to exclude.
      path: "archive/2026/areas/facts/capital-old.html",
      html: memoryHtml({
        title: "Capital old",
        claim: "The capital of India is Kolkata.",
        status: "archived",
        archivedAt: "2026-07-01T00:00:00Z"
      })
    },
    {
      // Same key on a TASK, so the `memory_type <> 'task'` carve-out has something to exclude.
      path: "areas/inbox/tasks/capital-check.html",
      html: memoryHtml({
        title: "Check the capital",
        claim: "The capital of India is unverified.",
        memoryType: "task",
        taskStatus: "todo"
      })
    },
    {
      path: "areas/facts/water.html",
      html: memoryHtml({ title: "Water", claim: "Water is wet." })
    },
    {
      path: "areas/facts/priya.html",
      html: memoryHtml({ title: "Priya", claim: "Priya adopted a dog named Waffles." })
    }
  ]

  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(frameCorpus(), "seed the frame corpus")
  })

  afterEach(() => repo.cleanup())

  const keyRows = (db: DatabaseShape) =>
    db.all<{ path: string; frame_key: string | null }>(
      "SELECT path, frame_key FROM files ORDER BY path"
    )

  it("writes the derived key on every row a rebuild projects", async () => {
    const rows = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* keyRows(db)
      })
    )

    expect(rows).toEqual([
      { path: "archive/2026/areas/facts/capital-old.html", frame_key: "the capital of india is" },
      { path: "areas/facts/capital-a.html", frame_key: "the capital of india is" },
      { path: "areas/facts/capital-b.html", frame_key: "the capital of india is" },
      { path: "areas/facts/priya.html", frame_key: null },
      { path: "areas/facts/water.html", frame_key: null },
      { path: "areas/inbox/tasks/capital-check.html", frame_key: "the capital of india is" }
    ])
    // Both branches are genuinely present, so the assertion above is not "everything is NULL".
    expect(rows.filter((row) => row.frame_key !== null)).toHaveLength(4)
    expect(rows.filter((row) => row.frame_key === null)).toHaveLength(2)
  })

  it("reproduces byte-identical keys on a second rebuild", async () => {
    /**
     * Determinism holds BY CONSTRUCTION — `frameKeyOf` is pure lexical, with no clock, no randomness,
     * and no model — so this test's job is to catch a wiring mistake that would break it anyway: a key
     * derived from a value the rebuild does not reproduce, or a column dropped from the second pass's
     * write. That is why it compares the full snapshot as well as the keys.
     */
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        const first = yield* keyRows(db)
        const firstSnapshot = yield* snapshot(db)
        yield* indexer.rebuild({ embed: false })
        const second = yield* keyRows(db)
        const secondSnapshot = yield* snapshot(db)
        return { first, second, firstSnapshot, secondSnapshot }
      })
    )

    expect(outcome.second).toEqual(outcome.first)
    expect(outcome.secondSnapshot).toEqual(outcome.firstSnapshot)
    expect(outcome.first.some((row) => row.frame_key !== null)).toBe(true)
  })

  it("reaches the same keys down the incremental path as down a fresh rebuild", async () => {
    /**
     * The two write paths share one projection, and this is what proves the sharing holds for THIS
     * column: an edit re-derives the key from the new gist rather than leaving the old one behind, and
     * a rebuild of the same tree agrees with it.
     */
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        yield* Effect.promise(() =>
          repo.commit(
            [
              {
                path: "areas/facts/capital-b.html",
                html: memoryHtml({
                  title: "Capital B",
                  // A new claim with a DIFFERENT frame, so a stale key would be visible.
                  claim: "The largest city of India is Mumbai.",
                  tags: ["geo"]
                })
              }
            ],
            "restate capital-b"
          )
        )
        yield* indexer.update({ embed: false })
        return yield* keyRows(db)
      })
    )

    const updated = outcome.find((row) => row.path === "areas/facts/capital-b.html")
    expect(updated?.frame_key).toBe("the largest city of india is")

    const fresh = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        return yield* keyRows(db)
      })
    )
    expect(outcome).toEqual(fresh)
  })

  it("serves the batch lookup from the rebuilt rows, excluding the archived one and the task", async () => {
    /**
     * The whole substrate in one assertion, over rows a real rebuild wrote rather than hand-inserted
     * ones: four files carry `the capital of india is`, and the lookup answers with exactly the two
     * ACTIVE NON-TASK ones — each with the gist the conflict report needs.
     */
    const outcome = await withRig(repo, ({ db, indexer }) =>
      Effect.gen(function* () {
        yield* indexer.rebuild({ embed: false })
        const holders = yield* db.get<{ n: number }>(
          "SELECT count(*) AS n FROM files WHERE frame_key = 'the capital of india is'"
        )
        const found = yield* makeIndexRecorder(db).activeFramesFor(["the capital of india is"])
        return { holders, matches: found.get("the capital of india is") }
      })
    )

    expect(outcome.holders?.n).toBe(4)
    expect(outcome.matches).toEqual([
      { path: "areas/facts/capital-a.html", gist: "The capital of India is New Delhi." },
      { path: "areas/facts/capital-b.html", gist: "The capital of India is Grosseto." }
    ])
  })
})

/**
 * A canonical, order-stable snapshot of every projected table.
 *
 * `indexed_at` is included: the harness pins the clock, so a differing value would mean a row was
 * written by a path that did not go through the injected clock. `blob_sha` is included because it is
 * the incremental path's change key — two snapshots agreeing on content while disagreeing on the sha
 * would leave the next update either re-indexing everything or nothing.
 */
const snapshot = (db: DatabaseShape) =>
  Effect.gen(function* () {
    const files = yield* db.all<Record<string, unknown>>(
      `SELECT path, blob_sha, content_hash, memory_type, title, body_text, gist, fts_text,
              disclosure_text, para, workspace, confidence, importance, archived, origin_path,
              word_count, created_at, updated_at, event_at, archived_at, valid_from, valid_until,
              reprieves, needs_revision, author, session_id, prompt_id, turn_uuid, indexed_at,
              task_status, due_at, frame_key
       FROM files ORDER BY path`
    )
    const tags = yield* db.all<Record<string, unknown>>(
      "SELECT path, tag FROM file_tags ORDER BY path, tag"
    )
    const entities = yield* db.all<Record<string, unknown>>(
      "SELECT path, entity_type, entity_name FROM file_entities ORDER BY path, entity_type, entity_name"
    )
    const facets = yield* db.all<Record<string, unknown>>(
      "SELECT path, name, value, numeric_value FROM file_facets ORDER BY path, name, value"
    )
    const citations = yield* db.all<Record<string, unknown>>(
      "SELECT path, text, href FROM file_citations ORDER BY path, text"
    )
    const chunks = yield* db.all<Record<string, unknown>>(
      "SELECT chunk_id, path, content_hash, ordinal, text, char_count FROM chunks ORDER BY path, ordinal"
    )
    const edges = yield* db.all<Record<string, unknown>>(
      `SELECT src_path, rel, dst_path, edge_class, derived, strength, provenance, sleep_run,
              src_hash, dst_hash, created_at
       FROM edges ORDER BY src_path, rel, dst_path`
    )
    return { files, tags, entities, facets, citations, chunks, edges }
  })

import { EMBED_DIM, EMBED_WATERMARK } from "@memhtml/llm"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DatabaseShape } from "../src/database.js"
import { makeIndexer } from "../src/indexer.js"
import {
  formatCoverage,
  readVectorCoverage,
  VECTOR_COVERAGE_FLOOR,
  VECTOR_COVERAGE_HARD_FLOOR,
  VectorCoverageLow
} from "../src/vector-coverage.js"
import { type FixtureRepo, makeFixtureRepo, type SeedFile } from "./fixture-repo.js"
import { makeFakeEmbedder, memoryHtml, withDb } from "./harness.js"

/**
 * The coverage reader (issue #141): one statement, four consumers. What is pinned here is the
 * arithmetic every consumer inherits, so a wrong answer would be wrong in `search`, `status`, `doctor`
 * and sleep's preflight at once.
 */

const AT = "2026-08-01T12:00:00Z"

const corpus = (count: number): ReadonlyArray<SeedFile> =>
  Array.from({ length: count }, (_, offset): SeedFile => {
    const index = offset + 1
    return {
      path: `resources/misc/coverage-${String(index).padStart(2, "0")}.html`,
      html: memoryHtml({
        title: `Coverage sample ${index}`,
        claim: `An observation about okapi and wildebeest number ${index}.`,
        memoryType: "episodic",
        updatedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00Z`
      })
    }
  })

const indexInto = (db: DatabaseShape, repo: FixtureRepo) =>
  makeIndexer({
    db,
    git: repo.git,
    embedWatermark: EMBED_WATERMARK,
    embedDim: EMBED_DIM,
    embeddings: makeFakeEmbedder(),
    now: () => AT
  })

describe("readVectorCoverage", () => {
  let repo: FixtureRepo

  beforeEach(async () => {
    repo = await makeFixtureRepo()
    await repo.commit(corpus(10), "seed ten one-chunk memories")
  })

  afterEach(() => repo.cleanup())

  it("reads an index with zero chunks as fully covered", async () => {
    /**
     * Nothing to inflate and nothing the plane fails to reach: an empty store is healthy, a search
     * over it has no vector arm to misrank with, and a sleep over it has nothing to refuse.
     */
    const coverage = await withDb((db) => readVectorCoverage(db, EMBED_WATERMARK))
    expect(coverage).toEqual({ chunks: 0, embeddings: 0, coverage: 1, model: EMBED_WATERMARK })
  })

  it("reads a fully embedded index as 1, with the counts behind it", async () => {
    const coverage = await withDb((db) =>
      Effect.gen(function* () {
        yield* indexInto(db, repo).rebuild({ embed: true })
        return yield* readVectorCoverage(db, EMBED_WATERMARK)
      })
    )
    expect(coverage.chunks).toBe(10)
    expect(coverage.embeddings).toBe(10)
    expect(coverage.coverage).toBe(1)
    expect(coverage.model).toBe(EMBED_WATERMARK)
  })

  it("counts only vectors in the configured space: rows under another model do not count", async () => {
    /**
     * `embeddings` still holds ten rows afterwards, so a reader counting the table would say 1. The
     * predicate on `model` is what makes it say 0.6.
     */
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        yield* indexInto(db, repo).rebuild({ embed: true })
        yield* db.run(
          `UPDATE embeddings SET model = 'some-other-model@8'
           WHERE chunk_id IN (SELECT chunk_id FROM chunks ORDER BY chunk_id LIMIT 4)`
        )
        const rows = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        return { rows: rows?.n ?? 0, coverage: yield* readVectorCoverage(db, EMBED_WATERMARK) }
      })
    )
    expect(outcome.rows).toBe(10)
    expect(outcome.coverage.embeddings).toBe(6)
    expect(outcome.coverage.coverage).toBeCloseTo(0.6, 10)
  })

  it("reads deleted vectors as the ratio of what is left", async () => {
    const coverage = await withDb((db) =>
      Effect.gen(function* () {
        yield* indexInto(db, repo).rebuild({ embed: true })
        yield* db.run(
          `DELETE FROM embeddings
           WHERE chunk_id IN (SELECT chunk_id FROM chunks ORDER BY chunk_id LIMIT 8)`
        )
        return yield* readVectorCoverage(db, EMBED_WATERMARK)
      })
    )
    expect(coverage).toEqual({ chunks: 10, embeddings: 2, coverage: 0.2, model: EMBED_WATERMARK })
  })

  it("falls back to the STORED watermark when the caller names no space, and to null before any rebuild", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const before = yield* readVectorCoverage(db)
        yield* indexInto(db, repo).rebuild({ embed: true })
        return { before, after: yield* readVectorCoverage(db) }
      })
    )
    expect(outcome.before).toEqual({ chunks: 0, embeddings: 0, coverage: 1, model: null })
    expect(outcome.after).toEqual({
      chunks: 10,
      embeddings: 10,
      coverage: 1,
      model: EMBED_WATERMARK
    })
  })

  it("is published on the indexer under the indexer's own watermark, beside whether an embedder is bound", async () => {
    const outcome = await withDb((db) =>
      Effect.gen(function* () {
        const indexer = indexInto(db, repo)
        yield* indexer.rebuild({ embed: true })
        const bare = makeIndexer({
          db,
          git: repo.git,
          embedWatermark: EMBED_WATERMARK,
          embedDim: EMBED_DIM,
          now: () => AT
        })
        return {
          bound: indexer.embedderBound,
          unbound: bare.embedderBound,
          coverage: yield* indexer.vectorCoverage()
        }
      })
    )
    expect(outcome.bound).toBe(true)
    expect(outcome.unbound).toBe(false)
    expect(outcome.coverage.coverage).toBe(1)
  })
})

describe("the floors", () => {
  it("keeps the hard floor under the soft one, both inside (0, 1)", () => {
    expect(VECTOR_COVERAGE_HARD_FLOOR).toBeLessThan(VECTOR_COVERAGE_FLOOR)
    expect(VECTOR_COVERAGE_HARD_FLOOR).toBeGreaterThan(0)
    expect(VECTOR_COVERAGE_FLOOR).toBeLessThan(1)
  })

  it("describes a refusal with the ratio, the counts, the floor and the remedy", () => {
    const failure = new VectorCoverageLow(
      { chunks: 100, embeddings: 40, coverage: 0.4, model: EMBED_WATERMARK },
      VECTOR_COVERAGE_HARD_FLOOR
    )
    expect(failure._tag).toBe("VectorCoverageLow")
    expect(failure.reason).toContain("40%")
    expect(failure.reason).toContain("40 of 100")
    expect(failure.reason).toContain("0.5")
    expect(failure.reason).toContain("memhtml index embed")
    expect(failure.reason).toContain("memhtml index rebuild --embed")
    // Vectors exist, so the opt-out is not offered: this operator meant to embed.
    expect(failure.reason).not.toContain("MEMHTML_EMBED=off")
  })

  it("names MEMHTML_EMBED=off as well when the plane holds no vector at all", () => {
    const failure = new VectorCoverageLow(
      { chunks: 100, embeddings: 0, coverage: 0, model: EMBED_WATERMARK },
      VECTOR_COVERAGE_HARD_FLOOR
    )
    expect(failure.reason).toContain("0 of 100")
    expect(failure.reason).toContain("MEMHTML_EMBED=off")
  })

  it("prints a ratio just under the floor with a decimal rather than rounding it onto the floor", () => {
    expect(formatCoverage(0.949)).toBe("94.9%")
    expect(formatCoverage(0.4)).toBe("40%")
    expect(formatCoverage(1)).toBe("100%")
    expect(formatCoverage(0)).toBe("0%")
  })
})

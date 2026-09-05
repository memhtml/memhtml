import { VECTOR_COVERAGE_FLOOR } from "@memhtml/index"
import { ConfigProvider, Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { DatabaseService, layerRetrievalPolicy, RetrievalPolicy } from "../src/api-layer.js"
import type { DoctorReport } from "../src/doctor.js"
import { type Cli, makeCli, noEmbedder } from "./harness.js"

/**
 * Vector coverage on the three operator surfaces and the search door (issue #141).
 *
 * The production incident: `chunks` and `embeddings` sat side by side in `status` and nothing compared
 * them, so a plane at 2 percent coverage read as `embedderUp: true` and `healthy: true` while every
 * search returned the newest files. These tests thin the plane by SQL rather than through `index
 * rebuild --no-embed`, because the shape under test is the table's (few vectors, many chunks) and the
 * sibling fix for the rebuild path (issue #142) must not move what they measure.
 */

interface Written {
  readonly path: string
}

interface Status {
  readonly vectorCoverage: number
  readonly vectorCoverageFloor: number
  readonly embedderUp: boolean
  readonly chunks: number
  readonly embeddings: number
}

interface IndexStatus {
  readonly vectorCoverage: number
  readonly vectorCoverageFloor: number
  readonly chunks: number
  readonly embeddings: number
}

interface Search {
  readonly hits: ReadonlyArray<{ readonly path: string }>
  readonly degraded: boolean
  readonly vectorCoverage: number
  readonly arms: ReadonlyArray<string>
}

const TARGET_TITLE = "Quillhaven owns the billing ledger"

/** Five one-chunk memories; the first carries a proper noun nothing else does. */
const seed = async (cli: Cli): Promise<ReadonlyArray<string>> => {
  const titles = [
    TARGET_TITLE,
    "The rollout window opens on Tuesday",
    "The metrics agent scrapes every exporter each minute",
    "Blue-green deploys are safe to abandon",
    "The replay window is open for a week"
  ]
  const paths: Array<string> = []
  for (const title of titles) {
    const written = await cli.json<Written>([
      "write",
      "--type",
      "semantic",
      "--title",
      title,
      "--claim",
      `${title}, as observed on the platform.`,
      "--workspace",
      "coverage-fixture"
    ])
    paths.push(written.path)
  }
  return paths
}

/** Delete every vector except those on `keep`, so the plane is sparse in one file's favour. */
const keepVectorsOnly = (cli: Cli, keep: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      yield* db.run(
        "DELETE FROM embeddings WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks WHERE path = ?)",
        [keep]
      )
    }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
  )

describe("doctor, status and index status report vector coverage", () => {
  let cli: Cli
  let paths: ReadonlyArray<string>

  beforeAll(async () => {
    cli = await makeCli()
    paths = await seed(cli)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("reads a fully embedded store as covered and healthy, with the floor beside the ratio", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.vectorCoverage).toBe(1)
    expect(report.vectorCoverageFloor).toBe(VECTOR_COVERAGE_FLOOR)
    expect(report.vectorCoverageLow).toBe(false)
    expect(report.vectorCoverageRemedy).toBeNull()
    expect(report.chunks).toBeGreaterThan(0)
    expect(report.embeddings).toBe(report.chunks)
    expect(report.healthy).toBe(true)

    const status = await cli.json<Status>(["status"])
    expect(status.vectorCoverage).toBe(1)
    expect(status.vectorCoverageFloor).toBe(VECTOR_COVERAGE_FLOOR)

    const index = await cli.json<IndexStatus>(["index", "status"])
    expect(index.vectorCoverage).toBe(1)
    expect(index.vectorCoverageFloor).toBe(VECTOR_COVERAGE_FLOOR)

    const search = await cli.json<Search>(["search", "Quillhaven"])
    expect(search.degraded).toBe(false)
    expect(search.vectorCoverage).toBe(1)
    expect(search.arms).toContain("vector")
  })

  it("flags a sparse plane on all three surfaces, names the remedy, and search drops the arm", async () => {
    const kept = paths[1]
    if (kept === undefined) throw new Error("the fixture wrote fewer than two memories")
    await keepVectorsOnly(cli, kept)

    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.embeddings).toBeGreaterThan(0)
    expect(report.embeddings).toBeLessThan(report.chunks)
    expect(report.vectorCoverage).toBeCloseTo(report.embeddings / report.chunks, 10)
    expect(report.vectorCoverage).toBeLessThan(VECTOR_COVERAGE_FLOOR)
    expect(report.vectorCoverageLow).toBe(true)
    expect(report.healthy).toBe(false)
    expect(report.vectorCoverageRemedy).toContain("memhtml index embed")
    expect(report.vectorCoverageRemedy).toContain("memhtml index rebuild --embed")
    // The finding is the only thing wrong: the store is otherwise the clean one the first case read.
    expect(report.dangling).toEqual([])
    expect(report.indexFresh).toBe(true)
    expect(report.embedModelMatches).toBe(true)

    const status = await cli.json<Status>(["status"])
    expect(status.vectorCoverage).toBe(report.vectorCoverage)
    // `embedderUp` is satisfied by ONE vector in the right space: this is the number it cannot say.
    expect(status.embedderUp).toBe(true)

    const index = await cli.json<IndexStatus>(["index", "status"])
    expect(index.vectorCoverage).toBe(report.vectorCoverage)

    const search = await cli.json<Search>(["search", "Quillhaven"])
    expect(search.degraded).toBe(true)
    expect(search.vectorCoverage).toBe(report.vectorCoverage)
    expect(search.arms).not.toContain("vector")
    expect(search.hits[0]?.path).toBe(paths[0])
  })
})

describe("the floor moves with the policy", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli({ vectorCoverageFloor: 0.1 })
    const paths = await seed(cli)
    const kept = paths[1]
    if (kept === undefined) throw new Error("the fixture wrote fewer than two memories")
    await keepVectorsOnly(cli, kept)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("reads the same sparse plane as healthy and keeps the arm when the floor sits under it", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.vectorCoverage).toBeLessThan(VECTOR_COVERAGE_FLOOR)
    expect(report.vectorCoverageFloor).toBe(0.1)
    expect(report.vectorCoverageLow).toBe(false)
    expect(report.healthy).toBe(true)

    const status = await cli.json<Status>(["status"])
    expect(status.vectorCoverageFloor).toBe(0.1)

    const search = await cli.json<Search>(["search", "Quillhaven"])
    expect(search.degraded).toBe(false)
    expect(search.arms).toContain("vector")
  })
})

describe("an embedder-less store is the lexical-only configuration, not a sparse plane", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli({ embedder: noEmbedder() })
    await seed(cli)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("reports coverage 0 and stays healthy on doctor, status and index status", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.chunks).toBeGreaterThan(0)
    expect(report.embeddings).toBe(0)
    expect(report.vectorCoverage).toBe(0)
    expect(report.vectorCoverageLow).toBe(false)
    expect(report.vectorCoverageRemedy).toBeNull()
    expect(report.healthy).toBe(true)

    const status = await cli.json<Status>(["status"])
    expect(status.vectorCoverage).toBe(0)
    expect(status.embedderUp).toBe(false)

    const index = await cli.json<IndexStatus>(["index", "status"])
    expect(index.vectorCoverage).toBe(0)

    // Every search on it is honestly degraded, and the ratio says why.
    const search = await cli.json<Search>(["search", "Quillhaven"])
    expect(search.degraded).toBe(true)
    expect(search.vectorCoverage).toBe(0)
  })
})

/**
 * `MEMHTML_VECTOR_COVERAGE_FLOOR` through the composition root. Every case injects its environment
 * through `ConfigProvider`, because `effect/Config` snapshots `process.env` at module load.
 */
const floorUnder = (env: Record<string, string>): Promise<number> =>
  Effect.runPromise(
    Effect.provideService(
      Effect.gen(function* () {
        return (yield* RetrievalPolicy).vectorCoverageFloor
      }).pipe(Effect.provide(layerRetrievalPolicy)),
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env })
    ) as Effect.Effect<number, never, never>
  )

describe("layerRetrievalPolicy", () => {
  it("defaults to the shared constant", async () => {
    expect(await floorUnder({})).toBe(VECTOR_COVERAGE_FLOOR)
  })

  it("reads a floor in (0, 1]", async () => {
    expect(await floorUnder({ MEMHTML_VECTOR_COVERAGE_FLOOR: "0.8" })).toBe(0.8)
    expect(await floorUnder({ MEMHTML_VECTOR_COVERAGE_FLOOR: "1" })).toBe(1)
  })

  it("reads an empty value as absent, the way MEMHTML_EMBED does", async () => {
    expect(await floorUnder({ MEMHTML_VECTOR_COVERAGE_FLOOR: "" })).toBe(VECTOR_COVERAGE_FLOOR)
  })

  it.each(["0", "-0.5", "1.5", "abc"])(
    "dies on %j rather than switching the gate off silently",
    async (raw) => {
      await expect(floorUnder({ MEMHTML_VECTOR_COVERAGE_FLOOR: raw })).rejects.toThrow()
    }
  )
})

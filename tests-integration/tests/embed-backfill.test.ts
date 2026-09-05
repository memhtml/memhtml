import { DatabaseService, type DatabaseShape } from "@memhtml/index"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"
import { runBuilt } from "./spawned.js"

/**
 * Issue #142, through both doors: the in-process CLI with a fake embedder, and the BUILT binary with
 * no embedder at all.
 *
 * The incident: `index rebuild --no-embed` was run against a live store, and ten hours of
 * `index update --embed` passes then left 183 embeddings under 9,332 chunks, because an update embeds
 * only its own batch's chunks and nothing revisits a chunk that lost its vector. Three contracts hold
 * it now. A rebuild preserves every vector whose content-addressed chunk id survives it. A bare
 * `--no-embed` rebuild over a store that carries vectors is refused and says how many. And
 * `memhtml index embed` closes a store-wide gap without a rebuild.
 */

/** One query against the store's own database, through the app layer. */
const query = <A>(cli: Cli, body: (db: DatabaseShape) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      return yield* body(db)
    }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
  ) as Promise<A>

/** Every vector, keyed by chunk id, as hex so a comparison is exact and readable when it fails. */
const vectorSnapshot = (cli: Cli): Promise<ReadonlyArray<readonly [string, string]>> =>
  query(cli, (db) =>
    db
      .all<{ chunk_id: string; vec: Uint8Array }>(
        "SELECT chunk_id, vec FROM embeddings ORDER BY chunk_id"
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => [row.chunk_id, Buffer.from(row.vec).toString("hex")] as const)
        )
      )
  )

const embeddingCount = (cli: Cli): Promise<number> =>
  query(cli, (db) =>
    db
      .get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
      .pipe(Effect.map((row) => row?.n ?? 0))
  )

const hasVector = (cli: Cli, chunkId: string): Promise<boolean> =>
  query(cli, (db) =>
    db
      .get<{ n: number }>("SELECT count(*) AS n FROM embeddings WHERE chunk_id = ?", [chunkId])
      .pipe(Effect.map((row) => (row?.n ?? 0) > 0))
  )

interface EmbedReport {
  readonly mode: string
  readonly headSha: string | null
  readonly chunks: number
  readonly embeddings: number
  readonly embeddingsWritten: number
  readonly embeddingsRemaining: number
}

describe("issue #142: rebuild keeps vectors, --no-embed is interlocked, index embed backfills", () => {
  let cli: Cli
  let seeded: number

  beforeAll(async () => {
    cli = await makeCli()
    // Three writes, each an `update --embed` through the write path, so the store carries vectors
    // the way a live store does: embedded on purpose, one batch at a time.
    await writeMemory(cli, {
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."]
    })
    await writeMemory(cli, {
      title: "Reverting without draining strands connections",
      claim: "A bare revert strands in-flight connections on the retired target group.",
      type: "error_pattern"
    })
    await writeMemory(cli, {
      title: "The metrics agent scrapes every exporter each minute",
      claim: "The metrics agent scrapes every exporter once each minute.",
      type: "semantic"
    })
    seeded = await embeddingCount(cli)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("carries vectors before anything is rebuilt, so the assertions below are not vacuous", () => {
    expect(seeded).toBeGreaterThan(0)
  })

  it("refuses a bare --no-embed rebuild with the new code, exit 1, and the count in the prose", async () => {
    const result = await cli.run(["index", "rebuild", "--no-embed"])
    const body = JSON.parse(result.stdout) as {
      readonly code?: string
      readonly error?: string
      readonly suggestions?: ReadonlyArray<string>
    }
    expect(result.exitCode).toBe(1)
    expect(body.code).toBe("ERR_REBUILD_NO_EMBED_REFUSED")
    expect(body.error).toContain(`${String(seeded)} embedding`)
    expect(body.suggestions?.length ?? 0).toBeGreaterThan(0)
    // Refused means untouched.
    expect(await embeddingCount(cli)).toBe(seeded)
  })

  it("logs a WARN naming the count on stderr, through the built binary with no embedder configured", async () => {
    // `MEMHTML_EMBED=off` in the child is the harness's own configuration, and it is exactly the
    // configuration the incident ran under. The interlock reads the table, not the embedder.
    const spawned = await runBuilt(cli.root, ["index", "rebuild", "--no-embed"])
    expect(spawned.exitCode).toBe(1)
    const body = JSON.parse(spawned.stdout) as { readonly code?: string }
    expect(body.code).toBe("ERR_REBUILD_NO_EMBED_REFUSED")
    expect(spawned.stderr).toMatch(/WARN/)
    expect(spawned.stderr).toContain(`${String(seeded)} embedding`)
    expect(await embeddingCount(cli)).toBe(seeded)
  })

  it("refuses a bare index rebuild through the built binary when MEMHTML_EMBED=off, the incident's own spelling", async () => {
    // `--embed` is the default, and with no embedder it can write no vector, so it is held to the
    // same interlock as `--no-embed`: the harness variable must not be able to do by accident what
    // the flag is refused for.
    const spawned = await runBuilt(cli.root, ["index", "rebuild"])
    expect(spawned.exitCode).toBe(1)
    const body = JSON.parse(spawned.stdout) as { readonly code?: string; readonly error?: string }
    expect(body.code).toBe("ERR_REBUILD_NO_EMBED_REFUSED")
    expect(body.error).toContain("MEMHTML_EMBED=off")
    expect(spawned.stderr).toMatch(/WARN/)
    expect(await embeddingCount(cli)).toBe(seeded)
  })

  it("proceeds under --force and preserves every vector byte for byte", async () => {
    const before = await vectorSnapshot(cli)
    const report = await cli.json<{
      readonly embeddingsPreserved: number
      readonly embeddingsWritten: number
    }>(["index", "rebuild", "--no-embed", "--force"])
    expect(report.embeddingsPreserved).toBe(seeded)
    expect(report.embeddingsWritten).toBe(0)
    expect(await vectorSnapshot(cli)).toEqual(before)
  })

  it("preserves the vectors on a --embed rebuild too, writing none", async () => {
    const before = await vectorSnapshot(cli)
    const report = await cli.json<{
      readonly embeddingsPreserved: number
      readonly embeddingsWritten: number
    }>(["index", "rebuild", "--embed"])
    expect(report.embeddingsPreserved).toBe(seeded)
    expect(report.embeddingsWritten).toBe(0)
    expect(await vectorSnapshot(cli)).toEqual(before)
  })

  it("index update --embed never revisits a chunk that lost its vector; index embed does", async () => {
    const [victim] = await vectorSnapshot(cli)
    const victimId = victim?.[0] ?? ""
    expect(victimId).not.toBe("")
    // The incident's shape: a chunk row with no vector under it.
    await query(cli, (db) => db.run("DELETE FROM embeddings WHERE chunk_id = ?", [victimId]))
    expect(await hasVector(cli, victimId)).toBe(false)

    // An unrelated write runs `update --embed`, scoped to its own chunk.
    await writeMemory(cli, {
      title: "An unrelated new memory lands after the vector was lost",
      claim: "A new fact lands after the vector was lost.",
      type: "semantic"
    })
    expect(await hasVector(cli, victimId)).toBe(false)

    const dry = await cli.json<EmbedReport>(["index", "embed", "--dry-run"])
    expect(dry.mode).toBe("embed")
    expect(dry.embeddingsWritten).toBe(0)
    expect(dry.embeddingsRemaining).toBe(1)
    expect(dry.chunks).toBe(seeded + 1)
    expect(dry.embeddings).toBe(seeded)
    expect(await hasVector(cli, victimId)).toBe(false)

    const wet = await cli.json<EmbedReport>(["index", "embed"])
    expect(wet.mode).toBe("embed")
    expect(wet.embeddingsWritten).toBe(1)
    expect(wet.embeddingsRemaining).toBe(0)
    expect(wet.chunks).toBe(seeded + 1)
    expect(wet.embeddings).toBe(seeded + 1)
    expect(wet.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await hasVector(cli, victimId)).toBe(true)

    // Safe to rerun.
    const again = await cli.json<EmbedReport>(["index", "embed"])
    expect(again.embeddingsWritten).toBe(0)
    expect(again.embeddingsRemaining).toBe(0)
  })

  it("index embed with no embedder configured writes nothing and reports the gap honestly", async () => {
    const [victim] = await vectorSnapshot(cli)
    const victimId = victim?.[0] ?? ""
    await query(cli, (db) => db.run("DELETE FROM embeddings WHERE chunk_id = ?", [victimId]))

    const spawned = await runBuilt(cli.root, ["index", "embed"])
    expect(spawned.exitCode).toBe(0)
    const body = JSON.parse(spawned.stdout) as { readonly type: string; readonly data: EmbedReport }
    expect(body.type).toBe("index.report")
    expect(body.data.mode).toBe("embed")
    expect(body.data.embeddingsWritten).toBe(0)
    expect(body.data.embeddingsRemaining).toBe(1)
    expect(await hasVector(cli, victimId)).toBe(false)

    // The in-process embedder closes it, so the suite leaves the store whole.
    const closed = await cli.json<EmbedReport>(["index", "embed"])
    expect(closed.embeddingsWritten).toBe(1)
    expect(closed.embeddingsRemaining).toBe(0)
  })
})

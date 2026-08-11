import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { DatabaseService, type DatabaseShape, STATE_SCHEMA } from "@memhtml/index"
import { STATE_SIDECAR_PATH } from "@memhtml/store"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli, writeMemory } from "./harness.js"

/**
 * The plan's verification item 6, second half: **the rebuildability contract.**
 *
 * `rm index.db && memhtml index rebuild && memhtml state import` must reproduce the whole system. That is the
 * claim the entire design rests on — it is why an authored edge is a `<link>` in a file rather than a
 * row, why the state plane has a committed JSONL sidecar, and why `index.db` is gitignored at all. A
 * rebuild that lost rows would make every one of those decisions wrong.
 *
 * Compared as a ROW SET rather than by counts. A count comparison passes when a cascade drops one row
 * and a rename duplicates another, which is exactly the class of bug this exists to catch.
 */

/** One table's whole contents, canonically ordered, as comparable strings. */
const snapshot = (
  db: DatabaseShape,
  table: string,
  columns: ReadonlyArray<string>,
  order: string
): Effect.Effect<ReadonlyArray<string>, never, never> =>
  db
    .all<Record<string, unknown>>(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${order}`)
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => columns.map((column) => String(row[column] ?? "")).join(""))
      ),
      Effect.orElseSucceed(() => [])
    )

/**
 * Every table a rebuild touches, with the columns whose VALUES must survive it.
 *
 * `indexed_at` is deliberately absent from `files`: it records when the projection ran, so a rebuild
 * legitimately moves it and comparing it would make the contract unassertable. `blob_sha` IS compared —
 * it is the indexer's change key, and a rebuild that re-derived a different one would mean the
 * incremental path and the full path disagree about what they read.
 */
const TABLES: ReadonlyArray<{
  readonly table: string
  readonly columns: ReadonlyArray<string>
  readonly order: string
}> = [
  {
    table: "files",
    columns: [
      "path",
      "blob_sha",
      "content_hash",
      "memory_type",
      "title",
      "gist",
      "fts_text",
      "disclosure_text",
      "para",
      "workspace",
      "confidence",
      "importance",
      "archived",
      "origin_path",
      "word_count",
      "created_at",
      "updated_at",
      "event_at",
      "session_id"
    ],
    order: "path"
  },
  { table: "file_tags", columns: ["path", "tag"], order: "path, tag" },
  {
    table: "file_entities",
    columns: ["path", "entity_type", "entity_name"],
    order: "path, entity_type, entity_name"
  },
  { table: "file_facets", columns: ["path", "name", "value"], order: "path, name, value" },
  { table: "file_citations", columns: ["path", "text"], order: "path, text" },
  {
    table: "chunks",
    columns: ["chunk_id", "path", "content_hash", "ordinal", "char_count"],
    order: "chunk_id"
  },
  {
    table: "edges",
    columns: ["src_path", "rel", "dst_path", "edge_class", "derived", "provenance"],
    order: "src_path, rel, dst_path"
  }
]

/** Read every table's snapshot through the app layer. */
const snapshotAll = (cli: Cli) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      const out: Record<string, ReadonlyArray<string>> = {}
      for (const spec of TABLES) {
        out[spec.table] = yield* snapshot(db, spec.table, spec.columns, spec.order)
      }
      out.access = yield* snapshot(
        db,
        `${STATE_SCHEMA}.access`,
        ["path", "access_count", "reinforcement_count"],
        "path"
      )
      return out
    }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
  )

describe("verification item 6 — rm index.db, rebuild, state import reproduces the system", () => {
  let cli: Cli
  let before: Record<string, ReadonlyArray<string>>

  beforeAll(async () => {
    cli = await makeCli()

    /**
     * A corpus built the INCREMENTAL way — one write, one correction, one archive, one link at a time —
     * because that is the path a rebuild has to reproduce. Seeding the tree and rebuilding once would
     * compare a rebuild against itself.
     */
    const first = await writeMemory(cli, {
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."],
      workspace: "checkout-api",
      tags: ["deploy", "oncall"],
      entities: ["service:checkout-api", "person:sanju"],
      sessionId: "cccccccc-3333-4333-8333-cccccccccccc"
    })

    const second = await writeMemory(cli, {
      title: "Reverting without draining strands connections",
      claim: "A bare revert strands in-flight connections on the retired target group.",
      type: "error_pattern",
      workspace: "checkout-api"
    })

    await cli.json(["link", first.path, "caused_by", second.path])

    // A correction: an add AND a rename in one commit, which is the case `indexPaths` cannot express.
    await cli.json([
      "correct",
      first.path,
      "--title",
      "Prod rollbacks drain the VIP and wait for connection bleed",
      "--claim",
      "Drain the VIP and wait for the bleed to finish before reverting.",
      "--reason",
      "the original omitted the bleed wait"
    ])

    const third = await writeMemory(cli, {
      title: "The metrics agent scrapes every exporter each minute",
      claim: "The metrics agent scrapes every exporter once each minute.",
      type: "semantic",
      tags: ["observability"]
    })
    await cli.json(["archive", third.path, "--reason", "superseded by the new cadence"])

    // Access history, so the state plane has something the sidecar must carry across the rebuild.
    await cli.json(["search", "drain the vip before reverting"])
    await cli.json(["reinforce", second.path, "--signal", "positive"])

    // The sidecar is what survives; `state.db` is gitignored and is NOT rebuildable from git.
    await cli.json(["state", "export"])

    before = await snapshotAll(cli)
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("carries a non-trivial corpus, so the comparison is not vacuous", () => {
    // Guard against the comparison passing because both sides are empty — the failure mode that makes a
    // reproducibility test look green while proving nothing.
    expect((before.files ?? []).length).toBeGreaterThan(3)
    expect((before.edges ?? []).length).toBeGreaterThan(0)
    expect((before.chunks ?? []).length).toBeGreaterThan(3)
    expect((before.file_tags ?? []).length).toBeGreaterThan(0)
    expect((before.file_entities ?? []).length).toBeGreaterThan(0)
    expect((before.access ?? []).length).toBeGreaterThan(0)
  })

  it("committed the state sidecar, which is the only durable copy of that plane", async () => {
    const sidecar = await readFile(join(cli.root, STATE_SIDECAR_PATH), "utf8")
    expect(sidecar.trim().length).toBeGreaterThan(0)
    // JSONL, path-ordered, one object per line: `git diff` on it reads as one line per changed memory.
    for (const line of sidecar.trim().split("\n")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
    // And it is IN the tree, not merely on disk.
    const tracked = await cli.git("ls-files", "--", STATE_SIDECAR_PATH)
    expect(tracked.trim()).toBe(STATE_SIDECAR_PATH)
  })

  it("reproduces every row set after both databases are deleted", async () => {
    /**
     * BOTH databases deleted, which is the real test: `index.db` is a projection of git and rebuilds
     * from the tree, and `state.db` rebuilds only from the committed sidecar. Deleting just the index
     * would leave the state plane intact and the harder half of the claim untested.
     */
    for (const file of ["index.db", "state.db"]) {
      await rm(join(cli.root, ".memhtml", file), { force: true })
      await rm(join(cli.root, ".memhtml", `${file}-wal`), { force: true })
      await rm(join(cli.root, ".memhtml", `${file}-shm`), { force: true })
    }

    await cli.json(["index", "rebuild", "--embed"])
    await cli.json(["state", "import"])

    const after = await snapshotAll(cli)

    for (const spec of TABLES) {
      expect(after[spec.table], `${spec.table} row set`).toEqual(before[spec.table])
    }
    // The state plane too, which git cannot reproduce and the sidecar can.
    expect(after.access).toEqual(before.access)
  })

  it("keeps the archived memory archived, with its origin path", async () => {
    // The archive mapping is injective and `originalPathFor` inverts it, so a rebuild reading the tree
    // alone must reach the same `archived`/`origin_path` values — no similarity score is consulted.
    const archived = await cli.json<{
      readonly files: ReadonlyArray<{ readonly path: string; readonly archived: boolean }>
    }>(["list", "--include-archived", "--para", "archive"])
    expect(archived.files.length).toBeGreaterThan(0)
    for (const file of archived.files) expect(file.archived).toBe(true)
  })

  it("still finds the corpus after the rebuild, with the vector arm firing", async () => {
    // A row-set match with a broken index would be a rebuild that reproduced the data and not the
    // capability. `--embed` refilled the vectors, so all four arms must be back.
    const hits = await cli.json<{
      readonly hits: ReadonlyArray<{ readonly path: string }>
      readonly degraded: boolean
      readonly arms: ReadonlyArray<string>
    }>(["search", "drain the vip and wait for the bleed"])
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.degraded).toBe(false)
    expect(hits.arms).toContain("vector")
    expect(hits.arms).toContain("salience")
  })

  it("reports the index fresh at HEAD after the rebuild", async () => {
    const status = await cli.json<{
      readonly indexFresh: boolean
      readonly headSha: string | null
    }>(["status"])
    expect(status.indexFresh).toBe(true)
    expect(status.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it("doctor is clean on the rebuilt corpus", async () => {
    // The composed assertion: a rebuild that dropped an edge shows up as a dangling href, and one that
    // lost the sidecar shows up as an orphan access row. Doctor reads both.
    const report = await cli.json<{
      readonly dangling: ReadonlyArray<unknown>
      readonly orphanAccessRows: ReadonlyArray<string>
      readonly indexFresh: boolean
      readonly healthy: boolean
    }>(["doctor"])
    expect(report.dangling).toEqual([])
    expect(report.orphanAccessRows).toEqual([])
    expect(report.indexFresh).toBe(true)
    expect(report.healthy).toBe(true)
  })
})

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { STATE_SCHEMA } from "@memhtml/index"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { DatabaseService } from "../src/api-layer.js"
import { EXIT_OK, EXIT_RUNTIME } from "../src/envelope.js"
import { type Cli, failingEmbedder, makeCli, noEmbedder } from "./harness.js"

/**
 * The end-to-end contract: write → search → recall → correct → archive → status, all through
 * `run(argv)` against a real temp git repo, real migrations, and a deterministic embedder.
 *
 * Everything below goes through the SAME `run` an operator invokes and the SAME layer graph
 * production builds. That is deliberate and it is the standing lesson of this repo: a stateless fake
 * verifies the shape of a call and misses the state semantics behind it, and every assertion here is
 * about state crossing three planes — a file in git, a row in SQL, a vector in the same row's chunk.
 * Five real bugs in this fleet have lived in exactly that gap.
 */

interface Written {
  readonly path: string
  readonly created: boolean
  readonly deduped: boolean
  readonly existingPath: string | undefined
  readonly commitSha: string | null
  readonly contentHash: string
}

interface Hits {
  readonly hits: ReadonlyArray<{
    readonly path: string
    readonly gist: string
    readonly entities: ReadonlyArray<string>
  }>
  readonly degraded: boolean
  readonly arms: ReadonlyArray<string>
  readonly entityScope: string | null
  readonly scopeEmpty: boolean
}

describe("the write path, end to end", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("writes a memory, placing it by the PARA rules and committing it", async () => {
    const written = await cli.json<Written>([
      "write",
      "--type",
      "procedural",
      "--title",
      "Prod rollbacks drain the VIP before the deploy is reverted",
      "--claim",
      "Drain the VIP before reverting the deploy.",
      "--body",
      "The revert alone leaves in-flight connections pinned to the old target group.",
      "--workspace",
      "checkout-api",
      "--tag",
      "deploy",
      "--tag",
      "oncall",
      "--entity",
      "service:checkout-api",
      "--session-id",
      "f7e32699-d45b-4248-8ae6-894dfc606f49"
    ])

    expect(written.created).toBe(true)
    expect(written.deduped).toBe(false)
    // Rule 4: a named workspace routes to `projects/<slug>/`, and the type is timeless so the
    // filename carries no date prefix.
    expect(written.path).toMatch(
      /^projects\/checkout-api\/prod-rollbacks-drain-the-vip[^/]*\.html$/
    )
    expect(written.commitSha).not.toBeNull()

    // The file is on disk AND in the commit. A write that left the tree dirty would mean the index
    // describes a state git does not have.
    const html = await readFile(join(cli.root, written.path), "utf8")
    expect(html).toContain("<mark>Drain the VIP before reverting the deploy.</mark>")
    expect(html).toContain('name="memhtml-session"')
  })

  it("finds the memory it just wrote, with the vector arm firing", async () => {
    const result = await cli.json<Hits>(["search", "drain the vip before reverting"])
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.path).toMatch(/prod-rollbacks-drain-the-vip/)
    expect(result.degraded).toBe(false)
    // All four arms: the fake embedder gives the vector arm a real vector, the corpus gives FTS a
    // term, and the state plane is attached so salience joins.
    expect(result.arms).toContain("fts")
    expect(result.arms).toContain("vector")
  })

  it("survives a query that is a hard MATCH syntax error as raw text", async () => {
    /**
     * `don't` is "Syntax Error: don't" on this driver and `service:checkout-api` is
     * "Field does not exist" — both are HARD errors, not empty results, and both are ordinary agent
     * prose. Retrieval sanitizes before MATCH, so these must be answers rather than failures.
     */
    for (const query of ["don't revert the deploy", "service:checkout-api rollback", "-zebra"]) {
      const result = await cli.run(["search", query])
      expect(result.exitCode).toBe(EXIT_OK)
      expect(JSON.parse(result.stdout).type).toBe("memory.hits")
    }
  })

  it("recalls a pack under a budget, with the claim quoted", async () => {
    const pack = await cli.json<{
      readonly memories: { readonly disclosed: ReadonlyArray<{ readonly gist: string }> }
      readonly spentChars: number
      readonly degraded: boolean
    }>(["recall", "vip drain rollback"])
    expect(pack.memories.disclosed.length).toBeGreaterThan(0)
    expect(pack.memories.disclosed[0]?.gist).toContain("Drain the VIP")
    expect(pack.spentChars).toBeGreaterThan(0)
  })

  it("returns the existing path on a byte-identical rewrite, creating no file and no commit", async () => {
    const before = await cli.json<{ readonly headSha: string | null }>(["status"])

    const again = await cli.json<Written>([
      "write",
      "--type",
      "procedural",
      "--title",
      "Prod rollbacks drain the VIP before the deploy is reverted",
      "--claim",
      "Drain the VIP before reverting the deploy.",
      "--body",
      "The revert alone leaves in-flight connections pinned to the old target group.",
      "--workspace",
      "checkout-api",
      "--tag",
      "deploy",
      "--tag",
      "oncall",
      "--entity",
      "service:checkout-api"
    ])

    expect(again.deduped).toBe(true)
    expect(again.created).toBe(false)
    expect(again.existingPath).toMatch(/prod-rollbacks-drain-the-vip/)
    expect(again.commitSha).toBeNull()

    // The tree is byte-identical: no new commit, and nothing dirty. A dedupe that wrote first and
    // rolled back would show up here as a moved HEAD or a dirty path.
    const after = await cli.json<{ readonly headSha: string | null; readonly dirty: boolean }>([
      "status"
    ])
    expect(after.headSha).toBe(before.headSha)
    expect(after.dirty).toBe(false)
  })

  it("links two memories with an authored edge, written into the source file", async () => {
    const second = await cli.json<Written>([
      "write",
      "--type",
      "error_pattern",
      "--title",
      "Reverting without draining strands connections",
      "--claim",
      "A bare revert strands in-flight connections on the retired target group.",
      "--workspace",
      "checkout-api"
    ])
    const first = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list",
      "--workspace",
      "checkout-api"
    ])
    const source = first.files.find((file) => file.path.includes("prod-rollbacks"))?.path
    expect(source).toBeDefined()

    const linked = await cli.json<{ readonly rel: string; readonly commitSha: string | null }>([
      "link",
      source as string,
      "caused_by",
      second.path
    ])
    expect(linked.rel).toBe("caused_by")
    expect(linked.commitSha).not.toBeNull()

    // File-borne, not only indexed. An edge that lived in the database alone would not survive
    // `rm index.db`, which is the whole reason an authored edge is a `<link>`.
    const html = await readFile(join(cli.root, source as string), "utf8")
    expect(html).toContain('rel="memhtml-caused-by"')

    // And indexed, so the graph query finds it.
    const neighbors = await cli.json<{
      readonly nodes: ReadonlyArray<{ readonly path: string; readonly hop: number }>
    }>(["neighbors", source as string])
    expect(neighbors.nodes.some((node) => node.path === second.path)).toBe(true)
    expect(neighbors.nodes.every((node) => node.hop >= 1)).toBe(true)
  })

  it("reads the edge from the other side too: an inbound edge is still a neighbour", async () => {
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list",
      "--workspace",
      "checkout-api"
    ])
    const target = listed.files.find((file) => file.path.includes("reverting-without-draining"))
    expect(target).toBeDefined()

    /**
     * The load-bearing direction. Only the SOURCE file holds the `<link>`, so a neighbourhood that
     * walked outbound edges alone would tell a superseding memory about its target and hide from the
     * target that it had been superseded.
     */
    const neighbors = await cli.json<{
      readonly nodes: ReadonlyArray<{ readonly path: string }>
    }>(["neighbors", target?.path as string])
    expect(neighbors.nodes.some((node) => node.path.includes("prod-rollbacks"))).toBe(true)
  })

  it("corrects a memory: the new file and the archived target land in one commit", async () => {
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list",
      "--workspace",
      "checkout-api"
    ])
    const target = listed.files.find((file) => file.path.includes("prod-rollbacks"))?.path
    expect(target).toBeDefined()

    const corrected = await cli.json<{
      readonly path: string
      readonly archivedPath: string
      readonly commitSha: string | null
    }>([
      "correct",
      target as string,
      "--title",
      "Prod rollbacks drain the VIP and wait for connection bleed",
      "--claim",
      "Drain the VIP and wait for the bleed to finish before reverting.",
      "--reason",
      "the original omitted the bleed wait"
    ])

    expect(corrected.archivedPath).toMatch(/^archive\/\d{4}\//)
    expect(corrected.commitSha).not.toBeNull()

    // The superseding file points at the target's ARCHIVE path, which is where the file is once the
    // commit lands. Pointing at the pre-archive path would dangle in the very commit that moved it.
    const html = await readFile(join(cli.root, corrected.path), "utf8")
    expect(html).toContain(`rel="memhtml-supersedes" href="/${corrected.archivedPath}"`)

    // The archived file carries the back-pointer and the stamps.
    const archived = await readFile(join(cli.root, corrected.archivedPath), "utf8")
    expect(archived).toContain('name="memhtml-status" content="archived"')
    expect(archived).toContain('name="memhtml-superseded-by"')

    // The index followed the move: the old path is gone, the archive path is present and archived.
    const active = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list"
    ])
    expect(active.files.some((file) => file.path === target)).toBe(false)

    const withArchived = await cli.json<{
      readonly files: ReadonlyArray<{ readonly path: string; readonly archived: boolean }>
    }>(["list", "--include-archived"])
    const archivedRow = withArchived.files.find((file) => file.path === corrected.archivedPath)
    expect(archivedRow?.archived).toBe(true)
  })

  it("reinforces a path, then holds the second bump behind the cooldown", async () => {
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list"
    ])
    const path = listed.files[0]?.path
    expect(path).toBeDefined()

    /**
     * The FIRST call bumps, and that is now assertable exactly rather than as a partition.
     *
     * It used to be neither: `search` and `recall` above bumped every path they returned, so this path
     * may or may not have been inside the 900-second window by the time the test ran and the only
     * honest assertion was that the two arrays partitioned the input. Retrieval no longer touches the
     * plane at all — salience moves on a chosen open or a named outcome — so nothing before this line
     * has bumped anything and the first call is unambiguously the first.
     */
    const first = await cli.json<{
      readonly bumped: ReadonlyArray<string>
      readonly cooledDown: ReadonlyArray<string>
      readonly signal: string
    }>(["reinforce", path as string, "--signal", "positive"])
    expect(first.signal).toBe("positive")
    expect(first.bumped).toEqual([path])
    expect(first.cooledDown).toEqual([])

    const second = await cli.json<{
      readonly bumped: ReadonlyArray<string>
      readonly cooledDown: ReadonlyArray<string>
    }>(["reinforce", path as string, "--signal", "positive"])
    // Immediately after any bump, the window holds. This is what stops a loop in an agent from
    // rewriting the corpus's ranking by replaying one query.
    expect(second.bumped).toEqual([])
    expect(second.cooledDown).toEqual([path])
  })

  it("archives a memory as a rename into archive/, never a delete", async () => {
    const written = await cli.json<Written>([
      "write",
      "--type",
      "episodic",
      "--title",
      "The checkout deploy on the second was rolled back twice",
      "--claim",
      "Two consecutive rollbacks of the same deploy on 2026-08-02."
    ])
    // Rule 6: an episodic memory with no workspace and no tag lands in the inbox, date-prefixed.
    expect(written.path).toMatch(/^areas\/inbox\/\d{8}-/)

    const archived = await cli.json<{
      readonly path: string
      readonly archivePath: string
    }>(["archive", written.path, "--reason", "superseded by the incident review"])

    expect(archived.archivePath).toBe(
      `archive/2026/${written.path}`.replace(
        "archive/2026/",
        `archive/${new Date().getUTCFullYear()}/`
      )
    )

    // Nothing is deleted: the file is readable at its new path, and `git log --follow` reads through
    // because the archive mapping mirrors the original path exactly.
    const html = await readFile(join(cli.root, archived.archivePath), "utf8")
    expect(html).toContain('name="memhtml-archived"')
  })

  it("reports corpus health with the index fresh at HEAD", async () => {
    const status = await cli.json<{
      readonly headSha: string | null
      readonly dirty: boolean
      readonly countsByType: Readonly<Record<string, number>>
      readonly archivedCount: number
      readonly edges: number
      readonly indexFresh: boolean
      readonly embedderUp: boolean
      readonly hasState: boolean
    }>(["status"])

    expect(status.dirty).toBe(false)
    expect(status.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(status.archivedCount).toBeGreaterThan(0)
    expect(status.edges).toBeGreaterThan(0)
    expect(status.hasState).toBe(true)
    expect(status.embedderUp).toBe(true)
    expect(
      Object.values(status.countsByType).reduce((total, one) => total + one, 0)
    ).toBeGreaterThan(0)
  })

  it("reproduces the whole index from git alone", async () => {
    /**
     * The rebuildability contract. `index.db` is a PROJECTION of the tree, so a rebuild from a clean
     * checkout must reach the same row set the incremental path built one commit at a time. This
     * compares the two by count across every table a rebuild touches — a rebuild that lost a
     * cascade or double-counted a rename shows up here and nowhere else.
     */
    const before = await cli.json<{
      readonly files: number
      readonly chunks: number
      readonly edges: number
      readonly tags: number
      readonly entities: number
    }>(["index", "status"])

    await cli.json(["index", "rebuild", "--no-embed"])

    const after = await cli.json<typeof before>(["index", "status"])
    expect(after.files).toBe(before.files)
    expect(after.chunks).toBe(before.chunks)
    expect(after.edges).toBe(before.edges)
    expect(after.tags).toBe(before.tags)
    expect(after.entities).toBe(before.entities)
  })

  it("reports a path with no file behind it as ERR_PATH_NOT_FOUND, with somewhere to go", async () => {
    const result = await cli.run(["read", "areas/inbox/does-not-exist.html"])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_PATH_NOT_FOUND")
    expect(body.suggestions).toContain("memhtml list")
  })

  it("refuses a self-link rather than writing an edge the CHECK constraint forbids", async () => {
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list"
    ])
    const path = listed.files[0]?.path as string
    const result = await cli.run(["link", path, "relates_to", path])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    expect((JSON.parse(result.stdout) as Record<string, unknown>).code).toBe("ERR_INVALID_MEMORY")
  })

  it("refuses `trace links` with neither side named", async () => {
    // A no-argument form that returned every link ever recorded is a tool an agent calls by
    // accident, so the refusal is the contract.
    const result = await cli.run(["trace", "links"])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    expect((JSON.parse(result.stdout) as Record<string, unknown>).code).toBe("ERR_INVALID_MEMORY")
  })

  it("round-trips a session link from the write side", async () => {
    const links = await cli.json<{
      readonly links: ReadonlyArray<{ readonly path: string; readonly linkKind: string }>
    }>(["trace", "links", "--session-id", "f7e32699-d45b-4248-8ae6-894dfc606f49"])
    expect(links.links.length).toBeGreaterThan(0)
    expect(links.links.some((link) => link.linkKind === "wrote")).toBe(true)
  })
})

/**
 * Salience-read semantics: a chosen open bumps, a ranker's guess does not.
 *
 * Its own fixture repo rather than the ordered suite above, deliberately. The subject is an access
 * COUNT, and a count is exactly the state a sibling test's `search` or `read` would silently move —
 * the cross-phase contamination this suite has paid for before. Here nothing touches the plane except
 * the call under test.
 *
 * Asserted against `state.access` itself, through the real layer graph, because the count is the whole
 * claim: a test that asserted on a log line or on a return value would pass against a bump that never
 * reached the plane.
 */
describe("salience accumulates chosen opens, not ranker guesses", () => {
  let cli: Cli
  let target: string

  /** `access_count` for one path, `null` when the plane holds no row for it at all. */
  const accessCount = (path: string): Promise<number | null> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DatabaseService
          const row = yield* db.get<{ access_count: number }>(
            `SELECT access_count FROM ${STATE_SCHEMA}.access WHERE path = ?`,
            [path]
          )
          return row?.access_count ?? null
        }),
        cli.layer
      )
    )

  beforeAll(async () => {
    cli = await makeCli()
    const written = await cli.json<Written>([
      "write",
      "--type",
      "procedural",
      "--title",
      "Rollbacks drain the VIP before the deploy is reverted",
      "--claim",
      "Drain the VIP before reverting the deploy.",
      "--body",
      "The revert alone leaves in-flight connections pinned to the retired target group."
    ])
    target = written.path
    // The write path records a session link and reindexes; it must not have touched the access plane.
    expect(await accessCount(target)).toBeNull()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("bumps a path's access count by exactly 1 when a caller OPENS it", async () => {
    const before = await accessCount(target)
    await cli.json(["read", target])
    const after = await accessCount(target)
    // From no row to a count of 1: the first open creates the row, which is the upsert's INSERT half.
    expect(before).toBeNull()
    expect(after).toBe(1)
  })

  it("moves NO access row when a search returns N hits", async () => {
    /**
     * The count is read for every returned path, not just the target, because the loop this rule exists
     * to break bumped the whole hit list — asserting on one path would miss a bump of the other four.
     * The 900-second cooldown is not what holds here and must not be mistaken for it: these paths have
     * never been bumped, so a search that reinforced them WOULD move every one of them.
     */
    const fresh = await cli.json<Written>([
      "write",
      "--type",
      "semantic",
      "--title",
      "A managed platform drains the VIP by itself",
      "--claim",
      "On a managed platform the VIP drain is automatic."
    ])
    const before = await accessCount(fresh.path)
    expect(before).toBeNull()

    const result = await cli.json<Hits>(["search", "drain the VIP before reverting the deploy"])
    expect(result.hits.length).toBeGreaterThan(0)

    for (const hit of result.hits) {
      const count = await accessCount(hit.path)
      // The target was opened by the test above and holds 1; nothing else holds a row at all, and the
      // target's count has not moved either.
      expect(count, `${hit.path} moved on a search hit`).toBe(hit.path === target ? 1 : null)
    }
  })

  it("moves NO access row when a recall discloses a body", async () => {
    // Recall spends a character budget on full bodies, which is a stronger form of the same guess —
    // and still a guess. The rule is about who chose the path, not about how much text came back.
    const before = await accessCount(target)
    const pack = await cli.json<{
      readonly memories: { readonly disclosed: ReadonlyArray<{ readonly path: string }> }
    }>(["recall", "vip drain rollback"])
    expect(pack.memories.disclosed.length).toBeGreaterThan(0)
    for (const entry of pack.memories.disclosed) {
      expect(await accessCount(entry.path), `${entry.path} moved on a recall`).toBe(
        entry.path === target ? before : null
      )
    }
  })

  it("still holds the read's second bump behind the 900-second cooldown", async () => {
    // The swap moved the CALLER, not the writer: `reinforce` is still the one site that touches
    // `state.access`, so its cooldown governs a repeated open exactly as it governed a repeated query.
    await cli.json(["read", target])
    expect(await accessCount(target)).toBe(1)
  })
})

describe("the lexical floor", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli({ embedder: failingEmbedder() })
    await cli.json([
      "write",
      "--type",
      "semantic",
      "--title",
      "An external-content FTS5 table is maintained by sync triggers",
      "--claim",
      "Every write to an FTS-indexed table is mirrored into the index by its sync triggers."
    ])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("still answers a search when the embedder is down, and says so", async () => {
    /**
     * Retrieval never errors because Bedrock is down; it gets narrower. `degraded: true` is how an
     * agent comparing two searches learns one of them was ranked by fewer signals — a silent
     * narrowing would make a Bedrock outage look like a change in the corpus.
     */
    const result = await cli.json<Hits>(["search", "sync triggers"])
    expect(result.degraded).toBe(true)
    expect(result.arms).not.toContain("vector")
    expect(result.hits.length).toBeGreaterThan(0)
  })
})

describe("an absent embedder", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli({ embedder: noEmbedder() })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("writes and searches with no vector plane at all", async () => {
    const written = await cli.json<Written>([
      "write",
      "--type",
      "verdict",
      "--title",
      "A rebuild with no embedder is instant",
      "--claim",
      "Skipping the embed lane makes a rebuild bounded by IO alone."
    ])
    expect(written.created).toBe(true)

    const result = await cli.json<Hits>(["search", "rebuild embedder instant"])
    expect(result.degraded).toBe(true)
    expect(result.hits.length).toBeGreaterThan(0)

    const index = await cli.json<{ readonly embeddings: number; readonly files: number }>([
      "index",
      "status"
    ])
    expect(index.embeddings).toBe(0)
    expect(index.files).toBeGreaterThan(0)
  })
})

describe("--article-html: the caller supplies the article verbatim", () => {
  /**
   * Its own fixture repo, not the ordered suite above. These write real files and one of them
   * deliberately trips the store's format gate, and a refusal landing in a corpus other tests then
   * assert counts over is exactly the cross-phase contamination that has bitten this suite before.
   */
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  /** Markup no claim/body call could produce: a `<dl>` after the mark, plus a `<time datetime>`. */
  const ARTICLE = [
    "<p><mark>WAL admits one writer and any number of concurrent readers.</mark>",
    'Measured on <time datetime="2026-07-28">28 July</time>.</p>',
    "<dl><dt>driver</dt><dd>node:sqlite</dd></dl>"
  ].join("\n")

  it("writes the markup UNESCAPED, structure intact, and commits it", async () => {
    const written = await cli.json<{
      readonly path: string
      readonly created: boolean
      readonly commitSha: string | null
    }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "WAL admits one writer",
      "--article-html",
      ARTICLE
    ])

    expect(written.created).toBe(true)
    expect(written.commitSha).not.toBeNull()

    /**
     * The load-bearing assertion, and the reason it reads the FILE rather than the envelope: the
     * claim/body path runs every string through `escapeText`, so a passthrough that leaked into that
     * lane would land `&lt;dl&gt;` on disk — a file that still parses, still commits, and reads back
     * as prose containing angle brackets. Only the bytes distinguish the two.
     */
    const html = await readFile(join(cli.root, written.path), "utf8")
    expect(html).toContain("<dl>")
    expect(html).toContain("<dd>node:sqlite</dd>")
    expect(html).not.toContain("&lt;dl&gt;")
    expect(html).toContain('<time datetime="2026-07-28">')
    // The caller's `<mark>` is the claim span; nothing wrapped a second one around it.
    expect(html).toContain(
      "<mark>WAL admits one writer and any number of concurrent readers.</mark>"
    )
    expect((html.match(/<mark>/g) ?? []).length).toBe(1)

    // And it is a real memory downstream: the mark became the gist, so retrieval can quote it.
    const detail = await cli.json<{ readonly gist: string }>(["read", written.path])
    expect(detail.gist).toBe("WAL admits one writer and any number of concurrent readers.")
  })

  it("corrects a memory from --article-html too, archiving the target in one commit", async () => {
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list"
    ])
    const target = listed.files.find((file) => file.path.includes("wal-admits"))?.path
    expect(target).toBeDefined()

    const corrected = await cli.json<{
      readonly path: string
      readonly archivedPath: string
      readonly commitSha: string | null
    }>([
      "correct",
      target as string,
      "--title",
      "WAL admits one writer at a time, and never blocks a reader",
      "--article-html",
      "<p><mark>The write lock is held for one transaction, not for the connection.</mark></p>",
      "--reason",
      "the original left the lock's duration unstated"
    ])

    expect(corrected.archivedPath).toMatch(/^archive\/\d{4}\//)
    expect(corrected.commitSha).not.toBeNull()

    // The supersede edge is head-plane, added AFTER the article is rendered — so a verbatim article
    // must not have displaced it. This is the one interaction the write path cannot show.
    const html = await readFile(join(cli.root, corrected.path), "utf8")
    expect(html).toContain(`rel="memhtml-supersedes" href="/${corrected.archivedPath}"`)
    expect(html).toContain(
      "<mark>The write lock is held for one transaction, not for the connection.</mark>"
    )
  })

  it("refuses markup with no <mark> at the store, before anything is committed", async () => {
    /**
     * The flag's description promises the store refuses a violation before any commit, and this is
     * that promise under test — a RUNTIME refusal (exit 1), not the usage error the flag pairing
     * gets, because the CLI does not parse HTML and should not pretend to. Without it the file lands
     * in a commit and the indexer then declines to project it: present in the tree, absent from every
     * search.
     */
    const before = await cli.json<{ readonly headSha: string | null }>(["status"])

    const result = await cli.run([
      "write",
      "--type",
      "semantic",
      "--title",
      "No mark anywhere",
      "--article-html",
      "<p>A paragraph with no claim span at all.</p>"
    ])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("<mark>")

    // Nothing moved and nothing is dirty: the refusal is BEFORE the write, so there is no partial
    // file to clean up. A gate that rendered, wrote, then rolled back would show up here.
    const after = await cli.json<{ readonly headSha: string | null; readonly dirty: boolean }>([
      "status"
    ])
    expect(after.headSha).toBe(before.headSha)
    expect(after.dirty).toBe(false)
  })
})

/**
 * The entity scope and the two-hop chain, in their OWN repo.
 *
 * A private fixture rather than the shared one above, and the isolation is the finding rather than
 * tidiness: these cases seed a memory whose claim shares the first suite's whole vocabulary — that is
 * what makes them meaningful — and the first suite's recall assertion reads `disclosed[0].gist`,
 * which a second high-ranking memory reorders. The contaminating state was this suite's own write,
 * one describe over.
 */
describe("the entity scope and the two-hop chain", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
    await cli.json<Written>([
      "write",
      "--type",
      "procedural",
      "--title",
      "Checkout rollbacks drain the VIP before the deploy is reverted",
      "--claim",
      "Drain the checkout VIP before reverting the deploy.",
      "--body",
      "The revert alone leaves in-flight connections pinned to the old target group.",
      "--workspace",
      "checkout-api",
      "--entity",
      "service:checkout-api"
    ])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("scopes a search by --entity, and chains a hop off a hit's own entities", async () => {
    /**
     * The CLI half of the hop, over a corpus where the excluded memory is a strong candidate for the
     * same query. The rival is written first and asserted PRESENT unscoped — a scope tested against a
     * corpus where the excluded row was below the window anyway would pass against no predicate.
     */
    const rival = await cli.json<Written>([
      "write",
      "--title",
      "Payments rollbacks drain the VIP too",
      "--claim",
      "Drain the payments VIP before reverting the deploy.",
      "--body",
      "The revert alone strands in-flight connections on the retired target group.",
      "--type",
      "procedural",
      "--workspace",
      "payments-api",
      "--entity",
      "service:payments-api"
    ])
    expect(rival.created).toBe(true)

    const query = "drain the vip before reverting the deploy"
    const unscoped = await cli.json<Hits>(["search", query, "--limit", "20"])
    expect(unscoped.hits.map((hit) => hit.path)).toContain(rival.path)
    // No scope named, so nothing to attribute an emptiness to.
    expect(unscoped.entityScope).toBeNull()
    expect(unscoped.scopeEmpty).toBe(false)

    /**
     * The reference comes from hop one's OWN output, in `type:name` form — the whole contract. A test
     * that spelled the string itself would be asserting its own arithmetic rather than the roundtrip.
     */
    const seed = unscoped.hits.find((hit) => hit.path === rival.path)
    expect(seed?.entities).toEqual(["service:payments-api"])
    const reference = seed?.entities[0] ?? ""

    const scoped = await cli.json<Hits>(["search", query, "--entity", reference, "--limit", "20"])
    expect(scoped.hits.map((hit) => hit.path)).toEqual([rival.path])
    expect(scoped.entityScope).toBe(reference)
    expect(scoped.scopeEmpty).toBe(false)
    /**
     * The checkout-api memory this describe seeded IS in the unscoped result and is NOT in the scoped
     * one. Without this pair the scoped result could be a query that only ever matched one file, and
     * the equality above would hold against no predicate at all.
     */
    const rivalOfRival = unscoped.hits.find((hit) => hit.path.includes("checkout-rollbacks"))
    expect(rivalOfRival).toBeDefined()
    expect(scoped.hits.map((hit) => hit.path)).not.toContain(rivalOfRival?.path)
  })

  it("reports an --entity scope that matches nothing as VISIBLY empty, and survives --dense", async () => {
    /**
     * HOP-3 at the CLI, and `--dense` is the half that is specific to this door: it strips
     * null-valued keys so an agent pastes less into a prompt (`envelope.ts:139`). A marker that were
     * null when it did not fire would therefore vanish from exactly the output an agent reads, and its
     * absence would be indistinguishable from a binary that does not report it.
     */
    const query = "drain the vip before reverting the deploy"
    const missing = await cli.json<Hits>([
      "search",
      query,
      "--entity",
      "service:nonexistent",
      "--limit",
      "20"
    ])
    expect(missing.hits).toEqual([])
    expect(missing.scopeEmpty).toBe(true)
    expect(missing.entityScope).toBe("service:nonexistent")
    // Not widened: the same query unscoped returns hits, so a fallback had somewhere to fall back to.
    const unscoped = await cli.json<Hits>(["search", query, "--limit", "20"])
    expect(unscoped.hits.length).toBeGreaterThan(0)

    // Both markers survive `--dense` on the response that NEEDS them: `scopeEmpty` because it is
    // `true`, `entityScope` because a scope was named.
    const dense = await cli.run([
      "search",
      query,
      "--entity",
      "service:nonexistent",
      "--limit",
      "20",
      "--dense"
    ])
    const body = JSON.parse(dense.stdout) as { readonly data: Record<string, unknown> }
    expect(body.data.scopeEmpty).toBe(true)
    expect(body.data.entityScope).toBe("service:nonexistent")

    /**
     * And on a response that does NOT need them, `scopeEmpty` is still present — it is a boolean in
     * every case, so `false` survives the null strip. `entityScope` is legitimately dropped there:
     * `null` means no entity was named, which is the one situation where there is nothing to
     * attribute and nothing for a reader to act on.
     */
    const denseUnscoped = await cli.run(["search", query, "--limit", "20", "--dense"])
    const unscopedBody = JSON.parse(denseUnscoped.stdout) as {
      readonly data: Record<string, unknown>
    }
    expect(unscopedBody.data.scopeEmpty).toBe(false)
    expect("scopeEmpty" in unscopedBody.data).toBe(true)
  })
})

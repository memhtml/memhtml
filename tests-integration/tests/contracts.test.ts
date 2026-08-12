import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, failingEmbedder, makeCli, writeMemory } from "./harness.js"

/**
 * The plan's end-to-end verification items 3 and 4, plus `memhtml publish` and `memhtml doctor`.
 *
 * Every assertion here crosses a package boundary through the shipped CLI, which is what makes this
 * tier different from each package's own suite: `@memhtml/store` proves a `git mv` is a rename and
 * `@memhtml/index` proves a rename keeps its embedding, and only a test that runs both proves the WRITE
 * PATH composes them correctly.
 *
 * The other items have their own files, each for a reason: item 1 (`clone.test.ts`) needs a second
 * repo, item 5 (`traces.test.ts`) needs `MEMHTML_TRACE_ROOT` set at module scope before any
 * `effect/Config` resolves, item 6 (`sleep.test.ts`, `rebuild.test.ts`) needs a scripted model and a
 * corpus built incrementally, and item 2 is `@memhtml/eval`'s own `test:eval` gate.
 */

describe("verification item 3 — double-write dedup leaves the tree byte-identical", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("returns the existing path with `deduped: true`, and no commit", async () => {
    const input = {
      title: "Prod rollbacks drain the VIP before the deploy is reverted",
      claim: "Drain the VIP before reverting the deploy.",
      body: ["The revert alone leaves in-flight connections pinned to the old target group."],
      workspace: "checkout-api",
      tags: ["deploy"]
    }

    const first = await writeMemory(cli, input)
    expect(first.created).toBe(true)
    expect(first.deduped).toBe(false)

    const before = await cli.json<{ readonly headSha: string | null }>(["status"])

    const second = await writeMemory(cli, input)
    expect(second.deduped).toBe(true)
    expect(second.created).toBe(false)
    expect(second.existingPath).toBe(first.path)
    expect(second.commitSha).toBeNull()

    /**
     * The clean-tree half, and it is the load-bearing one: the dedupe question is asked BEFORE any
     * file is written, so a duplicate writes nothing, stages nothing, and commits nothing. A
     * write-then-check order would need a rollback, and a rollback of a git operation is a second
     * failure mode. Asserted against git itself rather than only against the report.
     */
    const after = await cli.json<{
      readonly headSha: string | null
      readonly dirty: boolean
      readonly dirtyPaths: ReadonlyArray<string>
    }>(["status"])
    expect(after.headSha).toBe(before.headSha)
    expect(after.dirty).toBe(false)
    expect(after.dirtyPaths).toEqual([])
    expect((await cli.git("status", "--porcelain")).trim()).toBe("")
  })

  it("admits the same content once the earlier copy is archived", async () => {
    /**
     * `files_content_hash_active` is a PARTIAL unique index — `WHERE archived = 0` — so archiving
     * releases the hash. Without that a corrected memory could never be re-asserted, which is the
     * ordinary case of an agent re-learning something it had evicted.
     */
    const written = await writeMemory(cli, {
      title: "The staging bastion listens on a non-default port",
      claim: "The staging bastion listens on port 2222."
    })
    await cli.json(["archive", written.path, "--reason", "no longer current"])

    const again = await writeMemory(cli, {
      title: "The staging bastion listens on a non-default port",
      claim: "The staging bastion listens on port 2222."
    })
    expect(again.deduped).toBe(false)
    expect(again.created).toBe(true)
  })
})

describe("verification item 4 — embedder down: the lexical floor holds", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli({ embedder: failingEmbedder() })
    await writeMemory(cli, {
      title: "An external-content FTS5 table is maintained by sync triggers",
      claim: "Every write to an FTS-indexed table is mirrored into the index by its sync triggers.",
      type: "semantic"
    })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("still answers a search, reports `degraded: true`, and drops the vector arm", async () => {
    /**
     * Retrieval never ERRORS because Bedrock is down; it gets narrower. `degraded` is how an agent
     * comparing two searches learns one was ranked by fewer signals — a silent narrowing would make an
     * outage look like a change in the corpus.
     */
    const result = await cli.json<{
      readonly hits: ReadonlyArray<{ readonly path: string }>
      readonly degraded: boolean
      readonly arms: ReadonlyArray<string>
    }>(["search", "sync triggers"])

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.degraded).toBe(true)
    expect(result.arms).not.toContain("vector")
    // The lexical arm and both query-blind arms still fired: degradation narrows the fold, it does not
    // collapse it to one arm.
    expect(result.arms).toContain("fts")
  })

  it("recalls a pack on the floor too, rather than failing the disclosure fold", async () => {
    const pack = await cli.json<{
      readonly memories: { readonly disclosed: ReadonlyArray<{ readonly gist: string }> }
      readonly degraded: boolean
    }>(["recall", "sync triggers"])
    expect(pack.degraded).toBe(true)
    expect(pack.memories.disclosed.length).toBeGreaterThan(0)
  })

  it("writes with no embedder, leaving the vector plane sparse rather than refusing", async () => {
    // `--no-embed` and a Bedrock outage take the same path, and both must leave a usable lexical index.
    const written = await writeMemory(cli, {
      title: "A rebuild with no embedder is bounded by IO alone",
      claim: "Skipping the embed lane makes a rebuild bounded by IO alone.",
      type: "verdict"
    })
    expect(written.created).toBe(true)

    const index = await cli.json<{ readonly embeddings: number; readonly files: number }>([
      "index",
      "status"
    ])
    expect(index.embeddings).toBe(0)
    expect(index.files).toBeGreaterThan(0)
  })
})

describe("memhtml publish", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
    await writeMemory(cli, {
      title: "Blue-green cutover drains before retiring the old fleet",
      claim: "A blue-green cutover drains connections before the old fleet is retired.",
      workspace: "checkout-api"
    })
    await writeMemory(cli, {
      title: "The metrics agent scrapes every exporter each minute",
      claim: "The metrics agent scrapes every exporter once each minute.",
      type: "semantic",
      tags: ["observability"]
    })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("generates a listing per directory plus the root sitemap, and commits them", async () => {
    const report = await cli.json<{
      readonly artifacts: number
      readonly written: number
      readonly commitSha: string | null
    }>(["publish"])

    expect(report.artifacts).toBeGreaterThan(1)
    expect(report.written).toBe(report.artifacts)
    expect(report.commitSha).not.toBeNull()

    const sitemap = await readFile(join(cli.root, "sitemap.xml"), "utf8")
    expect(sitemap).toContain("<urlset")
    expect(sitemap).toContain("blue-green-cutover")
    /**
     * Every `<loc>` is repo-root-relative, never an absolute origin: the repo has no canonical one —
     * it is browsed from a filesystem, from a clone on another machine, and occasionally from a static
     * server, so an origin would be a value the generator has to invent and every consumer has to
     * ignore. Asserted per `<loc>` rather than by grepping the file for `http`, because the `urlset`
     * element's own xmlns IS an http URL and always will be.
     */
    const locations = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? "")
    expect(locations.length).toBeGreaterThan(1)
    for (const location of locations) {
      expect(location.startsWith("/")).toBe(true)
      expect(location).not.toMatch(/^[a-z]+:/)
    }

    const listing = await readFile(join(cli.root, "projects", "checkout-api", "index.html"), "utf8")
    expect(listing).toContain("Blue-green cutover drains before retiring the old fleet")
  })

  it("is DETERMINISTIC: a second run is byte-identical and commits nothing", async () => {
    /**
     * The `merge=ours` contract depends on exactly this. These files are the design's ONE
     * merge-conflict source, and a conflict is resolved by REGENERATING — which only works if
     * regeneration is unambiguous. A generator carrying a timestamp would make every publish a commit
     * and every merge a manual XML edit.
     */
    const before = await readFile(join(cli.root, "sitemap.xml"), "utf8")
    const head = (await cli.git("rev-parse", "HEAD")).trim()

    const second = await cli.json<{ readonly written: number; readonly commitSha: string | null }>([
      "publish"
    ])
    expect(second.written).toBe(0)
    expect(second.commitSha).toBeNull()

    expect(await readFile(join(cli.root, "sitemap.xml"), "utf8")).toBe(before)
    expect((await cli.git("rev-parse", "HEAD")).trim()).toBe(head)
    expect((await cli.git("status", "--porcelain")).trim()).toBe("")
  })

  it("marks the generated artifacts merge=ours AND configures the driver", async () => {
    /**
     * Finding #24: the attribute alone is INERT — probed live, git still conflicts and writes conflict
     * markers into the file. `merge.ours.driver` is what makes it effective, and config is per-clone, so
     * a fresh clone must re-run `memhtml init`. Both halves asserted, because either alone is a silent
     * no-op.
     */
    const attributes = await readFile(join(cli.root, ".gitattributes"), "utf8")
    expect(attributes).toContain("index.html merge=ours")
    expect(attributes).toContain("sitemap.xml merge=ours")
    expect((await cli.git("config", "--get", "merge.ours.driver")).trim()).toBe("true")
  })

  it("keeps the generated artifacts out of retrieval", async () => {
    // A listing whose body is the titles of other memories would rank the corpus's own table of
    // contents above its content. The indexer refuses them BY NAME, so this is the assertion that the
    // refusal survives a publish.
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list",
      "--include-archived"
    ])
    for (const file of listed.files) {
      expect(file.path.endsWith("/index.html")).toBe(false)
      expect(file.path).not.toBe("sitemap.xml")
    }
  })
})

describe("memhtml doctor", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()
    await writeMemory(cli, {
      title: "Rollback ordering drains the VIP first",
      claim: "A rollback drains the VIP before reverting.",
      workspace: "checkout-api"
    })
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("reports a clean corpus on a freshly written repo", async () => {
    const report = await cli.json<{
      readonly healthy: boolean
      readonly dangling: ReadonlyArray<unknown>
      readonly orphanAccessRows: ReadonlyArray<string>
      readonly inboxDepth: number
      readonly warnings: ReadonlyArray<unknown>
      readonly unparseable: ReadonlyArray<string>
      readonly indexFresh: boolean
      readonly embedModelMatches: boolean
    }>(["doctor"])

    expect(report.dangling).toEqual([])
    expect(report.orphanAccessRows).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.unparseable).toEqual([])
    expect(report.indexFresh).toBe(true)
    expect(report.embedModelMatches).toBe(true)
    expect(report.healthy).toBe(true)
  })

  it("detects an INJECTED dangling href, and --fix repairs it", async () => {
    /**
     * The repair path, driven by injecting the defect rather than by asserting on a synthetic report.
     * A `<link>` to a path that was never written is exactly what a hand-edit or an interrupted archive
     * produces, and the `edges` table has no foreign key on `dst_path` deliberately — so a LEFT JOIN is
     * the only thing that finds it.
     */
    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list"
    ])
    const source = listed.files[0]?.path as string
    const absolute = join(cli.root, source)
    const html = await readFile(absolute, "utf8")

    const injected = html.replace(
      "</head>",
      '<link rel="memhtml-relates-to" href="/areas/oncall/a-memory-that-was-never-written.html">\n</head>'
    )
    await writeFile(absolute, injected, "utf8")
    await cli.git("add", source)
    await cli.git("commit", "-m", "inject a dangling href")
    await cli.json(["index", "update"])

    const found = await cli.json<{
      readonly healthy: boolean
      readonly dangling: ReadonlyArray<{
        readonly srcPath: string
        readonly dstPath: string
        readonly rewriteTo: string | null
      }>
    }>(["doctor"])
    expect(found.healthy).toBe(false)
    expect(found.dangling).toHaveLength(1)
    expect(found.dangling[0]?.srcPath).toBe(source)
    // No file anywhere, so the repair DROPS the link rather than rewriting it: the edge asserts a
    // relationship to nothing.
    expect(found.dangling[0]?.rewriteTo).toBeNull()

    const fixed = await cli.json<{
      readonly repaired: { readonly dropped: number; readonly commitSha: string | null }
    }>(["doctor", "--fix"])
    expect(fixed.repaired.dropped).toBe(1)
    expect(fixed.repaired.commitSha).not.toBeNull()

    // The link is gone from the FILE, and the article is untouched: the head editors splice by offset,
    // so a repair cannot move the content hash.
    const repaired = await readFile(absolute, "utf8")
    expect(repaired).not.toContain("a-memory-that-was-never-written")
    expect(repaired).toContain("<mark>A rollback drains the VIP before reverting.</mark>")

    await cli.json(["index", "update"])
    const after = await cli.json<{ readonly dangling: ReadonlyArray<unknown> }>(["doctor"])
    expect(after.dangling).toEqual([])
  })

  it("rewrites a dangling href to the target's ARCHIVE path when the target moved", async () => {
    /**
     * The other half of the repair, and the reason it is not just a drop: an archived target still
     * EXISTS and the edge still says something true, so the href is rewritten. `archivePathFor` derives
     * the path rather than searching for it — the mapping is injective and `originalPathFor` inverts it,
     * so no rename-similarity score is consulted anywhere (finding #23).
     */
    const target = await writeMemory(cli, {
      title: "The old bastion port is recorded here",
      claim: "The bastion listened on port 2222 until the migration."
    })
    const source = await writeMemory(cli, {
      title: "The bastion port matters for the runbook",
      claim: "The runbook depends on the bastion port."
    })
    await cli.json(["link", source.path, "relates_to", target.path])

    const archived = await cli.json<{ readonly archivePath: string }>([
      "archive",
      target.path,
      "--reason",
      "the migration landed"
    ])

    // The edge now points at the pre-archive path, which no longer holds a file.
    const found = await cli.json<{
      readonly dangling: ReadonlyArray<{
        readonly dstPath: string
        readonly rewriteTo: string | null
      }>
    }>(["doctor"])
    const finding = found.dangling.find((one) => one.dstPath === target.path)
    expect(finding).toBeDefined()
    expect(finding?.rewriteTo).toBe(archived.archivePath)

    await cli.json(["doctor", "--fix"])
    const html = await readFile(join(cli.root, source.path), "utf8")
    expect(html).toContain(`href="/${archived.archivePath}"`)
  })

  it("prunes an orphan state row under --fix", async () => {
    /**
     * There are no cross-database foreign keys, so the store mirrors a path move explicitly and an
     * interrupted mirror leaves a row describing nothing. Injected directly, because provoking a
     * partial mirror would mean killing the process mid-commit.
     */
    const { DatabaseService } = await import("@memhtml/index")
    const { STATE_SCHEMA } = await import("@memhtml/index")
    const { Effect } = await import("effect")

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService
        yield* db.run(
          `INSERT INTO ${STATE_SCHEMA}.access (path, access_count, updated_at) VALUES (?, 3, ?)`,
          ["areas/oncall/a-path-with-no-file.html", "2026-08-01T00:00:00Z"]
        )
      }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
    )

    const found = await cli.json<{ readonly orphanAccessRows: ReadonlyArray<string> }>(["doctor"])
    expect(found.orphanAccessRows).toContain("areas/oncall/a-path-with-no-file.html")

    const fixed = await cli.json<{ readonly repaired: { readonly prunedAccessRows: number } }>([
      "doctor",
      "--fix"
    ])
    expect(fixed.repaired.prunedAccessRows).toBeGreaterThanOrEqual(1)

    const after = await cli.json<{ readonly orphanAccessRows: ReadonlyArray<string> }>(["doctor"])
    expect(after.orphanAccessRows).not.toContain("areas/oncall/a-path-with-no-file.html")
  })

  it("reports a vocabulary warning without refusing the file", async () => {
    /**
     * Format constraint 6: an element outside the closed vocabulary still INDEXES, because the format
     * has to degrade gracefully on a file a human hand-wrote. Doctor is the only surface that ever
     * surfaces it, so a warning that did not appear here would appear nowhere.
     */
    const path = "areas/oncall/a-hand-authored-memory.html"
    const absolute = join(cli.root, path)
    await mkdir(join(cli.root, "areas", "oncall"), { recursive: true })
    await writeFile(
      absolute,
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A hand authored memory</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-01T00:00:00Z">
<meta name="memhtml-updated" content="2026-08-01T00:00:00Z">
</head>
<body>
<article>
<p><mark>Someone wrote this by hand in a hurry.</mark></p>
<blockquote>An element the closed vocabulary does not name.</blockquote>
</article>
</body>
</html>
`,
      "utf8"
    )
    await cli.git("add", path)
    await cli.git("commit", "-m", "hand-author a memory")
    await cli.json(["index", "update"])

    const report = await cli.json<{
      readonly healthy: boolean
      readonly warnings: ReadonlyArray<{
        readonly path: string
        readonly warnings: ReadonlyArray<string>
      }>
      readonly unparseable: ReadonlyArray<string>
    }>(["doctor"])

    const warning = report.warnings.find((one) => one.path === path)
    expect(warning).toBeDefined()
    expect(warning?.warnings.join(" ")).toContain("blockquote")
    // A warning, NOT a violation: the file parsed and indexed.
    expect(report.unparseable).not.toContain(path)
    expect(report.healthy).toBe(false)

    const listed = await cli.json<{ readonly files: ReadonlyArray<{ readonly path: string }> }>([
      "list"
    ])
    expect(listed.files.some((file) => file.path === path)).toBe(true)
  })

  it("reports a stale index rather than silently refreshing it", async () => {
    // Doctor NAMES the fix instead of running it: `memhtml index update` moves the watermark, and a health
    // check that repaired what it measured would make "the index is fresh" unfalsifiable.
    await writeFile(join(cli.root, "areas", "oncall", "x.html"), "not a memory", "utf8")
    await cli.git("add", "areas/oncall/x.html")
    await cli.git("commit", "-m", "move HEAD past the index watermark")

    const report = await cli.json<{
      readonly indexFresh: boolean
      readonly indexHeadSha: string | null
      readonly headSha: string | null
    }>(["doctor"])
    expect(report.indexFresh).toBe(false)
    expect(report.indexHeadSha).not.toBe(report.headSha)
  })
})

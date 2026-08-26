import { DatabaseService } from "@memhtml/index"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { RESOLVE_MAX_HOPS, type ResolveResult, resolveQueries } from "../src/operations.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * `memhtml resolve`: following a path a receipt recorded forward to the memory that carries the fact
 * now.
 *
 * **The fixture corrects a memory TWICE with a reworded title each time, which is the only shape that
 * exercises the walk.** A path is the id of a memory and it derives from the title, so a correction
 * whose title is unchanged lands at the same path and one hop of the chain is invisible: `hops: 0` and
 * a full walk look identical. Rewording moves the file, which is exactly what makes an external
 * citation dead-end.
 *
 * **Both mechanisms appear in one chain, alternating.** A correction archives its target and points its
 * `supersedes` link at the ARCHIVE path, so the pre-archive path has no inbound edge at all: reaching
 * the successor from a cited path requires the archive mapping first and the edge second. A test that
 * only ever resolved an archive path would pass with the mapping deleted.
 *
 * **A NEIGHBOUR chain is seeded, corrected the same way.** `edges` and `files.origin_path` are shared
 * by every memory in the corpus, and on a single-chain fixture a redirect that matched "any archived
 * file" and a successor lookup that matched "any supersedes edge" both return the right row. The
 * neighbour is what makes those two mistakes fail.
 */

/** The whole chain the fixture builds, in the order the walk must traverse it. */
interface Chain {
  /** The path the FIRST write landed at — what an external receipt would have recorded. */
  readonly cited: string
  /** Where that file lives after the first correction moved it. */
  readonly firstArchive: string
  /** The first correction's own path, before the second correction moved it in turn. */
  readonly middle: string
  /** Where the middle file lives after the second correction. */
  readonly secondArchive: string
  /** The live path at the end of the chain. */
  readonly live: string
  /** The live memory's title, so the answer's `title` is checked against the corpus. */
  readonly liveTitle: string
}

const resolve = (cli: Cli, path: string): Promise<ResolveResult> =>
  cli.json<ResolveResult>(["resolve", path])

describe("memhtml resolve", () => {
  let cli: Cli
  let chain: Chain
  /** A second chain, built the same way, whose rows share every table the walk reads. */
  let neighbour: Chain
  /** Evicted with `archive` and never corrected: in the archive with nothing superseding it. */
  let evictedCitedPath = ""
  let evictedArchivePath = ""

  /** Write, then correct twice, rewording the title each time so every hop moves the file. */
  const buildChain = async (input: {
    readonly first: string
    readonly second: string
    readonly third: string
    readonly claim: string
  }): Promise<Chain> => {
    const written = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "procedural",
      "--title",
      input.first,
      "--claim",
      input.claim
    ])
    const one = await cli.json<{ readonly path: string; readonly archivedPath: string }>([
      "correct",
      written.path,
      "--title",
      input.second,
      "--claim",
      `${input.claim} Corrected once.`
    ])
    const two = await cli.json<{ readonly path: string; readonly archivedPath: string }>([
      "correct",
      one.path,
      "--title",
      input.third,
      "--claim",
      `${input.claim} Corrected twice.`
    ])
    return {
      cited: written.path,
      firstArchive: one.archivedPath,
      middle: one.path,
      secondArchive: two.archivedPath,
      live: two.path,
      liveTitle: input.third
    }
  }

  beforeAll(async () => {
    cli = await makeCli()

    chain = await buildChain({
      first: "Prod rollbacks drain the VIP first",
      second: "Prod rollbacks drain the VIP and wait for connections",
      third: "Prod rollbacks drain the VIP then wait two minutes",
      claim: "Drain the VIP before reverting the deploy."
    })
    neighbour = await buildChain({
      first: "Staging deploys skip the canary",
      second: "Staging deploys skip the canary except on Fridays",
      third: "Staging deploys skip the canary outside a release window",
      claim: "A staging deploy needs no canary step."
    })

    const evictable = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The old build box ran on a spinning disk",
      "--claim",
      "The retired build box used a spinning disk."
    ])
    evictedCitedPath = evictable.path
    const evicted = await cli.json<{ readonly archivePath: string }>([
      "archive",
      evictable.path,
      "--reason",
      "the box is gone"
    ])
    evictedArchivePath = evicted.archivePath
  }, 120_000)

  afterAll(() => cli.cleanup())

  it("moves the file on every hop, which is what the walk has to cross", () => {
    /**
     * The fixture's own precondition. Every path below is distinct, so no assertion in this file can
     * pass by the chain having stood still: two corrections at one path would make a four-hop walk and
     * a zero-hop walk return the same string.
     */
    const paths = [chain.cited, chain.firstArchive, chain.middle, chain.secondArchive, chain.live]
    expect(new Set(paths).size).toBe(paths.length)
    expect(chain.cited).not.toBe(chain.live)
    expect(chain.firstArchive).toContain("archive/")
    // The archive mirrors the original path under a year partition, which is what makes the mapping
    // invertible at all.
    expect(chain.firstArchive.endsWith(chain.cited)).toBe(true)
    // And the neighbour is a genuinely separate chain sharing the tables, not a second name for this one.
    expect(new Set([...paths, neighbour.cited, neighbour.live]).size).toBe(paths.length + 2)
  })

  it("walks a cited path forward to the live memory, naming each hop's mechanism", async () => {
    const answer = await resolve(cli, chain.cited)
    expect(answer.requested).toBe(chain.cited)
    expect(answer.path).toBe(chain.live)
    expect(answer.stopReason).toBe("live")
    expect(answer.title).toBe(chain.liveTitle)
    /**
     * The full chain, asserted as the WHOLE list rather than as an endpoint. A walk that skipped the
     * middle correction would land on the same live path — the endpoint is not evidence that the
     * intermediate hops happened, and `via` is what a receipt is audited on.
     */
    expect(answer.steps).toEqual([
      { from: chain.cited, to: chain.firstArchive, via: "archive_move" },
      { from: chain.firstArchive, to: chain.secondArchive, via: "supersedes" },
      { from: chain.secondArchive, to: chain.live, via: "supersedes" }
    ])
    expect(answer.hops).toBe(3)
    /**
     * The middle memory is named by its CURRENT path, `secondArchive`, and not by the path it was live
     * at. Its `supersedes` link is an element in the file, so the second correction's `git mv` carried
     * the link with it and the edge now points from the archived middle. A walk that expected the
     * live-at-the-time path would find no edge and stop one hop early.
     */
    expect(answer.steps.map((step) => step.to)).not.toContain(chain.middle)
  })

  it("resolves a path the SECOND correction vacated, entering one hop further along", async () => {
    // The middle memory's own path: absent from the tree, mapped into the archive, superseded from
    // there. The chain a citation written between the two corrections would carry.
    const answer = await resolve(cli, chain.middle)
    expect(answer.path).toBe(chain.live)
    expect(answer.steps).toEqual([
      { from: chain.middle, to: chain.secondArchive, via: "archive_move" },
      { from: chain.secondArchive, to: chain.live, via: "supersedes" }
    ])
  })

  it("resolves the neighbour chain to ITS own live path, not to the subject's", async () => {
    // The half a shared-table mistake fails: a redirect or a successor lookup that ignored its
    // parameter would answer both chains with whichever row the planner reached first.
    const answer = await resolve(cli, neighbour.cited)
    expect(answer.path).toBe(neighbour.live)
    expect(answer.path).not.toBe(chain.live)
    expect(answer.stopReason).toBe("live")
  })

  it("stops at zero hops on a path that is already live", async () => {
    const answer = await resolve(cli, chain.live)
    expect(answer.path).toBe(chain.live)
    expect(answer.hops).toBe(0)
    expect(answer.steps).toEqual([])
    expect(answer.stopReason).toBe("live")
  })

  it("enters the chain mid-way from an archive path", async () => {
    const answer = await resolve(cli, chain.firstArchive)
    expect(answer.path).toBe(chain.live)
    expect(answer.hops).toBe(2)
    expect(answer.steps.map((step) => step.via)).toEqual(["supersedes", "supersedes"])
  })

  it("says `archived` for a memory that was evicted rather than corrected", async () => {
    /**
     * The distinction the stop-reason vocabulary exists for. Both this and a correction leave the cited
     * path absent from the tree; only one has a successor. Reporting the archive path with
     * `stopReason: "live"` would tell a caller to cite an evicted memory as current.
     */
    const answer = await resolve(cli, evictedCitedPath)
    expect(answer.path).toBe(evictedArchivePath)
    expect(answer.stopReason).toBe("archived")
    expect(answer.steps).toEqual([
      { from: evictedCitedPath, to: evictedArchivePath, via: "archive_move" }
    ])
    // The title still comes back, because an evicted memory is readable and a citation of it is honest
    // once it says so.
    expect(answer.title).toBe("The old build box ran on a spinning disk")
  })

  it("says `unindexed` for a path the corpus never held, without inventing a hop", async () => {
    const answer = await resolve(cli, "areas/oncall/never-written.html")
    expect(answer.path).toBe("areas/oncall/never-written.html")
    expect(answer.stopReason).toBe("unindexed")
    expect(answer.hops).toBe(0)
    expect(answer.title).toBeNull()
  })

  it("names the commit the index describes, so a caller knows what the answer is about", async () => {
    const answer = await resolve(cli, chain.live)
    const status = await cli.json<{ readonly headSha: string | null }>(["index", "status"])
    // Read off `index status` rather than asserted as a literal: the claim is that the two report the
    // same watermark, not that this test knows what it is.
    expect(answer.indexedCommit).toBe(status.headSha)
    expect(answer.indexedCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("reports a supersede cycle as a cycle, with the loop closing in `steps`", async () => {
    /**
     * Two memories each claiming to supersede the other is an authoring defect a caller can reach with
     * two `memhtml link` calls, and it is the one input that can make a forward walk run forever. The
     * visited set stops it at the hop that closes the loop, however short, so this does not depend on
     * {@link RESOLVE_MAX_HOPS}.
     */
    const left = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The left mirror claims the right one is stale",
      "--claim",
      "The left mirror is the current one."
    ])
    const right = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The right mirror claims the left one is stale",
      "--claim",
      "The right mirror is the current one."
    ])
    await cli.json(["link", left.path, "supersedes", right.path])
    await cli.json(["link", right.path, "supersedes", left.path])

    const answer = await resolve(cli, left.path)
    expect(answer.stopReason).toBe("cycle")
    expect(answer.steps).toEqual([
      { from: left.path, to: right.path, via: "supersedes" },
      { from: right.path, to: left.path, via: "supersedes" }
    ])
    // The walk ends on a member of the loop rather than on a resolution, which `stopReason` is what
    // says. A caller reading `path` alone gets a path in the cycle either way; hiding the second step
    // would leave it unable to see why.
    expect(answer.path).toBe(left.path)
  })

  it("stops at the hop bound and says so rather than walking an unbounded chain", async () => {
    /**
     * A chain longer than the bound, seeded as index rows.
     *
     * The subject here is the LOOP's bound, not the store's write path: what has to be true is that a
     * chain of any length costs a bounded number of statements and reports the bound that stopped it.
     * Building it through {@link RESOLVE_MAX_HOPS} real corrections would assert the same property at
     * the cost of seventeen commits, and it is the walk that decides this, not git.
     */
    const length = RESOLVE_MAX_HOPS + 4
    const synthetic = Array.from(
      { length },
      (_, at) => `areas/chains/link-${String(at).padStart(2, "0")}.html`
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService
        for (const [at, path] of synthetic.entries()) {
          yield* db.run(
            `INSERT INTO files (path, blob_sha, content_hash, memory_type, title, body_text,
                                para, created_at, updated_at, indexed_at)
             VALUES (?, ?, ?, 'semantic', ?, 'b', 'areas', ?, ?, ?)`,
            [
              path,
              `sha-${String(at)}`,
              `hash-${String(at)}`,
              `Link ${String(at)} of a long chain`,
              "2026-08-01T00:00:00Z",
              "2026-08-01T00:00:00Z",
              "2026-08-01T00:00:00Z"
            ]
          )
        }
        // Each link supersedes the one before it, so the walk enters at index 0 and climbs.
        for (let at = 1; at < length; at += 1) {
          yield* db.run(
            `INSERT INTO edges (src_path, rel, dst_path, edge_class, derived, provenance, created_at)
             VALUES (?, 'supersedes', ?, 'memory', 0, 'authored', '2026-08-01T00:00:00Z')`,
            [synthetic[at] ?? "", synthetic[at - 1] ?? ""]
          )
        }
      }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
    )

    const answer = await resolve(cli, synthetic[0] ?? "")
    expect(answer.stopReason).toBe("hop_limit")
    // Exactly the bound, not one past it: the check runs before the step, so `path` is a path the walk
    // stood on and `hops` is the bound the answer claims to respect.
    expect(answer.hops).toBe(RESOLVE_MAX_HOPS)
    expect(answer.path).toBe(synthetic[RESOLVE_MAX_HOPS])
    // And resolving again continues from where it stopped, which is what makes the bound a bound and
    // not a truncation the caller cannot get past.
    const rest = await resolve(cli, answer.path)
    expect(rest.path).toBe(synthetic[length - 1])
    expect(rest.stopReason).toBe("live")
  })

  it("PROBES an index on all three of its statements rather than scanning a shared table", async () => {
    /**
     * The cost contract, at the planner, over the statements {@link resolveQueries} hands the walk —
     * the same strings the code issues, not a copy.
     *
     * Every one of the three returns the correct row either way, at every corpus size a test will
     * seed, so no result assertion above can tell a probe from a scan. Two of the three are the ones
     * that matter: `successor` reaches `edges`, whose `edges_derived (derived, rel)` also SEARCHes and
     * matches every correction in the corpus, and `archived` reaches `files`, where the alternative is
     * a full scan per hop.
     */
    const plans = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService
        const explain = (sql: string) =>
          db
            .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [chain.cited])
            .pipe(Effect.map((rows) => rows.map((row) => row.detail)))
        return {
          successor: yield* explain(resolveQueries.successor),
          archived: yield* explain(resolveQueries.archived),
          file: yield* explain(resolveQueries.file)
        }
      }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
    )

    // The constraint LIST per statement, because "a SEARCH happened" is what the defect also looks
    // like: `edges_derived (derived=? AND rel=?)` is a SEARCH over every authored correction.
    expect(plans.successor.join(" | ")).toContain("SEARCH e USING INDEX edges_dst")
    expect(plans.successor.join(" | ")).toContain("dst_path=?")
    expect(plans.archived.join(" | ")).toContain("SEARCH f USING INDEX files_origin")
    expect(plans.archived.join(" | ")).toContain("origin_path=?")
    expect(plans.file.join(" | ")).toContain("path=?")
    for (const [name, plan] of Object.entries(plans)) {
      expect(
        plan.filter((step) => step.includes("SCAN")),
        `${name} scans: ${plan.join(" | ")}`
      ).toEqual([])
    }
  })

  it("returns the resolution as its own envelope type", async () => {
    const envelope = await cli.envelope(["resolve", chain.cited])
    expect(envelope.type).toBe("memory.resolved")
    expect(envelope.error).toBeUndefined()
  })
})

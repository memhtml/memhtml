import { execFile } from "node:child_process"
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { DoctorReport } from "../src/doctor.js"
import { type Cli, makeCli } from "./harness.js"

const git = promisify(execFile)

/**
 * `memhtml doctor --fix` under a write that cannot land.
 *
 * The subject is the repair accounting, not the repair editors (those are `@memhtml/sleep`'s and
 * tested there). A repair is a claim that bytes reached disk, and the failure mode this file pins is
 * the quiet one: a `--fix` whose write failed but which counted the finding as settled anyway. The
 * envelope then said "1 dangling link repaired" over a tree that still held the dangling href, and
 * the commit subject notarized the claim.
 *
 * The injected failure is a real one — the source file made read-only — because a fake filesystem
 * would verify the shape of the call and miss the EACCES path `attemptIo` actually takes.
 */
describe("doctor --fix counts only repairs whose bytes reached disk", () => {
  let cli: Cli
  let source: string
  let target: string

  beforeAll(async () => {
    cli = await makeCli()

    const first = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The asserting memory",
      "--claim",
      "This memory holds the authored edge.",
      "--workspace",
      "doctor-fixture"
    ])
    source = first.path

    const second = await cli.json<{ readonly path: string }>([
      "write",
      "--type",
      "semantic",
      "--title",
      "The memory that will vanish",
      "--claim",
      "This memory's file is about to leave the tree.",
      "--workspace",
      "doctor-fixture"
    ])
    target = second.path

    await cli.json(["link", source, "caused_by", target])

    // Remove the target OUTSIDE the CLI — a hand-driven `git rm` is exactly the corpus damage
    // doctor exists to find. The archive path is not taken, so the finding has no rewrite target
    // and the repair is a drop.
    await git("git", ["-C", cli.root, "rm", "--quiet", target])
    await git("git", ["-C", cli.root, "commit", "--quiet", "-m", "remove the target by hand"])
    await cli.json(["index", "update"])
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("finds the dangling edge before any repair", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.dangling).toEqual([
      { srcPath: source, rel: "caused_by", dstPath: target, rewriteTo: null }
    ])
  })

  it("reports a failed write under failedWrites, uncounted and uncommitted", async () => {
    /**
     * The regression. The write used to run through `Effect.orElseSucceed` and the counters ran
     * unconditionally after it, so an EACCES here was reported as `dropped: 1` with a commit whose
     * subject claimed a repair the tree does not hold.
     */
    await chmod(join(cli.root, source), 0o444)
    try {
      const report = await cli.json<DoctorReport>(["doctor", "--fix"])
      expect(report.repaired).toBeDefined()
      expect(report.repaired?.failedWrites).toEqual([source])
      expect(report.repaired?.rewritten).toBe(0)
      expect(report.repaired?.dropped).toBe(0)
      expect(report.repaired?.commitSha).toBeNull()
      // The finding is still open, so the report must keep saying so.
      expect(report.dangling.map((finding) => finding.srcPath)).toContain(source)
    } finally {
      await chmod(join(cli.root, source), 0o644)
    }
  })

  it("retries cleanly on the next run: the drop lands, is counted, and is committed", async () => {
    const report = await cli.json<DoctorReport>(["doctor", "--fix"])
    expect(report.repaired?.failedWrites).toEqual([])
    expect(report.repaired?.dropped).toBe(1)
    expect(report.repaired?.rewritten).toBe(0)
    expect(report.repaired?.commitSha).not.toBeNull()

    // And the repair is real: a fresh pass over the reindexed tree finds nothing dangling.
    await cli.json(["index", "update"])
    const clean = await cli.json<DoctorReport>(["doctor"])
    expect(clean.dangling).toEqual([])
  })
})

/**
 * The untyped-entity count, which is what makes a bare-name PRODUCER visible.
 *
 * `unknown` is a supported storage type, so nothing refuses a bare `memhtml-entity` meta and nothing
 * downstream errors on one. What it costs is reachability: the `entity` scope requires the type half, so
 * a memory stored under `unknown:checkout-api` returns an empty set for `service:checkout-api` — the
 * same answer an absent memory gives. Doctor is the only surface that can say the corpus holds them.
 */
describe("doctor counts untyped entity references", () => {
  let cli: Cli

  beforeAll(async () => {
    cli = await makeCli()

    // A TYPED neighbour first. Its `unknown`-free rows are what prove the count is a predicate on the
    // entity type rather than a count of every entity in the corpus.
    await cli.json([
      "write",
      "--type",
      "semantic",
      "--title",
      "The typed neighbour",
      "--claim",
      "This memory names its entity with a type.",
      "--entity",
      "service:checkout-api"
    ])

    // Two files sharing one bare name, so `files` is a count of claimants and not of distinct names.
    for (const title of ["The first bare namer", "The second bare namer"]) {
      await cli.json([
        "write",
        "--type",
        "semantic",
        "--title",
        title,
        "--claim",
        `${title} writes its entity without a type.`,
        "--entity",
        "payments-api"
      ])
    }

    await cli.json([
      "write",
      "--type",
      "semantic",
      "--title",
      "The third bare namer",
      "--claim",
      "A different bare name entirely.",
      "--entity",
      "ledger-service"
    ])
  })

  it("reports each bare name with how many files claim it, and the typed one not at all", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    // Ordered by claimants descending, so the worst offender leads.
    expect(report.untypedEntities).toEqual([
      { entityName: "payments-api", files: 2 },
      { entityName: "ledger-service", files: 1 }
    ])
    // Distinct NAMES, not files: two claimants of one name count once.
    expect(report.untypedEntityTotal).toBe(2)
  })

  it("leaves healthy alone, because unknown is a supported type rather than a defect", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.untypedEntityTotal).toBeGreaterThan(0)
    // The load-bearing half: a corpus whose only finding is untyped entities is still healthy. Gating
    // on it would turn every hand-authored corpus red for writing metas the way the format allows.
    expect(report.healthy).toBe(true)
  })
})

/**
 * Stuck sleep runs: a `sleep_runs` row a killed process left `running` (issue #146).
 *
 * A run writes its row as `running` before the first phase and rewrites it after the last. A process
 * killed in between never makes the second write, and nothing else revisits earlier rows, so the row
 * says `running` forever. That is a defect in the ledger, like an orphan access row, and doctor is the
 * surface that reports ledger defects. The remedy is not `--fix`: the next `memhtml sleep run` (or
 * `memhtml sleep run --dry-run`) reaps such rows, and the second half of this suite drives exactly that.
 */
describe("doctor reports sleep runs stuck at running", () => {
  let cli: Cli
  const stuck = "sleep/2026-08-18"
  const live = "sleep/2026-08-31"
  let liveStartedAt: string

  beforeAll(async () => {
    cli = await makeCli()
    // One committed memory, so the store has a HEAD, a fresh index, and a clean tree for the dry run.
    await cli.json([
      "write",
      "--type",
      "semantic",
      "--title",
      "A memory so the store is not empty",
      "--claim",
      "The doctor suite needs one committed memory."
    ])

    // The live neighbour's branch exists; the stuck row's does not.
    await git("git", ["-C", cli.root, "branch", live])
    liveStartedAt = `${new Date(Date.now() - 5 * 60 * 1000).toISOString().slice(0, 19)}Z`

    const { DatabaseService } = await import("@memhtml/index")
    const { Effect } = await import("effect")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService
        const insert = `INSERT INTO sleep_runs (run_id, branch, base_sha, head_sha, status, started_at, ended_at)
                        VALUES (?, ?, 'c0ffee00', NULL, 'running', ?, NULL)`
        // Weeks old, `running`, branch gone: the production row the issue names.
        yield* db.run(insert, [stuck, stuck, "2026-08-18T02:00:00Z"])
        // Minutes old, `running`, branch present: a run executing right now on another process.
        yield* db.run(insert, [live, live, liveStartedAt])
      }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
    )
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("names the stuck row, leaves the live one out, and is unhealthy", async () => {
    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.stuckSleepRuns).toEqual([
      { runId: stuck, branch: stuck, startedAt: "2026-08-18T02:00:00Z", branchExists: false }
    ])
    expect(report.healthy).toBe(false)
  })

  it("is healthy again once a sleep run has reaped the row", async () => {
    const reaped = await cli.json<{
      readonly reaped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>
    }>(["sleep", "run", "--dry-run", "--phases", "preflight"])
    expect(reaped.reaped).toEqual([{ runId: stuck, reason: "branch gone" }])

    const report = await cli.json<DoctorReport>(["doctor"])
    expect(report.stuckSleepRuns).toEqual([])
    expect(report.healthy).toBe(true)
  })
})

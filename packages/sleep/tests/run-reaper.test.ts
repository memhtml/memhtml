import type { DatabaseShape } from "@memhtml/index"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { SLEEP_RUN_STALE_AFTER_MS } from "../src/contract.js"
import { run, stuckRunReason } from "../src/run.js"
import { readRun, recordRun } from "../src/sql.js"
import { DEDUP_CORPUS, type Fixture, withFixture } from "./fixture.js"

/**
 * The reaper: what a new `sleep run` does about `sleep_runs` rows an earlier, killed run left behind.
 *
 * A run writes its row as `running` before the first phase and rewrites it when the last phase ends.
 * A process killed in between never reaches the second write, so the row stays `running` with
 * `ended_at IS NULL`, and nothing revisits earlier rows (issue #146). The reaper runs at the start of
 * every `sleep run` and stamps such a row `abandoned` when its branch is gone, or when it started
 * longer ago than {@link SLEEP_RUN_STALE_AFTER_MS}. Every assertion here is against the TABLE and not
 * only the report, because a stuck row is a ledger defect a report cannot show.
 */

const DATE = "2026-08-02"

/** An ISO-8601 UTC second, the shape every `sleep_runs` timestamp takes. */
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** `millisAgo` before now, as the stamp `recordRun` stores. */
const stampAgo = (millisAgo: number): string =>
  `${new Date(Date.now() - millisAgo).toISOString().slice(0, 19)}Z`

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Seed one `sleep_runs` row as a killed run leaves it: `running`, `ended_at` NULL. */
const seedRunning = (fixture: Fixture, runId: string, startedAt: string) =>
  recordRun(fixture.db, {
    runId,
    branch: runId,
    baseSha: "c0ffee00",
    headSha: null,
    status: "running",
    startedAt,
    endedAt: null
  }).pipe(Effect.orDie)

describe("a new sleep run reaps rows an earlier killed run left running", () => {
  it("stamps a running row whose branch is gone as abandoned, and reports it", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * The stuck row: weeks old, `running`, no branch. This is the production shape the issue
           * names, a run whose process was killed and whose branch was deleted by hand afterwards.
           */
          const stuck = "sleep/2026-08-18"
          yield* seedRunning(fixture, stuck, "2026-08-18T02:00:00Z")
          expect(yield* fixture.deps.git.branchExists(stuck).pipe(Effect.orDie)).toBe(false)

          /**
           * A NEIGHBOUR that finished, also weeks old, also branchless. It proves the reaper is a
           * predicate on `status` and not a sweep over old rows: a `review` row is a run waiting on an
           * operator, and it is left exactly as it was.
           */
          const finished = "sleep/2026-08-19"
          yield* recordRun(fixture.db, {
            runId: finished,
            branch: finished,
            baseSha: "c0ffee01",
            headSha: "5ee5ee01",
            status: "review",
            startedAt: "2026-08-19T02:00:00Z",
            endedAt: "2026-08-19T02:40:00Z"
          }).pipe(Effect.orDie)

          const report = yield* run(fixture.deps, { date: DATE, phases: ["preflight"] })
          expect(report.phases.filter((phase) => phase.status === "failed")).toEqual([])

          // THE PROPERTY, at the table: the stuck row is closed, with a timestamp for its end.
          const row = yield* readRun(fixture.db, stuck).pipe(Effect.orDie)
          expect(row?.status).toBe("abandoned")
          expect(row?.ended_at).toMatch(ISO_SECOND)
          expect(row?.started_at).toBe("2026-08-18T02:00:00Z")

          // And the report says so, naming the row and the reason.
          expect(report.reaped).toEqual([{ runId: stuck, reason: "branch gone" }])

          // The neighbour is untouched: same status, same end.
          const neighbour = yield* readRun(fixture.db, finished).pipe(Effect.orDie)
          expect(neighbour?.status).toBe("review")
          expect(neighbour?.ended_at).toBe("2026-08-19T02:40:00Z")

          // The run's own row is the ordinary outcome, not something the reaper touched.
          const own = yield* readRun(fixture.db, report.runId).pipe(Effect.orDie)
          expect(own?.status).toBe("review")
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("leaves a young running row whose branch exists alone: that is a live run", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * Both conditions hold for a run that is executing right now on another process: its branch
           * exists and it started minutes ago. Reaping it would stamp a live run `abandoned` while its
           * phases are still committing, so neither rule may fire.
           */
          const live = "sleep/2026-07-30"
          yield* fixture.raw("branch", live)
          const startedAt = stampAgo(5 * 60 * 1000)
          yield* seedRunning(fixture, live, startedAt)

          const report = yield* run(fixture.deps, { date: DATE, phases: ["preflight"] })

          const row = yield* readRun(fixture.db, live).pipe(Effect.orDie)
          expect(row?.status).toBe("running")
          expect(row?.ended_at).toBeNull()
          expect(row?.started_at).toBe(startedAt)
          expect(report.reaped).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("reaps a running row past the wall-clock budget even when its branch still exists, on a dry run too", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * The branch is still there, so only the age rule can reach this row. Three days is past the
           * one-day budget by a margin no clock skew closes. A DRY run does the reaping, deliberately:
           * the reaper touches only the reporting table, which a dry run already writes for its own row.
           */
          const stale = "sleep/2026-07-29"
          yield* fixture.raw("branch", stale)
          yield* seedRunning(fixture, stale, stampAgo(3 * DAY))
          expect(3 * DAY).toBeGreaterThan(SLEEP_RUN_STALE_AFTER_MS)

          const report = yield* run(fixture.deps, {
            date: DATE,
            phases: ["preflight"],
            dryRun: true
          })
          expect(report.dryRun).toBe(true)

          const row = yield* readRun(fixture.db, stale).pipe(Effect.orDie)
          expect(row?.status).toBe("abandoned")
          expect(row?.ended_at).toMatch(ISO_SECOND)
          expect(report.reaped).toHaveLength(1)
          expect(report.reaped[0]?.runId).toBe(stale)
          expect(report.reaped[0]?.reason).toMatch(/^started 7[12]h ago, past budget$/)

          // The branch is still there: reaping closes the ROW and deletes nothing in git.
          expect(yield* fixture.deps.git.branchExists(stale).pipe(Effect.orDie)).toBe(true)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("reaps a killed run's row under the id this run is about to reuse, then owns the row", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * Issue #110's shape meets the reaper: a run under `sleep/<date>` was killed, its branch deleted
           * by hand, and the sleep rerun the same day. `runIdFor` hands back the SAME id, since the
           * branch is gone. The old row is reaped as `branch gone` and the report names this run's own
           * id, which is the truth about that id's earlier run; this run's `recordRun` then owns the row.
           */
          const reused = `sleep/${DATE}`
          yield* seedRunning(fixture, reused, "2026-08-02T00:05:00Z")

          const report = yield* run(fixture.deps, { date: DATE, phases: ["preflight"] })
          expect(report.runId).toBe(reused)
          expect(report.reaped).toEqual([{ runId: reused, reason: "branch gone" }])

          const row = yield* readRun(fixture.db, reused).pipe(Effect.orDie)
          expect(row?.status).toBe("review")
          expect(row?.started_at).not.toBe("2026-08-02T00:05:00Z")
          expect(row?.started_at).toMatch(ISO_SECOND)
          expect(row?.ended_at).toMatch(ISO_SECOND)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("never writes a running row for a dry run, which has no branch and would read as killed", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * A dry run creates no branch, so a `running` row for it is exactly the shape the reaper and
           * `doctor` classify as stuck. Every write is recorded through a wrapped `run`, because the
           * property is about a row that would exist only DURING the run and is overwritten at its end.
           */
          const writes: Array<ReadonlyArray<unknown>> = []
          const db: DatabaseShape = {
            ...fixture.db,
            run: (sql, params) => {
              writes.push(params ?? [])
              return fixture.db.run(sql, params)
            }
          }
          const report = yield* run(
            { ...fixture.deps, db },
            { date: DATE, phases: ["preflight"], dryRun: true }
          )
          expect(report.dryRun).toBe(true)
          expect(writes.length).toBeGreaterThan(0)
          expect(writes.filter((params) => params.includes("running"))).toEqual([])
          expect((yield* readRun(fixture.db, report.runId).pipe(Effect.orDie))?.status).toBe(
            "abandoned"
          )
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("stuckRunReason, the rule the reaper and doctor share", () => {
  const now = Date.parse("2026-09-05T02:00:03Z")
  const startedAgo = (millis: number): string =>
    `${new Date(now - millis).toISOString().slice(0, 19)}Z`
  const SECOND = 1000

  it("is exact at the bound: one second inside is live, one second past is reaped", () => {
    // Started exactly budget minus one second ago, branch present: still a live run.
    expect(
      stuckRunReason({
        startedAt: startedAgo(SLEEP_RUN_STALE_AFTER_MS - SECOND),
        branchExists: true,
        nowMillis: now
      })
    ).toBeUndefined()
    // One second past the budget: reaped, with the age in whole hours.
    expect(
      stuckRunReason({
        startedAt: startedAgo(SLEEP_RUN_STALE_AFTER_MS + SECOND),
        branchExists: true,
        nowMillis: now
      })
    ).toBe(`started ${String(SLEEP_RUN_STALE_AFTER_MS / HOUR)}h ago, past budget`)
    // The bound itself is not past the bound.
    expect(
      stuckRunReason({
        startedAt: startedAgo(SLEEP_RUN_STALE_AFTER_MS),
        branchExists: true,
        nowMillis: now
      })
    ).toBeUndefined()
  })

  it("reads a branch that is gone as stuck at any age, and an unreadable branch as no evidence", () => {
    expect(
      stuckRunReason({
        startedAt: startedAgo(5 * 60 * SECOND),
        branchExists: false,
        nowMillis: now
      })
    ).toBe("branch gone")
    // git could not say: the branch rule is skipped, and a young row stays a live run.
    expect(
      stuckRunReason({
        startedAt: startedAgo(5 * 60 * SECOND),
        branchExists: undefined,
        nowMillis: now
      })
    ).toBeUndefined()
    // git could not say, but the age rule still reaches an old row.
    expect(
      stuckRunReason({ startedAt: startedAgo(3 * DAY), branchExists: undefined, nowMillis: now })
    ).toBe("started 72h ago, past budget")
  })

  it("skips the age rule on a started_at it cannot parse, rather than reaping on garbage", () => {
    expect(
      stuckRunReason({ startedAt: "not a time", branchExists: true, nowMillis: now })
    ).toBeUndefined()
    expect(
      stuckRunReason({ startedAt: "", branchExists: undefined, nowMillis: now })
    ).toBeUndefined()
    // A gone branch still decides, whatever the stamp says.
    expect(stuckRunReason({ startedAt: "not a time", branchExists: false, nowMillis: now })).toBe(
      "branch gone"
    )
  })
})

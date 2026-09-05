import { StorageFailure } from "@memhtml/contracts/errors"
import { EmbedModelMismatch, IndexStale } from "@memhtml/index"
import { Effect, Logger } from "effect"
import { describe, expect, it } from "vitest"

import type { SleepDeps } from "../src/env.js"
import { merge, review } from "../src/review.js"
import { run } from "../src/run.js"
import { readRun, recordRun } from "../src/sql.js"
import {
  candidate,
  candidates,
  scriptedConsolidator,
  scriptedModel,
  value
} from "../src/testing.js"
import { DEDUP_CORPUS, type Fixture, memoryHtml, seedTrace, withFixture } from "./fixture.js"

/**
 * `review` and `merge`: the reviewable surface and the two refusals.
 *
 * Both refusals are asserted against GIT rather than against the report: a `merge` that returned
 * `merged: false` while having already fast-forwarded would satisfy the report shape and destroy the
 * property it claims.
 */

const DATE = "2026-08-02"

const inertModel = () =>
  scriptedModel((request) =>
    request.system.startsWith("You triage")
      ? value({ entries: [] })
      : request.system.startsWith("You partition")
        ? // dedup-merge's partition call. `groups: []` is a refusal, which leaves the phase on its
          // deterministic arm — the same pairs it folds with no model bound at all.
          value({ groups: [] })
        : value({ verdict: "neutral", confidence: 0.9, rationale: "compatible" })
  )

const headOf = (fixture: Fixture, ref = "HEAD"): Effect.Effect<string> =>
  fixture.raw("rev-parse", ref).pipe(Effect.map((text) => text.trim()))

/** The commit the index describes, read off the watermark row rather than off any report. */
const indexHeadOf = (fixture: Fixture): Effect.Effect<string | null | undefined> =>
  fixture.db.get<{ head_sha: string | null }>("SELECT head_sha FROM index_state LIMIT 1").pipe(
    Effect.map((row) => row?.head_sha),
    Effect.orDie
  )

/** One path's bytes as HEAD holds them, or `null` when HEAD does not hold the path. */
const blobAt = (fixture: Fixture, path: string): Effect.Effect<string | null> =>
  fixture.raw("show", `HEAD:${path}`).pipe(Effect.catchCause(() => Effect.succeed(null)))

describe("review", () => {
  it("reports the phases, the commits with their trailers, the diff stat, and per-file classes", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })
          const reviewed = yield* review(fixture.deps, report.runId)

          expect(reviewed.runId).toBe(report.runId)
          expect(reviewed.branch).toBe(report.branch)
          expect(reviewed.baseSha).toBe(report.baseSha)

          // Every phase the run executed has a row, read back out of the reporting tables.
          expect(reviewed.phases.length).toBe(report.phases.length)

          // Every commit carries a resolved phase and parsed counts — the trailers round-tripped.
          expect(reviewed.commits.length).toBeGreaterThan(0)
          expect(reviewed.commits.every((commit) => commit.phase !== null)).toBe(true)
          expect(reviewed.commits.some((commit) => Object.keys(commit.counts).length > 0)).toBe(
            true
          )

          expect(reviewed.diffStat).toContain("|")
          expect(reviewed.files.length).toBeGreaterThan(0)

          /**
           * The classification is the substance. An archive is `archived` (a rename into `archive/`), a
           * decay is `meta-only` (the article hash is unchanged, which the byte-splice editors
           * guarantee), a generated artifact is `created`. `git diff --stat` distinguishes none of them.
           */
          const classes = new Set(reviewed.files.map((file) => file.classification))
          expect(classes.has("archived")).toBe(true)
          expect(classes.has("meta-only")).toBe(true)
          expect(classes.has("created")).toBe(true)

          // Every `archived` entry names where it came from, and sits under the year partition.
          for (const file of reviewed.files.filter((one) => one.classification === "archived")) {
            expect(file.path.startsWith("archive/2026/")).toBe(true)
            expect(file.fromPath).toBeDefined()
          }

          /**
           * NO classification is `body-changed` for a file the run only stamped. This is the assertion
           * that would break if any phase went back to parse→serialize for a head edit: parse5's
           * serializer drops a `<pre>` newline per write, so the article hash would move and every
           * stamped file would read as a rewritten one.
           */
          const decayed = reviewed.files.filter((one) => one.classification === "meta-only")
          expect(decayed.length).toBeGreaterThan(0)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("classifies a consolidated memory as created and its commit as trace-consolidation", async () => {
    /**
     * The reviewable surface for the newest committing phase, and the last link in TRACE-3's chain.
     *
     * A commit is behind the discrimination gate because it is on the branch, but a reviewer can only
     * ACT on it if `review` resolves its phase and classifies its file — an unclassified path or a
     * `phase: null` commit would be a mutation landing with nothing to read about it. Both are asserted
     * here rather than inferred from the trailers being present.
     */
    const consolidator = scriptedConsolidator(() =>
      candidates([
        candidate({
          claim: "Partial indexes on this driver need the predicate restated in the query.",
          gist: "Two lookups planned as a scan until the redundant clause was added.",
          kind: "error_pattern"
        })
      ])
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })

          const report = yield* run(fixture.deps, { date: DATE })
          const reviewed = yield* review(fixture.deps, report.runId)

          // The commit resolves to the phase, with its counts parsed out of the trailer.
          const traceCommits = reviewed.commits.filter(
            (commit) => commit.phase === "trace-consolidation"
          )
          expect(traceCommits).toHaveLength(1)
          expect(traceCommits[0]?.counts.written).toBe(1)

          /**
           * And its file is classified `created`. Which path that is comes from the phase's own
           * placement rules, so the test finds it by what a consolidated memory IS — a created
           * `.html` outside `archive/` that is not a generated listing — rather than restating a path
           * the rules could legitimately change.
           */
          const created = reviewed.files.filter(
            (file) =>
              file.classification === "created" &&
              file.path.endsWith(".html") &&
              !file.path.startsWith("archive/") &&
              !file.path.endsWith("/index.html")
          )
          expect(created.length).toBeGreaterThan(0)
        }),
      { seed: DEDUP_CORPUS, model: inertModel(), consolidator }
    )
  })
})

describe("merge", () => {
  it("fast-forwards main when it has not moved", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })
          const branchHead = yield* headOf(fixture)

          const merged = yield* merge(fixture.deps, report.runId)

          expect(merged.merged).toBe(true)
          expect(merged.refusal).toBeUndefined()
          /**
           * The state-plane ledger reports no SHORTFALL. `marksPending` is what the branch earned and
           * `marksApplied` what the plane took, and a merge where they disagree is a plane write that did
           * not land — the abort suite drives the numbers themselves; this holds the invariant on the
           * ordinary path, including a night that earned nothing.
           */
          expect(merged.marksApplied).toBe(merged.marksPending)
          // main IS the branch tip now, and HEAD is on main — a fast-forward, not a merge commit.
          expect(yield* headOf(fixture, "main")).toBe(branchHead)
          expect((yield* fixture.raw("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main")
          // Fast-forward only: the tip has exactly one parent.
          const parents = (yield* fixture.raw("rev-list", "--parents", "-n", "1", "HEAD")).trim()
          expect(parents.split(" ").length).toBe(2)

          /**
           * Issue #145: the merge is not finished until the index describes the commit it produced.
           * The watermark is read from its row, because a report saying `indexUpdated` over a row
           * still naming the pre-merge commit would be the defect itself.
           */
          expect(yield* indexHeadOf(fixture)).toBe(branchHead)
          expect(merged.indexUpdated).toBe(true)
          expect(merged.indexHeadSha).toBe(branchHead)
          expect(merged.indexError).toBeUndefined()
          expect(typeof merged.indexAdded).toBe("number")
          expect(typeof merged.embeddingsWritten).toBe("number")
          expect(merged.indexSkipped).toBe(0)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("closes a row still marked running with a timestamp, never a sha, when it merges the run", async () => {
    /**
     * Issue #146. A run killed after its first `recordRun` leaves the row `running` with `ended_at`
     * NULL, and `merge` does not read status, so an operator can land that branch. The row it writes
     * then has to be a finished run: `merged`, with an `ended_at` that is a TIME. The merge's own
     * commit sha is what stands in for a missing `ended_at` otherwise, and a sha in a timestamp column
     * is a row every reader of `started_at`/`ended_at` misparses.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE, phases: ["preflight"] })
          // Put the row back the way a killed process leaves it. The branch and its commits stay.
          yield* recordRun(fixture.db, {
            runId: report.runId,
            branch: report.branch,
            baseSha: report.baseSha,
            headSha: null,
            status: "running",
            startedAt: "2026-08-02T00:10:00Z",
            endedAt: null
          }).pipe(Effect.orDie)

          const merged = yield* merge(fixture.deps, report.runId)
          expect(merged.merged).toBe(true)

          const row = yield* readRun(fixture.db, report.runId).pipe(Effect.orDie)
          expect(row?.status).toBe("merged")
          expect(row?.ended_at).not.toBeNull()
          expect(row?.ended_at).not.toBe(merged.headSha)
          expect(row?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
          // No row for this run id is left `running`: the merge is the run's end.
          const running = yield* fixture.db
            .all<{ run_id: string }>(
              "SELECT run_id FROM sleep_runs WHERE status = 'running' AND run_id = ?",
              [report.runId]
            )
            .pipe(Effect.orDie)
          expect(running).toEqual([])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it.each([
    {
      tag: "IndexStale",
      error: new IndexStale("a rebuild died inside its window"),
      recovery: "memhtml index rebuild --embed"
    },
    {
      tag: "EmbedModelMismatch",
      error: new EmbedModelMismatch("old-model@1024", "new-model@1024"),
      recovery: "memhtml index rebuild --embed"
    },
    {
      tag: "StorageFailure",
      error: StorageFailure.make({ operation: "index.write" }),
      recovery: "memhtml index update --embed"
    }
  ])(
    "reports a failed index update ($tag) without failing a merge whose main has moved",
    async ({ tag, error, recovery }) => {
      /**
       * Issue #145, the failure arm, once per error the indexer's `update` can raise. `main` has moved
       * and the memories are landed, so the outcome is a value on the report plus a WARN naming that
       * error's one recovery, never a merge that reports failure over a `main` that moved. Asserted
       * against git as well: the fast-forward happened.
       */
      await withFixture(
        (fixture) =>
          Effect.gen(function* () {
            const report = yield* run(fixture.deps, { date: DATE })
            const branchHead = yield* headOf(fixture)
            const watermarkBefore = yield* indexHeadOf(fixture)

            const deps: SleepDeps = {
              ...fixture.deps,
              indexer: {
                ...fixture.deps.indexer,
                update: () => Effect.fail(error)
              }
            }
            const warnings: Array<string> = []
            const captured = Logger.make((options) => {
              if (options.logLevel === "Warn") warnings.push(String(options.message))
            })

            const merged = yield* merge(deps, report.runId).pipe(
              Effect.provide(Logger.layer([captured]))
            )

            expect(merged.merged).toBe(true)
            expect(merged.refusal).toBeUndefined()
            expect(yield* headOf(fixture, "main")).toBe(branchHead)
            expect(merged.indexUpdated).toBe(false)
            expect(merged.indexError).toContain(tag)
            expect(merged.indexHeadSha).toBeUndefined()
            // The watermark is exactly where the failed update left it, and the warning says which recovery.
            expect(yield* indexHeadOf(fixture)).toBe(watermarkBefore)
            const warning = warnings.find((line) => line.startsWith("sleep.merge landed"))
            expect(warning).toContain(branchHead)
            expect(warning).toContain(recovery)
          }),
        { seed: DEDUP_CORPUS, model: inertModel() }
      )
    }
  )

  it("merges a disjoint advance with a merge commit that keeps both sides", async () => {
    /**
     * Issue #108. An agent writing an UNRELATED memory on main while the sleep branch sits in
     * review is a schedule collision, not a real conflict — and refusing it forfeits the whole
     * night's model calls. When the paths main gained and the paths the branch wrote are provably
     * disjoint, the merge proceeds with a merge commit that preserves both sides, and the pending
     * marks the branch earned are still applied.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })
          const branchHead = yield* headOf(fixture)

          // An agent writes a memory on main while the sleep branch sits in review. The path is
          // new, so it is disjoint from anything the branch touched by construction.
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.commit(
            [
              {
                path: "areas/team/written-during-review.html",
                html: memoryHtml({
                  title: "Written while the sleep branch was in review",
                  claim: "An agent kept writing while curation was under review."
                })
              }
            ],
            "an ordinary write during review"
          )

          const merged = yield* merge(fixture.deps, report.runId)

          expect(merged.merged).toBe(true)
          expect(merged.refusal).toBeUndefined()
          expect(merged.marksApplied).toBe(merged.marksPending)

          // Both sides are on main: the agent's write and the branch's work.
          expect((yield* fixture.raw("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main")
          expect(yield* blobAt(fixture, "areas/team/written-during-review.html")).not.toBeNull()

          /**
           * Issue #145 on the merge-commit shape. HEAD is main after `mergeBothSides`, so the update
           * projects the merged tree: the watermark names the merge commit and the agent's own write,
           * which the branch never saw, has a `files` row beside the night's work.
           */
          const mergedHead = yield* headOf(fixture, "main")
          expect(yield* indexHeadOf(fixture)).toBe(mergedHead)
          expect(merged.indexUpdated).toBe(true)
          expect(merged.indexHeadSha).toBe(mergedHead)
          const projected = yield* fixture.db
            .get<{ path: string }>("SELECT path FROM files WHERE path = ?", [
              "areas/team/written-during-review.html"
            ])
            .pipe(Effect.orDie)
          expect(projected?.path).toBe("areas/team/written-during-review.html")

          const merges = yield* fixture.raw("rev-list", "--merges", "-n", "1", "HEAD")
          expect(merges.trim()).not.toBe("")
          const branchReachable = yield* fixture.raw(
            "merge-base",
            "--is-ancestor",
            branchHead,
            "HEAD"
          )
          expect(branchReachable).toBeDefined()
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("refuses when the advance overlaps the branch, names the overlap, and leaves main where it was", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })

          /**
           * The overlapping path is found by asking the branch what it wrote, never by restating a
           * placement rule: any path the run's own diff names will do, and the first sorted one is
           * deterministic.
           */
          const touched = (yield* fixture.raw(
            "diff",
            "--name-only",
            `${report.baseSha}..${report.runId}`
          ))
            .split("\n")
            .filter((path) => path.endsWith(".html"))
            .sort()
          const collision = touched[0]
          expect(collision).toBeDefined()

          // An agent rewrites one of those same paths on main while the branch sits in review.
          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.commit(
            [
              {
                path: collision ?? "",
                html: memoryHtml({
                  title: "Rewritten while the sleep branch was in review",
                  claim: "An agent corrected this memory after the sleep read it."
                })
              }
            ],
            "a conflicting write during review"
          )
          const movedMain = yield* headOf(fixture, "main")

          const refused = yield* merge(fixture.deps, report.runId)

          expect(refused.merged).toBe(false)
          expect(refused.refusal).toBe("main-advanced")
          // The report names the collision, so an operator can tell a real overlap from two
          // writers sharing a slot.
          expect(refused.overlap).toContain(collision)
          /**
           * main did NOT move. The run curated a corpus that no longer exists — a decay computed
           * against a confidence an agent has since corrected — so the operator reruns the sleep,
           * which is cheap because every phase is idempotent.
           */
          expect(yield* headOf(fixture, "main")).toBe(movedMain)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("refuses an advance whose touched sets cannot be read, rather than guessing", async () => {
    /**
     * The conservative arm: disjointness is a positive proof, and a diff that cannot be read is
     * not a proof. The seam replaces `diffNameStatus` because no real-git provocation makes the
     * advance readable for the run but unreadable for the guard.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })

          yield* fixture.deps.git.checkoutBranch("main").pipe(Effect.orDie)
          yield* fixture.commit(
            [
              {
                path: "areas/team/written-during-review.html",
                html: memoryHtml({
                  title: "Written while the sleep branch was in review",
                  claim: "An agent kept writing while curation was under review."
                })
              }
            ],
            "an ordinary write during review"
          )
          const movedMain = yield* headOf(fixture, "main")

          const deps = {
            ...fixture.deps,
            git: {
              ...fixture.deps.git,
              diffNameStatus: () =>
                Effect.fail({ _tag: "GitFailure", message: "unreadable" } as never)
            }
          }
          const refused = yield* merge(deps, report.runId)

          expect(refused.merged).toBe(false)
          expect(refused.refusal).toBe("main-advanced")
          expect(yield* headOf(fixture, "main")).toBe(movedMain)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("refuses when the pre-merge gate fails, and leaves main where it was", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })
          const mainBefore = yield* headOf(fixture, "main")

          /**
           * The gate is the caller's quality refusal — T10 wires the discrimination eval here. A sleep
           * run that degrades retrieval quality cannot land, and the refusal is the point.
           */
          const refused = yield* merge(fixture.deps, report.runId, {
            preMergeGate: Effect.fail("discrimination regressed")
          })

          expect(refused.merged).toBe(false)
          expect(refused.refusal).toBe("gate-failed")
          expect(yield* headOf(fixture, "main")).toBe(mainBefore)

          // And with the gate passing, the same run merges — so the refusal was the gate, not the run.
          const allowed = yield* merge(fixture.deps, report.runId, { preMergeGate: Effect.void })
          expect(allowed.merged).toBe(true)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("refuses on an unknown run rather than merging whatever HEAD happens to be", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const mainBefore = yield* headOf(fixture, "main")
          const refused = yield* merge(fixture.deps, "sleep/1999-01-01")
          expect(refused.merged).toBe(false)
          expect(refused.refusal).toBe("no-run")
          expect(yield* headOf(fixture, "main")).toBe(mainBefore)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })
})

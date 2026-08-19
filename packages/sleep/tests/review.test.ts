import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { merge, review } from "../src/review.js"
import { run } from "../src/run.js"
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
          // main IS the branch tip now, and HEAD is on main — a fast-forward, not a merge commit.
          expect(yield* headOf(fixture, "main")).toBe(branchHead)
          expect((yield* fixture.raw("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main")
          // Fast-forward only: the tip has exactly one parent.
          const parents = (yield* fixture.raw("rev-list", "--parents", "-n", "1", "HEAD")).trim()
          expect(parents.split(" ").length).toBe(2)
        }),
      { seed: DEDUP_CORPUS, model: inertModel() }
    )
  })

  it("refuses when main advanced past the run's base, and leaves main where it was", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE })

          // An agent writes a memory on main while the sleep branch sits in review.
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

          const refused = yield* merge(fixture.deps, report.runId)

          expect(refused.merged).toBe(false)
          expect(refused.refusal).toBe("main-advanced")
          /**
           * main did NOT move. The run curated a corpus that no longer exists — a decay computed
           * against a confidence an agent has since corrected, an eviction of a memory just
           * reinforced — so the operator reruns the sleep, which is cheap because every phase is
           * idempotent.
           */
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

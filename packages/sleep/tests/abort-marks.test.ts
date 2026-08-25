import { STATE_SCHEMA } from "@memhtml/index"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { pendingMarksPath } from "../src/contract.js"
import type { PhaseEnv } from "../src/env.js"
import {
  edgeTyping,
  edgeTypingCandidates,
  PROMOTION_DETECTIONS,
  promotionKey
} from "../src/phases/edge-typing.js"
import { traceConsolidation } from "../src/phases/trace-consolidation.js"
import { merge } from "../src/review.js"
import { instantFor, run } from "../src/run.js"
import {
  candidate,
  candidates,
  scriptedConsolidator,
  scriptedModel,
  value
} from "../src/testing.js"
import {
  appliedWatermarks,
  applyLedger,
  corroborations,
  discardBranch,
  ledgerAtHead,
  pendingMarks,
  pendingSessions,
  reselectable
} from "./abort-fixture.js"
import { DEDUP_CORPUS, type Fixture, seedCorroboration, seedTrace, withFixture } from "./fixture.js"

/**
 * The abort, as a property of the STATE PLANE rather than of git.
 *
 * `git branch -D` is this design's whole abort story, and it can only be true if nothing a phase does
 * outlives its branch. Two writes are not undoable by a discard — `trace_consolidations`, which survives
 * an index rebuild by construction, and `.memhtml/state.db`, which is not rebuildable from the tree at
 * all — so both are recorded as marks on the branch and applied by `merge`. These cases are the ones
 * that would have gone green against the pre-ledger phases and green against the ledger, so each states
 * the plane BEFORE the discard as well as after.
 *
 * A NEIGHBOUR RUN's rows are seeded throughout. `trace_consolidations` is keyed on the session and
 * shared across every run that ever read one, and `edge_corroboration` is shared across every pair, so
 * a clean database agrees exactly with a phase that writes the plane directly: "the table is empty" and
 * "the table holds only what somebody else put there" are different assertions, and only the second one
 * can fail for the right reason.
 */

const DATE = "2026-08-08"
/** A run that landed BEFORE the one under test, whose rows must be untouched by any of this. */
const NEIGHBOUR_RUN = "sleep/2026-08-01"

const SAFE = "areas/deploy/blue-green-is-safe.html"
const NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"

const envFor = (fixture: Fixture, date: string = DATE): PhaseEnv => {
  const instant = instantFor(date)
  return {
    deps: fixture.deps,
    runId: `sleep/${date}`,
    branch: `sleep/${date}`,
    baseSha: "",
    date,
    at: instant.at,
    atMillis: instant.millis,
    dryRun: false
  }
}

const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * The keys the batch offered whose text names `needle`, read off the recorded prompt.
 *
 * A reply keyed by ordinal would answer about whichever pair the batch's sort put first, so it would
 * silently move onto a different pair the day the ordering changed while the assertions stayed green.
 */
const pairKeysWithText = (prompt: string, needle: string): ReadonlyArray<string> =>
  [...prompt.matchAll(/<pair_(m\d+)>\n([\s\S]*?)\n<\/pair_m\d+>/g)].flatMap((match) =>
    (match[2] ?? "").includes(needle) ? [match[1] as string] : []
  )

/** A model that calls the flip pair a contradiction and answers nothing about any other pair. */
const contradictingModel = () =>
  scriptedModel((request) =>
    value({
      verdicts: pairKeysWithText(request.prompt, "is not safe").map((key) => ({
        pairKey: key,
        rel: "contradicts",
        direction: "src_to_dst",
        confidence: 0.95,
        rationale: "scripted"
      }))
    })
  )

/**
 * A model that answers every OTHER phase harmlessly, for the cases that drive a whole run.
 *
 * `groups: []` and `entries: []` are refusals the phases handle, which leaves dedup and arc synthesis on
 * their deterministic arms; the fall-through payload decodes against no phase's schema, so those phases
 * count a skipped batch and stay green. What these cases need from a run is its trace-consolidation
 * marks, not its judgments.
 */
const inertModel = () =>
  scriptedModel((request) =>
    request.system.startsWith("You triage")
      ? value({ entries: [] })
      : request.system.startsWith("You partition")
        ? value({ groups: [] })
        : value({ verdict: "neutral", confidence: 0.9, rationale: "compatible" })
  )

/** Drop every `memhtml-contradicts` link from a file and commit it, as a reviewer editing the branch. */
const stripContradicts = (fixture: Fixture, path: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const html = yield* atHead(fixture, path)
    if (html === undefined) return
    const stripped = html
      .split("\n")
      .filter((line) => !line.includes('rel="memhtml-contradicts"'))
      .join("\n")
    yield* fixture.commit([{ path, html: stripped }], `drop the proposed contradiction on ${path}`)
  }).pipe(Effect.asVoid)

/** A consolidator that distils one candidate, so trace-consolidation has a memory to commit. */
const oneCandidate = () =>
  scriptedConsolidator(() =>
    candidates([
      candidate({
        claim: "Partial indexes on this driver need the predicate restated in the query.",
        gist: "Two lookups planned as a scan until the redundant clause was added.",
        kind: "error_pattern"
      })
    ])
  )

/**
 * A neighbour run's already-landed rows: one consolidated session and one promoted contradiction.
 *
 * Both are written through the SQL the merge itself uses, so the seeded state is state a real landed run
 * produces. The promoted row names the dedup corpus's metrics pair, which no case here judges, so
 * "the promotion under test is unset" cannot pass by reading an empty table.
 */
const seedNeighbour = (fixture: Fixture): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* seedTrace(fixture, { sessionId: "session-neighbour" })
    yield* fixture.db
      .run(
        `INSERT INTO trace_consolidations (session_id, run_id, consolidated_at)
         VALUES ('session-neighbour', ?, '2026-08-01T00:00:00Z')`,
        [NEIGHBOUR_RUN]
      )
      .pipe(Effect.orDie)
    yield* fixture.db
      .run(
        `INSERT INTO ${STATE_SCHEMA}.edge_corroboration
           (src_path, rel, dst_path, detections, confirmed, promoted, updated_at)
         VALUES ('areas/metrics/scrape-cadence.html', 'contradicts',
                 'areas/metrics/exporter-scrape-interval.html', 2, 1, 1, '2026-08-01T00:00:00Z')`
      )
      .pipe(Effect.orDie)
  }).pipe(Effect.asVoid)

/** The corroboration row for the pair edge typing will judge, in the orientation the scan produced. */
const flipPair = (fixture: Fixture) =>
  edgeTypingCandidates(fixture.db).pipe(
    Effect.map((pairs) =>
      pairs.find(
        (one) =>
          (one.src === SAFE && one.dst === NOT_SAFE) || (one.src === NOT_SAFE && one.dst === SAFE)
      )
    ),
    Effect.orDie
  )

describe("a discarded sleep branch discards its state-plane marks", () => {
  it("re-offers every session and leaves every promotion unset after `git branch -D`", async () => {
    /**
     * The finding, end to end. Three writes used to survive the discard, and the consolidation watermark
     * was the one that cost content: `trace_consolidations` is an ANTI-JOIN, so a row for a session whose
     * distilled memory went away with the branch removes that session from every future batch — the
     * transcript is unreadable forever with a row asserting it was handled.
     *
     * (Mutation: restoring `markSessionsConsolidated(env.deps.db, …)` inside trace-consolidation drops
     * `session-a` and `session-b` from the re-selectable set and fails this; restoring
     * `markPromoted(env.deps.db, …)` inside edge-typing leaves the flip pair `promoted = 1` and fails the
     * second half. Each was verified by reverting that one line and watching this case fail.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedNeighbour(fixture)
          yield* seedTrace(fixture, { sessionId: "session-a" })
          yield* seedTrace(fixture, { sessionId: "session-b" })

          /** One detection short, so this night's judgment is the second and really does promote. */
          const pair = yield* flipPair(fixture)
          expect(pair).toBeDefined()
          yield* seedCorroboration(fixture.db, {
            srcPath: pair?.src ?? "",
            dstPath: pair?.dst ?? "",
            detections: PROMOTION_DETECTIONS - 1
          })

          const runId = `sleep/${DATE}`
          yield* fixture.raw("checkout", "-b", runId)

          // Phase six, then phase twelve: the two phases that earn state-plane writes.
          const typed = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model: contradictingModel() }
          })
          expect(typed.counts.promoted).toBe(1)
          const consolidated = yield* traceConsolidation({
            ...envFor(fixture),
            deps: { ...fixture.deps, consolidator: oneCandidate() }
          })
          /** TWO, not three: the neighbour's applied watermark keeps its session out of the batch. */
          expect(consolidated.counts.batch).toBe(2)
          expect(consolidated.counts.consolidated).toBe(2)

          /**
           * On the branch the run has EARNED all three marks and applied none of them. Both halves matter:
           * a run that earned nothing would make the discard assertions below vacuous.
           */
          const earned = yield* pendingMarks(fixture, runId)
          expect(earned.filter((mark) => mark.kind === "session-consolidated")).toHaveLength(2)
          expect(earned.filter((mark) => mark.kind === "edge-promoted")).toHaveLength(1)
          expect(yield* atHead(fixture, SAFE)).toContain("memhtml-contradicts")
          expect(yield* appliedWatermarks(fixture)).toEqual([
            { session_id: "session-neighbour", run_id: NEIGHBOUR_RUN }
          ])

          yield* discardBranch(fixture, runId)

          /** The ledger went with the branch, so there is nothing left to apply by accident. */
          expect(yield* ledgerAtHead(fixture, runId)).toBeUndefined()
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")

          /**
           * The two sessions the discarded run read are BACK ON OFFER, and the neighbour's is not —
           * which is what says the anti-join still works and this is not a table that was simply emptied.
           */
          expect(yield* reselectable(fixture)).toEqual(["session-a", "session-b"])

          /**
           * The plane is exactly the neighbour's: its watermark and its promotion, and nothing of the
           * discarded run's. The flip pair keeps its DETECTION — corroboration counts nights that judged
           * the pair and a discarded night did judge it — while `promoted` stays 0, which is the state
           * that leaves the pair re-eligible for a night that actually lands.
           */
          expect(yield* appliedWatermarks(fixture)).toEqual([
            { session_id: "session-neighbour", run_id: NEIGHBOUR_RUN }
          ])
          const counters = yield* corroborations(fixture)
          const flip = counters.find(
            (row) => row.src_path === (pair?.src ?? "") && row.dst_path === (pair?.dst ?? "")
          )
          expect(flip?.promoted).toBe(0)
          expect(flip?.confirmed).toBe(0)
          const neighbour = counters.find(
            (row) => row.src_path === "areas/metrics/scrape-cadence.html"
          )
          expect(neighbour?.promoted).toBe(1)
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("`merge` applies a run's pending marks", () => {
  it("applies every mark once, reports what it applied, and stays put on a second apply", async () => {
    /**
     * The other side of the abort: a run that LANDS must reach exactly the plane the direct writes used
     * to reach, and reaching it twice must be indistinguishable from reaching it once, because a merge
     * retries. Driven through the whole `run` → `merge` path rather than through one phase, since the
     * ledger's committed location and the branch `merge` reads it from are the parts a phase test cannot
     * see.
     *
     * (Mutation: dropping the `applyMarks` call from `merge` leaves `trace_consolidations` holding only
     * the neighbour's row and fails the first half; making the applier issue the watermark upsert as a
     * plain `INSERT` fails the second, since the second apply would raise on the primary key.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedNeighbour(fixture)
          yield* seedTrace(fixture, { sessionId: "session-a" })

          const report = yield* run(fixture.deps, { date: DATE })
          expect(report.phases.filter((phase) => phase.status === "failed")).toEqual([])
          expect(yield* pendingSessions(fixture, report.runId, report.branch)).toEqual([
            "session-a"
          ])
          // Still a proposal while the branch sits in review, beside the neighbour's landed row.
          expect(yield* appliedWatermarks(fixture)).toEqual([
            { session_id: "session-neighbour", run_id: NEIGHBOUR_RUN }
          ])

          const merged = yield* merge(fixture.deps, report.runId)
          expect(merged.merged).toBe(true)
          /** Reported, and AGREEING: a shortfall between these two is a plane write that did not land. */
          expect(merged.marksPending).toBe(1)
          expect(merged.marksApplied).toBe(1)

          expect(yield* appliedWatermarks(fixture)).toEqual([
            { session_id: "session-a", run_id: report.runId },
            { session_id: "session-neighbour", run_id: NEIGHBOUR_RUN }
          ])
          // The landed session is off the anti-join's offer; the neighbour's was already off it.
          expect(yield* reselectable(fixture)).toEqual([])

          /**
           * Applying the same ledger again reaches the same plane, byte for byte across every column a
           * second application could move. That is what makes a retried merge safe to run blind.
           */
          const before = yield* appliedWatermarks(fixture)
          const countersBefore = yield* corroborations(fixture)
          expect(yield* applyLedger(fixture, report.runId)).toBe(1)
          expect(yield* appliedWatermarks(fixture)).toEqual(before)
          expect(yield* corroborations(fixture)).toEqual(countersBefore)
        }),
      { seed: DEDUP_CORPUS, model: inertModel(), consolidator: oneCandidate() }
    )
  })

  it("applies NOTHING when the pre-merge gate refuses", async () => {
    /**
     * The refusal has to reach the plane as well as `main`. A merge that ran its gate, refused, and had
     * already watermarked the batch would have spent the transcripts on a branch it then declined to
     * land — the same loss the discard case describes, arrived at through the quality gate.
     *
     * (Mutation: moving `applyMarks` above the gate check applies the watermark and fails this.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* seedTrace(fixture, { sessionId: "session-a" })
          const report = yield* run(fixture.deps, { date: DATE })

          const refused = yield* merge(fixture.deps, report.runId, {
            preMergeGate: Effect.fail("discrimination regressed")
          })
          expect(refused.refusal).toBe("gate-failed")
          expect(refused.marksApplied).toBeUndefined()
          expect(yield* appliedWatermarks(fixture)).toEqual([])
          expect(yield* reselectable(fixture)).toEqual(["session-a"])

          // And with the gate passing, the SAME run's marks land: the refusal was the gate.
          const allowed = yield* merge(fixture.deps, report.runId, { preMergeGate: Effect.void })
          expect(allowed.marksApplied).toBe(1)
          expect(yield* reselectable(fixture)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model: inertModel(), consolidator: oneCandidate() }
    )
  })
})

describe("the run's own view of the state plane", () => {
  it("counts a promotion its ledger already carries as earned, not as new work", async () => {
    /**
     * The overlay. `edge_corroboration.promoted` answers `0` for a promotion this run has recorded and
     * not yet merged, so a second reading of one pair inside one run would re-enter the promotion path
     * for an edge the run has already earned and count it a second time. The run's view is therefore
     * the DATABASE plus its own ledger.
     *
     * The `<link>`s are removed between the passes, which is what makes the assertion non-vacuous:
     * `stampFile` answers `false` on a head that already carries the edge, so with the links in place
     * both implementations report `promoted: 0` and the overlay could be deleted unnoticed. Stripping
     * them puts the tree back in the state where a write WOULD land, and the ledger is then the only
     * thing that says the write is already earned.
     *
     * (Mutation: dropping `promotedKeys.has(promotion)` from the promotion guard makes the second pass
     * report `promoted: 1` and re-stamp both files. Verified by reverting that clause.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pair = yield* flipPair(fixture)
          expect(pair).toBeDefined()
          yield* seedCorroboration(fixture.db, {
            srcPath: pair?.src ?? "",
            dstPath: pair?.dst ?? "",
            detections: PROMOTION_DETECTIONS - 1
          })

          const env = { ...envFor(fixture), deps: { ...fixture.deps, model: contradictingModel() } }
          const first = yield* edgeTyping(env)
          expect(first.counts.promoted).toBe(1)
          expect(yield* pendingMarks(fixture, env.runId)).toHaveLength(1)

          /** An operator drops the machine-proposed edge from both files while the branch is in review. */
          yield* stripContradicts(fixture, SAFE)
          yield* stripContradicts(fixture, NOT_SAFE)
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")

          const second = yield* edgeTyping(env)
          expect(second.counts.contradictions).toBe(1)
          expect(second.counts.promoted).toBe(0)
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")
          /** And no duplicate mark: one earned promotion is one line, however often it is re-read. */
          expect(yield* pendingMarks(fixture, env.runId)).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("keys a promotion in the ORIENTATION the counter row holds", async () => {
    /**
     * `edge_corroboration`'s primary key is `(src_path, rel, dst_path)` as the bump wrote it, and the
     * overlay's question is whether the run already earned the UPDATE against that row. A sorted key
     * would collapse two rows the table keeps apart, so a pair whose orientation a later night flips
     * would read as already promoted with its own row untouched.
     *
     * (Mutation: sorting the endpoints inside `promotionKey` fails the second assertion.)
     */
    expect(promotionKey("a.html", "contradicts", "b.html")).toBe(
      promotionKey("a.html", "contradicts", "b.html")
    )
    expect(promotionKey("a.html", "contradicts", "b.html")).not.toBe(
      promotionKey("b.html", "contradicts", "a.html")
    )
    // And the rel is part of it: one pair can earn different verdicts, and each is its own row.
    expect(promotionKey("a.html", "contradicts", "b.html")).not.toBe(
      promotionKey("a.html", "caused_by", "b.html")
    )
  })
})

describe("the pending ledger's committed location", () => {
  it("lives beside the run's report, under the same run-id-to-filename rule", () => {
    expect(pendingMarksPath("sleep/2026-08-08")).toBe(
      ".memhtml/sleep/sleep-2026-08-08.pending.jsonl"
    )
    expect(pendingMarksPath("sleep/2026-08-08-2")).toBe(
      ".memhtml/sleep/sleep-2026-08-08-2.pending.jsonl"
    )
  })
})

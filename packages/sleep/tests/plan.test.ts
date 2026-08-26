import type { DatabaseShape } from "@memhtml/index"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { TRACE_MIN_BYTES, TRACE_QUIET_MILLIS } from "../src/phases/trace-consolidation.js"
import { plan } from "../src/plan.js"
import { type Fixture, memoryHtml, type SeedFile, withFixture } from "./fixture.js"

/**
 * `sleep plan`: the cheap effect predicate, and the two properties that make it worth having.
 *
 * The FIRST is honesty. Two phases select candidate PAIRS from an n-by-n neighbor scan, so their
 * candidate count is not cheaply computable — computing it is the scan. Those report an input
 * cardinality and an explicit unknown, and the verdict has an `unknown` value because of them. A
 * predicate that answered "no effect" because it did not look would be worse than no predicate, and
 * a caller acting on a fabricated zero skips a run that had work.
 *
 * The SECOND is cost. The whole point is to be cheaper than `--dry-run`, which executes all seventeen
 * phases and lets each one decline to write. So the statement COUNT is asserted to be fixed and
 * identical over a corpus ten times larger. Statement count rather than wall time, because a timing
 * assertion on a shared machine measures the machine: this repo has a recorded case of a metric
 * describing the harness rather than the subject. A read whose work grew with n² would either issue
 * per-row statements or show a self-join in its plan, and both are checked.
 */

const AT_MILLIS = Date.parse("2026-08-20T00:00:00Z")

/** A settled transcript: over the byte floor, with an mtime the quiet window has already passed. */
const settledTrace = (db: DatabaseShape, sessionId: string) =>
  db.run(
    `INSERT INTO traces (session_id, slug, file_path, file_size, file_mtime, started_at, indexed_at)
     VALUES (?, '-tmp-traces', ?, ?, ?, ?, ?)`,
    [
      sessionId,
      `/tmp/traces/${sessionId}.jsonl`,
      TRACE_MIN_BYTES + 1,
      new Date(AT_MILLIS - TRACE_QUIET_MILLIS - 60_000).toISOString(),
      "2026-08-19T00:00:00Z",
      "2026-08-19T01:00:00Z"
    ]
  )

/** `n` distinct curatable memories, cheap to seed and enough to make a corpus grow. */
const corpusOf = (count: number): ReadonlyArray<SeedFile> =>
  Array.from({ length: count }, (_, at) => ({
    path: `areas/inbox/plan-subject-${String(at).padStart(3, "0")}.html`,
    html: memoryHtml({
      title: `Plan subject ${String(at)}`,
      claim: `Subject ${String(at)} states one distinct fact about topic ${String(at)}.`,
      body: `Body ${String(at)} carries vocabulary ${String(at)} and nothing shared with its siblings.`,
      memoryType: "semantic",
      updatedAt: "2026-08-19T00:00:00Z"
    })
  }))

/** A `DatabaseShape` that counts the statements issued through it, passing each one along. */
const counting = (
  db: DatabaseShape
): { readonly db: DatabaseShape; readonly count: () => number } => {
  let issued = 0
  const wrapped: DatabaseShape = {
    ...db,
    get: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
      issued += 1
      return (db.get as never as (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<A>)(
        sql,
        params
      )
    }) as DatabaseShape["get"],
    all: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
      issued += 1
      return (db.all as never as (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<A>)(
        sql,
        params
      )
    }) as DatabaseShape["all"]
  }
  return { db: wrapped, count: () => issued }
}

const planOf = (fixture: Fixture) => plan(fixture.db, AT_MILLIS)

describe("sleep plan", () => {
  it("reports an explicit UNKNOWN for a phase whose candidate count is the n-by-n work", async () => {
    const outcome = await withFixture((fixture) => planOf(fixture), { seed: corpusOf(6) })

    const pairs = outcome.unknown.find((entry) => entry.name === "pair_candidates")
    expect(pairs, "the pair-candidate entry is published").toBeDefined()
    expect(pairs?.phases).toEqual(["dedup-merge", "relationship-mining"])
    /**
     * The INPUT, in its own coordinate space: memories, not pairs. Six memories are up to fifteen
     * unordered pairs, so a caller reading this as candidates would understate the work — which is why
     * the field is named `inputCount` and the reason says what it is.
     */
    expect(pairs?.inputCount).toBe(6)
    expect(pairs?.unknownReason).toContain("n-by-n")

    // And NOWHERE is a zero fabricated for it. The unknown entries carry no `count` field at all, so a
    // caller cannot read one as "none found".
    for (const entry of outcome.unknown) {
      expect(entry).not.toHaveProperty("count")
      expect(entry.unknownReason.length).toBeGreaterThan(20)
    }
  })

  it("says `unknown` rather than `no-signal` when only the uncountable phases have input", async () => {
    /**
     * The verdict's whole reason for having three values. This corpus is freshly indexed with no
     * previous run, so `memories_since_last_run` is non-zero and the verdict is `would-change`; the
     * case below drives the same corpus to the state where every COUNTED signal is zero and asserts
     * `unknown` rather than the fabricated `no-signal`.
     */
    const outcome = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* planOf(fixture)
          // A recorded run whose start is AFTER every memory's `updated_at`, which is what zeroes the
          // volume signal without emptying the corpus.
          yield* fixture.db.run(
            `INSERT INTO sleep_runs (run_id, branch, base_sha, status, started_at)
             VALUES ('sleep/2026-08-19', 'sleep/2026-08-19', 'abc', 'merged', '2026-08-19T12:00:00Z')`
          )
          return { before, after: yield* planOf(fixture) }
        }),
      { seed: corpusOf(4) }
    )

    expect(outcome.before.verdict).toBe("would-change")
    expect(outcome.before.lastRun).toBeNull()

    const counted = outcome.after.signals.filter((signal) => signal.count > 0)
    expect(counted, `still counted: ${counted.map((one) => one.name).join(", ")}`).toEqual([])
    expect(outcome.after.verdict).toBe("unknown")
    // The corpus is NOT empty, which is what makes `unknown` the honest answer rather than `no-signal`.
    expect(
      outcome.after.unknown.reduce((total, entry) => total + entry.inputCount, 0)
    ).toBeGreaterThan(0)
    expect(outcome.after.lastRun?.runId).toBe("sleep/2026-08-19")
  })

  it("says `no-signal` only when nothing any phase reads has anything in it", async () => {
    const outcome = await withFixture((fixture) => planOf(fixture))
    // An empty corpus: every counted signal is zero AND every uncountable phase's input is empty, so
    // there is nothing for any phase to reach. This is the one state in which a caller may skip a run.
    expect(outcome.signals.every((signal) => signal.count === 0)).toBe(true)
    expect(outcome.unknown.every((entry) => entry.inputCount === 0)).toBe(true)
    expect(outcome.verdict).toBe("no-signal")
  })

  it("counts settled transcripts through the phase's OWN predicate, unclamped by its batch cap", async () => {
    const outcome = await withFixture((fixture) =>
      Effect.gen(function* () {
        for (let at = 0; at < 12; at += 1) {
          yield* settledTrace(fixture.db, `session-${String(at).padStart(2, "0")}`)
        }
        // A transcript under the byte floor and one still inside the quiet window: both are the
        // phase's own refusals, so neither may be counted.
        yield* fixture.db.run(
          `INSERT INTO traces (session_id, slug, file_path, file_size, file_mtime, started_at,
                                 indexed_at)
             VALUES ('too-small', '-tmp-traces', '/tmp/traces/small.jsonl', ?,
                     '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
          [TRACE_MIN_BYTES - 1]
        )
        yield* fixture.db.run(
          `INSERT INTO traces (session_id, slug, file_path, file_size, file_mtime, started_at,
                                 indexed_at)
             VALUES ('still-live', '-tmp-traces', '/tmp/traces/live.jsonl', ?, ?,
                     '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')`,
          [TRACE_MIN_BYTES + 1, new Date(AT_MILLIS - 60_000).toISOString()]
        )
        return yield* planOf(fixture)
      })
    )

    const sessions = outcome.signals.find((signal) => signal.name === "settled_sessions")
    /**
     * TWELVE, not the ten the phase hands over in one run. The count is the backlog and
     * `sessionsPerRun` is the cap beside it, because a caller deciding whether to run needs to know the
     * work is more than one run's worth. A count clamped to the cap would read as one run of work.
     */
    expect(sessions?.count).toBe(12)
    expect(outcome.sessionsPerRun).toBe(10)
    expect(outcome.verdict).toBe("would-change")
  })

  it("counts a dangling authored edge, which is the integrity phase's own repair set", async () => {
    const outcome = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.db.run(
            `INSERT INTO edges (src_path, rel, dst_path, edge_class, derived, provenance, created_at)
             VALUES ('areas/inbox/plan-subject-000.html', 'relates_to', 'areas/gone/nowhere.html',
                     'memory', 0, 'authored', '2026-08-19T00:00:00Z')`
          )
          // A DERIVED dangling edge is repaired by the next rebuild rather than by a commit, so the
          // phase does not act on it and the plan must not count it.
          yield* fixture.db.run(
            `INSERT INTO edges (src_path, rel, dst_path, edge_class, derived, provenance, created_at)
             VALUES ('areas/inbox/plan-subject-001.html', 'laterally_related',
                     'areas/gone/also-nowhere.html', 'memory', 1, 'sleep', '2026-08-19T00:00:00Z')`
          )
          return yield* planOf(fixture)
        }),
      { seed: corpusOf(2) }
    )

    const dangling = outcome.signals.find((signal) => signal.name === "dangling_authored_edges")
    expect(dangling?.count).toBe(1)
  })

  it("issues a FIXED number of statements, identical over a corpus ten times larger", async () => {
    /**
     * The cost contract, and the reason this read exists rather than `--dry-run`.
     *
     * A statement count that grew with the corpus would be the per-row work arriving through the back
     * door — and it is the shape a plan is most likely to be written with, since "count the candidates"
     * is one loop away from "find the candidates". Measured through a wrapping `DatabaseShape` over the
     * SAME plan function, at two corpus sizes an order of magnitude apart.
     */
    const small = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const rig = counting(fixture.db)
          yield* plan(rig.db, AT_MILLIS)
          return rig.count()
        }),
      { seed: corpusOf(4) }
    )
    const large = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const rig = counting(fixture.db)
          yield* plan(rig.db, AT_MILLIS)
          return rig.count()
        }),
      { seed: corpusOf(40) }
    )

    expect(small).toBe(large)
    // A real bound, not merely "equal": eight aggregates plus the last-run row. A plan that grew a
    // per-phase statement would fail the equality above, and one that grew a fixed handful fails here.
    expect(large).toBeLessThanOrEqual(10)
    expect(large).toBeGreaterThan(4)
  })

  it("self-joins no table, which is the shape the n-by-n phases have and this read must not", async () => {
    /**
     * The other half of the cost contract, at the planner. `neighborPairs` — the scan whose candidate
     * count this read declines to compute — joins `chunks` to `chunks` and `files` to `files`, and the
     * plan of such a statement names the same table twice. Every statement the plan issues is EXPLAINed
     * here, over the strings it really issued rather than pasted copies, and none may do that.
     */
    const plans = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const issued: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []
          const capturing: DatabaseShape = {
            ...fixture.db,
            get: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
              issued.push({ sql, params: params ?? [] })
              return (
                fixture.db.get as never as (
                  s: string,
                  p?: ReadonlyArray<unknown>
                ) => Effect.Effect<A>
              )(sql, params)
            }) as DatabaseShape["get"],
            all: (<A>(sql: string, params?: ReadonlyArray<unknown>) => {
              issued.push({ sql, params: params ?? [] })
              return (
                fixture.db.all as never as (
                  s: string,
                  p?: ReadonlyArray<unknown>
                ) => Effect.Effect<A>
              )(sql, params)
            }) as DatabaseShape["all"]
          }
          yield* plan(capturing, AT_MILLIS)

          const explained: Array<{ sql: string; steps: ReadonlyArray<string> }> = []
          for (const statement of issued) {
            const rows = yield* fixture.db.all<{ detail: string }>(
              `EXPLAIN QUERY PLAN ${statement.sql}`,
              statement.params as never
            )
            explained.push({ sql: statement.sql, steps: rows.map((row) => row.detail) })
          }
          return explained
        }),
      { seed: corpusOf(6) }
    )

    // The statements really ran, so these plans describe reads that did the work.
    expect(plans.length).toBeGreaterThan(4)
    for (const { sql, steps } of plans) {
      const tables = ["files", "chunks", "edges", "traces", "file_entities"]
      for (const table of tables) {
        const touches = steps.filter((step) => new RegExp(`\\b${table}\\b`).test(step)).length
        expect(touches, `${table} appears ${String(touches)}x in: ${sql}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

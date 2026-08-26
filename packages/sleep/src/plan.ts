import type { DatabaseShape } from "@memhtml/index"
import { Effect } from "effect"

import {
  TRACE_MIN_BYTES,
  TRACE_QUIET_MILLIS,
  TRACE_SESSIONS_PER_RUN
} from "./phases/trace-consolidation.js"
import { danglingEdges, latestRun, SLEEP_EXCLUDED_TYPES, settledSessionCount } from "./sql.js"

/**
 * `sleep plan`: would a run change anything, answered from index counts and nothing else.
 *
 * `--dry-run` is a legitimate preview and it is not this. A dry run still EXECUTES all seventeen
 * phases — including the neighbor scan that exhausted 70 GB of RSS on a 2,907-file corpus (issue #40)
 * — and every model-calling phase then checks `env.dryRun` and declines to write. That is an expensive
 * way to learn a run would do nothing. This reads a fixed number of aggregates and runs no phase.
 *
 * **A signal is a phase's own selection predicate, counted — never a second reading of it.** Where the
 * predicate exists as a function in `sql.ts` it is CALLED, and where it exists as a clause the clause is
 * shared (`settledSessionCount` binds the same `WHERE` the phase's batch query binds). A plan that
 * reimplemented a predicate could report a number the phase disagrees with, which is worse than
 * reporting nothing: the caller would skip a run that had work to do.
 *
 * **Two phases cannot have their candidate count computed cheaply, because computing it IS the work.**
 * `dedup-merge` and `relationship-mining` both select PAIRS from an n-by-n neighbor scan over the
 * vector plane, so "how many candidate pairs are there" is answerable only by doing the scan. Those
 * report their INPUT cardinality and an explicit unknown, and they are why {@link SleepPlan.verdict}
 * has three values rather than being a boolean. A predicate that answered "no effect" because it did
 * not look is worse than no predicate at all, and a wrong count has twice read as a finding here.
 */

/** One phase input whose candidate count is exactly known, and the phases that consume it. */
export interface PlanSignal {
  /** Stable identifier a caller branches on, never the prose. */
  readonly name: string
  /** The phases this count is an input to, in execution order. */
  readonly phases: ReadonlyArray<string>
  /** How many candidates the phase's own predicate selects. A quantity, exact. */
  readonly count: number
  /** What the number counts, for a human reading the envelope. */
  readonly detail: string
}

/**
 * One phase whose candidate count is NOT cheaply computable, with the input it would scan.
 *
 * `inputCount` is the SIZE OF THE SET the phase starts from, in a different coordinate space from a
 * signal's `count`: it is memories, where a count is candidates. Reading it as candidates would
 * overstate the work by roughly the square. `unknownReason` says why the candidate count is absent, so
 * an absent number is attributable rather than mysterious.
 */
export interface PlanUnknown {
  readonly name: string
  readonly phases: ReadonlyArray<string>
  readonly inputCount: number
  readonly unknownReason: string
}

/**
 * Whether a run would change anything, as three values rather than a boolean.
 *
 * - `would-change` — at least one exactly-counted signal is non-zero. A run has work.
 * - `unknown` — every counted signal is zero, and at least one phase whose candidates cannot be counted
 *   has a non-empty input. A run MIGHT find something; this read cannot say.
 * - `no-signal` — every counted signal is zero AND every uncountable phase's input is empty, so there
 *   is nothing for any phase to reach. This is the only value that means a run would do nothing.
 *
 * `no-signal` is deliberately hard to reach. Collapsing `unknown` into it is the exact mistake this
 * read exists not to make.
 */
export type PlanVerdict = "would-change" | "unknown" | "no-signal"

export interface SleepPlan {
  readonly verdict: PlanVerdict
  readonly signals: ReadonlyArray<PlanSignal>
  readonly unknown: ReadonlyArray<PlanUnknown>
  /** The last recorded run's id and start, or `null` when this corpus has never run one. */
  readonly lastRun: {
    readonly runId: string
    readonly startedAt: string
    readonly status: string
  } | null
  /**
   * Sessions the consolidation phase would hand over in ONE run, its own per-run cap.
   *
   * Published beside the settled-session count because the two are different facts: a backlog of forty
   * settled sessions at a cap of ten is four runs of work, and a count clamped to the cap would read as
   * one run's worth.
   */
  readonly sessionsPerRun: number
}

/**
 * The exclusion every phase applies, restated as a bind list once.
 *
 * `SLEEP_EXCLUDED_TYPES` is the phases' own list — a task is default-excluded from every phase — so a
 * plan that counted tasks as candidates would report work no phase would do.
 */
const excludedHoles = SLEEP_EXCLUDED_TYPES.map(() => "?").join(", ")

/** Active, non-task memories. The set every corpus-wide phase starts from. */
const CURATABLE = `SELECT count(*) AS n FROM files f
   WHERE f.archived = 0 AND f.memory_type NOT IN (${excludedHoles})`

const count = (
  db: DatabaseShape,
  sql: string,
  params: ReadonlyArray<string | number> = []
): Effect.Effect<number, never> =>
  db.get<{ n: number }>(sql, params).pipe(
    Effect.map((row) => row?.n ?? 0),
    // A plan is a READ a caller runs to decide whether to spend a run, so a storage failure on one
    // aggregate must not deny the whole answer. Zero is the safe direction: it can only make the
    // verdict more cautious, never claim work that is not there.
    Effect.orElseSucceed(() => 0)
  )

/**
 * What a run would find, without running one.
 *
 * Statement count is FIXED — one per signal plus the last-run row — and independent of corpus size,
 * which is the property that distinguishes this from the phases it describes. `tests/plan.test.ts`
 * asserts that count is identical over a corpus ten times larger, because a read whose statement count
 * grew with n would be the n-by-n work arriving through the back door.
 */
export const plan = (db: DatabaseShape, atMillis: number): Effect.Effect<SleepPlan> =>
  Effect.gen(function* () {
    const last = yield* latestRun(db).pipe(Effect.orElseSucceed(() => undefined))
    const settledBefore = new Date(Math.max(0, atMillis - TRACE_QUIET_MILLIS)).toISOString()

    /**
     * Memories written since the last run STARTED, which is the volume trigger to run on.
     *
     * `started_at` and not `ended_at`: a run reads the corpus as of its preflight, so a memory written
     * while a run was in flight is one the run did not see. Against no previous run every active
     * memory counts, which is correct for a first run.
     */
    const sinceLastRun = yield* count(
      db,
      last === undefined ? `${CURATABLE}` : `${CURATABLE} AND f.updated_at >= ?`,
      last === undefined ? [...SLEEP_EXCLUDED_TYPES] : [...SLEEP_EXCLUDED_TYPES, last.started_at]
    )

    const curatable = yield* count(db, CURATABLE, [...SLEEP_EXCLUDED_TYPES])

    /** Chunks with no vector. `preflight`'s embed pass is what closes the gap. */
    const unembeddedChunks = yield* count(
      db,
      `SELECT count(*) AS n FROM chunks c
       WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.chunk_id)`
    )

    const settledSessions = yield* settledSessionCount(db, {
      minBytes: TRACE_MIN_BYTES,
      settledBefore
    }).pipe(Effect.orElseSucceed(() => 0))

    /** The integrity phase's own input, counted from the rows it repairs. */
    const dangling = yield* danglingEdges(db).pipe(Effect.orElseSucceed(() => []))

    /**
     * Machine-proposed merges waiting on a SECOND run to agree, from the state plane.
     *
     * The correctness reason to trigger on volume rather than on a calendar: a promotion needs two runs
     * that read independently, and independence comes from the corpus having changed between them. A
     * non-zero count with nothing else moving means a run would re-read the same rows and promote on one
     * piece of evidence. `hasState` is checked because the state plane is separately attached and a
     * corpus can be read without it.
     */
    const pendingMerges = db.hasState
      ? yield* count(db, "SELECT count(*) AS n FROM state.entity_corroboration WHERE promoted = 0")
      : 0

    /** Active inbox memories: `placement-triage`'s input, and `compress`'s hardest population. */
    const inbox = yield* count(db, `${CURATABLE} AND f.path LIKE 'areas/inbox/%'`, [
      ...SLEEP_EXCLUDED_TYPES
    ])

    const signals: ReadonlyArray<PlanSignal> = [
      {
        name: "memories_since_last_run",
        phases: ["dedup-merge", "entity-resolution", "relationship-mining", "confidence-decay"],
        count: sinceLastRun,
        detail:
          last === undefined
            ? "active non-task memories; this corpus has no recorded run, so every one is new to a run"
            : `active non-task memories whose updated_at is at or after ${last.started_at}`
      },
      {
        name: "unembedded_chunks",
        phases: ["preflight"],
        count: unembeddedChunks,
        detail: "chunks with no vector; preflight's embed pass fills them"
      },
      {
        name: "settled_sessions",
        phases: ["trace-consolidation"],
        count: settledSessions,
        detail: `unconsolidated transcripts at or over ${String(TRACE_MIN_BYTES)} bytes whose mtime predates ${settledBefore}`
      },
      {
        name: "dangling_authored_edges",
        phases: ["integrity"],
        count: dangling.length,
        detail: "authored links pointing at a path the index does not hold"
      },
      {
        name: "pending_entity_merges",
        phases: ["entity-resolution"],
        count: pendingMerges,
        detail: db.hasState
          ? "proposed merges at one detection, awaiting a second run that reads an independently changed corpus"
          : "no state plane is attached, so the corroboration ledger is unreadable from here"
      }
    ]

    const unknown: ReadonlyArray<PlanUnknown> = [
      {
        name: "pair_candidates",
        phases: ["dedup-merge", "relationship-mining"],
        inputCount: curatable,
        unknownReason:
          "candidate PAIRS come from an n-by-n neighbor scan over the vector plane, so counting them is the scan; the input is memories, not pairs"
      },
      {
        name: "community_members",
        phases: ["arc-synthesis", "compress", "placement-triage"],
        inputCount: inbox,
        unknownReason:
          "candidacy requires a graph community, which is label propagation over the whole mined edge set; the input is the active inbox, the population with the fewest edges"
      },
      {
        name: "retention_bands",
        phases: ["retention-triage", "reprieve", "confidence-decay"],
        inputCount: curatable,
        unknownReason:
          "a band is the eight-signal retention score per memory, so counting a band is the scoring pass; the input is every curatable memory"
      }
    ]

    const counted = signals.reduce((total, signal) => total + signal.count, 0)
    const inputs = unknown.reduce((total, entry) => total + entry.inputCount, 0)

    return {
      verdict: counted > 0 ? "would-change" : inputs > 0 ? "unknown" : "no-signal",
      signals,
      unknown,
      lastRun:
        last === undefined
          ? null
          : { runId: last.run_id, startedAt: last.started_at, status: last.status },
      sessionsPerRun: TRACE_SESSIONS_PER_RUN
    } satisfies SleepPlan
  })

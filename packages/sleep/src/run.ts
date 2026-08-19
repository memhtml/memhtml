import { Effect, Result } from "effect"

import type { PhaseCounts, PhaseResult, RunReport, SleepPhase } from "./contract.js"
import {
  dependentsOf,
  HARD_PREREQUISITES,
  phaseIndexOf,
  SLEEP_PHASES,
  TRAILER_PHASE
} from "./contract.js"
import type { PhaseBody, PhaseEnv, SleepDeps } from "./env.js"
import { PHASE_BODIES } from "./phases/index.js"
import { reportPhase } from "./phases/report.js"
import { readPhases, readRun, recordPhase, recordRun } from "./sql.js"
import { makeDetectionBudget } from "./tasks.js"

/**
 * The runner: sixteen phases, each an isolated commit on `sleep/<date>`.
 *
 * **Per-phase isolation drives the design.** The predecessor memory system ran thirteen curation phases
 * inside one Postgres transaction, and four consecutive nights of production curation were lost
 * because one phase raised and the abort rolled back the twelve that had already succeeded. Here every
 * phase is its own commit, a failure is caught with `Effect.result` and recorded as a value, and the
 * phases after it still run, so a night that loses one phase keeps the other fifteen's work.
 *
 * The only exception is a declared hard prerequisite: `dedup-merge` failing SKIPS `compress` and
 * `retention-triage`, because both operate on the post-merge set and running them over a corpus that
 * still holds its duplicates would compress a pair the merge then archives half of.
 *
 * **Nothing is ever rolled back.** `git branch -D` on the sleep branch is the abort, and `main` never
 * moved. So a failed run costs nothing, and a bad run is reviewed and discarded instead of
 * recovered.
 */

/** What `run` takes. `date` is a parameter: a worker passes wall-clock, a test passes a fixed date. */
export interface RunOptions {
  /** `YYYY-MM-DD`. Names the branch and the run, and dates every stamp the run writes. */
  readonly date: string
  /** Run only these phases, in the canonical order. Absent runs all sixteen. */
  readonly phases?: ReadonlyArray<SleepPhase> | undefined
  /** Compute and count; write no commit and no row beyond the run row, which is marked dry. */
  readonly dryRun?: boolean | undefined
}

/** The branch and run id for a date, given which branches already exist. */
export const runIdFor = (date: string, taken: ReadonlyArray<string>): string => {
  const base = `sleep/${date}`
  if (!taken.includes(base)) return base
  for (let ordinal = 2; ordinal <= 100; ordinal += 1) {
    const candidate = `${base}-${ordinal}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}-100`
}

/** A date's run instant as an ISO-8601 UTC second. Midnight: the run's own date, not a clock read. */
export const instantFor = (date: string): { readonly at: string; readonly millis: number } => {
  const millis = Date.parse(`${date}T00:00:00Z`)
  const safe = Number.isFinite(millis) ? millis : 0
  return { at: `${new Date(safe).toISOString().slice(0, 19)}Z`, millis: safe }
}

/**
 * Run a sleep cycle.
 *
 * The branch is created BEFORE any phase runs, and every commit lands on it, so `main` is never
 * touched by a run at all. A dry run creates no branch: it computes on whatever `HEAD` is, which is
 * safe precisely because no phase in dry mode writes a file.
 */
export const run = (deps: SleepDeps, options: RunOptions): Effect.Effect<RunReport, never, never> =>
  Effect.gen(function* () {
    const dryRun = options.dryRun === true
    const requested = options.phases
    const selected =
      requested === undefined
        ? SLEEP_PHASES
        : SLEEP_PHASES.filter((phase) => requested.includes(phase))

    const started = yield* nowIso
    const baseSha = yield* deps.git.revParseHead().pipe(Effect.orElseSucceed(() => null))
    const branches = yield* existingSleepBranches(deps, options.date)
    const runId = runIdFor(options.date, branches)
    const instant = instantFor(options.date)

    const env: PhaseEnv = {
      deps,
      runId,
      branch: runId,
      baseSha: baseSha ?? "",
      date: options.date,
      at: instant.at,
      atMillis: instant.millis,
      dryRun,
      /**
       * ONE budget for the whole run, created here and shared by every phase that mints a detected
       * task. `DETECTED_TASK_CAP` bounds the NIGHT and not each detector, because how many proposals a
       * human can review is a property of the human — so a night where entity resolution finds nine
       * review candidates leaves task detection one, first come.
       *
       * Created per run rather than held in a module, which is what keeps two runs in one process (and
       * two tests in one file) from sharing a counter.
       */
      detectionBudget: makeDetectionBudget()
    }

    if (!dryRun) {
      yield* deps.git.checkoutBranch(runId, { create: true }).pipe(Effect.orElseSucceed(() => {}))
    }
    yield* ignoreFailure(
      recordRun(deps.db, {
        runId,
        branch: runId,
        baseSha: env.baseSha,
        headSha: null,
        status: "running",
        startedAt: started,
        endedAt: null
      })
    )

    const executed = yield* executePhases(env, selected, new Set())
    const headSha = yield* deps.git.revParseHead().pipe(Effect.orElseSucceed(() => baseSha))
    const ended = yield* nowIso
    const anyFailed = executed.some((phase) => phase.status === "failed")

    yield* ignoreFailure(
      recordRun(deps.db, {
        runId,
        branch: runId,
        baseSha: env.baseSha,
        headSha: headSha ?? env.baseSha,
        status: dryRun ? "abandoned" : anyFailed ? "failed" : "review",
        startedAt: started,
        endedAt: ended
      })
    )

    return {
      runId,
      branch: runId,
      baseSha: env.baseSha,
      headSha: headSha ?? env.baseSha,
      dryRun,
      phases: executed,
      llmCalls: executed.reduce((total, phase) => total + phase.llmCalls, 0)
    }
  }).pipe(Effect.withSpan("sleep.run"))

/**
 * Resume a run: read the completed phases out of the branch's own commit trailers and execute the rest.
 *
 * **The trailers are the source of truth, not `sleep_phases`.** A journal table a resume depended on
 * would be a second record of what already happened, and the two disagree exactly when it matters,
 * on a process killed after `git commit` and before the row's write. The commit is the fact; the row
 * is a convenience the history can regenerate.
 */
export const resume = (
  deps: SleepDeps,
  runId: string,
  options: { readonly date?: string | undefined } = {}
): Effect.Effect<RunReport, never, never> =>
  Effect.gen(function* () {
    const row = yield* ignoreFailureWith(readRun(deps.db, runId), undefined)
    const baseSha = row?.base_sha ?? ""
    const date = options.date ?? dateFromRunId(runId)
    const instant = instantFor(date)

    yield* deps.git.checkoutBranch(runId).pipe(Effect.orElseSucceed(() => {}))
    const completed = yield* completedPhases(deps, baseSha)

    const env: PhaseEnv = {
      deps,
      runId,
      branch: runId,
      baseSha,
      date,
      at: instant.at,
      atMillis: instant.millis,
      dryRun: false,
      /**
       * A resume gets a FRESH budget, deliberately. The alternative would be reconstructing how much
       * the interrupted attempt spent by counting detected tasks in the tree, and the count would be
       * wrong in the direction that matters: a phase that minted three and was then killed would have
       * its own three counted against it on the retry, so a resume would mint fewer than the run it is
       * finishing. The cost of a fresh one is bounded by the cap, and the mints a resume repeats are
       * refreshes rather than duplicates, which cost no budget at all.
       */
      detectionBudget: makeDetectionBudget()
    }

    const remaining = SLEEP_PHASES.filter((phase) => !completed.has(phase))
    const executed = yield* executePhases(env, remaining, new Set())
    const headSha = yield* deps.git.revParseHead().pipe(Effect.orElseSucceed(() => baseSha))
    const ended = yield* nowIso

    /**
     * Skipped-because-already-done rows are reported explicitly, so a resume's report accounts for all
     * sixteen phases. A report that showed only the eight it ran would read as a partial run.
     */
    const priorRows = yield* ignoreFailureWith(readPhases(deps.db, runId), [])
    const already: ReadonlyArray<PhaseResult> = [...completed].map((phase) => {
      const prior = priorRows.find((candidate) => candidate.phase === phase)
      return {
        phase,
        status: "skipped" as const,
        counts: parseCounts(prior?.counts),
        commitSha: prior?.commit_sha ?? null,
        llmCalls: prior?.llm_calls ?? 0,
        detail: "already completed on this branch"
      }
    })

    const all = SLEEP_PHASES.flatMap((phase) => {
      const found =
        executed.find((candidate) => candidate.phase === phase) ??
        already.find((candidate) => candidate.phase === phase)
      return found === undefined ? [] : [found]
    })

    yield* ignoreFailure(
      recordRun(deps.db, {
        runId,
        branch: runId,
        baseSha,
        headSha: headSha ?? baseSha,
        status: all.some((phase) => phase.status === "failed") ? "failed" : "review",
        startedAt: row?.started_at ?? ended,
        endedAt: ended
      })
    )

    return {
      runId,
      branch: runId,
      baseSha,
      headSha: headSha ?? baseSha,
      dryRun: false,
      phases: all,
      llmCalls: all.reduce((total, phase) => total + phase.llmCalls, 0)
    }
  }).pipe(Effect.withSpan("sleep.resume"))

/**
 * Execute phases in order, isolating each failure.
 *
 * `Effect.result`, because `Effect.either` does not exist in effect 4.0.0-beta.102. What the loop needs
 * from either name is the same: a phase failure becomes a VALUE the loop reads,
 * so the loop keeps going. Anything that let a failure travel through the error channel would abort
 * the run and lose every prior phase's report row.
 */
const executePhases = (
  env: PhaseEnv,
  phases: ReadonlyArray<SleepPhase>,
  alreadyFailed: Set<SleepPhase>
): Effect.Effect<ReadonlyArray<PhaseResult>, never, never> =>
  Effect.gen(function* () {
    const results: Array<PhaseResult> = []
    const failed = alreadyFailed
    const blocked = new Set<SleepPhase>()

    for (const phase of phases) {
      if (blocked.has(phase)) {
        const blocker = HARD_PREREQUISITES.find(([, after]) => after === phase)?.[0]
        results.push({
          phase,
          status: "skipped",
          counts: {},
          commitSha: null,
          llmCalls: 0,
          detail: `hard prerequisite ${blocker ?? "unknown"} failed`
        })
        yield* recordOne(env, phase, results[results.length - 1] as PhaseResult)
        continue
      }

      const startedAt = yield* nowIso
      const body: PhaseBody = phase === "report" ? reportPhase(results) : PHASE_BODIES[phase]
      const outcome = yield* Effect.result(body(env))
      const endedAt = yield* nowIso

      const result: PhaseResult = Result.isSuccess(outcome)
        ? {
            phase,
            status: "ok",
            counts: outcome.success.counts,
            commitSha: outcome.success.commitSha,
            llmCalls: outcome.success.llmCalls,
            ...(outcome.success.detail === undefined ? {} : { detail: outcome.success.detail })
          }
        : {
            phase,
            status: "failed",
            counts: {},
            commitSha: null,
            llmCalls: 0,
            detail: describeFailure(outcome.failure)
          }

      if (result.status === "failed") {
        failed.add(phase)
        for (const dependent of dependentsOf(phase)) blocked.add(dependent)
        yield* Effect.logError(`sleep.${phase} failed: ${result.detail ?? "no detail"}`)
        /**
         * A failed phase may have staged files before it failed. Unstaging them keeps the
         * failure isolated in the TREE as well as in the report. Leaving a partial stage would make
         * the NEXT phase's commit carry the failed phase's half-finished work, which is exactly the
         * cross-contamination per-phase commits exist to prevent.
         */
        if (!env.dryRun) yield* unstageAll(env)
      }

      results.push(result)
      yield* recordOne(env, phase, result, startedAt, endedAt)
    }

    return results
  })

/** Discard the index back to `HEAD`, leaving the working tree alone for an operator to inspect. */
const unstageAll = (env: PhaseEnv): Effect.Effect<void, never, never> =>
  env.deps.git.run(["reset", "--quiet", "HEAD", "--"]).pipe(
    Effect.asVoid,
    Effect.orElseSucceed(() => {})
  )

/** Write the phase's reporting row. A reporting failure never fails the run. */
const recordOne = (
  env: PhaseEnv,
  phase: SleepPhase,
  result: PhaseResult,
  startedAt?: string,
  endedAt?: string
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    if (env.dryRun) return
    const at = yield* nowIso
    yield* ignoreFailure(
      recordPhase(env.deps.db, {
        runId: env.runId,
        phase,
        ordinal: phaseIndexOf(phase),
        status: result.status,
        commitSha: result.commitSha,
        counts: JSON.stringify(result.counts),
        error: result.detail ?? null,
        llmCalls: result.llmCalls,
        startedAt: startedAt ?? at,
        endedAt: endedAt ?? at
      })
    )
  })

/** The phases whose `Memhtml-Phase` trailer already appears on the branch. */
export const completedPhases = (
  deps: SleepDeps,
  baseSha: string
): Effect.Effect<ReadonlySet<SleepPhase>, never, never> =>
  Effect.gen(function* () {
    const range = baseSha === "" ? "HEAD" : `${baseSha}..HEAD`
    const records = yield* deps.git
      .logTrailers(range, TRAILER_PHASE)
      .pipe(Effect.orElseSucceed(() => []))
    const found = new Set<SleepPhase>()
    for (const record of records) {
      for (const value of record.values) {
        if ((SLEEP_PHASES as ReadonlyArray<string>).includes(value)) found.add(value as SleepPhase)
      }
    }
    return found
  })

/** Sleep branches that already exist for a date, so a rerun takes a suffix instead of colliding. */
const existingSleepBranches = (
  deps: SleepDeps,
  date: string
): Effect.Effect<ReadonlyArray<string>, never, never> =>
  Effect.gen(function* () {
    const candidates = [
      `sleep/${date}`,
      ...Array.from({ length: 99 }, (_, at) => `sleep/${date}-${at + 2}`)
    ]
    const taken: Array<string> = []
    for (const candidate of candidates) {
      const exists = yield* deps.git.branchExists(candidate).pipe(Effect.orElseSucceed(() => false))
      if (exists) taken.push(candidate)
      else break
    }
    return taken
  })

/** The date a run id names. `sleep/2026-08-02-2` yields `2026-08-02`. */
export const dateFromRunId = (runId: string): string => {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(runId)
  return match?.[1] ?? "1970-01-01"
}

/**
 * A stored counts string as counts. A malformed value reads as empty instead of failing a report.
 *
 * An ARRAY is rejected as well as a non-object. `Object.entries` over an array yields its indices as
 * keys, so `[1,2]` would otherwise read as `{"0":1,"1":2}`, giving a report line with counts called
 * `0` and `1`. That is worse than an empty one because it looks like data.
 */
export const parseCounts = (raw: string | undefined): PhaseCounts => {
  if (raw === undefined || raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** A failure as an operator-readable line. It carries no stack, no SQL, and no memory contents. */
export const describeFailure = (failure: unknown): string => {
  if (typeof failure === "object" && failure !== null) {
    const tagged = failure as {
      _tag?: unknown
      reason?: unknown
      operation?: unknown
      command?: unknown
      path?: unknown
      stored?: unknown
      configured?: unknown
    }
    const tag = typeof tagged._tag === "string" ? tagged._tag : failure.constructor.name
    const detail =
      typeof tagged.reason === "string"
        ? tagged.reason
        : typeof tagged.operation === "string"
          ? tagged.operation
          : typeof tagged.command === "string"
            ? tagged.command
            : typeof tagged.path === "string"
              ? tagged.path
              : typeof tagged.stored === "string" && typeof tagged.configured === "string"
                ? `stored ${tagged.stored}, configured ${tagged.configured}`
                : ""
    return detail === "" ? tag : `${tag}: ${detail}`
  }
  return String(failure)
}

/** Wall clock as an ISO second, through the injected clock so a test can pin it. */
const nowIso = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => `${new Date(millis).toISOString().slice(0, 19)}Z`)
)

/** A failed reporting write leaves the run intact: the run's facts are its commits, not its rows. */
const ignoreFailure = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void, never, never> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning(`sleep.report write skipped: ${String(cause)}`))
  ) as Effect.Effect<void, never, never>

const ignoreFailureWith = <A, E>(
  effect: Effect.Effect<A, E>,
  fallback: A
): Effect.Effect<A, never, never> =>
  effect.pipe(Effect.orElseSucceed(() => fallback)) as Effect.Effect<A, never, never>

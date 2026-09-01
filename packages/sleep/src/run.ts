import { Effect, Result, Schema } from "effect"

import type { PhaseCounts, PhaseResult, RunReport, SleepPhase } from "./contract.js"
import { dependentsOf, phaseIndexOf, SLEEP_PHASES, TRAILER_PHASE } from "./contract.js"
import { makeLlmBudget, type PhaseBody, type PhaseEnv, type SleepDeps } from "./env.js"
import { PHASE_BODIES } from "./phases/index.js"
import { reportPhase } from "./phases/report.js"
import { readPhases, readRun, recordPhase, recordRun } from "./sql.js"
import { makeDetectionBudget } from "./tasks.js"

/**
 * The runner: seventeen phases, each an isolated commit on `sleep/<date>`.
 *
 * **Per-phase isolation drives the design.** The predecessor memory system ran thirteen curation phases
 * inside one Postgres transaction, and four consecutive nights of production curation were lost
 * because one phase raised and the abort rolled back the twelve that had already succeeded. Here every
 * phase is its own commit, a failure is caught with `Effect.result` and recorded as a value, and the
 * phases after it still run, so a night that loses one phase keeps the other sixteen's work.
 *
 * The exceptions are the declared hard prerequisites. `preflight` failing SKIPS all sixteen phases
 * after it, so a run that cannot prove a clean tree, one vector space, and a diffable index commits
 * nothing at all — the failure modes it catches make a later commit wrong rather than incomplete.
 * `dedup-merge` failing SKIPS `compress` and `retention-triage`, because both operate on the
 * post-merge set and running them over a corpus that still holds its duplicates would compress a pair
 * the merge then archives half of.
 *
 * **Nothing is ever rolled back.** `git branch -D` on the sleep branch is the abort, and `main` never
 * moved. So a failed run costs nothing, and a bad run is reviewed and discarded instead of
 * recovered.
 */

/** What `run` takes. `date` is a parameter: a worker passes wall-clock, a test passes a fixed date. */
export interface RunOptions {
  /** `YYYY-MM-DD`. Names the branch and the run, and dates every stamp the run writes. */
  readonly date: string
  /** Run only these phases, in the canonical order. Absent runs all of them. */
  readonly phases?: ReadonlyArray<SleepPhase> | undefined
  /** Compute and count; write no commit and no row beyond the run row, which is marked dry. */
  readonly dryRun?: boolean | undefined
  /**
   * The deep-sleep cycle (issue #63): mine a lower grouping band, group by shared entity, triage
   * inbox singletons into topic directories, and iterate compress until a pass folds nothing.
   * Same branch, same review, same merge gate as a default run — deep changes what the phases
   * REACH, never what happens to what they produce.
   */
  readonly deep?: boolean | undefined
  /**
   * A run-wide cap on model calls the DEEP mechanisms may spend. Read only when `deep` is set.
   * When it runs out, remaining deep batches are skipped with reason `budget` and counted per
   * phase — the run stays green, exactly as a model outage does.
   */
  readonly maxLlmCalls?: number | undefined
  /**
   * Sessions handed to trace-consolidation this run. Absent takes the default (ten); see the field
   * on `PhaseEnv` for why this is a parameter of the run rather than a constant of the phase.
   */
  readonly traceSessions?: number | undefined
}

/** How many runs one date can name: `sleep/<date>` plus the ninety-nine suffixed reruns. */
export const MAX_SAME_DAY_RUNS = 100

/**
 * The branch and run id for a date, given which branches already exist, or `undefined` when every
 * name the date can take is a branch already.
 *
 * A run id is a branch name AND the primary key of a `sleep_runs` row, so handing back a taken name
 * is two collisions at once: the phases would commit onto the branch of the run that holds the name,
 * and `recordRun`'s upsert would overwrite that run's status and head sha. Exhaustion is therefore a
 * refusal to start rather than a reused name.
 */
export const runIdFor = (date: string, taken: ReadonlyArray<string>): string | undefined => {
  const base = `sleep/${date}`
  if (!taken.includes(base)) return base
  for (let ordinal = 2; ordinal <= MAX_SAME_DAY_RUNS; ordinal += 1) {
    const candidate = `${base}-${ordinal}`
    if (!taken.includes(candidate)) return candidate
  }
  return undefined
}

/**
 * Why a run refused to start.
 *
 * The run branch is the only place a phase may commit, and `HEAD` is what decides where a commit
 * lands. So a run that cannot prove `HEAD` is on its own branch — the checkout failed, the branch
 * name is taken, the resume names a run nothing recorded — writes NOTHING: no commit, no
 * `sleep_runs` row, no phase row. That is what makes `git branch -D` the whole abort and a failed
 * run cost nothing. The alternative is seventeen phases committed onto whatever branch happened to
 * be checked out, which after a merge is `main`.
 */
export class SleepRunAborted extends Schema.TaggedError<SleepRunAborted>()("SleepRunAborted", {
  reason: Schema.String
}) {}

/** A date's run instant as an ISO-8601 UTC second. Midnight: the run's own date, not a clock read. */
export const instantFor = (date: string): { readonly at: string; readonly millis: number } => {
  const millis = Date.parse(`${date}T00:00:00Z`)
  const safe = Number.isFinite(millis) ? millis : 0
  return { at: `${new Date(safe).toISOString().slice(0, 19)}Z`, millis: safe }
}

/**
 * Run a sleep cycle.
 *
 * The branch is created and READ BACK before any phase runs, and every commit lands on it, so `main`
 * is never touched by a run at all. A dry run creates no branch: it computes on whatever `HEAD` is,
 * which is safe precisely because no phase in dry mode writes a file.
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
    if (runId === undefined) {
      return yield* abortedRun({
        runId: `sleep/${options.date}`,
        baseSha: baseSha ?? "",
        dryRun,
        phases: selected,
        reason: `every run id for ${options.date} is taken, through -${MAX_SAME_DAY_RUNS}`
      })
    }
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
      detectionBudget: makeDetectionBudget(),
      /**
       * The deep switches, shaped once here so every phase reads one field. The LLM budget is the
       * same created-per-run discipline as the detection budget above, and it exists only when the
       * caller stated a cap: an uncapped deep run is a valid ask, and a phantom cap of zero (or of
       * some default nobody chose) would silently skip work the operator paid for the flag to reach.
       */
      ...(options.deep === true
        ? {
            deep: {
              ...(options.maxLlmCalls === undefined
                ? {}
                : { budget: makeLlmBudget(options.maxLlmCalls) })
            }
          }
        : {}),
      ...(options.traceSessions === undefined ? {} : { traceSessions: options.traceSessions })
    }

    if (!dryRun) {
      const entered = yield* Effect.result(enterRunBranch(deps, runId, { create: true }))
      if (Result.isFailure(entered)) {
        return yield* abortedRun({
          runId,
          baseSha: env.baseSha,
          dryRun,
          phases: selected,
          reason: entered.failure.reason
        })
      }
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
 *
 * **The run row is still REQUIRED, because it carries the watermark the trailer read is scoped to.**
 * `base_sha` bounds the range to the branch's own commits; without it the scan is all of `HEAD`, where
 * a previously merged run's trailers name every phase — so the resume would report seventeen phases
 * complete, execute nothing, and say `review`. A run nothing recorded is therefore an abort, not an
 * empty watermark.
 */
export const resume = (
  deps: SleepDeps,
  runId: string,
  options: {
    readonly date?: string | undefined
    /**
     * Resume the remaining phases as a DEEP run. NOT inferred from the interrupted run — the run row
     * does not record the flag, and the commits a default phase leaves are indistinguishable from a
     * deep phase's — so the caller restates it, exactly as the caller restates nothing else because
     * everything else is on the branch. A deep run resumed without the flag finishes as a DEFAULT
     * one: already-completed deep phases keep their commits, and the remaining phases do default
     * work, which is safe because every deep mechanism is additive.
     */
    readonly deep?: boolean | undefined
    readonly maxLlmCalls?: number | undefined
  } = {}
): Effect.Effect<RunReport, never, never> =>
  Effect.gen(function* () {
    const date = options.date ?? dateFromRunId(runId)
    const instant = instantFor(date)

    const rowRead = yield* Effect.result(readRun(deps.db, runId))
    const row = Result.isSuccess(rowRead) ? rowRead.success : undefined
    if (row === undefined) {
      return yield* abortedRun({
        runId,
        baseSha: "",
        dryRun: false,
        phases: SLEEP_PHASES,
        reason: Result.isFailure(rowRead)
          ? `run row unreadable for ${runId}: ${describeFailure(rowRead.failure)}`
          : `no such run: ${runId}`
      })
    }
    const baseSha = row.base_sha

    const entered = yield* Effect.result(enterRunBranch(deps, runId, { create: false }))
    if (Result.isFailure(entered)) {
      return yield* abortedRun({
        runId,
        baseSha,
        dryRun: false,
        phases: SLEEP_PHASES,
        reason: entered.failure.reason
      })
    }
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
      detectionBudget: makeDetectionBudget(),
      /** A fresh LLM budget too, for the same reason the detection budget above is fresh. */
      ...(options.deep === true
        ? {
            deep: {
              ...(options.maxLlmCalls === undefined
                ? {}
                : { budget: makeLlmBudget(options.maxLlmCalls) })
            }
          }
        : {})
    }

    const remaining = SLEEP_PHASES.filter((phase) => !completed.has(phase))
    const executed = yield* executePhases(env, remaining, new Set())
    const headSha = yield* deps.git.revParseHead().pipe(Effect.orElseSucceed(() => baseSha))
    const ended = yield* nowIso

    /**
     * Skipped-because-already-done rows are reported explicitly, so a resume's report accounts for all
     * seventeen phases. A report that showed only the eight it ran would read as a partial run.
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
        startedAt: row.started_at,
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
 * Put `HEAD` on the run branch and PROVE it landed there, or fail with {@link SleepRunAborted}.
 *
 * The read-back is a separate fact from the checkout's exit status, and both are required. `git
 * checkout` failing is the loud case — a name that collides with an existing ref, a lock it cannot
 * take — and a `HEAD` that names some other branch afterwards is the quiet one. Either way the
 * phases would commit somewhere nobody will review, so neither is recoverable inside a run.
 */
const enterRunBranch = (
  deps: SleepDeps,
  branch: string,
  options: { readonly create: boolean }
): Effect.Effect<void, SleepRunAborted, never> =>
  Effect.gen(function* () {
    const checkout = yield* Effect.result(
      deps.git.checkoutBranch(branch, options.create ? { create: true } : {})
    )
    if (Result.isFailure(checkout)) {
      return yield* Effect.fail(
        SleepRunAborted.make({
          reason: `cannot check out ${branch}: ${describeFailure(checkout.failure)}`
        })
      )
    }
    const current = yield* currentBranch(deps)
    if (current !== branch) {
      return yield* Effect.fail(
        SleepRunAborted.make({
          reason: `HEAD is on ${current ?? "no branch"} after checking out ${branch}`
        })
      )
    }
  })

/**
 * The branch `HEAD` names, or `null` on a detached `HEAD` or an unreadable one.
 *
 * Through `git.run` because the port exposes no current-branch read, and this is the one fact that
 * decides where a phase's commit lands. `rev-parse --abbrev-ref HEAD` answers the literal `HEAD` when
 * nothing is checked out, which is a name no branch can have, so it reads as `null` rather than as a
 * branch called `HEAD`.
 */
const currentBranch = (deps: SleepDeps): Effect.Effect<string | null, never, never> =>
  deps.git.run(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
    Effect.map((output) => {
      const name = output.trim()
      return name === "" || name === "HEAD" ? null : name
    }),
    Effect.orElseSucceed(() => null)
  )

/**
 * The report of a run that never started: every selected phase `failed`, one shared reason, no commit.
 *
 * `failed` rather than `skipped` because that is what every consumer branches on — the run row's
 * status, `sleepRunReport`'s `failedPhases`, an operator reading a report line. A run that wrote
 * nothing while reporting no failure is precisely the outcome the abort exists to prevent, so it
 * cannot be how the abort is reported.
 *
 * Nothing is written here. A `sleep_runs` row keyed on a run id the caller does not own would
 * overwrite that run's status through `recordRun`'s upsert, and a row for a run id nothing recorded
 * would hand the NEXT resume the empty watermark this abort refused.
 */
const abortedRun = (input: {
  readonly runId: string
  readonly baseSha: string
  readonly dryRun: boolean
  readonly phases: ReadonlyArray<SleepPhase>
  readonly reason: string
}): Effect.Effect<RunReport, never, never> =>
  Effect.gen(function* () {
    const detail = describeFailure(SleepRunAborted.make({ reason: input.reason }))
    yield* Effect.logError(`sleep aborted ${input.runId}: ${input.reason}`)
    return {
      runId: input.runId,
      branch: input.runId,
      baseSha: input.baseSha,
      headSha: input.baseSha,
      dryRun: input.dryRun,
      phases: input.phases.map((phase) => ({
        phase,
        status: "failed" as const,
        counts: {},
        commitSha: null,
        llmCalls: 0,
        detail
      })),
      llmCalls: 0
    }
  })

/**
 * Execute phases in order, isolating each failure.
 *
 * `Effect.result`, because `Effect.either` does not exist in effect 4.0.0-rc.109. What the loop needs
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
    /**
     * Each blocked phase against the prerequisite whose failure blocked it, so the skip line names a
     * phase that really failed. `compress` declares two prerequisites, and reading a blocker back out
     * of `HARD_PREREQUISITES` would answer whichever pair is listed first — naming `preflight` on a
     * night where preflight succeeded and `dedup-merge` failed.
     *
     * The FIRST failure to reach a phase keeps the entry, which is the earliest prerequisite in
     * execution order: a failed preflight is what stopped `compress`, whatever `dedup-merge` did with
     * the corpus afterwards.
     */
    const blockedBy = new Map<SleepPhase, SleepPhase>()

    for (const phase of phases) {
      const blocker = blockedBy.get(phase)
      if (blocker !== undefined) {
        const skipped: PhaseResult = {
          phase,
          status: "skipped",
          counts: {},
          commitSha: null,
          llmCalls: 0,
          detail: `hard prerequisite ${blocker} failed`
        }
        results.push(skipped)
        yield* recordOne(env, phase, skipped)
        continue
      }

      /**
       * What was already dirty before this phase touched anything, so a failure restores only what
       * THIS phase wrote. Read per phase rather than once per run because each phase commits its own
       * work, and `undefined` (the read itself failed) means the scope cannot be established — in
       * which case nothing is restored, since destroying a path that may be an operator's is worse
       * than leaving one of this phase's behind.
       */
      const dirtyBefore = env.dryRun ? undefined : yield* dirtyPathSet(env)
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
        for (const dependent of dependentsOf(phase)) {
          if (!blockedBy.has(dependent)) blockedBy.set(dependent, phase)
        }
        yield* Effect.logError(`sleep.${phase} failed: ${result.detail ?? "no detail"}`)
        if (!env.dryRun) yield* discardPhaseWrites(env, phase, dirtyBefore)
      }

      results.push(result)
      yield* recordOne(env, phase, result, startedAt, endedAt)
    }

    return results
  })

/**
 * Every non-ignored dirty path, both sides of a rename, or `undefined` when git could not say.
 *
 * Ignored paths are excluded because `.memhtml/index.db` is dirty for a whole run by design, so
 * counting it would put the database in every phase's touched set. A rename contributes BOTH paths:
 * the source is gone from the working tree and the destination is new, and restoring one without the
 * other leaves the move half-undone.
 */
const dirtyPathSet = (
  env: PhaseEnv
): Effect.Effect<ReadonlySet<string> | undefined, never, never> =>
  env.deps.git.statusPorcelainV2().pipe(
    Effect.map((entries) => {
      const paths = new Set<string>()
      for (const entry of entries) {
        if (entry.kind === "ignored") continue
        paths.add(entry.path)
        if (entry.fromPath !== null) paths.add(entry.fromPath)
      }
      return paths
    }),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * Undo a failed phase's partial work: discard the index, then put every path the phase made dirty
 * back the way `HEAD` holds it.
 *
 * **Unstaging alone is not isolation.** `git reset HEAD` moves the index and leaves the bytes on disk,
 * and the file operations read the WORKING TREE: `stampFile` reads a file, edits its head, and stages
 * the whole result, so a later phase touching a path the failed phase half-wrote commits those bytes
 * under its own trailer — a `memhtml-supersedes` toward a file that was never archived, landing in the
 * confidence-decay commit. A `git mv` that succeeded before a later one failed is the same hazard in
 * the other direction: the file is physically gone from its live path until something puts it back.
 *
 * **The scope is the paths this phase made dirty and nothing else.** A path already dirty when the
 * phase started belongs to whoever made it so — an operator's own edit, which preflight's clean-tree
 * check refuses to run over in the first place — and this is a destructive restore, so it never
 * reaches outside the set it can attribute. `HEAD` decides the two treatments: a path `HEAD` holds is
 * checked out from it, and a path it does not exists only because this phase created it, so it goes.
 */
const discardPhaseWrites = (
  env: PhaseEnv,
  phase: SleepPhase,
  dirtyBefore: ReadonlySet<string> | undefined
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    // First, so the paths this phase staged are untracked again and therefore cleanable below.
    yield* runGit(env, ["reset", "--quiet", "HEAD", "--"], `${phase} unstage`)
    if (dirtyBefore === undefined) {
      yield* Effect.logWarning(
        `sleep.${phase} partial writes left in the tree: the pre-phase state could not be read`
      )
      return
    }
    const dirtyAfter = yield* dirtyPathSet(env)
    if (dirtyAfter === undefined) {
      yield* Effect.logWarning(
        `sleep.${phase} partial writes left in the tree: the post-failure state could not be read`
      )
      return
    }
    const touched = [...dirtyAfter].filter((path) => !dirtyBefore.has(path)).sort()
    if (touched.length === 0) return

    const inHead = yield* env.deps.git.lsTreeR("HEAD", touched).pipe(
      Effect.map((entries) => new Set(entries.map((entry) => entry.path))),
      Effect.orElseSucceed(() => new Set<string>())
    )
    const tracked = touched.filter((path) => inHead.has(path))
    const created = touched.filter((path) => !inHead.has(path))
    if (tracked.length > 0) {
      yield* runGit(env, ["checkout", "--quiet", "HEAD", "--", ...tracked], `${phase} restore`)
    }
    if (created.length > 0) {
      yield* runGit(env, ["clean", "-f", "-d", "-q", "--", ...created], `${phase} clean`)
    }
  })

/** One git call whose failure is a warning: a run's facts are its commits, not its housekeeping. */
const runGit = (
  env: PhaseEnv,
  args: ReadonlyArray<string>,
  what: string
): Effect.Effect<void, never, never> =>
  env.deps.git.run(args).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning(`sleep.${what} skipped: ${String(cause)}`))
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

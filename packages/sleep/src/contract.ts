/**
 * The phase vocabulary, the trailer keys, and the dependency graph between phases.
 *
 * These constants are the contract the runner, the resume read, and the report all key on, so
 * they live apart from every phase body: a phase name appears in a commit trailer, in a
 * `sleep_phases` row, and in a `--phases` flag, and three copies of the string would drift.
 */

/**
 * The seventeen phases, in execution order.
 *
 * The order encodes the predecessor memory system's dependencies (design §6): entity resolution precedes person
 * links so aliases have already merged, confidence decay precedes retention triage so triage
 * scores the decayed value, and dedup-merge precedes compress and retention because both operate
 * on the post-merge set.
 *
 * `task-detection` sits after `trace-consolidation` and before `integrity`, and both edges are
 * deliberate. It scans the ACTIVE corpus for unresolved
 * commitments, so it has to run after every phase that changes what is active — after dedup's folds,
 * after retention's evictions, after compress's canonicals, and after trace consolidation's newly
 * distilled memories, which are the freshest text of the night and the likeliest to carry one. And it
 * WRITES files, so it must precede `integrity`, which repairs dangling hrefs and regenerates the
 * directory artifacts: a task minted afterwards would be absent from its directory's `index.html`
 * until the next night.
 *
 * `placement-triage` is deep-only (issue #63): on a run without `--deep` it returns immediately,
 * writes nothing, and commits nothing, so the nightly cycle's behavior is unchanged by its presence
 * in this list. Its slot has the same two edges task-detection's does, plus one more on each side:
 * it must run after `compress` (it re-files only what even deep grouping could not fold, so folding
 * has to have had its chance first) and after `task-detection` (a move mid-scan would hand the
 * detector paths that no longer hold files), and it must precede `integrity` because it MOVES files —
 * integrity regenerates each directory's `index.html`, and it rewrites inbound hrefs itself because
 * integrity's dangling-href repair only knows how to chase a target into the ARCHIVE, not into a
 * topic directory.
 */
export const SLEEP_PHASES = [
  "preflight",
  "dedup-merge",
  "entity-resolution",
  "person-links",
  "relationship-mining",
  "edge-typing",
  "confidence-decay",
  "arc-synthesis",
  "retention-triage",
  "compress",
  "reprieve",
  "trace-consolidation",
  "task-detection",
  "placement-triage",
  "integrity",
  "state-export",
  "report"
] as const

export type SleepPhase = (typeof SLEEP_PHASES)[number]

/** True when a string names a phase. Narrows a `--phases` value or a trailer read. */
export const isSleepPhase = (value: string): value is SleepPhase =>
  (SLEEP_PHASES as ReadonlyArray<string>).includes(value)

/** The 1-based ordinal of a phase within the sequence. A display label, never arithmetic input. */
export const phaseIndexOf = (phase: SleepPhase): number => SLEEP_PHASES.indexOf(phase) + 1

/**
 * Phases whose failure blocks a later phase.
 *
 * Everything else is SOFT: a phase that fails is recorded `failed` and the phases after it still
 * run, keeping every prior commit on the branch. That posture comes from one specific failure.
 * The predecessor ran thirteen phases inside one transaction and four consecutive nights of
 * production curation were lost to a single phase raising, because the abort rolled back the
 * twelve that had already succeeded.
 *
 * `dedup-merge` is the one hard prerequisite, for `compress` and `retention-triage`: both operate
 * on the post-merge set, and running them over a corpus that still holds the duplicates would
 * compress a near-duplicate pair into a canonical while a merge later archives one of its members.
 *
 * That is why `dedup-merge` isolates each of its model calls instead of failing on one. It batches
 * components and a batch whose call comes back malformed is counted and skipped, so a single bad tool
 * payload cannot take two later phases down with it.
 */
export const HARD_PREREQUISITES: ReadonlyArray<readonly [SleepPhase, SleepPhase]> = [
  ["dedup-merge", "compress"],
  ["dedup-merge", "retention-triage"]
]

/** The phases blocked by `phase` failing. */
export const dependentsOf = (phase: SleepPhase): ReadonlyArray<SleepPhase> =>
  HARD_PREREQUISITES.flatMap(([before, after]) => (before === phase ? [after] : []))

/** Commit trailers `memhtml sleep resume` reads back out of `git log` to skip done work. */
export const TRAILER_RUN = "Memhtml-Run"
export const TRAILER_PHASE = "Memhtml-Phase"
export const TRAILER_COUNTS = "Memhtml-Counts"

/**
 * The phases that call a model, in execution order. Every other phase is deterministic and costs no
 * model call.
 *
 * **Descriptive, not a gate.** Nothing branches on this list: each phase reads `env.deps.model` itself
 * and degrades on its own when it is absent. What the list feeds is the generated documentation's
 * `callsModel` column (`apps/docs/src/loaders/registry.ts`), so an operator reading the phase table
 * learns which phases a credential-free run gets nothing from. A phase omitted here would still make
 * its calls and would be documented as deterministic.
 *
 * Membership means "spends model calls when a model is bound", not "needs a model to be useful".
 * `dedup-merge` and `entity-resolution` both do real deterministic work without one: dedup falls back
 * to the 0.92 cosine floor plus the divergence veto and still commits, and entity-resolution's
 * normalization and character-overlap passes run either way. The other four report a reason and
 * write nothing.
 *
 * `task-detection` was the first member that is net-new model spend rather than a
 * question a phase was already asking. Issue #44 sizes it that way on purpose: surfaces 1 and 2 cover
 * the highest-signal sources at no marginal cost, and this one is the batched scan over the active
 * corpus, capped like every other phase and degrading to `no model bound` with nothing written.
 *
 * `placement-triage` spends model calls only under `--deep` (issue #63). On a nightly run it returns
 * immediately with a reason, so its membership here reads "spends calls when deep AND a model is
 * bound" — the same two-condition degradation `trace-consolidation` has for its consolidator.
 */
export const LLM_PHASES: ReadonlyArray<SleepPhase> = [
  "dedup-merge",
  "entity-resolution",
  "edge-typing",
  "arc-synthesis",
  "compress",
  "trace-consolidation",
  "task-detection",
  "placement-triage"
]

/**
 * Phases that never commit.
 *
 * `preflight` refreshes the index and asserts a clean tree; it produces no mutation to review.
 * `relationship-mining` writes derived edges to the index only. They are a re-derivable
 * function of the corpus and the embedder, and committing thousands of them would bury every
 * real diff in machine noise.
 *
 * `trace-consolidation` was here while it was a counting stub and is NOT any more. It now
 * synthesizes memories and lands each as its own reviewable commit, which puts it behind the
 * discrimination gate the same way every other mutation is. A phase absent from this list is not
 * obliged to commit (this one still reports `commitSha: null` on a night with nothing to distill, no
 * consolidator bound, or a dry run), so the list names phases that CANNOT commit, not phases that
 * happened not to.
 *
 * `task-detection` is absent for the same reason: it commits the tasks it mints, and mints nothing on
 * a night with no model, no candidate, or nothing above its floor.
 */
export const NON_COMMITTING_PHASES: ReadonlyArray<SleepPhase> = ["preflight", "relationship-mining"]

/** How a phase ended. `failed` is a normal terminal state, not an aborted run. */
export type PhaseStatus = "ok" | "failed" | "skipped"

/** Per-phase counts, as they land in the `Memhtml-Counts` trailer and the `sleep_phases` row. */
export type PhaseCounts = Readonly<Record<string, number>>

/** One phase's outcome. */
export interface PhaseResult {
  readonly phase: SleepPhase
  readonly status: PhaseStatus
  readonly counts: PhaseCounts
  /** The commit this phase produced, or `null` when it staged nothing or does not commit. */
  readonly commitSha: string | null
  /** Model calls this phase made. Zero for the eleven deterministic phases. */
  readonly llmCalls: number
  /** Why it failed, or why it was skipped. Absent on `ok`. */
  readonly detail?: string | undefined
}

/** A whole run's outcome. */
export interface RunReport {
  /** `sleep/<YYYY-MM-DD>`, suffixed `-2` on a same-day rerun. Also the branch name. */
  readonly runId: string
  readonly branch: string
  /** The commit the run branched from. `merge` refuses if main moved past it. */
  readonly baseSha: string
  /** The branch tip after the run, or `baseSha` when nothing committed. */
  readonly headSha: string
  readonly dryRun: boolean
  readonly phases: ReadonlyArray<PhaseResult>
  /** Total model calls across {@link LLM_PHASES}. */
  readonly llmCalls: number
}

/** How one file changed across a run, for the review surface. */
export type FileClassification = "meta-only" | "body-changed" | "archived" | "created" | "deleted"

/** One file's classification in a review. */
export interface ReviewFile {
  readonly path: string
  readonly classification: FileClassification
  /** Set only on an archive: the path it moved from. */
  readonly fromPath?: string | undefined
}

/** One commit on the sleep branch. */
export interface ReviewCommit {
  readonly sha: string
  readonly phase: SleepPhase | null
  readonly counts: PhaseCounts
}

/** What `review` reports: the run, its commits, and what they did to the tree. */
export interface ReviewReport {
  readonly runId: string
  readonly branch: string
  readonly baseSha: string
  readonly headSha: string
  readonly phases: ReadonlyArray<PhaseResult>
  readonly commits: ReadonlyArray<ReviewCommit>
  /** `git diff --stat base..HEAD`, verbatim. */
  readonly diffStat: string
  readonly files: ReadonlyArray<ReviewFile>
}

/** What `merge` did, or why it refused. */
export interface MergeReport {
  readonly runId: string
  readonly branch: string
  readonly merged: boolean
  /** `main`'s sha after the fast-forward, or before it on a refusal. */
  readonly headSha: string
  /** Set on a refusal: which precondition failed. */
  readonly refusal?: "main-advanced" | "gate-failed" | "no-run" | undefined
}

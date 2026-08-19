/**
 * The phase vocabulary, the trailer keys, and the dependency graph between phases.
 *
 * These constants are the contract the runner, the resume read, and the report all key on, so
 * they live apart from every phase body: a phase name appears in a commit trailer, in a
 * `sleep_phases` row, and in a `--phases` flag, and three copies of the string would drift.
 */

/**
 * The fifteen phases, in execution order.
 *
 * The order encodes the predecessor memory system's dependencies (design §6): entity resolution precedes person
 * links so aliases have already merged, confidence decay precedes retention triage so triage
 * scores the decayed value, and dedup-merge precedes compress and retention because both operate
 * on the post-merge set.
 */
export const SLEEP_PHASES = [
  "preflight",
  "dedup-merge",
  "entity-resolution",
  "person-links",
  "relationship-mining",
  "conflict-detection",
  "confidence-decay",
  "arc-synthesis",
  "retention-triage",
  "compress",
  "reprieve",
  "trace-consolidation",
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
 * The phases that call a model. Every other phase is deterministic and costs no model call.
 *
 * `dedup-merge` is here and is the only member that still does its whole job WITHOUT one. It calls a
 * model to partition connected components into merge groups, and with no model bound it falls back to
 * the 0.92 cosine floor plus the divergence veto and commits that. So membership here means "spends
 * model calls when a model is bound", not "needs a model to be useful", and a credential-free night
 * still folds duplicates. The other four report a reason and write nothing.
 *
 * Listed in execution order, which is what makes the list readable against {@link SLEEP_PHASES}.
 */
export const LLM_PHASES: ReadonlyArray<SleepPhase> = [
  "dedup-merge",
  "conflict-detection",
  "arc-synthesis",
  "compress",
  "trace-consolidation"
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

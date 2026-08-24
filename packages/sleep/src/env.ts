import type { DatabaseShape, EmbedModelMismatch, IndexerShape } from "@memhtml/index"
import type { ModelClientShape, ModelKey } from "@memhtml/llm"
import type { GitShape, StoreError, StoreShape } from "@memhtml/store"
import type { Effect } from "effect"

import type { ConsolidatorPort } from "./consolidator.js"
import type { PhaseCounts, SleepPhase } from "./contract.js"
/**
 * Type-only, so `verbatimModuleSyntax` erases it and this module's `dist` still imports nothing from
 * `tasks.js`. `tasks.ts` names `PhaseEnv` in return, and a VALUE import either way would be a real
 * cycle between the environment and one of its consumers.
 */
import type { DetectionBudget } from "./tasks.js"

/**
 * What a sleep run is composed of, and what one phase is handed.
 *
 * Every dependency is a shape supplied by the caller. The sleep package builds none of its own
 * services. A runner that constructed a database connection or a Bedrock client could not be
 * pointed at a fixture repo, and the whole test tier for this package is a real temp-dir git repo
 * plus an in-memory SQLite database plus a scripted model.
 */

/** Everything a run needs. Both optional members degrade a phase; neither fails the run. */
export interface SleepDeps {
  readonly git: GitShape
  readonly store: StoreShape
  readonly db: DatabaseShape
  readonly indexer: IndexerShape
  /**
   * The model behind the LLM phases. Absent DEGRADES each of them; it never fails a run.
   *
   * What degradation means is per phase, and the two shapes are different on purpose. `compress`,
   * `arc-synthesis`, and `edge-typing` have nothing to do without a model, so they report a reason and
   * write nothing. `dedup-merge` has a deterministic answer — the 0.92 cosine floor plus the divergence
   * veto — so with no model it does that work and commits it, and `entity-resolution` likewise runs its
   * normalization, character, and declared-alias passes. A night with no credentials still folds every
   * duplicate a cosine can prove and applies every alias a person file declares.
   *
   * Either way this differs from `failed`, which is what a model that answers badly produces. A
   * deterministic run (a dry run, a fixture without credentials) is not a broken run.
   */
  readonly model?: ModelClientShape | undefined
  /**
   * The agent behind trace consolidation, or absent.
   *
   * A separate port from {@link model}, because it runs an agent session that greps and reads
   * inside a sandbox over many turns, and its cost comes back as a COUNT of calls instead of
   * one. Absent degrades the phase to `ok` with a reason, exactly as
   * an absent `model` does for the other three. A run without Bedrock credentials, which is every
   * CI run, is not a broken run.
   */
  readonly consolidator?: ConsolidatorPort | undefined
  /** Which model each LLM phase calls. Defaults in {@link DEFAULT_MODELS}. */
  readonly models?: Partial<Record<SleepPhase, ModelKey>> | undefined
}

/**
 * Model assignments per LLM phase.
 *
 * Every structured phase names `gpt-5.6-sol`, and the reason is one wire property rather
 * than a model-quality judgment: its strict `json_schema` mode does constrained decoding
 * on Bedrock today, so an off-schema answer — including the double-encoded-string shape
 * that skipped 13 batches in one Claude-5 run (issue #53) — cannot be generated at all.
 * The Claude 5 models reject `strict` and `output_config.format` on every Bedrock surface
 * (probed live 2026-08-22), so with them the schema is a request the decode enforces
 * after the fact, and a violated batch is work lost. When Claude 5 structured outputs
 * land on Bedrock, re-deciding this map is a quality question again; today it is not.
 *
 * `trace-consolidation` names `opus-5` and does not thereby choose it. The consolidator is an eve
 * agent that pins its own model in `apps/consolidator/agent/agent.ts`, and this map cannot reach that
 * pin. The entry exists to AGREE with it, so a reader comparing the two
 * finds one answer instead of a silent disagreement. (ROADMAP item 11's recorded decision: Opus 5 on
 * the Bedrock global endpoint, high reasoning effort, no cost ceiling.)
 */
export const DEFAULT_MODELS: Readonly<Record<string, ModelKey>> = {
  "dedup-merge": "gpt-5.6-sol",
  "entity-resolution": "gpt-5.6-sol",
  "edge-typing": "gpt-5.6-sol",
  "arc-synthesis": "gpt-5.6-sol",
  compress: "gpt-5.6-sol",
  "trace-consolidation": "opus-5",
  "task-detection": "gpt-5.6-sol",
  "placement-triage": "gpt-5.6-sol"
}

/** The model a phase calls: the caller's override, else {@link DEFAULT_MODELS}, else sonnet. */
export const modelFor = (deps: SleepDeps, phase: SleepPhase): ModelKey =>
  deps.models?.[phase] ?? DEFAULT_MODELS[phase] ?? "sonnet-5"

/**
 * What every phase can fail with.
 *
 * A phase failure stays inside the runner. It is caught with `Effect.result` and becomes a
 * `PhaseResult` with `status: "failed"`. So this union exists to keep each phase's own error channel
 * typed. A phase that could fail with something outside it would be a phase whose failure the runner
 * cannot describe in a report line.
 */
export type SleepError = StoreError | EmbedModelMismatch

/** One phase's environment: the run's identity, the injected clock reading, and the deps. */
export interface PhaseEnv {
  readonly deps: SleepDeps
  /** `sleep/<YYYY-MM-DD>`, suffixed on a rerun. The `Memhtml-Run` trailer value. */
  readonly runId: string
  readonly branch: string
  readonly baseSha: string
  /**
   * The run date as `YYYY-MM-DD`. A PARAMETER; a phase reads no clock. A
   * worker passes wall-clock and a test passes a fixed date, which is what makes an archive
   * year partition and a `memhtml-valid-until` extension assertable.
   */
  readonly date: string
  /** The run's instant as an ISO-8601 UTC second, for every `memhtml-*` stamp this run writes. */
  readonly at: string
  /** Epoch milliseconds of {@link at}, for the arithmetic the stamps come from. */
  readonly atMillis: number
  /** True on a dry run: compute and count, write no commit and no row beyond the run row. */
  readonly dryRun: boolean
  /**
   * The deep-sleep switches, or absent on a nightly run (issue #63).
   *
   * ABSENT is the nightly cycle, byte-identical to what it did before this field existed: every deep
   * behavior in every phase is behind an `env.deep !== undefined` gate, so a `PhaseEnv` built without
   * the field — every existing test, every nightly cron — takes the exact code paths it always took.
   */
  readonly deep?: DeepOptions | undefined
  /**
   * The night's shared detected-task budget, or absent.
   *
   * The one MUTABLE member of this interface, and the mutation is the point: four phases mint
   * detected tasks and `DETECTED_TASK_CAP` is a bound on the whole night, not on each of them,
   * because how many proposals a human can review is a property of the human. Phases run
   * sequentially in one process, so a module-level counter inside `tasks.ts` would also work in
   * production — and would leak between test cases in one file, which is the contaminating-state
   * failure this repo has paid for repeatedly. A value the RUN creates cannot: two runs hold two
   * budgets.
   *
   * Optional so a test constructing a `PhaseEnv` by hand stays valid; `budgetFor` then hands that
   * phase a fresh cap of its own. `run.ts` supplies one per run, which is what makes the cap shared
   * in production.
   */
  readonly detectionBudget?: DetectionBudget | undefined
}

/** What a phase body produces. The runner turns this into a `PhaseResult`. */
export interface PhaseOutcome {
  readonly counts: PhaseCounts
  /** The commit this phase made, or `null` when it staged nothing or does not commit at all. */
  readonly commitSha: string | null
  readonly llmCalls: number
  /** Present when the phase completed but has something an operator should read. */
  readonly detail?: string | undefined
}

/** A phase body: the whole phase, as one effect over its environment. */
export type PhaseBody = (env: PhaseEnv) => Effect.Effect<PhaseOutcome, SleepError>

/** A phase that ran and did nothing. The shape every early return uses. */
export const emptyOutcome = (counts: PhaseCounts = {}): PhaseOutcome => ({
  counts,
  commitSha: null,
  llmCalls: 0
})

/**
 * The deep-sleep switches (issue #63): absent on a nightly run, present under `--deep`.
 *
 * One OBJECT rather than a boolean beside a number, because the two travel together or not at all: a
 * budget with no deep run has nothing to bound (the nightly phases carry their own per-phase caps),
 * and a deep run with no stated budget still needs a place for the shared counter to live. Every
 * deep behavior in every phase gates on `env.deep !== undefined`, which is what makes the no-flag
 * regression test a one-field assertion.
 */
export interface DeepOptions {
  /**
   * The run-wide model-call budget, or absent for an unbounded deep run.
   *
   * MUTABLE, exactly as {@link PhaseEnv.detectionBudget} is and for the same reason: the phases run
   * sequentially in one process and the cap bounds the RUN, not each phase. Created per run by
   * `run.ts`, so two runs in one process (and two tests in one file) cannot share a counter.
   */
  readonly budget?: LlmBudget | undefined
}

/** The shared deep-run model-call budget. `spent` only ever grows; the cap never moves. */
export interface LlmBudget {
  readonly maxCalls: number
  spent: number
}

/** A fresh budget. A non-positive or fractional cap clamps to a usable whole number. */
export const makeLlmBudget = (maxCalls: number): LlmBudget => ({
  maxCalls: Math.max(0, Math.trunc(maxCalls)),
  spent: 0
})

/**
 * Take one call from the budget, or report exhaustion.
 *
 * `true` means the caller may make the call and the budget has been charged. Charging BEFORE the
 * call rather than after means a crash mid-call cannot under-count, which errs on the side the
 * budget exists for. No budget bound means every call is allowed.
 */
export const takeLlmCall = (deep: DeepOptions | undefined): boolean => {
  const budget = deep?.budget
  if (budget === undefined) return true
  if (budget.spent >= budget.maxCalls) return false
  budget.spent += 1
  return true
}

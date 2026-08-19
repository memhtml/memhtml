import type { DatabaseShape, EmbedModelMismatch, IndexerShape } from "@memhtml/index"
import type { ModelClientShape, ModelKey } from "@memhtml/llm"
import type { GitShape, StoreError, StoreShape } from "@memhtml/store"
import type { Effect } from "effect"

import type { ConsolidatorPort } from "./consolidator.js"
import type { PhaseCounts, SleepPhase } from "./contract.js"

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
   * The model behind the four LLM phases. Absent makes each of them `skipped` with a reason.
   * That differs from `failed`, which is what a model that answers badly produces. A deterministic
   * run (a dry run, a fixture without credentials) is not a broken run.
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
 * Model assignments per LLM phase: the cheap judge for edge typing, the strong one for synthesis.
 *
 * `trace-consolidation` names `opus-5` and does not thereby choose it. The consolidator is an eve
 * agent that pins its own model in `apps/consolidator/agent/agent.ts`, and this map cannot reach that
 * pin. The entry exists to AGREE with it, so a reader comparing the two
 * finds one answer instead of a silent disagreement. (ROADMAP item 11's recorded decision: Opus 5 on
 * the Bedrock global endpoint, high reasoning effort, no cost ceiling.)
 */
export const DEFAULT_MODELS: Readonly<Record<string, ModelKey>> = {
  "edge-typing": "sonnet-5",
  "arc-synthesis": "opus-5",
  compress: "sonnet-5",
  "trace-consolidation": "opus-5"
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

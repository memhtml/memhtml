import { BATCH_CAP } from "@memhtml/session"

/**
 * The four bounds one curator run lives inside. Every one is enforced by the process making the
 * model calls, in that process, so a wedged provider or a chatty model cannot outlast them.
 *
 * `maxOutputTokensPerCall` rides the model itself (`curatorModel` wraps it with
 * `defaultSettingsMiddleware`), because a call that names no limit gets Bedrock's own 4,096-token
 * default and is cut off mid-answer (`.erpaval/solutions/api-patterns/an-unset-per-call-token-limit-
 * truncates-the-answer.md`). `maxOps` matches the session's `BATCH_CAP`: a run that appended more
 * than one commit can carry would be refused at commit time anyway, so the loop stops first.
 */
export interface CuratorBudget {
  /** Model calls the loop may make before it is stopped. */
  readonly maxSteps: number
  /** Output tokens (reasoning included) one model call may spend. */
  readonly maxOutputTokensPerCall: number
  /** Wall clock for the whole run, model calls and tool executions together. */
  readonly wallClockMs: number
  /** Overlay ops the run may append before it is stopped. */
  readonly maxOps: number
}

export const DEFAULT_BUDGET: CuratorBudget = {
  maxSteps: 40,
  maxOutputTokensPerCall: 32_000,
  wallClockMs: 20 * 60_000,
  maxOps: BATCH_CAP
}

/** The default budget with named overrides; an `undefined` override keeps the default. */
export const budgetWith = (overrides: Partial<CuratorBudget> = {}): CuratorBudget => ({
  maxSteps: overrides.maxSteps ?? DEFAULT_BUDGET.maxSteps,
  maxOutputTokensPerCall: overrides.maxOutputTokensPerCall ?? DEFAULT_BUDGET.maxOutputTokensPerCall,
  wallClockMs: overrides.wallClockMs ?? DEFAULT_BUDGET.wallClockMs,
  maxOps: overrides.maxOps ?? DEFAULT_BUDGET.maxOps
})

import { REINFORCE_COOLDOWN_S } from "./ranking.js"

/**
 * The reinforcement cooldown predicate. Its twin is the salience arm's SQL guard:
 *
 * ```sql
 * WHERE last_accessed_at IS NULL
 *    OR unixepoch('now') - unixepoch(last_accessed_at) >= 900
 * ```
 *
 * SQL cannot call this function, so the shared source of truth is the window constant
 * {@link REINFORCE_COOLDOWN_S} and the boundary behavior is pinned by a property test on both
 * sides. The `>=` here matches the SQL's `>=`: a stamp exactly `cooldownSeconds` old **is**
 * bumpable.
 *
 * The cooldown exists because `access_count` feeds the salience RRF arm. Without it, replaying
 * one query ten times would inflate that memory's salience tenfold and let a loop in an agent
 * rewrite the corpus's ranking.
 */
export const shouldBumpAccess = (
  lastAccessedAt: Date | undefined,
  now: Date,
  cooldownSeconds: number = REINFORCE_COOLDOWN_S
): boolean => {
  if (lastAccessedAt === undefined) return true
  const elapsedSeconds = (now.getTime() - lastAccessedAt.getTime()) / 1000
  return elapsedSeconds >= cooldownSeconds
}

/** The signal a reinforcement carries. `negative` is what drives the outcome EWMA down. */
export const REINFORCE_SIGNALS = ["positive", "negative", "neutral"] as const
export type ReinforceSignal = (typeof REINFORCE_SIGNALS)[number]

/**
 * The outcome-EWMA signal value for a reinforcement, unitless in `[-1, 1]`. `neutral` is 0, so
 * a neutral reinforcement bumps the access count without moving the outcome score — a memory
 * being read is evidence of relevance, not of correctness.
 */
export const signalValue = (signal: ReinforceSignal): number => {
  switch (signal) {
    case "positive":
      return 1
    case "negative":
      return -1
    case "neutral":
      return 0
  }
}

/**
 * Split paths into those whose access stamp may be bumped now and those still cooling down.
 * One pass, order-preserving, so `memory_reinforce` can answer both lists from one call.
 */
export const partitionByCooldown = (
  entries: ReadonlyArray<{ readonly path: string; readonly lastAccessedAt?: Date | undefined }>,
  now: Date,
  cooldownSeconds: number = REINFORCE_COOLDOWN_S
): {
  readonly bumped: ReadonlyArray<string>
  readonly cooledDown: ReadonlyArray<string>
} => {
  const bumped: Array<string> = []
  const cooledDown: Array<string> = []
  for (const entry of entries) {
    if (shouldBumpAccess(entry.lastAccessedAt, now, cooldownSeconds)) bumped.push(entry.path)
    else cooledDown.push(entry.path)
  }
  return { bumped, cooledDown }
}

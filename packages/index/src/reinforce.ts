import type { StorageFailure } from "@memhtml/contracts/errors"
import { REINFORCE_COOLDOWN_S, type ReinforceSignal, signalValue } from "@memhtml/domain"
import { Effect } from "effect"

import type { DatabaseShape } from "./database.js"
import { STATE_SCHEMA } from "./schema-const.js"

/**
 * Reinforcement, the ONE call site that moves `state.access`.
 *
 * One site because the cooldown is the invariant. `access_count` feeds the salience RRF arm, so an
 * unguarded second writer would let a loop in an agent replay one query and rewrite the corpus's
 * ranking. A cooldown enforced in two places is a cooldown enforced in neither.
 *
 * The guard is expressed twice by necessity, once as the SQL `WHERE` below and once as
 * `@memhtml/domain`'s `shouldBumpAccess`. SQL cannot call the function, so the shared source of truth
 * is the window constant `REINFORCE_COOLDOWN_S` and a property test pins the two to agree at the
 * boundary. Both use `>=`, so a stamp exactly the window old IS bumpable.
 */

/** The EWMA weight a new outcome signal carries. The remainder keeps the prior score. */
export const OUTCOME_EWMA_ALPHA = 0.3

/** Which paths were bumped and which were still cooling down. */
export interface ReinforceResult {
  readonly bumped: ReadonlyArray<string>
  readonly cooledDown: ReadonlyArray<string>
}

/**
 * Bump the access bookkeeping for every path past its cooldown.
 *
 * `RETURNING` is what makes the split authoritative rather than inferred. The conditional upsert
 * decides in the database, at the instant of the write, and reports which rows it actually touched.
 * Reading `last_accessed_at` first and deciding in TypeScript would race a concurrent reinforce and
 * report a bump that never happened.
 *
 * `at` is passed in rather than read from the clock so a caller can pin the instant. The cooldown
 * boundary test needs to name a time exactly `REINFORCE_COOLDOWN_S` after the stored stamp.
 *
 * `reinforcement_count` increments and `outcome_score` moves only on a non-neutral signal. Being
 * read is evidence of relevance and not of correctness, so a plain retrieval bumps access without
 * claiming the memory was right.
 */
export const reinforce = (
  db: DatabaseShape,
  paths: ReadonlyArray<string>,
  signal: ReinforceSignal,
  at: string,
  cooldownSeconds: number = REINFORCE_COOLDOWN_S
): Effect.Effect<ReinforceResult, StorageFailure> =>
  Effect.gen(function* () {
    const targets = [...new Set(paths)].filter((path) => path !== "")
    if (targets.length === 0 || !db.hasState) return { bumped: [], cooledDown: targets }

    const value = signalValue(signal)
    const reinforced = value === 0 ? 0 : 1
    const bumped: Array<string> = []

    for (const path of targets) {
      const rows = yield* db.all<{ path: string }>(
        `INSERT INTO ${STATE_SCHEMA}.access
           (path, access_count, reinforcement_count, outcome_score, last_accessed_at, last_reinforced_at, updated_at)
         VALUES (?1, 1, ?3, ?4, ?2, CASE WHEN ?3 = 0 THEN NULL ELSE ?2 END, ?2)
         ON CONFLICT(path) DO UPDATE SET
           access_count = access_count + 1,
           reinforcement_count = reinforcement_count + ?3,
           outcome_score = CASE WHEN ?3 = 0 THEN outcome_score
             ELSE max(-1.0, min(1.0, outcome_score * (1 - ?5) + ?4 * ?5)) END,
           last_accessed_at = ?2,
           last_reinforced_at = CASE WHEN ?3 = 0 THEN last_reinforced_at ELSE ?2 END,
           updated_at = ?2
         WHERE access.last_accessed_at IS NULL
            OR unixepoch(?2) - unixepoch(access.last_accessed_at) >= ?6
         RETURNING path`,
        [path, at, reinforced, value, OUTCOME_EWMA_ALPHA, cooldownSeconds]
      )
      if (rows.length > 0) bumped.push(path)
    }

    const cooledDown = targets.filter((path) => !bumped.includes(path))
    return { bumped, cooledDown }
  }).pipe(Effect.withSpan("index.reinforce"))

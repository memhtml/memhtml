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

/**
 * The EWMA weight a new outcome signal carries. The remainder keeps the prior score.
 *
 * The value the SQL below BINDS, and the twin of `@memhtml/domain`'s `DEFAULT_EWMA_ALPHA`, which is
 * the reference implementation the arithmetic here is checked against. SQL cannot read that constant,
 * so this one is declared here and `tests/reinforce.test.ts` pins the pair to agree — a fork of
 * either side fails a suite rather than drifting the reference model off the shipped arithmetic.
 */
export const OUTCOME_EWMA_ALPHA = 0.3

/**
 * Paths bound into one upsert.
 *
 * SQLite's bound-variable ceiling is a BUILD property rather than a language one, at 999 in older
 * builds and 32766 since 3.32, and this package must not assume which one the driver shipped with.
 * Five shared values plus this many paths stays under either, so the split is a correctness guard
 * rather than a tuning knob: one extra statement per 500 paths against a batch that would otherwise
 * be refused outright.
 */
export const REINFORCE_PATH_BATCH = 500

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
 * BATCHED by signature: one statement per {@link REINFORCE_PATH_BATCH} paths, never one per path.
 * A multi-row upsert evaluates its `DO UPDATE … WHERE` per conflicting row, so each path is still
 * decided on its own stamp, and `RETURNING` names exactly the rows that moved. A per-path statement
 * is the store-scaled per-op shape this package refuses everywhere else (see the indexer's pending
 * scan): a recall reinforcing forty hits would pay forty round trips to answer one question.
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
    const bumped = new Set<string>()

    for (let start = 0; start < targets.length; start += REINFORCE_PATH_BATCH) {
      const slice = targets.slice(start, start + REINFORCE_PATH_BATCH)
      /**
       * `?1`–`?5` are the shared values and `?6` onward are the paths, which is what lets one
       * statement carry a whole batch without restating the instant, the signal, or the window per
       * row. Every path is BOUND; none is interpolated.
       */
      const rows = yield* db.all<{ path: string }>(
        `INSERT INTO ${STATE_SCHEMA}.access
           (path, access_count, reinforcement_count, outcome_score, last_accessed_at, last_reinforced_at, updated_at)
         VALUES ${slice
           .map(
             (_, offset) =>
               `(?${String(offset + 6)}, 1, ?2, ?3, ?1, CASE WHEN ?2 = 0 THEN NULL ELSE ?1 END, ?1)`
           )
           .join(", ")}
         ON CONFLICT(path) DO UPDATE SET
           access_count = access_count + 1,
           reinforcement_count = reinforcement_count + ?2,
           outcome_score = CASE WHEN ?2 = 0 THEN outcome_score
             ELSE max(-1.0, min(1.0, outcome_score * (1 - ?4) + ?3 * ?4)) END,
           last_accessed_at = ?1,
           last_reinforced_at = CASE WHEN ?2 = 0 THEN last_reinforced_at ELSE ?1 END,
           updated_at = ?1
         WHERE access.last_accessed_at IS NULL
            OR unixepoch(?1) - unixepoch(access.last_accessed_at) >= ?5
         RETURNING path`,
        [at, reinforced, value, OUTCOME_EWMA_ALPHA, cooldownSeconds, ...slice]
      )
      for (const row of rows) bumped.add(row.path)
    }

    return {
      bumped: targets.filter((path) => bumped.has(path)),
      cooledDown: targets.filter((path) => !bumped.has(path))
    }
  }).pipe(Effect.withSpan("index.reinforce"))

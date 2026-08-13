import { MAX_REPRIEVES, REPRIEVE_DAYS, reprieveScore, shouldReprieve } from "@memhtml/domain"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { archiveFile, datePlusDays, meta, stampFile } from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { hoursBetween, runRetentionPass } from "../retention.js"
import { isSleepExcluded } from "../sql.js"

/**
 * Phase 11, reprieve. A TTL-passed memory earns another two weeks, or it expires. ONE commit.
 *
 * The reprieve score sums four terms: importance, access, outcome, and recency-of-use. It is
 * deliberately NOT convex, because `log1p(accessCount)` is unbounded and the score can exceed 1. It is
 * proven only monotone and sign-clamped, which is all the gate needs. A negative outcome contributes
 * exactly zero and no penalty. The outcome EWMA has already lowered that memory's salience, and
 * penalizing it again here would punish one bad outcome twice.
 *
 * **`MAX_REPRIEVES` is what makes the TTL mean something.** Without the cap a frequently-read memory
 * would extend its own validity forever, and `memhtml-valid-until` would document an intention the system
 * does not enforce. Three reprieves is six weeks past the stated expiry, enough for a human to notice
 * and re-assert the fact deliberately.
 *
 * **Arcs are exempt.** An arc is system-written and carries no meaningful TTL; expiring one on age
 * would delete the agent's own behavioural identity on a schedule.
 */
export const reprieve: PhaseBody = (env) =>
  Effect.gen(function* () {
    const pass = yield* runRetentionPass(env.deps.db, env.at)
    const expired = pass.scored.filter((entry) => {
      if (entry.row.memory_type === "arc") return false
      /**
       * A task's `memhtml-due` is a DEADLINE, not a validity bound, and it is a different column
       * (`due_at`) from the `valid_until` this phase reads, so a task reaching here could only do
       * so by carrying both. Excluded explicitly anyway, because expiring an overdue task would
       * archive work precisely for being late. `memhtml doctor` reports overdue tasks so a human
       * decides instead.
       */
      if (isSleepExcluded(entry.row.memory_type)) return false
      const until = entry.row.valid_until
      if (until === null || until === "") return false
      const deadline = Date.parse(until)
      return Number.isFinite(deadline) && deadline <= env.atMillis
    })

    const decisions = expired.map((entry) => {
      const score = reprieveScore({
        importance: entry.row.importance,
        accessCount: entry.access.accessCount,
        outcomeScore: entry.access.outcomeScore,
        hoursSinceAccess: hoursBetween(entry.access.lastAccessedAt ?? entry.row.updated_at, env.at)
      })
      return {
        entry,
        score,
        reprieved: shouldReprieve({ score, reprieveCount: entry.row.reprieves })
      }
    })

    const toReprieve = decisions.filter((decision) => decision.reprieved)
    const toExpire = decisions.filter((decision) => !decision.reprieved)
    const counts = {
      ttlPassed: expired.length,
      reprieved: toReprieve.length,
      expired: toExpire.length,
      maxReprieves: MAX_REPRIEVES
    }
    if (expired.length === 0 || env.dryRun) return emptyOutcome(counts)

    let reprieved = 0
    for (const decision of toReprieve) {
      const changed = yield* stampFile(env, decision.entry.row.path, [
        meta("memhtml-valid-until", datePlusDays(env.date, REPRIEVE_DAYS)),
        meta("memhtml-reprieves", String(decision.entry.row.reprieves + 1)),
        meta("memhtml-updated", env.at)
      ])
      if (changed) reprieved += 1
    }

    let archived = 0
    for (const decision of toExpire) {
      /**
       * `null` means retention triage already evicted this path, which is the COMMON case and not an
       * edge one. A memory whose TTL has passed usually also scores below the retention floor, and
       * triage runs two phases earlier. Both phases read the index, refreshed once in preflight, so
       * both list it active at its pre-eviction path.
       */
      if ((yield* archiveFile(env, decision.entry.row.path)) !== null) archived += 1
    }

    const final = { ...counts, reprieved, expired: archived }
    const commitSha = yield* commitPhase(
      env,
      "reprieve",
      `reprieve ${reprieved}, expire ${archived} TTL-passed memories`,
      final
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })

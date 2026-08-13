import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { archiveFile } from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { runRetentionPass } from "../retention.js"
import { isSleepExcluded } from "../sql.js"

/**
 * Phase 9, retention triage. Score every active memory on the eight signals; the EVICT band moves
 * into the archive. ONE commit.
 *
 * Eviction is a `git mv` into `archive/<YYYY>/<original-path>`, not a delete. The path under the
 * year mirrors the original exactly, so the mapping is injective, `originalPathFor` inverts it, and
 * `git log --follow` reads straight through. Nothing in this system is deleted. A wrongly
 * evicted memory is recoverable by reading the archive, and an unrecoverable eviction would make the
 * eight-signal score a decision nobody could safely tune.
 *
 * **Arcs are not evicted here.** An arc is a synthesis whose members may all have aged out. Scoring
 * it on its own recency and access would discard the conclusion precisely when the evidence behind it
 * has faded, which is the opposite of what the arc is for. Arc demotion belongs to arc synthesis,
 * which has the utility signal.
 *
 * **Tasks are not evicted either, for a sharper reason.** The retention score is dominated by
 * recency and access, so a task nobody has touched for a month scores at the FLOOR, and that is exactly
 * the task most likely to still be owed. Evicting on that signal would archive the neglected work
 * first and leave the busy work behind, the inverse of what a to-do list is for. A task leaves the
 * active tree one way, by being finished.
 *
 * Runs after confidence decay so it scores the decayed value, and after dedup-merge, declared a HARD
 * prerequisite, so the corpus it scores is the post-merge one.
 */
export const retentionTriage: PhaseBody = (env) =>
  Effect.gen(function* () {
    const pass = yield* runRetentionPass(env.deps.db, env.at)
    const candidates = pass.scored.filter(
      (entry) => entry.row.memory_type !== "arc" && !isSleepExcluded(entry.row.memory_type)
    )

    const evict = candidates.filter((entry) => entry.score.action === "evict")
    const compress = candidates.filter((entry) => entry.score.action === "compress")
    const keep = candidates.filter((entry) => entry.score.action === "keep")

    const counts = {
      scored: candidates.length,
      keep: keep.length,
      compress: compress.length,
      evict: evict.length,
      evicted: evict.length
    }
    if (evict.length === 0) return emptyOutcome({ ...counts, evicted: 0 })
    if (env.dryRun) return emptyOutcome(counts)

    let evicted = 0
    for (const entry of evict) {
      // `null` means an earlier phase already moved this path. The tree is the system of record and
      // the index was refreshed once in preflight, so a path with no file behind it is not a candidate.
      if ((yield* archiveFile(env, entry.row.path)) !== null) evicted += 1
    }

    const final = { ...counts, evicted }
    const commitSha = yield* commitPhase(
      env,
      "retention-triage",
      `evict ${evicted} memories below the retention floor`,
      final
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })

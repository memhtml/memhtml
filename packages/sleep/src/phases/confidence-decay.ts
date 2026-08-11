import {
  DEFAULT_CONFIDENCE_DECAY_ALPHA,
  DEFAULT_CONFIDENCE_FLOOR,
  decayConfidence,
  isCommittableConfidenceChange
} from "@memhtml/domain"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { confidenceOf, meta, readFileBytes, renderConfidence, stampFile } from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { accessRows, activeCorpus, isSleepExcluded } from "../sql.js"

/**
 * Phase 7 — confidence decay. Un-reinforced memories lose confidence toward the floor. ONE commit
 * for the whole corpus.
 *
 * **Only un-reinforced files decay.** A file whose `state.access.reinforcement_count` is above zero
 * has been confirmed useful, and eroding its confidence anyway would make the reinforcement signal
 * meaningless — the phase exists to let an unconfirmed claim fade, not to punish age.
 *
 * **The 0.005 delta gate is what keeps the diff reviewable.** This is the widest commit in a sleep
 * run — one meta line across many files — and a sub-threshold change carries no decision-relevant
 * information while costing a reviewer a line of diff. `decayConfidence` is unconditionally
 * non-increasing and stops at the floor, so a corpus that has finished decaying reaches a fixed point
 * and this phase stops committing entirely.
 *
 * Runs BEFORE retention triage so triage scores the decayed value: scoring the pre-decay confidence
 * would give a memory one extra night of undeserved retention every night, indefinitely.
 */
export const confidenceDecay: PhaseBody = (env) =>
  Effect.gen(function* () {
    const corpus = yield* activeCorpus(env.deps.db)
    const access = yield* accessRows(env.deps.db)
    const reinforced = new Set(
      access.flatMap((row) => (row.reinforcement_count > 0 ? [row.path] : []))
    )

    let eligible = 0
    let belowGate = 0
    let skippedType = 0
    let reinforcedCount = 0
    const changes: Array<readonly [string, number]> = []

    for (const row of corpus) {
      /**
       * Confidence is how sure the agent is that a CLAIM is true, and a task makes no claim.
       * Decaying one would rewrite a task file every night forever — and this is the widest commit
       * in a run, so it would be the noisiest possible no-op.
       *
       * Counted in its own bucket rather than folded into `reinforced`. `reinforced` is derived
       * below as a difference, so a type skip absorbed into it would report tasks as
       * confirmed-useful memories: a count whose name means one thing and whose value means
       * another, which is the seam this fleet has paid for repeatedly.
       */
      if (isSleepExcluded(row.memory_type)) {
        skippedType += 1
        continue
      }
      if (reinforced.has(row.path)) {
        reinforcedCount += 1
        continue
      }
      eligible += 1
      /**
       * The confidence is read from the FILE, not from the `files` row. The file is the system of
       * record and the row is a projection of it; decaying from the projection would compound a
       * stale index into the corpus itself, writing a value derived from a number the tree never had.
       */
      const html = yield* readFileBytes(env, row.path)
      if (html === undefined) continue
      const before = confidenceOf(html)
      const after = decayConfidence(
        before,
        DEFAULT_CONFIDENCE_DECAY_ALPHA,
        DEFAULT_CONFIDENCE_FLOOR
      )
      if (!isCommittableConfidenceChange(before, after)) {
        belowGate += 1
        continue
      }
      changes.push([row.path, after])
    }

    const counts = {
      active: corpus.length,
      reinforced: reinforcedCount,
      skippedType,
      eligible,
      belowGate,
      decayed: changes.length
    }
    if (changes.length === 0 || env.dryRun) return emptyOutcome(counts)

    let decayed = 0
    for (const [path, value] of changes) {
      const changed = yield* stampFile(env, path, [
        meta("memhtml-confidence", renderConfidence(value)),
        meta("memhtml-updated", env.at)
      ])
      if (changed) decayed += 1
    }

    const final = { ...counts, decayed }
    const commitSha = yield* commitPhase(
      env,
      "confidence-decay",
      `decay confidence on ${decayed} un-reinforced memories`,
      final
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })

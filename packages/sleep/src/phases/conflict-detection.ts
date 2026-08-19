import { Effect } from "effect"

import { isolate } from "../batch.js"
import { commitPhase } from "../commit.js"
import { hrefFor, link, meta, stampFile } from "../edits.js"
import { emptyOutcome, modelFor, type PhaseBody } from "../env.js"
import { assertsContradiction, STANCE_SYSTEM, StanceJudgment, stancePrompt } from "../llm.js"
import {
  activeCorpus,
  bumpCorroboration,
  conflictCandidates,
  markPromoted,
  SLEEP_EXCLUDED_TYPES
} from "../sql.js"

/**
 * Phase 6, conflict detection. An NLI stance judge over embedding-near same-entity pairs; a
 * corroborated contradiction is promoted into BOTH files and committed.
 *
 * Three stages, and keeping them separate is what makes the phase safe:
 *
 * 1. **Scan (SQL, no model).** Same-entity active pairs above {@link CONFLICT_COSINE_FLOOR} carrying
 *    no edge in either direction, capped at {@link CONFLICT_CANDIDATE_LIMIT}.
 * 2. **Judge (one model call per pair, isolated).** Each call is wrapped so one malformed tool
 *    payload skips its pair and is counted. A night that judged 199 pairs and lost the 200th has
 *    done 199 pairs of work; failing the phase would discard all of it.
 * 3. **Assert (deterministic, decided here and not by the model).** Only `verdict: "contradicts"` above
 *    the confidence floor bumps the corroboration counter, and only `detections >= 2` promotes the edge
 *    into the files. A single machine detection therefore cannot reach the retention penalty. The
 *    counter lives in the state plane and the penalty counts only `derived = 0` file-borne edges.
 *
 * **Detection only.** The phase asserts the contradiction and stops. It does not supersede, close a
 * `memhtml-valid-until`, or archive either side. Choosing the winner of a contradiction is a one-way
 * door on stored belief, and it belongs to an agent or a human, not to a nightly job.
 */

/** The moderate similarity floor a pair must clear to be worth a model call. */
export const CONFLICT_COSINE_FLOOR = 0.8

/** Nearest same-entity neighbors considered per source. */
export const CONFLICT_PER_SOURCE_K = 5

/** Pairs judged per cycle. The model-cost guard. */
export const CONFLICT_CANDIDATE_LIMIT = 200

/** Detections a machine-found contradiction needs before it is written into the files. */
export const PROMOTION_DETECTIONS = 2

export const conflictDetection: PhaseBody = (env) =>
  Effect.gen(function* () {
    const model = env.deps.model
    if (model === undefined) {
      return { ...emptyOutcome({ candidates: 0, judged: 0 }), detail: "no model bound" }
    }

    /**
     * Tasks are out of the candidate set. "These two contradict" is a judgment about asserted
     * facts, and a task asserts nothing. A model asked about two tasks would answer a question
     * that has no true answer, and a promoted `contradicts` between them would be a memory-class
     * edge with task endpoints written into both files.
     */
    const candidates = yield* conflictCandidates(env.deps.db, {
      floor: CONFLICT_COSINE_FLOOR,
      perSourceK: CONFLICT_PER_SOURCE_K,
      limit: CONFLICT_CANDIDATE_LIMIT,
      excludeTypes: SLEEP_EXCLUDED_TYPES
    })
    if (candidates.length === 0) {
      return emptyOutcome({ candidates: 0, judged: 0, contradictions: 0, promoted: 0, skipped: 0 })
    }
    if (env.dryRun) {
      return emptyOutcome({
        candidates: candidates.length,
        judged: 0,
        contradictions: 0,
        promoted: 0,
        skipped: 0
      })
    }

    const corpus = yield* activeCorpus(env.deps.db)
    const textOf = new Map(corpus.map((row) => [row.path, `${row.gist}\n${row.body_text}`]))
    const modelKey = modelFor(env.deps, "conflict-detection")

    let judged = 0
    let contradictions = 0
    let promoted = 0
    let skipped = 0
    let llmCalls = 0

    for (const candidate of candidates) {
      const textA = textOf.get(candidate.src)
      const textB = textOf.get(candidate.dst)
      if (textA === undefined || textB === undefined) {
        skipped += 1
        continue
      }

      llmCalls += 1
      const judgment = yield* isolate(
        `conflict-detection pair ${judged + skipped}`,
        model.generateObject({
          schema: StanceJudgment,
          system: STANCE_SYSTEM,
          prompt: stancePrompt(textA, textB),
          modelKey,
          effort: "medium",
          toolDescription: "Emit the stance of memory B relative to memory A."
        })
      )
      if (judgment === undefined) {
        skipped += 1
        continue
      }
      judged += 1
      if (!assertsContradiction(judgment)) continue
      contradictions += 1

      /**
       * The bump and the promotion decision are one statement's `RETURNING`, not a read followed by
       * a write. Two runs racing on one pair would otherwise both read `detections = 1` and both
       * decline to promote, so a genuinely corroborated contradiction would stay out of the files
       * forever.
       */
      const rows = yield* bumpCorroboration(env.deps.db, {
        srcPath: candidate.src,
        rel: "contradicts",
        dstPath: candidate.dst,
        at: env.at
      })
      const row = rows[0]
      if (row === undefined || row.detections < PROMOTION_DETECTIONS || row.promoted === 1) continue

      // Both directions: a contradiction is symmetric, and a reader arriving at either file must
      // see it. `addLink` is idempotent on the pair, so a re-promotion writes nothing.
      yield* stampFile(env, candidate.src, [
        link("contradicts", hrefFor(candidate.dst)),
        meta("memhtml-updated", env.at)
      ])
      yield* stampFile(env, candidate.dst, [
        link("contradicts", hrefFor(candidate.src)),
        meta("memhtml-updated", env.at)
      ])
      yield* markPromoted(env.deps.db, {
        srcPath: candidate.src,
        rel: "contradicts",
        dstPath: candidate.dst,
        at: env.at
      })
      promoted += 1
    }

    const counts = { candidates: candidates.length, judged, contradictions, promoted, skipped }
    if (promoted === 0) return { counts, commitSha: null, llmCalls }

    const commitSha = yield* commitPhase(
      env,
      "conflict-detection",
      `promote ${promoted} corroborated contradictions`,
      counts
    )
    return { counts, commitSha, llmCalls }
  })

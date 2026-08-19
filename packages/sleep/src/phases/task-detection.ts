import { Effect } from "effect"

import { assembleBatches, batchCall, keyMembers, resolveKeys } from "../batch.js"
import { commitPhase } from "../commit.js"
import { emptyOutcome, modelFor, type PhaseBody } from "../env.js"
import { TASK_DETECT_SYSTEM, TaskDetection, taskDetectPrompt } from "../llm.js"
import { type CorpusRow, recentActiveMemories } from "../sql.js"
import { budgetFor, closeVanishedDetections, detectionKey, mintDetectedTask } from "../tasks.js"

/**
 * Phase 13, task detection. A batched scan over the recent active corpus for work the text records
 * and nobody opened. ONE commit for the night's mints.
 *
 * Surface 3 of issue #44, and the only one that is net-new model spend. Surfaces 1 and 2 ride on
 * decisions other phases were already making — a review band entity resolution declined, a pair the
 * divergence veto refused, a commitment the consolidator's existing call can also report — so they
 * cost tokens the night was already spending. This one asks a question nobody was asking, which is why
 * it is capped, floored, and last of the four: the issue explicitly sizes it as the surface that could
 * ship last or never.
 *
 * Four stages, and the separation is what keeps a model's sentence from becoming an assertion:
 *
 * 1. **Scan (SQL, no model).** {@link TASK_SCAN_LIMIT} most-recently-updated active non-task
 *    memories, newest first, ties by path. Deterministic, so the batches and the `m1`..`mN` keys are a
 *    function of the corpus.
 * 2. **Batch (deterministic).** Sliced at {@link TASK_DETECT_BATCH_SIZE} on the shared kernel, each
 *    member cut to {@link TASK_DETECT_MEMBER_CHARS}. One call per batch, never one per memory: 200
 *    candidates is 10 calls, and per-memory judging is 200.
 * 3. **Ask (one isolated call per batch).** A failure skips its batch and is counted. A night that
 *    scanned nine batches and lost the tenth has done nine batches of work.
 * 4. **Mint (deterministic, and this is where the guards are).** The key must resolve to an offered
 *    member; the confidence must clear {@link TASK_DETECT_FLOOR}; the sentence must exist VERBATIM in
 *    the cited file's own article text, which `mintDetectedTask` checks by reading the file; the
 *    nightly budget must have room. Everything the file says is derived from the member the model was
 *    shown plus its own quoted sentence — the model never names a path, a title, or a status.
 *
 * **No self-referential loops, and ONE guard rather than two.** `recentActiveMemories` excludes `task`
 * in SQL, and that is the whole mechanism: a task is not evidence of another task, and a detector that
 * scanned its own output would restate its own queue every night. A path-prefix check on top of it was
 * written and then removed, because it could not be made to fire — the index is refreshed once in
 * preflight, so a task minted earlier in the same night is ABSENT from the projection rather than
 * present with the wrong type, and either way the statement does not return it. Mutation-verified:
 * deleting the SQL filter fails `tests/task-detection.test.ts`, and deleting the path filter did not.
 *
 * **Self-cleaning, and only from a full-strength scan.** {@link closeVanishedDetections} runs when the
 * night reached every batch — no skips — because `liveKeys` then genuinely describes the findings that
 * still exist. On a night that lost a batch it describes what the phase managed to look at, and
 * sweeping against that would close a human's review because a call was throttled.
 *
 * **Degrades and never fails.** No model bound, no candidate, a dry run, or a night where nothing
 * clears the floor all produce `ok` with counts. A credential-free run is not a broken run.
 */

/**
 * Memories scanned per night.
 *
 * 200, matching `EDGE_TYPING_CANDIDATE_LIMIT`'s posture rather than `COMPRESS_CANDIDATE_LIMIT`'s: this
 * is a bound on what the phase READS INTO PROMPTS, and every candidate costs tokens whether or not it
 * yields a finding. At {@link TASK_DETECT_BATCH_SIZE} that is ten calls a night, which sits inside the
 * envelope issue #43 measured for the whole batching direction. Newest-first ordering is what makes
 * 200 a moving window rather than a truncation: a corpus of 2,907 is scanned in the region where
 * unresolved work actually lives, and last month's settled memories are not re-read every night.
 */
export const TASK_SCAN_LIMIT = 200

/**
 * Memories offered per model call.
 *
 * Twenty. The question is per member and the answer is a short list, so the batch can be wider than
 * compress's 8 (which has to hold every member's facts in the answer's generative attention) and
 * narrower than dedup's 40 (whose members are pre-grouped, so most of a batch needs no independent
 * judgment). Twenty memories at {@link TASK_DETECT_MEMBER_CHARS} is 24k characters of member text, and
 * the model has to read each one for a distinct verbatim sentence.
 */
export const TASK_DETECT_BATCH_SIZE = 20

/** Characters of each member shown. The house per-member budget, the same 1200 four phases use. */
export const TASK_DETECT_MEMBER_CHARS = 1200

/**
 * The confidence a finding must clear before a task is minted.
 *
 * 0.7, the same floor `EDGE_CONFIDENCE_FLOOR` and `ENTITY_CONFIDENCE_FLOOR` set, and for the
 * comparable reason: a false positive costs a reviewer's attention, which is the resource this whole
 * surface spends, and the failure mode of a low floor is a queue nobody reads. One number rather than
 * one per kind, because a second would be a knob nobody could state the meaning of.
 */
export const TASK_DETECT_FLOOR = 0.7

/** The detector's name: the key's namespace, the task's second tag, and the sweep's scope. */
export const TASK_DETECT_DETECTOR = "task-detection"

/** The text a member is offered under: its title, claim, and body, the join compress and dedup use. */
const memberText = (row: CorpusRow): string => `${row.title}\n${row.gist}\n${row.body_text}`

/**
 * The claim a finding becomes, by kind.
 *
 * Derived here and never asked of the model, the same decision every other phase makes about a value
 * that reaches a file. A model-written claim would be the `<mark>` span, `files.gist`, and the frame
 * key the proximity check reads — so the one sentence that decides how this task is de-duplicated
 * against the rest of the queue would be prose a model chose.
 *
 * The verbs are the imperative a reviewer acts on: a commitment is confirmed or closed, a follow-up is
 * resolved or dismissed. Both name the SOURCE, because a task whose subject a reader has to go
 * looking for is a task they skip.
 */
const claimFor = (kind: "commitment" | "followup", path: string): string =>
  kind === "commitment"
    ? `confirm: ${path} records a commitment with nothing saying it was done.`
    : `resolve: ${path} leaves a follow-up open.`

/** The title a finding becomes. Same two shapes, without the trailing sentence punctuation. */
const titleFor = (kind: "commitment" | "followup", row: CorpusRow): string =>
  kind === "commitment"
    ? `Confirm the commitment recorded in ${row.title}`
    : `Resolve the follow-up left open by ${row.title}`

export const taskDetection: PhaseBody = (env) =>
  Effect.gen(function* () {
    const model = env.deps.model
    if (model === undefined) {
      return { ...emptyOutcome(ZERO), detail: "no model bound" }
    }

    /**
     * The candidate slice, with the self-scan exclusion inside the statement. See the phase header:
     * `recentActiveMemories` filters `memory_type` in SQL, and no second path-level filter is added
     * here on purpose — a detected task's row either carries `memory_type = 'task'` and the statement
     * excludes it, or is absent from the index entirely and the statement never sees it. A path-prefix
     * check would be a guard with no reachable input, which is worse than no guard: it reads as the
     * thing standing between a task and the prompt while the statement is what actually does it.
     */
    const candidates = yield* recentActiveMemories(env.deps.db, { limit: TASK_SCAN_LIMIT })
    if (candidates.length === 0) return emptyOutcome(ZERO)
    /**
     * A dry run stops after the deterministic half, before the calls. The candidate count is the
     * number an operator sizing a night wants, and a preview that spent the tokens to then discard
     * every answer would be the most expensive way to produce it. `entity-resolution` makes the same
     * choice for a stronger reason (its dry run would have to manufacture a night of corroboration);
     * here it is simply that nothing the calls buy survives a dry run.
     */
    if (env.dryRun) return emptyOutcome({ ...ZERO, candidates: candidates.length })

    const batches = assembleBatches([candidates], { maxMembers: TASK_DETECT_BATCH_SIZE })
    const modelKey = modelFor(env.deps, "task-detection")
    const budget = budgetFor(env)

    let llmCalls = 0
    let findings = 0
    let minted = 0
    let refreshed = 0
    let unverified = 0
    let framed = 0
    let skipped = 0
    /** Every key this night's scan SAW above the floor, whether or not it minted. The sweep's input. */
    const liveKeys = new Set<string>()

    for (const batch of batches) {
      const keyed = keyMembers(batch, memberText, { charBudget: TASK_DETECT_MEMBER_CHARS })

      llmCalls += 1
      const answer = yield* batchCall(model, `task-detection batch of ${batch.length}`, {
        schema: TaskDetection,
        system: TASK_DETECT_SYSTEM,
        prompt: taskDetectPrompt(keyed.keyed),
        modelKey,
        effort: "medium",
        toolDescription:
          "Emit one finding per memory that records open work, quoting the sentence verbatim."
      })
      if (answer === undefined) {
        skipped += 1
        continue
      }

      /**
       * The keys this batch has already yielded a finding for, so a SECOND finding naming one is
       * dropped. Same guard `edge-typing` carries and the same reason: nothing in the schema stops a
       * model from emitting two findings for one member, and acting on both would mint two tasks about
       * one memory whose only difference is which sentence was quoted. `resolveKeys` does not help,
       * because it is called one key at a time here — a finding names one member.
       */
      const answered = new Set<string>()

      for (const finding of answer.findings) {
        const [row] = resolveKeys(keyed, [finding.memberKey])
        if (row === undefined) continue
        if (answered.has(finding.memberKey)) continue
        answered.add(finding.memberKey)
        findings += 1
        if (finding.confidence < TASK_DETECT_FLOOR) continue

        /**
         * The key is the SOURCE PATH plus the normalized sentence, so the same commitment found again
         * tomorrow keys the same and refreshes. The path is in the key rather than only the sentence
         * because one sentence can legitimately appear in two memories — a corrected memory and its
         * correction share most of their prose — and those are two findings a reviewer decides
         * separately. `detectionKey` normalizes, so a member whose whitespace the chunker changed keys
         * the same.
         */
        const key = detectionKey(TASK_DETECT_DETECTOR, `${row.path} ${finding.sentence}`)
        liveKeys.add(key)

        const outcome = yield* mintDetectedTask(env, budget, {
          detector: TASK_DETECT_DETECTOR,
          finding: `${row.path} ${finding.sentence}`,
          title: titleFor(finding.kind, row),
          claim: claimFor(finding.kind, row.path),
          detail:
            `Detected as ${finding.kind === "commitment" ? "a commitment" : "an unresolved follow-up"} ` +
            `at confidence ${finding.confidence.toFixed(2)} in a ${row.memory_type} memory last ` +
            `updated ${row.updated_at}.`,
          evidence: { kind: "quote", quote: finding.sentence, sourcePath: row.path }
        })
        if (outcome === "minted") minted += 1
        else if (outcome === "refreshed") refreshed += 1
        else if (outcome === "unverified") unverified += 1
        else if (outcome === "framed") framed += 1
      }
    }

    /**
     * The sweep, only from a full-strength scan. `skipped > 0` means at least one batch's memories
     * went unread, so a finding of theirs is missing from `liveKeys` because the phase could not look
     * rather than because it is gone.
     */
    const closed =
      skipped === 0 ? yield* closeVanishedDetections(env, TASK_DETECT_DETECTOR, liveKeys) : 0

    const counts = {
      candidates: candidates.length,
      batches: batches.length,
      findings,
      minted,
      refreshed,
      unverified,
      framed,
      closed,
      capped: budget.overflow,
      skipped
    }
    /**
     * A refresh writes a `memhtml-updated` stamp, which is a staged file, so it commits — the queue's
     * "last seen" is a fact worth a diff. Nothing staged at all leaves `commitSha: null`, which
     * `commitPhase` already produces on an empty index; the early return only spares git the call.
     */
    if (minted === 0 && refreshed === 0 && closed === 0) {
      return { counts, commitSha: null, llmCalls }
    }

    const commitSha = yield* commitPhase(
      env,
      "task-detection",
      `open ${minted} detected tasks, close ${closed} no longer detected`,
      counts,
      closed === 0 ? undefined : "closing reason: no longer detected"
    )
    return { counts, commitSha, llmCalls }
  })

/**
 * The full count SHAPE, at zero.
 *
 * Every key the phase can report is present on every path, because a report reader comparing two
 * nights reads a missing key as a phase that does not have that concept rather than as a night that
 * did none of it. Same rule `edge-typing`'s `zero` states.
 */
const ZERO = {
  candidates: 0,
  batches: 0,
  findings: 0,
  minted: 0,
  refreshed: 0,
  unverified: 0,
  framed: 0,
  closed: 0,
  capped: 0,
  skipped: 0
}

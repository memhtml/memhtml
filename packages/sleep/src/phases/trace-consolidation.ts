import { ENTITY_SEPARATOR, WRITABLE_MEMORY_TYPES } from "@memhtml/contracts"
import type { StorageFailure } from "@memhtml/contracts/errors"
import { placementFor } from "@memhtml/contracts/paths"
import { SLUG_FALLBACK, slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import { frameKeyOf } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import { makeIndexRecorder } from "@memhtml/index"
import { Effect, Result } from "effect"

import { commitPhase } from "../commit.js"
import type {
  CandidateCommitmentLike,
  CandidateMemoryLike,
  TranscriptManifestEntry
} from "../consolidator.js"
import { pendingMarksPath, recordPendingMarks } from "../contract.js"
import { readFileBytes, writeFileBytes } from "../edits.js"
import { emptyOutcome, type PhaseBody, type PhaseEnv, type SleepError } from "../env.js"
import {
  linkedSessionCount,
  type SessionManifestRow,
  sessionManifestRows,
  unconsolidatedSessions,
  unlinkedSessionCount
} from "../sql.js"
import {
  budgetFor,
  closeDetectedTask,
  detectionKey,
  mintDetectedTask,
  openDetections
} from "../tasks.js"

/**
 * Phase 12, trace consolidation. Unread transcripts go to the injected agent; each candidate it
 * clears becomes ONE REVIEWABLE COMMIT. Watermarks are PROPOSED on the branch and land at merge.
 *
 * **`.memhtml` holds no session content, and this phase does not change that.** The trace tables are a
 * read-only index over `~/.claude/projects`, so the transcripts are read AT THEIR SOURCE, by the
 * consolidator, off a read-only mount inside its sandbox. What comes back is a distilled CLAIM and no
 * span of transcript. What this phase SENDS is a manifest of metadata: paths, spans, counts,
 * and the corpus paths already linked to each session, with nothing that was written inside a
 * transcript. The evidence quotes a candidate cites travel into the commit message's context and stop
 * there. A memory body carrying a verbatim turn would put session content in the corpus, which is the
 * one thing the trace plane's whole design exists to prevent.
 *
 * **A watermark means a transcript was READ, not that one was requested.** The phase asks about a
 * batch and watermarks only what the agent reports having reached, intersected with that batch. See
 * {@link analyzedFrom}. The distinction matters because `trace_consolidations` is an anti-join. A
 * watermark on a session whose transcript did not arrive removes it from every future batch, so the
 * transcript is lost with a row asserting it was handled.
 *
 * **And a watermark means a transcript was read BY A RUN THAT LANDED.** The row is not written here at
 * all: this phase records a `session-consolidated` `PendingMark` in the run's committed ledger, and
 * `merge` writes the row once the branch is on `main`. The anti-join's row survives `git branch -D`
 * and `memhtml index rebuild` alike, so writing it during the phase would make a discard partial in the
 * one direction that costs content — the distilled memories go away with the branch and the row saying
 * the transcript was handled stays behind, so no later cycle ever reads it again.
 *
 * **Structurally firewalled from retrieval.** This is the one phase that reads the trace tables, and
 * what it WRITES is an ordinary memory through the ordinary template. Nothing in the retrieval SQL
 * assembler names `traces`, `trace_prompts`, or `trace_consolidations`, and a test greps every
 * assembled statement to prove it. A trace row cannot enter RRF. A memory this phase
 * synthesized is indistinguishable from one an agent wrote, which is correct, because it IS one.
 *
 * **One commit per candidate, not one for the phase.** Same reasoning `arc-synthesis` records: a
 * distilled memory is a standalone assertion a reviewer reads as one thing, and a commit carrying six
 * unrelated ones is a commit nobody reviews. It also means a bad candidate in position three leaves
 * one and two committed.
 *
 * **The discrimination gate needs nothing wired here.** Every commit lands on the sleep branch, and
 * `merge`'s `preMergeGate` (`review.ts:196-209`) runs over the whole branch before `main` moves. So
 * being on the branch IS being behind the gate, and a phase that tried to gate itself would be a
 * second, weaker copy of the one that already covers all fifteen phases.
 *
 * **Degrades three ways and fails on none of them.** No consolidator bound, a consolidator that failed
 * (missing credentials, an unreachable agent, an off-contract answer), and a candidate this phase
 * refuses all produce `ok` with counts and a reason. INV-3 in full: a night with no Bedrock
 * credentials is not a broken night, and a run that lost this phase stays green.
 *
 * ## Surface 2: the same answer also carries COMMITMENTS
 *
 * The consolidator's turn now reports two lists, and the second is issue #44's surface 2. The marginal
 * cost is tokens in a call this phase was already making — no new model call, which is what makes this
 * surface cheap enough to run every night and is the reason the issue sizes it above the net-new scan.
 *
 * A commitment is not a candidate memory and does not travel through the candidate loop.
 * {@link CONSOLIDATION_KINDS} excludes `task` deliberately ("task is work to do, not something observed
 * to have happened"), and that exclusion still holds: the model reports what a transcript SAYS, and the
 * decision to open a task is made HERE, deterministically, by {@link commitmentRefusalFor} plus
 * {@link COMMITMENT_FLOOR}.
 *
 * Two arms, from one list:
 *
 * - **Unresolved** commitments mint detected tasks, sharing the night's `DETECTED_TASK_CAP` budget with
 *   every other detector, keyed on a normalized digest of the STATEMENT so the same promise restated on
 *   a later night refreshes rather than duplicating.
 * - **Resolved** commitments — a session showing the work done — close an OPEN detected task whose key
 *   matches. That is the issue's "closure is also detected", and it is the reason a commitment that
 *   arrives already-done is still worth reporting: a night that opens a task and a later night that
 *   closes it are two readings of the same commitment.
 *
 * The key carries the statement and NOT the session, which is the one place surface 2 departs from
 * `task-detection`'s keying, and it is forced by what closure has to reach across. See
 * {@link commitmentKey}.
 *
 * **Only a DETECTED task is ever closed, and the guard is `closeDetectedTask`'s, on the path.** A
 * human-opened task must not be archived because a model read "shipped it" in somebody's scrollback.
 *
 * **A commitment's evidence quote never enters the corpus, exactly like a candidate's.** The task body
 * carries the model's own restatement plus the session id as a `memhtml-session` stamp; the verbatim
 * line goes in the commit message. `packages/sleep/src/tasks.ts`' `DetectionEvidence` `session` arm is
 * where that split is enforced, and its header records why the quote is not re-verified against
 * transcript bytes.
 *
 * **One commit for the batch of commitment tasks**, not one per task, and that is the one place this
 * phase departs from its one-commit-per-candidate discipline. The reason the discipline exists is that
 * a distilled memory is a standalone ASSERTION about the world a reviewer weighs on its own. A detected
 * task asserts nothing — it is a proposal, and the reviewer's decision is made in the task file rather
 * than at the commit. What the commit has to do is be reviewable, and "the night found four
 * commitments, here they are with their quotes" is one reviewable decision about one model answer.
 */

/**
 * The smallest transcript worth a model's attention, in bytes.
 *
 * 8 KiB, measured and not picked. Over the live corpus at `~/.claude/projects` on 2026-08-08
 * (11,361 transcripts, 6.59 GB): 34 files sit below 8 KiB, and each holds 5-13 JSONL lines, a
 * session opened and abandoned, whose whole content is a system preamble and one prompt. p01 is
 * 43.6 KB, so the floor excludes ~0.3% of sessions and none that transacted anything. A candidate
 * distilled from a 10-line file could only restate one of those lines, which
 * `apps/consolidator/agent/instructions.md:42-43` names as below the bar anyway. So the floor saves the
 * call without changing the answer.
 */
export const TRACE_MIN_BYTES = 8 * 1024

/**
 * Sessions handed over per run.
 *
 * Ten, which sits below the consolidator's own 32-transcript ceiling
 * (`apps/consolidator/src/contract.ts:210`) deliberately. That cap bounds RESIDENT BYTES in
 * the sandbox, and this one bounds what a single agent session is asked to hold in attention. A batch
 * that clears the byte budget can still be too wide to read carefully, and the cross-session patterns
 * this phase exists to find are the ones visible across a handful of recent sessions.
 *
 * The two caps compose instead of duplicating: whichever is smaller binds, and the consolidator warns
 * when it has to page. Newest-first ordering in the query is what makes ten a nightly increment
 * instead of a truncation. A first run over a year of transcripts consolidates the ten most recent,
 * and each subsequent night takes the next ten.
 */
export const TRACE_SESSIONS_PER_RUN = 10

/**
 * How settled a transcript must be before it is read, in milliseconds before the run's instant.
 *
 * One hour. A transcript is written by a live process, and a session still in progress would be read
 * half-finished and then watermarked as done, with the interesting part arriving after the row that
 * says it was handled. The cutoff is derived from `env.at`, which is midnight of the run's own date
 * (`run.ts:56-60`), NOT from a clock. A phase that read wall-clock could not be tested against a
 * fixed date, and `env.ts:60-67` states the rule. One consequence follows: with `at` at
 * midnight, nothing written on the run's own date is eligible, so the quiet window in practice
 * subsumes the live-session guard instead of merely satisfying it.
 */
export const TRACE_QUIET_MILLIS = 60 * 60 * 1000

/** Evidence quotes shown in one commit message. Enough to judge the claim, short of a transcript. */
const COMMIT_EVIDENCE_LIMIT = 3

/** Characters of one quote shown in a commit message. */
const COMMIT_QUOTE_CHARS = 200

/** Where a consolidated memory lands: by kind and tag, exactly as an agent's own write is placed. */
const CONSOLIDATION_TAG = "trace-consolidation"

/**
 * The confidence a commitment must clear before it mints a task or closes one.
 *
 * 0.7, the same floor `TASK_DETECT_FLOOR`, `EDGE_CONFIDENCE_FLOOR`, and `ENTITY_CONFIDENCE_FLOOR` set,
 * and one number rather than one per arm. The mint arm and the closure arm read it identically on
 * purpose: they are the same judgement about the same sentence, made once, and a lower floor on closure
 * would mean a commitment too weak to open a task was strong enough to close one.
 *
 * The resource this bounds is a reviewer's attention, which is a property of the human rather than of
 * how the finding was reached — the reasoning `DETECTED_TASK_CAP` records for being shared.
 */
export const COMMITMENT_FLOOR = 0.7

/** The detector name every commitment task is keyed, tagged, and closed under. */
export const COMMITMENT_DETECTOR = "trace-commitment"

/** The actors whose commitments are FIRST-PERSON, and therefore the only ones minted. */
const FIRST_PERSON_ACTORS: ReadonlySet<string> = new Set(["user", "agent"])

/**
 * A commitment this phase will act on, or the reason it was refused.
 *
 * Deterministic and between the model and the tree, the same position {@link refusalFor} occupies for a
 * candidate memory, and every clause is a real failure mode rather than a restatement of the schema:
 *
 * - **An actor outside `user`/`agent`.** Issue #44 asks for first-person commitments only, and the
 *   contract's third value exists so a model has somewhere honest to put a third party's commitment
 *   instead of mislabelling it. Dropping `other` HERE rather than refusing it in the schema is what
 *   makes that honesty free: the model can report "a colleague said they'd ship it" accurately, and the
 *   phase declines to open a task nobody in this store owes.
 * - **An empty statement.** It becomes the task's `<mark>` claim and therefore `files.gist`, so a
 *   whitespace claim is a file the parser accepts and no search can find.
 * - **An empty quote or session id.** The quote is the reviewer's receipt in the commit message, and
 *   the session is the task's `from_session` provenance. Neither is optional in the contract; this is
 *   the redundancy every model-facing gate in this package carries, so a scripted or future
 *   consolidator that skipped the schema still does not get past here.
 * - **Below the floor.** Counted separately by the caller rather than folded into the refusals,
 *   because a night pressing against the floor is a different signal from a night sending malformed
 *   commitments — the first says the threshold may be wrong and the second says the agent is.
 *
 * A session id OUTSIDE the batch is not checked here and is checked by the caller, which holds the
 * batch. See {@link commitmentSession}.
 */
const commitmentRefusalFor = (commitment: CandidateCommitmentLike): string | null => {
  if (!FIRST_PERSON_ACTORS.has(commitment.actor)) {
    return `actor ${commitment.actor} is not first-person`
  }
  if (commitment.statement.trim() === "") return "empty statement"
  if (commitment.evidence.quote.trim() === "") return "empty evidence quote"
  if (commitment.evidence.sessionId.trim() === "") return "empty evidence session"
  return null
}

/**
 * A commitment's stable key: a normalized digest of the STATEMENT, and deliberately NOT of the session.
 *
 * This is the one place surface 2's keying departs from `task-detection`'s, which puts the source path
 * in its key, and the difference is forced by what closure has to do. The issue's requirement is that
 * "a commitment whose completion appears in A LATER SESSION can propose `task status done`" — so the
 * task a Monday session opened has to be findable from a Friday session's completion, and any key
 * carrying the session id makes those two keys different by construction. A session-keyed design cannot
 * close anything across nights, which is the only span closure is for.
 *
 * The consequence is that one sentence said in two sessions is ONE task, refreshed rather than
 * duplicated. That is the right reading for a commitment and the wrong one for `task-detection`'s
 * findings, and the asymmetry is not an inconsistency. A commitment is a piece of WORK: "wire the
 * capture path" promised on Monday and again on Wednesday is one thing to do, and two rows in the queue
 * would be one task and one duplicate. `task-detection`'s findings are per-MEMORY review decisions —
 * a corrected memory and its correction share most of their prose — and those are two files a reviewer
 * looks at separately, which is why the path belongs in that key.
 *
 * `detectionKey` normalizes (NFC, lowercase, collapsed whitespace), so a restatement whose spacing or
 * casing differs keys the same. It does not survive the model REWORDING the statement, which is the
 * honest limit of a digest over prose: `mintDetectedTask`'s frame-key check is the second net, the
 * volume cap is the third, and a completion whose wording moved is what `completionsUnmatched` counts.
 */
const commitmentKey = (commitment: CandidateCommitmentLike): string =>
  detectionKey(COMMITMENT_DETECTOR, commitment.statement)

/**
 * The claim a commitment becomes: the work, stated as work, with the actor who owes it.
 *
 * **The STATEMENT leads, and that is a correctness requirement rather than a style choice.** The claim
 * is what `mintDetectedTask`'s frame-key proximity check reads, and the earlier wording — `confirm: the
 * <actor> committed to <statement>` — puts the statement in the rule's VALUE position: measured against
 * `frameKeyOf`, every commitment whose statement is six tokens or fewer keys on
 * `confirm: the agent committed to`, so "add the guard" and "ship the fix" shared a frame and the second
 * one answered `framed` and vanished. Only long statements escaped, by overflowing `MAX_VALUE_TOKENS` to
 * `null`, which made the collapse depend on statement length.
 *
 * With the statement in the frame the key carries it (measured: twelve statements across both actors,
 * twelve distinct keys, none null), so the check still fires between two DIFFERENT detectors describing
 * one commitment and never between two commitments of this one — which the statement digest in
 * {@link commitmentKey} already separates.
 */
const commitmentClaim = (commitment: CandidateCommitmentLike): string =>
  `confirm: ${flattenOne(commitment.statement)} is a commitment the ${commitment.actor} ` +
  `recorded and nothing says it is done.`

/** The title. The statement itself, which is already one sentence; `mintDetectedTask` cuts it to 90. */
const commitmentTitle = (commitment: CandidateCommitmentLike): string =>
  `Commitment: ${flattenOne(commitment.statement)}`

/** Whitespace collapsed and one trailing sentence period dropped, so the claim reads as one clause. */
const flattenOne = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")

/** The session a commitment cites, trimmed. The value the batch check and the key both read. */
const commitmentSession = (commitment: CandidateCommitmentLike): string =>
  commitment.evidence.sessionId.trim()

/**
 * The commit body for a batch of commitment tasks: one `commitment <session>: <quote>` line each.
 *
 * This is where a commitment's verbatim quote is allowed to go and nowhere else, the same rule
 * {@link commitContextFor} states for a candidate's evidence. A reviewer deciding whether a proposed
 * task is real needs the line it was read from, and a commit message is not part of the corpus: not
 * indexed, not chunked, not embedded, not retrievable. `commitPhase` indents the body, which is the
 * trailer-injection guard, and it matters here for the same reason it matters there — the text is a
 * model's, read out of a transcript nobody wrote for this system.
 */
const commitmentContext = (
  minted: ReadonlyArray<CandidateCommitmentLike>,
  closed: ReadonlyArray<string>
): string =>
  [
    ...minted
      .slice(0, COMMIT_EVIDENCE_LIMIT)
      .map(
        (one) =>
          `commitment ${commitmentSession(one)}: ` +
          `${one.evidence.quote.replace(/\s+/g, " ").slice(0, COMMIT_QUOTE_CHARS)}`
      ),
    ...closed.map((path) => `closed ${path}: completion detected`)
  ].join("\n")

/** What the commitment pass did, as the counts and the commit need it. */
interface CommitmentOutcome {
  /** Commitments the answer carried, before any filter. */
  readonly commitments: number
  /** Tasks newly minted. A refresh is not one; see {@link mintDetectedTask}. */
  readonly commitmentTasks: number
  /** Resolved commitments that closed an open detected task. */
  readonly completionsApplied: number
  /**
   * Resolved commitments that closed nothing: below the floor, refused by the filter, or matching no
   * open detected task.
   *
   * Counted rather than dropped, because it is the operator-visible reading of the arm working at all.
   * A night whose every completion is unmatched is a night where the keying is wrong — the model
   * reworded the statement, or the task was already closed by hand — and that is invisible unless the
   * number is reported. The issue asks for exactly this count.
   */
  readonly completionsUnmatched: number
  /** Refused by the deterministic filter: a non-first-person actor, an empty field. */
  readonly commitmentsSkipped: number
  /** Above the filter and below {@link COMMITMENT_FLOOR}. */
  readonly commitmentsBelowFloor: number
  /** Tasks a second reading refreshed rather than duplicated. */
  readonly commitmentsRefreshed: number
  /**
   * Commitments `mintDetectedTask`'s frame-key proximity check turned away: an open task already
   * occupies the claim's slot.
   *
   * Counted rather than dropped, so `commitments` arithmetic SUMS. Without it a framed commitment left
   * no trace anywhere — it was neither a task, nor a refresh, nor a skip, nor below the floor, nor
   * capped — and the honest reading of a night's numbers requires that every commitment the answer
   * carried is accounted for by exactly one counter.
   *
   * It is expected to be near-zero and a nonzero value is a real signal: it means another DETECTOR
   * already opened a task about this same work item, which is the collision the check exists to find.
   */
  readonly commitmentsFramed: number
  /**
   * Commitments declined because a HUMAN already closed the task this key owns: a standing dismissal.
   *
   * Counted for the same reason `commitmentsFramed` is — every commitment the answer carried lands in
   * exactly one counter — and because the number answers a real question. A commitment an agent keeps
   * restating that a human keeps having closed is a disagreement about whether the work is wanted, and
   * that is visible only if the declined mints are reported. See `tasks.ts`'s module header.
   */
  readonly commitmentsDismissed: number
  /**
   * Commitments the nightly volume cap turned away, measured as THIS PASS's DELTA on the shared
   * budget's overflow.
   *
   * A delta rather than `budget.overflow` outright, and the difference is not cosmetic. The budget is
   * shared across every detector (`DETECTED_TASK_CAP` records why: the number a human can review is a
   * property of the human, not of how many detectors ran), so by the time this phase runs the counter
   * may already carry entity-resolution's and dedup's overflow. Reporting it raw would attribute their
   * turned-away findings to this phase's commitments — a number an operator would read as "the
   * commitment detector is too noisy" about a night where it minted everything it found.
   *
   * The reading a delta gives is the one that answers a question: how many commitments this night saw
   * did not fit. That the cap was already full when they arrived is real and is what the SHARED budget
   * means; whose findings filled it is a different question, answered by the other phases' own counts.
   */
  readonly commitmentsCapped: number
  /** True when anything was staged, so the caller knows whether to commit. */
  readonly staged: boolean
  /** The tasks whose quotes go in the commit body, and the paths closed. */
  readonly mintedCommitments: ReadonlyArray<CandidateCommitmentLike>
  readonly closedPaths: ReadonlyArray<string>
}

/** Every count at zero, so a phase that ran no commitment pass still reports the shape. */
const ZERO_COMMITMENTS: CommitmentOutcome = {
  commitments: 0,
  commitmentTasks: 0,
  completionsApplied: 0,
  completionsUnmatched: 0,
  commitmentsSkipped: 0,
  commitmentsBelowFloor: 0,
  commitmentsRefreshed: 0,
  commitmentsFramed: 0,
  commitmentsDismissed: 0,
  commitmentsCapped: 0,
  staged: false,
  mintedCommitments: [],
  closedPaths: []
}

/**
 * The whole commitment pass: filter, then close what resolved and mint what did not.
 *
 * **Closures run BEFORE mints, and the order is load-bearing.** A resolved commitment and an unresolved
 * one can key the same when a model reports both readings of one sentence, and closing first means the
 * task leaves the open queue before the mint arm looks at it — so the mint opens a fresh task for a
 * commitment the same answer says is done, which reads as churn. Running mints first would instead
 * REFRESH the task and then immediately close it, which is worse: the queue loses a task in the same
 * commit that touched it, and the refresh's `memhtml-updated` stamp says a human was shown something
 * that was archived before they could look. Ordering closures first makes a same-answer contradiction
 * resolve to "closed", which is the reading that costs a reviewer nothing.
 *
 * **Only sessions in the BATCH.** The client already refuses a turn citing a session it did not make
 * readable (`ungroundedCommitmentReason`), and this narrows the same way `analyzedFrom` narrows the
 * watermark set: an id outside the batch this phase asked about is a bug in the consolidator, and it
 * must not become a task file whose provenance names a session nobody selected. Cheap, so unconditional.
 *
 * **The budget is the run's shared one**, taken once here and threaded, per `budgetFor`'s contract.
 * Overflow lands in `budget.overflow`, which the caller reports as `capped` alongside every other
 * detector's.
 */
const consolidateCommitments = (
  env: PhaseEnv,
  commitments: ReadonlyArray<CandidateCommitmentLike>,
  batchSessionIds: ReadonlySet<string>
): Effect.Effect<CommitmentOutcome, SleepError> =>
  Effect.gen(function* () {
    if (commitments.length === 0) return ZERO_COMMITMENTS

    let skipped = 0
    let belowFloor = 0
    /** Resolved commitments the floor turned away: completions this night declined to apply. */
    let belowFloorCompletions = 0
    const admissible: Array<CandidateCommitmentLike> = []
    for (const [offset, commitment] of commitments.entries()) {
      const refusal = commitmentRefusalFor(commitment)
      if (refusal !== null) {
        yield* Effect.logWarning(
          `sleep.trace-consolidation commitment ${offset} skipped: ${refusal}`
        )
        skipped += 1
        continue
      }
      if (!batchSessionIds.has(commitmentSession(commitment))) {
        yield* Effect.logWarning(
          `sleep.trace-consolidation commitment ${offset} skipped: session ` +
            `${commitmentSession(commitment)} is not in this run's batch`
        )
        skipped += 1
        continue
      }
      if (commitment.confidence < COMMITMENT_FLOOR) {
        belowFloor += 1
        /**
         * A resolved commitment below the floor is the issue's "left for review" case, so it is counted
         * as an unapplied completion HERE rather than inferred later by subtraction.
         *
         * Only the ones that reached the floor. A commitment the filter refused above — a third party's,
         * or one naming a session outside the batch — is not a completion this store declined to apply;
         * it was never a first-person commitment at all, and counting it as an unmatched completion would
         * report the same finding under two counters and make `completionsUnmatched` read as a keying
         * problem on a night whose only fault was a mislabelled actor.
         */
        if (commitment.resolved) belowFloorCompletions += 1
        continue
      }
      admissible.push(commitment)
    }

    /**
     * The closure arm. The open queue is read ONCE for the whole batch and then narrowed in memory:
     * `openDetections` is a `readdir` plus a parse per file, and asking it per resolved commitment
     * would be the round-trip-per-row shape every batch read in this package exists to avoid.
     */
    const resolved = admissible.filter((commitment) => commitment.resolved)
    const closedPaths: Array<string> = []
    let unmatched = 0
    if (resolved.length > 0) {
      const open = yield* openDetections(env)
      const byKey = new Map(open.map((detected) => [detected.key, detected] as const))
      for (const commitment of resolved) {
        const match = byKey.get(commitmentKey(commitment))
        if (match === undefined) {
          unmatched += 1
          continue
        }
        /**
         * `closeDetectedTask` re-checks the path, which is redundant with `openDetections` only
         * returning detected paths and is kept for the reason that function's own note gives: the guard
         * belongs at the write, not at the lookup. A `false` here means the file vanished between the
         * read and the write, so it is counted as unmatched rather than as a closure.
         */
        if (yield* closeDetectedTask(env, match.path)) closedPaths.push(match.path)
        else unmatched += 1
        byKey.delete(match.key)
      }
    }
    /**
     * The completions the floor turned away, added to the ones that matched nothing.
     *
     * ADDED rather than derived by subtracting `resolved.length` from the resolved commitments in the
     * whole answer, which is what an earlier version did and got wrong: that difference also swept in
     * every resolved commitment the FILTER refused, so a night whose only fault was a third party's
     * completion reported an unmatched completion and pointed an operator at the keying.
     */
    unmatched += belowFloorCompletions

    const budget = budgetFor(env)
    /** The shared counter BEFORE this pass, so `commitmentsCapped` is this pass's own delta. */
    const overflowBefore = budget.overflow
    const minted: Array<CandidateCommitmentLike> = []
    let refreshed = 0
    let framed = 0
    let dismissed = 0
    for (const commitment of admissible) {
      if (commitment.resolved) continue
      const outcome = yield* mintDetectedTask(env, budget, {
        detector: COMMITMENT_DETECTOR,
        /**
         * The statement alone, matching {@link commitmentKey} exactly. `mintDetectedTask` re-derives the
         * digest from `detector` + `finding`, so a `finding` that disagreed with the key this phase
         * matches closures against would mint under one path and look for another — the arms would
         * silently never meet. One expression rather than two is what keeps them the same key.
         */
        finding: commitment.statement,
        title: commitmentTitle(commitment),
        claim: commitmentClaim(commitment),
        detail:
          `Recorded in a consolidated session at confidence ` +
          `${commitment.confidence.toFixed(2)} and never stated as done. Confirm it is still ` +
          `wanted, or close it.`,
        evidence: {
          kind: "session",
          sessionId: commitmentSession(commitment),
          statement: commitment.statement
        },
        ...(typeof commitment.dueHint === "string" ? { dueHint: commitment.dueHint } : {})
      })
      if (outcome === "minted") minted.push(commitment)
      else if (outcome === "refreshed") refreshed += 1
      else if (outcome === "framed") framed += 1
      else if (outcome === "dismissed") dismissed += 1
    }

    return {
      commitments: commitments.length,
      commitmentTasks: minted.length,
      completionsApplied: closedPaths.length,
      completionsUnmatched: unmatched,
      commitmentsSkipped: skipped,
      commitmentsBelowFloor: belowFloor,
      commitmentsRefreshed: refreshed,
      commitmentsFramed: framed,
      commitmentsDismissed: dismissed,
      commitmentsCapped: budget.overflow - overflowBefore,
      staged: minted.length > 0 || refreshed > 0 || closedPaths.length > 0,
      mintedCommitments: minted,
      closedPaths
    }
  })

/**
 * A candidate's entities as the `type:name` references a `memhtml-entity` meta carries.
 *
 * The join is the whole translation between the agent's answer and the corpus: `CandidateEntity`
 * (`apps/consolidator/src/contract.ts`) states the two halves separately so a model cannot omit the
 * type, and the corpus keys on `(entity_type, entity_name)` reassembled as one reference by the
 * `entity` scope. Both halves are trimmed, because a padded half survives `parseEntity` — the split is
 * on the first colon, so `service :sqlite` files under the type `"service "` and no reference a caller
 * spells reaches it.
 *
 * A pair with either half empty after the trim is DROPPED rather than filed, which is the same
 * redundancy every model-facing gate in this package carries: the schema already refuses an empty half,
 * and a scripted or future consolidator that skipped the schema still cannot write `:name` or
 * `service:` — references whose one meaningful half is unreachable through a scope that compares the
 * whole string.
 *
 * One function, called by the write and by {@link placementDirectory}, so the file's metas and the
 * directory it lands in are derived from the same references. `placementFor` routes on `person:`, and
 * two independent joins could put a person memory outside `resources/people/`.
 */
const entityRefsFor = (candidate: CandidateMemoryLike): ReadonlyArray<string> =>
  candidate.entities.flatMap((entity) => {
    const type = entity.type.trim()
    const name = entity.name.trim()
    return type === "" || name === "" ? [] : [`${type}${ENTITY_SEPARATOR}${name}`]
  })

/**
 * A candidate the phase will write, or `null` with the reason it was refused.
 *
 * The gate is deterministic and sits between the agent and the tree, which is where every
 * model-supplied value in this package is checked. Three refusals, each a real failure mode:
 *
 * - **`kind` outside the writable vocabulary.** The consolidator's schema already narrows to six
 *   corpus types and proves it at compile time (`apps/consolidator/src/contract.ts:44-45`), but this
 *   phase writes through `renderTemplate` into a `files.memory_type` CHECK constraint, and a value
 *   that reached it unchecked would fail the whole commit instead of skipping one candidate. Checked
 *   against `@memhtml/contracts`' own list, so the two cannot drift.
 * - **An empty claim or gist.** A memory with no claim has nothing to disclose at Tier 1 and a
 *   `<mark>` holding whitespace is a file the parser accepts and no search can find.
 * - **Fewer than two evidence quotes.** The TRACE-2 bar as this phase can check it: a pattern across
 *   lines or sessions has at least two lines behind it, and a candidate citing one is a restatement
 *   of that line. The consolidator's schema enforces the same minimum, and the redundancy is
 *   deliberate, so a scripted or future consolidator that skipped it would still not get past here.
 * - **A claim that slugs to nothing.** `slugify` folds to `[a-z0-9-]`, so a claim written entirely
 *   in CJK, Cyrillic, or punctuation reduces to `SLUG_FALLBACK`, and every such candidate files under
 *   one stem even across unrelated subjects and sessions. Under the disk-authoritative
 *   {@link freePath} that is no longer an overwrite, but it is `untitled.html`, `untitled-2.html`,
 *   `untitled-3.html`: a path is the id in this corpus, and an id carrying no subject is not one a
 *   reviewer or a later correction can address. The consolidator writes English prose, so this gates
 *   a value it should not send instead of filtering ordinary output.
 */
const refusalFor = (candidate: CandidateMemoryLike): string | null => {
  if (!(WRITABLE_MEMORY_TYPES as ReadonlyArray<string>).includes(candidate.kind)) {
    return `kind ${candidate.kind} is not a writable memory type`
  }
  if (candidate.claim.trim() === "") return "empty claim"
  if (candidate.gist.trim() === "") return "empty gist"
  if (candidate.evidence.length < 2) return "fewer than two evidence quotes"
  if (slugify(titleFor(candidate.claim)) === SLUG_FALLBACK) return "claim slugs to no title"
  return null
}

/**
 * A title for a candidate, from its claim.
 *
 * Derived here instead of asked for, the same decision `arc-synthesis` makes about a slug. A
 * model-chosen title becomes a model-chosen FILE PATH through `slugify`, which is a traversal surface
 * and a collision surface at once. The claim is a sentence, so the title is its leading clause with
 * sentence punctuation dropped, enough to read in `ls` and in a commit subject.
 */
const titleFor = (claim: string): string => {
  const flat = claim.replace(/\s+/g, " ").trim()
  const firstSentence = /^(.*?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat
  return firstSentence
    .replace(/[.!?]+$/, "")
    .slice(0, 90)
    .trim()
}

/**
 * The commit message context for one candidate: its evidence, capped, and its frame conflict if any.
 *
 * This is where evidence quotes are allowed to go, and nowhere else. A reviewer deciding whether a
 * distilled claim earns its place needs the lines it was read from, and a commit message is not part
 * of the corpus: it is not indexed, not chunked, not embedded, and not retrievable. The memory body
 * carries the claim; the commit carries the receipt.
 */
const commitContextFor = (
  candidate: CandidateMemoryLike,
  conflict: { readonly path: string; readonly gist: string } | undefined
): string =>
  [
    ...candidate.evidence
      .slice(0, COMMIT_EVIDENCE_LIMIT)
      .map(
        (one) =>
          `evidence ${one.sessionId}: ${one.quote.replace(/\s+/g, " ").slice(0, COMMIT_QUOTE_CHARS)}`
      ),
    ...(conflict === undefined ? [] : [`frame conflict with ${conflict.path}: ${conflict.gist}`])
  ].join("\n")

/**
 * Frame-key conflicts for a whole batch of candidates, as a map from candidate offset to the live
 * claim already occupying that slot.
 *
 * **ONE query for the batch.** `activeFramesFor` takes an array precisely so a caller cannot loop
 * (`packages/index/src/traces-persist.ts:105-113`), and a per-candidate lookup against a
 * corpus-sized table is the quadratic-write-cost shape this codebase has already paid for once.
 *
 * **A lookup failure degrades to no conflicts.** The assist is a note ABOUT the writes, so losing the
 * night's memories over a failed note about them would invert the priority. This is the same
 * `Effect.catch` → `logWarning` → neutral-value shape `apps/cli/src/operations.ts:440-446` uses for
 * the write-path assist, and for the same reason.
 */
const frameConflicts = (
  env: PhaseEnv,
  candidates: ReadonlyArray<CandidateMemoryLike>
): Effect.Effect<ReadonlyMap<number, { readonly path: string; readonly gist: string }>> =>
  Effect.gen(function* () {
    const keyed: Array<{ readonly offset: number; readonly key: string }> = []
    for (const [offset, candidate] of candidates.entries()) {
      const key = frameKeyOf(candidate.claim)
      if (key !== null) keyed.push({ offset, key })
    }
    if (keyed.length === 0) return new Map()

    const live = yield* makeIndexRecorder(env.deps.db)
      .activeFramesFor(keyed.map((entry) => entry.key))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `sleep.trace-consolidation conflict lookup skipped: ${error.operation}`
          ).pipe(
            Effect.as(
              new Map<string, ReadonlyArray<{ readonly path: string; readonly gist: string }>>()
            )
          )
        )
      )

    const conflicts = new Map<number, { readonly path: string; readonly gist: string }>()
    for (const entry of keyed) {
      const [stored] = live.get(entry.key) ?? []
      if (stored !== undefined) conflicts.set(entry.offset, stored)
    }
    return conflicts
  })

export const traceConsolidation: PhaseBody = (env) =>
  Effect.gen(function* () {
    /**
     * The v1 counters survive, and they still do work. The count of sessions with no memory
     * linked to them is the one number that says whether the agent is writing memories at all, and
     * that question is separate from whether this phase has read a transcript. A session can be
     * consolidated and still hold no agent-written memory, which is exactly the gap this phase fills.
     */
    const unlinked = yield* unlinkedSessionCount(env.deps.db)
    const linked = yield* linkedSessionCount(env.deps.db)
    const base = { sessions: unlinked + linked, linked, unlinked }

    const consolidator = env.deps.consolidator
    if (consolidator === undefined) {
      return {
        ...emptyOutcome({ ...base, ...ZERO_COUNTS }),
        detail: "no consolidator bound"
      }
    }

    /**
     * The cutoff carries its MILLISECONDS, and dropping them opens a hole rather than rounding.
     *
     * `traces.file_mtime` holds `new Date(mtimeMs).toISOString()`
     * (`packages/index/src/traces-persist.ts:446`), 24 characters with a `.mmm` fraction, and
     * `unconsolidatedSessions` compares it as TEXT (`sql.ts:449`). A 20-character cutoff
     * (`…:00Z`) therefore loses to every sub-second suffix: `'.' (0x2E) < 'Z' (0x5A)`, so
     * `…:00.500Z` sorts BELOW `…:00Z` and a session modified half a second INSIDE the quiet
     * window is admitted as settled. Same length on both sides is what makes the comparison mean
     * what the window says.
     */
    const settledBefore = new Date(Math.max(0, env.atMillis - TRACE_QUIET_MILLIS)).toISOString()
    const batch = yield* unconsolidatedSessions(env.deps.db, {
      minBytes: TRACE_MIN_BYTES,
      settledBefore,
      limit: TRACE_SESSIONS_PER_RUN
    })
    if (batch.length === 0) {
      return emptyOutcome({ ...base, ...ZERO_COUNTS })
    }

    /**
     * A dry run stops HERE, having done the whole deterministic half: the batch is real and counted,
     * and the model call is what does not happen. It stops before the call rather than after it,
     * because a dry run that spent Opus tokens to then discard the answer would be the most
     * expensive way to count.
     */
    if (env.dryRun) {
      return emptyOutcome({ ...base, ...ZERO_COUNTS, batch: batch.length })
    }

    /**
     * The whole consolidator call in isolation. A failure is a VALUE here and not a phase
     * failure, and the `_tag` rides into the detail so an operator can tell a missing credential
     * from an unreachable agent from an off-contract answer without reading the log.
     *
     * `Effect.result` instead of a `catch` that returns a neutral value, because the two outcomes
     * need different report lines. "The agent found nothing" and "the agent could not be asked" are
     * both `consolidated: 0`, and an operator has to be able to distinguish them.
     */
    /**
     * The manifest is generated HERE, from the plane, and handed over as the batch's description.
     *
     * A generated manifest and not a bare file list, because the metadata a consolidation needs is
     * not in a transcript's bytes: which project a session ran under, how long it lasted, and the one
     * worth a join, which memories the corpus already links to it, since a pattern already
     * written down is not the new signal the bar asks for. `sessionManifestRows` is the query.
     *
     * **A manifest lookup failure degrades to the bare batch instead of failing the phase.** The
     * manifest sharpens the ask; the transcripts are the ask. Same posture `frameConflicts` takes for
     * the same reason, since losing the night's memories over a failed note about them inverts the
     * priority. The fallback is still a complete `{sessionId, filePath}` per session, so a
     * degraded run reads the same transcripts with less context instead of reading fewer.
     */
    const manifest = yield* manifestFor(env, batch)

    const outcome = yield* Effect.result(consolidator.consolidate({ transcripts: manifest }))
    if (Result.isFailure(outcome)) {
      const failure = outcome.failure
      yield* Effect.logWarning(
        `sleep.trace-consolidation degraded: ${failure._tag}: ${failure.reason}`
      )
      return {
        ...emptyOutcome({ ...base, ...ZERO_COUNTS, batch: batch.length }),
        detail: `consolidator unavailable: ${failure._tag}`
      }
    }

    const candidates = outcome.success.candidates
    const llmCalls = outcome.success.llmCalls

    /**
     * The watermark, recorded as a PENDING MARK on the branch and applied by `merge`. It covers exactly
     * the sessions the agent ACTUALLY READ; {@link analyzedFrom} is that set, and it is not `batch`.
     *
     * ## Only a session whose transcript arrived
     *
     * `batch` is the set the phase ASKED ABOUT, and the two differ whenever a transcript does not reach
     * the agent: rotated away since `memhtml trace index` ran, moved outside `MEMHTML_TRACE_ROOT`, or
     * behind a symlink the read-only mount will not follow (measured; see `partitionReachable` in
     * `apps/consolidator/src/client.ts`). Marking such a session records it consolidated when nothing
     * read it, and `trace_consolidations` is an ANTI-JOIN, so the session is then never selected again.
     *
     * **The guard is structural, not a check placed here.** `ConsolidationOutcome` cannot be constructed
     * without `analyzedSessionIds` (`../consolidator.ts`), so no shape a consolidator returns leaves this
     * phase with only the batch to fall back on. A `?? batch` default, or an optional field, would have
     * reintroduced that.
     *
     * {@link analyzedFrom} then INTERSECTS with the batch, so the outcome's set can only ever narrow what
     * is marked and never widen it. A consolidator naming a session nobody asked about is a bug in the
     * consolidator; it must not become a watermark on an unread session.
     *
     * ## Still the whole READ batch, including the barren ones
     *
     * A session that yielded no candidate HAS been consolidated: the agent read it and correctly found
     * nothing above the bar. Marking only the productive sessions would re-read every quiet transcript at
     * full Opus cost every night forever, and the batch would never advance past them. So the narrowing
     * is by REACHABILITY and never by productivity.
     *
     * ## Recorded FIRST, and safe because it is only a proposal
     *
     * The mark is written and staged before the candidate loop, so the first candidate's commit carries
     * the ledger and a night that distils two memories still lands two commits. Nothing rides on the
     * ORDER any more, which is the property the merge-time application buys: a process killed anywhere in
     * this phase leaves a branch nobody merged, so the marks are never applied and the batch is re-read.
     * A run whose ledger commits and whose candidates then fail is the same case — the branch is
     * discarded or resumed, and either way no session is recorded read on the strength of nothing.
     */
    const analyzed = analyzedFrom(batch, outcome.success.analyzedSessionIds)
    const pendingRecorded = yield* recordPendingMarks(
      env.deps.git.root,
      env.runId,
      analyzed.map((sessionId) => ({
        kind: "session-consolidated" as const,
        sessionId,
        runId: env.runId,
        at: env.at
      }))
    )
    if (pendingRecorded) yield* env.deps.git.add([pendingMarksPath(env.runId)])

    const conflicts = yield* frameConflicts(env, candidates)

    let written = 0
    let skipped = 0
    let conflicted = 0
    let lastCommit: string | null = null
    /** Paths this phase has already claimed in THIS run, so two candidates cannot collide on one. */
    const claimed = new Set<string>()

    for (const [offset, candidate] of candidates.entries()) {
      const refusal = refusalFor(candidate)
      if (refusal !== null) {
        yield* Effect.logWarning(
          `sleep.trace-consolidation candidate ${offset} skipped: ${refusal}`
        )
        skipped += 1
        continue
      }

      const title = titleFor(candidate.claim)
      /**
       * No free path is a REFUSAL, taking the same skip-and-count path a bad candidate takes. A
       * thousand collisions on one stem is a corpus problem an operator should see in the counts.
       * The alternative, one fixed overflow path, is the overwrite this probe exists to
       * prevent, made unconditional.
       */
      const path = yield* freePath(env, candidate, title, claimed)
      if (path === undefined) {
        yield* Effect.logWarning(
          `sleep.trace-consolidation candidate ${offset} skipped: no free path under ` +
            `${placementDirectory(candidate)} for ${slugify(title)}`
        )
        skipped += 1
        continue
      }
      claimed.add(path)

      /**
       * A frame conflict does NOT suppress the write, and that is INV-1 and not an oversight. The
       * assist proposes and does not block, because sometimes the contradiction IS the answer. A
       * distilled claim that a runbook step changed necessarily contradicts the memory stating the old
       * step, and a phase that declined to write it would keep the corpus tidy by never recording the
       * change.
       *
       * Nor does the conflict become an authored `<link>`, and the reason is mechanical. Any authored
       * edge between two paths permanently closes that pair to edge typing's scans: `derived = 0` is
       * the anti-join in BOTH `sharedEntityPairs` and `minedPairs`, so stamping one here would silence
       * the very disagreement this lookup surfaced. The conflict lives in the counts, in the
       * `Memhtml-Counts` trailer, and in the commit message's context, where a reviewer sees it at merge
       * review and decides.
       */
      const conflict = conflicts.get(offset)
      if (conflict !== undefined) conflicted += 1

      yield* writeFileBytes(
        env,
        path,
        renderTemplate({
          title,
          claim: candidate.claim.trim(),
          /**
           * The candidate's supporting detail becomes the body, and its evidence quotes do not. Those
           * are transcript spans, and copying one into an article would put session content in the
           * corpus. The distilled prose is what the agent earned; the quotes are how it proves it,
           * and proof belongs in the commit.
           */
          body: [candidate.gist.trim()],
          memoryType: candidate.kind as (typeof WRITABLE_MEMORY_TYPES)[number],
          at: env.at,
          author: "agent:sleep",
          entities: entityRefsFor(candidate),
          tags: [CONSOLIDATION_TAG]
        })
      )
      yield* env.deps.git.add([path])

      const counts = {
        ...base,
        batch: batch.length,
        candidates: candidates.length,
        written: written + 1,
        skipped,
        conflicts: conflicted
      }
      const commitSha = yield* commitPhase(
        env,
        "trace-consolidation",
        `${conflict === undefined ? "distill" : "distill (frame conflict)"} ${title}`,
        counts,
        commitContextFor(candidate, conflict)
      )
      if (commitSha !== null) lastCommit = commitSha
      written += 1
    }

    /**
     * Surface 2, AFTER every candidate commit.
     *
     * After the candidates, so a commitment task cannot ride into a `distill …` commit and confuse what
     * that commit decided; each half of the answer gets its own reviewable commit.
     *
     * The batch is the grounding set, `analyzedFrom` is not. A commitment cites a session whose
     * TRANSCRIPT was read, and `analyzedSessionIds` is the reachable set the CLIENT computed — which is
     * the right input for a watermark and the wrong one for this check, since a scripted or degraded
     * consolidator could report a narrower reachable set while still having read the sessions it quotes.
     * The batch is what this phase asked about, and it is the containment the phase can assert.
     */
    const commitments = yield* consolidateCommitments(
      env,
      outcome.success.commitments,
      new Set(batch.map((session) => session.session_id))
    )
    if (commitments.staged) {
      const commitSha = yield* commitPhase(
        env,
        "trace-consolidation",
        `detect ${String(commitments.commitmentTasks)} commitments, ` +
          `close ${String(commitments.completionsApplied)} completed`,
        { ...base, batch: batch.length, ...commitmentCounts(commitments) },
        commitmentContext(commitments.mintedCommitments, commitments.closedPaths)
      )
      if (commitSha !== null) lastCommit = commitSha
    }

    /**
     * `consolidated` is the ANALYZED count and `batch` the requested one, so the two disagreeing in a
     * report is the operator-visible signal that transcripts went missing. A mark over the batch would
     * make the two equal by construction and leave that state with no reading at all.
     */
    const unreachable = batch.length - analyzed.length
    if (unreachable > 0) {
      yield* Effect.logWarning(
        `sleep.trace-consolidation asked about ${String(batch.length)} sessions and ` +
          `${String(unreachable)} did not reach the agent; those stay unconsolidated for the next run`
      )
    }

    const counts = {
      ...base,
      batch: batch.length,
      candidates: candidates.length,
      written,
      skipped,
      conflicts: conflicted,
      consolidated: analyzed.length,
      unreachable,
      ...commitmentCounts(commitments)
    }

    /**
     * A night that read transcripts and distilled nothing from them still has to COMMIT its ledger, so
     * it gets a commit of its own.
     *
     * That night is the ordinary one, not an edge case: the bar in `agent/instructions.md` refuses a
     * candidate that restates one line, so a batch of quiet sessions correctly yields nothing. The marks
     * are what advance the batch past those sessions, and a ledger left staged and uncommitted would
     * either be swept into the NEXT phase's commit or discarded with the index — so the reading would
     * either be wrong or absent. A commit whenever `lastCommit` is still null covers both, and adds no
     * second commit to a night that already committed a candidate, because that commit carried the
     * ledger with it.
     */
    if (pendingRecorded && lastCommit === null) {
      lastCommit = yield* commitPhase(
        env,
        "trace-consolidation",
        `record ${String(analyzed.length)} consolidated sessions pending review`,
        counts
      )
    }

    return { counts, commitSha: lastCommit, llmCalls }
  })

/**
 * The commitment half of the counts, from the pass's outcome.
 *
 * One function, called by both the phase's return and the commitment commit's trailer, so a reader
 * comparing the `Memhtml-Counts` trailer against the report sees the same keys with the same meanings.
 * `capped` is the SHARED budget's overflow — every detector's, not this one's, per `DETECTED_TASK_CAP`'s
 * note — so it is read off the budget rather than counted here.
 */
const commitmentCounts = (outcome: CommitmentOutcome): Record<string, number> => ({
  commitments: outcome.commitments,
  commitmentTasks: outcome.commitmentTasks,
  completionsApplied: outcome.completionsApplied,
  completionsUnmatched: outcome.completionsUnmatched,
  commitmentsSkipped: outcome.commitmentsSkipped,
  commitmentsBelowFloor: outcome.commitmentsBelowFloor,
  commitmentsRefreshed: outcome.commitmentsRefreshed,
  commitmentsFramed: outcome.commitmentsFramed,
  commitmentsDismissed: outcome.commitmentsDismissed,
  commitmentsCapped: outcome.commitmentsCapped
})

/**
 * The full count SHAPE, at zero, for every path that returns before the model answer.
 *
 * Every key the phase can report is present on every path, because a report reader comparing two nights
 * reads a missing key as a phase that does not have the concept rather than as a night that did none of
 * it. Same rule `task-detection`'s `ZERO` and `edge-typing`'s `zero` state. `base` is spread beside it
 * because those three counters are real on every path, including a dry run.
 */
const ZERO_COUNTS = {
  batch: 0,
  candidates: 0,
  written: 0,
  skipped: 0,
  conflicts: 0,
  consolidated: 0,
  unreachable: 0,
  ...commitmentCounts(ZERO_COMMITMENTS)
}

/**
 * The sessions to watermark: those the agent reported analyzing, INTERSECTED with the batch.
 *
 * The intersection is the containment half of the invariant and it is cheap, so it is unconditional. A
 * consolidator is an injected collaborator, the real one an eve agent over HTTP and a scripted one in
 * tests, and `analyzedSessionIds` is a value it computes. Trusting it as the watermark set directly
 * would make "which sessions are marked read forever" a claim the agent gets to make about sessions
 * nobody asked about. Intersecting lets the outcome NARROW the batch and not widen it,
 * which is the only authority it needs.
 *
 * Batch order is preserved instead of the outcome's, so the watermark writes newest-first exactly as
 * the selection read. That ordering makes a report line and a test's `toEqual` reproducible.
 */
const analyzedFrom = (
  batch: ReadonlyArray<{ readonly session_id: string }>,
  analyzedSessionIds: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const analyzed = new Set(analyzedSessionIds)
  return batch.map((session) => session.session_id).filter((id) => analyzed.has(id))
}

/**
 * The batch as manifest entries, joined to the memories already linked to each session.
 *
 * **One query for the batch, and a `Map` for the grouping.** `sessionManifestRows` returns one row per
 * link, so a session with three linked memories is three rows and one with none is a single row carrying
 * `memory_path: null`, and this folds them. A per-session query would be the round-trip-per-row shape
 * this package's other batch reads exist to avoid, and a `group_concat` would put a corpus path inside
 * a delimited string that a `,` in a path would then split.
 *
 * **A lookup failure degrades to the bare refs.** Same shape and same reason as `frameConflicts`: the
 * manifest's extra fields sharpen the ask, and losing the night's transcripts over a failed enrichment
 * of them would invert the priority. Every session still arrives with the `sessionId` and `filePath`
 * that make it readable.
 *
 * A session in the batch with NO manifest row also falls back to its bare ref instead of being
 * dropped. That gap is possible, since `unconsolidatedSessions` and this lookup are two statements, and
 * a session silently missing from the handover would be one the phase decided not to read while counting
 * it in `batch`. The reachability check downstream is what decides whether a transcript is readable;
 * this function's job is not to make that decision by omission.
 */
const manifestFor = (
  env: PhaseEnv,
  batch: ReadonlyArray<{
    readonly session_id: string
    readonly file_path: string
  }>
): Effect.Effect<ReadonlyArray<TranscriptManifestEntry>> =>
  Effect.gen(function* () {
    const rows = yield* sessionManifestRows(
      env.deps.db,
      batch.map((session) => session.session_id)
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `sleep.trace-consolidation manifest lookup skipped: ${error.operation}`
        ).pipe(Effect.as<ReadonlyArray<SessionManifestRow>>([]))
      )
    )

    const bySession = new Map<string, SessionManifestRow[]>()
    for (const row of rows) {
      const existing = bySession.get(row.session_id)
      if (existing === undefined) bySession.set(row.session_id, [row])
      else existing.push(row)
    }

    return batch.map((session) => {
      const rowsFor = bySession.get(session.session_id)
      const head = rowsFor?.[0]
      if (head === undefined) {
        return { sessionId: session.session_id, filePath: session.file_path }
      }
      return {
        sessionId: session.session_id,
        /**
         * The path comes from the SELECTION's row and not the manifest join's, so the file handed
         * over is the file selected. The two read the same column of the same table, which is exactly
         * why the tie is broken deliberately: if they ever disagree, the selected path is the one the
         * byte floor and the quiet window were evaluated against.
         */
        filePath: session.file_path,
        slug: head.slug,
        ...optional({
          cwd: head.cwd,
          gitBranch: head.git_branch,
          startedAt: head.started_at,
          endedAt: head.ended_at
        }),
        fileMtime: head.file_mtime,
        fileSize: head.file_size,
        promptCount: head.prompt_count,
        turnCount: head.turn_count,
        /**
         * `[]` for a session with no linked memory, which is a real and meaningful value here: the
         * corpus holds nothing for a session whose findings were never written down. It is distinct
         * from the absent field a failed lookup leaves behind.
         */
        linkedMemories: (rowsFor ?? [])
          .filter(
            (row): row is SessionManifestRow & { memory_path: string; link_kind: string } =>
              row.memory_path !== null && row.link_kind !== null
          )
          .map((row) => ({ path: row.memory_path, linkKind: row.link_kind }))
      }
    })
  })

/** Drop the `null`s the nullable `traces` columns carry, so an absent value is an absent key. */
const optional = (fields: Record<string, string | null>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(fields).filter((pair): pair is [string, string] => pair[1] !== null)
  )

/** Collision ordinals tried before a candidate is refused. The store's own ceiling, verbatim. */
const PATH_ORDINAL_LIMIT = 1000

/**
 * A path for a candidate that holds no file and has not been claimed in this run, or `undefined`
 * when the ordinals are exhausted.
 *
 * The placement is `@memhtml/contracts`' own, via the same `memoryType`/`entities`/`tags` inputs an
 * agent's write supplies, so a consolidated memory sits where a hand-written one about the same
 * subject would. Nothing about it is filed under a "consolidated" directory: a distilled memory is an
 * ordinary memory, and a parallel tree would be a second place to look for one fact.
 *
 * **DISK IS AUTHORITATIVE, and `claimed` is only the half disk cannot answer.** A path is taken if
 * EITHER source says so, the same rule `store.freePathFor` (`packages/store/src/store.ts:352-373`)
 * states, and this is the reading an earlier version of this function had backwards. It probed
 * `claimed` alone, on the argument that a disk collision was too unlikely to guard; it is not. The
 * slug comes from the claim's leading clause truncated to `SLUG_MAX_LENGTH`, and the same
 * pattern distilled on a later night, or two claims differing only past character 80, produces the
 * identical stem. A repeat claim then silently overwrote whatever occupied it: a memory a human had
 * since hand-corrected, or one this phase wrote weeks ago. The commit lands as a MODIFY carrying no
 * mention that anything was replaced, and every count still reads `written: 1`. Reproduced live
 * 2026-08-08. A `person:` entity makes it worse than a same-directory clash, because placement then
 * routes into `resources/people/`, which is `person-links`' own write surface.
 *
 * `store.freePathFor` itself is NOT reused, and the reason is reach and not preference. It is a
 * closure inside `makeStore` and not a member of `StoreShape`, so no phase can call it. Widening
 * that interface to expose a path-allocation helper would put a second door onto the store's write
 * path for one caller. So the RULE is borrowed and the four lines are not, which is also what lets
 * the probe read through `readFileBytes`, the sleep package's own repo-relative reader that
 * every other phase in this package uses.
 *
 * The suffix goes through `withCollisionOrdinal`, so it lands INSIDE the length budget. Plain
 * concatenation pushed a maximum-length stem to 82 characters, past `SLUG_MAX_LENGTH`, and
 * `isSlug`, the predicate every other path in the corpus satisfies, rejects that.
 *
 * Exhaustion returns `undefined` and the caller SKIPS the candidate. The old fall-through to
 * `<stem>-overflow.html` is the bug it was trying to avoid, once: a thousand-and-first collision
 * would take that one path unconditionally and overwrite whatever sat there, forever.
 */
const freePath = (
  env: PhaseEnv,
  candidate: CandidateMemoryLike,
  title: string,
  claimed: ReadonlySet<string>
): Effect.Effect<string | undefined, StorageFailure> =>
  Effect.gen(function* () {
    const directory = placementDirectory(candidate)
    const stem = slugify(title)
    for (let ordinal = 1; ordinal <= PATH_ORDINAL_LIMIT; ordinal += 1) {
      const candidatePath = `${directory}/${withCollisionOrdinal(stem, ordinal)}.html`
      if (claimed.has(candidatePath)) continue
      if ((yield* readFileBytes(env, candidatePath)) === undefined) return candidatePath
    }
    return undefined
  })

/** The directory the ordinary placement rules give a candidate. */
const placementDirectory = (candidate: CandidateMemoryLike): string =>
  placementFor({
    memoryType: candidate.kind,
    entities: entityRefsFor(candidate),
    tags: [CONSOLIDATION_TAG]
  })

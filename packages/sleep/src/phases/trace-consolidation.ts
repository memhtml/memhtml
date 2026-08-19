import { WRITABLE_MEMORY_TYPES } from "@memhtml/contracts"
import type { StorageFailure } from "@memhtml/contracts/errors"
import { placementFor } from "@memhtml/contracts/paths"
import { SLUG_FALLBACK, slugify, withCollisionOrdinal } from "@memhtml/contracts/slug"
import { frameKeyOf } from "@memhtml/domain"
import { renderTemplate } from "@memhtml/html"
import { makeIndexRecorder } from "@memhtml/index"
import { Effect, Result } from "effect"

import { commitPhase } from "../commit.js"
import type { CandidateMemoryLike, TranscriptManifestEntry } from "../consolidator.js"
import { readFileBytes, writeFileBytes } from "../edits.js"
import { emptyOutcome, type PhaseBody, type PhaseEnv } from "../env.js"
import {
  linkedSessionCount,
  markSessionsConsolidated,
  type SessionManifestRow,
  sessionManifestRows,
  unconsolidatedSessions,
  unlinkedSessionCount
} from "../sql.js"

/**
 * Phase 12, trace consolidation. Unread transcripts go to the injected agent; each candidate it
 * clears becomes ONE REVIEWABLE COMMIT. Watermarks land last.
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
 * `markSessionsConsolidated`'s call site. The distinction matters because
 * `trace_consolidations` is an anti-join. A watermark on a session whose transcript did not arrive
 * removes it from every future batch, so the transcript is lost with a row asserting it was handled.
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
        ...emptyOutcome({ ...base, batch: 0, candidates: 0, written: 0, consolidated: 0 }),
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
      return emptyOutcome({ ...base, batch: 0, candidates: 0, written: 0, consolidated: 0 })
    }

    /**
     * A dry run stops HERE, having done the whole deterministic half: the batch is real and counted,
     * and the model call is what does not happen. It stops before the call rather than after it,
     * because a dry run that spent Opus tokens to then discard the answer would be the most
     * expensive way to count.
     */
    if (env.dryRun) {
      return emptyOutcome({
        ...base,
        batch: batch.length,
        candidates: 0,
        written: 0,
        consolidated: 0
      })
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
        ...emptyOutcome({
          ...base,
          batch: batch.length,
          candidates: 0,
          written: 0,
          consolidated: 0
        }),
        detail: `consolidator unavailable: ${failure._tag}`
      }
    }

    const candidates = outcome.success.candidates
    const llmCalls = outcome.success.llmCalls
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
          entities: candidate.entities.filter((entity) => entity.trim() !== ""),
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
     * The watermark is written LAST, after every commit, and covers exactly the sessions the agent
     * ACTUALLY READ. {@link analyzedFrom} is that set, and it is not `batch`.
     *
     * ## Only a session whose transcript arrived
     *
     * This is the invariant the phase exists to hold on to, and it used to be broken here in one line:
     * the watermark covered `batch`, the set the phase ASKED ABOUT. The two differ whenever a
     * transcript does not reach the agent: rotated away since `memhtml trace index` ran, moved outside
     * `MEMHTML_TRACE_ROOT`, or behind a symlink the read-only mount will not follow (measured; see
     * `partitionReachable` in `apps/consolidator/src/client.ts`). Each of those recorded a session as
     * consolidated that nothing had read, and `trace_consolidations` is an ANTI-JOIN, so the session
     * was then never selected again. The transcript was lost silently, with a row asserting otherwise.
     *
     * **The guard is structural, not a check placed here.** `ConsolidationOutcome` cannot be
     * constructed without `analyzedSessionIds` (`../consolidator.ts`), so no shape a
     * consolidator returns leaves this phase with only the batch to fall back on. A `?? batch`
     * default, or an optional field, would have reintroduced that.
     *
     * {@link analyzedFrom} then INTERSECTS with the batch, so the outcome's set can only ever narrow
     * what is watermarked and never widen it. A consolidator naming a session nobody asked about is a
     * bug in the consolidator; it must not become a watermark on an unread session.
     *
     * ## Still the whole READ batch, including the barren ones
     *
     * A session that yielded no candidate HAS been consolidated: the agent read it and correctly found
     * nothing above the bar. Watermarking only the productive sessions would re-read every quiet
     * transcript at full Opus cost every night forever, and the batch would never advance past them.
     * So the narrowing is by REACHABILITY and never by productivity.
     *
     * ## Last, not first
     *
     * A process killed between the commits and this write reconsolidates those sessions next night, at
     * the cost of a wasted model call and a duplicate candidate a reviewer declines. The reverse order
     * would lose the transcripts silently, marked read with no memory to show for it.
     */
    const analyzed = analyzedFrom(batch, outcome.success.analyzedSessionIds)
    yield* markSessionsConsolidated(env.deps.db, {
      runId: env.runId,
      at: env.at,
      sessionIds: analyzed
    })

    /**
     * `consolidated` is the ANALYZED count and `batch` the requested one, so the two disagreeing in a
     * report is the operator-visible signal that transcripts went missing. That state previously
     * had no reading at all, since a watermark over the batch made the two equal by construction.
     */
    const unreachable = batch.length - analyzed.length
    if (unreachable > 0) {
      yield* Effect.logWarning(
        `sleep.trace-consolidation asked about ${String(batch.length)} sessions and ` +
          `${String(unreachable)} did not reach the agent; those stay unconsolidated for the next run`
      )
    }

    return {
      counts: {
        ...base,
        batch: batch.length,
        candidates: candidates.length,
        written,
        skipped,
        conflicts: conflicted,
        consolidated: analyzed.length,
        unreachable
      },
      commitSha: lastCommit,
      llmCalls
    }
  })

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
    entities: candidate.entities,
    tags: [CONSOLIDATION_TAG]
  })

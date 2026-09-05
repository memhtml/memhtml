import type { StorageFailure } from "@memhtml/contracts/errors"
import { attemptIo, readFileOrNull, SLEEP_REPORTS_DIR } from "@memhtml/store"
import { Effect } from "effect"

/**
 * The phase vocabulary, the trailer keys, the dependency graph between phases, and the pending-mark
 * ledger a run hands its own merge.
 *
 * These constants are the contract the runner, the resume read, and the report all key on, so
 * they live apart from every phase body: a phase name appears in a commit trailer, in a
 * `sleep_phases` row, and in a `--phases` flag, and three copies of the string would drift. The
 * ledger is here for the same reason and one more: two phases WRITE it and `merge` READS it, so a
 * copy of its filename or its line shape in either place would be a copy free to disagree.
 */

/**
 * The seventeen phases, in execution order.
 *
 * The order encodes the predecessor memory system's dependencies (design §6): entity resolution precedes person
 * links so aliases have already merged, confidence decay precedes retention triage so triage
 * scores the decayed value, and dedup-merge precedes compress and retention because both operate
 * on the post-merge set.
 *
 * `task-detection` sits after `trace-consolidation` and before `integrity`, and both edges are
 * deliberate. It scans the ACTIVE corpus for unresolved
 * commitments, so it has to run after every phase that changes what is active — after dedup's folds,
 * after retention's evictions, after compress's canonicals, and after trace consolidation's newly
 * distilled memories, which are the freshest text of the night and the likeliest to carry one. And it
 * WRITES files, so it must precede `integrity`, which repairs dangling hrefs and regenerates the
 * directory artifacts: a task minted afterwards would be absent from its directory's `index.html`
 * until the next night.
 *
 * `placement-triage` is deep-only (issue #63): on a run without `--deep` it returns immediately,
 * writes nothing, and commits nothing, so a default run's behavior is unchanged by its presence
 * in this list. Its slot has the same two edges task-detection's does, plus one more on each side:
 * it must run after `compress` (it re-files only what even deep grouping could not fold, so folding
 * has to have had its chance first) and after `task-detection` (a move mid-scan would hand the
 * detector paths that no longer hold files), and it must precede `integrity` because it MOVES files —
 * integrity regenerates each directory's `index.html`, and it rewrites inbound hrefs itself because
 * integrity's dangling-href repair only knows how to chase a target into the ARCHIVE, not into a
 * topic directory.
 */
export const SLEEP_PHASES = [
  "preflight",
  "dedup-merge",
  "entity-resolution",
  "person-links",
  "relationship-mining",
  "edge-typing",
  "confidence-decay",
  "arc-synthesis",
  "retention-triage",
  "compress",
  "reprieve",
  "trace-consolidation",
  "task-detection",
  "placement-triage",
  "integrity",
  "state-export",
  "report"
] as const

export type SleepPhase = (typeof SLEEP_PHASES)[number]

/** True when a string names a phase. Narrows a `--phases` value or a trailer read. */
export const isSleepPhase = (value: string): value is SleepPhase =>
  (SLEEP_PHASES as ReadonlyArray<string>).includes(value)

/** The 1-based ordinal of a phase within the sequence. A display label, never arithmetic input. */
export const phaseIndexOf = (phase: SleepPhase): number => SLEEP_PHASES.indexOf(phase) + 1

/**
 * Phases whose failure blocks a later phase.
 *
 * Everything else is SOFT: a phase that fails is recorded `failed` and the phases after it still
 * run, keeping every prior commit on the branch. That posture comes from one specific failure.
 * The predecessor ran thirteen phases inside one transaction and four consecutive nights of
 * production curation were lost to a single phase raising, because the abort rolled back the
 * twelve that had already succeeded.
 *
 * **`preflight` gates the WHOLE run: every one of the sixteen phases after it.** It establishes the
 * three preconditions the rest of the night reads, and each of its failures makes every later phase's
 * commit wrong rather than merely unhelpful. `requireCleanTree` failing means the operator has
 * uncommitted work in the tree, so a later phase stages and commits the operator's bytes under
 * sleep's own trailers. `EmbedModelMismatch` is a half-migrated vector space, which degrades every
 * cosine in the run while each individual vector stays well-formed — dedup, mining, and conflict
 * detection all come back plausible and wrong. `IndexStale` is an index a rebuild emptied and did not
 * finish repopulating, and every later phase reads the index, so their counts describe a corpus
 * fragment. All three end in the one outcome per-phase isolation is not a defense against: a corrupt
 * night with a green report.
 *
 * `dedup-merge` gates `compress` and `retention-triage`: both operate on the post-merge set, and
 * running them over a corpus that still holds the duplicates would compress a near-duplicate pair
 * into a canonical while a merge later archives one of its members.
 *
 * That is why `dedup-merge` isolates each of its model calls instead of failing on one. It batches
 * components and a batch whose call comes back malformed is counted and skipped, so a single bad tool
 * payload cannot take two later phases down with it.
 *
 * **The edges are spelled out one literal pair at a time, including preflight's sixteen.** The
 * generated phase table parses this array as a literal (`apps/docs/src/loaders/registry.ts` reads it
 * through `stringPairArrayConst`), so a computed or spread member would publish a page saying
 * preflight blocks nothing while the runner blocks everything after it. `units.test.ts` asserts
 * `dependentsOf("preflight")` is every later phase, so a phase added to {@link SLEEP_PHASES} without
 * a pair here fails a test instead of silently running after a failed preflight.
 */
export const HARD_PREREQUISITES: ReadonlyArray<readonly [SleepPhase, SleepPhase]> = [
  ["preflight", "dedup-merge"],
  ["preflight", "entity-resolution"],
  ["preflight", "person-links"],
  ["preflight", "relationship-mining"],
  ["preflight", "edge-typing"],
  ["preflight", "confidence-decay"],
  ["preflight", "arc-synthesis"],
  ["preflight", "retention-triage"],
  ["preflight", "compress"],
  ["preflight", "reprieve"],
  ["preflight", "trace-consolidation"],
  ["preflight", "task-detection"],
  ["preflight", "placement-triage"],
  ["preflight", "integrity"],
  ["preflight", "state-export"],
  ["preflight", "report"],
  ["dedup-merge", "compress"],
  ["dedup-merge", "retention-triage"]
]

/**
 * The phases blocked by `phase` failing.
 *
 * A phase may appear as the dependent of more than one prerequisite — `compress` declares both — so
 * the runner records WHICH prerequisite failed rather than looking a blocker up here. This direction
 * of the relation is the only one a failure can be read forward through.
 */
export const dependentsOf = (phase: SleepPhase): ReadonlyArray<SleepPhase> =>
  HARD_PREREQUISITES.flatMap(([before, after]) => (before === phase ? [after] : []))

/** Commit trailers `memhtml sleep resume` reads back out of `git log` to skip done work. */
export const TRAILER_RUN = "Memhtml-Run"
export const TRAILER_PHASE = "Memhtml-Phase"
export const TRAILER_COUNTS = "Memhtml-Counts"

/**
 * The phases that call a model, in execution order. Every other phase is deterministic and costs no
 * model call.
 *
 * **Descriptive, not a gate.** Nothing branches on this list: each phase reads `env.deps.model` itself
 * and degrades on its own when it is absent. What the list feeds is the generated documentation's
 * `callsModel` column (`apps/docs/src/loaders/registry.ts`), so an operator reading the phase table
 * learns which phases a credential-free run gets nothing from. A phase omitted here would still make
 * its calls and would be documented as deterministic.
 *
 * Membership means "spends model calls when a model is bound", not "needs a model to be useful".
 * `dedup-merge` and `entity-resolution` both do real deterministic work without one: dedup falls back
 * to the 0.92 cosine floor plus the divergence veto and still commits, and entity-resolution's
 * normalization and character-overlap passes run either way. Every other member reports a reason and
 * writes nothing.
 *
 * `task-detection` was the first member that is net-new model spend rather than a
 * question a phase was already asking. Issue #44 sizes it that way on purpose: surfaces 1 and 2 cover
 * the highest-signal sources at no marginal cost, and this one is the batched scan over the active
 * corpus, capped like every other phase and degrading to `no model bound` with nothing written.
 *
 * `placement-triage` spends model calls only under `--deep` (issue #63). On a default run it returns
 * immediately with a reason, so its membership here reads "spends calls when deep AND a model is
 * bound" — the same two-condition degradation `trace-consolidation` has for its consolidator.
 */
export const LLM_PHASES: ReadonlyArray<SleepPhase> = [
  "dedup-merge",
  "entity-resolution",
  "edge-typing",
  "arc-synthesis",
  "compress",
  "trace-consolidation",
  "task-detection",
  "placement-triage"
]

/**
 * Phases whose commit is a UNIFORM SWEEP: one head stamp applied to every eligible file by a rule,
 * carrying no per-file decision and authoring no edge.
 *
 * This is the distinction `placement-triage`'s this-run guard turns on. That guard refuses to move a
 * file another phase wrote on this branch, because a move would fold that phase's edit into a rename
 * a reviewer reads somewhere else. A sweep has no edit to fold: `confidence-decay` restamps
 * `memhtml-confidence` and `memhtml-updated` on every eligible active file, and its value is a
 * mechanical function of the value already in the file (`decayConfidence`), so nothing about it is
 * invalidated by the file being at a different path afterwards. It is also the WIDEST commit in a
 * run, so a guard that counts it pins essentially the whole corpus and the phase downstream refuses
 * essentially everything (issue #81).
 *
 * **The list enumerates the sweeps, so a phase absent from it PINS.** The two mistakes cost
 * different amounts. A phase wrongly treated as a sweep lets placement move a file it just wrote —
 * a committed href that dangles, or a decision folded into a rename — while a phase wrongly pinning
 * costs one night's yield on a file that is still a candidate tomorrow. So membership is an explicit
 * claim and the default is the recoverable side.
 *
 * A phase that calls a model is never a member: a model answer is a per-file decision. The two lists
 * are asserted disjoint in `units.test.ts`.
 *
 * The near-misses, because the absences carry the rule:
 *
 * - `reprieve` writes only head metas too, and is still out. `memhtml-valid-until` plus
 *   `memhtml-reprieves` IS a per-file retention decision, and a reviewer reads it at the path it was
 *   decided on. Its volume is bounded to the files whose TTL passed, so membership would buy almost
 *   no reach against that.
 * - `person-links` and `edge-typing` splice `<link>` elements, which leave the article's bytes — and
 *   therefore its content hash — identical. So the meaning of a change, not its width, is what
 *   decides membership: a hash-based rule would release exactly these two, and placement's inbound
 *   href rewrite reads the INDEX, which no phase refreshes mid-run, so an edge authored this run is
 *   invisible to it and the move would leave the href dangling.
 * - `preflight` and `relationship-mining` are in {@link NON_COMMITTING_PHASES}, so no commit of
 *   theirs can appear in a range; `integrity`, `state-export`, and `report` run after
 *   `placement-triage`, so theirs cannot either. Membership for any of the five would be a claim
 *   nothing can exercise.
 */
export const SWEEP_PHASES: ReadonlyArray<SleepPhase> = ["confidence-decay"]

/** True when a phase's commit is a uniform sweep. See {@link SWEEP_PHASES}. */
export const isSweepPhase = (phase: SleepPhase): boolean => SWEEP_PHASES.includes(phase)

/**
 * Phases that never commit.
 *
 * `preflight` refreshes the index and asserts a clean tree; it produces no mutation to review.
 * `relationship-mining` writes derived edges to the index only. They are a re-derivable
 * function of the corpus and the embedder, and committing thousands of them would bury every
 * real diff in machine noise.
 *
 * `trace-consolidation` was here while it was a counting stub and is NOT any more. It now
 * synthesizes memories and lands each as its own reviewable commit, which puts it behind the
 * discrimination gate the same way every other mutation is. A phase absent from this list is not
 * obliged to commit (this one still reports `commitSha: null` on a night with nothing to distill, no
 * consolidator bound, or a dry run), so the list names phases that CANNOT commit, not phases that
 * happened not to.
 *
 * `task-detection` is absent for the same reason: it commits the tasks it mints, and mints nothing on
 * a night with no model, no candidate, or nothing above its floor.
 */
export const NON_COMMITTING_PHASES: ReadonlyArray<SleepPhase> = ["preflight", "relationship-mining"]

/** How a phase ended. `failed` is a normal terminal state, not an aborted run. */
export type PhaseStatus = "ok" | "failed" | "skipped"

/** Per-phase counts, as they land in the `Memhtml-Counts` trailer and the `sleep_phases` row. */
export type PhaseCounts = Readonly<Record<string, number>>

/** One phase's outcome. */
export interface PhaseResult {
  readonly phase: SleepPhase
  readonly status: PhaseStatus
  readonly counts: PhaseCounts
  /** The commit this phase produced, or `null` when it staged nothing or does not commit. */
  readonly commitSha: string | null
  /** Model calls this phase made. Zero for every phase outside {@link LLM_PHASES}. */
  readonly llmCalls: number
  /** Why it failed, or why it was skipped. Absent on `ok`. */
  readonly detail?: string | undefined
}

/**
 * How long a `sleep_runs` row may stay `running` before a later run treats it as killed.
 *
 * Twenty hours. This bounds how long ONE run can still plausibly be executing; it says nothing about
 * when the next run comes, because the cycle has no schedule of its own and a caller decides that. A
 * run writes its row `running` before the first phase and rewrites it after the last, and a process
 * killed in between leaves the first write in place with nothing else ever revisiting it (issue
 * #146). No phase budget bounds a whole run's wall-clock duration (the caps in this package count
 * model calls and detected tasks), so the bound is stated here. A full run over the production corpus
 * is a multi-hour process, and twenty hours is several times that.
 *
 * Why twenty and not a round day: the RUNBOOK's example wiring runs `sleep run` once a day, and a bound
 * equal to that interval turns the boundary into a coin flip. Measured: a run started at 02:00:07 and a
 * next start at 02:00:03 the following day are 86,396,000 ms apart, which is under a 24-hour bound by
 * four seconds, so the killed row survives one more day. Four hours of margin absorb cron drift and a
 * host that booted late, so a once-a-day caller always reaps the previous run on the next start.
 *
 * The comparison is between two wall-clock stamps of the same kind, the stuck row's `started_at` and
 * the new run's own start. The run's `--date` parameter is the wrong reference: a backdated run would
 * make every earlier row read as far older or far younger than it is.
 */
export const SLEEP_RUN_STALE_AFTER_MS = 20 * 60 * 60 * 1000

/** One earlier run's row the reaper closed at the start of this run, and why. */
export interface ReapedRun {
  readonly runId: string
  /** `branch gone`, or `started <n>h ago, past budget`. */
  readonly reason: string
}

/** A whole run's outcome. */
export interface RunReport {
  /** `sleep/<YYYY-MM-DD>`, suffixed `-2` on a same-day rerun. Also the branch name. */
  readonly runId: string
  readonly branch: string
  /** The commit the run branched from. `merge` refuses if main moved past it. */
  readonly baseSha: string
  /** The branch tip after the run, or `baseSha` when nothing committed. */
  readonly headSha: string
  readonly dryRun: boolean
  readonly phases: ReadonlyArray<PhaseResult>
  /** Total model calls across {@link LLM_PHASES}. */
  readonly llmCalls: number
  /**
   * Rows of EARLIER runs this run stamped `abandoned` before it started, with the reason for each.
   * Empty on a resume, which targets a `running` row on purpose, and on a run that refused to start
   * before it reached the ledger.
   */
  readonly reaped: ReadonlyArray<ReapedRun>
}

/** How one file changed across a run, for the review surface. */
export type FileClassification = "meta-only" | "body-changed" | "archived" | "created" | "deleted"

/** One file's classification in a review. */
export interface ReviewFile {
  readonly path: string
  readonly classification: FileClassification
  /** Set only on an archive: the path it moved from. */
  readonly fromPath?: string | undefined
}

/** One commit on the sleep branch. */
export interface ReviewCommit {
  readonly sha: string
  readonly phase: SleepPhase | null
  readonly counts: PhaseCounts
}

/** What `review` reports: the run, its commits, and what they did to the tree. */
export interface ReviewReport {
  readonly runId: string
  readonly branch: string
  readonly baseSha: string
  readonly headSha: string
  readonly phases: ReadonlyArray<PhaseResult>
  readonly commits: ReadonlyArray<ReviewCommit>
  /** `git diff --stat base..HEAD`, verbatim. */
  readonly diffStat: string
  readonly files: ReadonlyArray<ReviewFile>
}

/** What `merge` did, or why it refused. */
export interface MergeReport {
  readonly runId: string
  readonly branch: string
  readonly merged: boolean
  /** `main`'s sha after the merge, or before it on a refusal. */
  readonly headSha: string
  /** Set on a refusal: which precondition failed. */
  readonly refusal?: "main-advanced" | "gate-failed" | "no-run" | undefined
  /**
   * Set on a `main-advanced` refusal caused by a path collision: the paths both main's advance and
   * the branch touched since the base, sorted. Absent when the refusal is the advance being
   * unreadable, or any other refusal — a disjoint advance merges and reports no refusal at all, so
   * this field is what tells an operator "real collision" from "could not prove disjointness".
   */
  readonly overlap?: ReadonlyArray<string> | undefined
  /**
   * Pending state-plane marks the run's ledger carried, and how many of them this merge applied.
   * Present only on a merge that happened; a refusal applies nothing and reports neither.
   *
   * TWO numbers rather than one, and they answer different questions. `marksPending` is what the
   * branch earned, `marksApplied` is what the plane took. A record kind (`commitment-below-floor`)
   * counts as applied by having reached `main`; it writes no row. They agree on every ordinary merge, so a
   * merge where they disagree is the operator-visible reading of a plane write that did not land —
   * the sessions in the shortfall stay unconsolidated and are re-read on the next cycle, which costs
   * a model call and loses nothing. One number could not distinguish that from a run that earned no
   * marks at all.
   */
  readonly marksPending?: number | undefined
  readonly marksApplied?: number | undefined
}

/**
 * ONE pending state-plane write a run has earned, recorded on its branch and applied by `merge`.
 *
 * **Why these writes are deferred at all.** `git branch -D` is this design's abort and `main` never
 * moves during a run, so discarding a branch has to discard everything the run decided. A write into
 * the state plane escapes that: `.memhtml/state.db` is not rebuildable from the tree and
 * `trace_consolidations` survives an index rebuild by construction (migration 0010), so a row written
 * DURING a phase outlives the branch that earned it. For the consolidation watermark that is
 * data loss and not merely bookkeeping — the watermark is an ANTI-JOIN, so a session it covers is
 * never selected again, and the transcript is gone with a row asserting it was handled.
 *
 * So a phase records the write here instead of performing it, `merge` applies the ledger after the
 * branch lands, and a discarded branch takes its pending marks with it.
 *
 * **The ledger is a committed artifact and not a table**, for the reason the trailers are the resume
 * mechanism: a run's facts are its commits. A table would be a second record of what a run earned,
 * and the two disagree exactly when it matters — on a branch that was reviewed and thrown away.
 */
export type PendingMark =
  | {
      readonly kind: "session-consolidated"
      readonly sessionId: string
      readonly runId: string
      readonly at: string
    }
  | {
      readonly kind: "edge-promoted"
      readonly srcPath: string
      readonly rel: string
      readonly dstPath: string
      readonly at: string
    }
  /**
   * An entity merge recorded as applied: `state.entity_corroboration.promoted`/`confirmed`.
   *
   * The three fields ARE the counter row's primary key, `(entity_type, alias_name, canonical_name)`,
   * and the pair is ORIENTED — `alias_name` is the name rewritten away and `canonical_name` the one
   * that survives, two roles the table keeps apart on purpose (`S0002_entity_corroboration.sql`
   * records that a merge whose direction flips restarts the counter). A mark that sorted the two names
   * would address a row the table does not hold. `entity_type` is in the key because `person:api` and
   * `service:api` are different subjects whose names collide.
   *
   * Deferred for the reason the edge promotion is, one step further along the same door: setting
   * `promoted = 1` asserts that the corpus already carries the rewrite, and an entity merge rewrites
   * `memhtml-entity` metas across every file claiming the alias. A branch discarded after the flag was
   * set leaves the plane claiming a corpus-wide rename that no file carries — a provenance record that
   * is false and not rebuildable, since `.memhtml/state.db` is not derived from the tree.
   */
  | {
      readonly kind: "entity-promoted"
      readonly entityType: string
      readonly aliasName: string
      readonly canonicalName: string
      readonly at: string
    }
  /**
   * A commitment the consolidator extracted that scored below `COMMITMENT_FLOOR`, kept whole.
   *
   * A RECORD rather than a deferred write: nothing in the state plane changes when `merge` applies it,
   * and {@link isStateWriteMark} is what keeps it out of `applyPendingMarks`' statement list. It lives
   * in the ledger anyway because the ledger is the run's committed, reviewable, branch-scoped record,
   * and "did not act" and "did not record" are different decisions. The floor exists so a
   * low-confidence commitment does not mint a task on its own; without the text, the confidence, and
   * the session beside the count, an operator reading `commitmentsBelowFloor=2` cannot tell a floor
   * that was rightly conservative from one that dropped a real commitment, and the floor is untunable
   * (issue #131). The report renders these under a fold; a later run or an operator can re-score them.
   */
  | {
      readonly kind: "commitment-below-floor"
      readonly sessionId: string
      readonly statement: string
      readonly confidence: number
      readonly resolved: boolean
      readonly runId: string
      readonly at: string
    }

/** The marks that perform a state-plane write when applied. Everything but the record kinds. */
export type StateWriteMark = Exclude<PendingMark, { readonly kind: "commitment-below-floor" }>

/** True for a mark `merge` executes as SQL; false for a record it carries and applies as nothing. */
export const isStateWriteMark = (mark: PendingMark): mark is StateWriteMark =>
  mark.kind !== "commitment-below-floor"

/**
 * Where a run's ledger lives: beside its report, under the same run-id-to-filename rule.
 *
 * `/` is not legal in a filename and a run id is `sleep/<date>`, so the separator becomes a hyphen —
 * the same transformation `reportFilename` makes, stated the same way, so a run's two artifacts sort
 * next to each other in `.memhtml/sleep/`.
 */
export const pendingMarksPath = (runId: string): string =>
  `${SLEEP_REPORTS_DIR}/${runId.replaceAll("/", "-")}.pending.jsonl`

/**
 * One mark as its ledger line, with the keys in a FIXED order.
 *
 * Fixed order is what makes the rendered line the mark's identity, which is what
 * {@link appendPendingMarks} deduplicates on: two recordings of one mark must render byte-identically
 * or a resume would append a second copy of a write it already earned. It also makes the file
 * byte-stable, so a phase that records nothing new writes nothing and stages nothing.
 */
const renderPendingMark = (mark: PendingMark): string => {
  switch (mark.kind) {
    case "session-consolidated":
      return JSON.stringify({
        kind: mark.kind,
        sessionId: mark.sessionId,
        runId: mark.runId,
        at: mark.at
      })
    case "commitment-below-floor":
      return JSON.stringify({
        kind: mark.kind,
        sessionId: mark.sessionId,
        statement: mark.statement,
        confidence: mark.confidence,
        resolved: mark.resolved,
        runId: mark.runId,
        at: mark.at
      })
    case "edge-promoted":
      return JSON.stringify({
        kind: mark.kind,
        srcPath: mark.srcPath,
        rel: mark.rel,
        dstPath: mark.dstPath,
        at: mark.at
      })
    case "entity-promoted":
      return JSON.stringify({
        kind: mark.kind,
        entityType: mark.entityType,
        aliasName: mark.aliasName,
        canonicalName: mark.canonicalName,
        at: mark.at
      })
  }
}

/**
 * The ledger's bytes with `marks` appended, dropping any that are already recorded.
 *
 * APPEND order is preserved and is the order `merge` applies in, because a promotion mark presumes
 * the counter row its own phase created and an ordering that reversed them would apply an update to
 * a row that is not there yet.
 *
 * JSONL rather than one JSON array, the same shape and the same reason as the access sidecar: the
 * file appends cleanly, a truncated write costs one mark instead of the whole ledger, and `git diff`
 * reads as one line per earned write.
 */
export const appendPendingMarks = (
  existing: string | undefined,
  marks: ReadonlyArray<PendingMark>
): string => {
  const lines = (existing ?? "").split("\n").filter((line) => line.trim() !== "")
  const seen = new Set(lines)
  for (const mark of marks) {
    const line = renderPendingMark(mark)
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

/**
 * Parse a ledger back into marks, reporting how many lines it could not read.
 *
 * Defensive per line, exactly as the access sidecar's parse is: the ledger is the only record of what
 * a branch earned, so a file whose tail an interrupted write mangled must still yield every mark it
 * does hold. `skipped` is REPORTED rather than swallowed, because a skipped line is a write the merge
 * will not make — the caller logs it, and the session it named is simply re-read next cycle.
 */
export const parsePendingMarks = (
  contents: string
): {
  readonly marks: ReadonlyArray<PendingMark>
  readonly skipped: number
} => {
  const marks: Array<PendingMark> = []
  let skipped = 0
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue
    const mark = parseOne(line)
    if (mark === undefined) skipped += 1
    else marks.push(mark)
  }
  return { marks, skipped }
}

/** One line as a mark, or `undefined` when any field it needs is absent or not a string. */
const parseOne = (line: string): PendingMark | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const fields = parsed as Record<string, unknown>
  const at = text(fields.at)
  if (at === undefined) return undefined
  if (fields.kind === "session-consolidated") {
    const sessionId = text(fields.sessionId)
    const runId = text(fields.runId)
    return sessionId === undefined || runId === undefined
      ? undefined
      : { kind: "session-consolidated", sessionId, runId, at }
  }
  if (fields.kind === "edge-promoted") {
    const srcPath = text(fields.srcPath)
    const rel = text(fields.rel)
    const dstPath = text(fields.dstPath)
    return srcPath === undefined || rel === undefined || dstPath === undefined
      ? undefined
      : { kind: "edge-promoted", srcPath, rel, dstPath, at }
  }
  if (fields.kind === "entity-promoted") {
    const entityType = text(fields.entityType)
    const aliasName = text(fields.aliasName)
    const canonicalName = text(fields.canonicalName)
    return entityType === undefined || aliasName === undefined || canonicalName === undefined
      ? undefined
      : { kind: "entity-promoted", entityType, aliasName, canonicalName, at }
  }
  if (fields.kind === "commitment-below-floor") {
    const sessionId = text(fields.sessionId)
    const statement = text(fields.statement)
    const runId = text(fields.runId)
    const { confidence, resolved } = fields
    return sessionId === undefined ||
      statement === undefined ||
      runId === undefined ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      typeof resolved !== "boolean"
      ? undefined
      : { kind: "commitment-below-floor", sessionId, statement, confidence, resolved, runId, at }
  }
  return undefined
}

/** A non-empty string field, or `undefined`. A blank id is not an id. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

/** The marks a run has already recorded. Empty when it has recorded none. */
export const readPendingMarks = (
  root: string,
  runId: string
): Effect.Effect<ReadonlyArray<PendingMark>, StorageFailure> =>
  readFileOrNull(`${root}/${pendingMarksPath(runId)}`).pipe(
    Effect.map((contents) => (contents === null ? [] : parsePendingMarks(contents).marks))
  )

/**
 * Record marks in the run's ledger. `true` when the file changed, which is when the caller must
 * stage it — a phase that leaves the ledger unstaged has earned a write no merge will find.
 *
 * Read-modify-write against DISK rather than an accumulator in the run's environment, and that is
 * forced: the ledger is one file per run and phases three, six and twelve all write it, sequentially,
 * in separate phase bodies. Disk is the carrier they share, and it is also the carrier that survives
 * the process — a resume re-recording a mark it already earned appends nothing.
 */
export const recordPendingMarks = (
  root: string,
  runId: string,
  marks: ReadonlyArray<PendingMark>
): Effect.Effect<boolean, StorageFailure> =>
  Effect.gen(function* () {
    if (marks.length === 0) return false
    const absolute = `${root}/${pendingMarksPath(runId)}`
    const existing = yield* readFileOrNull(absolute)
    const next = appendPendingMarks(existing ?? undefined, marks)
    if (next === existing) return false
    yield* attemptIo(`sleep.pending-marks:${runId}`, async () => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      const { dirname } = await import("node:path")
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, next, "utf8")
    })
    return true
  })

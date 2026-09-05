import type { StorageFailure } from "@memhtml/contracts/errors"
import { isArchivePath } from "@memhtml/contracts/paths"
import { contentHash } from "@memhtml/html"
import type { EmbedModelMismatch, IndexStale } from "@memhtml/index"
import { Effect } from "effect"

import type {
  FileClassification,
  MergeReport,
  PhaseResult,
  ReviewCommit,
  ReviewReport,
  SleepPhase
} from "./contract.js"
import {
  isSleepPhase,
  parsePendingMarks,
  pendingMarksPath,
  TRAILER_COUNTS,
  TRAILER_PHASE
} from "./contract.js"
import type { SleepDeps } from "./env.js"
import { nowIso, parseCounts } from "./run.js"
import { applyPendingMarks, latestRun, type RunRow, readPhases, readRun, recordRun } from "./sql.js"

/**
 * `review` and `merge`: what a human reads before a sleep branch lands, and the two refusals that
 * stop it landing badly.
 *
 * A run earns trust from what a reviewer can see, not from having succeeded. The review shows which
 * files changed, whether a change was a meta stamp or a rewritten claim, and which phases failed.
 * The merge then refuses on two independent grounds: `main` having moved, and
 * the caller's own gate.
 */

/** Which run `review`/`merge` acts on: a named one, or the newest recorded. */
const resolveRun = (
  deps: SleepDeps,
  runId: string | undefined
): Effect.Effect<RunRow | undefined, never, never> =>
  (runId === undefined ? latestRun(deps.db) : readRun(deps.db, runId)).pipe(
    Effect.orElseSucceed(() => undefined)
  )

/**
 * Review a run: its phase rows, its commits with their trailers, the diff stat, and a per-file
 * classification.
 *
 * The classification is the substance. `git diff --stat` says a file changed by two lines and says
 * nothing about whether those lines were a confidence stamp or the memory's claim. Head edits go
 * through byte-splicing editors so that distinction is REAL: a meta-only
 * change provably leaves the article's bytes, and therefore its content hash, identical. So
 * `meta-only` here is computed by comparing the two versions' content hashes, not by reading the diff.
 */
export const review = (
  deps: SleepDeps,
  runId?: string
): Effect.Effect<ReviewReport, never, never> =>
  Effect.gen(function* () {
    const row = yield* resolveRun(deps, runId)
    const resolvedId = row?.run_id ?? runId ?? ""
    const branch = row?.branch ?? resolvedId
    const baseSha = row?.base_sha ?? ""

    const phaseRows = yield* readPhases(deps.db, resolvedId).pipe(Effect.orElseSucceed(() => []))
    const phases: ReadonlyArray<PhaseResult> = phaseRows.flatMap((phaseRow) =>
      isSleepPhase(phaseRow.phase)
        ? [
            {
              phase: phaseRow.phase,
              status:
                phaseRow.status === "ok" || phaseRow.status === "failed"
                  ? phaseRow.status
                  : "skipped",
              counts: parseCounts(phaseRow.counts),
              commitSha: phaseRow.commit_sha,
              llmCalls: phaseRow.llm_calls,
              ...(phaseRow.error === null ? {} : { detail: phaseRow.error })
            }
          ]
        : []
    )

    const headSha = yield* deps.git
      .revParseHead()
      .pipe(Effect.orElseSucceed(() => null))
      .pipe(Effect.map((sha) => sha ?? baseSha))
    const range = baseSha === "" ? branch : `${baseSha}..${branch}`

    const commits = yield* readCommits(deps, range)
    const diffStat =
      baseSha === ""
        ? ""
        : yield* deps.git.run(["diff", "--stat", range]).pipe(Effect.orElseSucceed(() => ""))
    const files = baseSha === "" ? [] : yield* classifyFiles(deps, baseSha, branch)

    return { runId: resolvedId, branch, baseSha, headSha, phases, commits, diffStat, files }
  }).pipe(Effect.withSpan("sleep.review"))

/**
 * The commits in a range with their phase and counts trailers.
 *
 * Read with `logTrailers`, one call per key, instead of by grepping `%B`. The trailer values can carry
 * colons and commas, since `Memhtml-Counts` is JSON, and `%(trailers:key=…,valueonly)` returns them
 * verbatim. A `grep '^Memhtml-Phase:'` over a message body would also match a line inside a memory
 * title that happened to start that way.
 */
const readCommits = (
  deps: SleepDeps,
  range: string
): Effect.Effect<ReadonlyArray<ReviewCommit>, never, never> =>
  Effect.gen(function* () {
    const phaseRecords = yield* deps.git
      .logTrailers(range, TRAILER_PHASE)
      .pipe(Effect.orElseSucceed(() => []))
    const countRecords = yield* deps.git
      .logTrailers(range, TRAILER_COUNTS)
      .pipe(Effect.orElseSucceed(() => []))
    const countsBySha = new Map(countRecords.map((record) => [record.sha, record.values[0]]))

    return phaseRecords.map((record): ReviewCommit => {
      const value = record.values[0]
      const phase: SleepPhase | null = value !== undefined && isSleepPhase(value) ? value : null
      return { sha: record.sha, phase, counts: parseCounts(countsBySha.get(record.sha)) }
    })
  })

/**
 * Classify every path the run touched.
 *
 * A rename is `archived` regardless of similarity score, because eviction IS a `git mv` into
 * `archive/<YYYY>/` and the year-partitioned path is what says so. Nothing here reads the score: an
 * archive commit that also stamps the head measures R059-R087 (a head stamp lowers a tree-to-tree
 * similarity), so gating on 100 would classify every real eviction as a delete plus an add.
 */
const classifyFiles = (
  deps: SleepDeps,
  baseSha: string,
  branch: string
): Effect.Effect<
  ReadonlyArray<{
    readonly path: string
    readonly classification: FileClassification
    readonly fromPath?: string | undefined
  }>,
  never,
  never
> =>
  Effect.gen(function* () {
    const changes = yield* deps.git
      .diffNameStatus(baseSha, branch)
      .pipe(Effect.orElseSucceed(() => []))

    const results: Array<{
      path: string
      classification: FileClassification
      fromPath?: string | undefined
    }> = []

    for (const change of changes) {
      if (change.kind === "added" || change.kind === "copied") {
        results.push({ path: change.path, classification: "created" })
        continue
      }
      if (change.kind === "deleted") {
        results.push({ path: change.path, classification: "deleted" })
        continue
      }
      if (change.kind === "renamed") {
        results.push({
          path: change.path,
          classification: isArchivePath(change.path) ? "archived" : "body-changed",
          ...(change.fromPath === null ? {} : { fromPath: change.fromPath })
        })
        continue
      }
      /**
       * A modification is meta-only iff the two versions' ARTICLE hashes agree. That is the property
       * the byte-splice head editors buy: a decay pass, a link promotion, and a reprieve extension all
       * leave the article untouched, so a reviewer can skip them and read only the body changes.
       */
      const before = yield* blobText(deps, `${baseSha}:${change.path}`)
      const after = yield* blobText(deps, `${branch}:${change.path}`)
      const sameArticle =
        before !== undefined && after !== undefined && contentHash(before) === contentHash(after)
      results.push({
        path: change.path,
        classification: sameArticle ? "meta-only" : "body-changed"
      })
    }

    return results.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    )
  })

/** One blob's text at a revision, or `undefined` when the revision does not hold it. */
const blobText = (deps: SleepDeps, spec: string): Effect.Effect<string | undefined, never, never> =>
  deps.git.run(["show", spec]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/** What `merge` takes. `preMergeGate` is the caller's quality refusal, composed ahead of the merge. */
export interface MergeOptions {
  /**
   * A gate that must succeed before `main` moves. T10 wires the discrimination eval here, so a sleep
   * run that degrades retrieval quality is refused and cannot land.
   *
   * Absent means no gate. This package cannot import the eval without depending on it, so the
   * composition belongs to the CLI. A missing gate is then visible in the caller's own wiring,
   * instead of being supplied silently here.
   */
  readonly preMergeGate?: Effect.Effect<void, unknown> | undefined
  /** The branch the run lands on. Defaults to `main`. */
  readonly targetBranch?: string | undefined
}

/**
 * Land the sleep branch on the target branch, or refuse.
 *
 * **Two refusals, both before anything moves.** `main` having advanced past `base_sha` means the run
 * curated a corpus that MAY no longer exist: a decay computed against a confidence an agent has since
 * corrected, an eviction of a memory that was just reinforced. Whether it does is a path question,
 * and {@link advanceOverlap} asks it: when the paths main gained and the paths the branch wrote —
 * FULL diffs on both sides, committed sidecars, regenerated artifacts, and both halves of every
 * rename included — intersect at even one path, or when either diff cannot be read, the merge
 * refuses and the operator reruns the sleep. The rerun is cheap because every phase is idempotent:
 * an already-merged duplicate no longer surfaces, an already-decayed confidence is a fixed point,
 * and an already-archived file is not a candidate. The refusal names the overlap (issue #108), so an
 * operator can tell a real collision from two writers sharing a schedule slot.
 *
 * A PROVABLY DISJOINT advance merges. Any writer committing to main during the sleep's multi-hour
 * window would otherwise forfeit the whole night at merge time, and a schedule collision is exactly
 * the case where the two writers touch unrelated paths. Disjointness makes the semantic objection
 * above empty — nothing the run decided reads a path main changed — and makes a conflict impossible,
 * so nobody hand-edits generated `sitemap.xml`. An unmoved main still fast-forwards with no merge
 * commit; a disjoint advance lands as a merge commit that preserves both sides, with a conflict —
 * unreachable if disjointness held — aborted and refused rather than left in progress.
 *
 * **The merge is also where the run's PENDING STATE-PLANE MARKS are applied**, and that is what makes
 * `git branch -D` a real abort. `.memhtml/state.db` is not rebuildable from the tree and
 * `trace_consolidations` outlives an index rebuild, so a state-plane row written during a phase
 * survives the discard of the branch that earned it — for the consolidation watermark that is content
 * loss, because the watermark is an anti-join and the session it covers is never selected again. So a
 * phase records each such write in `pendingMarksPath(runId)`, a committed artifact on the branch, and
 * {@link applyMarks} performs them here, once the memories they describe are on `main`.
 *
 * **The merge ends by projecting the merged commit into the index** ({@link reindex}, issue #145).
 * The index describes one commit and this merge produced a new one, so until `index_state.head_sha`
 * names it, every memory the run distilled, rewrote, or archived is invisible to `search` and a
 * long-lived `serve mcp` over the same `index.db` serves the pre-merge projection. The report
 * carries the update's counts beside `headSha`, so a cron log answers "is it searchable" without a
 * second command.
 */
export const merge = (
  deps: SleepDeps,
  runId: string | undefined,
  options: MergeOptions = {}
): Effect.Effect<MergeReport, never, never> =>
  Effect.gen(function* () {
    const target = options.targetBranch ?? "main"
    const row = yield* resolveRun(deps, runId)
    if (row === undefined) {
      return {
        runId: runId ?? "",
        branch: runId ?? "",
        merged: false,
        headSha: "",
        refusal: "no-run" as const
      }
    }

    yield* deps.git.checkoutBranch(target).pipe(Effect.orElseSucceed(() => {}))
    const mainHead = yield* deps.git
      .revParseHead()
      .pipe(Effect.orElseSucceed(() => null))
      .pipe(Effect.map((sha) => sha ?? ""))

    const advanced = row.base_sha !== "" && mainHead !== row.base_sha
    if (advanced) {
      const overlap = yield* Effect.result(advanceOverlap(deps, row.base_sha, mainHead, row.branch))
      if (overlap._tag === "Failure") {
        // Disjointness is a positive proof, and a diff that cannot be read is not one.
        yield* Effect.logWarning(
          `sleep.merge refused: ${target} advanced past the run's base and the touched sets ` +
            `could not be read — rerun the sleep`
        )
        return {
          runId: row.run_id,
          branch: row.branch,
          merged: false,
          headSha: mainHead,
          refusal: "main-advanced" as const
        }
      }
      if (overlap.success.length > 0) {
        const named = overlap.success.slice(0, 5).join(", ")
        const rest = overlap.success.length > 5 ? ` and ${overlap.success.length - 5} more` : ""
        yield* Effect.logWarning(
          `sleep.merge refused: ${target} advanced past the run's base and the advance overlaps ` +
            `the branch (${named}${rest}) — rerun the sleep`
        )
        return {
          runId: row.run_id,
          branch: row.branch,
          merged: false,
          headSha: mainHead,
          refusal: "main-advanced" as const,
          overlap: overlap.success
        }
      }
      yield* Effect.log(
        `sleep.merge: ${target} advanced past the run's base on paths disjoint from the branch; ` +
          `merging both sides`
      )
    }

    if (options.preMergeGate !== undefined) {
      const gate = yield* Effect.result(options.preMergeGate)
      if (gate._tag === "Failure") {
        yield* Effect.logWarning(`sleep.merge refused: pre-merge gate failed`)
        return {
          runId: row.run_id,
          branch: row.branch,
          merged: false,
          headSha: mainHead,
          refusal: "gate-failed" as const
        }
      }
    }

    const landed = yield* Effect.result(
      advanced ? mergeBothSides(deps, row.branch) : deps.git.mergeFastForward(row.branch)
    )
    if (landed._tag === "Failure") {
      return {
        runId: row.run_id,
        branch: row.branch,
        merged: false,
        headSha: mainHead,
        refusal: "main-advanced" as const
      }
    }

    const merged = yield* deps.git
      .revParseHead()
      .pipe(Effect.orElseSucceed(() => null))
      .pipe(Effect.map((sha) => sha ?? mainHead))

    const marks = yield* applyMarks(deps, row)

    /**
     * The row this writes is a FINISHED run, whatever state it was read in. A run killed after its
     * first `recordRun` sits at `running` with `ended_at` NULL, and nothing above reads status, so an
     * operator can land that branch; the merge is then the run's end, and `ended_at` takes the merge's
     * own instant (issue #146). A timestamp column takes a timestamp: the merge sha is a different
     * fact and already sits in `head_sha`.
     */
    const endedAt = row.ended_at ?? (yield* nowIso)
    yield* recordRun(deps.db, {
      runId: row.run_id,
      branch: row.branch,
      baseSha: row.base_sha,
      headSha: merged,
      status: "merged",
      startedAt: row.started_at,
      endedAt
    }).pipe(Effect.catchCause(() => Effect.void))

    /**
     * AFTER the run row, on purpose. The update includes the night's embedding pass, which can take
     * minutes against Bedrock, and a process killed inside it must leave a row that says `merged`:
     * `main` has moved, so the run IS merged, and the index is a projection an operator can redo. A
     * row still saying `review` would make the next `sleep merge <id>` read `main` as advanced past
     * the run's base, find the branch's own paths in the overlap, and refuse `main-advanced` forever.
     */
    const index = yield* reindex(deps, merged)

    return {
      runId: row.run_id,
      branch: row.branch,
      merged: true,
      headSha: merged,
      marksPending: marks.pending,
      marksApplied: marks.applied,
      ...index
    }
  }).pipe(Effect.withSpan("sleep.merge"))

/** What {@link reindex} adds to a merge that happened: the projection landed, or why it did not. */
type IndexOutcome =
  | {
      readonly indexUpdated: true
      readonly indexHeadSha: string
      readonly indexAdded: number
      readonly indexModified: number
      readonly indexRemoved: number
      readonly indexRenamed: number
      readonly embeddingsWritten: number
      readonly indexSkipped: number
    }
  | { readonly indexUpdated: false; readonly indexError: string }

/**
 * Project the merged commit into the index, and report what that took.
 *
 * An incremental `update` rather than a rebuild: the watermark is the pre-merge commit, so the diff
 * is exactly the run's own writes, renames tracked and new canonicals embedded, and its cost is the
 * size of the night rather than the size of the store.
 *
 * **A failed update does NOT fail the merge**, on the reasoning {@link applyMarks} follows: `main`
 * has already moved and the memories are landed, so the outcome is reported (`indexUpdated: false`
 * with `indexError`) and logged with its recovery, instead of a merge that reports failure over a
 * `main` that moved. Each failure has one recovery and the warning names it. `IndexStale` is a
 * rebuild that died mid-way and `EmbedModelMismatch` is a vector space the configured model does not
 * match; `memhtml index rebuild --embed` is the one path past either guard. A `StorageFailure` is
 * a transient the next `memhtml index update --embed` retries.
 */
const reindex = (deps: SleepDeps, headSha: string): Effect.Effect<IndexOutcome, never, never> =>
  deps.indexer.update({ embed: true }).pipe(
    /**
     * A skipped file is on `main` and absent from the index, so `indexUpdated: true` alone would
     * stand over a merged memory nobody can search. The count travels on the report as preflight's
     * `indexSkipped` does, and the paths go to the log, where `memhtml doctor` is the reader's next step.
     */
    Effect.tap((update) => {
      if (update.skipped.length === 0) return Effect.void
      const named = update.skipped
        .slice(0, 5)
        .map((one) => `${one.path} (${one.reason})`)
        .join(", ")
      const rest = update.skipped.length > 5 ? ` and ${update.skipped.length - 5} more` : ""
      return Effect.logWarning(
        `sleep.merge indexed ${headSha} with ${String(update.skipped.length)} file(s) skipped: ` +
          `${named}${rest}; they are on main and not in the index; run memhtml doctor`
      )
    }),
    Effect.map(
      (update): IndexOutcome => ({
        indexUpdated: true,
        indexHeadSha: update.headSha,
        indexAdded: update.added,
        indexModified: update.modified,
        indexRemoved: update.removed,
        indexRenamed: update.renamed,
        embeddingsWritten: update.embeddingsWritten,
        indexSkipped: update.skipped.length
      })
    ),
    Effect.catch((error) => {
      const reason = describeIndexError(error)
      const recovery =
        error._tag === "StorageFailure"
          ? "memhtml index update --embed"
          : "memhtml index rebuild --embed"
      return Effect.logWarning(
        `sleep.merge landed ${headSha} on main but the index still describes the pre-merge ` +
          `commit: ${reason}; run ${recovery}`
      ).pipe(Effect.as<IndexOutcome>({ indexUpdated: false, indexError: reason }))
    })
  )

/** One line an operator can act on, per failure the indexer's `update` can raise. */
const describeIndexError = (error: StorageFailure | EmbedModelMismatch | IndexStale): string => {
  switch (error._tag) {
    case "IndexStale":
      return `IndexStale: ${error.reason}`
    case "EmbedModelMismatch":
      return `EmbedModelMismatch: index holds ${error.stored}, configured ${error.configured}`
    case "StorageFailure":
      return `StorageFailure: ${error.operation}`
  }
}

/**
 * The paths BOTH sides touched since the base, sorted. Empty is the proof a disjoint merge needs.
 *
 * Full `diff` on each side rather than the sweep-scoped {@link touchedThisRun} set: a sweep's
 * restamp says nothing about the individual file as a DECISION, but it is still a write, and a
 * path-level disjointness check is only safe if it sees every write — the integrity phase
 * regenerates artifacts whose sources another writer may have just touched. Renames contribute both
 * of their paths on the same reasoning as {@link touched.ts}'s widened set.
 */
const advanceOverlap = (
  deps: SleepDeps,
  baseSha: string,
  mainHead: string,
  branch: string
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.gen(function* () {
    const gained = yield* touchedBetween(deps, baseSha, mainHead)
    const wrote = yield* touchedBetween(deps, baseSha, branch)
    return [...gained].filter((path) => wrote.has(path)).sort()
  })

/** Every path `from..to` touched, both halves of a rename included. */
const touchedBetween = (
  deps: SleepDeps,
  from: string,
  to: string
): Effect.Effect<ReadonlySet<string>, unknown> =>
  deps.git.diffNameStatus(from, to).pipe(
    Effect.map((changes) => {
      const paths = new Set<string>()
      for (const change of changes) {
        paths.add(change.path)
        if (change.fromPath !== null) paths.add(change.fromPath)
      }
      return paths
    })
  )

/**
 * Land a disjoint advance as a merge commit, with a conflict aborted rather than left in progress.
 *
 * A conflict is unreachable when {@link advanceOverlap} returned empty — git conflicts on a path
 * both sides changed — so this arm exists for the same reason `merge --abort` does: the working
 * tree must never be left mid-merge on a path this code did not predict.
 */
const mergeBothSides = (deps: SleepDeps, branch: string): Effect.Effect<void, unknown> =>
  deps.git.merge(branch).pipe(
    Effect.flatMap((outcome) =>
      outcome.merged
        ? Effect.void
        : deps.git.mergeAbort().pipe(
            Effect.orElseSucceed(() => {}),
            Effect.andThen(Effect.fail(`merge conflicted: ${outcome.conflicted.join(", ")}`))
          )
    )
  )

/**
 * Apply the merged run's pending state-plane marks, from the ledger the branch carries.
 *
 * **The ledger is read as a BLOB at the branch tip, not off the working tree.** What earns the writes is
 * what the branch committed, and a working-tree read would also honour an uncommitted file — including
 * one a discarded run of the same date left behind, which is precisely the mark this design refuses to
 * apply. A run that earned no marks has no such blob at all, and `git show` failing for that is the
 * ordinary case rather than an error.
 *
 * **A failed apply does NOT fail the merge, and the direction is deliberate.** `main` has already moved
 * and the memories are landed; every mark is a bookkeeping write whose absence costs a repeat rather
 * than a loss — an unwatermarked session is re-read next cycle at the price of a model call and a
 * duplicate candidate a reviewer declines, and an unpromoted counter leaves its pair re-eligible. So
 * the shortfall is reported (`marksPending` above `marksApplied`) and logged, which is a state an
 * operator can read, instead of a merge that reports failure over a `main` that moved.
 */
const applyMarks = (
  deps: SleepDeps,
  row: RunRow
): Effect.Effect<{ readonly pending: number; readonly applied: number }, never, never> =>
  Effect.gen(function* () {
    const contents = yield* blobText(deps, `${row.branch}:${pendingMarksPath(row.run_id)}`)
    if (contents === undefined) return { pending: 0, applied: 0 }

    const ledger = parsePendingMarks(contents)
    if (ledger.skipped > 0) {
      yield* Effect.logWarning(
        `sleep.merge could not read ${String(ledger.skipped)} pending mark(s) of ${row.run_id}; ` +
          `their sessions stay unconsolidated and are re-read next cycle`
      )
    }
    const pending = ledger.marks.length + ledger.skipped
    const applied = yield* applyPendingMarks(deps.db, ledger.marks).pipe(
      Effect.catch((error) =>
        Effect.logError(
          `sleep.merge could not apply ${row.run_id}'s pending marks: ${error.operation}`
        ).pipe(Effect.as(0))
      )
    )
    return { pending, applied }
  })

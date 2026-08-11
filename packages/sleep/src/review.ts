import { isArchivePath } from "@memhtml/contracts/paths"
import { contentHash } from "@memhtml/html"
import { Effect } from "effect"

import type {
  FileClassification,
  MergeReport,
  PhaseResult,
  ReviewCommit,
  ReviewReport,
  SleepPhase
} from "./contract.js"
import { isSleepPhase, TRAILER_COUNTS, TRAILER_PHASE } from "./contract.js"
import type { SleepDeps } from "./env.js"
import { parseCounts } from "./run.js"
import { latestRun, type RunRow, readPhases, readRun, recordRun } from "./sql.js"

/**
 * `review` and `merge`: what a human reads before a sleep branch lands, and the two refusals that
 * stop it landing badly.
 *
 * A sleep run is not trusted because it succeeded. It is trusted because a reviewer can see what it
 * did — which files changed, whether the change was a meta stamp or a rewritten claim, and which
 * phases failed — and because the merge refuses on two independent grounds: `main` having moved, and
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
 * nothing about whether those lines were a confidence stamp or the memory's claim — and the whole
 * reason head edits go through byte-splicing editors is so that distinction is REAL: a meta-only
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
 * Read with `logTrailers`, one call per key, rather than by grepping `%B`. The trailer values can carry
 * colons and commas — `Memhtml-Counts` is JSON — and `%(trailers:key=…,valueonly)` returns them verbatim
 * while a `grep '^Memhtml-Phase:'` over a message body would also match a line inside a memory title that
 * happened to start that way.
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
 * A rename is `archived` regardless of similarity score — eviction IS a `git mv` into
 * `archive/<YYYY>/`, and the year-partitioned path is what says so. Nothing here reads the score: an
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
   * A gate that must succeed before `main` moves. T10 wires the discrimination eval here: a sleep run
   * that degrades retrieval quality cannot land, and the refusal is the point.
   *
   * Absent means no gate. That is a deliberate default rather than a permissive one — this package
   * cannot import the eval without depending on it, so the composition belongs to the CLI, and a
   * missing gate has to be visible in the caller's own wiring rather than silently supplied here.
   */
  readonly preMergeGate?: Effect.Effect<void, unknown> | undefined
  /** The branch to fast-forward. Defaults to `main`. */
  readonly targetBranch?: string | undefined
}

/**
 * Fast-forward the target branch to the sleep branch, or refuse.
 *
 * **Two refusals, both before anything moves.** `main` having advanced past `base_sha` means the run
 * curated a corpus that no longer exists: a decay computed against a confidence an agent has since
 * corrected, an eviction of a memory that was just reinforced. The operator reruns the sleep, which is
 * cheap because every phase is idempotent — an already-merged duplicate no longer surfaces, an
 * already-decayed confidence is a fixed point, an already-archived file is not a candidate.
 *
 * Fast-forward only, never a merge commit. A three-way merge here would produce a commit whose parents
 * are the sleep branch and a moved `main`, which is exactly the state the first refusal exists to
 * prevent — and the conflict resolution would be a human editing generated `sitemap.xml` by hand.
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

    if (row.base_sha !== "" && mainHead !== row.base_sha) {
      yield* Effect.logWarning(
        `sleep.merge refused: ${target} advanced past the run's base — rerun the sleep`
      )
      return {
        runId: row.run_id,
        branch: row.branch,
        merged: false,
        headSha: mainHead,
        refusal: "main-advanced" as const
      }
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

    const fastForward = yield* Effect.result(deps.git.mergeFastForward(row.branch))
    if (fastForward._tag === "Failure") {
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

    yield* recordRun(deps.db, {
      runId: row.run_id,
      branch: row.branch,
      baseSha: row.base_sha,
      headSha: merged,
      status: "merged",
      startedAt: row.started_at,
      endedAt: row.ended_at ?? merged
    }).pipe(Effect.catchCause(() => Effect.void))

    return { runId: row.run_id, branch: row.branch, merged: true, headSha: merged }
  }).pipe(Effect.withSpan("sleep.merge"))

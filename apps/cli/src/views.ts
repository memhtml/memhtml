import { InvalidMemory } from "@memhtml/contracts/errors"
import { DatabaseService, type DatabaseShape, readIndexState } from "@memhtml/index"
import { EMBED_WATERMARK } from "@memhtml/llm"
import { isSleepPhase, type RunReport, SLEEP_PHASES, type SleepPhase } from "@memhtml/sleep"
import { Effect } from "effect"

/**
 * Response shaping: the few places a payload is not simply the use case's own return value.
 *
 * Kept out of the dispatcher so an arm stays one call. Each function here exists because a wire
 * shape and an internal shape genuinely differ — a report that must not carry an unbounded field, a
 * flag list that must be validated against a closed vocabulary before it reaches a runner.
 */

/**
 * The index's own report of itself: the watermark, the vector space, and the row counts.
 *
 * `memhtml index status` reads this rather than running an indexer method, because "what does the index
 * currently contain" must be answerable without the git subprocess an `update` would spawn — an
 * operator asking about a stale index is frequently asking BECAUSE something is wrong with the repo.
 */
export const indexReport = () =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const state = yield* readIndexState(db).pipe(Effect.orElseSucceed(() => undefined))

    return {
      mode: "status",
      headSha: state?.head_sha ?? null,
      embedModel: state?.embed_model ?? null,
      embedDim: state?.embed_dim ?? null,
      /**
       * True when the stored vector space IS the configured one. A mismatch is not a warning — the
       * indexer refuses to write against it — so reporting the two values separately lets an
       * operator see which side to change.
       */
      embedModelMatches: state?.embed_model === EMBED_WATERMARK,
      configuredEmbedModel: EMBED_WATERMARK,
      rebuiltAt: state?.rebuilt_at ?? null,
      updatedAt: state?.updated_at ?? null,
      files: yield* count(db, "SELECT count(*) AS n FROM files"),
      activeFiles: yield* count(db, "SELECT count(*) AS n FROM files WHERE archived = 0"),
      chunks: yield* count(db, "SELECT count(*) AS n FROM chunks"),
      embeddings: yield* count(db, "SELECT count(*) AS n FROM embeddings"),
      edges: yield* count(db, "SELECT count(*) AS n FROM edges"),
      derivedEdges: yield* count(db, "SELECT count(*) AS n FROM edges WHERE derived = 1"),
      tags: yield* count(db, "SELECT count(DISTINCT tag) AS n FROM file_tags"),
      entities: yield* count(
        db,
        "SELECT count(DISTINCT entity_type || ':' || entity_name) AS n FROM file_entities"
      ),
      traces: yield* count(db, "SELECT count(*) AS n FROM traces"),
      hasState: db.hasState
    }
  })

const count = (db: DatabaseShape, sql: string) =>
  db.get<{ n: number }>(sql).pipe(
    Effect.map((row) => row?.n ?? 0),
    Effect.orElseSucceed(() => 0)
  )

/**
 * A `--phases` value as a validated phase list, or `undefined` for "all fifteen".
 *
 * An unknown phase is a refusal rather than a silent drop. A run asked for `--phases dedup,compress`
 * with a typo in the first name would otherwise execute only the second — and `dedup-merge` is a
 * HARD prerequisite of `compress`, so the typo would produce a compress pass over a corpus that
 * still holds its duplicates.
 */
export const sleepPhases = (
  raw: string | undefined
): Effect.Effect<ReadonlyArray<SleepPhase> | undefined, InvalidMemory> => {
  if (raw === undefined || raw.trim() === "") return Effect.succeed(undefined)
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")

  const unknown = names.filter((name) => !isSleepPhase(name))
  if (unknown.length > 0) {
    return Effect.fail(
      InvalidMemory.make({
        reason: `unknown sleep phase: ${unknown.join(", ")}. One of: ${SLEEP_PHASES.join(", ")}`
      })
    )
  }

  // Canonical order, not the caller's. The order encodes real dependencies — decay before triage so
  // triage scores the decayed value — and honouring a caller's ordering would let a `--phases` value
  // silently invert them.
  return Effect.succeed(SLEEP_PHASES.filter((phase) => names.includes(phase)))
}

/**
 * A run report on the wire.
 *
 * Identical to the internal shape except for `llmCalls`, which is summed per phase AND totalled — a
 * caller auditing Bedrock spend reads the total, and one debugging a phase reads the per-phase
 * number, and deriving either from the other at the call site is how two consumers end up disagreeing
 * about what a number counts.
 */
export const sleepRunReport = (report: RunReport) => ({
  runId: report.runId,
  branch: report.branch,
  baseSha: report.baseSha,
  headSha: report.headSha,
  dryRun: report.dryRun,
  llmCalls: report.llmCalls,
  phases: report.phases,
  /** Phases that ended `failed`. Present so a caller does not have to filter to know. */
  failedPhases: report.phases.flatMap((phase) => (phase.status === "failed" ? [phase.phase] : [])),
  commits: report.phases.flatMap((phase) => (phase.commitSha === null ? [] : [phase.commitSha]))
})

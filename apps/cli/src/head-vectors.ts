import type { HeadView } from "@memhtml/contracts"
import { ModelUnavailable, type StorageFailure } from "@memhtml/contracts/errors"
import {
  emptyVectorCache,
  type FillCounts,
  fillVectors,
  type HeadVectors,
  type VectorCache,
  type VectorSpace
} from "@memhtml/head"
import { EMBED_DIM, EMBED_MODEL_ID, EMBED_WATERMARK } from "@memhtml/llm"
import { ensureExcludedQuietly } from "@memhtml/session"
import {
  readVectorCache,
  VECTORS_DIR,
  vectorCachePathFor,
  writeVectorCache
} from "@memhtml/snapshot"
import { Duration, Effect, Fiber, Option, type Result } from "effect"

import type { EmbedderShape } from "./api-layer.js"

/**
 * The vector arm's disk half (`docs/v2-poc.md`, "Vector arm"): the one cache file the CLI reads and
 * writes, `head embed` filling it, and the degraded answer every searching arm gives when the arm
 * cannot run.
 *
 * The space is the configured embedder's, `@memhtml/llm`'s model id at its dimension, the same pair
 * v1's `EMBED_WATERMARK` names, so the file for Cohere Embed v4 at 1024 floats is
 * `.memhtml/vectors/cohere.embed-v4_0@1024.arrow`. The deterministic fake a test binds produces
 * vectors of that width too, and writes that file inside its own temp repo.
 */

/** The configured embedder's vector space. */
export const HEAD_VECTOR_SPACE: VectorSpace = { modelId: EMBED_MODEL_ID, dimension: EMBED_DIM }

/** The cache file for {@link HEAD_VECTOR_SPACE} under `root`. */
export const headVectorsPath = (root: string): string => vectorCachePathFor(root, HEAD_VECTOR_SPACE)

/**
 * Why a search ran without the vector arm. `embedder-off` is `MEMHTML_EMBED=off`; `no-cache` is a
 * store nobody has run `head embed` on; `cache-unreadable` is a file the reader refused (corrupt,
 * truncated, or another space's); `embed-failed` is the query's (or the put's) embed call failing;
 * `embed-timeout` is the query's embed still running when its deadline passed.
 */
export type VectorSkipReason =
  | "embedder-off"
  | "no-cache"
  | "cache-unreadable"
  | "embed-failed"
  | "embed-timeout"

/**
 * A deadline value as the variable or a request states it: a whole number of milliseconds, `0` for
 * none, or the reason it is neither.
 */
export const parseDeadlineMs = (
  raw: string
): { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly reason: string } => {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) {
    return { ok: false, reason: "expected a whole number of milliseconds, 0 for none" }
  }
  const ms = Number(text)
  return Number.isSafeInteger(ms)
    ? { ok: true, ms }
    : { ok: false, reason: "the number is too large" }
}

/**
 * What becomes of a query embed still running when its deadline passes: `kept` to finish in the
 * background, or `stopped`. The search has already answered by the time this runs, so it must not
 * wait for the embed; it decides and returns.
 */
export type LateEmbed = (
  embed: Fiber.Fiber<Float32Array, ModelUnavailable>
) => Effect.Effect<"kept" | "stopped">

/**
 * The default {@link LateEmbed}: interrupt the embed (which aborts its request) in a fiber of its
 * own, so the caller never waits for the interruption to land.
 */
export const stopLateEmbed: LateEmbed = (embed) =>
  Fiber.interrupt(embed).pipe(
    Effect.forkDetach({ startImmediately: true }),
    Effect.as("stopped" as const)
  )

/**
 * What a searching payload reports about the vector arm. `used: false` names the reason and never
 * fails the search: the lexical arm answers either way.
 */
export interface VectorUse {
  readonly used: boolean
  readonly reason: VectorSkipReason | null
  /** The failure's own words for `cache-unreadable` and `embed-failed`; otherwise `null`. */
  readonly detail: string | null
  /** Vectors in the cache that was read, or `null` when none was. */
  readonly cached: number | null
  /** Share of the view's active records whose content hash has a vector, or `null` with no cache. */
  readonly coverage: number | null
  /**
   * Milliseconds reading the cache file, or `null` when it was not read. 0 from the head server,
   * which holds the cache and read no file for the answer.
   */
  readonly loadMs: number | null
  /** Milliseconds in the embed call for the query (or the puts), or `null` when none was made. */
  readonly embedMs: number | null
}

/** A `VectorUse` for an arm that did not run, with whatever was measured before it stopped. */
export const skippedUse = (
  reason: VectorSkipReason,
  rest: Partial<Omit<VectorUse, "used" | "reason">> = {}
): VectorUse => ({
  used: false,
  reason,
  detail: rest.detail ?? null,
  cached: rest.cached ?? null,
  coverage: rest.coverage ?? null,
  loadMs: rest.loadMs ?? null,
  embedMs: rest.embedMs ?? null
})

/** Share of `view`'s active records whose content hash `vectors` holds; 0 over an empty view. */
export const coverageOf = (view: HeadView, vectors: HeadVectors): number => {
  let active = 0
  let covered = 0
  for (const record of view.records()) {
    if (record.archived) continue
    active += 1
    if (vectors.get(record.contentHash) !== undefined) covered += 1
  }
  return active === 0 ? 0 : covered / active
}

/**
 * The cache as a search finds it: read, with what reading it cost, or the reason it could not be.
 * A CLI call reads the file for itself ({@link loadForSearch}); the head server holds one of these
 * and hands it over with `loadMs` 0, since the answer read nothing (`head-server.ts`).
 */
export type CacheRead =
  | { readonly ok: true; readonly cache: VectorCache; readonly loadMs: number }
  | { readonly ok: false; readonly use: VectorUse }

/** The cache under `root` read for a search, or the reason it could not be. Never fails. */
export const loadForSearch = (root: string): Effect.Effect<CacheRead> =>
  Effect.gen(function* () {
    const started = Date.now()
    const read = yield* Effect.result(readVectorCache(headVectorsPath(root), HEAD_VECTOR_SPACE))
    const loadMs = Date.now() - started
    if (read._tag === "Failure") {
      return {
        ok: false as const,
        use: skippedUse("cache-unreadable", { detail: read.failure.operation, loadMs })
      }
    }
    if (read.success === null)
      return { ok: false as const, use: skippedUse("no-cache", { loadMs }) }
    return { ok: true as const, cache: read.success, loadMs }
  })

/** What {@link vectorsForQuery} hands a search: the options to spread into `searchHead`, and the report. */
export interface QueryVectors {
  readonly search: { readonly vectors?: HeadVectors; readonly queryVector?: Float32Array }
  readonly use: VectorUse
}

/**
 * The query's embed, bounded by `deadlineMs` when it is a positive number. The embed runs in a fiber
 * of its own and the wait is on joining it, so a deadline that passes interrupts only the join and
 * returns at once: the answer never waits for the embed, not even for its interruption to land.
 * What happens to the embed then is `late`'s decision, and its answer is the `late` field.
 */
const embedWithin = (
  embed: Effect.Effect<Float32Array, ModelUnavailable>,
  deadlineMs: number | null,
  late: LateEmbed
): Effect.Effect<
  | { readonly done: true; readonly result: Result.Result<Float32Array, ModelUnavailable> }
  | { readonly done: false; readonly late: "kept" | "stopped" }
> =>
  Effect.gen(function* () {
    if (deadlineMs === null || deadlineMs <= 0) {
      return { done: true as const, result: yield* Effect.result(embed) }
    }
    const fiber = yield* Effect.forkDetach(embed, { startImmediately: true })
    const joined = yield* Effect.result(Fiber.join(fiber)).pipe(
      Effect.timeoutOption(Duration.millis(deadlineMs))
    )
    if (Option.isSome(joined)) return { done: true as const, result: joined.value }
    return { done: false as const, late: yield* late(fiber) }
  })

/**
 * The vector arm's inputs for one `head search` query, or the reason there are none. The order of
 * the checks is the order of their cost: the embedder switch reads nothing, the cache read touches
 * the disk, and only a store with both pays for the `embedQuery` call. `cache` is run only past the
 * switch: {@link loadForSearch} for a CLI call, the held cache for the head server.
 *
 * `deadlineMs` bounds the query embed (`null` or `0`: no bound). Past it the arm is skipped with
 * `embed-timeout` and the search answers on the lexical arm; `late` decides what becomes of the
 * embed still running ({@link stopLateEmbed} when absent, which the CLI uses because its process
 * exits after the answer; the head server keeps one to finish, `head-server.ts`).
 */
export const vectorsForQuery = (input: {
  readonly cache: Effect.Effect<CacheRead>
  readonly view: HeadView
  readonly query: string
  readonly embedder: EmbedderShape
  readonly deadlineMs?: number | null | undefined
  readonly late?: LateEmbed | undefined
}): Effect.Effect<QueryVectors> =>
  Effect.gen(function* () {
    const port = input.embedder.query
    if (port === undefined) return { search: {}, use: skippedUse("embedder-off") }
    const loaded = yield* input.cache
    if (!loaded.ok) return { search: {}, use: loaded.use }
    const { cache, loadMs } = loaded
    const coverage = coverageOf(input.view, cache.vectors)
    const started = Date.now()
    const deadlineMs = input.deadlineMs ?? null
    const within = yield* embedWithin(
      port.embedQuery(input.query),
      deadlineMs,
      input.late ?? stopLateEmbed
    )
    const embedMs = Date.now() - started
    if (!within.done) {
      return {
        search: {},
        use: skippedUse("embed-timeout", {
          detail: `the query embed was still running at its ${String(deadlineMs)} ms deadline; ${within.late === "kept" ? "left to finish in the background" : "stopped"}`,
          cached: cache.vectors.size,
          coverage,
          loadMs,
          embedMs
        })
      }
    }
    const embedded = within.result
    if (embedded._tag === "Failure") {
      return {
        search: {},
        use: skippedUse("embed-failed", {
          detail: embedded.failure.reason,
          cached: cache.vectors.size,
          coverage,
          loadMs,
          embedMs
        })
      }
    }
    return {
      search: { vectors: cache.vectors, queryVector: embedded.success },
      use: {
        used: true,
        reason: null,
        detail: null,
        cached: cache.vectors.size,
        coverage,
        loadMs,
        embedMs
      }
    }
  })

/** What {@link vectorsForPuts} hands `session put`: the cache, one vector per text, and the report. */
export interface PutVectors {
  readonly vectors: HeadVectors | null
  readonly perPut: ReadonlyArray<Float32Array> | null
  readonly use: VectorUse
}

/**
 * The vector arm's inputs for a `session put`'s neighbors: the cache plus each put's own text
 * embedded as a DOCUMENT (`embed`, one call for the batch), because a put is compared with stored
 * documents, not asked as a question. Degrades the way {@link vectorsForQuery} does.
 */
export const vectorsForPuts = (input: {
  readonly cache: Effect.Effect<CacheRead>
  readonly view: HeadView
  readonly texts: ReadonlyArray<string>
  readonly embedder: EmbedderShape
}): Effect.Effect<PutVectors> =>
  Effect.gen(function* () {
    const none = (use: VectorUse): PutVectors => ({ vectors: null, perPut: null, use })
    const port = input.embedder.document
    if (port === undefined) return none(skippedUse("embedder-off"))
    const loaded = yield* input.cache
    if (!loaded.ok) return none(loaded.use)
    const { cache, loadMs } = loaded
    const coverage = coverageOf(input.view, cache.vectors)
    const started = Date.now()
    const embedded = yield* Effect.result(port.embed(input.texts))
    const embedMs = Date.now() - started
    if (embedded._tag === "Failure") {
      return none(
        skippedUse("embed-failed", {
          detail: embedded.failure.reason,
          cached: cache.vectors.size,
          coverage,
          loadMs,
          embedMs
        })
      )
    }
    return {
      vectors: cache.vectors,
      perPut: embedded.success,
      use: {
        used: true,
        reason: null,
        detail: null,
        cached: cache.vectors.size,
        coverage,
        loadMs,
        embedMs
      }
    }
  })

/** What `head embed` reports. */
export interface HeadEmbedded extends FillCounts {
  readonly path: string
  readonly modelId: string
  readonly dimension: number
  /** Vectors in the cache after this call, including ones for records no longer in the view. */
  readonly cached: number
  /** The cache file's size after this call. */
  readonly bytes: number
  /** False when every active record was already covered, so the file was left as it was. */
  readonly written: boolean
  /** Reading the existing cache. */
  readonly loadMs: number
  /** The embed call. */
  readonly embedMs: number
  /** Writing the cache file, 0 when nothing was written. */
  readonly saveMs: number
  /** The whole fill, load to save. */
  readonly ms: number
}

/**
 * `head embed`'s work over a loaded view: read the cache (an absent file is an empty cache), embed
 * the active records it lacks, and write the file back when anything was added. No document
 * embedder (`MEMHTML_EMBED=off`) is `ModelUnavailable`, since filling the cache is the whole call; a
 * cache the reader refuses is its `StorageFailure`, left for the operator to delete, because the
 * file may belong to another space whose name sanitizes to the same one.
 */
export const embedHead = (input: {
  readonly root: string
  readonly view: HeadView
  readonly embedder: EmbedderShape
}): Effect.Effect<HeadEmbedded, ModelUnavailable | StorageFailure> =>
  Effect.gen(function* () {
    const port = input.embedder.document
    if (port === undefined) {
      return yield* Effect.fail(
        ModelUnavailable.make({
          modelId: EMBED_WATERMARK,
          reason:
            "MEMHTML_EMBED=off: no document embedder is bound, so head embed has nothing to embed with"
        })
      )
    }
    const path = headVectorsPath(input.root)
    const started = Date.now()
    const existing = yield* readVectorCache(path, HEAD_VECTOR_SPACE)
    const loadMs = Date.now() - started
    const embedStarted = Date.now()
    const filled = yield* fillVectors({
      view: input.view,
      cache: existing ?? emptyVectorCache(HEAD_VECTOR_SPACE),
      embedder: port
    })
    const embedMs = Date.now() - embedStarted
    const unchanged = existing !== null && filled.counts.embedded === 0
    let bytes = existing?.bytes ?? 0
    let saveMs = 0
    if (!unchanged) {
      const saveStarted = Date.now()
      yield* ensureExcludedQuietly(input.root, [`${VECTORS_DIR}/`])
      const written = yield* writeVectorCache({ stored: filled.cache, path })
      saveMs = Date.now() - saveStarted
      bytes = written.bytes
    }
    return {
      path,
      modelId: HEAD_VECTOR_SPACE.modelId,
      dimension: HEAD_VECTOR_SPACE.dimension,
      ...filled.counts,
      cached: filled.cache.vectors.size,
      bytes,
      written: !unchanged,
      loadMs,
      embedMs,
      saveMs,
      ms: Date.now() - started
    }
  })

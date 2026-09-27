import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { Effect } from "effect"

/**
 * What the vector arm embeds, and how a cache of those vectors is filled.
 *
 * One vector per record, keyed by what was embedded: the record's content hash, inside a cache that
 * belongs to one vector space (an embedder's model id and dimension). The content hash digests the
 * `<article>` and nothing else, so the embedded text is drawn from the article and nothing else, and
 * an unchanged article reuses its vector across every version, every path it moves to, and every
 * head-only edit (`link`, `unlink`, a meta change). Filling is the only step that reaches a model,
 * and it lives here rather than in `searchHead`, which stays pure.
 */

/**
 * The longest text one record embeds, in characters: v1's `CHUNK_MAX_CHARS` (`@memhtml/index`).
 * Below it v1 embeds a record's whole article as chunk 0, which is the common case in a
 * one-fact-per-file corpus, so for those records the two stores embed the same text. v2 keeps one
 * vector per record rather than v1's chunks, so an article past the ceiling is cut, and the cut
 * keeps the opening, where the format puts the claim.
 */
export const VECTOR_TEXT_MAX_CHARS = 1_800

/**
 * The text a record embeds: its article's text (`bodyText`, which opens with the claim), trimmed and
 * cut at {@link VECTOR_TEXT_MAX_CHARS}.
 *
 * The title is left out on purpose. It lives in `<head>`, outside what the content hash digests, so
 * a vector that read it could go stale under a key that never changes: a retitled record would keep
 * the old title's vector. BM25 still reads the title, so a title match is not lost, only not
 * double-counted. The article is also what v1 embeds per chunk.
 */
export const vectorTextOf = (record: MemoryRecord): string =>
  record.bodyText.trim().slice(0, VECTOR_TEXT_MAX_CHARS)

/** One embedder's vector space. Two caches with different spaces hold incomparable vectors. */
export interface VectorSpace {
  readonly modelId: string
  readonly dimension: number
}

/** Vectors of one space, by content hash. */
export interface VectorCache {
  readonly space: VectorSpace
  readonly vectors: ReadonlyMap<string, Float32Array>
}

/** An empty cache in `space`, for a store that has none yet. */
export const emptyVectorCache = (space: VectorSpace): VectorCache => ({
  space,
  vectors: new Map()
})

/** The half of `@memhtml/llm`'s `EmbeddingsShape` a fill needs, structurally, so this package never imports it. */
export interface DocumentEmbedder<E> {
  readonly embed: (texts: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Float32Array>, E>
}

/** What one fill did, counted over the view's active records. */
export interface FillCounts {
  /** Active records in the view. */
  readonly records: number
  /** Active records whose content hash already had a vector. */
  readonly reused: number
  /** Distinct texts sent to `embed`; two active records sharing a content hash cost one. */
  readonly embedded: number
  /** Active records with no text to embed (an empty article), which the arm never ranks. */
  readonly empty: number
}

export interface FillResult {
  readonly cache: VectorCache
  readonly counts: FillCounts
}

/**
 * Embed every active record of `view` whose content hash `cache` lacks, in one `embed` call (which
 * chunks at the model's request ceiling and bounds its own concurrency), and return the cache with
 * the new vectors added beside every vector it already held.
 *
 * Archived records are not embedded, because the arm ranks active records only. Entries for hashes
 * the view no longer holds are kept: the cache serves every version of the store, and a record the
 * next branch or the next rebase brings back reuses its vector rather than paying for it twice.
 *
 * A vector of the wrong width is refused as a defect rather than stored, because one would make the
 * cache disagree with its own space and every cosine against it meaningless. `@memhtml/llm` already
 * refuses such a response as a `ModelUnavailable`, so this only fires for an embedder that is not
 * that one.
 */
export const fillVectors = <E>(input: {
  readonly view: HeadView
  readonly cache: VectorCache
  readonly embedder: DocumentEmbedder<E>
}): Effect.Effect<FillResult, E> =>
  Effect.gen(function* () {
    const { cache } = input
    let records = 0
    let reused = 0
    let empty = 0
    // Content hash to text. One hash is one article and so one text, which is why a hash shared by
    // two records (a copy under another path) is embedded once.
    const missing = new Map<string, string>()
    for (const record of input.view.records()) {
      if (record.archived) continue
      records += 1
      if (cache.vectors.has(record.contentHash)) {
        reused += 1
        continue
      }
      const text = vectorTextOf(record)
      if (text === "") {
        empty += 1
        continue
      }
      missing.set(record.contentHash, text)
    }
    if (missing.size === 0) {
      return { cache, counts: { records, reused, embedded: 0, empty } }
    }
    const hashes = [...missing.keys()]
    const vectors = yield* input.embedder.embed([...missing.values()])
    if (vectors.length !== hashes.length) {
      return yield* Effect.die(
        new Error(`embed returned ${vectors.length} vectors for ${hashes.length} texts`)
      )
    }
    const next = new Map(cache.vectors)
    for (const [index, hash] of hashes.entries()) {
      const vector = vectors[index]
      if (vector === undefined || vector.length !== cache.space.dimension) {
        return yield* Effect.die(
          new Error(
            `embed returned a vector of ${vector?.length ?? 0} dimensions for ${cache.space.modelId}@${cache.space.dimension}`
          )
        )
      }
      next.set(hash, vector)
    }
    return {
      cache: { space: cache.space, vectors: next },
      counts: { records, reused, embedded: hashes.length, empty }
    }
  })

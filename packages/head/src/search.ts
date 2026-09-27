import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { type ArmHit, cosine, DEFAULT_ARM_LIMIT, fuseArms, RRF_K } from "@memhtml/domain"
import { HashMap, Option } from "effect"

import { indexesOf } from "./indexes.js"
import type { LexicalIndex } from "./lexical.js"
import { tokenize } from "./lexical.js"

/**
 * Retrieval over one view: a lexical arm, a recency arm, and, when the caller passes vectors and a
 * query vector, a vector arm, fused with reciprocal rank fusion at `k = 60`, weights 1.0, 0.5, and
 * 1.0, over active records only.
 *
 * The lexical arm is BM25 (Robertson/Sparck Jones idf, `k1 = 1.2`, `b = 0.75`) over the title, the
 * claim, and the body, read from the version's persistent lexical index, and keeps the best
 * {@link LEXICAL_ARM_LIMIT}. The vector arm orders the active records that have a vector by cosine
 * against the query vector, brute force, and keeps the best {@link VECTOR_ARM_LIMIT}. The recency
 * arm orders the records those two arms kept by `eventAt ?? updatedAt`, the same key the v1 SQL arm
 * uses (see {@link recencyArm} for why it ranks only those). Every arm and the fused list break ties
 * on path ascending, so two runs over one view return the same list.
 *
 * The function stays pure: it never embeds. The caller owns the vectors (keyed by content hash, see
 * `vectors.ts`) and the query vector, so a search with neither is the two-arm search exactly.
 */

export type SearchArm = "lexical" | "recency" | "vector"

export interface SearchHit {
  readonly path: string
  readonly score: number
  readonly arms: ReadonlyArray<SearchArm>
  readonly claim: string
}

export const LEXICAL_WEIGHT = 1.0
export const RECENCY_WEIGHT = 0.5
/**
 * The vector arm's weight: v1's (`vectorArm` in `@memhtml/index` `retrieval-sql.ts`), so a read that
 * moves from v1 to v2 weighs a semantic match the way it did. v1 fuses four arms at 1.0 (lexical),
 * 1.0 (vector), 0.5 (recency), and 0.4 (salience); v2 has no salience arm, and dropping it leaves
 * the other three in the same proportion.
 */
export const VECTOR_WEIGHT = 1.0
/**
 * How many records the vector arm ranks: v1's `DEFAULT_ARM_LIMIT`. Cosine gives every embedded
 * record a score, so an uncapped arm would put a contribution on the whole corpus, most of it the
 * noise far down a similarity list, and `arms` would name `vector` on every hit. The cap keeps the
 * arm's vote to the records it is confident about, as v1's `LIMIT` does.
 */
export const VECTOR_ARM_LIMIT = DEFAULT_ARM_LIMIT
/**
 * How many records the lexical arm ranks: v1's `DEFAULT_ARM_LIMIT`, for the vector arm's reason.
 * BM25 scores every record that shares one token with the query, so uncapped the arm voted for
 * hundreds of records on the live clone, and each weak match collected RRF mass that a record
 * found by meaning alone could not: a paraphrase whose target was second in the vector arm ranked
 * it 31st overall (docs/v2-poc.md, "Vector arm").
 */
export const LEXICAL_ARM_LIMIT = DEFAULT_ARM_LIMIT
export const DEFAULT_LIMIT = 10

const BM25_K1 = 1.2
const BM25_B = 0.75

const byScoreThenPath = (
  left: { readonly path: string; readonly score: number },
  right: { readonly path: string; readonly score: number }
): number =>
  right.score - left.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

/**
 * BM25 over the query's tokens, capped at {@link LEXICAL_ARM_LIMIT}. Every document with at least
 * one matching token is scored; the best are kept.
 */
const lexicalArm = (lexical: LexicalIndex, query: string): ReadonlyArray<ArmHit> => {
  const documentCount = HashMap.size(lexical.lengths)
  if (documentCount === 0) return []
  const averageLength = lexical.totalLength / documentCount
  const scores = new Map<string, number>()
  for (const token of new Set(tokenize(query))) {
    const bucket = Option.getOrUndefined(HashMap.get(lexical.postings, token))
    if (bucket === undefined) continue
    const matching = HashMap.size(bucket)
    const idf = Math.log((documentCount - matching + 0.5) / (matching + 0.5) + 1)
    for (const [path, tf] of HashMap.entries(bucket)) {
      const length = Option.getOrElse(HashMap.get(lexical.lengths, path), () => averageLength)
      const normalized =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / (averageLength || 1)))
      scores.set(path, (scores.get(path) ?? 0) + idf * normalized)
    }
  }
  return [...scores.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort(byScoreThenPath)
    .slice(0, LEXICAL_ARM_LIMIT)
    .map((hit, index) => ({ path: hit.path, rank: index + 1 }))
}

/** The instant a record is ranked by for recency, clamped to `now` so a future date cannot lead. */
const recencyKey = (record: MemoryRecord, now: string | undefined): string => {
  const at = record.eventAt ?? record.updatedAt
  return now !== undefined && at > now ? now : at
}

/**
 * The records another arm kept, newest first. v1 ranks the newest 40 of the whole scope, which lifts
 * the same 40 records into every answer whatever the query asks; here recency orders only the
 * lexical and vector arms' candidates, so it breaks near-ties toward the newer record and never adds
 * one. The other two caps bound it, so it has none of its own: on the live clone's gate probes this
 * beat a global newest 40 on both paths, and a cap of 40 on the candidates cut their older half and
 * scored lower with the vector arm (docs/v2-poc.md, "Vector arm"). A query no arm matches returns
 * nothing.
 */
const recencyArm = (
  records: ReadonlyArray<MemoryRecord>,
  now: string | undefined
): ReadonlyArray<ArmHit> =>
  records
    .map((record) => ({ path: record.path, key: recencyKey(record, now) }))
    .sort(
      (left, right) =>
        (left.key < right.key ? 1 : left.key > right.key ? -1 : 0) ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    )
    .map((entry, index) => ({ path: entry.path, rank: index + 1 }))

/**
 * The active records that have a vector, by cosine against the query vector, best first, capped at
 * {@link VECTOR_ARM_LIMIT}. A record whose content hash has no vector is not in the arm; it can still
 * be found by the other two.
 */
const vectorArm = (
  records: ReadonlyArray<MemoryRecord>,
  vectors: HeadVectors,
  queryVector: ArrayLike<number>
): ReadonlyArray<ArmHit> =>
  records
    .flatMap((record) => {
      const vector = vectors.get(record.contentHash)
      return vector === undefined ? [] : [{ path: record.path, score: cosine(vector, queryVector) }]
    })
    .sort(byScoreThenPath)
    .slice(0, VECTOR_ARM_LIMIT)
    .map((hit, index) => ({ path: hit.path, rank: index + 1 }))

/**
 * Vectors by content hash, the key `vectors.ts` gives each one. A `ReadonlyMap` fits; so does any
 * lookup a long-lived head process holds, which is why the input is this narrow.
 */
export interface HeadVectors {
  get(contentHash: string): ArrayLike<number> | undefined
}

export interface SearchHeadInput {
  readonly query: string
  readonly limit?: number
  readonly now?: string
  /** Vectors by content hash. The vector arm runs only when this and `queryVector` are both set. */
  readonly vectors?: HeadVectors
  /** The query in the same vector space as `vectors`. */
  readonly queryVector?: ArrayLike<number>
}

export const searchHead = (view: HeadView, input: SearchHeadInput): ReadonlyArray<SearchHit> => {
  const indexes = indexesOf(view)
  const active = [...HashMap.values(indexes.records)].filter((record) => !record.archived)
  const lexical = lexicalArm(indexes.lexical, input.query)
  const vector =
    input.vectors === undefined || input.queryVector === undefined
      ? null
      : vectorArm(active, input.vectors, input.queryVector)
  const matched = new Set([...lexical, ...(vector ?? [])].map((hit) => hit.path))
  const recency = recencyArm(
    active.filter((record) => matched.has(record.path)),
    input.now
  )
  // With no vector arm the fold is the two-arm fold exactly, so a search without vectors is the
  // two-arm search, byte for byte.
  const fused =
    vector === null
      ? fuseArms([lexical, recency], [LEXICAL_WEIGHT, RECENCY_WEIGHT], RRF_K)
      : fuseArms([lexical, recency, vector], [LEXICAL_WEIGHT, RECENCY_WEIGHT, VECTOR_WEIGHT], RRF_K)
  const lexicalPaths = new Set(lexical.map((hit) => hit.path))
  const recencyPaths = new Set(recency.map((hit) => hit.path))
  const vectorPaths = new Set((vector ?? []).map((hit) => hit.path))
  const limit = input.limit ?? DEFAULT_LIMIT
  return [...fused.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort(byScoreThenPath)
    .slice(0, Math.max(0, limit))
    .flatMap((hit) => {
      const record = Option.getOrUndefined(HashMap.get(indexes.records, hit.path))
      if (record === undefined) return []
      const arms: Array<SearchArm> = []
      if (lexicalPaths.has(hit.path)) arms.push("lexical")
      if (recencyPaths.has(hit.path)) arms.push("recency")
      if (vectorPaths.has(hit.path)) arms.push("vector")
      return [{ path: hit.path, score: hit.score, arms, claim: record.claim }]
    })
}

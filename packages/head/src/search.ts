import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { type ArmHit, cosine, DEFAULT_ARM_LIMIT, fuseArms, RRF_K } from "@memhtml/domain"
import { HashMap, Option } from "effect"

import { indexesOf } from "./indexes.js"
import type { LexicalIndex } from "./lexical.js"
import { tokenize } from "./lexical.js"

/**
 * Retrieval over one view: a lexical arm and, when the caller passes vectors and a query vector, a
 * vector arm, fused with reciprocal rank fusion at `k = 60`, weights 1.0 and 1.0, over active records
 * only, with recency as the tie-break.
 *
 * The lexical arm is BM25 (Robertson/Sparck Jones idf, `k1 = 1.2`, `b = 0.75`) over the title, the
 * claim, and the body, read from the version's persistent lexical index, and keeps the best
 * {@link LEXICAL_ARM_LIMIT}. The vector arm orders the active records that have a vector by cosine
 * against the query vector, brute force, and keeps the best {@link VECTOR_ARM_LIMIT}. In both arms
 * records with equal scores share one rank (see {@link armRanks}), so two records an arm cannot tell
 * apart get the same fused share.
 *
 * The rule: recency decides only between hits whose fused score is exactly equal, newest first by
 * `eventAt ?? updatedAt` (clamped to `now`), and path ascending decides after that. It never
 * overturns a score difference and never adds a record, so a query no arm matches returns nothing.
 * A byte-identical newer twin therefore outranks the older copy, and a clearly better older match
 * stays above a newer, weaker one.
 *
 * Why not a weighted recency arm. Until 2026-09-28 recency was an RRF arm at weight 0.5 that ranked
 * every lexical and vector candidate newest first. That made it a second full ranking rather than a
 * tie-break, and a curation landing that made the surviving records newer made older targets lose to
 * newer, weaker matches. On the 2026-09-28 collapse rehearsal (base `33f182de7`, landed
 * `85eeb5ed`, the head gate's 200 title probes, seed 1, top 10) the weighted arm scored MRR 0.5572
 * at the base and 0.4384 landed, so the gate refused the landing; this rule scores 0.9449 and 0.9485
 * without the vector arm and 0.9492 and 0.9522 with it, and on the 2026-09-23 clone at `a650152e` it
 * raised the gate probes from 0.4557 to 0.9975 without the vector arm and from 0.8321 to 0.9905 with
 * it. Smaller weights land near the same numbers (0.05 scored 0.9374 and 0.9410 without the vector
 * arm), but without shared ranks no weight small enough to be a tie-break lets a newer twin win,
 * and letting recency reorder hits within 0.0003 of each other dropped two-arm MRR at the base to
 * 0.6769 (docs/v2-poc.md, "Recency as the tie-break").
 *
 * The function stays pure: it never embeds. The caller owns the vectors (keyed by content hash, see
 * `vectors.ts`) and the query vector, so a search with neither is the lexical search exactly.
 */

export type SearchArm = "lexical" | "recency" | "vector"

export interface SearchHit {
  readonly path: string
  readonly score: number
  /**
   * The arms that ranked the hit, and `recency` when its fused score equals another candidate's,
   * which is when recency (or path after it) decided its place.
   */
  readonly arms: ReadonlyArray<SearchArm>
  readonly claim: string
}

export const LEXICAL_WEIGHT = 1.0
/**
 * The vector arm's weight: v1's (`vectorArm` in `@memhtml/index` `retrieval-sql.ts`), so a read that
 * moves from v1 to v2 weighs a semantic match the way it did. v1 fuses four arms at 1.0 (lexical),
 * 1.0 (vector), 0.5 (recency), and 0.4 (salience); v2 keeps lexical and vector at v1's weights and
 * has no salience arm, and its recency is a tie-break rather than an arm.
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
 * An arm's scored records as ranks, best first, cut at `limit`, with equal scores sharing the best
 * rank of their run (competition ranking: 1, 1, 3). Two records an arm scores identically, such as
 * byte-identical articles under BM25 or one content hash under cosine, then contribute the same RRF
 * share, so they tie in the fused score and recency, not path, decides between them. The cut at
 * `limit` still follows path order inside a run that crosses it.
 */
const armRanks = (
  scored: ReadonlyArray<{ readonly path: string; readonly score: number }>,
  limit: number
): ReadonlyArray<ArmHit> => {
  const kept = [...scored].sort(byScoreThenPath).slice(0, limit)
  const hits: Array<ArmHit> = []
  for (const [index, hit] of kept.entries()) {
    const previous = hits[index - 1]
    const shared = previous !== undefined && kept[index - 1]?.score === hit.score
    hits.push({ path: hit.path, rank: shared ? previous.rank : index + 1 })
  }
  return hits
}

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
  return armRanks(
    [...scores.entries()].map(([path, score]) => ({ path, score })),
    LEXICAL_ARM_LIMIT
  )
}

/** The instant a record is ranked by for recency, clamped to `now` so a future date cannot lead. */
const recencyKey = (record: MemoryRecord, now: string | undefined): string => {
  const at = record.eventAt ?? record.updatedAt
  return now !== undefined && at > now ? now : at
}

/**
 * The fused order: score descending, then the newer record, then path ascending. Recency is read
 * only when two scores are exactly equal, which is the whole of its say in the ranking.
 */
const byScoreThenNewerThenPath =
  (keys: ReadonlyMap<string, string>) =>
  (
    left: { readonly path: string; readonly score: number },
    right: { readonly path: string; readonly score: number }
  ): number => {
    if (left.score !== right.score) return right.score - left.score
    const leftKey = keys.get(left.path) ?? ""
    const rightKey = keys.get(right.path) ?? ""
    if (leftKey !== rightKey) return leftKey < rightKey ? 1 : -1
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  }

/**
 * The active records that have a vector, by cosine against the query vector, best first, capped at
 * {@link VECTOR_ARM_LIMIT}, equal cosines sharing a rank. A record whose content hash has no vector is not in the arm; it can still
 * be found by the other two.
 */
const vectorArm = (
  records: ReadonlyArray<MemoryRecord>,
  vectors: HeadVectors,
  queryVector: ArrayLike<number>
): ReadonlyArray<ArmHit> =>
  armRanks(
    records.flatMap((record) => {
      const vector = vectors.get(record.contentHash)
      return vector === undefined ? [] : [{ path: record.path, score: cosine(vector, queryVector) }]
    }),
    VECTOR_ARM_LIMIT
  )

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
  // With no vector arm the fold is the lexical fold exactly, so a search without vectors is the
  // lexical search, byte for byte.
  const fused =
    vector === null
      ? fuseArms([lexical], [LEXICAL_WEIGHT], RRF_K)
      : fuseArms([lexical, vector], [LEXICAL_WEIGHT, VECTOR_WEIGHT], RRF_K)
  const keys = new Map<string, string>()
  for (const path of fused.keys()) {
    const record = Option.getOrUndefined(HashMap.get(indexes.records, path))
    if (record !== undefined) keys.set(path, recencyKey(record, input.now))
  }
  const ordered = [...fused.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort(byScoreThenNewerThenPath(keys))
  // A hit names `recency` when it shares its fused score with another candidate, which is exactly
  // when recency (or, on equal instants, path after it) placed it.
  const tied = new Set<string>()
  for (const [index, hit] of ordered.entries()) {
    const next = ordered[index + 1]
    if (next !== undefined && next.score === hit.score) {
      tied.add(hit.path)
      tied.add(next.path)
    }
  }
  const lexicalPaths = new Set(lexical.map((hit) => hit.path))
  const vectorPaths = new Set((vector ?? []).map((hit) => hit.path))
  const limit = input.limit ?? DEFAULT_LIMIT
  return ordered.slice(0, Math.max(0, limit)).flatMap((hit) => {
    const record = Option.getOrUndefined(HashMap.get(indexes.records, hit.path))
    if (record === undefined) return []
    const arms: Array<SearchArm> = []
    if (lexicalPaths.has(hit.path)) arms.push("lexical")
    if (tied.has(hit.path)) arms.push("recency")
    if (vectorPaths.has(hit.path)) arms.push("vector")
    return [{ path: hit.path, score: hit.score, arms, claim: record.claim }]
  })
}

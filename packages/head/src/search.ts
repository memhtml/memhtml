import type { HeadView, MemoryRecord } from "@memhtml/contracts"
import { type ArmHit, fuseArms, RRF_K } from "@memhtml/domain"
import { HashMap, Option } from "effect"

import { indexesOf } from "./indexes.js"
import type { LexicalIndex } from "./lexical.js"
import { tokenize } from "./lexical.js"

/**
 * Two-arm retrieval over one view: a lexical arm and a recency arm, fused with reciprocal rank
 * fusion at `k = 60`, weights 1.0 and 0.5, over active records only.
 *
 * The lexical arm is BM25 (Robertson/Sparck Jones idf, `k1 = 1.2`, `b = 0.75`) over the title, the
 * claim, and the body, read from the version's persistent lexical index. The recency arm orders by
 * `eventAt ?? updatedAt`, the same key the v1 SQL arm uses. Both arms and the fused list break
 * ties on path ascending, so two runs over one view return the same list.
 */

export type SearchArm = "lexical" | "recency"

export interface SearchHit {
  readonly path: string
  readonly score: number
  readonly arms: ReadonlyArray<SearchArm>
  readonly claim: string
}

export const LEXICAL_WEIGHT = 1.0
export const RECENCY_WEIGHT = 0.5
export const DEFAULT_LIMIT = 10

const BM25_K1 = 1.2
const BM25_B = 0.75

const byScoreThenPath = (
  left: { readonly path: string; readonly score: number },
  right: { readonly path: string; readonly score: number }
): number =>
  right.score - left.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

/** BM25 over the query's tokens. Every document with at least one matching token is a hit. */
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
    .map((hit, index) => ({ path: hit.path, rank: index + 1 }))
}

/** The instant a record is ranked by for recency, clamped to `now` so a future date cannot lead. */
const recencyKey = (record: MemoryRecord, now: string | undefined): string => {
  const at = record.eventAt ?? record.updatedAt
  return now !== undefined && at > now ? now : at
}

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

export const searchHead = (
  view: HeadView,
  input: { readonly query: string; readonly limit?: number; readonly now?: string }
): ReadonlyArray<SearchHit> => {
  const indexes = indexesOf(view)
  const active = [...HashMap.values(indexes.records)].filter((record) => !record.archived)
  const lexical = lexicalArm(indexes.lexical, input.query)
  const recency = recencyArm(active, input.now)
  const fused = fuseArms([lexical, recency], [LEXICAL_WEIGHT, RECENCY_WEIGHT], RRF_K)
  const lexicalPaths = new Set(lexical.map((hit) => hit.path))
  const recencyPaths = new Set(recency.map((hit) => hit.path))
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
      return [{ path: hit.path, score: hit.score, arms, claim: record.claim }]
    })
}

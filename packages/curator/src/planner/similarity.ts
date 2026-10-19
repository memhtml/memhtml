import type { MemoryRecord } from "@memhtml/contracts"
import { tokenize } from "@memhtml/head"

/**
 * The similarity layer of the planner: a kNN graph over records, from lexical TF-IDF cosine.
 *
 * Lexical rather than embedded, and stated here as the spec asks: the embedding interface exists in
 * v2 but only the fake embedder implements it, and the collapse has to run against a store whose
 * index may be stale or absent. The tokens are the head's own (`tokenize`: lowercase, split on
 * non-word runs, stop words dropped) over title, claim, and body, so the planner and `head search`
 * agree on what a word is.
 *
 * Weights are `(1 + ln tf) * idf`, L2-normalized, so the dot product is the cosine. Tokens carried by
 * more than {@link MAX_DOCUMENT_FREQUENCY_SHARE} of the records are dropped before weighting: they
 * carry almost no idf and every pair shares them, so keeping them would make the posting-list join
 * below quadratic in the corpus for no ranking gain.
 *
 * Deterministic: records are visited in path order, ties broken on path.
 */

export interface SimilarityEdge {
  readonly from: string
  readonly to: string
  readonly weight: number
}

/** A token in more than this share of the records is dropped from every vector. */
export const MAX_DOCUMENT_FREQUENCY_SHARE = 0.2

/**
 * The share never cuts below this many records, so a small partition keeps the words its
 * near-duplicates share: at twenty records a 20% share would drop every token four restatements
 * have in common, which is exactly the signal the graph is built from.
 */
export const MIN_DOCUMENT_FREQUENCY_CAP = 10

const byPath = (a: { readonly path: string }, b: { readonly path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/** The text one record is compared by: title, then claim, then the body. */
export const comparedText = (record: MemoryRecord): string =>
  `${record.title} ${record.claim} ${record.bodyText}`

interface Vector {
  readonly path: string
  readonly weights: ReadonlyMap<string, number>
}

/** Every record's normalized TF-IDF vector, over the vocabulary that survives the frequency cap. */
export const tfidfVectors = (records: ReadonlyArray<MemoryRecord>): ReadonlyArray<Vector> => {
  const sorted = [...records].sort(byPath)
  const frequencies = sorted.map((record) => {
    const counts = new Map<string, number>()
    for (const token of tokenize(comparedText(record))) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    return counts
  })
  const documentFrequency = new Map<string, number>()
  for (const counts of frequencies) {
    for (const token of counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const total = sorted.length
  const maxDf = Math.max(
    MIN_DOCUMENT_FREQUENCY_CAP,
    Math.floor(total * MAX_DOCUMENT_FREQUENCY_SHARE)
  )
  return sorted.map((record, index) => {
    const counts = frequencies[index] ?? new Map<string, number>()
    const weights = new Map<string, number>()
    let norm = 0
    for (const [token, tf] of counts) {
      const df = documentFrequency.get(token) ?? 0
      if (df > maxDf) continue
      const weight = (1 + Math.log(tf)) * (Math.log((total + 1) / (df + 1)) + 1)
      weights.set(token, weight)
      norm += weight * weight
    }
    const scale = norm === 0 ? 0 : 1 / Math.sqrt(norm)
    for (const [token, weight] of weights) weights.set(token, weight * scale)
    return { path: record.path, weights }
  })
}

/**
 * The kNN edges: for each record its `k` nearest neighbors at or above `floor`, undirected, one
 * edge per pair carrying the cosine. Candidates come from a posting-list join, so two records with
 * no token in common are never compared.
 */
export const knnEdges = (
  records: ReadonlyArray<MemoryRecord>,
  options: { readonly k: number; readonly floor: number }
): ReadonlyArray<SimilarityEdge> => {
  const vectors = tfidfVectors(records)
  const postings = new Map<string, Array<number>>()
  for (const [index, vector] of vectors.entries()) {
    for (const token of vector.weights.keys()) {
      const list = postings.get(token) ?? []
      list.push(index)
      postings.set(token, list)
    }
  }
  const pairs = new Map<string, SimilarityEdge>()
  for (const [index, vector] of vectors.entries()) {
    const scores = new Map<number, number>()
    for (const [token, weight] of vector.weights) {
      for (const other of postings.get(token) ?? []) {
        if (other === index) continue
        const otherWeight = vectors[other]?.weights.get(token) ?? 0
        scores.set(other, (scores.get(other) ?? 0) + weight * otherWeight)
      }
    }
    const top = [...scores.entries()]
      .filter(([, score]) => score >= options.floor)
      .map(([other, score]) => ({ other, score, path: vectors[other]?.path ?? "" }))
      .sort((a, b) => b.score - a.score || byPath(a, b))
      .slice(0, options.k)
    for (const { other, score } of top) {
      const a = vectors[Math.min(index, other)]?.path ?? ""
      const b = vectors[Math.max(index, other)]?.path ?? ""
      const key = `${a}\u0000${b}`
      const existing = pairs.get(key)
      if (existing === undefined || existing.weight < score) {
        pairs.set(key, { from: a, to: b, weight: score })
      }
    }
  }
  return [...pairs.values()].sort(
    (x, y) => byPath({ path: x.from }, { path: y.from }) || byPath({ path: x.to }, { path: y.to })
  )
}

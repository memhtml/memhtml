import { cosine } from "./cosine.js"

/**
 * Pairwise nearest-neighbor selection over decoded vectors: the n×n arm of the similarity space,
 * computed in one pass of plain arithmetic over vectors decoded ONCE.
 *
 * The 1×n retrieval arm computes distances inside SQL through `vector_distance_cos`, and that
 * boundary is priced per CALL: node:sqlite materializes a fresh `Uint8Array` per blob argument per
 * invocation. One query vector against n rows is n copies and unmeasurable. At n×n it is the
 * corpus re-copied n times over — probed 2026-08-18 (issue #40) at n = 2,907 × 1024-dim float32:
 * 8.45M UDF calls, tens of GB of allocation churn, OOM at the default heap with zero phases
 * recorded, while the decoded corpus is 12 MB. So the n×n consumers decode each vector once and
 * run the same arithmetic here, where a pair costs one dot product and no allocation.
 *
 * Similarities are BIT-IDENTICAL to {@link cosine}: `pairSimilarity` hoists the two square roots
 * out of the pair loop but performs the same floating-point operations in the same order, and a
 * property test holds the two together. A floor or tie-break decided here therefore agrees with
 * every SQL-side reader of the same space, and an equivalence test can assert exact equality
 * rather than epsilon.
 */

/** One decoded vector under the key the ranking reports. Keys must be unique. */
export interface KeyedVector {
  readonly key: string
  readonly vec: Float32Array
}

/** One selected pair. `sim` is cosine similarity, unitless in `[-1, 1]`. */
export interface NeighborPair {
  readonly src: string
  readonly dst: string
  readonly sim: number
}

/** The selection knobs every pair consumer states. */
export interface NeighborOptions {
  /** Pairs below this similarity never enter ranking. */
  readonly floor: number
  /** Nearest neighbors kept per `src`, ordered `sim` DESC then `dst` ASC. */
  readonly perSourceK: number
  /** Global cap, applied after the final `sim` DESC, `src` ASC, `dst` ASC ordering. */
  readonly limit: number
}

/**
 * A `Float32Array` over stored bytes, copying only when it must.
 *
 * `Float32Array` requires a 4-byte-aligned `byteOffset`, and a driver row's `Uint8Array` may be
 * a view into a pooled buffer at any offset. Viewing in place is the common case and costs
 * nothing. A misaligned or ragged blob is copied rather than rejected, because the vector arm's
 * job is to rank and a throw here would fail a whole search over one row.
 */
export const float32View = (bytes: Uint8Array): Float32Array | undefined => {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return undefined
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

/** `sqrt(Σ x²)` accumulated in index order — the same order {@link cosine} accumulates its norms. */
const sqrtNorm = (vec: Float32Array): number => {
  let sum = 0
  for (let index = 0; index < vec.length; index += 1) {
    const x = vec[index] as number
    sum += x * x
  }
  return Math.sqrt(sum)
}

/**
 * Cosine similarity from precomputed norms: {@link cosine}'s operations with the square roots
 * hoisted out of the pair loop, so the result is bit-identical for equal-length vectors. The
 * zero-norm rule and the `[-1, 1]` clamp are the same ones, for the same reasons. Mismatched
 * lengths fall back to {@link cosine}, whose min-length walk defines that case; equal lengths are
 * what the `embed_model` watermark guarantees for stored vectors.
 */
const pairSimilarity = (a: Float32Array, aNorm: number, b: Float32Array, bNorm: number): number => {
  if (a.length !== b.length) return cosine(a, b)
  if (aNorm === 0 || bNorm === 0) return 0
  let dot = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] as number) * (b[index] as number)
  }
  return Math.max(-1, Math.min(1, dot / (aNorm * bNorm)))
}

interface Candidate {
  readonly dst: string
  readonly sim: number
}

/**
 * Insert into a per-source list ordered `sim` DESC then `dst` ASC, bounded at `k`. Linear
 * insertion, because `k` is single-digit everywhere this runs and a heap's constant factors lose
 * at that size. Memory across the whole selection is O(n·k), never the pair space.
 */
const insertBounded = (list: Array<Candidate>, k: number, dst: string, sim: number): void => {
  let at = list.length
  for (let index = 0; index < list.length; index += 1) {
    const held = list[index] as Candidate
    if (sim > held.sim || (sim === held.sim && dst < held.dst)) {
      at = index
      break
    }
  }
  if (at >= k) return
  list.splice(at, 0, { dst, sim })
  if (list.length > k) list.pop()
}

/** The final ordering every consumer sees: `sim` DESC, then `src` ASC, then `dst` ASC, then cap. */
const collectRanked = (
  bySource: ReadonlyMap<string, ReadonlyArray<Candidate>>,
  limit: number
): ReadonlyArray<NeighborPair> => {
  const rows: Array<NeighborPair> = []
  for (const [src, list] of bySource) {
    for (const held of list) rows.push({ src, dst: held.dst, sim: held.sim })
  }
  rows.sort((left, right) => {
    if (left.sim !== right.sim) return left.sim < right.sim ? 1 : -1
    if (left.src !== right.src) return left.src < right.src ? -1 : 1
    return left.dst < right.dst ? -1 : left.dst > right.dst ? 1 : 0
  })
  return rows.slice(0, limit)
}

/**
 * Per-source top-`k` nearest neighbors above a similarity floor, over every unordered pair.
 *
 * Each pair's similarity is computed ONCE and offered to BOTH endpoints' neighborhoods, so the
 * output can hold `(a, b)` and `(b, a)` — each is a fact about a different source's neighborhood,
 * and a consumer folding pairs must dedup the mirror itself (dedup-merge does, with its `seen`
 * set). A floor comparison a NaN similarity cannot pass keeps a vector carrying NaN bytes out of
 * every neighborhood rather than poisoning an ordering.
 */
export const topNeighborPairs = (
  vectors: ReadonlyArray<KeyedVector>,
  options: NeighborOptions
): ReadonlyArray<NeighborPair> => {
  const norms = vectors.map((entry) => sqrtNorm(entry.vec))
  const bySource = new Map<string, Array<Candidate>>()
  for (const entry of vectors) bySource.set(entry.key, [])
  for (let i = 0; i < vectors.length; i += 1) {
    const left = vectors[i] as KeyedVector
    const leftNorm = norms[i] as number
    const leftList = bySource.get(left.key) as Array<Candidate>
    for (let j = i + 1; j < vectors.length; j += 1) {
      const right = vectors[j] as KeyedVector
      const sim = pairSimilarity(left.vec, leftNorm, right.vec, norms[j] as number)
      if (!(sim >= options.floor)) continue
      insertBounded(leftList, options.perSourceK, right.key, sim)
      insertBounded(bySource.get(right.key) as Array<Candidate>, options.perSourceK, left.key, sim)
    }
  }
  return collectRanked(bySource, options.limit)
}

/** One enumerated candidate pair, oriented by the caller. Pairs must be distinct. */
export interface CandidatePair {
  readonly src: string
  readonly dst: string
}

/**
 * Rank an ENUMERATED pair set: similarity, floor, per-source top-`k`, final ordering, cap.
 *
 * This is the shape for a consumer whose candidate pairs come from a selective predicate — the
 * conflict scan's shared-entity join — rather than from the whole pair space. The predicate runs
 * BEFORE ranking, exactly as a `WHERE` inside the ranking CTE would, so per-source top-`k` is
 * computed over passing pairs only. A pair naming a key with no vector contributes nothing, the
 * same outcome the SQL join's missing-embedding row produces.
 */
export const rankCandidatePairs = (
  pairs: ReadonlyArray<CandidatePair>,
  vectors: ReadonlyArray<KeyedVector>,
  options: NeighborOptions
): ReadonlyArray<NeighborPair> => {
  const byKey = new Map<string, { readonly vec: Float32Array; readonly norm: number }>()
  for (const entry of vectors) byKey.set(entry.key, { vec: entry.vec, norm: sqrtNorm(entry.vec) })
  const bySource = new Map<string, Array<Candidate>>()
  for (const pair of pairs) {
    const left = byKey.get(pair.src)
    const right = byKey.get(pair.dst)
    if (left === undefined || right === undefined) continue
    const sim = pairSimilarity(left.vec, left.norm, right.vec, right.norm)
    if (!(sim >= options.floor)) continue
    let list = bySource.get(pair.src)
    if (list === undefined) {
      list = []
      bySource.set(pair.src, list)
    }
    insertBounded(list, options.perSourceK, pair.dst, sim)
  }
  return collectRanked(bySource, options.limit)
}

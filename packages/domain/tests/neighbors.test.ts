import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { cosine } from "../src/cosine.js"
import {
  type CandidatePair,
  float32View,
  type KeyedVector,
  type NeighborOptions,
  type NeighborPair,
  rankCandidatePairs,
  topNeighborPairs
} from "../src/neighbors.js"

/**
 * The kernel is held against an INDEPENDENT reference: every ordered pair through `cosine`
 * itself, then the same floor / per-source rank / global order / cap written as plain sorts.
 * Exact `toEqual`, no epsilon — the kernel's hoisted-norm arithmetic must be bit-identical to
 * `cosine`, or a floor or tie-break decided by one would disagree with the other.
 */

const finiteFloat = fc.float({ noNaN: true, noDefaultInfinity: true })

/** Distinct keys zipped with same-length vectors, the shape stored embeddings guarantee. */
const corpus = (dim: number) =>
  fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 0, maxLength: 8 }).chain((keys) =>
    fc
      .array(fc.array(finiteFloat, { minLength: dim, maxLength: dim }), {
        minLength: keys.length,
        maxLength: keys.length
      })
      .map(
        (rows): ReadonlyArray<KeyedVector> =>
          keys.map((key, at) => ({ key, vec: Float32Array.from(rows[at] as Array<number>) }))
      )
  )

const options = fc.record({
  floor: fc.double({ min: -1, max: 1, noNaN: true }),
  perSourceK: fc.integer({ min: 0, max: 4 }),
  limit: fc.integer({ min: 0, max: 30 })
})

const bySimSrcDst = (left: NeighborPair, right: NeighborPair): number => {
  if (left.sim !== right.sim) return left.sim < right.sim ? 1 : -1
  if (left.src !== right.src) return left.src < right.src ? -1 : 1
  return left.dst < right.dst ? -1 : left.dst > right.dst ? 1 : 0
}

const bySimDst = (left: NeighborPair, right: NeighborPair): number => {
  if (left.sim !== right.sim) return left.sim < right.sim ? 1 : -1
  return left.dst < right.dst ? -1 : left.dst > right.dst ? 1 : 0
}

/** Floor, per-source top-k, global order, cap — over rows already carrying sims. */
const referenceRank = (
  rows: ReadonlyArray<NeighborPair>,
  opts: NeighborOptions
): ReadonlyArray<NeighborPair> => {
  const bySrc = new Map<string, Array<NeighborPair>>()
  for (const row of rows) {
    if (!(row.sim >= opts.floor)) continue
    const list = bySrc.get(row.src) ?? []
    if (list.length === 0) bySrc.set(row.src, list)
    list.push(row)
  }
  const kept: Array<NeighborPair> = []
  for (const list of bySrc.values()) {
    list.sort(bySimDst)
    kept.push(...list.slice(0, opts.perSourceK))
  }
  kept.sort(bySimSrcDst)
  return kept.slice(0, opts.limit)
}

const referenceTopPairs = (
  vectors: ReadonlyArray<KeyedVector>,
  opts: NeighborOptions
): ReadonlyArray<NeighborPair> => {
  const rows: Array<NeighborPair> = []
  for (const left of vectors) {
    for (const right of vectors) {
      if (left.key === right.key) continue
      rows.push({ src: left.key, dst: right.key, sim: cosine(left.vec, right.vec) })
    }
  }
  return referenceRank(rows, opts)
}

describe("topNeighborPairs", () => {
  it("matches the ordered-pair reference exactly, sims included", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }).chain(corpus), options, (vectors, opts) => {
        expect(topNeighborPairs(vectors, opts)).toEqual(referenceTopPairs(vectors, opts))
      }),
      { numRuns: 250 }
    )
  }, 30_000)

  it("reports the sim cosine itself reports, bit for bit", () => {
    fc.assert(
      fc.property(
        fc.array(finiteFloat, { minLength: 3, maxLength: 3 }),
        fc.array(finiteFloat, { minLength: 3, maxLength: 3 }),
        (a, b) => {
          const va = Float32Array.from(a)
          const vb = Float32Array.from(b)
          const pairs = topNeighborPairs(
            [
              { key: "a", vec: va },
              { key: "b", vec: vb }
            ],
            { floor: -1, perSourceK: 2, limit: 10 }
          )
          expect(pairs).toHaveLength(2)
          for (const pair of pairs) expect(Object.is(pair.sim, cosine(va, vb))).toBe(true)
        }
      ),
      { numRuns: 500 }
    )
  })

  it("keeps a pair sitting exactly AT the floor — the comparison is >=, never >", () => {
    /**
     * Colinear unit-normed vectors make the similarity EXACTLY 1 (dot 2 over norms 1 × 2), so a
     * floor of 1 sits precisely on it. A random floor collides with a computed sim with
     * probability ~0, which is why the property runs above cannot hold this edge and this
     * deterministic case must.
     */
    const pairs = topNeighborPairs(
      [
        { key: "a", vec: Float32Array.from([1, 0]) },
        { key: "b", vec: Float32Array.from([2, 0]) }
      ],
      { floor: 1, perSourceK: 1, limit: 10 }
    )
    expect(pairs).toHaveLength(2)
    expect(
      rankCandidatePairs(
        [{ src: "b", dst: "a" }],
        [
          { key: "a", vec: Float32Array.from([1, 0]) },
          { key: "b", vec: Float32Array.from([2, 0]) }
        ],
        { floor: 1, perSourceK: 1, limit: 10 }
      )
    ).toHaveLength(1)
  })

  it("offers each unordered pair to BOTH neighborhoods, the <> join's shape", () => {
    const va = Float32Array.from([1, 0])
    const vb = Float32Array.from([1, 0.1])
    const pairs = topNeighborPairs(
      [
        { key: "a", vec: va },
        { key: "b", vec: vb }
      ],
      { floor: 0.5, perSourceK: 1, limit: 10 }
    )
    expect(pairs.map((pair) => `${pair.src}->${pair.dst}`)).toEqual(["a->b", "b->a"])
  })
})

describe("rankCandidatePairs", () => {
  const pairsFor = (vectors: ReadonlyArray<KeyedVector>) =>
    fc.array(
      fc.record({
        src: fc.constantFrom(...vectors.map((entry) => entry.key), "absent"),
        dst: fc.constantFrom(...vectors.map((entry) => entry.key), "absent")
      }),
      { minLength: 0, maxLength: 20 }
    )

  const referenceCandidates = (
    pairs: ReadonlyArray<CandidatePair>,
    vectors: ReadonlyArray<KeyedVector>,
    opts: NeighborOptions
  ): ReadonlyArray<NeighborPair> => {
    const byKey = new Map(vectors.map((entry) => [entry.key, entry.vec]))
    const rows: Array<NeighborPair> = []
    for (const pair of pairs) {
      const left = byKey.get(pair.src)
      const right = byKey.get(pair.dst)
      if (left === undefined || right === undefined) continue
      rows.push({ src: pair.src, dst: pair.dst, sim: cosine(left, right) })
    }
    return referenceRank(rows, opts)
  }

  it("matches the reference exactly over an enumerated pair set", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 6 })
          .chain(corpus)
          .filter((vectors) => vectors.length > 0)
          .chain((vectors) =>
            fc.tuple(
              fc.constant(vectors),
              pairsFor(vectors).map((pairs) => {
                const seen = new Set<string>()
                return pairs.filter((pair) => {
                  const key = `${pair.src} ${pair.dst}`
                  if (pair.src === pair.dst || seen.has(key)) return false
                  seen.add(key)
                  return true
                })
              })
            )
          ),
        options,
        ([vectors, pairs], opts) => {
          expect(rankCandidatePairs(pairs, vectors, opts)).toEqual(
            referenceCandidates(pairs, vectors, opts)
          )
        }
      ),
      { numRuns: 250 }
    )
  }, 30_000)

  it("contributes nothing for a pair naming a key with no vector", () => {
    const vectors: ReadonlyArray<KeyedVector> = [{ key: "a", vec: Float32Array.from([1, 0]) }]
    expect(
      rankCandidatePairs([{ src: "a", dst: "gone" }], vectors, {
        floor: -1,
        perSourceK: 5,
        limit: 10
      })
    ).toEqual([])
  })
})

describe("float32View", () => {
  it("refuses empty and ragged blobs", () => {
    expect(float32View(new Uint8Array(0))).toBeUndefined()
    expect(float32View(new Uint8Array(5))).toBeUndefined()
  })

  it("views aligned bytes in place", () => {
    const source = Float32Array.from([1.5, -2.25, 0])
    const bytes = new Uint8Array(source.buffer)
    const view = float32View(bytes)
    expect(view).toBeDefined()
    expect(Array.from(view as Float32Array)).toEqual([1.5, -2.25, 0])
    expect((view as Float32Array).buffer).toBe(bytes.buffer)
  })

  it("copies misaligned bytes rather than rejecting them", () => {
    const source = Float32Array.from([3.5, -7])
    const padded = new Uint8Array(source.byteLength + 1)
    padded.set(new Uint8Array(source.buffer), 1)
    const misaligned = new Uint8Array(padded.buffer, 1, source.byteLength)
    const view = float32View(misaligned)
    expect(view).toBeDefined()
    expect(Array.from(view as Float32Array)).toEqual([3.5, -7])
    expect((view as Float32Array).buffer).not.toBe(padded.buffer)
  })
})

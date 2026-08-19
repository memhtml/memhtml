import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  connectedComponents,
  excludeSelfSupersede,
  MAX_MERGE_PAIRS,
  type MergePair,
  mergeCandidates,
  mergeVetoed,
  NEAR_DUPLICATE_THRESHOLD,
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "../src/merge.js"

const PREDICATES = [
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent,
  mergeVetoed
] as const

/** Prose drawn from the vocabularies the guards key on, so divergence actually occurs. */
const body = fc
  .array(
    fc.constantFrom(
      "the",
      "deploy",
      "step",
      "is",
      "safe",
      "not",
      "never",
      "retry",
      "3",
      "13",
      "v2",
      "v2.1",
      "m1",
      "pro",
      "beta",
      "fails",
      "isn't",
      "reject"
    ),
    { minLength: 1, maxLength: 12 }
  )
  .map((words) => words.join(" "))

const path = fc.stringMatching(/^[a-z]{1,6}$/).map((stem) => `areas/oncall/${stem}.html`)

describe("divergence predicates", () => {
  it("is symmetric in its two arguments, every one of them", () => {
    fc.assert(
      fc.property(body, body, (a, b) => {
        for (const predicate of PREDICATES) {
          expect(predicate(a, b)).toBe(predicate(b, a))
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is reflexive-free: a body never diverges from itself", () => {
    fc.assert(
      fc.property(body, (text) => {
        for (const predicate of PREDICATES) {
          expect(predicate(text, text)).toBe(false)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is exactly the disjunction of the three families", () => {
    fc.assert(
      fc.property(body, body, (a, b) => {
        expect(mergeVetoed(a, b)).toBe(
          negationDivergent(a, b) || numericTokenDivergent(a, b) || variantQualifierDivergent(a, b)
        )
      }),
      { numRuns: 1000 }
    )
  })

  it("catches the polarity flip an embedding scores as near-identical", () => {
    expect(negationDivergent("the deploy step is safe", "the deploy step is not safe")).toBe(true)
    expect(mergeVetoed("the deploy step is safe", "the deploy step is not safe")).toBe(true)
  })

  it("reads a contraction as its expansion, so isn't surfaces the not", () => {
    expect(negationDivergent("the deploy step is safe", "the deploy step isn't safe")).toBe(true)
  })

  it("does not flag two bodies that both negate, or neither", () => {
    expect(negationDivergent("never retry", "do not retry")).toBe(false)
    expect(negationDivergent("always retry", "retry again")).toBe(false)
  })

  it("catches a numeric flip", () => {
    expect(numericTokenDivergent("retry 3 times", "retry 13 times")).toBe(true)
    expect(numericTokenDivergent("ADR 11 supersedes", "ADR 13 supersedes")).toBe(true)
  })

  it("does not flag two number-free bodies or two with the same numbers", () => {
    expect(numericTokenDivergent("drain the vip", "drain the vip first")).toBe(false)
    expect(numericTokenDivergent("retry 3 times", "retry 3 times quickly")).toBe(false)
  })

  it("catches a variant qualifier one side lacks", () => {
    expect(variantQualifierDivergent("the M1 build", "the M1 Pro build")).toBe(true)
    expect(variantQualifierDivergent("the release", "the release beta")).toBe(true)
    expect(variantQualifierDivergent("the M1 Pro build", "the M1 Pro build again")).toBe(false)
  })

  it("is case- and unicode-normalization-insensitive", () => {
    expect(negationDivergent("NOT SAFE", "not safe")).toBe(false)
    expect(mergeVetoed("Retry 3 Times", "retry 3 times")).toBe(false)
  })
})

describe("mergeCandidates", () => {
  const pair = (over: Partial<MergePair> = {}): MergePair => ({
    keepPath: "areas/oncall/a.html",
    dropPath: "areas/oncall/b.html",
    similarity: 0.99,
    ...over
  })

  it("pins the threshold and the per-cycle cap", () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toBe(0.92)
    expect(MAX_MERGE_PAIRS).toBe(100)
  })

  it("applies the threshold strictly: exactly at it is not a duplicate", () => {
    expect(mergeCandidates([pair({ similarity: NEAR_DUPLICATE_THRESHOLD })])).toHaveLength(0)
    expect(mergeCandidates([pair({ similarity: NEAR_DUPLICATE_THRESHOLD + 1e-9 })])).toHaveLength(1)
  })

  it("vetoes a divergent pair no matter how high its cosine", () => {
    fc.assert(
      fc.property(body, body, fc.double({ min: 0.93, max: 1, noNaN: true }), (a, b, similarity) => {
        const decisions = mergeCandidates([pair({ similarity, keepText: a, dropText: b })])
        expect(decisions.length).toBe(mergeVetoed(a, b) ? 0 : 1)
      }),
      { numRuns: 1000 }
    )
  })

  it("skips the guards when either text is absent, so a text-less caller is unchanged", () => {
    expect(mergeCandidates([pair({ keepText: "safe", dropText: undefined })])).toHaveLength(1)
    expect(mergeCandidates([pair({ keepText: undefined, dropText: "not safe" })])).toHaveLength(1)
  })

  it("refuses a self-merge", () => {
    expect(mergeCandidates([pair({ dropPath: "areas/oncall/a.html" })])).toHaveLength(0)
  })

  it("fixes each path in one role for the batch: no path is twice a drop, twice a keeper, or both", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(path, path, fc.double({ min: 0.5, max: 1, noNaN: true }))
            .map(
              ([keepPath, dropPath, similarity]): MergePair => ({ keepPath, dropPath, similarity })
            ),
          { maxLength: 20 }
        ),
        (pairs) => {
          const decisions = mergeCandidates(pairs)
          const dropped = decisions.map((decision) => decision.dropPath)
          const kept = decisions.map((decision) => decision.keepPath)
          expect(new Set(dropped).size).toBe(dropped.length)
          expect(new Set(kept).size).toBe(kept.length)
          for (const keeper of kept) {
            expect(dropped).not.toContain(keeper)
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it("breaks a forward transitive chain rather than folding into an archived file", () => {
    const decisions = mergeCandidates([
      { keepPath: "a.html", dropPath: "b.html", similarity: 0.99 },
      { keepPath: "b.html", dropPath: "c.html", similarity: 0.99 }
    ])
    expect(decisions).toEqual([{ keepPath: "a.html", dropPath: "b.html", similarity: 0.99 }])
  })

  it("refuses to archive a path that already absorbed another this batch", () => {
    const decisions = mergeCandidates([
      { keepPath: "gf.html", dropPath: "a.html", similarity: 0.99 },
      { keepPath: "b.html", dropPath: "gf.html", similarity: 0.99 }
    ])
    expect(decisions).toEqual([{ keepPath: "gf.html", dropPath: "a.html", similarity: 0.99 }])
  })

  it("honors input order as priority order", () => {
    const decisions = mergeCandidates([
      { keepPath: "a.html", dropPath: "b.html", similarity: 0.95 },
      { keepPath: "c.html", dropPath: "b.html", similarity: 0.99 }
    ])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.keepPath).toBe("a.html")
  })

  it("caps the decision count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (maxPairs) => {
        const pairs = Array.from({ length: 40 }, (_, index) => ({
          keepPath: `k${index}.html`,
          dropPath: `d${index}.html`,
          similarity: 0.99
        }))
        expect(mergeCandidates(pairs, { maxPairs }).length).toBeLessThanOrEqual(maxPairs)
      }),
      { numRuns: 1000 }
    )
  })

  it("carries every decision's similarity through untouched", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(path, path, fc.double({ min: 0.93, max: 1, noNaN: true }))
            .map(
              ([keepPath, dropPath, similarity]): MergePair => ({ keepPath, dropPath, similarity })
            ),
          { maxLength: 15 }
        ),
        (pairs) => {
          // First-wins, matching the guard: two pairs can name the same (keep, drop) at
          // different similarities, and only the earlier one is ever committed.
          const bySource = new Map<string, number>()
          for (const pair of pairs) {
            const key = `${pair.keepPath} ${pair.dropPath}`
            if (!bySource.has(key)) bySource.set(key, pair.similarity)
          }
          for (const decision of mergeCandidates(pairs)) {
            expect(bySource.get(`${decision.keepPath} ${decision.dropPath}`)).toBe(
              decision.similarity
            )
          }
        }
      ),
      { numRuns: 1000 }
    )
  })
})

describe("excludeSelfSupersede", () => {
  it("removes the canonical and preserves the order of the rest", () => {
    fc.assert(
      fc.property(fc.array(path, { maxLength: 12 }), path, (members, canonical) => {
        const remaining = excludeSelfSupersede(canonical, members)
        expect(remaining).not.toContain(canonical)
        expect(remaining).toEqual(members.filter((member) => member !== canonical))
      }),
      { numRuns: 1000 }
    )
  })

  it("is a no-op when the canonical is not in the batch", () => {
    expect(excludeSelfSupersede("z.html", ["a.html", "b.html"])).toEqual(["a.html", "b.html"])
  })

  it("removes every occurrence of the canonical", () => {
    expect(excludeSelfSupersede("a.html", ["a.html", "b.html", "a.html"])).toEqual(["b.html"])
  })
})

/**
 * `connectedComponents`, whose ONE guarantee is that the partition depends on the edge SET and not on
 * the order the edges arrived in.
 *
 * dedup-merge unions two independently-produced edge lists — mined cosine pairs and frame-key exact
 * matches — and the mined half arrives in `sim DESC` order while the frame half arrives path-ordered.
 * So arrival order genuinely varies between corpora, and a partition that depended on it would make
 * which files a night considers together a function of how the two lists happened to interleave.
 */
describe("connectedComponents", () => {
  it("collapses a transitive chain into ONE component, sorted", () => {
    expect(
      connectedComponents([
        ["b.html", "c.html"],
        ["a.html", "b.html"]
      ])
    ).toEqual([["a.html", "b.html", "c.html"]])
  })

  it("keeps disjoint pairs apart, ordered by each component's smallest member", () => {
    expect(
      connectedComponents([
        ["z.html", "y.html"],
        ["b.html", "a.html"]
      ])
    ).toEqual([
      ["a.html", "b.html"],
      ["y.html", "z.html"]
    ])
  })

  it("orders components by their own SMALLEST member, not by whichever root was seen first", () => {
    /**
     * THE discriminating assertion, and the reason the union keeps the smaller root.
     *
     * Grouping is order-invariant for any union-find at all, so it cannot show which root rule is in
     * force. Component ORDER can, and it is load-bearing: dedup-merge slices this list at
     * `DEDUP_MAX_COMPONENTS`, so component order decides which components a capped night considers at
     * all.
     *
     * Both edges below name their LARGER key first, which is what makes the two rules disagree.
     * (Verified by mutation: replacing the smaller-root rule with an unconditional
     * `parent.set(rootRight, rootLeft)` returns `[[b, m], [a, z]]` and fails here. The transitive and
     * disjoint cases above both still pass under that mutation, because each feeds its edges in an
     * order the wrong rule happens to agree with — which is exactly why this case is written
     * separately rather than folded into them.)
     */
    expect(
      connectedComponents([
        ["z.html", "a.html"],
        ["m.html", "b.html"]
      ])
    ).toEqual([
      ["a.html", "z.html"],
      ["b.html", "m.html"]
    ])
  })

  it("is INVARIANT under edge order, not merely stable: every permutation agrees", () => {
    /**
     * dedup-merge unions two independently-ordered edge lists, so the interleaving really varies. This
     * holds the whole output — grouping, member order, and component order together — against every
     * permutation of one edge set, which is the property the phase states about its own reproducibility.
     */
    const edges: ReadonlyArray<readonly [string, string]> = [
      ["c.html", "d.html"],
      ["z.html", "a.html"],
      ["b.html", "c.html"],
      ["y.html", "x.html"]
    ]
    const expected = connectedComponents(edges)
    expect(expected).toEqual([
      ["a.html", "z.html"],
      ["b.html", "c.html", "d.html"],
      ["x.html", "y.html"]
    ])
    expect(connectedComponents([...edges].reverse())).toEqual(expected)

    fc.assert(
      fc.property(fc.shuffledSubarray([...edges], { minLength: edges.length }), (shuffled) => {
        expect(connectedComponents(shuffled)).toEqual(expected)
      }),
      { numRuns: 200 }
    )
  })

  it("normalizes a mirrored edge, so (a,b) and (b,a) are one edge", () => {
    // `topNeighborPairs` offers each pair to BOTH endpoints' neighborhoods, so mirrors really arrive.
    expect(
      connectedComponents([
        ["a.html", "b.html"],
        ["b.html", "a.html"]
      ])
    ).toEqual([["a.html", "b.html"]])
  })

  it("admits a self-edge as a lone member and joins nothing to it", () => {
    expect(connectedComponents([["a.html", "a.html"]])).toEqual([["a.html"]])
  })

  it("names every key exactly once across the whole partition", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(path, path), { maxLength: 30 }), (edges) => {
        const components = connectedComponents(edges)
        const members = components.flat()
        expect(new Set(members).size).toBe(members.length)
        // Every endpoint of every edge is placed, and nothing else is.
        expect(new Set(members)).toEqual(new Set(edges.flat()))
      }),
      { numRuns: 500 }
    )
  })

  it("puts two keys in one component exactly when an edge path joins them", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(path, path), { maxLength: 24 }), (edges) => {
        const components = connectedComponents(edges)
        const componentOf = new Map<string, number>()
        components.forEach((members, at) => {
          for (const member of members) componentOf.set(member, at)
        })
        // Reachability, computed independently of the union-find.
        const neighbors = new Map<string, Set<string>>()
        for (const [left, right] of edges) {
          for (const [from, to] of [
            [left, right],
            [right, left]
          ] as const) {
            const bucket = neighbors.get(from) ?? new Set<string>()
            bucket.add(to)
            neighbors.set(from, bucket)
          }
        }
        for (const start of new Set(edges.flat())) {
          const seen = new Set([start])
          const queue = [start]
          while (queue.length > 0) {
            const at = queue.pop() as string
            for (const next of neighbors.get(at) ?? []) {
              if (seen.has(next)) continue
              seen.add(next)
              queue.push(next)
            }
          }
          for (const reached of seen) {
            expect(componentOf.get(reached)).toBe(componentOf.get(start))
          }
        }
      }),
      { numRuns: 300 }
    )
  })

  it("is empty for no edges", () => {
    expect(connectedComponents([])).toEqual([])
  })
})

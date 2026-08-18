import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  bridgeCounts,
  type GraphEdge,
  labelPropagation,
  MIN_COMMUNITY_SIZE,
  PAGERANK_DAMPING,
  pagerank
} from "../src/graph.js"

const node = fc.stringMatching(/^n[0-9]$/)

const graph = fc
  .tuple(
    fc.uniqueArray(node, { minLength: 1, maxLength: 10 }),
    fc.array(fc.tuple(node, node, fc.double({ min: 0.01, max: 1, noNaN: true })), { maxLength: 25 })
  )
  .map(([nodes, rawEdges]): { nodes: ReadonlyArray<string>; edges: ReadonlyArray<GraphEdge> } => ({
    nodes,
    edges: rawEdges.map(([src, dst, strength]) => ({ src, dst, strength }))
  }))

/** The same graph with nodes and edges shuffled — the input a second run might see. */
const shuffled = <T>(values: ReadonlyArray<T>): ReadonlyArray<T> => [...values].reverse()

describe("pagerank", () => {
  it("pins the damping factor", () => {
    expect(PAGERANK_DAMPING).toBe(0.85)
  })

  it("returns nothing for an empty node set", () => {
    expect(pagerank([], []).size).toBe(0)
    expect(pagerank([], [{ src: "a", dst: "b", strength: 1 }]).size).toBe(0)
  })

  it("scores every node and nothing else", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const scores = pagerank(nodes, edges)
        expect(scores.size).toBe(new Set(nodes).size)
        for (const name of scores.keys()) {
          expect(nodes).toContain(name)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("keeps the score mass at 1, so a dangling node leaks nothing", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const total = [...pagerank(nodes, edges).values()].reduce((sum, score) => sum + score, 0)
        expect(total).toBeCloseTo(1, 6)
      }),
      { numRuns: 1000 }
    )
  })

  it("scores every node strictly positive, since teleport reaches all of them", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        for (const score of pagerank(nodes, edges).values()) {
          expect(score).toBeGreaterThan(0)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is deterministic: the same graph in any input order gives the same scores", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const first = pagerank(nodes, edges)
        const second = pagerank(shuffled(nodes), shuffled(edges))
        expect([...second.keys()]).toEqual([...first.keys()])
        for (const [name, score] of first) {
          expect(second.get(name)).toBe(score)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is deterministic across repeated calls", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        expect([...pagerank(nodes, edges)]).toEqual([...pagerank(nodes, edges)])
      }),
      { numRuns: 1000 }
    )
  })

  it("distributes uniformly over an edgeless graph", () => {
    fc.assert(
      fc.property(fc.uniqueArray(node, { minLength: 1, maxLength: 8 }), (nodes) => {
        for (const score of pagerank(nodes, []).values()) {
          expect(score).toBeCloseTo(1 / nodes.length, 9)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("ranks a hub above its sources", () => {
    const scores = pagerank(
      ["hub", "a", "b", "c"],
      [
        { src: "a", dst: "hub", strength: 1 },
        { src: "b", dst: "hub", strength: 1 },
        { src: "c", dst: "hub", strength: 1 }
      ]
    )
    const hub = scores.get("hub") ?? 0
    for (const source of ["a", "b", "c"]) {
      expect(hub).toBeGreaterThan(scores.get(source) ?? 0)
    }
  })

  it("shifts mass toward the seeds under personalization, so the walk is query-conditioned", () => {
    const nodes = ["a", "b", "c", "d"]
    const edges: ReadonlyArray<GraphEdge> = [
      { src: "a", dst: "b", strength: 1 },
      { src: "c", dst: "d", strength: 1 }
    ]
    const uniform = pagerank(nodes, edges)
    const seeded = pagerank(nodes, edges, { seeds: new Map([["a", 1]]) })
    expect(seeded.get("a") ?? 0).toBeGreaterThan(uniform.get("a") ?? 0)
    expect(seeded.get("d") ?? 0).toBeLessThan(uniform.get("d") ?? 0)
  })

  it("falls back to the uniform prior when every seed names an absent node", () => {
    const nodes = ["a", "b", "c"]
    const edges: ReadonlyArray<GraphEdge> = [{ src: "a", dst: "b", strength: 1 }]
    expect([...pagerank(nodes, edges, { seeds: new Map([["zz", 1]]) })]).toEqual([
      ...pagerank(nodes, edges)
    ])
  })

  it("ignores self-loops and edges naming an absent node", () => {
    const nodes = ["a", "b"]
    const clean = pagerank(nodes, [{ src: "a", dst: "b", strength: 1 }])
    const noisy = pagerank(nodes, [
      { src: "a", dst: "b", strength: 1 },
      { src: "a", dst: "a", strength: 1 },
      { src: "a", dst: "ghost", strength: 1 },
      { src: "ghost", dst: "b", strength: 1 }
    ])
    expect([...noisy]).toEqual([...clean])
  })

  it("folds parallel edges to their maximum strength rather than summing them", () => {
    const nodes = ["a", "b", "c"]
    const folded = pagerank(nodes, [
      { src: "a", dst: "b", strength: 0.4 },
      { src: "a", dst: "b", strength: 0.9 },
      { src: "a", dst: "c", strength: 0.9 }
    ])
    const single = pagerank(nodes, [
      { src: "a", dst: "b", strength: 0.9 },
      { src: "a", dst: "c", strength: 0.9 }
    ])
    expect([...folded]).toEqual([...single])
  })
})

describe("labelPropagation", () => {
  it("pins the community-size floor", () => {
    expect(MIN_COMMUNITY_SIZE).toBe(3)
  })

  it("labels every node, and nothing else", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const communities = labelPropagation(nodes, edges)
        expect(communities.size).toBe(new Set(nodes).size)
        for (const name of communities.keys()) {
          expect(nodes).toContain(name)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is deterministic: the same graph in any input order gives the same partition", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        expect([...labelPropagation(shuffled(nodes), shuffled(edges))]).toEqual([
          ...labelPropagation(nodes, edges)
        ])
      }),
      { numRuns: 1000 }
    )
  })

  it("is deterministic across repeated calls", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        expect([...labelPropagation(nodes, edges)]).toEqual([...labelPropagation(nodes, edges)])
      }),
      { numRuns: 1000 }
    )
  })

  it("gives every member of a community the same label, and that label is a member", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const communities = labelPropagation(nodes, edges)
        const members = new Map<string, Array<string>>()
        for (const [name, label] of communities) {
          if (label === undefined) continue
          const bucket = members.get(label)
          if (bucket === undefined) members.set(label, [name])
          else bucket.push(name)
        }
        for (const [label, group] of members) {
          expect(group.length).toBeGreaterThanOrEqual(MIN_COMMUNITY_SIZE)
          expect(group).toContain(label)
          expect([...group].sort()[0]).toBe(label)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("breaks an equal-weight label tie toward the lexicographically smaller label", () => {
    // Adopting whichever label the neighbor map happens to enumerate first would make the
    // partition depend on edge insertion order; sorting the candidate labels pins it. Witness
    // found by differential search 2026-08-02 — unsorted enumeration collapses all four nodes
    // into one community here, and the difference survives canonicalization.
    const communities = labelPropagation(
      ["n0", "n1", "n2", "n3"],
      [
        { src: "n2", dst: "n3", strength: 0.5 },
        { src: "n0", dst: "n3", strength: 0.25 },
        { src: "n1", dst: "n0", strength: 0.25 }
      ],
      { minCommunitySize: 1 }
    )
    expect([...communities]).toEqual([
      ["n0", "n0"],
      ["n1", "n0"],
      ["n2", "n2"],
      ["n3", "n2"]
    ])
  })

  it("is invariant to edge insertion order, which an unsorted tie-break is not", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const rotations = edges.map((_, offset) => [
          ...edges.slice(offset),
          ...edges.slice(0, offset)
        ])
        const reference = [...labelPropagation(nodes, edges, { minCommunitySize: 1 })]
        for (const rotated of rotations) {
          expect([...labelPropagation(nodes, rotated, { minCommunitySize: 1 })]).toEqual(reference)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("leaves an isolated node and a bare pair uncommunitied", () => {
    const communities = labelPropagation(
      ["a", "b", "lonely"],
      [{ src: "a", dst: "b", strength: 1 }]
    )
    expect(communities.get("a")).toBeUndefined()
    expect(communities.get("b")).toBeUndefined()
    expect(communities.get("lonely")).toBeUndefined()
  })

  it("finds a triangle as one community and keeps a separate triangle separate", () => {
    const triangle = (prefix: string): ReadonlyArray<GraphEdge> => [
      { src: `${prefix}1`, dst: `${prefix}2`, strength: 1 },
      { src: `${prefix}2`, dst: `${prefix}3`, strength: 1 },
      { src: `${prefix}3`, dst: `${prefix}1`, strength: 1 }
    ]
    const communities = labelPropagation(
      ["x1", "x2", "x3", "y1", "y2", "y3"],
      [...triangle("x"), ...triangle("y")]
    )
    expect(communities.get("x1")).toBe("x1")
    expect(communities.get("x2")).toBe("x1")
    expect(communities.get("x3")).toBe("x1")
    expect(communities.get("y1")).toBe("y1")
    expect(communities.get("y3")).toBe("y1")
  })
})

describe("bridgeCounts", () => {
  it("counts nothing when no node is in a community", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const none = new Map<string, string | undefined>(nodes.map((name) => [name, undefined]))
        for (const count of bridgeCounts(nodes, edges, none).values()) {
          expect(count).toBe(0)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("counts only edges crossing a community boundary, both endpoints", () => {
    const nodes = ["a1", "a2", "b1", "b2"]
    const edges: ReadonlyArray<GraphEdge> = [
      { src: "a1", dst: "a2", strength: 1 },
      { src: "a1", dst: "b1", strength: 1 }
    ]
    const communities = new Map<string, string | undefined>([
      ["a1", "a1"],
      ["a2", "a1"],
      ["b1", "b1"],
      ["b2", "b1"]
    ])
    const counts = bridgeCounts(nodes, edges, communities)
    expect(counts.get("a1")).toBe(1)
    expect(counts.get("b1")).toBe(1)
    expect(counts.get("a2")).toBe(0)
    expect(counts.get("b2")).toBe(0)
  })

  it("never counts more bridges for a node than its total degree", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const communities = labelPropagation(nodes, edges)
        const counts = bridgeCounts(nodes, edges, communities)
        const degree = new Map<string, number>()
        for (const edge of edges) {
          if (edge.src === edge.dst) continue
          degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1)
          degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1)
        }
        for (const [name, count] of counts) {
          expect(count).toBeLessThanOrEqual(degree.get(name) ?? 0)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it("is deterministic over any input order", () => {
    fc.assert(
      fc.property(graph, ({ nodes, edges }) => {
        const communities = labelPropagation(nodes, edges)
        expect([...bridgeCounts(shuffled(nodes), shuffled(edges), communities)].sort()).toEqual(
          [...bridgeCounts(nodes, edges, communities)].sort()
        )
      }),
      { numRuns: 1000 }
    )
  })
})

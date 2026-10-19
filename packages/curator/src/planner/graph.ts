import { UndirectedGraph } from "graphology"
import louvainModule from "graphology-communities-louvain"
import pagerankModule from "graphology-metrics/centrality/pagerank.js"

import type { SimilarityEdge } from "./similarity.js"

/**
 * Community detection and the anchor score over one partition's graph.
 *
 * Louvain, not Leiden. Leiden is the better algorithm (it refines communities so each is connected),
 * and the spec prefers it when a maintained npm package exists. Probed 2026-09-24: the graphology
 * monorepo ships no Leiden; the only npm Leiden implementations for graphology are a single-publisher
 * extraction (`@aflsolutions/graphology-communities-leiden`) and two unrelated graph libraries'
 * ports (`ngraph.leiden`, `leiden-ts`), none of them the maintained project that owns the graph type
 * this planner builds. So this is `graphology-communities-louvain` from the maintained monorepo, run
 * with a seeded generator in place of `Math.random` so the same graph yields the same communities,
 * which is what makes a plan reproducible and `--plan <file>` a replay rather than a re-roll.
 *
 * The anchor is PageRank (`graphology-metrics`, weighted, default damping 0.85): the member most
 * pointed at by strong edges is the best canonical candidate, the way the 2026-09-24 graph-cuts
 * analysis picked one per community.
 */

/**
 * The two CJS packages declare `export default` in a `.d.ts` TypeScript reads as CommonJS, so under
 * `NodeNext` the default import is typed as the module object while Node hands the function itself
 * (probed 2026-09-24: `m.default.detailed` is a function, `m.default.default` is undefined). One
 * cast per package bridges the two; `graphology` itself ships an `.mjs` with named exports, so its
 * class is imported by name and needs none.
 */
const louvain = louvainModule as unknown as typeof louvainModule.default
const pagerank = pagerankModule as unknown as typeof pagerankModule.default

/** A weighted undirected edge between two records of one partition. */
export interface WeightedEdge {
  readonly from: string
  readonly to: string
  readonly weight: number
}

export interface Communities {
  /** Communities with at least two members, largest first, then by first path. Members sorted. */
  readonly communities: ReadonlyArray<ReadonlyArray<string>>
  /** Every node's PageRank in the partition graph, so an anchor is defined for isolated nodes too. */
  readonly pagerank: ReadonlyMap<string, number>
  readonly modularity: number
  readonly edges: number
}

/** mulberry32: a small seeded generator over [0, 1), enough to fix Louvain's visiting order. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Build the partition graph from every node and the edge layers, and cut it.
 *
 * Edges between the same pair from different layers add their weights, so a pair that is both
 * lexically close and shares an entity binds tighter than either alone. A partition with no edge has
 * no community: every node is its own, and PageRank is uniform.
 */
export const detectCommunities = (
  nodes: ReadonlyArray<string>,
  layers: ReadonlyArray<ReadonlyArray<WeightedEdge | SimilarityEdge>>,
  seed: number
): Communities => {
  const graph = new UndirectedGraph({ allowSelfLoops: false })
  for (const node of [...nodes].sort(byString)) graph.addNode(node)
  for (const layer of layers) {
    for (const edge of layer) {
      if (edge.from === edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue
      if (graph.hasEdge(edge.from, edge.to)) {
        graph.updateEdgeAttribute(
          edge.from,
          edge.to,
          "weight",
          (weight: number | undefined) => (weight ?? 0) + edge.weight
        )
      } else {
        graph.addEdge(edge.from, edge.to, { weight: edge.weight })
      }
    }
  }
  const ranks = new Map<string, number>()
  if (graph.order === 0) return { communities: [], pagerank: ranks, modularity: 0, edges: 0 }
  const scores = pagerank(graph, { getEdgeWeight: "weight" })
  for (const node of graph.nodes()) ranks.set(node, scores[node] ?? 0)
  if (graph.size === 0) return { communities: [], pagerank: ranks, modularity: 0, edges: 0 }

  const detailed = louvain.detailed(graph, { getEdgeWeight: "weight", rng: seededRandom(seed) })
  const grouped = new Map<number, Array<string>>()
  for (const node of graph.nodes()) {
    // An isolated node forms a community of one, which is a singleton rather than a cluster.
    if (graph.degree(node) === 0) continue
    const community = detailed.communities[node]
    if (community === undefined) continue
    const members = grouped.get(community) ?? []
    members.push(node)
    grouped.set(community, members)
  }
  const communities = [...grouped.values()]
    .filter((members) => members.length > 1)
    .map((members) => [...members].sort(byString))
    .sort((a, b) => b.length - a.length || byString(a[0] ?? "", b[0] ?? ""))
  return { communities, pagerank: ranks, modularity: detailed.modularity, edges: graph.size }
}

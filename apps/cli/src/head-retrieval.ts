import { tokenize } from "@memhtml/head"
import {
  budgetFor,
  DEFAULT_SEARCH_LIMIT,
  type DisclosureCandidate,
  foldDisclosure,
  hasFtsTerms,
  MEMORY_BODY_BUDGET,
  MMR_POOL_FACTOR,
  type RecallPack,
  type SearchResult
} from "@memhtml/index"
import { Effect } from "effect"

import { askHead } from "./head-client.js"
import { type HeadScope, MCP_HEAD_VAR, SearchAnswer } from "./head-protocol.js"
import type { RecallParams, SearchParams } from "./operations.js"

/**
 * `memory_search` and `memory_recall` answered from the head server (`docs/v2-poc.md`, "Search and
 * recall on the head"), for the MCP server the gateway runs.
 *
 * The index (`.memhtml/index.db`) is a projection someone has to update; the head server follows the
 * ref and never lags it. A record a run session commits is in the head's next answer and in the
 * index only after the next `memhtml index update`. So both tools ask the socket first and take the
 * index path they always took when the socket gives no answer, or when the call asks for something
 * the head cannot answer the way the index would ({@link routeFor}).
 *
 * The answer is v1's `SearchResult` or `RecallPack` exactly, so the handlers shape it with the code
 * they already had and a caller cannot tell the doors apart by the fields. The ranking is the head's:
 * BM25 and the vector arm fused by RRF with recency as the tie-break, where v1 also fuses a recency
 * and a salience arm and diversifies with MMR.
 */

export { MCP_HEAD_VAR }

/**
 * How long a tool call waits for the head's answer once connected. The server bounds its query
 * embed at 450 ms by default (600 ms on the live unit) and answers a search in a few milliseconds
 * after it, so 2 s is slack for an advance over a large delta; past it the index answers instead.
 */
export const HEAD_RETRIEVAL_TIMEOUT_MS = 2_000

/** Why a call went to the index rather than the head. */
export type IndexReason =
  /** {@link MCP_HEAD_VAR} is `off`. */
  | "disabled"
  /** `include_archived`: the head's arms rank active records only. */
  | "include-archived"
  /** `as_of`: a record carries no validity window, and the lens needs archived records ranked too. */
  | "as-of"
  /** A double-quoted span, which v1 matches as an FTS5 phrase; the head's BM25 has no phrases. */
  | "phrase"
  /**
   * No term the head's BM25 indexes (none at all, or only its stop words, which v1's FTS5 keeps): v1
   * still ranks by its other arms, the head only by the vector arm.
   */
  | "no-terms"
  /** The socket gave no answer: no server, a timeout, a refusal (an older server), a bad body. */
  | "no-answer"

export type Routing = { readonly route: "head" } | { readonly route: "index"; reason: IndexReason }

/**
 * Where one call goes. Every parameter not named here routes to the head: `query`, `limit`,
 * `memory_types`, `workspace`, `tags`, `entity`, `facets`, and recall's `budget_chars`.
 */
export const routeFor = (
  params: SearchParams | RecallParams,
  env: Readonly<Record<string, string | undefined>> = process.env
): Routing => {
  if (env[MCP_HEAD_VAR]?.trim().toLowerCase() === "off")
    return { route: "index", reason: "disabled" }
  if (params.includeArchived === true) return { route: "index", reason: "include-archived" }
  if (params.asOf !== undefined && params.asOf !== "") return { route: "index", reason: "as-of" }
  if (params.query.includes('"')) return { route: "index", reason: "phrase" }
  if (!hasFtsTerms(params.query) || tokenize(params.query).length === 0)
    return { route: "index", reason: "no-terms" }
  return { route: "head" }
}

/** The request's scope: only the axes the call named, so an absent one stays absent. */
const scopeOf = (params: SearchParams | RecallParams): HeadScope => ({
  ...(params.memoryTypes === undefined ? {} : { memoryTypes: params.memoryTypes }),
  ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
  ...(params.tags === undefined ? {} : { tags: params.tags }),
  ...(params.entity === undefined ? {} : { entity: params.entity }),
  ...(params.facets === undefined
    ? {}
    : { facets: params.facets.map((facet) => ({ name: facet.name, value: facet.value })) })
})

/** One scoped, detailed search on the socket, or `null` when no usable answer came back. */
const ask = (root: string, params: SearchParams | RecallParams, limit: number | undefined) =>
  askHead({
    root,
    route: "search",
    schema: SearchAnswer,
    body: {
      query: params.query,
      ...(limit === undefined ? {} : { limit }),
      scope: scopeOf(params),
      detail: true
    },
    answerTimeoutMs: HEAD_RETRIEVAL_TIMEOUT_MS
  }).pipe(
    Effect.map((answered) => {
      if (answered === null) return null
      const { data } = answered
      // A server that took the request but did not scope it or detail its hits is not this protocol;
      // an older server refuses the body outright (excess properties), so this is belt and braces.
      if (data.scope === undefined) return null
      const hits = data.hits.flatMap((hit) =>
        hit.detail === undefined ? [] : [{ ...hit, detail: hit.detail }]
      )
      return hits.length === data.hits.length ? { ...data, scope: data.scope, hits } : null
    })
  )

/**
 * The arms named on a head answer, in v1's vocabulary: `fts` for BM25, `vector` when the vector arm
 * ran, and `recency`, which decides between equal fused scores. The head has no salience arm.
 */
const armsOf = (vectorUsed: boolean): ReadonlyArray<string> =>
  vectorUsed ? ["fts", "vector", "recency"] : ["fts", "recency"]

/** `memory_search` on the head, or `null` for the index: see {@link routeFor}. */
export const searchOnHead = (
  root: string,
  params: SearchParams
): Effect.Effect<SearchResult | null> =>
  Effect.gen(function* () {
    const routing = routeFor(params)
    if (routing.route === "index") {
      yield* Effect.logDebug(`memory_search: index (${routing.reason})`)
      return null
    }
    const answer = yield* ask(root, params, params.limit)
    if (answer === null) {
      yield* Effect.logDebug("memory_search: index (no-answer)")
      return null
    }
    yield* Effect.logDebug(`memory_search: head at ${answer.head.sha}`)
    return {
      hits: answer.hits.map((hit) => ({
        path: hit.path,
        title: hit.detail.title,
        gist: hit.claim,
        memoryType: hit.detail.memoryType,
        score: hit.score,
        confidence: hit.detail.confidence,
        updatedAt: hit.detail.updatedAt,
        snippet: hit.detail.snippet,
        entities: hit.detail.entities,
        supersededBy: hit.detail.supersededBy
      })),
      degraded: !answer.vector.used,
      vectorCoverage: answer.vector.coverage ?? 0,
      arms: armsOf(answer.vector.used),
      entityScope: params.entity === undefined || params.entity === "" ? null : params.entity,
      scopeEmpty: answer.scope.empty,
      archivedMatches: answer.scope.archivedMatches,
      archived: answer.scope.archived
    }
  })

/**
 * `memory_recall` on the head, or `null` for the index. The pool is v1's, `DEFAULT_SEARCH_LIMIT *
 * MMR_POOL_FACTOR` candidates in fused order, folded by v1's own `foldDisclosure`: arcs under their
 * envelope, the rest under the budget.
 */
export const recallOnHead = (
  root: string,
  params: RecallParams
): Effect.Effect<RecallPack | null> =>
  Effect.gen(function* () {
    const routing = routeFor(params)
    if (routing.route === "index") {
      yield* Effect.logDebug(`memory_recall: index (${routing.reason})`)
      return null
    }
    const answer = yield* ask(root, params, DEFAULT_SEARCH_LIMIT * MMR_POOL_FACTOR)
    if (answer === null) {
      yield* Effect.logDebug("memory_recall: index (no-answer)")
      return null
    }
    yield* Effect.logDebug(`memory_recall: head at ${answer.head.sha}`)
    const candidates = answer.hits.map(
      (hit): DisclosureCandidate => ({
        path: hit.path,
        title: hit.detail.title,
        gist: hit.claim,
        memoryType: hit.detail.memoryType,
        disclosureText: hit.detail.disclosureText,
        entityNames: hit.detail.entityNames
      })
    )
    const arcs = foldDisclosure(
      candidates.filter((candidate) => candidate.memoryType === "arc"),
      budgetFor("arc")
    )
    const memories = foldDisclosure(
      candidates.filter((candidate) => candidate.memoryType !== "arc"),
      params.budgetChars ?? MEMORY_BODY_BUDGET
    )
    return {
      arcs,
      memories,
      spentChars: arcs.spentChars + memories.spentChars,
      truncated: arcs.truncated || memories.truncated,
      degraded: !answer.vector.used,
      vectorCoverage: answer.vector.coverage ?? 0
    }
  })

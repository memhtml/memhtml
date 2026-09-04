import type { ModelUnavailable, StorageFailure } from "@memhtml/contracts/errors"
import { applyMmr, MMR_LAMBDA, type MmrCandidate } from "@memhtml/domain"
import { Context, Effect } from "effect"

import type { DatabaseShape, SqlValue } from "./database.js"
import {
  budgetFor,
  type DisclosureCandidate,
  foldDisclosure,
  MEMORY_BODY_BUDGET
} from "./disclosure.js"
import { sanitizeFtsQuery } from "./fts-query.js"
import {
  buildRrfSql,
  buildSnippetSql,
  PARAM_QUERY_VECTOR,
  rrfParams,
  truncateSnippet
} from "./retrieval-sql.js"
import { assembleScope, type SearchScope } from "./scope.js"

/**
 * The retrieval surface: `search` returns ranked hits, `recall` returns a pack under a budget.
 *
 * Both sit on the same fused SQL and the same MMR pass, so a ranking change cannot apply to one and
 * not the other. Neither ever names `traces` or `trace_prompts`. A test greps every statement this
 * module can assemble to prove it, which is how the trace firewall is enforced without a second
 * database.
 */

/** How many candidates each arm contributes before fusion. */
export const DEFAULT_ARM_LIMIT = 40

/** How many hits `search` returns when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 10

/**
 * Fused candidates fetched before MMR, as a multiple of the final limit. Diversification can only
 * reorder what it was given, so a pool the size of the limit makes MMR a no-op.
 */
export const MMR_POOL_FACTOR = 3

/** The query and its scope. Mirrors `memory_search`'s parameters. */
export interface SearchInput extends SearchScope {
  readonly query: string
  readonly limit?: number | undefined
}

/** One ranked hit. */
export interface SearchHit {
  readonly path: string
  readonly title: string
  readonly gist: string
  readonly memoryType: string
  /** The fused RRF score, unitless and comparable only within one result set. */
  readonly score: number
  readonly confidence: number
  readonly updatedAt: string
  /**
   * The text of this file's best-matching chunk for THIS query, truncated to `SNIPPET_MAX_CHARS`
   * with a `…` marker when cut. "Best" is nearest-to-the-query-vector when the vector arm ran. On
   * the degraded path it is the file's ordinal-0 chunk, the article's opening text, which for the
   * one-fact-per-file common case is the whole article. Empty string only when the file has no
   * chunk at all (an empty article), never absent.
   */
  readonly snippet: string
  /**
   * Every entity this memory carries, in `type:name` form, so `person:sanju` and never bare `sanju`.
   *
   * The form is a CONTRACT with the `entity` scope rather than a display choice. A value taken from
   * this array must be usable verbatim as the next search's `entity`, which makes a two-hop chain
   * two tool calls instead of a guess about how to spell the reference. `file_entities` is keyed on
   * `(type, name)`, so a bare name would be ambiguous and the second hop would scope to whichever
   * type the corpus happened to hold.
   *
   * Empty array when the memory names no entity, never absent. A caller reading an absent key cannot
   * tell "no entities" from "this server does not report them".
   */
  readonly entities: ReadonlyArray<string>
  /**
   * The path of the memory that superseded this one, or `null` when nothing has. Non-null only for
   * an archived hit, which reaches a result set through `asOf` or `includeArchived`, so a
   * point-in-time answer reads as history. The hit was believed then, and THIS is what
   * replaced it. Present-and-nullable in every result, so a caller can tell "not superseded" from
   * "this build does not report supersession".
   *
   * Derived from the `edges` table rather than the `memhtml-superseded-by` head meta. The loser is
   * the `dst_path` of the winner's authored `supersedes` edge, which `edges_dst` indexes. The
   * meta reaches no SQL column at all, so reading it would cost a file open per hit.
   */
  readonly supersededBy: string | null
}

/** A search's outcome. */
export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>
  /**
   * True when the vector arm did not fire, because the embedder failed or the index has no vectors,
   * so the result came from the lexical floor. Reported rather than silent, because an agent
   * comparing two searches needs to know one of them was ranked by fewer signals.
   */
  readonly degraded: boolean
  /** The arms that actually contributed, for the operator envelope. */
  readonly arms: ReadonlyArray<string>
  /**
   * The entity reference this search was scoped to, or `null` when it was not scoped by entity.
   *
   * Echoed back so an empty result is ATTRIBUTABLE. A scope that matches nothing never widens here,
   * since there is no fallback to widen to. The failure mode left is a caller who cannot tell a
   * corpus with no answer from a scope with a typo in it, and this field is what tells them.
   */
  readonly entityScope: string | null
  /**
   * True when a scope was named, it narrowed the query, and nothing survived it.
   *
   * A BOOLEAN in every case rather than a field that appears only when it fires. The CLI's `--dense`
   * drops null-valued keys (`apps/cli/src/envelope.ts:139`), so a marker that were null when absent
   * would vanish from exactly the output an agent pastes into a context window. `false` costs five
   * bytes and is unambiguous.
   *
   * Never `true` for an unscoped empty result. An empty corpus is not an over-narrow scope, and
   * conflating them would make the marker mean "no hits", which `hits.length` already says.
   */
  readonly scopeEmpty: boolean
  /**
   * How many ARCHIVED memories the same scope matches, computed only when `scopeEmpty` is true and
   * `0` otherwise.
   *
   * The pointer behind an empty scope. Eviction and compress are a `git mv` into `archive/`, and the
   * default scope excludes archived rows, so a correct facet over a real record (`day=2026-09-02` on a
   * journal compress folded last night) answers nothing and, without this number, says nothing about
   * why. With it an agent can tell "never existed" from "archived": retry with `includeArchived`, or
   * follow `archived[].supersededBy` to what replaced it (issue #130). A scope match rather than a
   * ranked one: the question is whether the scope's address still resolves, not how the query would
   * rank what it points at. Only the scope's own axes are re-applied; the archived flag is what flips.
   * Zero as well under `asOf`, whose lens already admits archived rows, so the flag is not what
   * emptied that search.
   */
  readonly archivedMatches: number
  /**
   * Up to `limit` of those archived paths, sorted, each with the path of the memory that superseded it
   * or `null` when nothing did. Empty unless `scopeEmpty` is true. `supersededBy` is derived from the
   * `supersedes` edge the way a hit's is, so compress's canonical and `correct`'s replacement both
   * resolve.
   */
  readonly archived: ReadonlyArray<ArchivedMatch>
}

/** One archived memory the scope of an empty search still matches. */
export interface ArchivedMatch {
  readonly path: string
  readonly supersededBy: string | null
}

/** A recall request. `budgetChars` bounds the quoted bodies, not the index lines. */
export interface RecallInput extends SearchScope {
  readonly query: string
  readonly budgetChars?: number | undefined
}

/** The recall pack. Arcs and ordinary memories fold separately, each under its own envelope. */
export interface RecallPack {
  readonly arcs: ReturnType<typeof foldDisclosure>
  readonly memories: ReturnType<typeof foldDisclosure>
  readonly spentChars: number
  readonly truncated: boolean
  readonly degraded: boolean
}

export interface RetrievalShape {
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, StorageFailure>
  readonly recall: (input: RecallInput) => Effect.Effect<RecallPack, StorageFailure>
}

export const Retrieval = Context.Service<RetrievalShape>("memhtml/Retrieval")

/** What the query embedder must provide. Structurally `@memhtml/llm`'s `embedQuery`. */
export interface QueryEmbedPort {
  readonly embedQuery: (text: string) => Effect.Effect<Float32Array, ModelUnavailable>
}

export interface RetrievalDeps {
  readonly db: DatabaseShape
  readonly embeddings?: QueryEmbedPort | undefined
}

/** The columns `search` and `recall` both read off a fused path list. */
interface HitRow {
  readonly path: string
  readonly title: string
  readonly gist: string
  readonly memory_type: string
  readonly confidence: number
  readonly updated_at: string
  readonly body_text: string
  readonly disclosure_text: string
  readonly entity_names: string | null
  readonly entity_refs: string | null
  readonly superseded_by: string | null
  readonly vec: Uint8Array | null
}

/**
 * Did the caller narrow the candidate set at all?
 *
 * What makes an empty result ATTRIBUTABLE to a scope rather than to the corpus. The archived flag is
 * excluded on purpose, because `includeArchived` WIDENS. A caller who passed nothing but that has not
 * narrowed anything and an empty result is the corpus's answer. Same for an empty type list, which
 * reaches here from a flag nobody passed.
 */
const scopeNarrows = (scope: SearchScope): boolean =>
  (scope.memoryTypes ?? []).length > 0 ||
  (scope.workspace !== undefined && scope.workspace !== "") ||
  (scope.tags ?? []).some((tag) => tag.trim() !== "") ||
  (scope.entity !== undefined && scope.entity !== "") ||
  // Every axis `assembleScope` can emit a condition for has to be named here, or a facet-scoped query
  // that matched nothing reports `scopeEmpty: false` and an agent reads the empty result as the
  // corpus's answer rather than as its own predicate.
  (scope.facets ?? []).some((facet) => facet.name.trim() !== "" && facet.value.trim() !== "")

export const makeRetrieval = (deps: RetrievalDeps): RetrievalShape => {
  const { db } = deps

  /**
   * The query vector, or `undefined` when there is none.
   *
   * A model failure is caught here and degrades the search rather than failing it. Retrieval gets
   * narrower when Bedrock is down and does not error. The failure is logged so a degraded run is
   * visible to an operator instead of only to the `degraded` flag on the response.
   */
  const queryVector = (query: string): Effect.Effect<Uint8Array | undefined> =>
    deps.embeddings === undefined
      ? Effect.succeed(undefined)
      : deps.embeddings.embedQuery(query).pipe(
          Effect.map(
            (vector) =>
              new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength) as
                | Uint8Array
                | undefined
          ),
          Effect.tapError((error) =>
            Effect.logError(`retrieval: lexical floor, embedder failed: ${error.reason}`)
          ),
          Effect.orElseSucceed(() => undefined)
        )

  /**
   * Run the fold and return fused paths, best first.
   *
   * The parameter tuple is always four values wide with `null` at `?4` when there is no query
   * vector, even though the assembled SQL then references no `?4` at all. Binding the same prefix
   * either way is what keeps the scope values at `?5` onward in fixed positions. A tuple that
   * shrank would silently shift every scope placeholder onto the wrong value.
   */
  const fuse = (input: {
    readonly query: string
    readonly scope: SearchScope
    readonly limit: number
    readonly vector: Uint8Array | undefined
  }) =>
    Effect.gen(function* () {
      const assembled = assembleScope(input.scope)
      /**
       * The MATCH text, not the caller's prose. Several forms that appear in ordinary agent queries
       * are HARD driver errors rather than empty results: an apostrophe, a `type:name` entity
       * reference, a leading hyphen. So the query is reduced to indexable terms and the lexical arm
       * is dropped entirely when nothing survives.
       */
      const matchQuery = sanitizeFtsQuery(input.query)
      const sql = buildRrfSql({
        hasQueryVector: input.vector !== undefined,
        hasState: db.hasState,
        hasQueryTerms: matchQuery !== "",
        holes: assembled.holes
      })
      if (sql === undefined) return { paths: [] as ReadonlyArray<string>, sql: "" }

      const params: ReadonlyArray<SqlValue> = rrfParams(sql, {
        matchQuery,
        armLimit: DEFAULT_ARM_LIMIT,
        finalLimit: input.limit,
        vector: input.vector,
        scopeParams: assembled.params
      })
      const rows = yield* db.all<{ path: string; score: number }>(sql, params)
      return { paths: rows.map((row) => row.path), sql }
    })

  /**
   * Hydrate fused paths into full rows, in the fused order.
   *
   * `entity_names`, `entity_refs`, and `vec` come along in the same statement. The names drive the
   * recall fold's per-entity cap, the refs are what a search hit publishes, and the vector drives MMR.
   * Fetching them here rather than per hit is what keeps retrieval at a fixed statement count
   * regardless of result size: fuse, hydrate, and (for `search`) one snippet fetch.
   *
   * **Two projections of `file_entities`, and the duplication is load-bearing.** The fold's cap is
   * keyed on the entity NAME ALONE (`disclosure.ts:112`) so that one memory claiming `person:sanju`
   * and `concept:sanju` counts once against the name it shares. A search hit publishes the FULL
   * `type:name` reference, because that string is the next hop's `entity` scope and the bare name is
   * ambiguous. Collapsing the two into one column would silently move the cap or break the chain,
   * and the first of those has no test that could see it as anything but a ranking wobble.
   *
   * **`superseded_by` names `edge_class` so the subquery can probe `edges_dst`, and the predicate
   * changes no row.** The class is implied: `edges`' CHECK constraints admit `rel = 'supersedes'`
   * only under `edge_class = 'memory'` (`0004_edges.sql`), so this narrows nothing and is a planner
   * constraint rather than a filter. Measured 2026-08-26 on node 24's `node:sqlite` with no
   * `ANALYZE`: `dst_path = ? AND rel = ? AND derived = 0` alone plans as `SEARCH g USING INDEX
   * edges_derived (derived=? AND rel=?)`, which binds `(0, 'supersedes')` and walks EVERY correction
   * in the corpus once per hit; naming `edge_class` binds two columns of `edges_dst (dst_path,
   * edge_class)` and the same subquery plans as a probe. This is `0011_edge_indexes.sql`'s rule read
   * from the other side — an index that binds more equality columns wins the planner's guess, so a
   * correlated subquery that omits a column the index leads with loses its own key.
   */
  const hydrate = (paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (paths.length === 0) return [] as ReadonlyArray<HitRow>
      const holes = paths.map(() => "?").join(", ")
      const rows = yield* db.all<HitRow>(
        `SELECT f.path AS path, f.title AS title, f.gist AS gist, f.memory_type AS memory_type,
                f.confidence AS confidence, f.updated_at AS updated_at, f.body_text AS body_text,
                f.disclosure_text AS disclosure_text,
                (SELECT group_concat(e.entity_name, char(10)) FROM file_entities e WHERE e.path = f.path) AS entity_names,
                (SELECT group_concat(e.entity_type || ':' || e.entity_name, char(10))
                   FROM file_entities e WHERE e.path = f.path) AS entity_refs,
                (SELECT g.src_path FROM edges g
                  WHERE g.dst_path = f.path AND g.edge_class = 'memory'
                    AND g.rel = 'supersedes' AND g.derived = 0
                  ORDER BY g.created_at DESC, g.src_path ASC LIMIT 1) AS superseded_by,
                (SELECT em.vec FROM chunks c JOIN embeddings em ON em.chunk_id = c.chunk_id
                  WHERE c.path = f.path ORDER BY c.ordinal LIMIT 1) AS vec
         FROM files f WHERE f.path IN (${holes})`,
        paths
      )
      const byPath = new Map(rows.map((row) => [row.path, row]))
      return paths.flatMap((path) => {
        const row = byPath.get(path)
        return row === undefined ? [] : [row]
      })
    })

  /**
   * The best-matching chunk's text per path, truncated to snippet size.
   *
   * ONE statement over the ≤limit selected paths' chunks. It brute-force re-scores a handful of
   * files, after the fused ranking has already chosen them, so the fused CTE never changes shape.
   * With a query vector the winner is the chunk nearest to it, and a NULL distance (a chunk whose
   * embedding is missing) loses to any scored chunk. Without one it is the ordinal-0 chunk, the
   * article's opening text. Ordinal breaks distance ties, so the winner is deterministic and two
   * runs over an unchanged corpus carry the same snippet.
   */
  const snippets = (paths: ReadonlyArray<string>, vector: Uint8Array | undefined) =>
    Effect.gen(function* () {
      const sql = buildSnippetSql({ hasQueryVector: vector !== undefined, pathCount: paths.length })
      if (sql === undefined) return new Map<string, string>()
      const params: ReadonlyArray<SqlValue> = vector === undefined ? paths : [vector, ...paths]
      const rows = yield* db.all<{
        path: string
        ordinal: number
        text: string
        dist: number | null
      }>(sql, params)

      const best = new Map<string, { ordinal: number; text: string; dist: number | null }>()
      for (const row of rows) {
        const incumbent = best.get(row.path)
        if (incumbent === undefined || beats(row, incumbent)) {
          best.set(row.path, { ordinal: row.ordinal, text: row.text, dist: row.dist })
        }
      }
      return new Map([...best].map(([path, row]) => [path, truncateSnippet(row.text)]))
    })

  /** Decode a stored float32 blob. Cheaper than `vector_extract` and the only reader of the layout. */
  /**
   * The archived rows a scope matches, for the `scopeEmpty` pointer.
   *
   * The same `assembleScope` the arms use, with the archived flag flipped rather than a second
   * predicate written by hand: `includeArchived: true` drops the `archived = 0` condition and the
   * `WHERE` here adds `archived = 1`, so the scope axes are byte-for-byte the ones that emptied the
   * search. `asOf` is dropped for the same reason `scopeNarrows` ignores it: the question is whether
   * the address resolves at all. The four leading slots are unbound (`?1`–`?4` belong to the fused
   * statement's query, limits, and vector) so the scope's `?5`-onward placeholders bind unchanged.
   */
  const archivedInScope = (scope: SearchScope, limit: number) =>
    Effect.gen(function* () {
      const assembled = assembleScope({ ...scope, includeArchived: true, asOf: undefined })
      const limitSlot = PARAM_QUERY_VECTOR + assembled.params.length + 1
      // At least one row, or `LIMIT 0` returns nothing and the window count is lost with it: a caller
      // asking for zero hits still gets a true `archivedMatches`.
      const bounded = Math.max(1, limit)
      const rows = yield* db.all<{ path: string; superseded_by: string | null; total: number }>(
        `SELECT f.path AS path,
                (SELECT g.src_path FROM edges g
                  WHERE g.dst_path = f.path AND g.edge_class = 'memory'
                    AND g.rel = 'supersedes' AND g.derived = 0
                  ORDER BY g.created_at DESC, g.src_path ASC LIMIT 1) AS superseded_by,
                COUNT(*) OVER () AS total
         FROM files f
         WHERE f.archived = 1${assembled.holes.fileFilter.replaceAll("{alias}", "f")}
         ORDER BY f.path ASC
         LIMIT ?${limitSlot}`,
        [null, null, null, null, ...assembled.params, bounded]
      )
      return {
        archivedMatches: rows[0]?.total ?? 0,
        archived: rows.map((row) => ({ path: row.path, supersededBy: row.superseded_by }))
      }
    })

  const decodeVector = (blob: Uint8Array | null): ReadonlyArray<number> | undefined => {
    if (blob === null || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return undefined
    const copy = Uint8Array.from(blob)
    return [...new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)]
  }

  const search = (input: SearchInput) =>
    Effect.gen(function* () {
      const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
      const vector = yield* queryVector(input.query)
      const fused = yield* fuse({
        query: input.query,
        scope: input,
        limit: limit * MMR_POOL_FACTOR,
        vector
      })
      const rows = yield* hydrate(fused.paths)

      /**
       * Fusion rank stands in for relevance in the MMR objective. RRF scores are already
       * rank-derived and incomparable across queries, so a monotone substitute is the right input.
       * MMR only needs the ORDER to be right, and reciprocal position preserves it while keeping the
       * penalty term on a comparable scale to the relevance term.
       */
      const candidates: ReadonlyArray<MmrCandidate> = rows.map((row, offset) => ({
        path: row.path,
        score: 1 / (offset + 1),
        vector: decodeVector(row.vec)
      }))
      const ordered = applyMmr(candidates, limit, MMR_LAMBDA)
      const byPath = new Map(rows.map((row) => [row.path, row]))
      /**
       * Fetched for the FINAL paths only, after MMR rather than after fusion, so the extra statement
       * re-scores at most `limit` files' chunks rather than the whole 3× pool.
       */
      const snippetByPath = yield* snippets(
        ordered.map((candidate) => candidate.path),
        vector
      )
      const scopeEmpty = ordered.length === 0 && scopeNarrows(input)
      /**
       * Under `asOf` the archived flag is not what emptied the search: the point-in-time lens already
       * admits archived rows and excludes by validity instead, so a count of archived rows would name
       * records that did not exist at the asked instant. The pointer stays at the zero shape there.
       */
      const pointer =
        scopeEmpty && (input.asOf === undefined || input.asOf === "")
          ? yield* archivedInScope(input, limit)
          : { archivedMatches: 0, archived: [] as ReadonlyArray<ArchivedMatch> }

      return {
        hits: ordered.flatMap((candidate) => {
          const row = byPath.get(candidate.path)
          return row === undefined
            ? []
            : [
                {
                  path: row.path,
                  title: row.title,
                  gist: row.gist,
                  memoryType: row.memory_type,
                  score: candidate.score,
                  confidence: row.confidence,
                  updatedAt: row.updated_at,
                  snippet: snippetByPath.get(row.path) ?? "",
                  /**
                   * Sorted so two runs over an unchanged corpus publish the same order.
                   * `group_concat` has no defined order of its own, and an agent diffing two hops
                   * would read a reshuffle as a change in the corpus.
                   */
                  entities: entityRefsOf(row),
                  supersededBy: row.superseded_by
                }
              ]
        }),
        degraded: vector === undefined,
        arms: armNamesIn(fused.sql),
        entityScope: input.entity === undefined || input.entity === "" ? null : input.entity,
        /**
         * Computed from the SAME `ordered` list the hits come from rather than from the fused paths.
         * A scope that admitted candidates which MMR then dropped is not an empty scope. No branch
         * here widens anything, and the flag is the whole response to an over-narrow scope.
         */
        scopeEmpty,
        archivedMatches: pointer.archivedMatches,
        archived: pointer.archived
      }
    }).pipe(Effect.withSpan("retrieval.search"))

  const recall = (input: RecallInput) =>
    Effect.gen(function* () {
      const budget = input.budgetChars ?? MEMORY_BODY_BUDGET
      const vector = yield* queryVector(input.query)
      const fused = yield* fuse({
        query: input.query,
        scope: input,
        limit: DEFAULT_SEARCH_LIMIT * MMR_POOL_FACTOR,
        vector
      })
      const rows = yield* hydrate(fused.paths)

      const candidates = rows.map(
        (row): DisclosureCandidate => ({
          path: row.path,
          title: row.title,
          gist: row.gist,
          memoryType: row.memory_type,
          disclosureText: row.disclosure_text,
          entityNames: row.entity_names === null ? [] : row.entity_names.split("\n")
        })
      )

      /**
       * Arcs are folded under their OWN envelope, not carved out of the memories' budget. An arc is a
       * synthesis of many memories, so letting the two compete would make a single arc crowd out
       * every concrete memory behind it. The pack would then explain the pattern and cite none of the
       * evidence.
       */
      const arcs = foldDisclosure(
        candidates.filter((candidate) => candidate.memoryType === "arc"),
        budgetFor("arc")
      )
      const memories = foldDisclosure(
        candidates.filter((candidate) => candidate.memoryType !== "arc"),
        budget
      )

      return {
        arcs,
        memories,
        spentChars: arcs.spentChars + memories.spentChars,
        truncated: arcs.truncated || memories.truncated,
        degraded: vector === undefined
      }
    }).pipe(Effect.withSpan("retrieval.recall"))

  return { search, recall }
}

/**
 * A hit's entity references, deduplicated and sorted.
 *
 * `group_concat` defines no order, so sorting HERE is what makes two searches over an unchanged
 * corpus publish the same array. An agent diffing two hops would otherwise read a reshuffle as a
 * change in the corpus. Deduplicated because the value's only job is to be a scope for the next call
 * and a repeated reference offers the caller nothing.
 */
const entityRefsOf = (row: HitRow): ReadonlyArray<string> =>
  row.entity_refs === null
    ? []
    : [...new Set(row.entity_refs.split("\n").filter((ref) => ref !== ""))].sort()

/** The arm CTEs an assembled statement declares, for the operator envelope. */
const armNamesIn = (sql: string): ReadonlyArray<string> =>
  ["fts", "vector", "recency", "salience"].filter((name) => sql.includes(`${name} AS (`))

/**
 * Does `challenger` beat `incumbent` as a file's snippet chunk? Lower distance wins. A NULL
 * distance, meaning no embedding for that chunk, loses to any scored one. Ties (including NULL vs
 * NULL, the whole degraded path) fall to the lower ordinal, so the choice is total and deterministic.
 */
const beats = (
  challenger: { readonly ordinal: number; readonly dist: number | null },
  incumbent: { readonly ordinal: number; readonly dist: number | null }
): boolean => {
  if (challenger.dist !== null && incumbent.dist === null) return true
  if (challenger.dist === null && incumbent.dist !== null) return false
  if (challenger.dist !== null && incumbent.dist !== null && challenger.dist !== incumbent.dist) {
    return challenger.dist < incumbent.dist
  }
  return challenger.ordinal < incumbent.ordinal
}

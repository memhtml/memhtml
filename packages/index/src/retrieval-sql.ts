import { RRF_K } from "@memhtml/domain"

import { FTS_COLUMN, SNIPPET_MAX_CHARS, STATE_SCHEMA } from "./schema-const.js"

/**
 * The four-arm RRF assembler. Arms are data — a registry folded over by {@link buildRrfSql} — so
 * adding a fifth arm is a table entry rather than a new query, and dropping one is a filter.
 *
 * The parameter tuple is fixed at four positions and the SQL uses NUMBERED placeholders, which is
 * what makes degradation to the lexical floor free: an arm needing the query vector is dropped
 * before assembly, `?4` then appears nowhere in the statement, and `?1`-`?3` keep their meaning so
 * the caller binds the same prefix either way. With positional `?` the numbering would shift and
 * every remaining arm would silently read the wrong parameter.
 *
 * ```
 * ?1 query text   ?2 per-arm candidate limit   ?3 final limit   ?4 query vector (float32 blob)
 * ```
 *
 * Weights are inlined as numeric literals rather than bound. They come from trusted configuration,
 * not from a caller, and inlining keeps the tuple stable at four regardless of how many arms fire.
 */

/** The bound-parameter positions, named so a reader never counts question marks. */
export const PARAM_QUERY = 1
export const PARAM_ARM_LIMIT = 2
export const PARAM_FINAL_LIMIT = 3
export const PARAM_QUERY_VECTOR = 4

/** The filter hole an arm's SQL template carries. Assembled, never bound. */
export interface ArmHoles {
  /**
   * Additional `AND` conditions on the `files` row: the archived flag, the memory-type IN-list, the
   * workspace equality, the tag overlap, and the entity reference. Column references are written against the literal
   * token `{alias}`, which each arm replaces with the alias its own `files` row goes by — one
   * filter string reaching every arm is what stops a scope from applying to three arms and not the
   * fourth. Empty string when the search is unscoped, making the assembled SQL byte-identical to
   * the unfiltered form.
   */
  readonly fileFilter: string
}

/** One ranking arm: a weight, a SQL template, and whether it needs the query vector. */
export interface RankArm {
  readonly name: string
  /** Unitless multiplier on this arm's `1/(rank + k)` contributions. */
  readonly weight: number
  /** True when the arm references `?4`; dropped from the fold when no query vector is available. */
  readonly needsEmbedding: boolean
  /** True when the arm reads the ATTACHed state plane; dropped when no state database is attached. */
  readonly needsState: boolean
  /**
   * True when the arm MATCHes `?1`; dropped when the query holds no indexable term. A query of only
   * punctuation is a HARD driver error rather than an empty result (probed 2026-08-02: `-x` and
   * `!!! ???` both fail the statement), so the arm has to leave the fold rather than run and return
   * nothing.
   */
  readonly needsQueryTerms: boolean
  /** The arm's ranked-list SQL, returning exactly `(path, rank)` with `rank` 1-based. */
  readonly sql: (holes: ArmHoles) => string
}

/**
 * Lexical. `ROW_NUMBER() OVER ()` with no `ORDER BY` is deliberate and probed: it captures MATCH's
 * own row order, which is the only relevance signal this driver exposes — there is no `rank` column
 * and no `bm25()`. The window must sit OUTSIDE a `LIMIT`ed subquery, because a window function
 * evaluated alongside the MATCH would number the pre-limit scan.
 *
 * MATCHes the single denormalized `fts_text` column: a multi-column FTS index returns rowid order
 * instead of relevance order and scopes MATCH to the named column alone.
 */
const ftsArm: RankArm = {
  name: "fts",
  weight: 1.0,
  needsEmbedding: false,
  needsState: false,
  needsQueryTerms: true,
  sql: ({ fileFilter }) =>
    `SELECT path, ROW_NUMBER() OVER () AS rank FROM (
       SELECT path FROM files
       WHERE ${FTS_COLUMN} MATCH ?${PARAM_QUERY}${fileFilter.replaceAll("{alias}", "files")}
       LIMIT ?${PARAM_ARM_LIMIT}
     )`
}

/**
 * Semantic. Exact brute force over the whole `embeddings` table: 2000 files × 1024 dims, top 40,
 * measured 27 ms (probed 2026-08-02), so an approximate index buys nothing at this scale.
 *
 * `GROUP BY c.path` with `min(distance)` collapses a file to its single best chunk. Without it a
 * three-chunk file contributes three ranks, consumes three slots of the arm's candidate budget, and
 * has three reciprocal-rank contributions summed into its fused score — so being long would
 * outrank being relevant.
 */
const vectorArm: RankArm = {
  name: "vector",
  weight: 1.0,
  needsEmbedding: true,
  needsState: false,
  needsQueryTerms: false,
  sql: ({ fileFilter }) =>
    `SELECT path, ROW_NUMBER() OVER (ORDER BY dist) AS rank FROM (
       SELECT c.path AS path, min(vector_distance_cos(e.vec, ?${PARAM_QUERY_VECTOR})) AS dist
       FROM chunks c
       JOIN embeddings e ON e.chunk_id = c.chunk_id
       JOIN files f ON f.path = c.path
       WHERE 1 = 1${fileFilter.replaceAll("{alias}", "f")}
       GROUP BY c.path
       ORDER BY dist
       LIMIT ?${PARAM_ARM_LIMIT}
     )`
}

/**
 * Recency by EVENT time, falling back to write time. `coalesce(event_at, updated_at)` is what makes
 * an episodic memory about last month's incident sort by when the incident happened rather than by
 * when someone got around to writing it down.
 */
const recencyArm: RankArm = {
  name: "recency",
  weight: 0.5,
  needsEmbedding: false,
  needsState: false,
  needsQueryTerms: false,
  sql: ({ fileFilter }) =>
    `SELECT path, ROW_NUMBER() OVER (ORDER BY coalesce(event_at, updated_at) DESC, path ASC) AS rank
     FROM (
       SELECT path, event_at, updated_at FROM files
       WHERE 1 = 1${fileFilter.replaceAll("{alias}", "files")}
       ORDER BY coalesce(event_at, updated_at) DESC, path ASC
       LIMIT ?${PARAM_ARM_LIMIT}
     )`
}

/**
 * The one memory type salience does not rank.
 *
 * A task is reached by `task_status` and `due_at` — nominal predicates, not a relevance contest — and
 * salience over working state would reward STALENESS: the stuck task re-read during every triage would
 * outrank the fresh urgent one. Named as a constant so this predicate and the tests read one value.
 */
export const SALIENCE_EXCLUDED_TYPE = "task"

/**
 * The one path prefix salience does not rank.
 *
 * There is no `person` memory type — a person file is a `semantic` record that `placementFor` routes to
 * `resources/people/` (`packages/contracts/src/paths.ts:122`), so the prefix IS the discriminator. A
 * reference record is reached by entity key, and decay is wrong for identity: a colleague unmentioned
 * for six months is not less themselves. Memories ABOUT a person live elsewhere and keep their
 * salience, which is the signal that answers "which five of fifty sanju-memories do we consult".
 */
export const SALIENCE_EXCLUDED_PREFIX = "resources/people/"

/**
 * Salience over the durable state plane, read in the same statement as `main.files` through the
 * ATTACH. Three terms, each unitless and each verified present on this driver:
 *
 * - `exp(-0.01 * hours_since_access)` — a decaying recency-of-use signal.
 * - `ln(1 + access_count)` — diminishing returns on raw popularity.
 * - `max(outcome_score, 0.0)` — the negative-outcome clamp. A memory whose reinforcements were
 *   negative gets no boost, and takes no penalty either: the retention scorer owns punishment, and
 *   double-counting it here would let one bad outcome bury a memory that is still the best answer.
 *
 * **Two exclusions LOCAL to this arm, and the locality is the point.** Salience belongs to ranked
 * fusion over interchangeable candidates; a task and a person-reference record are reached by
 * predicate and by key. The shared `fileFilter` reaches every arm and must NOT carry these — an
 * excluded row still earns its FTS, vector, and recency ranks, and only its salience contribution
 * disappears. Written as inline literals rather than bound values, following the
 * `EXCLUDED_BY_DEFAULT` precedent (`scope.ts:121`): they are this arm's own rule, not caller input,
 * and binding them would consume placeholder numbers the `?5`-upward scope contract owns.
 *
 * The mechanism is that the CTE emits no row for an excluded path at all. The decay term reads
 * `coalesce(a.last_accessed_at, f.updated_at)`, so leaving the row in with a zeroed access count would
 * still rank it by write time — which is the recency arm's job, counted twice.
 */
const salienceArm: RankArm = {
  name: "salience",
  weight: 0.4,
  needsEmbedding: false,
  needsState: true,
  needsQueryTerms: false,
  sql: ({ fileFilter }) =>
    `SELECT path, ROW_NUMBER() OVER (ORDER BY score DESC, path ASC) AS rank FROM (
       SELECT f.path AS path,
              exp(-0.01 * (unixepoch('now') - unixepoch(coalesce(a.last_accessed_at, f.updated_at))) / 3600.0)
              + ln(1 + coalesce(a.access_count, 0))
              + max(coalesce(a.outcome_score, 0.0), 0.0) AS score
       FROM files f
       LEFT JOIN ${STATE_SCHEMA}.access a ON a.path = f.path
       WHERE f.memory_type <> '${SALIENCE_EXCLUDED_TYPE}'
         AND f.path NOT LIKE '${SALIENCE_EXCLUDED_PREFIX}%'${fileFilter.replaceAll("{alias}", "f")}
       ORDER BY score DESC, path ASC
       LIMIT ?${PARAM_ARM_LIMIT}
     )`
}

/** The registry, in fold order. Order is presentation only — RRF's sum commutes. */
export const RANK_ARMS: ReadonlyArray<RankArm> = [ftsArm, vectorArm, recencyArm, salienceArm]

/** What {@link buildRrfSql} folds over. */
export interface RrfOptions {
  /** False when the embedder failed or the query has no vector: `needsEmbedding` arms are dropped. */
  readonly hasQueryVector: boolean
  /** False when no state database is attached: `needsState` arms are dropped. */
  readonly hasState: boolean
  /**
   * False when the sanitized query holds no indexable term: `needsQueryTerms` arms are dropped.
   * Defaults to true, so a caller that forgets it gets the full fold rather than a silently narrowed
   * one — the failure then surfaces as a driver error in a test rather than as a missing arm in
   * production.
   */
  readonly hasQueryTerms?: boolean | undefined
  readonly holes: ArmHoles
  readonly arms?: ReadonlyArray<RankArm> | undefined
}

/** The arms that will actually fire, in registry order. */
export const activeArms = (options: RrfOptions): ReadonlyArray<RankArm> =>
  (options.arms ?? RANK_ARMS).filter(
    (arm) =>
      arm.weight > 0 &&
      (!arm.needsEmbedding || options.hasQueryVector) &&
      (!arm.needsState || options.hasState) &&
      (!arm.needsQueryTerms || options.hasQueryTerms !== false)
  )

/**
 * The one fused statement: each active arm as a CTE, their weighted reciprocal ranks `UNION ALL`ed,
 * then summed per path.
 *
 * Ties break on `path ASC` so the ordering is total and two runs over an unchanged corpus produce
 * the same list — which is what the discrimination gate compares against.
 *
 * Returns `undefined` when no arm is active. A caller must treat that as an empty result rather
 * than assemble `SELECT ... FROM ()`, which is why this is not a string.
 */
export const buildRrfSql = (options: RrfOptions): string | undefined => {
  const arms = activeArms(options)
  if (arms.length === 0) return undefined

  const ctes = arms.map((arm) => `${arm.name} AS (\n${arm.sql(options.holes)}\n)`).join(",\n")
  const union = arms
    .map((arm) => `SELECT path, ${arm.weight.toFixed(4)} / (rank + ${RRF_K}) AS s FROM ${arm.name}`)
    .join("\n     UNION ALL ")

  return `WITH ${ctes},
     rrf AS (${union})
     SELECT path, SUM(s) AS score FROM rrf GROUP BY path ORDER BY score DESC, path ASC LIMIT ?${PARAM_FINAL_LIMIT}`
}

/**
 * The snippet fetch: every chunk of the SELECTED paths, with its distance to the query vector when
 * one exists. ONE statement after the fused ranking, never a change to the fused CTE — the ranking
 * already chose the paths, and re-scoring the ≤limit winners' chunks is brute force over a handful
 * of rows.
 *
 * Two forms, mirroring {@link buildRrfSql}'s degradation:
 *
 * - With a query vector, `?1` is the vector and paths bind from `?2`. The `LEFT JOIN` keeps a chunk
 *   whose embedding is missing (a sparse vector plane is a legal state — `--no-embed`, a Bedrock
 *   outage mid-index), with `dist` NULL; the caller treats NULL as "worst", so such a file still
 *   gets its ordinal-0 text rather than vanishing from the snippet map. The `CASE` guard is what
 *   keeps `vector_distance_cos` from ever seeing a NULL blob.
 * - Without one, paths bind from `?1` and only the ordinal-0 chunk comes back — the file's opening
 *   text, which on this corpus is almost always the whole article ({@link CHUNK_MAX_CHARS}).
 *
 * The winner-per-path fold happens in the caller, not in SQL: `PARTITION BY` windows are unprobed on
 * this driver, and a JS `Map` over ≤limit×chunks rows is the cheaper thing to be sure of.
 *
 * Returns `undefined` for zero paths, same contract as {@link buildRrfSql}: the caller must treat
 * that as an empty result rather than assemble `IN ()`.
 */
export const buildSnippetSql = (options: {
  readonly hasQueryVector: boolean
  readonly pathCount: number
}): string | undefined => {
  if (options.pathCount <= 0) return undefined
  const first = options.hasQueryVector ? 2 : 1
  const holes = Array.from({ length: options.pathCount }, (_, at) => `?${first + at}`).join(", ")
  return options.hasQueryVector
    ? `SELECT c.path AS path, c.ordinal AS ordinal, c.text AS text,
              CASE WHEN e.chunk_id IS NULL THEN NULL ELSE vector_distance_cos(e.vec, ?1) END AS dist
       FROM chunks c
       LEFT JOIN embeddings e ON e.chunk_id = c.chunk_id
       WHERE c.path IN (${holes})`
    : `SELECT path, ordinal, text, NULL AS dist FROM chunks WHERE ordinal = 0 AND path IN (${holes})`
}

/**
 * Truncate chunk text to a hit-sized snippet: at most {@link SNIPPET_MAX_CHARS} characters, with a
 * `…` marker when cut so a reader can tell a short chunk from a shortened one. The marker fits
 * INSIDE the ceiling — a consumer budgeting `SNIPPET_MAX_CHARS` per hit is never off by one.
 */
export const truncateSnippet = (text: string): string =>
  text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd()}…`

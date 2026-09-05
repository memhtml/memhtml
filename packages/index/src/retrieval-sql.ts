import { RRF_K } from "@memhtml/domain"

import { FTS_INDEX_NAME, SNIPPET_MAX_CHARS, STATE_SCHEMA } from "./schema-const.js"

/**
 * The four-arm RRF assembler. Arms are data, a registry folded over by {@link buildRrfSql}, so
 * adding a fifth arm is a table entry rather than a new query, and dropping one is a filter.
 *
 * The parameter tuple is fixed at four positions and the SQL uses NUMBERED placeholders, which is
 * what makes degradation to the lexical floor free. An arm needing the query vector is dropped
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

/** The highest `?N` a statement names, or 0 when it binds nothing. */
const highestSlot = (sql: string): number =>
  [...sql.matchAll(/\?(\d+)/g)].reduce((top, match) => Math.max(top, Number(match[1])), 0)

/**
 * The bound tuple for an assembled statement, trimmed to the slots that statement actually names.
 *
 * SQLite binds by INDEX and rejects a value at a position no `?N` mentions. Binding four against a
 * statement that stops at `?3` is `column index out of range`, not a harmlessly ignored extra. Which
 * slots survive assembly varies. Dropping the vector arm removes `?4`, an empty scope removes
 * `?5` and up, and one arm run in isolation may reach no further than `?2`.
 *
 * So the ceiling is READ OFF THE SQL rather than restated as a rule about which arms are in the fold.
 * A rule would have to be re-derived every time an arm changes which placeholders it uses, and would
 * be wrong silently. The statement is the authority on what it references. The full tuple is still
 * built in slot order first, because the numbered placeholders are what let `?1`-`?3` keep their
 * meaning whichever arms fire.
 */
export const rrfParams = (
  sql: string,
  input: {
    readonly matchQuery: string
    readonly armLimit: number
    readonly finalLimit: number
    readonly vector?: Uint8Array | undefined
    readonly scopeParams: ReadonlyArray<string | number>
  }
): ReadonlyArray<string | number | Uint8Array | null> =>
  [
    input.matchQuery,
    input.armLimit,
    input.finalLimit,
    input.vector ?? null,
    ...input.scopeParams
  ].slice(0, highestSlot(sql))

/** The filter hole an arm's SQL template carries. Assembled, never bound. */
export interface ArmHoles {
  /**
   * Additional `AND` conditions on the `files` row, covering the archived flag, the memory-type
   * IN-list, the workspace equality, the tag overlap, and the entity reference. Columns are written
   * against the literal token `{alias}`, which each arm replaces with the alias its own `files` row
   * goes by. One filter string reaching every arm is what stops a scope from applying to three arms
   * and not the fourth. Empty string when the search is unscoped, making the assembled SQL
   * byte-identical to the unfiltered form.
   */
  readonly fileFilter: string
}

/** One ranking arm, holding a weight, a SQL template, and whether it needs the query vector. */
export interface RankArm {
  readonly name: string
  /** Unitless multiplier on this arm's `1/(rank + k)` contributions. */
  readonly weight: number
  /** True when the arm references `?4`; dropped from the fold when no query vector is available. */
  readonly needsEmbedding: boolean
  /** True when the arm reads the ATTACHed state plane; dropped when no state database is attached. */
  readonly needsState: boolean
  /**
   * True when the arm MATCHes `?1`, and dropped when the query holds no indexable term. A query of
   * only punctuation is a HARD driver error rather than an empty result (probed 2026-08-02, `-x` and
   * `!!! ???` both fail the statement), so the arm has to leave the fold rather than run and return
   * nothing.
   */
  readonly needsQueryTerms: boolean
  /** The arm's ranked-list SQL, returning exactly `(path, rank)` with `rank` 1-based. */
  readonly sql: (holes: ArmHoles) => string
}

/**
 * Lexical, ranked by `bm25()`, a real term-frequency/inverse-document-frequency score rather than
 * whatever order the index happens to return rows in.
 *
 * FTS5 reports bm25 as a NEGATIVE number where more negative is more relevant, so `ORDER BY bm25`
 * ascending puts the best match first. Getting that sign backwards would invert the whole arm while
 * still producing a plausible ranked list, which is why the discrimination gate (every probe must
 * outrank its own wrong-fact twins) is the test that matters here.
 *
 * The `ORDER BY` sits INSIDE the limited subquery so the LIMIT keeps the most relevant candidates,
 * and `ROW_NUMBER()` sits outside it so the fused rank numbers the survivors rather than the
 * pre-limit scan.
 *
 * `?1` is one of the two MATCH forms `ftsQueryForms` builds (`fts-query.ts`): the query's sanitized
 * terms joined with `AND`, or joined with `OR`, with a double-quoted span kept as one phrase in
 * either. The caller binds the all-terms form when {@link buildFtsProbeSql} finds a file in scope
 * holding every term, and the any-of form otherwise. A sentence that is not a verbatim quote of stored
 * text satisfies no all-terms MATCH, so the any-of form is what lets one proper noun in it find its
 * file (issue #143); the all-terms form is kept where it can answer because RRF's `1/(rank + 60)` is
 * nearly flat across this arm's 40 candidates, and 40 any-of candidates let recency and salience
 * outvote a lexical lead that 3 all-terms candidates would have kept (corpus MRR 1.0 against 0.28 on
 * the gate's fixture). Whichever form is bound, the bm25 order the fold sees is that form's own.
 *
 * The join is on `rowid`. `files_fts` is external-content over `files`, so it stores no copy of the
 * row and the rowid is the only handle back to the path.
 */
const ftsArm: RankArm = {
  name: "fts",
  weight: 1.0,
  needsEmbedding: false,
  needsState: false,
  needsQueryTerms: true,
  sql: ({ fileFilter }) =>
    `SELECT path, ROW_NUMBER() OVER () AS rank FROM (
       SELECT files.path AS path FROM ${FTS_INDEX_NAME}
       JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
       WHERE ${FTS_INDEX_NAME} MATCH ?${PARAM_QUERY}${fileFilter.replaceAll("{alias}", "files")}
       ORDER BY bm25(${FTS_INDEX_NAME})
       LIMIT ?${PARAM_ARM_LIMIT}
     )`
}

/**
 * Does any file IN SCOPE hold every term of the all-terms MATCH form? One row or none.
 *
 * The lexical arm's own join and the same `fileFilter` the arm carries, so the answer is about the
 * candidates the arm would actually see: an all-terms match on an archived row, or on a row outside
 * the caller's workspace, is not a reason to bind the all-terms form and have the arm return nothing.
 * Binds `?1` as the all-terms text and the scope's `?5`-onward slots unchanged, so `rrfParams` builds
 * its tuple for this statement the way it does for the fused one.
 */
export const buildFtsProbeSql = ({ fileFilter }: ArmHoles): string =>
  `SELECT 1 AS hit FROM ${FTS_INDEX_NAME}
   JOIN files ON files.rowid = ${FTS_INDEX_NAME}.rowid
   WHERE ${FTS_INDEX_NAME} MATCH ?${PARAM_QUERY}${fileFilter.replaceAll("{alias}", "files")}
   LIMIT 1`

/**
 * Semantic. Exact brute force over the whole `embeddings` table, so 2000 files × 1024 dims, top 40,
 * measured 27 ms (probed 2026-08-02). An approximate index buys nothing at this scale.
 *
 * `GROUP BY c.path` with `min(distance)` collapses a file to its single best chunk. Without it a
 * three-chunk file contributes three ranks, consumes three slots of the arm's candidate budget, and
 * has three reciprocal-rank contributions summed into its fused score, so being long would
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
 * A task is reached by `task_status` and `due_at`, nominal predicates and not a relevance contest.
 * Salience over working state would reward STALENESS, so the stuck task re-read during every triage
 * would outrank the fresh urgent one. Named as a constant so the predicate and the tests read one.
 */
export const SALIENCE_EXCLUDED_TYPE = "task"

/**
 * The one path prefix salience does not rank.
 *
 * There is no `person` memory type. A person file is a `semantic` record that `placementFor` routes to
 * `resources/people/` (`packages/contracts/src/paths.ts:122`), so the prefix IS the discriminator. A
 * reference record is reached by entity key, and decay is wrong for identity. A colleague unmentioned
 * for six months is not less themselves. Memories ABOUT a person live elsewhere and keep their
 * salience, which is the signal that answers "which five of fifty sanju-memories do we consult".
 */
export const SALIENCE_EXCLUDED_PREFIX = "resources/people/"

/**
 * Salience over the durable state plane, read in the same statement as `main.files` through the
 * ATTACH. Three terms, each unitless and each verified present on this driver:
 *
 * - `exp(-0.01 * hours_since_access)`: a decaying recency-of-use signal.
 * - `ln(1 + access_count)`: diminishing returns on raw popularity.
 * - `max(outcome_score, 0.0)`: the negative-outcome clamp. A memory whose reinforcements were
 *   negative gets no boost, and takes no penalty either. The retention scorer owns punishment, and
 *   double-counting it here would let one bad outcome bury a memory that is still the best answer.
 *
 * **Two exclusions LOCAL to this arm, and the locality is the point.** Salience belongs to ranked
 * fusion over interchangeable candidates, while a task and a person-reference record are reached by
 * predicate and by key. The shared `fileFilter` reaches every arm and must NOT carry these. An
 * excluded row still earns its FTS, vector, and recency ranks, and only its salience contribution
 * disappears. Written as inline literals rather than bound values, following the
 * `EXCLUDED_BY_DEFAULT` precedent (`scope.ts:121`). They are this arm's own rule and not caller
 * input, and binding them would consume placeholder numbers the `?5`-upward scope contract owns.
 *
 * The mechanism is that the CTE emits no row for an excluded path at all. The decay term reads
 * `coalesce(a.last_accessed_at, f.updated_at)`, so leaving the row in with a zeroed access count would
 * still rank it by write time, which is the recency arm's job, counted twice.
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

/** The registry, in fold order. Order is presentation only. RRF's sum commutes. */
export const RANK_ARMS: ReadonlyArray<RankArm> = [ftsArm, vectorArm, recencyArm, salienceArm]

/** What {@link buildRrfSql} folds over. */
export interface RrfOptions {
  /** False when the embedder failed or the query has no vector, dropping `needsEmbedding` arms. */
  readonly hasQueryVector: boolean
  /** False when no state database is attached, dropping `needsState` arms. */
  readonly hasState: boolean
  /**
   * False when the sanitized query holds no indexable term, dropping `needsQueryTerms` arms.
   * Defaults to true, so a caller that forgets it gets the full fold rather than a silently narrowed
   * one. The failure then surfaces as a driver error in a test rather than as a missing arm in
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
 * The one fused statement. Each active arm becomes a CTE, their weighted reciprocal ranks are
 * `UNION ALL`ed, then summed per path.
 *
 * Ties break on `path ASC` so the ordering is total and two runs over an unchanged corpus produce
 * the same list, which is what the discrimination gate compares against.
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
 * The snippet fetch, covering every chunk of the SELECTED paths, with its distance to the query
 * vector when one exists. ONE statement after the fused ranking, never a change to the fused CTE.
 * The ranking already chose the paths, and re-scoring the ≤limit winners' chunks is brute force over
 * a handful of rows.
 *
 * Two forms, mirroring {@link buildRrfSql}'s degradation:
 *
 * - With a query vector, `?1` is the vector and paths bind from `?2`. The `LEFT JOIN` keeps a chunk
 *   whose embedding is missing, with `dist` NULL. A sparse vector plane is a legal state, produced
 *   by `--no-embed` or a Bedrock outage mid-index. The caller treats NULL as "worst", so such a file
 *   still gets its ordinal-0 text rather than vanishing from the snippet map. The `CASE` guard is
 *   what keeps `vector_distance_cos` from ever seeing a NULL blob.
 * - Without one, paths bind from `?1` and only the ordinal-0 chunk comes back, the file's opening
 *   text, which on this corpus is almost always the whole article ({@link CHUNK_MAX_CHARS}).
 *
 * The winner-per-path fold happens in the caller rather than in SQL. `PARTITION BY` windows are
 * unprobed on this driver, and a JS `Map` over ≤limit×chunks rows is the cheaper thing to be sure of.
 *
 * Returns `undefined` for zero paths, the same contract as {@link buildRrfSql}. The caller must treat
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
 * Truncate chunk text to a hit-sized snippet of at most {@link SNIPPET_MAX_CHARS} characters, with a
 * `…` marker when cut so a reader can tell a short chunk from a shortened one. The marker fits
 * INSIDE the ceiling. A consumer budgeting `SNIPPET_MAX_CHARS` per hit is never off by one.
 */
export const truncateSnippet = (text: string): string =>
  text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd()}…`

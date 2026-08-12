/**
 * The identifiers the SQL and the TypeScript both name. Stated here once so a table rename is a
 * compile error at every reader rather than a query that silently matches nothing — a truncate
 * list that has drifted from the schema leaves rows behind and a rebuild is no longer a rebuild.
 */

/** Where the rebuildable index's migrations live, applied in filename order. */
export const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname

/**
 * The state plane's own migration ledger. A separate directory because these statements are applied
 * to the ATTACHed `state` database, which has its own `schema_migrations` table: the two planes have
 * independent lifetimes, and `index.db` is deleted and rebuilt without touching `state.db`.
 */
export const STATE_MIGRATIONS_DIR = new URL("../state-migrations", import.meta.url).pathname

/** The schema name `state.db` is ATTACHed under. Every cross-plane query qualifies with it. */
export const STATE_SCHEMA = "state"

/**
 * The lexical index: an external-content FTS5 table over `files`, maintained by triggers.
 *
 * It is a TABLE, not an index, which is what makes it MATCHable and `bm25()`-rankable. Nothing
 * drops or recreates it around a bulk load — see `indexer.ts`'s `applyProjectionWrites` for the
 * measurements that retired that bracket.
 */
export const FTS_INDEX_NAME = "files_fts"

/**
 * The one column `files_fts` covers.
 *
 * ONE column so that a single MATCH finds a term wherever it lives: the indexer denormalizes title,
 * gist, and body into `fts_text`, and the arm MATCHes that. A multi-column FTS5 table would make
 * `bm25()` weight the columns against each other, which is a ranking decision the RRF fusion
 * already owns — the lexical arm's job is to contribute one honest relevance order, not to
 * pre-blend fields.
 */
export const FTS_COLUMN = "fts_text"

/** The `index_state` singleton's primary key. The table holds exactly one row by CHECK. */
export const INDEX_STATE_ID = 1

/**
 * Tables a rebuild empties, in delete order: children before parents, so the statements are correct
 * even with foreign keys enforced rather than relying on cascade.
 */
export const MEMORY_TABLES = [
  "file_citations",
  "file_facets",
  "file_entities",
  "file_tags",
  "embeddings",
  "chunks",
  "edges",
  "files"
] as const

/** The trace plane's tables. Never touched by a memory rebuild, and never named in retrieval SQL. */
export const TRACE_TABLES = ["trace_prompts", "traces", "trace_watermarks"] as const

/** The state plane's tables, qualified at the call site with {@link STATE_SCHEMA}. */
export const STATE_TABLES = ["access", "edge_corroboration"] as const

/**
 * Character ceiling for one chunk. Below it an entry's whole article is chunk 0 — the overwhelmingly
 * common case, since the format is one fact per file.
 */
export const CHUNK_MAX_CHARS = 1_800

/**
 * Character ceiling for a search hit's `snippet` — the text of the file's best-matching chunk.
 * Roughly three gists wide: enough to show WHY the chunk matched without turning a ten-hit result
 * into a recall pack, which has its own budgeted door. A snippet cut at this ceiling ends in `…`.
 */
export const SNIPPET_MAX_CHARS = 700

/**
 * Rows per `writeAll` batch.
 *
 * A bound rather than a tuning knob: one batch is one transaction, so this caps how much work a
 * single failure discards and how long one write holds the WAL write lock against a concurrent
 * reader. Whole-store passes are batched rather than sent as one transaction for that reason, not
 * for a per-row cost that FTS5 does not have.
 */
export const WRITE_BATCH_SIZE = 500

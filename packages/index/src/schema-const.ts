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
 * The lexical index. Named because a full rebuild drops it, bulk-loads, and recreates it: writing
 * through a live FTS index measured 10-25 ms per row and superlinear in table size (probed
 * 2026-08-02 on @tursodatabase/database 0.7.2 — 800 rows took 19.9 s indexed, 18 ms unindexed,
 * plus 13 ms to build the index afterwards).
 */
export const FTS_INDEX_NAME = "files_fts"

/**
 * The one column `files_fts` covers.
 *
 * A multi-column FTS index is not usable for ranked retrieval on this driver (probed 2026-08-02):
 * `WHERE body_text MATCH ?` under `USING fts(title, gist, body_text)` returns matching rows in
 * **rowid order**, and MATCH is scoped to the named column alone — a term living in `title` is not
 * found. A single-column index returns true relevance order, which is the only relevance signal
 * this driver exposes (there is no `rank`, no `bm25()`). So the indexer denormalizes title, gist,
 * and body into one column and the arm MATCHes that.
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

/** Rows per `writeAll` batch. Larger batches on an FTS-indexed table degrade superlinearly. */
export const WRITE_BATCH_SIZE = 500

/**
 * When an incremental pass rebuilds the FTS index instead of inserting through it.
 *
 * Inserting through the live index costs ~8 ms/row freshly built and degrades with every row
 * inserted since the last CREATE INDEX (probed 2026-08-06: four 256-op batches cost 2.4 s → 10.7 s
 * in writeAll; bracketed, flat at ~0.6 s). Rebuilding costs ~6.6 µs per TABLE row (13 ms at 1k
 * files, 133 ms at 20k). Break-even is therefore near one written file per ~1000 table rows;
 * {@link FTS_REBUILD_ROWS_PER_WRITE} states it, and a pass touching at least
 * `files / FTS_REBUILD_ROWS_PER_WRITE` files takes the rebuild. The floor keeps the interactive
 * path — one file, ~8 ms — from ever paying a table-sized rebuild.
 */
export const FTS_REBUILD_ROWS_PER_WRITE = 1_000
export const FTS_REBUILD_MIN_FILES = 16

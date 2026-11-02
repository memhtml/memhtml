---
title: The index
description: Two databases on one connection, a schema whose keys expect the primary key to move, and one projection function that rebuild and incremental update share.
---

## 1. Two databases on one connection

The index plane, `.memhtml/index.db`, is a projection of the git tree: its memory rows are computed from files in the tree, and nothing is recorded there first. The state plane, `.memhtml/state.db`, holds the usage statistics no file records. Both are SQLite files.

`state.db` is attached to the same connection under the schema name `state` (`packages/index/src/database.ts::attachState`), which lets the salience ranker `LEFT JOIN state.access` in the same statement that reads `main.files`, with no join performed in application code. Attaching twice is an error, so it happens once per connection in `makeDatabase` (`packages/index/src/database.ts::makeDatabase`).

Each plane keeps its own migration ledger (`packages/index/src/database.ts::runMigrations`, `packages/index/src/schema-const.ts::STATE_MIGRATIONS_DIR`). Rebuilding `index.db` must not mark the state plane's migrations unapplied.

Both planes are plain SQLite reached through node's built-in `node:sqlite`, so the only database dependency is node itself, with no driver feature flags to keep in step. `sqlite3` or a GUI browser opens either file directly.

Every connection sets `busy_timeout = 5000` and `foreign_keys = ON`, and sets `journal_mode = WAL` and `synchronous = NORMAL` for `index.db` (`packages/index/src/database.ts::makeDatabase`). Those two apply per database and run before `state.db` is attached, so the state plane keeps SQLite's rollback journal. Each connection also registers one SQL function, `vector_distance_cos`. It calls `@memhtml/domain`'s `cosineDistance`, so one implementation serves both the vector ranker's SQL and the diversification pass, and the two cannot disagree about a clamp or about a zero-magnitude vector.

Migrations apply in filename order, and each file's statements commit together with its ledger row in one transaction (`packages/index/src/database.ts::runMigrations`), so a crash never leaves one half-applied. Migrations are read from disk relative to the built output, so adding one means adding a `.sql` file and changing no code.

## 2. Schema

`files` (`packages/index/migrations/0008_tasks.sql`) projects one memory file: identity, classification under a ten-value `memory_type` CHECK, three text surfaces, the scoring inputs, the bitemporal fields, provenance, and two task columns.

Each child table (`packages/index/migrations/0001_files.sql`) declares `ON UPDATE CASCADE` alongside `ON DELETE CASCADE`. `files.path` is the primary key, and it moves, because eviction is a `git mv`. Foreign keys are checked immediately, so without the update cascade the rename's `UPDATE` fails outright.

### 2.1. Three text columns, three jobs

- `body_text` is the full search surface.
- `fts_text` is the title, gist, and body joined by newlines (`packages/index/src/project.ts::ftsTextFor`). It is one denormalized column because a multi-column FTS5 table would make `bm25()` weight the columns against each other, a ranking decision that rank fusion already owns (`packages/index/src/schema-const.ts::FTS_COLUMN`). FTS5's tokenizer treats a newline as a separator, like a space, so a quoted phrase can match across the end of the title and the start of the gist.
- `disclosure_text` is what recall may quote, as opposed to what it may search (`packages/index/src/project.ts::disclosureTextFor`): the `<mark>` claim, `<summary>` headlines, `<dl>` facets, and citations. Facets and citations are read from the whole article, so one inside a `<details>` or an `<aside>` is quoted too. The rest of a `<details>` body stays out, so recall spends none of its shared budget on one memory's backstory. The rest of an `<aside>` stays out as well, because an aside is a scope caveat and a disclosure line has no room to say "this is the exception". The column is composed from the parser's separated extraction fields rather than re-derived from markup.

### 2.2. Chunks, embeddings, edges, watermark

`chunks` and `embeddings` key on `content_hash` rather than on `path`, with `chunk_id = sha256(content_hash + ":" + ordinal)` (`packages/index/src/chunking.ts::chunkIdFor`). An identical body anywhere in the tree therefore shares one chunk row and one vector, and a `git mv` costs zero embedding calls.

`edges` (`packages/index/migrations/0008_tasks.sql`) carries the four relationship classes, the `derived` flag, a strength, a provenance, and CHECK constraints that refuse a cross-class rel, a self-loop, and `derived = 1` outside `provenance = 'sleep'`. The sleep pipeline stamped that provenance on the edges it mined until 0.16 removed the pipeline. No command writes a derived edge now.

`index_state` (`packages/index/migrations/0007_watermark.sql`) is a single-row table, enforced by CHECK, holding the watermark and the identity of the vector space. The watermark is the commit sha the index has caught up to.

The state plane (`packages/index/state-migrations/S0001_access.sql`, `packages/index/state-migrations/S0002_entity_corroboration.sql`) holds `access`, `edge_corroboration`, and `entity_corroboration`. Its `CREATE TABLE` statements name the `state` schema, and its `CREATE INDEX` statements put that name on the index rather than on the table, which is the form this driver accepts.

### 2.3. Entity activity is a report and never a signal

`file_entities` carries no time column of its own, so "when was this entity last active" is a question about the `files` rows that reference it. `memhtml entity activity` (`apps/cli/src/operations.ts::entityActivity`, `apps/cli/src/operations.ts::entityActivityQuery`) answers it: `GROUP BY e.entity_type, e.entity_name` over `file_entities JOIN files`, which is the column set of the `file_entities_name` index, so the grouping is an index scan rather than a sort of the whole join.

It publishes three timestamps because they are three clocks. `lastActivityAt` is `max(coalesce(event_at, updated_at))`, the recency arm's own rule, so "most recently active" means here what it means in a ranked search. It is a maximum of a per-row coalesce, not a coalesce of two maxima, and the two differ whenever the newest world time and the newest write time sit on different memories. `lastEventAt` is `max(event_at)` alone, which is world time, and it is `null` when no in-scope memory states one. `lastWrittenAt` is `max(updated_at)` alone, which is write time. A caller that needs one clock gets it by name instead of inferring which one a coalesced value fell back to. `entityCount` is the total matching the scope regardless of `limit`, so a clamped answer is visible.

`--type` folds case, the way `--entity` folds at both retrieval doors, but a row carries the type and name the corpus authored. So a corpus holding both `Service:Checkout-API` and `service:checkout-api` reports two rows where `--entity` returns one entity's memories. The report shows the spellings as stored, before any curation pass has folded them.

**It is report-only, and that is structural.** Every ranking arm lives in `@memhtml/index` and every decay term in `@memhtml/domain`. Both sit below `apps/cli` in the project-reference graph, so neither can import this function, and an attempt is a compile error. This matters because of the salience arm's own two exclusions ([Four-arm retrieval](/internals/four-arm-retrieval/)). Decay is wrong for identity, because a colleague unmentioned for six months is not less themselves, and decay over working state would reward staleness. An "entity last active" number wired into ranking reintroduces both at once, on the axis where a consumer models its own domain.

Activity is write-side only. Reads live in `state.access`, which is path-keyed with no foreign key onto `files` and sits in the separately attached plane. That plane's lifetime differs from the index's: `index.db` is a disposable projection of git, and `state.db` is not. Joining it here would let a rebuilt index and a preserved state plane disagree about one row. The salience arm is the one ranking statement that crosses that boundary.

### 2.4. Widening a CHECK-bearing table

Migration `0008_tasks.sql` widens both CHECK-bearing tables by recreating them and copying the rows across, and the step that makes it safe is that it snapshots every child table first (`packages/index/migrations/0008_tasks.sql`).

`DROP TABLE files` cascades away every row of every child table, including `embeddings` behind `chunks`, inside the same transaction the migration runner wraps the file in. A migration that copied only `files` would report success and destroy every embedding in the database. The snapshot avoids that without depending on foreign-key state at all: the children are copied out, the cascade fires against a table whose contents no longer matter, and the rows are copied back under the new parent.

## 3. Projection

`projectFile` (`packages/index/src/project.ts::projectFile`) is pure. Given a document, a path, and a blob sha, the row set is fully determined, so rebuild and update write the same rows from the same bytes rather than two implementations happening to agree. They do not always read the same bytes: `update` also projects uncommitted files from the working tree, and `rebuild` reads HEAD only.

`archived` is read from the path's top-level bucket instead of from `memhtml-status` (`packages/index/src/project.ts::projectFile`). The path records the state, so a file whose head says `active` while sitting under `archive/` carries stale metadata. Trusting the meta would let a mis-stamped file re-enter retrieval and break the guarantee the duplicate-detection index provides.

### 3.1. Four narrow write rules

Each rule avoids a specific loss.

- The `files` write is an upsert on `path` (`packages/index/src/project.ts::projectFile`), so one statement serves both a rebuild into an emptied table and an in-place rewrite. Rewriting in place preserves the row's chunks, where deleting and re-inserting would cascade them away along with their embeddings. A `content_hash` collision against a different active path is left unabsorbed on purpose, since that is the structural duplicate check.
- Chunk deletion is narrowed to `content_hash <> ?` (`packages/index/src/project.ts::projectFile`). A blanket delete would re-embed the whole file after any metadata-only edit.
- Edges are cleared by `src_path` only (`packages/index/src/project.ts::projectFile`), because an inbound edge is another file's authored assertion.
- `FILE_COLUMNS` (`packages/index/src/project.ts::FILE_COLUMNS`) drives the insert's column list and the upsert's assignment clause from one list. The placeholder count comes from the hand-ordered value array in `projectFile`, so a column added to `FILE_COLUMNS` without a value fails on a column/value count mismatch. A value misplaced within that array can still bind to the wrong column without failing any CHECK.

### 3.2. Entity rows

Entity rows come from three sources (`packages/index/src/project.ts::entityRowsFor`): `memhtml-entity` metas, one `concept:<term>` per `<dfn>`, and one `lang:<value>` per `<code data-lang>`. A memory that defines a term is therefore findable by that term without the author restating it as a meta.

Rows are deduplicated in TypeScript (`packages/index/src/project.ts::dedupeBy`) rather than in the database, because they go in through `writeAll` as one atomic batch. A duplicate facet would fail the primary key and roll back every other row in that batch, taking down a whole rebuild over one repeated `<dt>`/`<dd>` pair.

## 4. Rebuild

Both the rebuild path and the update path call `projectFile`, which is the reproducibility contract (`packages/index/src/indexer.ts::makeIndexer::projectOne`). Figure 1 draws it: two entry points, four different ways of getting at the bytes, and one projection function they all reach.

```d2 pad=20 src="_figures/rebuild-and-update.d2" title="Two entry points. Index update reads the watermark index_state.head_sha first: no index_state row routes to index rebuild, and a recorded commit routes to git diff for committed changes and git status porcelain for uncommitted ones. Index rebuild reads the whole corpus at HEAD through ls-tree and cat-file. All four of those readers converge on projectFile, marked pure, which produces the row set."
```

**Figure 1: two entry points, one projection function.** The same bytes give the same rows whichever entry point projected them, but on a dirty tree the two read different bytes: `update` also reads uncommitted files, and `rebuild` reads HEAD only. Update's two watermark checks are why it never diffs against nothing. With no `index_state` row it falls through to a rebuild, and a row whose `head_sha` is NULL is refused with `ERR_INDEX_STALE`.

Rebuild (`packages/index/src/indexer.ts::makeIndexer::rebuild`, `packages/index/src/indexer.ts::makeIndexer::reproject`) runs `rev-parse HEAD`, one `ls-tree -r` over the four top-level prefixes, and one `cat-file --batch` for the whole corpus. That is one subprocess for the tree instead of N `readFile` calls, and it works on a bare or detached checkout.

Generated `index.html` and `sitemap.xml` files are excluded by name (`packages/index/src/indexer.ts::GENERATED_NAMES`, `packages/index/src/indexer.ts::isIndexablePath`). Indexing them would feed every directory listing back into retrieval as a memory whose body is the titles of other memories, and the corpus would rank its own table of contents above its content.

The full-text index stays live through the bulk load (`packages/index/src/indexer.ts::makeIndexer::reproject`, `packages/index/src/indexer.ts::makeIndexer::truncateForRebuild`). Emptying `files` removes every row from it through the delete trigger, and each new row is indexed through the insert trigger. Nothing drops and recreates `files_fts` around the load. FTS5 writes stay linear, and a drop-and-recreate bracket would open a window where a crash leaves the store with no lexical index (`packages/index/src/schema-const.ts::FTS_INDEX_NAME`, `packages/index/src/indexer.ts::makeIndexer::applyProjectionWrites`). Section 5 gives the measured costs.

Tables are emptied children-first (`packages/index/src/schema-const.ts::MEMORY_TABLES`), so the statements are correct with foreign keys enforced rather than relying on the cascade. A parse failure is a counted skip (`packages/index/src/indexer.ts::makeIndexer::projectOne`): one bad hand-authored file should be reported by `memhtml doctor` and should not stop the indexing of every other file in the tree.

## 5. Incremental update

Update (`packages/index/src/indexer.ts::makeIndexer::update`) reads `index_state.head_sha` as its watermark. With no `index_state` row, which is a store nothing has indexed yet, it falls through to a full rebuild rather than diffing against nothing. A row whose `head_sha` is NULL is a rebuild that died between its truncate and its watermark write, and update refuses it with `ERR_INDEX_STALE` until a rebuild runs (`packages/index/src/indexer.ts::IndexStale`).

With a watermark in hand, update takes `git diff --name-status -M` from the watermark to HEAD, plus `git status --porcelain=v2` for uncommitted edits. The second covers the ordinary agent flow, where an agent edited a file with a text tool and has not committed. Committed changes apply first and the working tree second (`packages/index/src/indexer.ts::makeIndexer::update`). So a path that moved in a commit and was then edited without committing ends at the working tree's content because of the ordering, not because of a precedence rule that could disagree with it.

Every committed diff target's blob is fetched in two subprocesses total, one `ls-tree -r` over the four buckets and one `cat-file --batch`, rather than two per file (`packages/index/src/indexer.ts::makeIndexer::update`). A per-file read would spawn two processes for every changed file, so batching is cheaper from the second changed file onward.

A rename within the corpus goes through `movePath` (`packages/index/src/indexer.ts::makeIndexer::movePath`) as an `UPDATE`, not as a delete plus an insert. `ON UPDATE CASCADE` carries tags, entities, facets, citations, and chunks along with it, and the `edges` row is updated explicitly because it holds no foreign key. This is why `chunks` keys on `content_hash`: a delete-and-re-add would cascade the source's chunks away with their embeddings, and the next embed pass would pay for text that did not change.

Every pass writes through the live lexical index, bulk and interactive alike (`packages/index/src/indexer.ts::makeIndexer::applyProjectionWrites`). `files_fts` is an external-content FTS5 table maintained by three triggers on `files`, and its write cost stays linear rather than accumulating. In a probe on 2026-08-12 on node 24.19.0, six consecutive 256-operation batches against a constant 10k-file store cost 6, 5, 6, 5, 5, and 5 ms. Inserting a whole store cost 20 ms at 800 files, 101 ms at 5k, and 234 ms at 10k. Set beside the thousands of embedding calls a bulk pass makes, that cost does not justify a drop-and-recreate bracket, which would open a window where a crash leaves the store with no lexical index at all.

## 6. Chunking and embeddings

`chunkText` (`packages/index/src/chunking.ts::chunkText`) returns the whole article as chunk 0 up to 1,800 characters, which covers nearly every file, since the format is one fact per file. The embedding is then a function of the article rather than of an arbitrary window. Longer text splits on sentence boundaries and packs greedily, and a sentence over the ceiling is hard-cut rather than dropped, so the function is total and no text leaves the index.

`embedMissing` (`packages/index/src/indexer.ts::makeIndexer::embedMissing`) requests vectors only for chunks that have none or that carry a vector from another model. On the update path the pending scan is scoped to the batch's own chunk ids, so `update --embed` embeds only its own batch. A store-wide gap, left by `--no-embed` runs or by failed embed calls, is closed by `memhtml index embed`, the bare `embedMissing()` whose scan stays unscoped and which writes nothing but vectors. `rebuild --embed` runs the same unscoped scan after reprojecting. A rebuild keeps the vectors it already has: `truncateForRebuild` stashes the `embeddings` rows in the configured space, and `restoreEmbeddings` puts back every one whose content-addressed chunk id the reprojection produced again, so only a model change empties the vector plane. `rebuild --no-embed` over a store that carries vectors is refused with `ERR_REBUILD_NO_EMBED_REFUSED` unless `--force` is given.

A model failure does not fail the pass. The lexical index alone is a working index, and refusing to leave the vector lane partly filled would let a throttled provider turn a complete full-text index into no index at all.

Embedding is Cohere Embed v4 at 1,024 dimensions, batched at Cohere's 96-text ceiling (`packages/llm/src/constants.ts::EMBED_MODEL_ID`, `packages/llm/src/constants.ts::EMBED_DIM`, `packages/llm/src/constants.ts::EMBED_BATCH_LIMIT`, `packages/llm/src/embeddings.ts::makeEmbeddings`). Documents and queries are sent with different `input_type` values (`packages/llm/src/embeddings.ts::EmbeddingsShape`), because reusing one value for both silently degrades every cosine.

## 7. A vector-space mismatch is refused unless a rebuild migrates it

`index update`, `index embed`, and a rebuild that cannot write vectors (`--no-embed`, or `--embed` with `MEMHTML_EMBED=off`) check `index_state.embed_model` before they write, and a mismatch fails with a typed error rather than a silent reindex (`packages/index/src/indexer.ts::EmbedModelMismatch`, `packages/index/src/indexer.ts::makeIndexer::guardEmbedModel`). `index rebuild --embed` with an embedder bound is the one path past the check, and it migrates the whole space: its truncate records the configured space and carries no vector from the old one across (`packages/index/src/indexer.ts::makeIndexer::truncateForRebuild`). So an index can never hold vectors from two spaces.

A half-migrated vector space degrades every cosine while every individual vector stays well-formed, which no test would notice. The refusal turns that silent degradation into an error at the first write.

Recovering from one, and rebuilding an index in general, is an operations how-to under [Learn](/learn/).

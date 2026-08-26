---
title: The index
description: Two databases on one connection, a schema whose keys expect the primary key to move, and one projection function that makes rebuild and incremental update agree.
---

## 1. Two databases on one connection

The index is a projection of the git tree, meaning every row in it is computed from a file in the tree and nothing is recorded there first. It lives in two SQLite files. `.memhtml/index.db` is the index plane, and `.memhtml/state.db` is the state plane, which holds the usage statistics no file records.

`state.db` is attached to the same connection under the schema name `state` (`packages/index/src/database.ts:287`), which lets the salience ranker `LEFT JOIN state.access` in the same statement that reads `main.files`, with no join performed in application code. Attaching twice is an error, so it happens once per connection in `makeDatabase` (`packages/index/src/database.ts:319`).

Each plane keeps its own migration ledger (`packages/index/src/database.ts:195`, `packages/index/src/schema-const.ts:10-15`). Rebuilding `index.db` must not mark the state plane's migrations unapplied.

Both planes are plain SQLite reached through node's built-in `node:sqlite`, so the only database dependency is node itself, with no driver feature flags to keep in step, and `sqlite3` or a GUI browser opens either file directly.

Every connection sets `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, and `foreign_keys = ON`, and registers one SQL function, `vector_distance_cos` (`packages/index/src/database.ts:342-354`). That function calls `@memhtml/domain`'s `cosineDistance`, so one implementation serves both the vector ranker's SQL and the diversification pass, and the two cannot disagree about a clamp or about a zero-magnitude vector.

Migrations apply in filename order, and each file's statements commit together with its ledger row in one transaction (`packages/index/src/database.ts:215`), so a crash never leaves one half-applied. Migrations are read from disk relative to the built output, so adding one means adding a `.sql` file and changing no code.

## 2. Schema

`files` (`packages/index/migrations/0008_tasks.sql:28`) projects one memory file: identity, classification under a ten-value `memory_type` CHECK, three text surfaces, the scoring inputs, the bitemporal fields, provenance, and two task columns.

Each child table (`packages/index/migrations/0001_files.sql:73-110`) declares `ON UPDATE CASCADE` alongside `ON DELETE CASCADE`. `files.path` is the primary key and it moves, because eviction is a `git mv`, and foreign keys are checked immediately. Without the update cascade the rename's `UPDATE` fails outright.

### 2.1. Three text columns, three jobs

- `body_text` is the full search surface.
- `fts_text` is the title, gist, and body joined by newlines (`packages/index/src/project.ts:48`). One denormalized column, because a multi-column full-text index on this driver returns rowid order rather than relevance order, and it scopes MATCH to the named column alone (`packages/index/src/schema-const.ts:28-38`). The join uses newlines rather than spaces, so a term ending the title cannot fuse with one starting the gist into a phrase neither states.
- `disclosure_text` is what recall may quote, as opposed to what it may search (`packages/index/src/project.ts:51-83`): the `<mark>` claim, `<summary>` headlines, `<dl>` facets, and citations. `<details>` bodies never appear, so that tier of provenance reaches an agent only through `memory_read`. `<aside>` texts never appear either, because an aside is a scope caveat and a disclosure line has no room to say "this is the exception". The column is composed from the parser's separated extraction fields rather than re-derived from markup.

### 2.2. Chunks, embeddings, edges, watermark

`chunks` and `embeddings` key on `content_hash` rather than on `path`, with `chunk_id = sha256(content_hash + ":" + ordinal)` (`packages/index/src/chunking.ts:27`). An identical body anywhere in the tree therefore shares one chunk row and one vector, and a `git mv` costs zero embedding calls.

`edges` (`packages/index/migrations/0008_tasks.sql:147`) carries the four relationship classes, the `derived` flag, a strength, a provenance, and CHECK constraints that refuse a cross-class rel, a self-loop, and `derived = 1` outside `provenance = 'sleep'`.

`index_state` (`packages/index/migrations/0007_watermark.sql:5`) is a single-row table, enforced by CHECK, holding the watermark and the identity of the vector space. The watermark is the commit sha the index has caught up to.

The state plane (`packages/index/state-migrations/S0001_access.sql`) holds `access` and `edge_corroboration`. Its DDL names its own schema and puts that name on the INDEX rather than on the table, which is the form this driver accepts.

### 2.3. Entity activity is a report and never a signal

`file_entities` carries no time column of its own, so "when was this entity last active" is a question about the `files` rows that reference it. `memhtml entity activity` (`entityActivity`, `apps/cli/src/operations.ts`) answers it: `GROUP BY (entity_type, entity_name)` over `file_entities JOIN files`, which is `file_entities_name`'s own column order, so the grouping is an index scan rather than a sort of the whole join.

It publishes three timestamps because they are three clocks. `last_activity_at` is `max(coalesce(event_at, updated_at))`, the recency arm's own rule, so "most recently active" means here what it means in a ranked search — and it is a maximum of a per-row coalesce, not a coalesce of two maxima, which differ whenever the newest world time and the newest write time sit on different memories. `last_event_at` is `max(event_at)` alone, WORLD time, `null` when no in-scope memory states one. `last_written_at` is `max(updated_at)` alone, WRITE time. A caller that needs one clock gets it by name instead of inferring which one a coalesced value fell back to. `entity_count` is the total matching the scope regardless of `limit`, so a clamped answer is visible.

**It is report-only, and that is structural.** Every ranking arm lives in `@memhtml/index` and every decay term in `@memhtml/domain`, and both sit below `apps/cli` in the project-reference graph, so neither can import this function — an attempt is a compile error. The reason it matters is the salience arm's own two exclusions ([Four-arm retrieval](/internals/four-arm-retrieval/)): decay is wrong for identity, because a colleague unmentioned for six months is not less themselves, and decay over working state would reward staleness. An "entity last active" number wired into ranking reintroduces both at once, on the axis where a consumer models its own domain.

Activity is write-side only. Reads live in `state.access`, which is path-keyed with no foreign key onto `files` and sits in the separately ATTACHed plane whose lifetime differs from the index's — `index.db` is a disposable projection of git and `state.db` is not. Joining it here would let a rebuilt index and a preserved state plane disagree about one row. The salience arm is the one statement that crosses that boundary.

### 2.4. Widening a CHECK-bearing table

Migration `0008_tasks.sql` widens both CHECK-bearing tables by recreating them and copying the rows across, and the step that makes it safe is that it snapshots every child table first (`packages/index/migrations/0008_tasks.sql:85-92`).

`DROP TABLE files` cascades away every row of every child table, including `embeddings` behind `chunks`, inside the same transaction the migration runner wraps the file in. A migration that copied only `files` would report success and destroy every embedding in the database. The snapshot avoids that without depending on foreign-key state at all: the children are copied out, the cascade fires against a table whose contents no longer matter, and the rows are copied back under the new parent.

## 3. Projection

`projectFile` (`packages/index/src/project.ts:141`) is pure. Given a document, a path, and a blob sha, the row set is fully determined. That is what makes a fresh rebuild reproduce the incremental row set, rather than two implementations happening to agree.

`archived` is read from the path's top-level bucket instead of from `memhtml-status` (`packages/index/src/project.ts:133-140`). The path records the state, so a file whose head says `active` while sitting under `archive/` carries stale metadata. Trusting the meta would let a mis-stamped file re-enter retrieval and break the guarantee the duplicate-detection index provides.

### 3.1. Four narrow write rules

Each rule avoids a specific loss.

- The `files` write is an upsert on `path` (`packages/index/src/project.ts:204-214`), so one statement serves both a rebuild into an emptied table and an in-place rewrite. Rewriting in place preserves the row's chunks, where deleting and re-inserting would cascade them away along with their embeddings. A `content_hash` collision against a different active path is left unabsorbed on purpose, since that is the structural duplicate check.
- Chunk deletion is narrowed to `content_hash <> ?` (`packages/index/src/project.ts:232-235`). A blanket delete would re-embed the whole file after any metadata-only edit.
- Edges are cleared by `src_path` only (`packages/index/src/project.ts:236-241`), because an inbound edge is another file's authored assertion.
- `FILE_COLUMNS` (`packages/index/src/project.ts:93`) drives the insert, the placeholder count, and the upsert's assignment clause from one list. A column added to one of the three and forgotten in another would bind every subsequent value to the wrong column while every CHECK still passed.

### 3.2. Entity rows

Entity rows come from three sources (`packages/index/src/project.ts:315`): `memhtml-entity` metas, one `concept:<term>` per `<dfn>`, and one `lang:<value>` per `<code data-lang>`. A memory that defines a term is therefore findable by that term without the author restating it as a meta.

Rows are deduplicated in TypeScript (`packages/index/src/project.ts:381`) rather than in the database, because they go in through `writeAll` as one atomic batch. A duplicate facet would fail the primary key and roll back every other row in that batch, taking down a whole rebuild over one repeated `<dt>`/`<dd>` pair.

## 4. Rebuild

Both the rebuild path and the update path call `projectFile`, which is the reproducibility contract (`packages/index/src/indexer.ts:20-27`). Figure 1 draws it: two entry points, four different ways of getting at the bytes, and one projection function they all reach.

```d2 pad=20 src="_figures/rebuild-and-update.d2" title="Two entry points. Index update reads the watermark index_state.head_sha first: an absent watermark routes to index rebuild, and a present one routes to git diff for committed changes and git status porcelain for uncommitted ones. Index rebuild reads the whole corpus through ls-tree and cat-file. All four of those readers converge on projectFile, marked pure, which produces the row set."
```

**Figure 1: two entry points, one projection function.** Nothing about the row set depends on which entry point produced it, which is what makes a fresh rebuild reproduce the incremental row set. The watermark's absent branch is why an update can never diff against nothing.

Rebuild (`packages/index/src/indexer.ts:396`) runs `rev-parse HEAD`, one `ls-tree -r` over the four top-level prefixes, and one `cat-file --batch` for the whole corpus. That is one subprocess for the tree instead of N `readFile` calls, and it works on a bare or detached checkout.

Generated `index.html` and `sitemap.xml` files are excluded by name (`packages/index/src/indexer.ts:130-137`). Indexing them would feed every directory listing back into retrieval as a memory whose body is the titles of other memories, and the corpus would rank its own table of contents above its content.

The full-text index is dropped for the bulk load and rebuilt afterwards (`packages/index/src/indexer.ts:406`, `packages/index/src/indexer.ts:426`). Writing through a live full-text index costs 10-25 ms per row and gets worse faster than linearly as the table grows, while building the index over a finished table is linear at roughly 6.6 µs per row (`packages/index/src/schema-const.ts:20-26`). Keeping it live during a rebuild would make a 10k-memory corpus unindexable in practice.

Tables are emptied children-first (`packages/index/src/schema-const.ts:47-56`), so the statements are correct with foreign keys enforced rather than relying on the cascade. A parse failure is a counted skip (`packages/index/src/indexer.ts:209-226`): one bad hand-authored file should be reported by `memhtml doctor` and should not stop the indexing of every other file in the tree.

## 5. Incremental update

Update (`packages/index/src/indexer.ts:567`) reads `index_state.head_sha` as its watermark. An absent watermark falls through to a full rebuild rather than diffing against nothing (`packages/index/src/indexer.ts:572-586`).

With a watermark in hand it takes `git diff --name-status -M` from the watermark to HEAD, plus `git status --porcelain=v2` for uncommitted edits, which covers the ordinary agent flow where the agent edited with a text tool and has not committed. Committed changes apply first and the working tree second (`packages/index/src/indexer.ts:645-649`). A path that both moved in a commit and was then edited without committing therefore ends at the working tree's content because of the ordering, rather than because of a precedence rule that could disagree with it.

Every committed diff target's blob is fetched in two subprocesses total rather than two per file (`packages/index/src/indexer.ts:596-623`). A per-file `lsTreeR(ref, [path])` walks the whole tree to answer one path, so N writes would cost 2N tree walks, and that per-operation term scaled by store size is what makes bulk ingest quadratic. One full-tree walk costs the same as one single-path walk, so batching is cheaper from the second changed file onward.

A rename goes through `movePath` (`packages/index/src/indexer.ts:480`) as an `UPDATE`, never as a delete plus an insert. `ON UPDATE CASCADE` carries tags, entities, facets, citations, and chunks along with it, and the `edges` row is updated explicitly because it holds no foreign key. This is why `chunks` keys on `content_hash`: a delete-and-re-add would cascade the source's chunks away with their embeddings, and the next embed pass would pay for text that did not change.

Every pass writes through the live lexical index, bulk and interactive alike (`packages/index/src/indexer.ts:171-181`). `files_fts` is an external-content FTS5 table maintained by three triggers on `files`, and its write cost stays linear rather than accumulating. Probed 2026-08-12 on node 24.19.0, six consecutive 256-operation batches against a constant 10k-file store cost 6, 5, 6, 5, 5, and 5 ms, and inserting a whole store costs 20 ms at 800 files, 101 ms at 5k, and 234 ms at 10k. Set beside the thousands of embedding calls a bulk pass makes, that cost does not justify a drop-and-recreate bracket, and a bracket would open a window where a crash leaves the store with no lexical index at all.

## 6. Chunking and embeddings

`chunkText` (`packages/index/src/chunking.ts:41`) returns the whole article as chunk 0 below 1,800 characters, which covers nearly every file, since the format is one fact per file. The embedding is then a function of the article rather than of an arbitrary window. Longer text splits on sentence boundaries and packs greedily, and a sentence over the ceiling is hard-cut rather than dropped, so the function is total and no text leaves the index.

`embedMissing` (`packages/index/src/indexer.ts`) requests vectors only for chunks that have none or that carry a vector from another model. On the update path the pending scan is scoped to the batch's own chunk ids, so `update --embed` embeds only its own batch. A store-wide gap, left by `--no-embed` runs or by failed embed calls, is closed by `rebuild --embed`, whose scan stays unscoped.

A model failure does not fail the pass. The lexical index alone is a working index, and refusing to leave the vector lane partly filled would let a throttled provider turn a complete full-text index into no index at all.

Embedding is Cohere Embed v4 at 1,024 dimensions over `invoke_model`, batched at Cohere's 96-text ceiling (`packages/llm/src/constants.ts:7-11`, `packages/llm/src/embeddings.ts:110`). Documents and queries are sent with different `input_type` values (`packages/llm/src/embeddings.ts:11-14`), because reusing one value for both silently degrades every cosine.

## 7. A vector-space mismatch is a hard refusal

A write against an index built under a different embedding model fails with a typed error, and nothing reindexes silently (`packages/index/src/indexer.ts:103-116`, `packages/index/src/indexer.ts:241`). `index_state.embed_model` is checked before any write, and before the first write records a watermark, so an index can never accumulate rows from two vector spaces.

A half-migrated vector space degrades every cosine while every individual vector stays well-formed, which no test would notice. The refusal turns that silent degradation into an error at the first write.

Recovering from one, and rebuilding an index in general, is an operations how-to under [Learn](/learn/).

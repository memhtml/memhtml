---
title: The index
description: Two databases on one connection, a schema whose keys anticipate a moving path, and a projection function that makes rebuild and incremental update agree by construction.
---

## 1. Two databases on one connection

`.memhtml/state.db` is ATTACHed as `state` (`packages/index/src/database.ts:294`) so the salience arm
can `LEFT JOIN state.access` in the same statement as `main.files` with no application-side join.
Attaching is not idempotent, so it happens once per connection in `makeDatabase`
(`packages/index/src/database.ts:319`).

Each plane keeps its own migration ledger (`packages/index/src/database.ts:195`,
`packages/index/src/schema-const.ts:10-15`), because rebuilding `index.db` must not mark the state
plane's migrations unapplied.

Both planes are plain SQLite through node's built-in `node:sqlite`, so there is no third-party database
dependency and no driver feature flags to keep in step — `sqlite3` or a GUI browser opens either file
directly.

Every connection sets `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, and
`foreign_keys = ON`, and registers one SQL function, `vector_distance_cos`
(`packages/index/src/database.ts:342-354`). That function is `@memhtml/domain`'s `cosineDistance`
rather than a second implementation, so the vector arm's SQL and the MMR pass cannot disagree about a
clamp or a zero-magnitude vector.

Migrations apply in filename order, each file's statements and its ledger row committing in ONE
transaction (`packages/index/src/database.ts:215`), so a crash never leaves one half-applied. Migrations
are read from disk relative to the built output, so adding one means adding a `.sql` file and no code
change.

## 2. Schema

`files` (`packages/index/migrations/0008_tasks.sql:28`) projects one memory file: identity,
classification under a ten-value `memory_type` CHECK, three text surfaces, the scoring inputs, the
bitemporal fields, provenance, and two task columns.

Child tables (`packages/index/migrations/0001_files.sql:73-110`) each declare **`ON UPDATE CASCADE` as
well as `ON DELETE CASCADE`**, because `files.path` is the primary key *and* it moves — eviction is a
`git mv` — and foreign keys are immediate, so without it the rename's `UPDATE` fails outright.

### 2.1. Three text columns, three jobs

- `body_text` — the full search surface.
- `fts_text` — title, gist, and body newline-joined (`packages/index/src/project.ts:48`). One
  denormalized column, because a multi-column FTS index on this driver returns rowid order rather than
  relevance order and scopes MATCH to the named column alone
  (`packages/index/src/schema-const.ts:28-38`). Newline- rather than space-joined, so a term ending the
  title cannot fuse with one starting the gist into a phrase neither states.
- `disclosure_text` — what recall may *quote*, as opposed to what it may search
  (`packages/index/src/project.ts:51-83`): the `<mark>` claim, `<summary>` headlines, `<dl>` facets,
  citations. `<details>` bodies never appear — that tier of provenance reaches an agent only through
  `memory_read` — and neither do `<aside>` texts, because an aside is a scope caveat and a disclosure
  line has no room to say "this is the exception". It is composed from the parser's separated extraction
  fields rather than re-derived from markup.

### 2.2. Chunks, embeddings, edges, watermark

`chunks` and `embeddings` key on `content_hash`, not `path`:
`chunk_id = sha256(content_hash + ":" + ordinal)` (`packages/index/src/chunking.ts:27`), so an
identical body anywhere in the tree shares one chunk row and one vector, and a `git mv` costs zero
embedding calls.

`edges` (`packages/index/migrations/0008_tasks.sql:147`) carries the four classes, the `derived`
firewall, a strength, a provenance, and CHECKs refusing a cross-class rel, a self-loop, and
`derived = 1` outside `provenance = 'sleep'`.

`index_state` (`packages/index/migrations/0007_watermark.sql:5`) is a single-row table by CHECK holding
the watermark and the vector-space identity.

The state plane (`packages/index/state-migrations/S0001_access.sql`) holds `access` and
`edge_corroboration`; its DDL names its own schema and puts that name on the INDEX rather than the
table, which is the form this driver accepts.

### 2.3. Widening a CHECK-bearing table

Migration `0008_tasks.sql` widens both CHECK-bearing tables by recreate-and-copy, and its load-bearing
detail is that it **snapshots every child table first**
(`packages/index/migrations/0008_tasks.sql:85-92`).

`DROP TABLE files` cascades away every row of every child — including `embeddings` behind `chunks` —
inside the same transaction the runner wraps the file in, so a migration that copied only `files` would
report success and silently destroy every embedding in the database. The snapshot does not depend on
foreign-key state at all: children are copied out, the cascade fires against a table of no consequence,
and the rows are copied back under the new parent.

## 3. Projection

`projectFile` (`packages/index/src/project.ts:141`) is pure: given a doc, a path, and a blob sha the
row set is fully determined, which makes "a fresh rebuild reproduces the incremental row set" true by
construction rather than by two implementations agreeing.

`archived` is read from the path's PARA bucket, not `memhtml-status`
(`packages/index/src/project.ts:133-140`) — the path *is* the state, so a file whose head says `active`
while sitting under `archive/` is stale metadata, and trusting the meta would let a mis-stamped file
re-enter retrieval and break the dedup index's guarantee.

### 3.1. Four narrow write rules

Each avoids a specific loss.

- The `files` write is an **upsert on `path`** (`packages/index/src/project.ts:204-214`), so one
  statement serves a rebuild into an emptied table and an in-place rewrite. Rewriting in place preserves
  the row's chunks; deleting and re-inserting would cascade them away with their embeddings. A
  `content_hash` collision against a *different* active path is deliberately not absorbed — that is the
  structural dedup.
- Chunk deletion is narrowed to `content_hash <> ?` (`packages/index/src/project.ts:232-235`), because
  a blanket delete would re-embed the whole file on any meta-only edit.
- Edges are cleared by `src_path` only (`packages/index/src/project.ts:236-241`), because an inbound
  edge is another file's authored assertion.
- `FILE_COLUMNS` (`packages/index/src/project.ts:93`) drives the insert, the placeholder count, and the
  upsert's assignment clause from one list, since a column added to one and forgotten in another binds
  every subsequent value to the wrong column while every CHECK still passes.

### 3.2. Entity rows

Entity rows come from three sources (`packages/index/src/project.ts:315`): `memhtml-entity` metas, one
`concept:<term>` per `<dfn>`, and one `lang:<value>` per `<code data-lang>` — so a memory that
*defines* a term is findable by it without the author restating it as a meta.

Row deduplication happens in TypeScript (`packages/index/src/project.ts:381`) rather than in the
database, because these rows go in through `writeAll` as one atomic batch and a duplicate facet would
fail the primary key and roll back every other row, taking the whole rebuild down over one repeated
`<dt>`/`<dd>` pair.

## 4. Rebuild

Both the rebuild and the update path call `projectFile`, which is the reproducibility contract
(`packages/index/src/indexer.ts:20-27`). Figure 1 is that contract drawn: two entry points, four
different ways of getting at the bytes, and one projection function they all end at.

```d2 pad=20 src="_figures/rebuild-and-update.d2" title="Two entry points. Index update reads the watermark index_state.head_sha first: an absent watermark routes to index rebuild, and a present one routes to git diff for committed changes and git status porcelain for uncommitted ones. Index rebuild reads the whole corpus through ls-tree and cat-file. All four of those readers converge on projectFile, marked pure, which produces the row set."
```

**Figure 1: two entry points, one projection function.** Nothing about the row set depends on which
entry point produced it, which is what makes "a fresh rebuild reproduces the incremental row set" true by
construction rather than by two implementations happening to agree. The watermark's absent branch is the
reason an update can never diff against nothing.

**Rebuild** (`packages/index/src/indexer.ts:389`) runs `rev-parse HEAD`, one `ls-tree -r` over the four
PARA prefixes, and one `cat-file --batch` for the whole corpus — one subprocess for the tree instead of
N `readFile` calls, working on a bare or detached checkout.

Generated `index.html` and `sitemap.xml` are excluded by name
(`packages/index/src/indexer.ts:130-137`): indexing them would feed every directory listing back into
retrieval as a memory whose body is the titles of other memories, so the corpus would rank its own table
of contents above its content.

The FTS index is **dropped for the bulk load and rebuilt after**
(`packages/index/src/indexer.ts:406`, `packages/index/src/indexer.ts:426`). Writing through a live FTS
index costs 10-25 ms per row and degrades superlinearly in table size, while building it over a finished
table is linear at roughly 6.6 µs per row (`packages/index/src/schema-const.ts:20-26`) — keeping it up
during a rebuild would make a 10k-memory corpus unindexable in practice.

Tables empty children-first (`packages/index/src/schema-const.ts:47-56`) so the statements are correct
with foreign keys enforced rather than relying on cascade. A parse failure is a counted skip
(`packages/index/src/indexer.ts:209-226`): one bad hand-authored file must be reported by
`memhtml doctor`, not stop the indexing of every other file in the tree.

## 5. Incremental update

**Update** (`packages/index/src/indexer.ts:565`) reads `index_state.head_sha` as its watermark; an
absent watermark falls through to a full rebuild rather than diffing against nothing
(`packages/index/src/indexer.ts:572-586`).

Otherwise it takes `git diff --name-status -M` from the watermark to HEAD plus
`git status --porcelain=v2` for uncommitted edits — the ordinary agent flow, where the agent edited with
a text tool and has not committed. Committed changes apply first and the working tree second
(`packages/index/src/indexer.ts:645-649`), so a path that both moved in a commit and was then edited
uncommitted ends at the working tree's content by *ordering* rather than by a precedence rule that could
disagree.

Every committed diff target's blob is fetched in **two subprocesses, not two per file**
(`packages/index/src/indexer.ts:596-623`): a per-file `lsTreeR(ref, [path])` walks the whole tree to
answer one path, so N writes cost 2N tree walks — the store-scaled per-op term that makes bulk ingest
quadratic. One full-tree walk costs the same as one single-path walk, so batching is strictly cheaper
from the second changed file on.

A rename is `movePath` (`packages/index/src/indexer.ts:480`) — an `UPDATE`, never a delete plus an
insert. `ON UPDATE CASCADE` carries tags, entities, facets, citations, and chunks along; the `edges` row
updates explicitly because it holds no foreign key. This is the whole reason `chunks` keys on
`content_hash`: a delete-and-re-add would cascade the source's chunks away with their embeddings, and
the next embed pass would pay for text that did not change.

Every pass writes through the live lexical index, bulk or interactive alike
(`packages/index/src/indexer.ts:171-181`). `files_fts` is an external-content FTS5 table maintained by
three triggers on `files`, and its write cost is linear rather than accumulating: probed 2026-08-12 on
node 24.19.0, six consecutive 256-op batches against a constant 10k-file store cost 6, 5, 6, 5, 5, 5 ms,
and inserting a whole store costs 20 ms at 800 files, 101 ms at 5k, and 234 ms at 10k. Beside the
thousands of embedding calls a bulk pass makes, that is not a number worth a drop/recreate bracket — and
a bracket would open a window where a crash leaves the store with no lexical index at all.

## 6. Chunking and embeddings

`chunkText` (`packages/index/src/chunking.ts:41`) returns the whole article as chunk 0 below 1,800
characters — the overwhelmingly common case, since the format is one fact per file — so the embedding is
a function of the article rather than of an arbitrary window. Longer text splits on sentence boundaries
and packs greedily; a sentence over the ceiling is hard-cut rather than dropped, so the function is
total and no text leaves the index.

`embedMissing` (`packages/index/src/indexer.ts`) requests vectors only for chunks with none or with a
vector from another model. On the update path the pending scan is scoped to the batch's own chunk ids,
so `update --embed` embeds only its own batch; a store-wide gap — from `--no-embed` runs or failed embed
calls — is closed by `rebuild --embed`, whose scan stays unscoped.

A model failure is **not fatal**: the lexical floor is a working index, and refusing to leave the vector
lane partly filled would let a throttled provider turn a complete FTS index into no index at all.

Embedding is Cohere Embed v4 at 1,024 dimensions over `invoke_model`, batched at Cohere's 96-text
ceiling (`packages/llm/src/constants.ts:7-11`, `packages/llm/src/embeddings.ts:110`), with **different
`input_type` values for documents and queries** (`packages/llm/src/embeddings.ts:11-14`) — reusing one
silently degrades every cosine.

## 7. A vector-space mismatch is a hard refusal

Never a silent reindex (`packages/index/src/indexer.ts:103-116`,
`packages/index/src/indexer.ts:241`). `index_state.embed_model` is checked before any write and before
the *first* write records a watermark, so an index built under one model can never accumulate rows under
another.

A half-migrated vector space degrades every cosine while every individual vector stays well-formed,
which is invisible in tests. That is the failure the refusal exists to make loud.

Recovering from one, and rebuilding an index in general, is an operations how-to under [Learn](/learn/).

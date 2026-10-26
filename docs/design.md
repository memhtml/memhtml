# memhtml — architecture

An agent memory store. The system of record is a git repository of semantic HTML5 files, one fact per file. Everything else is a projection of that tree or an operation on it: a SQLite index with a four-arm retrieval fold, an in-memory head that sessions write over, a head server that keeps one loaded, an MCP server, and a curation session on a branch.

Two properties hold the design together:

- **The tree is authoritative and the index is disposable.** `.memhtml/index.db` is gitignored and reproducible from `git ls-tree` (`packages/store/src/layout.ts:25`, `packages/store/src/layout.ts:84`). Anything that must survive `rm index.db` lives in a file.
- **Every corpus change is one git commit.** `git log` is the history of what the agent learned and `diff base..HEAD` is a reviewable curation run (`packages/store/src/store.ts:40-45`). The store owns staging, because a caller that staged its own files could bundle two unrelated writes into one commit. A session (§17) lands its whole log as one commit too.

## 1. Packages and dependency direction

| Package                | Role                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `contracts`            | Schemas, enums, errors, path algebra. Zero I/O.                                         |
| `domain`               | Pure math: retention, decay, RRF, MMR, graph, merge guards.                             |
| `html`                 | Parse, serialize, hash, and byte-splice the memory file format.                         |
| `store`                | Git-backed file store: write, read, correct, archive, link, commit.                     |
| `index`                | SQLite service, migrations, indexer, projection, retrieval.                             |
| `traces`               | Streaming session-JSONL parser and scanner.                                             |
| `llm`                  | Bedrock embeddings and forced-tool structured output.                                   |
| `eval`                 | Two discrimination gates: retrieval (generated corpus) and write path (labeled corpus). |
| `head`                 | One corpus version in memory, its indexes, overlays, search, and the head gate (§16).   |
| `session`              | Session logs, validation, the commit path, the checkout lock, and prune (§17).          |
| `snapshot`             | Arrow snapshots per commit and the vector cache (§20).                                  |
| `curator`              | The curator's tool loop, charters, budget, and the collapse planner (§23).              |
| `integrations`         | Host wiring for coding agents: MCP entry, hooks, instructions, receipt (§12.1).         |
| `telemetry`            | The opt-in OTLP trace exporter.                                                         |
| `apps/cli`, `apps/mcp` | The `memhtml` binary and the `memhtml-mcp` stdio server.                                |

Arrows point inward: `contracts` imports only `effect`; `domain` and `html` import `contracts`; `store` adds `html`; `index` adds `domain` and `llm`; `traces` and `eval` sit above `index`. The v2 packages follow the same rule: `snapshot` imports only `contracts`; `session` adds `domain` and `html` and works over the `HeadView` type that `contracts` defines; `head` adds `store` for its git service; and `curator` sits above `head`, `session`, and `llm`. `integrations` imports only `contracts`, and `telemetry` imports only `effect`. `apps/mcp` depends on `@memhtml/cli` rather than re-composing the service graph, so there is one answer to which database, which git root, which vector space (`apps/mcp/src/server.ts:13-18`).

`@memhtml/domain`'s purity is enforced, not documented: `packages/domain/tests/layering.test.ts` greps the emitted `dist/*.js` for a runtime import of `node:sqlite`, `@aws-sdk`, or `node:fs`. Math that needed infrastructure to test would let a caller's I/O failure surface as a scoring bug.

`AppLive` (`apps/cli/src/api-layer.ts:62-83`) wires every service. The design's one cycle is broken there: the store needs a SQL lookup to answer "does this content already exist" and `@memhtml/store` is SQL-free, so the lookup arrives as an injected function.

## 2. Store layout and path algebra

```
$MEMHTML_ROOT/                         a git repo, one global memory store
  projects/<workspace-slug>/       a workspace is a directory; there is no workspaces table
  projects/<slug>/tasks/           task files: one named segment, not a fifth bucket
  areas/<area>/  areas/arcs/  areas/inbox/
  resources/<topic>/  resources/people/<person>.html
  archive/<YYYY>/<original-path>   soft-evicted, path-preserving
  .memhtml/index.db                    gitignored, rebuildable
  .memhtml/state.db                    gitignored, NOT rebuildable from git
  .memhtml/state/access.jsonl          COMMITTED sidecar: the state plane's durability
  .memhtml/sessions/<id>.json          gitignored, one session's overlay log (§17)
  .memhtml/snapshots/<sha>.arrow       gitignored, a head snapshot per commit (§20)
  .memhtml/vectors/<model>@<dim>.arrow gitignored, the head's vector cache (§20)
  .memhtml/head.sock                   gitignored, the head server's socket (§22)
  .memhtml/checkout.lock               the checkout lock while a writer holds it (§17)
  memhtml.config.json                  COMMITTED store policy, never a record (§19)
  sitemap.xml, index.html          generated by publish, committed
```

PARA is fixed at four buckets (`packages/contracts/src/types.ts:63`). `archive` is a bucket rather than a status because the path itself records the state.

**Placement is a pure total function.** `placementFor` (`packages/contracts/src/paths.ts:148`) applies five rules in order: an explicit valid path; `arc` → `areas/arcs`; `task` → by workspace alone, _before_ the topic rule; a named workspace → `projects/<slug>`; `semantic`/`procedural`/`precedent` with a primary tag → `resources/<tag>` (a tag that slugs to `people` falls through); otherwise `areas/inbox`. No rule routes into `resources/people`: a person record is written there at an explicit path by curation, and a `person:` entity says only who a record is about. It always returns a directory rooted in a bucket, so the write path never guesses twice and never fails. `memoryPathFor` (`packages/contracts/src/paths.ts:194`) adds the filename, date-prefixing an episodic entry because time is part of its identity while every other type must be correctable in place.

**A derived path takes a collision suffix; an EXPLICIT path takes a refusal.** `freePathFor` (`packages/store/src/store.ts:432`) suffixes `-2`, then `-3`, until one is free, and a path is taken if either disk or the batch's own `claimed` set says so — without `claimed`, two ops sharing a title in one batch would both receive the unsuffixed path and the second write would silently overwrite the first. A caller-supplied valid `--path` gets no suffix and no fallback: an occupied one fails with `WriteConflict` → `ERR_WRITE_CONFLICT`, nothing written and nothing committed (`packages/store/src/store.ts:438-458`). Both alternatives are worse than a refusal here. A quiet `-2` would hand back a path the caller did not name and did not ask for, and a quiet overwrite would DELETE a memory in a corpus whose only eviction is a `git mv` into `archive/`. The conflict reports `theirSha` as the blob currently at that path with an empty `ourSha`, because this write read nothing it would have replaced. One path is exempt: `correctMemory`'s own target, which the same commit moves into the archive, so the target's path is free by the time the correction's bytes are written. The recovery an agent is handed is `memhtml read <path>` then `memhtml correct <path>` (`apps/cli/src/errors.ts:209-213`), which writes the superseding memory and archives what it replaces in one commit — the operation an overwrite would have faked.

**The archive mapping is injective and invertible.** `archivePathFor` (`packages/contracts/src/paths.ts:217`) mirrors the original path whole beneath `archive/<YYYY>/`, and `originalPathFor` (`packages/contracts/src/paths.ts:225`) strips exactly one such prefix, so it is a left inverse even for a memory archived twice. `git log --follow` reads through the move and `diff -M` reports `R100` rather than a delete plus an add. Nothing is ever deleted.

Path validation refuses `.` and `..` segments (`packages/contracts/src/paths.ts:95-100`), keeping a caller-supplied path inside the repo. A path is the id of a memory — there is no separate uuid anywhere (`packages/contracts/src/types.ts:102-107`).

`memhtml init` (`packages/store/src/layout.ts:213`) is the only path that creates the root, and it is convergent rather than merely idempotent: each step asks the repo what is already true, so it converges from an empty directory, from a live repo, and from one an interrupted run left half-staged. It re-sets `merge.ours.driver` every run (`packages/store/src/layout.ts:227`) because that config is per-clone and the `.gitattributes` a fresh clone inherits is inert without it.

## 3. The memory file format

`docs/format.md` specifies the format — element vocabulary, body structure, constraints, task files. What matters architecturally is the machine plane.

**A flat `memhtml-*` token space**, hyphenated rather than colon-prefixed, because `rel` tokens cannot hold a colon and the same convention carries to `<link rel="memhtml-supersedes">` (`packages/contracts/src/edges.ts:101-110`). Repeatable keys are repeated elements, so a one-tag correction is a one-line diff. `META_ORDER` (`packages/html/src/vocabulary.ts:48-53`) is a diff-stability contract: a new scalar meta is appended, because inserting one mid-list moves every following line in every file the next edit touches.

**Two hashes, two jobs.** `memhtml-content-hash` is `sha256` over the whitespace-normalized text of `<article>` alone, `<pre>` verbatim (`packages/html/src/hash.ts:7-19`). It is the dedup key and it is invariant under head edits by construction — which is what keeps confidence decay, access bookkeeping, and every curation stamp from looking like content changes. Without that invariance the corpus-wide decay pass would present the whole corpus as new content and dedup would collapse. The git blob sha of the whole file is the indexer's change key, a separate thing.

**Head edits go through byte-splice editors, never parse-then-serialize** — `setMeta` (`packages/html/src/editors.ts:155`), `addLink` (`packages/html/src/editors.ts:226`), `readMeta` (`packages/html/src/editors.ts:292`). A serializer round trip re-serializes the article, so a bookkeeping pass would read as a content change in `git diff` and could move the content hash (`packages/html/src/editors.ts:10-19`).

**The render gate.** `renderTemplate` (`packages/html/src/template.ts:209`) places the `<mark>` claim itself, so the ordinary write path cannot violate the claim-leads-the-article constraint — but `articleHtml` passes a caller's markup through verbatim (`packages/html/src/template.ts:125-128`). So the store runs `checkMemory` (`packages/html/src/parse.ts:417`) over the rendered bytes and refuses before anything is written (`packages/store/src/store.ts:671-682`). Without the gate a bad file lands in a commit and the indexer then declines to project it: present in the tree, absent from every search, visible only as a log line.

## 4. Edge encoding

**Authored edges live in the HTML; derived edges live only in the index.** An agent asserting "this supersedes that" is authorship — small, reviewable in a diff, and exactly what git is for. A machine-mined `relates_to` at cosine 0.87 is a re-derivable function of the corpus and the embedder; committing thousands would bury every real diff in machine noise for zero recoverable information.

The `derived` column is the firewall: the retention `contestedStatus` signal counts only authored (`derived = 0`) contradictions (`packages/contracts/src/edges.ts:122-128`, `packages/domain/src/retention.ts:164-166`), so an uncorroborated machine suspicion can never evict a memory. The one fact that does not survive a rebuild — the corroboration counter — lives in the state plane (`packages/index/state-migrations/S0001_access.sql:39-48`), and nothing writes it, so every contradiction the signal counts is an authored one carried in a file.

**Four non-mixing edge classes** (`packages/contracts/src/edges.ts:9`): nine memory rels, two person, one provenance, two task. The class is _derived_ from the rel (`packages/contracts/src/edges.ts:70`) rather than carried alongside it, so the two cannot disagree. SQL CHECKs pair each class with its vocabulary (`packages/index/migrations/0008_tasks.sql:194-199`) and every memory-graph query filters `edge_class = 'memory'`, so a person or task edge is structurally incapable of entering PageRank, MMR, or the retention bridge count.

SQL cannot enforce the _type_ of the files at either end, so the store refuses an edge whose class disagrees with its endpoints (`packages/store/src/store.ts:1263-1311`). Both directions are refusals with distinct failure modes: a memory rel with a task endpoint would let a to-do list reweight the retention of knowledge; a task rel with a memory endpoint claims a memory `blocks` something nothing can close.

`href` values are repo-root-relative with a leading slash — a document-reference form converted at the HTML boundary and never stored (`packages/index/src/project.ts:341-347`). Root-relative survives a `git mv` of the source, is greppable as a fixed string, and resolves without knowing the referrer's depth.

There is deliberately **no foreign key on `edges.src_path`/`dst_path`**: a `<link>` may name a file the indexer has not reached, or an archived path, and a hard FK would make indexing order-dependent (`packages/index/src/indexer.ts:754-757`). Dangling hrefs are found by `memhtml doctor` and repaired in a commit by `memhtml doctor --fix` (`apps/cli/src/repair.ts`).

## 5. The write path

**Singular write** (`packages/store/src/store.ts:722`): render through the gate, hash, ask the dedupe question, claim a free path, write, stage, commit. The order _is_ the mechanism — a duplicate leaves the tree byte-identical with nothing for the next `git status` to report, whereas a write-then-check order would need a rollback, and rolling back a git operation is a second failure mode.

**Content-hash dedup is enforced twice.** The write path asks an injected `dedupeLookup` (`packages/store/src/store.ts:734`, wired to `activePathForHash` at `packages/index/src/traces-persist.ts:196`) and returns the existing path with `deduped: true`, creating no file and no commit. Structurally a partial unique index refuses it anyway: `… ON files (content_hash) WHERE archived = 0 AND memory_type <> 'task'` (`packages/index/migrations/0008_tasks.sql:126-127`). The lookup carries the same `task` exclusion as the index, so the question and the answer agree by construction rather than by discipline.

**Tasks are carved out of dedup in both directions** (`packages/store/src/store.ts:350-374`). Two open tasks with identical bodies are two real work items; and a memory whose article matches a task's must not be deduped onto that task, or the caller is handed a task's path as the home of its fact. One predicate, not a `memoryType !== "task"` test at each of the three places the batch touches its hash map.

**Batch write is ONE commit and ONE reindex** (`packages/store/src/store.ts:908`, `apps/cli/src/operations.ts:746`) — the whole reason the primitive exists rather than being a loop at the caller, since N singular writes are N commits and, because the indexer diffs per commit, N index passes. The reindex goes through `update()` over the whole COMMIT rather than a caller-supplied path list (`apps/cli/src/operations.ts:248-266`), because only a diff can express a rename — every correction and every archive is a `git mv`, and `update()` reads `diff --name-status -M`, sees the `R`, and re-points the row, keeping the embedding, where indexing the destination alone would leave the source row live and duplicate the chunk rows the move exists to preserve — and only `update()` records `index_state.head_sha`, without which `memhtml status` reports `index_fresh: false` forever. It is gated on a file having been written: moving the watermark for a commit that never happened is the bug that guard avoids.

Atomicity comes from a two-phase fold. Phase 1 validates every op and writes nothing (`packages/store/src/store.ts:937-960`), so an atomic abort has nothing to roll back. The failed op is reported with its own code and every other op reports `skipped: true`, **including ones that already validated** (`packages/store/src/store.ts:962-980`) — reporting a validated-but-unwritten op as `ok` with a path would hand the caller a path with no file behind it. Phase 2 writes, stages, and commits once; a failure there triggers `restore` (`packages/store/src/store.ts:534`), which uses `git reset -- <paths>` rather than `git rm --cached` because `rm --cached` exits 128 as soon as one listed path was never staged — precisely the state a partly-failed `git.add` leaves.

The batch's dedupe oracle consults **itself first, then the store** (`packages/store/src/store.ts:825-859`), because the store's lookup reads the index, which does not yet know about anything this batch wrote. A `claimed` set does the same job for path collisions (`packages/store/src/store.ts:418-422`) — without it two ops sharing a title would both be handed the unsuffixed path and the second write would silently overwrite the first. One instant is read for the whole batch (`packages/store/src/store.ts:914-921`), or two episodic ops written either side of midnight would get different date prefixes and one indivisible operation's stamps would disagree about when it happened.

**The conflict assist is propose-only, and that is a decision rather than a v1 limitation** (`apps/cli/src/operations.ts:494`, AC-1-2). With `detect_conflicts` on, each op's claim is keyed by `frameKeyOf` (`packages/domain/src/frame.ts`, the eval harness's measured port) and matched against ACTIVE non-task memories plus the batch's own earlier ops; a match surfaces as a per-op `conflict` naming the other claim and where it lives. **Nothing about the write changes.** No auto-archive, no last-wins, no refusal — because sometimes the contradiction IS the answer: a memory recording that a runbook step changed necessarily contradicts the memory stating the old step, and a resolver would destroy the pair a later reader needs in order to see the change at all. The caller decides: keep both, `memory_correct` the match, or skip.

Three properties fall out of that, and each matters. **The assist is structurally unable to block a write** — `detectFrameConflicts` returns `Effect<…, never>` and swallows a lookup failure into an empty map with a logged warning, mirroring `bumpAccess` and `recordLink`, so a broken index degrades the report and never the commit. **The degradation is partial rather than total**: only the store half needs the database, so the intra-batch fold keeps answering when the query cannot. And **ONE query per batch, never one per op** — `activeFramesFor` takes an array precisely so a caller cannot loop (`packages/index/src/traces-persist.ts:112`), which is the quadratic-write-cost lesson expressed as a signature.

Two asymmetries in the fold are deliberate. A store match **outranks** an earlier op in the same batch, because a stored memory is a fact already in the corpus while the earlier op is one this call is about to create — and `memory_correct`, the usual action, needs a path that exists. And only the LATER op reports: op 3 matching op 1 tells a caller it is about to restate itself, which is actionable with op 3 in hand, while reporting it on op 1 too would name a conflict with something that did not exist when op 1 was written and would double one finding into two. The map records the FIRST claimant of a slot, so a chain of restatements all point at the claim that has to be reconciled rather than each one step back.

The `article_html` path reports nothing, and the boundary is stated in the tool description and the guide rather than hidden. On that path `claim` is `""` by construction — the `<mark>` inside the caller's markup is the claim and the parser extracts it on the first index pass — so `frameKeyOf` has nothing to key. Deriving one at the ops layer would mean parsing every op's article before the store renders it, a second parse of the same bytes and a second place the gist rule could drift from `parse.ts`.

`summary` deliberately does not count conflicts. Its five numbers partition the ops exactly, and a conflict is not an outcome — the op wrote. A v2 field is possible; a sixth number a client cannot reconcile with the other five is not.

**The near-duplicate assist is the conflict assist's vector sibling** (`apps/cli/src/operations.ts`, `detectNearDuplicates`; NEAR-1..5; issue #103). The frame rule refuses to key a rewording and the content hash cannot see one, so `detect_near_duplicates` reports what an op's text embedding-matches at or above `NEAR_DUPLICATE_THRESHOLD` (0.92, the near-duplicate floor in `@memhtml/domain`) as a per-op `near_duplicates` list carrying the other claim, the measured similarity, and the conflict field's own `path`/`batch_index` split. The op has no stored embedding at write time, so the assist embeds the whole batch in ONE call through the DOCUMENT port — never `embedQuery`, because Cohere embeds documents and queries into different regions of the space and this comparison is document-vs-document — and ranks against every active non-task, non-arc first-chunk vector in ONE corpus read (`activeNearestFor`, `packages/index/src/traces-persist.ts`), decoded once in TypeScript for issue #40's reason (`packages/index/src/database.ts:39-43`). Propose-only with the same fold asymmetries, and one deliberate difference in how it degrades: TOTALLY, and REPORTED. An absent document embedder (`MEMHTML_EMBED=off`), a failed embed call, and a failed corpus read each yield `near_duplicates_degraded: true` with every finding null — including the intra-batch half the vectors in hand could still answer — because the flag is published as "null means unchecked" and a half-checked batch under it would be false exactly where a caller must trust it. An embedding assist has a standing way to be OFF that a SQL lookup does not, which is why this assist reports its degradation where the frame assist only logs.

**Correction** (`packages/store/src/store.ts:1045`) reads the target first, or the tree gains an orphan superseding file with nothing to supersede. Its `memhtml-supersedes` points at the target's _archive_ path, where the file lives only after this commit lands; pointing at the pre-archive path would create a dangling href in the same commit that made it dangle. Both files land in one commit.

**Archive** (`packages/store/src/store.ts:1146`) is `git mv` plus stamps. `stageArchive` (`packages/store/src/store.ts:584`) creates the destination's parent first, because `git mv` refuses a destination whose parent does not exist and the year partition is new every January.

**These are the v1 doors, and the store's policy decides when they're open.** `write`, `apply`, `correct`, and `task add`, with the MCP tools `memory_write`, `memory_write_batch`, and `memory_correct`, create a record with no write bar (`apps/cli/src/doors.ts`). The store's `v1Doors` key closes them inside a run session or everywhere (§19), and a session is the write path that's held to the bar (§17). Every v1 write runs inside `StoreShape.exclusive` (`packages/store/src/store.ts:236`), which takes the store's in-process permit and then the repository's checkout lock while it stages and commits, so a v1 write and a session commit never interleave in one checkout.

**Provenance is recorded in both planes.** The writer stamps `memhtml-session`/`memhtml-prompt`/`memhtml-turn` into the head and attaches `Memhtml-Session`/`Memhtml-Prompt` commit trailers (`packages/store/src/plumbing.ts:400-425`); the operations layer records a `memory_session_links` row with its `link_kind` — `wrote` (`apps/cli/src/operations.ts:351`), `read` (`apps/cli/src/operations.ts:972`), or `corrected` (`apps/cli/src/operations.ts:1088`). File-borne provenance survives a rebuild; the row is queryable both directions.

## 6. The index

Two databases on one connection. `.memhtml/state.db` is ATTACHed as `state` (`packages/index/src/database.ts:286`) so the salience arm can `LEFT JOIN state.access` in the same statement as `main.files` with no application-side join; attaching is not idempotent, so it happens once per connection in `makeDatabase` (`packages/index/src/database.ts:311`). Each plane keeps its own migration ledger (`packages/index/src/database.ts:197-200`, `packages/index/src/schema-const.ts:13-18`), because rebuilding `index.db` must not mark the state plane's migrations unapplied.

Both planes are plain SQLite through node's built-in `node:sqlite`, so there is no third-party database dependency and no driver feature flags to keep in step — `sqlite3` or a GUI browser opens either file directly. Every connection sets `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, and `foreign_keys = ON`, and registers one SQL function, `vector_distance_cos` (`packages/index/src/database.ts:45-51`, `packages/index/src/database.ts:327-346`). That function is `@memhtml/domain`'s `cosineDistance` rather than a second implementation, so the vector arm's SQL and the MMR pass cannot disagree about a clamp or a zero-magnitude vector. Migrations apply in filename order, each file's statements and its ledger row committing in ONE transaction (`packages/index/src/database.ts:207`), so a crash never leaves one half-applied.

### 6.1 Schema

`files` (`packages/index/migrations/0008_tasks.sql:30`) projects one memory file: identity, classification under a ten-value `memory_type` CHECK, three text surfaces, the scoring inputs, the bitemporal fields, provenance, and two task columns. Child tables (`packages/index/migrations/0001_files.sql:73-111`) each declare **`ON UPDATE CASCADE` as well as `ON DELETE CASCADE`**, because `files.path` is the primary key _and_ it moves — eviction is a `git mv` — and foreign keys are immediate, so without it the rename's `UPDATE` fails outright.

Three text columns, three jobs:

- `body_text` — the full search surface.
- `fts_text` — title, gist, and body newline-joined (`packages/index/src/project.ts:48`). One denormalized column, because a multi-column FTS index on this driver returns rowid order rather than relevance order and scopes MATCH to the named column alone (`packages/index/src/project.ts:41-47`). Newline- rather than space-joined, so a term ending the title cannot fuse with one starting the gist into a phrase neither states.
- `disclosure_text` — what recall may _quote_, as opposed to what it may search (`packages/index/src/project.ts:51-83`): the `<mark>` claim, `<summary>` headlines, `<dl>` facets, citations. `<details>` bodies never appear (Tier 3 provenance reaches an agent only through `memory_read`), and neither do `<aside>` texts, because an aside is a scope caveat and a disclosure line has no room to say "this is the exception". Composed from the parser's separated extraction fields rather than re-derived from markup.

`chunks` and `embeddings` key on `content_hash`, not `path`: `chunk_id = sha256(content_hash + ":" + ordinal)` (`packages/index/src/chunking.ts:27`), so an identical body anywhere in the tree shares one chunk row and one vector and a `git mv` costs zero Bedrock calls. `edges` (`packages/index/migrations/0008_tasks.sql:173`) carries the four classes, the `derived` firewall, a strength, a provenance, and CHECKs refusing a cross-class rel, a self-loop, and `derived = 1` outside `provenance = 'sleep'`. `index_state` (`packages/index/migrations/0007_watermark.sql:5`) is a single-row table by CHECK holding the watermark and the vector-space identity. The state plane (`packages/index/state-migrations/S0001_access.sql`) holds `access` and `edge_corroboration`; its DDL names its own schema and puts that name on the INDEX rather than the table, which is the form this driver accepts.

Migration `0008_tasks.sql` widens both CHECK-bearing tables by recreate-and-copy, and its load-bearing detail is that it **snapshots every child table first** (`packages/index/migrations/0008_tasks.sql:87-94`). `DROP TABLE files` cascades away every row of every child — including `embeddings` behind `chunks` — inside the same transaction the runner wraps the file in, so a migration that copied only `files` would report success and silently destroy every embedding in the database. The snapshot does not depend on foreign-key state at all: children are copied out, the cascade fires against a table of no consequence, and the rows are copied back under the new parent.

### 6.2 Projection

`projectFile` (`packages/index/src/project.ts:141`) is pure: given a doc, a path, and a blob sha the row set is fully determined, which makes "a fresh rebuild reproduces the incremental row set" true by construction rather than by two implementations agreeing.

`archived` is read from the path's PARA bucket, not `memhtml-status` (`packages/index/src/project.ts:133-140`) — the path _is_ the state, so a file whose head says `active` while sitting under `archive/` is stale metadata, and trusting the meta would let a mis-stamped file re-enter retrieval and break the dedup index's guarantee.

Four narrow write rules, each avoiding a specific loss:

- The `files` write is an **upsert on `path`** (`packages/index/src/project.ts:204-214`), so one statement serves a rebuild into an emptied table and an in-place rewrite. Rewriting in place preserves the row's chunks; deleting and re-inserting would cascade them away with their embeddings. A `content_hash` collision against a _different_ active path is deliberately not absorbed — that is the structural dedup.
- Chunk deletion is narrowed to `content_hash <> ?` (`packages/index/src/project.ts:232-235`), because a blanket delete would re-embed the whole file on any meta-only edit.
- Edges are cleared by `src_path` only (`packages/index/src/project.ts:236-241`), because an inbound edge is another file's authored assertion.
- `FILE_COLUMNS` (`packages/index/src/project.ts:93`) drives the insert, the placeholder count, and the upsert's assignment clause from one list, since a column added to one and forgotten in another binds every subsequent value to the wrong column while every CHECK still passes.

Entity rows come from three sources (`packages/index/src/project.ts:321`): `memhtml-entity` metas, one `concept:<term>` per `<dfn>`, one `lang:<value>` per `<code data-lang>` — so a memory that _defines_ a term is findable by it without the author restating it as a meta. Row deduplication happens in TypeScript (`packages/index/src/project.ts:379-387`) rather than in the database, because these rows go in through `writeAll` as one atomic batch and a duplicate facet would fail the primary key and roll back every other row, taking the whole rebuild down over one repeated `<dt>`/`<dd>` pair.

### 6.3 Rebuild and incremental update

Both paths call `projectFile`, which is the reproducibility contract (`packages/index/src/indexer.ts:18-24`).

**Rebuild** (`packages/index/src/indexer.ts:618`): `rev-parse HEAD`, one `ls-tree -r` over the four PARA prefixes, one `cat-file --batch` for the whole corpus — one subprocess for the tree instead of N `readFile` calls, working on a bare or detached checkout. Generated `index.html` and `sitemap.xml` are excluded by name (`packages/index/src/indexer.ts:233-240`): indexing them would feed every directory listing back into retrieval as a memory whose body is the titles of other memories, so the corpus would rank its own table of contents above its content.

A rebuild doesn't drop and recreate the FTS index. The truncate's `DELETE FROM files` unindexes every row through the delete trigger, and the projection's inserts index every new one through the insert trigger (`packages/index/src/indexer.ts:643-649`, `packages/index/src/schema-const.ts:23-30`). Tables empty children-first (`packages/index/src/schema-const.ts:47-60`) so the statements are correct with foreign keys enforced rather than relying on cascade. A parse failure is a counted skip (`packages/index/src/indexer.ts:300-317`): one bad hand-authored file must be reported by `memhtml doctor`, not stop the indexing of every other file in the tree.

**Update** (`packages/index/src/indexer.ts:808`) reads `index_state.head_sha` as its watermark; an absent watermark falls through to a full rebuild rather than diffing against nothing (`packages/index/src/indexer.ts:814-834`). Otherwise it takes `git diff --name-status -M` from the watermark to HEAD plus `git status --porcelain=v2` for uncommitted edits — the ordinary agent flow, where the agent edited with a text tool and has not committed. Committed changes apply first and the working tree second (`packages/index/src/indexer.ts:909-913`), so a path that both moved in a commit and was then edited uncommitted ends at the working tree's content by _ordering_ rather than by a precedence rule that could disagree.

Every committed diff target's blob is fetched in **two subprocesses, not two per file** (`packages/index/src/indexer.ts:860-887`): a per-file `lsTreeR(ref, [path])` walks the whole tree to answer one path, so N writes cost 2N tree walks — the store-scaled per-op term that makes bulk ingest quadratic. One full-tree walk costs the same as one single-path walk, so batching is strictly cheaper from the second changed file on.

A rename is `movePath` (`packages/index/src/indexer.ts:772`) — an `UPDATE`, never a delete plus an insert. `ON UPDATE CASCADE` carries tags, entities, facets, citations, and chunks along; the `edges` row updates explicitly because it holds no foreign key. This is the whole reason `chunks` keys on `content_hash`: a delete-and-re-add would cascade the source's chunks away with their embeddings, and the next embed pass would pay Bedrock again for text that did not change.

Every pass writes through the live lexical index, bulk or interactive alike (`packages/index/src/indexer.ts:288-298`). `files_fts` is an external-content FTS5 table maintained by three triggers on `files`, and its write cost is linear rather than accumulating: probed 2026-08-12 on node 24.19.0, six consecutive 256-op batches against a constant 10k-file store cost 6, 5, 6, 5, 5, 5 ms, and inserting a whole store costs 20 ms at 800 files, 101 ms at 5k, and 234 ms at 10k. Beside the thousands of Bedrock embedding calls a bulk pass makes, that is not a number worth a drop/recreate bracket — and a bracket would open a window where a crash leaves the store with no lexical index at all.

### 6.4 Chunking and embeddings

`chunkText` (`packages/index/src/chunking.ts:41`) returns the whole article as chunk 0 below 1,800 characters — the overwhelmingly common case, since the format is one fact per file — so the embedding is a function of the article rather than of an arbitrary window. Longer text splits on sentence boundaries and packs greedily; a sentence over the ceiling is hard-cut rather than dropped, so the function is total and no text leaves the index.

`embedMissing` (`packages/index/src/indexer.ts`) requests vectors only for chunks with none or with a vector from another model. On the update path the pending scan is scoped to the batch's own chunk ids (the unscoped scan was the last store-scaled per-batch cost), so `update --embed` embeds only its own batch; a store-wide gap, from `--no-embed` runs or failed embed calls, is closed by `memhtml index embed` (the bare `embedMissing()`: unscoped, vectors only, safe to rerun, reporting `embeddingsRemaining`); `rebuild --embed` runs the same unscoped scan after reprojecting. A rebuild in either mode keeps the vectors whose content-addressed chunk id survives it: `truncateForRebuild` stashes the configured space's `embeddings` rows in a temp table and restores them after the projections land, so only a model change empties the vector plane, and `rebuild --no-embed` over a store that carries vectors is refused with `ERR_REBUILD_NO_EMBED_REFUSED` unless `--force` is given. A model failure is **not fatal**: the lexical floor is a working index, and refusing to leave the vector lane partly filled would let a throttled Bedrock turn a complete FTS index into no index at all. Embedding is Cohere Embed v4 at 1,024 dimensions over `invoke_model`, batched at Cohere's 96-text ceiling (`packages/llm/src/constants.ts:7-11`, `packages/llm/src/embeddings.ts:34`), with **different `input_type` values for documents and queries** (`packages/llm/src/embeddings.ts:11-14`) — reusing one silently degrades every cosine.

**A vector-space mismatch is a hard refusal, never a silent reindex** (`EmbedModelMismatch` and `guardEmbedModel` in `packages/index/src/indexer.ts`). `index_state.embed_model` is checked before any write and before the _first_ write records a watermark, so an index built under one model can never accumulate rows under another. A half-migrated vector space degrades every cosine while every individual vector stays well-formed, which is invisible in tests.

## 7. Retrieval

`search` and `recall` sit on the same fused SQL and the same MMR pass (`packages/index/src/retrieval.ts:30-37`), so a ranking change cannot apply to one and not the other.

**Arms are data** — a registry folded over by `buildRrfSql` (`packages/index/src/retrieval-sql.ts:268`, `packages/index/src/retrieval-sql.ts:307`) — so adding a fifth is a table entry and dropping one is a filter. Each returns exactly `(path, rank)`, 1-based.

| Arm        | Weight | Needs        | Rank source                                                             |
| ---------- | ------ | ------------ | ----------------------------------------------------------------------- |
| `fts`      | 1.0    | query terms  | `ROW_NUMBER() OVER ()` over a `LIMIT`ed MATCH subquery                  |
| `vector`   | 1.0    | query vector | `ROW_NUMBER() OVER (ORDER BY dist)` over `min(cos)` grouped by path     |
| `recency`  | 0.5    | —            | `coalesce(event_at, updated_at) DESC, path ASC`                         |
| `salience` | 0.4    | state plane  | three terms over `state.access`, DESC — no task, no `resources/people/` |

- **fts** (`packages/index/src/retrieval-sql.ts:124`). The `LIMIT`ed subquery orders by `bm25()`, which FTS5 reports as a negative number where more negative is more relevant, so ascending order puts the best match first. `ROW_NUMBER() OVER ()` sits _outside_ that subquery, or it would number the pre-limit scan.
- **vector** (`packages/index/src/retrieval-sql.ts:164`). Exact brute force. `GROUP BY c.path` with `min(distance)` collapses a file to its best chunk — without it a three-chunk file contributes three ranks, consumes three slots of the arm's budget, and has three reciprocal-rank contributions summed, so being long would outrank being relevant.
- **recency** (`packages/index/src/retrieval-sql.ts:188`). Event time first, so an episodic memory sorts by when the incident happened rather than by when someone wrote it down.
- **salience** (`packages/index/src/retrieval-sql.ts:246`). `exp(-0.01·hours)` + `ln(1 + access_count)` + `max(outcome_score, 0.0)`, read over the ATTACH. The clamp is the negative-outcome guard: no boost, but no penalty either — the retention scorer owns punishment, and double-counting it here would let one bad outcome bury a memory that is still the best answer.

  **Two exclusions, and they are this arm's alone.** A `task` row and anything under `resources/people/` emit no salience row at all (`SALIENCE_EXCLUDED_TYPE`, `SALIENCE_EXCLUDED_PREFIX`). Salience ranks interchangeable candidates; a task is reached by `task_status`/`due_at` and salience there would reward STALENESS — the stuck task re-read at every triage outranking the fresh urgent one — while a person-reference record is reached by entity key and decay is wrong for identity, since a colleague unmentioned for six months is not less themselves. Memories _about_ a person live outside `resources/people/` and keep their salience, which is the signal that answers "which five of fifty entries about this person do we actually consult". A path prefix rather than a type because there is no `person` memory type — a person file is a `semantic` record curation writes there at an explicit path. The predicates sit INSIDE the arm and never in the shared `fileFilter` (`packages/index/src/retrieval-sql.ts:234-240`): an excluded row still earns its FTS, vector, and recency ranks, so the arm has no opinion rather than the query being narrowed.

Fusion is one statement: each active arm a CTE, weighted `1/(rank + 60)` contributions `UNION ALL`ed, then summed per path (`packages/index/src/retrieval-sql.ts:311-318`, `packages/domain/src/ranking.ts:8`). Ties break on `path ASC`, so the ordering is total and two runs over an unchanged corpus produce the same list — what the discrimination gate compares against. `buildRrfSql` returns `undefined` when no arm is active, so a caller must treat that as an empty result rather than assemble `SELECT … FROM ()`. The pure arithmetic has a twin in `@memhtml/domain` (`packages/domain/src/rrf.ts:39`), so a weight change is testable without a database.

**Numbered placeholders and degraded mode.** The prefix is fixed at four positions (`packages/index/src/retrieval-sql.ts:24-27`): `?1` query text, `?2` per-arm limit, `?3` final limit, `?4` query vector. Scope values bind from `?5` up (`packages/index/src/scope.ts:239`), and the caller **always** builds a four-value prefix with `null` at `?4` even when the assembled SQL references no `?4` (`packages/index/src/retrieval.ts:322-329`). That is what keeps scope values at fixed positions whether or not the vector arm fired — with positional `?` the numbering would shift and every remaining arm would silently read the wrong parameter. `rrfParams` then trims only the slots past the highest `?N` the statement names, because SQLite rejects a value bound at a position no `?N` mentions (`packages/index/src/retrieval-sql.ts:33-63`). Weights are inlined as literals: trusted configuration, and inlining keeps the tuple stable at four regardless of how many arms fire.

Degradation is a filter, not an error path. `activeArms` (`packages/index/src/retrieval-sql.ts:288`) drops any arm whose `needsEmbedding`, `needsState`, or `needsQueryTerms` precondition is unmet; an embedder failure is caught, logged, and turned into `undefined` (`packages/index/src/retrieval.ts:259-280`), so retrieval never errors because Bedrock is down — it gets narrower, and `degraded` says so on the response.

`needsQueryTerms` exists because several forms an agent writes are **hard driver errors rather than empty results**: an apostrophe, a colon (the system's own entity notation), a leading hyphen, a bare boolean operator (`packages/index/src/fts-query.ts:4-15`). `sanitizeFtsQuery` (`packages/index/src/fts-query.ts:73`) reduces a query to runs of Unicode letters and digits and returns `""` when nothing survives, and the arm then leaves the fold. Dropping rather than escaping is deliberate: `query` is prose, not a query language, and supporting negation would mean an agent invokes it accidentally by writing a hyphenated word. `\p{L}\p{N}` rather than `[a-z0-9]` keeps `déployé` one token. The terms reach MATCH in one of two forms `ftsQueryForms` builds (`packages/index/src/fts-query.ts:99`), joined with `AND` or with `OR`, a double-quoted span kept as one phrase in either; the arm binds the all-terms form when a one-row probe through the caller's scope finds a file holding every term and the any-of form otherwise (`packages/index/src/retrieval.ts:354-358`). FTS5 reads space-separated terms as AND, so a sentence that is not a verbatim quote of stored text matches nothing under that form alone and the arm contributes nothing to the fold; the any-of form lets one stored word find its file. The all-terms form is kept where it answers because RRF's flat `1/(rank + 60)` lets 40 any-of candidates hand the decision to recency and salience (corpus MRR 1.0 against 0.28 on the gate's fixture).

**Scoping** is assembled **once** and every arm receives the same string, differing only in the alias its `files` row goes by via a `{alias}` token (`packages/index/src/scope.ts:230-231`); per-arm filters would let a scope apply to three arms and not the fourth, a leak no type catches. Defaults exclude archived files and `memory_type <> 'task'` (`packages/index/src/scope.ts:260-280`), because a corpus with fifty open to-do items would put fifty of them in front of every recall, crowding out the knowledge an agent asked for with a list it can read by `ls`-ing a directory. A caller-named type list is honored verbatim, `task` included — filtering it back out would make the opt-in unreachable, so this is a default and not a firewall. That default is inlined rather than bound, because binding it would consume a placeholder number and shift every scope parameter below it. Workspace is **strict equality**: an unplaced memory is not "in every workspace", and returning it would make a project-scoped recall quietly global.

The `entity` scope is **one** reference in `type:name` form, and the predicate REBUILDS that form from `file_entities`' two columns rather than making the caller know where the split falls (`packages/index/src/scope.ts:298-313`). It is `EXISTS` rather than a `JOIN`, matching the tag predicate: a file carrying one name under two types would multiply its rows through a join, and a duplicated row inside an arm's `LIMIT` spends the candidate budget on one file. Singular where `tags` is a list, and the asymmetry is the point — the scope exists so a caller can chain a hop off a hit's own `entities` list, which is one reference at a time, so a list would raise the question of whether it broadens or narrows before anyone has asked for either. A scope matching nothing returns no hits and says so through `scope_empty` rather than widening.

**The pointer behind an empty scope.** When `scopeEmpty` is true, `archivedInScope` (`packages/index/src/retrieval.ts`) re-runs the same assembled scope with the archived flag flipped and reports `archivedMatches` (a count) and `archived` (up to `limit` paths with what superseded each, from the `supersedes` edge). A correction, an archive, and a collapse fold each `git mv` a record into `archive/`, and the default scope excludes it, so a correct facet over a moved record otherwise reads as never written (issue #130). Zero shape (`0`, `[]`) whenever `scopeEmpty` is false.

**MMR.** `search` fetches `limit × 3` fused candidates (`packages/index/src/retrieval.ts:49-53`), because diversification can only reorder what it was given. `applyMmr` (`packages/domain/src/mmr.ts:36`) is greedy `λ·relevance − (1−λ)·max_sim_to_selected` at λ = 0.5. Fusion _rank_ stands in for relevance (`packages/index/src/retrieval.ts:519-529`): RRF scores are rank-derived and incomparable across queries, so a monotone substitute is the honest input — MMR needs only the order to be right. A vectorless candidate takes penalty 0, the honest reading of unknown similarity, so vectorless candidates keep their relative fusion order rather than being shuffled by a fabricated distance. At λ ≥ 1 the function short-circuits rather than burning O(n²) cosines to reproduce the order it was given.

**Polarity.** Between fusion and MMR, `polarityScored` (`packages/index/src/polarity.ts`) demotes the negation-flipped twin of a better-agreeing candidate: a candidate whose claim disagrees with the query's polarity (`negationDivergent`, the gate's own marker set) AND has an agreeing near-copy in the pool (cosine ≥ `TWIN_COSINE` = 0.9) is clamped below that copy and scaled by `POLARITY_DEMOTION` = 0.5, and a twin already below every agreeing copy is left alone. Narrow on purpose: a lone negated fact with no affirmative twin is untouched. What it does read is the query's phrasing as the wanted polarity, so a live contradiction pair ranks the half matching the question first (resolved contradictions are archived by `correct` and never reach it), and the veto's outcome words (`without`, `fail`, `avoid`) count as negation on the query side; both are pinned in `packages/index/tests/polarity.test.ts`. `search` and `recall` both apply it. Measured live 2026-09-04: 36/36 probes discriminated at MRR 1.0, zero inversions (issue #132).

Each hit carries a `snippet`: its best-matching chunk for this query, capped at 700 characters with a `…` that fits _inside_ the ceiling (`packages/index/src/retrieval-sql.ts:359-365`). It is one statement over the final paths only — after MMR, not after fusion — so the fused CTE never changes shape (`packages/index/src/retrieval.ts:541-548`). A NULL distance loses to any scored chunk and ordinal breaks ties, so the winner is deterministic (`packages/index/src/retrieval.ts:674-689`).

**The disclosure fold.** `recall` returns a budgeted pack whose three tiers map onto the HTML structure rather than onto a truncation of prose (`packages/index/src/disclosure.ts:1-17`). `foldDisclosure` (`packages/index/src/disclosure.ts:93`) spends the budget in rank order and **continues past a candidate that does not fit**, turning it into an index line: the budget is a character budget and not a position cut-off, so one long memory mid-list does not silently truncate every shorter one after it. `MAX_PER_ENTITY = 2` caps full quotes per **entity name**, not per path (`packages/index/src/disclosure.ts:25-32`) — per-path would be no cap at all, since twelve memories about one service are twelve paths. A capped memory still gets its index line, so the cap narrows depth rather than dropping the memory. Arcs fold under their **own** 9,000-character envelope rather than competing with memories' 16,000 (`packages/index/src/retrieval.ts:629-642`): an arc is a synthesis of many memories, so letting the two compete would make one arc crowd out every concrete memory behind it, and the pack would explain the pattern while citing none of the evidence.

**Reinforcement.** `reinforce` (`packages/index/src/reinforce.ts:69`) is the **one** call site that moves `state.access`, because the cooldown is the invariant: `access_count` feeds the salience arm, so a second writer would let a loop in an agent replay one query and rewrite the corpus's ranking, and a cooldown enforced in two places is enforced in neither. The guard is expressed twice by necessity — as the SQL `WHERE` and as a pure twin — so the shared source of truth is `REINFORCE_COOLDOWN_S = 900` (`packages/domain/src/ranking.ts:24`) and a property test pins the two at the boundary. The conditional upsert's `RETURNING` makes the bumped/cooled split authoritative rather than inferred (`packages/index/src/reinforce.ts:51-54`): reading `last_accessed_at` first and deciding in TypeScript would race a concurrent reinforce and report a bump that never happened. Only a non-neutral signal moves `reinforcement_count` and the outcome EWMA — being read is evidence of relevance, not of correctness.

**What bumps, and what deliberately does not.** Salience accumulates evidence that someone _chose_ a memory, so the read tiers get three different policies:

| Read                                                                                     | Bumps                                  | Why                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_read` / `memhtml read` of a named path, and the `memhtml://file/{path}` resource | yes                                    | the caller chose THAT memory — the strongest signal short of a write (`apps/cli/src/operations.ts:968`)                                        |
| a path merely _returned_ by `memory_search` / `memory_recall`                            | no                                     | the ranker's own guess (`apps/cli/src/operations.ts:994`, `:1011`)                                                                             |
| every curation pass                                                                      | no                                     | a sweep touching the whole corpus converges everything to uniform salience, which is no salience, and curation bypasses the tool path entirely |
| `memory_reinforce` with a named signal                                                   | yes, and it moves the outcome EWMA too | the caller is asserting the memory was right or wrong                                                                                          |

Bumping on a hit is what builds the rich-get-richer loop: today's top five rank higher tomorrow purely for having been listed, while the memory that should displace them never appears and so never earns a first bump. The cooldown does not save it — 900 seconds bounds one query replayed inside a session, and the drift operates across days. Reading files off disk (docs/code-mode.md) touches no access row and so obeys the same rule for free rather than as an exception.

## 8. The state plane and its committed sidecar

Access counts, reinforcement counts, and the outcome EWMA are the only state git cannot reproduce, and they are high-churn: a commit per access bump would be a commit per memory an agent opens. So `state.db` is gitignored and its durability story is an append-only JSONL sidecar written by `memhtml state export` (`packages/store/src/layout.ts:27-31`, `packages/index/src/sidecar.ts`).

The sidecar is **byte-stable or it commits nothing**: rows arrive path-ordered from SQL, floats round to four decimals, keys are written in fixed order, and an unchanged plane produces an identical file whose commit is empty (`packages/index/src/sidecar.ts`). Four decimals is the grid the outcome EWMA lives on (`packages/domain/src/decay.ts:20`), so a fifth digit would be float noise that changes the file's bytes without changing its meaning; `-0` normalizes to `0` so two equal planes render identically. `parseSidecar` (`packages/index/src/sidecar.ts`) skips and counts an unparseable line rather than failing the import — this is the only durable copy of the plane, and refusing a file truncated by an interrupted write would turn a partial loss into a total one.

Cross-database foreign keys do not exist, so a path move is mirrored by an explicit `onMove` hook the store calls at the one place a path can change (`packages/store/src/store.ts:201-209`, `apps/cli/src/api-layer.ts:197`), and `memhtml doctor` reports orphaned rows. `tests-integration/tests/clone.test.ts` exercises the whole claim: clone the memory repo, assert neither database came with it, then `memhtml init` + `state import` + `index rebuild` and check that the origin's access _counts_ — not merely the rows' existence — come back.

## 9. The trace indexer and its firewall

`.memhtml` never holds session content. The trace tables are a read-only index over `~/.claude/projects`, and the root is a parameter rather than a constant so the scan is drivable against a fixture tree (`packages/traces/src/scan.ts:81-82`).

**Watermark: size, mtime, and a byte offset** (`packages/traces/src/watermark.ts:66`). Matching size and mtime skips the file unopened; growth _tails_ from the stored offset; a shrink, a backward mtime, or an offset past the current size rescans from 0, because a rewrite invalidates the offset's meaning.

**Streaming parse** (`packages/traces/src/parse.ts:117-125`) splits lines on the raw buffer rather than handing the stream to `readline`, and the reason is the byte count: `readline` strips the terminator without saying whether the final line had one, so a scan racing a live append would count the partial tail as consumed, the watermark would advance past it, and the completed record would be read next time with its head missing. Here an unterminated trailing line is neither folded nor counted, so the next tail re-reads it whole. Peak memory is one chunk plus one line whatever the file's size. The parse cannot fail: a missing file, a permission rejection, a truncated line, and binary garbage all degrade to counters (`packages/traces/src/parse.ts:67-80`).

**A type allowlist is applied before any field access** (`packages/traces/src/extract.ts:11-38`). Seven types are read; six are counted and skipped, and two of those carry **no envelope and no `sessionId` at all** — so reaching for `record.cwd` on one would be reading a field that does not exist on a record that is not about a session. A record with no session key is dropped, not treated as malformed input. A type in neither list increments `unknownTypeLines`, the counter to watch when a new runtime release lands. Every line falls into exactly one counter. Timestamps are canonicalized to ISO-8601 UTC (`packages/traces/src/extract.ts:144-150`) because `traces.started_at` is `TEXT` under an index, so ordering is lexicographic and an offset timestamp would sort as later than a `Z` instant hours after it.

**A tail's extract describes the appended slice, not the session**, so merging it is producer-owned reading semantics and lives in `@memhtml/traces` (`packages/traces/src/scan.ts:165-208`): identity fields take the older side, current-state fields the newer, `startedAt`/`endedAt` are min/max, `turnCount` sums, and `promptCount` is **derived from the merged set rather than summed**, because a prompt straddling the boundary appears in both extracts. Tail ordinals are renumbered from the end of the stored list (`packages/traces/src/scan.ts:213-219`), or every tail would collide with ordinal 0 and the ordinal would stop being an order. A rescan replaces the row outright. `text_head` caps at 200 characters and `first_prompt` at 500 (`packages/traces/src/extract.ts:48-51`): this is an index, not a copy.

**The firewall is a table-name firewall and the enforcement is a test.** Nothing in the retrieval SQL assembler names `traces` or `trace_prompts` — asserted by grepping every statement the module can assemble, in both the default and the scoped form, because a firewall that holds for one and leaks for the other is not a firewall (`packages/index/tests/retrieval-sql.test.ts:204-211`).

### 9a. What the plane is FOR, and who consumes it

The sections above describe how the plane is built. This one says why it exists, because the three tables divide a question that reads as one.

**`traces` answers "what session was this."** One row per session, keyed on `session_id` (`packages/index/migrations/0005_traces.sql:8`): the cwd-derived `slug`, `cwd`, `git_branch`, `entrypoint`, `model`, `version`, `started_at`/`ended_at`, the prompt/turn/agent counts, `first_prompt`, an `ai_title`, and the three that matter most, `file_path`, `file_size`, and `file_mtime`, pointing at the transcript on disk. `search_text` is `first_prompt` and `ai_title` newline-joined under an FTS index, single-column for the same reason `files.fts_text` is.

**`trace_prompts` answers "what was asked, in what order."** One row per distinct prompt with a `text_head` the extractor caps at 200 characters, and an `ordinal` that is 0-based **within one session** and comparable only there.

**`memory_session_links` answers "which memory came from which session, and how."** Its `link_kind` is CHECK-constrained to `wrote`, `read`, `corrected`, `reinforced`. Three properties are deliberate and easy to misread:

- It is written **at memory-write time by the store's injected recorder**, not by the trace scanner. The provenance is recorded by the act that created it.
- The same link is **also file-borne** as `memhtml-session` / `memhtml-prompt` / `memhtml-turn` metas, so it survives a rebuild. This table exists to make the link queryable in **both** directions, not to hold it.
- There is **no foreign key to `traces`**, on purpose: a memory can be written in a session whose transcript has not been scanned yet, and refusing the link would discard provenance the file already carries.

**Consumers, and the shape of each.** `memhtml trace index` (hourly cron) is the producer. `memhtml trace search` and `memhtml trace links` are the read surfaces, mirrored over MCP as `trace_search` and `trace_links` (`apps/mcp/src/tools.ts:943-990`). The firewall means these are a **separate query surface** rather than another retrieval arm — a trace row is structurally incapable of entering RRF, so "search my memories" and "search my sessions" cannot be conflated by accident.

**The consumer the plane is shaped for** is a curator distilling sessions into memories. Anything an agent learned mid-session and didn't explicitly write is otherwise lost, because the transcripts hold it and the corpus doesn't. Such a curator reads transcripts **at their source** and writes what it distills as ordinary memories through a session (§17), never copying transcript text into the corpus. That's why `traces` stores a pointer rather than content. 0.16 ships no transcript curator: `curate run` (§23) works over the corpus alone.

Joining `traces` to `memory_session_links` yields the manifest shape that turns a curator's first move from "read everything" into "read the sessions that touch the memories in question" — paths, date ranges, session ids, tied to the memory files they relate to.

## 10. Curation

Curation is a session on a `curate/<date>` branch, held to the same commit path as any other session and landed only by `curate merge` with the head gate and a human or a gate at it. §23 describes the curation door, the curator, and the collapse, and §24 records why curation sits off the write path.

**Removed in 0.16.** The v1 sleep pipeline (`@memhtml/sleep`, its seventeen phases on a `sleep/<date>` branch, and the six `memhtml sleep` commands) and the consolidator agent (`apps/consolidator`) are gone, along with `apply --consolidate` and MCP `memory_write_batch.consolidate`. `curate run`, `curate collapse`, and `curate merge` replace them. The operator steps are on the docs site at https://memhtml.github.io/learn/operations/migrate-to-0-16/.

What the pipeline hosted that isn't curation lives elsewhere. Artifact generation is `memhtml publish` (`apps/cli/src/artifacts.ts`), the state-plane sidecar is `memhtml state` (`packages/index/src/sidecar.ts`), dangling-href repair is `memhtml doctor --fix` (`apps/cli/src/repair.ts`), and the detected-task path helpers are `memhtml task list --detected` (`apps/cli/src/detected-tasks.ts`). The pure math the phases used (retention scoring, decay, merge vetoes, graph analysis) stays in `@memhtml/domain`. The index keeps two artifacts of the removed pipeline: the `0006_sleep.sql` migration, which every index has applied, and the `sleep` edge provenance value, which rows it wrote still carry.

## 11. Concurrency and conflict surfacing

Git is the optimistic-concurrency mechanism. Two agents editing different files never interact.

Two agents editing the _same_ file surface as a merge conflict, and the recovery belongs to the caller. `mergeBranch` (`packages/store/src/store.ts:1375`) reads both competing blob shas out of the unmerged index — stage 2 is ours, stage 3 is theirs — **before** aborting, because `merge --abort` discards the unmerged index. It then fails with a typed `WriteConflict` carrying the path and both shas (`packages/contracts/src/errors.ts:35`), which reaches an agent as `ERR_WRITE_CONFLICT` plus the suggestion to re-read and reapply (`apps/cli/src/errors.ts:209-213`).

A session commit never merges. It refuses `worktree-dirty` on a path it touches and answers `rebase-needed` when its ref moved, and the caller rebases and retries (`packages/session/src/commit.ts`, §17). Every writer of one checkout, the v1 store and every session commit alike, holds the checkout lock (`.memhtml/checkout.lock`) while it changes the shared index and moves the branch, so a v1 write can't sweep a session's staged file into its own commit (§17, "The checkout lock"). A curation pass reruns cheaply because its work lists are computed from the corpus: an archived duplicate no longer surfaces as a pair, and a filed record is no longer in the inbox.

## 12. The envelope contract and the tool surface

Every command writes one JSON envelope to stdout and nothing else, except `memhtml help` on a terminal, which writes Markdown (piped, or with `--json`, it is an envelope); logs go to stderr. `AGENTS.md` is generated from the same `COMMANDS` array that drives parsing (`apps/cli/src/agents-doc.ts:12`), so it is the reference for the command list and cannot drift from the live answer.

`apiVersion` lets the envelope evolve without silently breaking parsers, and `type` is a discriminator an agent reads to know the shape of `data` before parsing it (`apps/cli/src/envelope.ts:1-6`). Both `RESPONSE_TYPES` (`apps/cli/src/envelope.ts:12`) and `ERROR_CODES` (`apps/cli/src/envelope.ts:110`) are **append-only**: once shipped, a code's meaning never changes and a code is never removed, because agents branch on `code` and never on the human `error` string, which changes freely as wording improves. Exit codes are 0 / 2 / 1 (`apps/cli/src/envelope.ts:166-168`). `--dense` strips nulls and indentation (`apps/cli/src/envelope.ts:234`), and an unknown argument comes back with Levenshtein-nearest candidates (`apps/cli/src/envelope.ts:203`) rather than a dead end.

`failureFor` (`apps/cli/src/errors.ts:278`) is the **one** translation from a typed domain failure to a code, total by construction: an unrecognized `_tag` becomes `ERR_UNKNOWN` rather than an empty response (`apps/cli/src/errors.ts:99-100`). The human message is deliberately narrow (`apps/cli/src/errors.ts:104-112`) — every payload field it names is one a caller can act on: a path to re-read, two shas to reconcile, a model to check. It never carries the driver's message, the SQL, the git argv, or any memory body, because each typed error class already dropped those at its adapter edge precisely so a tool response could not carry corpus content (`packages/contracts/src/errors.ts:3-8`, `packages/index/src/database.ts:152-162`). Suggestions are part of the contract (`apps/cli/src/errors.ts:169-176`), so an agent receiving `ERR_INDEX_STALE` can recover in one step without a round trip to a human; an absent list is `[]`, never null. Per-op batch codes are mapped **once**, in the operations layer (`apps/cli/src/operations.ts:475-489`), so `memhtml apply` and `memory_write_batch` cannot report different codes for one refused op.

Fifteen MCP tools are built with `Tool.make` and collected by `Toolkit.make` (`apps/mcp/src/tools.ts`), plus two resources — `memhtml://file/{path}` for citation-grade drill-down and `memhtml://at/{commit}/{path}` for the same drill-down at a named commit, whose bytes cannot move (`apps/mcp/src/resources.ts`). Curation is not an agent tool: it is an operator action producing a reviewable branch. `memory_search` and `memory_recall` ask the head server first and fall back to the index, so a record a session committed is searchable before `index update` runs (§22, "Search and recall on the head"). The record-creating tools obey the store's `v1Doors` policy (§19), and a closed door answers a typed failure that names the session commands to use instead (`apps/mcp/src/failure.ts`). Two things about the server are forced by the transport and the SDK rather than chosen:

- **`Logger.LogToStderr` is mandatory** (`apps/mcp/src/server.ts:21-23`). Effect's default logger writes to stdout, and stdout here is the NDJSON-RPC stream — one log line corrupts the frame a client is mid-parse on.
- **Tool descriptions are the only server-level guidance channel** (`apps/mcp/src/server.ts:25-38`). MCP defines an `instructions` field on the initialize response and the SDK's handler does not emit it, so `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` are shared constants appended to every description they apply to (`apps/mcp/src/tools.ts:212`, `apps/mcp/src/tools.ts:154`), which is why they read as prose to an agent rather than as notes to a maintainer.

Tool failures are a declared `Schema.TaggedError` (`apps/mcp/src/failure.ts:34`), and that matters: of the SDK's three catch branches for a failed `tools/call`, only the one reached by a value the tool's own `failureSchema` accepts passes prose through verbatim — a generic error is rewritten to an internal-server-error sentence, which is the difference between an agent that can recover and an agent that reads a sentence with no content in it. Code, message, and suggestions fold into `.message` at construction because MCP's tool-error channel is one text block, with the `ERR_*` code first so a consumer can read it back off the prefix.

The CLI's own guidance lives in the manifest's `guide` blocks (`apps/cli/src/commands.ts:1779`), rendered into `AGENTS.md` by the same generator (`apps/cli/src/agents-doc.ts:92`), so the doc and the live answer cannot disagree. The `memhtml task` family is sugar over the same use cases: `task add` is `write --type task`, `task status` edits one head meta and routes `done` through the archive machinery, and `task list` is a direct indexed scan that never enters retrieval, backed by a partial index over live tasks (`packages/index/migrations/0008_tasks.sql:139-140`). `memhtml link` accepts the task rels; `memory_link` does not, refusing one at decode.

### 12.1 Host integrations

`memhtml integrations install` wires a coding agent to the store, and the receipt is what makes that reversible: one JSON file per host per scope recording the SHA-256 of every byte the install owns (`packages/integrations/src/types.ts`), so `uninstall` removes exactly those entries and refuses one a human changed, with `ERR_INTEGRATION_MODIFIED` rather than a silent overwrite. Ownership is claimed at two grains for the same reason. A `file` is wholly ours and its whole hash is the claim; a `fragment` is a JSON key, a fenced TOML table, a Markdown block, or one entry in a hooks array inside a file other tools also write, and only the rendered fragment is claimed, so an operator's own MCP servers and prose survive both directions of the transaction. MCP entries and hook command lines record an absolute node executable and an absolute entry script by default (`BinaryLocation`), because a GUI host inherits no shell `PATH` and a moved toolchain alias orphans a bare command as a server that will not start; the cost is one re-run after an upgrade, which `doctor` reports by re-resolving the path against the recorded version. Every installed hook is one `memhtml hook <event> --host <host>` invocation, and it writes the host's protocol rather than this project's envelope, because the host is the parser (`packages/integrations/src/dialect.ts`); any failure prints nothing and exits 0, since a hook runs on the critical path of a turn and a diagnostic on that stream would enter the model's context as content. Hooks are read-only over the corpus: they recall and they index transcripts, and none of them writes a memory, because the store is single-writer and deciding what is durable belongs to a curator on a reviewable branch with whole transcripts rather than to a 1.5 s bound with one prompt. The prose the installer writes into a host's instruction file and skill is not a fourth copy: the manifest's `recall-discipline` guide topic, the fenced block, the skill, and the retrieval tools' descriptions all render from `RECALL_DISCIPLINE` in `packages/contracts/src/guidance.ts`, which is where the surfaces that teach an agent how to use a memory store stop being able to disagree.

## 13. Testing posture

Integration tests drive the **real** driver against `":memory:"` with the real migrations (`packages/index/src/database.ts:301-304`) and the **real git binary** against a temp-dir repo (`packages/store/src/store.ts:402-404`). A fake driver would verify the shape of the calls and miss every constraint the database enforces; a fake git would verify that the right strings were assembled and miss every state transition that matters. Fakes are `Layer.succeed` values — a deterministic hash-seeded embedder whose cosine relations are a pure function of the text (`packages/eval/src/harness.ts:52`), a failing embedder for the degraded path (`packages/eval/src/harness.ts:99`), and a scripted model.

Property tests with `fast-check` cover `@memhtml/domain` and `@memhtml/html`. The ones the design depends on: the content hash is invariant under any meta-only mutation; `originalPathFor(archivePathFor(p, y)) === p`; every weight profile sums to exactly 1.0 under compensated summation; each retention band boundary is owned by the lower band; decay is unconditionally non-increasing and floor-respecting; RRF is strictly decreasing in rank and order-insensitive across arms; MMR's output is a duplicate-free subsequence of its input; each divergence predicate is symmetric; label propagation yields the same partition for the same edge list; and the pure cooldown twin agrees with the SQL at the boundary.

The v2 packages add their own properties: an advanced head shares every untouched record with its parent by object identity, a snapshot round-trips 1,000 generated records to deep equality, and the planner gives byte-identical output for one view. `tests-integration/tests/v2-sessions.test.ts` drives concurrent sessions through the rebase-and-retry loop, the head server suites drive a real server over a real socket, and `tests-integration/tests/private-terms.test.ts` fails on any tracked file outside the docs site that names a person or an internal system from a hashed list.

**The discrimination gate** (`packages/eval/src/discriminate.ts:225`) asks whether the retrieval stack ranks a memory above its own high-similarity _wrong_ twin — controls derived mechanically from the target by the three divergence families and each validated against its own family's predicate, so a control that failed to diverge is discarded rather than scored (`packages/eval/src/controls.ts:29`, `packages/eval/src/controls.ts:167`).

Two numbers, and **the strict one is the gate** (`packages/eval/src/discriminate.ts:18-21`). `mrr` is measured in the space of `{target} ∪ controls` alone against a floor of 0.85 (`packages/eval/src/discriminate.ts:104`), while the refusal is per-probe and absolute: a single target ranked at or below any of its own controls is an inversion, and one inversion fails the run regardless of what MRR says, because an aggregate alone can be bought by thirty easy probes covering one broken one. A control the search never returned counts as outranked, since being absent is worse than being last. `corpusMrr` is measured against the whole corpus and is **reported, not gated**: it is low by construction on a fixture holding many near-identical memories, and reading it as a retrieval defect would confuse the two coordinate spaces the two field names exist to keep apart (`packages/eval/src/discriminate.ts:79-89`).

**A skipped quality gate never looks like a passing one** (`packages/eval/src/run.ts:16-24`). `fake` mode runs everywhere and is what CI measures; `live` mode without credentials reports `skipped: true` and `passed: false` with a loud stderr line, never a green report — a caller asking for live and getting a silent fake would be told the real vector space discriminates when nothing measured it.

The gate is wired in two places: `memhtml eval discriminate` exits non-zero on any inversion, and `pnpm check` runs it as a `test:eval` turbo task. The refusal is the point: a change that degrades retrieval quality does not ship.

## 14. The published artifact

Sixteen workspace packages, one published package. All sixteen are `private`, so `npm publish` refuses them, and `mise run package:assemble` bundles them into a single `memhtml` carrying two binaries, `memhtml` and `memhtml-mcp` (`tsdown.config.ts`, `scripts/package-manifest.mjs`). The layering in §1 is the shape of the source; it is not a distribution surface, and none of the fourteen libraries has a consumer outside this repository to be a surface for.

**The published contract is the two binaries and their envelope**, not an import. There is no `exports` map, deliberately: declaring an entry point would promise a surface no test covers, and adding one later is a minor bump while removing one is a major, so the cheap direction stays available.

**Nothing that resolves a path at run time may be bundled with the code that resolves it.** Six things do, and after bundling the resolving module lives in `dist/`, so each asset is copied to the package root one level above:

| Asset                                       | Resolved by                                                                                                                       | From                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `migrations/`, `state-migrations/`          | `new URL("../migrations", import.meta.url)` (`packages/index/src/schema-const.ts:11`)                                             | `packages/index/`   |
| `guest/corpus.mjs`                          | `resolve(dirname(fileURLToPath(import.meta.url)), "..", "guest", …)` (`apps/cli/src/exec.ts:111`)                                 | `apps/cli/`         |
| `guest/sandbox-runner.mjs`                  | the same `resolve` (`apps/cli/src/exec.ts:121`)                                                                                   | `apps/cli/`         |
| `prompts/charter.md`, `prompts/collapse.md` | `new URL("../prompts/charter.md", import.meta.url)` (`packages/curator/src/charter.ts:22`, `packages/curator/src/charter.ts:111`) | `packages/curator/` |

Two dependencies must additionally stay OUTSIDE the bundle, because their files are read rather than imported: `node-html-parser`, whose published `dist/index.mjs` is read as bytes into the QuickJS guest (`apps/cli/src/exec.ts:144-151`), and `highlight.js`, loaded through `createRequire` on the first detection (`packages/html/src/detect.ts:47-55`).

**The artifact has its own gate, because no other tier can see it.** Every suite in §13 resolves `@memhtml/*` through pnpm's links, where each asset is on disk whether or not anything declares it — three assets shipped absent from every tarball under exactly that blindness. `mise run package:smoke` installs the tarball into a throwaway directory and drives every command, every MCP tool, and every published MCP resource template through the installed binary — 88 checks as of 0.16.0. All three surfaces are enumerated from the artifact itself (`memhtml manifest`, `tools/list`, `resources/templates/list`) and the script prints `checks: results.length` rather than asserting a literal, so a new command, tool, or template fails a census rather than going untested (`scripts/smoke-package.mjs:1300`). `resources/read` earns its own family of checks because it is a second RPC family with a ROUTER of its own, which no `tools/call` check reaches (`scripts/smoke-package.mjs:860-871`). It is outside `pnpm check` because it needs the registry, and `check` is offline by construction. `--live` adds the one edge the credential-free run can't reach: Bedrock embeddings, through `index update` and through `head embed` and `head search` (`scripts/smoke-package.mjs:1135-1193`).

## 15. The corpus as a value

Sections 1 to 14 describe the parts that hold for every write: the file format, the git store, the SQLite index and its retrieval, the state plane, the trace plane, and the tool surface. Sections 15 to 24 describe how 0.16 holds the corpus in memory, how a session writes, and how conflicts are settled. A memory file is the same file it was, and git is still the system of record.

### Why

Three measurements on a production store (2026-09-22, 8,213 files, 2,216 commits) motivated the change. Each one names a cost the shape before 0.16 paid by construction.

Two thirds of the active memories sat in `areas/inbox/`. Whoever writes a record picks its directory, and retrieval never reads a path, so a wrong placement costs nothing at read time and nothing pushes a writer to get it right.

The curation pipeline that 0.15 shipped (removed in 0.16, see §10) disagreed with itself about the corpus. Its retention triage put 2,851 of 2,955 scored memories in the compress band, while its compress phase processed 7 a run.

One 124 s `memory_search` held the single SQLite writer and blocked the index update behind it. Every reader and every writer shared one process and one database, so a slow read stalled a write.

### The shape

The corpus is a value. Every version is immutable, a session sees exactly one version plus its own deltas, versions share untouched records by pointer, and change is by append. The design has five clusters, top to bottom:

1. Agents. Many sessions run at once. Each holds a pointer to a head version and an overlay log of its own operations, and nothing else. `packages/session/src` owns the session (§17).
2. Memory. One head holds the parsed corpus as a persistent `effect` `HashMap` from path to `MemoryRecord`, with derived indexes that are persistent structures too. `packages/head/src` owns it (§16), and the head server keeps one loaded (§22).
3. The commit path. It's mechanical and makes no model call: validate, check that the ref is still at the validated version, mark frame-key contradictions, write blobs, write a tree, commit, and compare-and-swap the ref (§17).
4. Disk. The git object store is the truth. An Arrow snapshot per commit is the cold-start cache, and an Arrow file of embeddings is the vector cache. `packages/snapshot/src` owns both (§20). A session's durable state is its log, one JSON file.
5. Curation. Judgment runs as a session on a `curate/<date>` branch, and a human or a gate lands it with `curate merge` (§23). It's never in the write path.

### What stays

Four decisions from sections 1 to 14 carry over unchanged. They're the ones the benchmark campaign and the filesystem-memory literature both support.

Git is the system of record (§2). The head, the snapshot, the vector cache, and the session log are all projections of commits or deltas over one, and each can be rebuilt from the object store or discarded.

One fact per file (§3). A `MemoryRecord` is a flat projection of one file (`packages/contracts/src/record.ts`), a `put` writes one file, and a changed claim is a new file plus an archive of the old one, never an edit in place.

The closed HTML vocabulary (§3, §4). `parseMemory` is the same parser, `contentHash` is the same hash, and a session's `put` fails validation for the same format reasons a v1 write does.

A human at the merge of curation (§10). Curation proposes on a branch and the gate decides. The curator sits outside the write path, and the human stays in the loop.

### What moves from the schema into the gate

Two decisions that the v1 write path fixes at write time become gate decisions over time.

The relation set. The closed set of `memhtml-*` rels is a schema constant every parser and writer shares. The commit path is the one place that admits an edge, so a relation can start as a gate rule with a validator before it becomes a vocabulary constant. The frame-key check that adds a `memhtml-contradicts` edge at commit time is the first example of the gate writing an edge nobody authored.

Placement. A writer still picks a directory, and the inbox still absorbs an unsure guess. Filing a record is a curator's `move` on a `curate/<date>` branch (§17, §23), checked by the same gate as any other commit. Retrieval over the head never reads a path, so a wrong placement costs a curation pass rather than a recall.

### The command families

The v2 surface is four families in `apps/cli/src/commands.ts`. `run.ts` dispatches them, `runV2` in `apps/cli/src/v2.ts` answers most of them, and `head serve`, `curate run`, `curate collapse`, `session prune`, and `config` run through modules of their own. `docs/reference/cli.md` is the reference for every flag.

| family                                                       | what it does                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `session start`, `put`, `exec`, `commit`, `rebase`, `status` | open a session on a ref, append ops to its log, land the log as one commit           |
| `session prune`                                              | remove session state nothing reads again (§17)                                       |
| `head status`, `search`, `snapshot`, `embed`, `serve`        | load, query, and cache the head, and run the head server (§16, §20, §22)             |
| `curate run`, `collapse`, `merge`                            | run the curator or the collapse on a `curate/<date>` branch, and land a branch (§23) |
| `config`                                                     | report the store's effective policy and where each value came from (§19)             |

None of the session or head commands opens `index.db`. The head comes from the head server, a snapshot, or git, and every payload that reports a head says which in `head.source` (`server`, `snapshot`, `snapshot+advance`, or `git`).

## 16. The head

`@memhtml/head` holds one version of the corpus in memory. A `HeadVersion` (`packages/head/src/version.ts`) is a `HeadView` (`packages/contracts/src/record.ts`) plus its commit sha, its parent version, and its lexical index. Records live in an `effect` `HashMap<string, MemoryRecord>`, and every derived index is a persistent structure too: `byContentHash` and `byFrameKey` over active records, `inbound` by href, `byEntity`, and the lexical index from token to each path's term frequency, with the document lengths BM25 needs (`packages/head/src/indexes.ts`, `packages/head/src/lexical.ts`).

`loadHead` reads a whole commit with one `ls-tree` and one `cat-file --batch`. A file that fails `parseMemory` is skipped and counted in `skipped` and `skippedFiles` with the parser's reason, because a long-lived store holds files older than the current constraints. `README.html` at the store root is one of them, and it's counted rather than hidden.

`advanceHead` moves a version to a later commit. It asks `git diff-tree -r -z --name-only --no-renames <from> <to>` for the changed paths, so a range of many commits costs one subprocess and a rename contributes both its paths. It re-parses only those paths and rebuilds only the index entries they touch. The new version shares every untouched record with the old one by object reference, and a `fast-check` property over random edit sets holds that to object identity (`packages/head/tests`).

`withOverlay` applies a session's ops to a view, in order. There are seven op kinds (`OverlayOp` in `packages/contracts/src/record.ts`):

| op                 | what it does                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `put`              | parses one file and inserts it at its path                                                                                                 |
| `archive`          | moves a record to its `archive/<YYYY>/` twin with `archived: true`                                                                         |
| `link`, `unlink`   | splices one `(rel, href)` edge into the head or cuts it, through `addLink` and `removeLink`, so the content hash is unchanged              |
| `label`, `unlabel` | adds one `memhtml-entity` meta or removes one, through `addMeta` and `removeMeta`, so the content hash is unchanged                        |
| `move`             | inserts the same bytes at a new live path, so the record keeps its blob, its content hash, its creation time, and every meta (§17, "Move") |

A `label` value must be well formed: it parses as `type:name` and is already in the normalized spelling, so `service:memhtml`, `project:agent-runtime`, and `person:laura` pass and `Service:MemHTML` and `person: laura` don't (`isWellFormedEntity` in `packages/contracts/src/types.ts`). An `unlabel` names a value exactly as the record carries it, so a legacy spelling can be taken off.

### Search on the head

`searchHead` (`packages/head/src/search.ts`) ranks the active records of a view. It's pure: it never embeds, and the caller passes the vectors and the query vector when it has them.

The lexical arm is BM25 over title, claim, and body, with tokens lowercased on non-word characters and stop words dropped. It keeps its best 40 (`LEXICAL_ARM_LIMIT`, the same number as v1's `DEFAULT_ARM_LIMIT`). The vector arm, when the caller passes vectors and a query vector, ranks the active records that have a vector by cosine and keeps its best 40 (`VECTOR_ARM_LIMIT`). Both fuse with reciprocal rank fusion at k = 60 and weight 1.0. Records an arm scores equally share one rank (competition ranking, 1, 1, 3). A query no arm matches returns no hits, and the ranking is deterministic.

The head has no salience arm, because the state plane lives in SQLite (§8), and no MMR pass. A search scope (§22, "Search and recall on the head") is applied inside each arm before the arm's cap (`admit`), the way v1's scope reaches every arm.

### The vector arm

One vector per record, of `vectorTextOf(record)`: the article's text, which opens with the claim, cut at 1,800 characters (`VECTOR_TEXT_MAX_CHARS`, v1's chunk ceiling). Below that ceiling v1 embeds a record's whole article as chunk 0, so the two stores embed the same text for nearly every record in a one-fact-per-file corpus. The title is left out because it lives in `<head>`, outside what the content hash digests, so a vector that read it would go stale under a key that never changes.

The key is the record's content hash, inside a cache that belongs to one vector space: the embedder's model id at its dimension. An unchanged record reuses its vector across every version, every path it moves to, and every head-only edit, and two records that hold one article cost one embed. `fillVectors` embeds the active records the cache lacks in one `embed` call, chunked at Cohere's 96-text ceiling. It skips archived records, which the arm never ranks, and it keeps the entries of hashes the view no longer holds, because the cache serves every version and a record a rebase brings back shouldn't be paid for twice. §20 describes the cache file.

The arm never fails a search. When it can't run, the answer comes from the lexical arm and `vector` says why: `{ used: false, reason }` with `embedder-off`, `no-cache`, `cache-unreadable`, `embed-failed`, or `embed-timeout`. A run that used it reports `{ used: true, cached, coverage, loadMs, embedMs }`, where `coverage` is the share of the head's active records whose hash has a vector.

The weight stays at v1's 1.0. Measured 2026-09-27 on a 7,437-record copy of a production store (728 active records, all embedded), the arm put five of seven hand-written paraphrase queries in the top three. The query with no word in common with its target is the case the arm exists for, and it's the one the arm doesn't rescue: a record the lexical arm misses can score at most `1 / 61` from the vector arm, so records both arms find outrank it. At weight 2.0 it ranked 20th and at 3.0 16th, so raising the weight doesn't fix it. On the same copy a search in process took 1.7 ms a query with two arms and 2.5 ms with the vector arm, and the query embed itself took 143 to 331 ms.

### Recency as the tie-break

Recency decides only between hits whose fused score is exactly equal, newest first by `eventAt ?? updatedAt` clamped to `now`, and path ascending decides after it. It never overturns a score difference and never adds a record. A hit's `arms` carries `recency` when it shares its fused score with another candidate.

A weighted recency arm was measured first and rejected (2026-09-28). At weight 0.5 over every lexical and vector candidate it acted as a second full ranking: the newest candidate collected `0.5 / 61` and the 40th about `0.5 / 100`, a spread wider than the gap between lexical ranks 1 and 10. A rehearsal of a large collapse on a copy of a production store made the surviving records newer, older probe targets lost to newer and weaker matches, and the head gate refused the landing at MRR 0.4384 against a floor of 0.5372. Under the tie-break rule the same landing passed at 0.9485 against a floor of 0.9249, and on a 2026-09-23 copy of the same store the gate's 200 title probes rose from MRR 0.4557 to 0.9975 without the vector arm. A weight of 0.02 or 0.05 scored within 0.005 of the tie-break, but without shared ranks no weight small enough to be a tie-break lets a byte-identical newer copy outrank the older one, and the exact rule is the one whose behavior fits in one sentence.

### The head gate

`gateHeads` (`packages/head/src/gate.ts`, bound by `apps/cli/src/head-gate.ts`) scores a curation landing before `curate merge` moves anything. It loads the version at the target's tip and the version at the branch's tip, samples up to 200 records active in both (`HEAD_GATE_PROBES`, seed 1), and queries each by its title, or the first sentence of its claim when the title is blank, with its own path as the expected hit. It scores both versions on the same probes: MRR in the top 10, and inversions, which are a target outside the top 10 (`fell-out`) or a record the target supersedes ranking above it (`superseded-outranks`). The gate passes when the landed MRR is at or above the base MRR minus 0.02 (`HEAD_GATE_TOLERANCE`) and the inversion count didn't grow. A record the landing adds isn't a probe, and one it archives leaves the probe set, so the numbers differ only by what the landing did to what survives.

The gate is relative because the absolute numbers depend on the corpus. One base scored MRR 0.2578 before the arms were capped and 0.9975 after the tie-break rule, with no change to the corpus, so a fixed floor would either refuse every landing or gate nothing.

The gate runs the lexical path with no vectors, so `curate merge` stays credential-free and never embeds. A landing that damages only the vector arm, such as a canonical record whose article is thin under a good title, is invisible to it. Scoring the vector arm at the gate would need both versions embedded inside `curate merge`.

## 17. Sessions

A session is a pointer to one corpus version plus an overlay log of its own operations. `@memhtml/session` owns the log, the validator, and the commit path. It spawns git itself with `node:child_process` (`packages/session/src/plumbing.ts`), because the store's `Git` service strips `GIT_INDEX_FILE` from every child, and it never imports `@memhtml/store`.

### Session state on disk

A session's whole durable state is its log, `.memhtml/sessions/<id>.json`: `{ id, baseSha, ref, ops, pending? }`, written whole through `write-file-atomic`. The log's presence means the session wrote, and an agent runtime can read it to decide whether a run has anything to commit. `session status` reports the log's ops by kind and the paths they touch.

Three more files can sit beside it:

- `<id>.lock` is a `proper-lockfile` directory held while one writer has the session (`withSessionLock`). A second writer fails at once with `session.locked`. A lock left by a killed process goes stale after 30 s (`SESSION_LOCK_STALE_MS`) and the next writer of that id reclaims it.
- `<id>.dropped.jsonl` records each op a `session commit --drop-refused` took out of the log, with the instant and the reason.
- `<id>.idx` and a ref under `refs/memhtml/sessions/` are what pre-release v2 builds wrote. Nothing writes them now, and `session prune` removes old ones. The `Memhtml-Session:` trailer on each session commit records the session's id.

Every writer computes the file it writes from a log it read before it took the lock. A `session exec` reads the log, runs a script for seconds, and then appends its harvest, so the lock alone would still lose an update when two execs read one log. So `appendOps`, `saveSession`, and `commitSession` read the log again under the lock (`requireLogUnmoved`) and write only when it still holds the ops the caller read. Otherwise they refuse with `session.moved` and write nothing.

A session id matches `SESSION_ID` (`packages/session/src/session.ts`). `session start` checks its base with `rev-parse` and refuses an id that already has a log (`session.exists`) unless `--force`. A new store's `.gitignore` names `.memhtml/sessions/`, `.memhtml/snapshots/`, `.memhtml/vectors/`, and `.memhtml/head.sock`. A store scaffolded earlier carries a committed `.gitignore` without them, so `ensureExcluded` (`packages/session/src/exclude.ts`) appends the missing patterns to `.git/info/exclude` once, and `git status` stays clean.

### Validation

`validateOps(view, ops, { scope, writeBar, batchCap })` (`packages/session/src/validate.ts`) judges a whole batch against the version the session sees and returns every violation it finds, except that a batch over the cap returns the `batch-cap` violation alone:

| kind            | when                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`        | the file doesn't parse or breaks a format constraint, or a move or an archive leaves a live edge pointing at the old path                              |
| `duplicate`     | the put's content hash is already active at another path                                                                                               |
| `claim-edit`    | a put over an active path with a different content hash                                                                                                |
| `reserved-path` | `.memhtml/`, `memhtml.config.json`, `index.html`, or `sitemap.xml` under any scope; `areas/arcs/` and `resources/people/` unless the scope is `curate` |
| `batch-cap`     | more than 200 ops (`BATCH_CAP`)                                                                                                                        |
| `write-bar`     | the store's write bar refuses the record (§19)                                                                                                         |

The scope is `session` for every ref except one under `refs/heads/curate/`, which is `curate` (`sessionScopeOf` in `apps/cli/src/v2.ts`). An `archive` op's article must be its source's, because the commit writes the source as the batch left it. Once the whole batch is walked, a live record still carrying an edge to a path an archive vacated is a `format` violation on the archive naming the holder, the rel, and the repoint to the archive slot, the rule a move is held to ("Move" below). The one exception is a holder the scope may not write, an arc or a people record under `session`: no batch of that writer can repoint it, so the archive leaves its edge to the curator, whose briefing lists it among the dangling edges with the archived form to repoint it to. Head ops judge their source as the batch has left it, so a batch may drop an edge it added and may not drop one twice, and a `label` of a value the record already carries is a violation.

### The commit order

`commitSession` (`packages/session/src/commit.ts`) lands a session's log as one commit. The whole call holds the session's lock, and before it starts it checks that the log hasn't moved. Then, in order:

0. Recovery. A log carrying `pending` names a commit an earlier call built and may have landed before it was killed. Under the checkout lock, a `pending` reachable from the ref landed: the call answers `committed` for it with `recovered: true` and clears the log. A `pending` that never landed is undone with `read-tree -m -u pending <tip>`, which reverts only the paths where the shared index still holds `pending`'s version, and the call drops `pending` and goes on.
1. Validate. `validateOps` with the session's scope and the store's write bar. Any violation answers `refused` with the violations and writes nothing.
2. Check the ref. A ref that moved past the version that was validated answers `rebase-needed` with the new tip and the paths that collide (possibly none). There's no disjoint fast path, because a duplicate hash or a frame-key rival is a collision between different paths, and only a head rebuilt at the tip can judge it.
3. Mark contradictions. A put whose frame key resolves to a different active path gets a `memhtml-contradicts` link spliced into its head, and the pair is reported. Both records stay live.
4. Build. The blobs, a tree, and a commit object with the `memhtml(session): ...` subject and the `Memhtml-Session` trailer, staged through a temporary index file in a directory under the OS temp dir that's removed on every exit. Nothing a later call depends on lives in it.
5. Save `pending: <commit>` to the log, before anything shared is touched. From here on a process killed at any instant leaves a log the next call settles in step 0.
6. Land (`landOnRef`). Under the checkout lock and uninterruptible: the ref must still name the version from step 2, else `rebase-needed` with nothing touched. When `HEAD` is the session's ref, uncommitted state at a path the commit touches answers `worktree-dirty`, and otherwise `read-tree -m -u` moves the shared index and working tree to the new tree while the ref still names the parent. Then `update-ref` with the tip step 2 read as the expected old value, so a curate ref's first commit requires that the ref doesn't exist yet. A lost swap rolls the checkout back and answers `rebase-needed`. `worktree-dirty`, `rebase-needed`, and a `checkout.locked` failure all clear `pending`.
7. Save the log on the new commit with zero ops.

The checkout moves before the ref because the reverse order would leave `HEAD` ahead of the index on any failure. Git then reports the session's own files as staged deletions, and the next `git commit -a` or v1 write commits them away.

### The checkout lock

A v1 store write and a session commit can share one checkout. The v1 store stages with `git add` and then commits the whole shared index, while a session commit moves the index with `read-tree` and then swaps the ref. Interleaved, the v1 commit sweeps the session's file into its own commit, the session loses its swap, and the rollback leaves the file staged as deleted. So every writer of the shared index holds one lock per repository while it changes the index and moves the branch (`packages/contracts/src/checkout-lock.ts`, `withCheckoutLock` in `packages/session/src/checkout-lock.ts`).

The lock is `proper-lockfile` on `.memhtml/checkout`, so the lock directory is `.memhtml/checkout.lock`. A holder refreshes it every 2 s, and it goes stale after 10 s without a refresh. A waiter retries for up to 15 s, pausing 10 ms at first and doubling up to 250 ms, and then fails with `ERR_STORAGE` `checkout.locked` having written nothing. The lock is reentrant within one fiber. Its path, timing, and reentrancy key live in `@memhtml/contracts`, because the store and the session package can't import each other and must agree on all three.

Every v1 store write takes it through `StoreShape.exclusive`, with `Git.commit` as a backstop, and so do `init`, `task status`, `publish`, `state export`, `doctor --fix`, every session commit, and the `curate merge` fast-forward.

One crash window remains. A SIGKILL in the few milliseconds a commit holds the lock leaves the lock behind until it goes stale after 10 s. After that a v1 write can sweep the dead commit's staged file into its own commit. The file lands on the branch and isn't lost, step 0 keeps it, and the session answers `rebase-needed`.

### Three conflict tiers

Conflicts sort into three tiers, and each tier has one owner.

Syntactic conflicts belong to git. Two sessions touching the same path surface as `rebase-needed`, at step 2 or as a lost swap at step 6, and the caller rebases and retries with validation running again over the new base. A duplicate content hash or a claim edit is refused at step 1 with the path it collides with, and step 2 guarantees step 1 judged the version the commit lands on.

Detectable semantic conflicts belong to the frame key. Two live claims about the same subject with different content aren't an error. Step 3 keeps both live and connects them with a `contradicts` edge, so the head's `byFrameKey` and `inbound` indexes find the pair without a model call.

Judgment belongs to a curator on a branch. Deciding which of two contradicting claims is right, merging near-duplicates, and filing records out of the inbox are sessions on `curate/<date>`, committed through the same steps and landed by `curate merge` with a human or a gate at it (§23).

`tests-integration/tests/v2-sessions.test.ts` drives eight sessions started at once on one version of a 300-record fixture, each committing three disjoint files through the rebase-and-retry loop, and then the four conflict cases through the CLI.

### Rebase and retry

`session commit` never retries on its own. It answers `rebase-needed` whenever the ref moved past the session's base, and the caller runs `session rebase`, which moves the base to the ref's tip and keeps the ops, and commits again. Validation runs again at the next commit. A caller that reads the `refused` that follows decides what to do with it.

`session commit --drop-refused` is for a caller with no turn left to fix a line in, such as an agent runtime committing a run's session when the run ends. It takes every op that touches a path a refusal names out of the log (`replaceOps`, under the log's lock), appends each to `<id>.dropped.jsonl`, and commits the rest, repeating until the commit is clean or the log is empty. The payload's `dropped` lists `{ kind, path, reasons }` for each. A batch-cap refusal names no path, so it drops nothing and the refusal stands.

### Move

`move` relocates one active record to a new live path with its bytes unchanged. Placement had no correct shape before it existed. Measured on a copy of a production store (2026-09-30), a curator session that copied an inbox record to its home, archived the original, and repointed the one arc that cited it was refused as a `duplicate`, because the head's `byContentHash` still named the inbox copy while the same batch archived it. Two curator runs had moved nothing out of the inbox. Had the pair gone through, the record would also have lost its identity, as a new record plus an archived copy of the same article.

So the op relocates and does nothing else. Inbound edges move through explicit `unlink` and `link` pairs, so every file a commit changes is named by an op, the log still says what the commit does, and the replay (§23) reconstructs a move as it reconstructs everything else. The pairs are mechanical, so no writer computes them by hand: `withRepoints(view, ops)` (`packages/session/src/moves.ts`) inserts an `unlink` of each live edge to the old path and a `link` of the same rel to the destination before the batch's first move or archive. An archive vacates a path too, so it gets the same pairs, with its `archive/<YYYY>/` slot as the destination: a successor's `supersedes` edge to the record it retires ends at the archived copy. It skips a holder the batch archives, an edge the batch already unlinks, a source the batch puts a new record at, and a holder the writer's scope may not write. `session exec`, the curator's `exec` and `propose`, `curate collapse`'s driver, and `curate merge` complete their ops with it. `session commit`, here and in the head server's rebase rounds, and the curator's own landing complete the whole log again against the version they commit over, so an edge the ref gained to the old path after the ops were written is repointed in the same commit; a log already complete gains nothing, because an edge the log unlinks, at the holder's path or at the path the log moved it to, is the log's. The pairs count against `BATCH_CAP`, so a record with a hundred or more edges to repoint can't be archived or moved in one capped session: the completed batch is refused as `batch-cap`.

`validateOps` holds a move to these rules. The source must be live and not already moved or archived in the batch. The destination must be a memory path outside `archive/`, not the source, held by no record active or archived, and not written earlier in the batch. The op's article must be the source's. A later op sees the record at its destination, so a head op on the old path is refused. Once the whole batch is walked, each destination is held to the write bar's anchor rule, and a live record still carrying an edge to an old path is a `format` violation on the move naming the holder, the rel, and the repoint to add.

### Session prune

`memhtml session prune --older-than <duration> [--dry-run]` (`pruneSessions` in `packages/session/src/prune.ts`) removes the session state a store accumulates and nothing reads again. Measured on a production store on 2026-10-18 it found 1,686 `<id>.idx` files totaling 2.5 GB, 1,579 session refs, and three lock directories that no writer would ever reclaim.

Each of these goes when it's older than the cutoff: `<id>.idx` files, refs under `refs/memhtml/sessions/`, stale `<id>.lock` directories, and logs that hold zero ops. A log that holds ops is never removed. Its run wrote something that hasn't landed, so prune lists it under `unlanded` with its id, op count, `pending`, and age, for an operator to commit. Every id is handled under its session lock, fail-fast, so a writer of that id is never pruned from under, and an id whose lock is held is listed under `busy`. The duration is a number with a unit (`7d`, `48h`, `90m`, read by `ms`), and a bare number is refused, because `--older-than 7` meaning seven milliseconds would prune every idle log. `--dry-run` takes no lock and reports what a real run would remove.

## 18. Run sessions

An agent runtime runs many short CLI processes per run and wants every memory a run writes to meet the write bar and land in one commit. `MEMHTML_SESSION` is the one piece of state the runtime hands every subprocess of a run, for example `run-<run id>`, and the CLI reads it in `run.ts` before anything opens (`apps/cli/src/config.ts`):

- Every `session` command takes it as the default `--id`, so an agent writes with `memhtml session exec <<'SH'` and never repeats an id. With neither `--id` nor the variable, the call is `ERR_MISSING_ARGUMENT`. A value that isn't a session id is `ERR_INVALID_FLAG` naming the variable, and a blank value is unset.
- `session put` and `session exec` start the session on first use when the id came from the variable (`ensureSession` in `apps/cli/src/v2.ts`). An existing log is resumed, and a missing one is started on the ref's tip with one `rev-parse`, since `startSession` reads only the base's sha. An explicit `session start` would cost one more CLI process per run, paid by every run including the ones that never write. Two first uses at once both find no log, and the one that loses the lock waits up to 5 s for the log and goes on, so neither fails and neither log is replaced. An id given on the command line must name a started session, so a typo is an error rather than a new session.
- Under the store's default `v1Doors` mode, `closed-in-session` (§19), the v1 doors that create a record (`write`, `apply`, `correct`, `task add`) refuse with `ERR_SESSION_BOUND` at exit 2 before anything opens. Each refusal names the session command that does the same job and suggests a `printf '%s\n' '<write line>' | memhtml session put --file -` line that decodes as written. Reads and the edits of existing records (`link`, `archive`, `task status`, `reinforce`) stay open.

A session whose id is the variable's is run-bound, whether the call spells the id with `--id` or not. In one, `duplicate` and `claim-edit` block a put or a harvest too (`RUN_BOUND_BLOCKING_VIOLATIONS` in `apps/cli/src/v2.ts`). Outside a run those two are reported and appended, because a rebase can change the answer and the caller commits when it chooses. Inside a run nobody chooses: one repeated fact in a run's log would refuse the whole commit at run end, and every record the run wrote would be lost with it. So a `session put` with one repeated line appends none of its lines and names that line, and the agent fixes it inside the turn. A duplicate's refusal names the record that already holds the article, and a claim edit's says to write the new fact under its own title with a `memhtml-supersedes` link.

The runtime commits the session when the run ends with `session commit --drop-refused`, and one `session rebase` and a retry on `rebase-needed`. What that commit can still refuse is what landed on the branch during the run: another writer's record with the same article, or a record at a path the run also wrote.

The test environment (`throwawayTestEnv` in `@memhtml/store/testing`) blanks the variable, so a suite started from inside a run sees no default session. `apps/cli/tests/session-env.test.ts` and `apps/cli/tests/session-run-bound.test.ts` cover the rules.

Placement never routes a record into `resources/people/`, which is reserved outside the `curate` scope. A `person:` entity says only who a record is about, and a person record is written at an explicit path by curation.

## 19. The write bar and the store policy

### The write bar

The curator can only clean what got in, so the write bar decides what any session, the curator's included, may commit as a memory. It has two halves, and the split follows who can judge each.

The mechanical half is code. `validateOps` runs `writeBarReasons` (`packages/session/src/validate.ts`) over every put under every scope and reports a `write-bar` violation when the store's policy refuses the record:

- `writeBar.refusedTypes` lists the memory types no session may write, each with the reason its refusal gives. A deployment that keeps run narratives in the trace index, for example, refuses `episodic`.
- `writeBar.requireAnchor` requires every new record to name what it's about: at least one `memhtml-entity`, or a path under `projects/<slug>/`. The reason (`UNANCHORED_REASON`) says what to add, so a writer that reads it can fix the put. The rule also holds a `move` destination and an `unlabel` that drops a record's last entity, so swapping one label for another passes in either order and dropping the last one fails.

An archive destination is an existing record moving and isn't judged. Tasks are judged like every other type: a task under `projects/<slug>/tasks/` is anchored by its path, and a task in the inbox needs an entity. `session put` and `session exec` treat a `write-bar` violation as blocking, like a format violation, because no rebase cures it, and the curator's `propose` and `exec` tools hand it back to the model with its reason.

The library default refuses no type and anchors nothing (`DEFAULT_WRITE_BAR`). Format, the content-integrity refusals (duplicates, frame-key handling, a put over an active path, reserved paths), and the batch cap hold whatever the policy says.

The judgment half is the writing agent's. The guide that `AGENTS.md` carries tells a writer to keep what's durable, one fact per memory, such as a decision and its reason (`packages/contracts/src/guidance.ts`). To support that judgment, `session put` reports `neighbors`, the three records nearest each put in the session's view by the same search `head search` runs, so the writer can skip a near-duplicate and link related records before it commits. Reading before writing is what Mem0 (arXiv 2504.19413) and A-MEM (NeurIPS 2025) do at write time, and Xiong et al. (ACL 2026, arXiv 2505.16067) measured selective addition beating add-everything. The same literature finds that rewriting raw evidence with a model hurts (arXiv 2605.12978), which is why the bar filters what enters and leaves run traces raw in the trace index.

### The store policy file

What every process that writes to one store must agree on lives in one file at the store root, `memhtml.config.json` (`packages/contracts/src/store-config.ts`). It's tracked in git beside the corpus, so a clone carries its rules with it.

| key                      | library default     | what it sets                                                                               |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------ |
| `writeBar.refusedTypes`  | none                | types no session may write, by name or as `{ type, reason }`                               |
| `writeBar.requireAnchor` | `false`             | every new record names an entity or sits under `projects/<slug>/`                          |
| `v1Doors`                | `closed-in-session` | when the v1 record-creating doors refuse                                                   |
| `curator.writerBuckets`  | `[]`                | directory-name globs that say who wrote a record, so placement and the collapse avoid them |
| `curator.placementQuota` | `60`                | inbox records one `curate run` should file, 0 to 200                                       |

The three `v1Doors` modes:

- `open`: no door refuses.
- `closed-in-session`: the CLI's doors refuse inside a process whose environment carries `MEMHTML_SESSION`, with `ERR_SESSION_BOUND` (§18). The MCP write tools refuse only when the MCP server process itself runs with `MEMHTML_SESSION` set.
- `closed`: every record-creating door refuses, in every process, at exit 2. The code is `ERR_V1_DOOR_CLOSED` when no session is set and `ERR_SESSION_BOUND` when `MEMHTML_SESSION` is set. Records go in through sessions only.

The record-creating doors are `write`, `apply`, `correct`, and `task add` (`apps/cli/src/doors.ts`), and the MCP tools `memory_write`, `memory_write_batch`, and `memory_correct` (`guardV1Door` in `apps/mcp/src/handlers.ts`). They commit straight to the store with no write bar, which is why the policy can close them. `memory_link`, `memory_archive`, and `memory_reinforce` stay open in every mode.

A strict deployment's file looks like this:

```json
{
  "writeBar": {
    "refusedTypes": [
      { "type": "episodic", "reason": "a run narrative belongs in the trace index" },
      { "type": "verdict", "reason": "review output is not a memory" }
    ],
    "requireAnchor": true
  },
  "v1Doors": "closed-in-session",
  "curator": {
    "writerBuckets": ["*-import", "*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"],
    "placementQuota": 60
  }
}
```

The file is read from the working tree each time a decision needs it and never cached, so an edit applies with no restart (`loadStorePolicy` in `apps/cli/src/store-config.ts`). With no file, the library defaults apply. Decoding is strict and fails closed: an unknown key, a value of the wrong type, an unknown memory type, or a type listed twice fails with `ERR_STORE_CONFIG` at exit 1, because a typo in a policy file must not loosen the policy it meant to state. Reads, search, and status never touch the file. It's never a record: it isn't a head candidate, it's never indexed, every session scope reserves it, and `list`, `publish`, the sitemap, and `doctor` leave it out.

`memhtml config` (`config.report`) prints the effective policy and where each value came from, `file` or `default`, beside the process tuning variables. Both curator charters are templates whose placeholders the policy fills (§23).

## 20. Snapshots and the vector cache

### The snapshot

`writeSnapshot` (`packages/snapshot/src/snapshot.ts`) writes one Arrow IPC file per commit at `.memhtml/snapshots/<sha>.arrow`: one row per record, list-typed columns for tags, entities, links, and facets, and `sha` and `format` in the schema metadata. A round-trip test over 1,000 generated records asserts deep equality, and a second test reads one row of a table opened over a `Buffer` and counts the decoded cells to confirm the other rows aren't touched. The package also owns the directory as a set: `listSnapshots` lists every `<sha>.arrow` newest first, and `pruneSnapshots` keeps the newest four (`SNAPSHOTS_KEPT`).

### Loading from snapshots

Outside the head server, the head loads once per CLI process, so every commit that moves a ref writes the snapshot for the new sha, and every load takes the cheapest path that exists. Both sides live in `apps/cli/src/head-cache.ts`.

The write side is `snapshotAfterCommit`. `session commit` (a `committed` outcome), a `curate merge` replay, `curate run`, and `curate collapse` build the new version from the one the commit was judged against with `advanceHead`, write it, and prune the directory to four. A `curate merge` fast-forward loads the new version the cheapest way `loadVersion` knows and writes that. The payload carries `snapshot: { sha, path, bytes, rows, ms, pruned }`. The write is best-effort: a failure is logged and the payload carries `snapshot: null`, never a failed commit, because the ref has already moved and a full disk must not read as a lost commit. A commit the head server lands writes its snapshot in the server (§22). `head snapshot --write` writes one from a forced git read, for a store whose `HEAD` moved by other means.

The read side is `loadVersion(root, sha)`, which `loadHeadAt` in `apps/cli/src/v2.ts` wraps with timing, and it tries three sources in order:

1. The commit's own snapshot (`source: "snapshot"`).
2. The snapshot of an ancestor, advanced to the commit with `advanceHead` over the paths `diff-tree` names (`source: "snapshot+advance"`, with `ancestorSha` and `reparsed`). The ancestors are tried best first, by the fewest changed memory paths, among the listed snapshots that `merge-base --is-ancestor` puts under the target, so a snapshot of a side branch is never advanced from (`ancestorSnapshots`). A snapshot of a commit git can't compare is skipped, and a snapshot directory that can't be listed falls through to git.
3. Git (`source: "git"`).

Any snapshot read failure is a cache miss: a decode error, a wrong format or schema, or a snapshot that names another sha. The loader logs a warning, removes the file, and tries the next source, so only git can fail a load. `head snapshot --read` still fails on a bad file, because reading one file is what it was asked to do. A version built from a snapshot is a real `HeadVersion` (`versionFromRecords` in `@memhtml/head`), so an advanced version shares every untouched record with it by reference. `skipped` reads `null` for both snapshot sources, because a snapshot holds records only.

Measured 2026-09-24 on an 8,245-record copy of a production store (git 2.50.1, `memhtml head status` end to end including process start, two runs each):

| load path                                             | ms         |
| ----------------------------------------------------- | ---------- |
| git (`ls-tree`, `cat-file --batch`, and the parse)    | 6812, 6409 |
| snapshot (its own file, 43.0 MB)                      | 2398, 2293 |
| snapshot+advance (an ancestor and 40 changed records) | 2615, 2438 |
| snapshot write after a load                           | 338        |

Reading the Arrow file takes about 0.3 s of the snapshot path, and folding the records into the persistent indexes takes about 1.5 s. The fold is the same cost the git path pays after it parses, so the snapshot removes the parse and the subprocesses, and the index build is what remains. The head server removes the rest by staying loaded.

### Format versions

Snapshots and vector caches carry a `format` metadata key, `"1"` at 0.16 (`SNAPSHOT_FORMAT`, `VECTOR_CACHE_FORMAT`). A file with no key reads as format 1, which covers every file written before the key existed, so the upgrade needs no rewrite and no re-embed. A snapshot whose key names another format is a miss (`snapshot.read.format`). The loader removes it and loads from an ancestor's snapshot or from git. A vector cache whose key names another format reads as absent, and the arm reports `no-cache` until `head embed` writes a new one.

### Writes and staging

Every snapshot and vector-cache write goes through `write-file-atomic`, which writes a staging file per writer named `<file>.<number>` and renames it into place, so two writers never share a temp name and a reader never sees half a file. A staging file a killed writer left behind is swept once it's older than an hour (`sweepStaging`, `STAGING_ABANDONED_MS` in `packages/snapshot/src/staging.ts`). A snapshot of 8,245 records writes in 338 ms, so an hour is far past any write in flight.

### The vector cache

The cache file is `.memhtml/vectors/<model id>@<dimension>.arrow` (`packages/snapshot/src/vectors.ts`; characters of the model id outside `[A-Za-z0-9._-]` become `_`, so Cohere Embed v4 at 1,024 dimensions is `cohere.embed-v4_0@1024.arrow`). It holds a `contentHash` column and a `vector` fixed-size list of `Float32`, with the model id, the dimension, and the format in the schema metadata. The reader refuses a file whose metadata names another space (`vectors.read.space`), because two model ids can sanitize to one filename, and one whose columns differ (`vectors.read.schema`). A missing file reads as `null`. The vector column is one contiguous `Float32Array` per batch, and the reader hands out a `subarray` per row over the buffer it read, so a load copies no float.

`memhtml head embed` fills the cache for the version at `HEAD` (`apps/cli/src/head-vectors.ts`). `head search` reads it and embeds the query with the query input type, and `session put` embeds each put's text as a document, since a put is compared with stored documents rather than asked as a question. The embedder is bound the way v1 binds it, so `MEMHTML_EMBED=off` switches it off and `MEMHTML_LLM_BASE_URL` routes it through an LLM proxy. `head embed` needs the embedder, so under `MEMHTML_EMBED=off` it fails with `ERR_MODEL_UNAVAILABLE`. Deleting the directory costs one `head embed`.

Measured 2026-09-27 on the 7,437-record copy (728 active records): the first `head embed` embedded 728 records in one call of 4.3 s, a second run reused all 728 and wrote nothing, and the 3.0 MB file read in 7 to 10 ms. A synthetic cache of 8,000 vectors is 33.4 MB and reads in about 52 ms.

## 21. The sandbox

`session exec` runs a script over head plus overlay and harvests what it wrote into the session's log (`runSessionExec` in `apps/cli/src/session-exec.ts`). It reuses the sandbox `memhtml exec` builds, and differs from it in two ways: the guest filesystem is seeded from the view's records under `/mnt/memhtml` with no disk worktree, and the mount is writable.

The guest is seeded from the view's UTF-8 bytes (`SeedImage`: buffers plus a path and a byte range per file), and each file gets its own copy, because just-bash keeps the array it's given by reference. `--lang bash`, the default, hands the text to the interpreter as the shell program. `--lang js` writes it to `/workspace/script.mjs` and runs `js-exec` on it. Both run in the same sandbox over the same mount, and `/workspace/lib/corpus.mjs` (§12, code mode) is seeded for both, so a bash script can `js-exec` a module that imports it. Under `bash` the shell's deadline is `--timeout-ms` exactly, and just-bash's command and loop-iteration counts are raised out of the way, so a runaway loop ends at the deadline with exit 124 and `timedOut: true`.

`session exec` completes its harvest with `withRepoints` (§17, "Move"), so a script that archives or moves a cited file needn't edit the files that cite it, and appends the harvest only when the script exited 0 and no harvested op carries a violation a rebase can't cure (format, reserved path, batch cap, write bar), judged the way `session put` judges its puts. The report carries `violations` and `blocking` either way.

### Harvest

After the script exits, `harvestOps` compares what the guest left against the seeded bytes. Every changed seeded file ends in `ops` or in `rejected`, and none is dropped silently:

- A new `.html` file is a `put`.
- A seeded file whose article changed is a `put` at the same path, which `validateOps` refuses as `claim-edit`. That's the store's rule, and the harvester only reports it.
- A seeded file whose bytes changed and whose article didn't is a head edit. Every `<link rel="memhtml-...">` added becomes a `link` and every one cut an `unlink`, and every `memhtml-entity` meta added becomes a `label` and every one cut an `unlabel`. So a `sed -i` that splices one line into a head is one op. Any other head change (a title, another meta, a comment) or article markup changed with the words kept is rejected with a reason.
- A seeded file gone from its path is an `archive` when its article sits at its `archive/<YYYY>/` twin, a `move` when it sits at exactly one new live path, and a rejection otherwise. Deleting isn't an operation.
- A file outside `.html`, under `.git`, or named `index.html` is rejected.

The harvester applies the reserved-path rules of the session's scope to what the script wrote, and skips a seeded file whose bytes are unchanged before that check, so a session-scope run over a store holding curated records reports none of them.

### Heredoc scripts

An agent does most of its reads and writes as a heredoc, so `session exec` reads its script from stdin. The quoted opener (`<<'SH'`) keeps the agent's own shell from expanding anything, so the script reaches the sandbox byte for byte, nested heredocs included. Paths are absolute: the guest's working directory is `/home/user`, and the corpus is at `/mnt/memhtml`.

A read harvests nothing:

```sh
memhtml session exec --id s1 <<'SH'
grep -rl 'content="system:memhtml"' /mnt/memhtml/projects | wc -l
SH
```

A write of one record at the bar, anchored by its entity and its workspace path, followed by `memhtml session commit --id s1 --message "..."` to land it:

```sh
memhtml session exec --id s1 <<'SH'
mkdir -p /mnt/memhtml/projects/memhtml
cat > /mnt/memhtml/projects/memhtml/session-exec-runs-bash.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>session exec runs bash by default</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-09-27T12:00:00Z">
<meta name="memhtml-updated" content="2026-09-27T12:00:00Z">
<meta name="memhtml-entity" content="system:memhtml">
</head>
<body>
<article>
<p><mark>memhtml session exec runs its script as bash unless --lang js is passed.</mark> A heredoc on stdin is the script, and js-exec runs a module from inside it.</p>
</article>
</body>
</html>
HTML
SH
```

just-bash 3.4.2, probed on 2026-09-27, runs `sed -i`, `find -exec`, `xargs`, `jq`, `awk`, `set -o pipefail`, and nested heredocs as GNU bash does. It differs in four ways. A redirect into a directory that doesn't exist creates it. A producer piped into `head` isn't stopped when `head` exits, so `while true; do echo x; done | head -1` runs to the deadline. `yes` and `curl` aren't commands. A runaway inside one `awk`, `sed`, or `jq` call, or a recursion deeper than 100 calls, ends in milliseconds with exit 126 and the bound named on stderr.

Measured 2026-09-28 on the 7,437-record copy, 20 runs each, a no-op heredoc took 877 ms at p50 through the head server against 2,335 ms with `--no-server`, where the local head load alone was 1,401 ms. What's left on the server path is the CLI's own start, about 0.7 s. The socket answers the exec in 135 ms at p50, so an agent harness that speaks to the socket directly takes the CLI's start off the path.

## 22. The head server

Every command that loads the head pays for it: about 2.4 s from a snapshot on a store of 8,200 records, more on a loaded host. A pre-turn memory lookup with a 1.5 s budget can only be served from a head that stays loaded. `memhtml head serve` is that process. It holds the head and the vector cache loaded, answers lookups, runs `session exec` scripts in worker threads, and lands session commits. The server is `apps/cli/src/head-server.ts`, the client `head-client.ts`, the routes and schemas `head-protocol.ts`, and the workers `exec-pool.ts` with `guest/sandbox-runner.mjs`.

### Lifecycle

`memhtml head serve [--ref <ref>] [--poll-ms <ms>]` resolves the ref it follows (the flag's, else the branch `HEAD` points at, else `refs/heads/main`), loads the version at its tip the cheapest way `loadHeadAt` knows, reads the vector cache when an embedder is bound, binds its endpoint, logs one `head serve: listening on …` line to stderr, and serves until SIGTERM or SIGINT. On either signal it closes the listener, waits up to 2 s for requests in flight, stops the exec workers, removes the socket file, and writes one `head.served` envelope to stdout with the endpoint, the ref, the sha it ended at, the record count, the signal, the load source and its time, the advance and request counts, and the uptime.

### The socket

The endpoint is `.memhtml/head.sock` inside the store, a Unix domain socket and never a TCP port. It's bound with mode 0600: the umask is narrowed to 0177 around the bind, so the file is never reachable by another user, even for the instant before a `chmod`. The path is in the store's `.gitignore`, and the server adds it to `.git/info/exclude` before it binds.

The socket path limit is counted in UTF-8 bytes: 107 on Linux and Android, and 103 on macOS, the BSDs, and other POSIX systems (`socketPathMax`). A client never dials a path past the limit and loads locally instead, and `head serve` refuses such a store before it loads anything, with `HeadSocketPathTooLong` (`socket`, `bytes`, `max`, `platform`), which maps to `ERR_STORAGE`.

On win32 the client and the server both use the named pipe `\\.\pipe\memhtml-<first 16 hex digits of sha256(path.win32.resolve(store))>` (`headEndpoint`, `headPipeName`). It isn't a file, so there's no mode, ignore entry, or file to remove. It hasn't been run on a real Windows host.

Before binding, a socket file already at the path is probed with one connect. A connect that completes is a live server, and the new one refuses with `ERR_HEAD_SERVER_RUNNING` at exit 1, naming the live server's pid, ref, and sha. `ECONNREFUSED` is a file with no listener, which is what a server killed with SIGKILL leaves, and it's replaced with a warning. A file that isn't a socket is refused, because nothing here removes a file it didn't make. Two servers started in the same instant can both probe a stale file before either binds, so a supervisor starts one server per store.

### Protocol

The protocol is JSON over HTTP/1.1 on the endpoint, served by `@effect/platform-node`'s `NodeHttpServer` and asked by `node:http` with an agent that dials the socket. Both are imported only when used, because the package's barrel costs about half a second of imports every other command would pay. Every route is under `/v1/` (`HEAD_PROTOCOL`), and a new version is a new prefix. Request bodies are decoded with Effect Schema with excess properties refused, the way the CLI refuses an unknown flag. A body that doesn't decode is 400 with the CLI's failure envelope (`ERR_INVALID_FLAG`), an unknown route is 404 (`ERR_UNKNOWN_COMMAND`), and a failure while answering is 500 with the envelope `failureFor` builds.

| route                | body                                                         | answer                                                                                                                            |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`     | none                                                         | the server's pid, root, endpoint, ref, sha, record counts, load source, advances, requests, uptime, vectors, embed, and exec pool |
| `POST /v1/search`    | `{ query, limit?, now?, embedDeadlineMs?, scope?, detail? }` | `{ query, hits, vector, searchMs, head, scope? }`, the fields `head search` returns                                               |
| `POST /v1/read`      | `{ path }`                                                   | `{ record, head }`, with `record` set to `null` for a path the version lacks                                                      |
| `POST /v1/neighbors` | `{ sha, ops, lines, at, runBound? }`                         | what `session put` computes before it appends (`preparePuts`), at the version `sha` names                                         |
| `POST /v1/exec`      | `{ id, script, lang, timeoutMs?, runBound? }`, at most 1 MiB | `{ served: true, base, outcome, head }`, or `{ served: false, reason, detail }`                                                   |
| `POST /v1/commit`    | `{ id, message, dropRefused? }`                              | `{ served: true, base, outcome, head }`, or `{ served: false, reason, detail }`                                                   |
| `POST /v1/rebase`    | `{ id }`                                                     | `{ served: true, outcome, head }`, or `{ served: false, reason, detail }`                                                         |

`head` in an answer is `{ sha, ref, records, skipped }`, the version the answer was computed over. The search body is `searchHead`'s input object passed through whole, so an option `searchHead` gains later is one more optional field. `neighbors` is judged at the session's base, because `session put` judges its puts against the version the session sees. The server builds that version from the one it holds by the same tree diff an advance uses, and runs `preparePuts`, the function `session put` runs locally, so the two paths answer identically. The append always happens in the client, under the session's lock.

### Consistency

An answer is never older than the ref at the moment of the request. Every request reads the ref first (one `rev-parse`, a few milliseconds) and, when it moved, advances the held version with `advanceHead` before it answers. A background poll (`--poll-ms`, default 1000, `0` turns it off) does the same between requests, so a request usually finds the version already advanced. Advances hold one permit: two never run at once, and a request that arrives during one waits for it and answers from its result. Inside the permit the ref is read again, so a waiter never moves the version back. Each advance cuts the new version's `parent` pointer, so the server holds one version rather than a chain of every delta it has seen. After an advance the new version's snapshot is written in the background, best-effort, and skipped when the file exists. A ref that stops resolving leaves the server answering at the last version it held, with a warning per request.

The server holds the vector cache it read before it bound and `stat`s the file before every answer that uses it and after every poll. A changed inode, size, or mtime is read again under a permit of its own, so a `head embed` run while the server is up takes effect on the next request with no restart.

### Commit and rebase

`session commit` and `session rebase` ask the server first (`--server`, on by default; `--no-server` keeps the local path). `/v1/commit` takes `{ id, message, dropRefused? }`, reads the session's log itself, and builds the version at the session's base: the tip it holds, an ancestor built by the tree diff, or, for a base off the ref's history, a version loaded the way `loadHeadAt` loads one. Then `commitOverHead`, the function the CLI's local path runs, validates, commits, and swaps the ref. The server reads the store's policy per request and passes its write bar to the commit, and `session commit` reads the policy before it asks, so a malformed file fails with `ERR_STORE_CONFIG` on either path. `/v1/rebase` moves a session's base to the held tip after the advance check every answer makes.

The server runs one commit or rebase at a time. One that waits more than 20 s to start (`COMMIT_QUEUE_WAIT_MS`) is declined `busy` having done nothing, and a commit that started runs to its end whatever interrupts its request, so the ref, the log, the held version, and the snapshot never part ways. A committed outcome moves the held version to the new commit and writes its snapshot before the answer, so the next request pays no advance. A served answer is `{ served: true, base: "tip" | "ancestor" | "loaded", outcome, head }`. A declined one is `{ served: false, reason: "other-ref" | "session-unreadable" | "base-unservable" | "busy", detail }`.

The CLI commits locally when no server answers, when the server answers a 4xx (a server older than the route, or a body it refused), and when it declines. It fails with `ERR_STORAGE` and doesn't retry locally when the server took the request and then answered 5xx, or gave no answer within `MEMHTML_COMMIT_DEADLINE_MS` (default 60,000, `0` for no bound, a malformed value exits 2). In those cases the ref may already have moved, so the caller reads `session status`, and zero ops there means the commit landed. Both commands report `via: "server" | "local"` and `server: { used, base, reason, detail }` beside the outcome kinds, which are unchanged.

Measured on a 10,286-record fixture on a shared host: a commit at the tip took 1.2 s through the server, against 3.2 s locally from a snapshot and 7.0 s with no snapshot. Behind the tip (commit, rebase, commit) it took 3.0 s through the server against 9.2 s locally.

### Exec

`session exec` asks the server to run its script (`POST /v1/exec`) unless `--no-server` is passed. The server reads the session's log itself, so the request names only the session, the script, the language, and the bound. The script sees the version at the session's base: the held tip (`base: "tip"`) or a version built from it by the tree diff when the base is an ancestor (`base: "ancestor"`; the last four are kept, shared with `/v1/neighbors`). A base off the ref's history is declined with `base-unservable`, and the client's snapshot path loads it instead. Then `execOverHead` (`apps/cli/src/v2.ts`) overlays the log's ops, runs the script, harvests, judges the log plus the harvest against the base, and appends a clean harvest. The CLI's local path calls the same function, so the two paths answer with one report shape.

just-bash interprets a script on the thread that calls it and yields to microtasks only, so a busy script holds that thread's event loop for as long as it runs. On the server's thread that would stall every search for up to the script's bound. So scripts run in a pool of `worker_threads` workers, each running `guest/sandbox-runner.mjs`, the module the CLI imports in process. The pool size is `MEMHTML_EXEC_POOL_SIZE`, by default the host's available parallelism minus one, between 1 and 4, and each worker's heap limit is `MEMHTML_EXEC_WORKER_HEAP_MB`, by default 2,048 MB. Workers stay warm between jobs, because a fresh worker costs 107 to 130 ms, most of it importing just-bash.

A bash loop ends at its own deadline in the worker. A single command just-bash can't interrupt runs past it, so the pool holds a timer per job at the run's deadline (the bound, plus 2 s of grace under `js`, plus 5 s for seeding and the walk). A job that hasn't answered by then has its worker terminated and is answered as exit 124 with `timedOut: true` and nothing harvested. A worker that dies, from a crash or its heap limit, fails its job with `ERR_STORAGE` and is replaced, so neither a runaway nor an allocation bomb reaches the server's thread or heap.

Two execs of one session run one after the other, so the second reads the log with the first's harvest in it. Execs of different sessions run at once, up to the pool's size. A request waits at most 30 s (`EXEC_QUEUE_WAIT_MS`) for its session's earlier exec, and at most 30 s more for a free worker, and is declined `busy` past either having run nothing. Across processes the log's own write discipline holds: the append reads the log again under the lock and writes only if it still holds the ops the exec read.

The server keeps the seed image of the last two base versions (`IMAGES_KEPT`) in a `SharedArrayBuffer`, which crosses to a worker without a copy, so a call over a base it has seen encodes only the records its overlay rewrote. The request body is capped at 1 MiB (`EXEC_BODY_MAX_BYTES`). A declared length past the cap is answered 413 before a byte is read, a chunked body is refused at the byte that crosses it, and the CLI refuses a script over the cap at exit 2 with or without a server, so a script's fate never depends on whether a server is running.

### The query embed's deadline

A search waits for its query embed at most the request's `embedDeadlineMs`, else the server's `MEMHTML_EMBED_DEADLINE_MS`, else 450 ms (`EMBED_DEADLINE_DEFAULT_MS`), and `0` waits as long as the embed takes. Past the deadline the search answers from the lexical arm with `vector.reason: "embed-timeout"`. The deadline interrupts only the wait: the embed runs in a fiber of its own, and the answer returns at once. An embed still running at its deadline is left to finish when no other late embed is finishing (`LATE_EMBEDS_MAX`, 1), because finishing it completes the slow connection the miss was waiting on, and a second is interrupted. `head search` passes `MEMHTML_EMBED_DEADLINE_MS` to the server when it's set, and its local path applies the same deadline. `session put`'s neighbors embed puts as documents and aren't bounded, because a put isn't on a turn's budget.

A lookup with a 0.8 s share of a 1.5 s budget motivated the bound: on 2026-09-28 the first search after an idle stretch spent 741 ms in the query embed, and the turn got no memory. Measured the same day over the socket with a real proxy, the longest answer fell from 956 ms to 486 ms, no answer took more than 36 ms past the deadline, and 8 of 53 searches answered without the vector arm.

### Keeping the embed path warm

With an embedder, a cache, and `MEMHTML_EMBED_WARM_IDLE_MS` above 0, the server issues one one-token query embed whenever no embed has ended for that long and none is in flight. Every embed the server makes moves the idle clock, so a busy server never warms. The default is 0, so the warmup is off: a deployment whose proxy drops idle connections turns it on, for example at 45,000 ms, at the cost of about 1,900 billed one-token embeds a day per server. A probe on 2026-09-28 found no idle gap up to 900 s that made the first embed slower than the calls straight after it, so the bound is a judgment rather than a measured cliff. The deadline above bounds a slow embed whatever its cause.

### Filling vectors after an advance

A commit that lands while the server runs brings records the vector cache has no vector for, and a record found only by the lexical arm loses to records both arms find. So an advance that brings such records starts a background fill (`fillPass`, `startBackfill`). It embeds the held version's missing hashes 96 at a time (`BACKFILL_BATCH_MAX`, Cohere's per-request ceiling), off every request's path, and writes the result to the cache file the way `head embed` does, so the file and the held cache agree and a restart keeps the vectors. One fill runs at a time, and a trigger during one asks it for another pass, so concurrent advances never embed a hash twice. A cache file removed or refused meanwhile is left that way. A failed batch is retried on the next advance, and also on each warmup tick when the warmup runs, or on each poll when it doesn't. `status` reports `vectors.pending` and `vectors.backfill`.

### Fallback

`head status`, `head search`, and `session put` try the server first, except that `session put` on a curate-scope session always judges locally. They connect with a 100 ms timeout (`CONNECT_TIMEOUT_MS`) and a 10 s answer timeout (`ANSWER_TIMEOUT_MS`), and take the local path whenever no server answers. Any failure in the connect phase, before the request is sent, means no server, whatever the errno (`server.reason: "no-server"`), and so does a socket path past the byte limit. A failure after the server accepted the request stays an error. `askHead` never fails, so a server can make a call faster and never make it fail. `--no-server` skips the server.

`session exec`, `session commit`, and `session rebase` follow the same rules with one exception, because their requests have effects. `session exec` runs locally when the server never took the request, answered anything but 200, or declined. `session commit` and `session rebase` run locally when the server never took the request, answered a 4xx, or declined, and a 5xx answer fails with `ERR_STORAGE`. When the request was sent and no usable answer came back, the server may have appended the harvest or moved the ref, and running again locally could do it twice, so the call fails with `ERR_STORAGE` naming `session status`. `askHeadFor` is the client call that tells these cases apart (`answered`, `no-server`, `refused`, `lost`).

`curate merge`, `curate run`, and `curate collapse` never ask the server. They judge the exact version they commit against in their own process.

### Search and recall on the head

Run sessions commit without touching `.memhtml/index.db`, so the MCP server's `memory_search` and `memory_recall`, which answered from that index, couldn't see a record a run wrote until something ran `memhtml index update`. Measured on 2026-09-30, 60 of the 97 records sessions had written were missing from the index. The head server never lags its ref, so both tools ask it first (`apps/cli/src/head-retrieval.ts`, called from `apps/mcp/src/handlers.ts`) and fall back to the index path. The answer is v1's `SearchResult` or `RecallPack` type exactly, so every field a caller reads is there with the meaning it had.

A call goes to the head unless it names something the head can't answer the way the index would (`routeFor`):

| parameter                                               | route | why                                                                                 |
| ------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `query`, `limit`                                        | head  | the lexical and vector arms                                                         |
| `memory_types`, `workspace`, `tags`, `entity`, `facets` | head  | a record carries every axis, including v1's derived `concept:` and `lang:` entities |
| recall's `budget_chars`                                 | head  | the fold is v1's `foldDisclosure` over the head's candidates                        |
| `include_archived: true`                                | index | the head's arms rank active records only                                            |
| `as_of`                                                 | index | a record carries no validity window                                                 |
| a `"` in `query`                                        | index | the index matches a quoted span as a phrase, and the head's BM25 has no phrases     |
| a query with no term the head indexes                   | index | the head would rank by the vector arm alone                                         |
| `MEMHTML_MCP_HEAD=off` in the MCP server's environment  | index | an operator's switch, read per call                                                 |

A routed call asks `/v1/search` with the 100 ms connect timeout and a 2 s answer timeout (`HEAD_RETRIEVAL_TIMEOUT_MS`), and answers from the index whenever no answer comes. The request's `scope` turns into a predicate the arms apply before their caps (`admitFor` in `apps/cli/src/head-scope.ts`), and a present scope brings v1's default with it: every type but `task` unless the call names types. `detail: true` adds the per-hit fields v1 returns, each computed with v1's own helpers from the record the answer ranked. A server older than these two fields refuses them with 400, so the two servers can be deployed in either order.

What differs is the ranking. The head fuses the lexical and vector arms with recency as the tie-break, while the index also fuses recency and salience arms over every record in scope, demotes negation twins, and diversifies with MMR. So through the head `arms` never reads `salience`, a narrow query can return fewer hits, `vector_coverage` is the share of the head's active records with a vector, and a snippet is the article's opening chunk. Measured 2026-09-30 on a 7,731-record copy of a production store (883 active records), 50 queries agreed on the first hit in 39, found the record a title or phrase came from in the top five for 39 of 40 on the index and 37 on the head, and answered in about a quarter of a second at p50 on both doors.

### Running it

`head serve` is a foreground process that logs to stderr and exits 0 on SIGTERM, so a user service runs it with no wrapper. This example isn't installed anywhere:

```ini
# ~/.config/systemd/user/memhtml-head@.service
# One server per store; the instance name is the store path, escaped with `systemd-escape --path`.
[Unit]
Description=memhtml head server for %f

[Service]
Type=exec
# Absolute paths: a user unit's PATH holds neither a version-managed node nor the memhtml bin.
ExecStart=/path/to/node /path/to/memhtml/dist/memhtml.mjs head serve --repo %f
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

```sh
unit="memhtml-head@$(systemd-escape --path /path/to/store).service"
systemctl --user daemon-reload
systemctl --user enable --now "$unit"
journalctl --user -u "$unit" -f
```

`ExecStart` names an absolute Node 24 and the installed entry point (`dist/memhtml.mjs` in the published package, `apps/cli/dist/bin.js` in a checkout), because a user unit's `PATH` holds `git` and not a version-managed Node. `Restart=on-failure` doesn't fight a refusal loop: a second server exits 1 with `ERR_HEAD_SERVER_RUNNING` only while another is live, and a unit killed with SIGKILL leaves a socket the restart replaces.

### Measurements

Measured 2026-09-27 on a 7,437-record copy of a production store, with the server's snapshot present, on a shared host whose load average stayed between 16 and 22 on 16 cores. `head search` ran 50 different queries, one CLI process each, through the server and locally, interleaved.

| what                                                        | p50 ms | p95 ms |
| ----------------------------------------------------------- | ------ | ------ |
| server start, spawn to the listening line (snapshot load)   | 3121   | 4188   |
| `head search` through the server, including the CLI's start | 840    | 1422   |
| of which the socket round trip                              | 52     | 123    |
| `head search --no-server`, end to end                       | 2637   | 4145   |
| `memhtml manifest`, the CLI's start with no work            | 785    | 1060   |
| `curl --unix-socket` to `/v1/search`                        | 36     | 92     |

A commit picked up by the poll reached the server's advance line in 119 to 971 ms, and each advance took 51 to 102 ms. The server path fits a 1.5 s budget at p50, and the local path doesn't fit at all. Nearly all of what remains is the CLI's own start, so a pre-turn hook that speaks to the socket directly answers in 36 ms at p50. With the vector arm on the same copy, the socket round trip rose to about 260 to 290 ms at p50, almost all of it the query embed, and the fold with the arm took 5 or 6 ms.

## 23. Curation on a branch

A curator is a session on a branch. It works through the same session commands as any other writer, under the `curate` scope because its ref sits under `refs/heads/curate/`, and its first `session commit` creates the branch with a `memhtml(curate): ...` subject. The ref committed to isn't the one `HEAD` points at, so `main` and the checkout don't move. Nothing reaches `main` from a curate ref but `curate merge`, so the reserved paths keep one door.

### The curation door

`curate merge <ref> [--into main] [--skip-gate]` lands a curator branch (`curateMerge` in `apps/cli/src/v2.ts`). Both refs must resolve. A call that fails leaves the repository as it found it, and the head gate (§16) runs before anything moves. `--skip-gate` is a logged override, and the payload's `gate.ran` says which happened.

When the branch descends from `--into`, the landing is a fast-forward. The gate scores the two tips. When `HEAD` is `--into`, the checkout follows before the ref moves, as in the commit path's step 6, and uncommitted state at a touched path is `ERR_DIRTY_TREE`. Then `update-ref` swaps `--into` under the checkout lock, and a lost swap rolls the checkout back and names the new tip.

When `--into` moved past the curator's base, which is the usual case on a store that other writers land on every few minutes, the landing is a replay. A commit on a curate ref is a pure function of overlay ops, so the difference between two trees can be decided back into ops (`reconstructOps` in `apps/cli/src/replay.ts`), and anything that can't was written by hand:

1. The merge base is computed, `git diff-tree` names every path the base and the tip disagree on, and `harvestOps`, the harvester `session exec` uses, turns the difference into puts, archives, head ops, and moves. An archive twin's stamps are applied to the seeded side first, so they don't read as a meta change. Anything else refuses the merge naming the path and the reason, with nothing moved: a file deleted with no twin, an article changed in place, a title or meta changed, or a file that isn't a memory.
2. A session starts on `--into`'s tip with id `merge-<first seven digits of the curate branch's tip sha>` and `force`, so a merge killed partway can run again. The ops are appended with `withRepoints` completing them against that tip, so a record that landed on `main` after the curator ran and cites a moved or archived record's old path gets its edge repointed in the same commit. `validateOps` judges them under the `curate` scope with no batch cap (`MERGE_BATCH_CAP`), because each of the branch's commits already passed the cap and the replay is one commit by design.
3. The head gate scores the tip of `--into` against the branch's tip.
4. `commitSession` lands the ops with the subject `memhtml(curate): <the tip's subject> (replayed onto <short sha>)`, through a rebase-and-retry loop bounded at eight (`MERGE_ATTEMPTS`).
5. The curate ref moves to the landed commit with a compare-and-swap, so a rerun answers `moved: false`.

The payload is `curate.merged`: `{ ref, into, from, to, moved, gate, worktreeSynced, replayed, snapshot }`. `replayed` is `null` on a fast-forward and names the base, the ops by kind, the attempts, and the original tip on a replay. A gate refusal is exit 1 with `ERR_DISCRIMINATION_FAILED` and the MRRs, the floor, and the first inversions in the message.

### The curator

`memhtml curate run` is the curator memhtml owns: a bounded, model-driven tool loop over a curator session, packaged as `@memhtml/curator` and bound to the real head, session, and sandbox by `apps/cli/src/curate-run.ts`. The package takes its tools as an interface (`CuratorTools`), because the sandbox lives in `apps/cli` and a package can't import an app.

The loop is the AI SDK's `generateText` with tools and stop conditions (`packages/curator/src/loop.ts`). It ends on a `finish` call or on a step that carries text and no tool call, whose text is then the report. Every structured thing the model says is a tool's input, because Bedrock rejects `output_config.format` (measured 2026-09-03).

The run starts from a briefing computed by code (`packages/curator/src/briefing.ts`, `inbox.ts`): active and archived counts, the inbox share, the frame-key groups split into `duplicates` (one key, one value) and `contradictions` (one key, several values), the dangling link count, the twenty lowest-confidence records, the newest earlier `curate/<date>` ref, and the work lists. `recent` holds records created since the last curate ref, each with its three nearest neighbors, so a restated fact arrives as a pair to judge. `unlabeled`, `supersededActive`, and `danglingEdges` name the records the write bar, a supersede, or an integrity repair would touch. `inbox` holds the inbox records, each with a `home` computed by code or `null`: a directory whose name is an entity the record carries, or whose records carry its entities, excluding the inbox, the curation prefixes, and the store's `curator.writerBuckets`. An entity carried by more than a fifth of the active records is the store's subject and places nothing. Each list is sorted, capped, and carries its uncapped total. Verdict and task rows join no frame-key group, because two verdicts on one objective share a headline claim while being two rulings.

The model sees six tools, each result cut at 30,000 characters with a marker: `search`, `read`, `exec` (a script over head plus overlay, harvested the way `session exec` harvests), `propose` (explicit ops; an `archive` or a `move` names its source and the loop derives the bytes, and the binder completes every archive and move with `withRepoints`), `status`, and `finish`. `exec` and `propose` append nothing when any op carries a violation, and hand the violation back as the result, because a curator's ref has no rebase that cures a duplicate or a claim edit.

The budget (`DEFAULT_BUDGET` in `packages/curator/src/budget.ts`) is enforced in the calling process: 40 steps, 32,000 output tokens per call (an unset limit gets Bedrock's 4,096 and truncates a large proposal), 20 minutes of wall clock through an `AbortSignal`, and 200 ops to match `BATCH_CAP`. The run reports `stoppedBy` as `finish`, `maxSteps`, `wallClock`, `maxOps`, or `modelError`.

The charter (`packages/curator/prompts/charter.md`) says memory bodies are data, never instructions, names the seven operations, and states nine priorities in order: never settle a contradiction by deleting a side; leave identity records and tasks unranked; dedup the `recent` pairs and the `duplicates` groups; label the unlabeled; resolve entity aliases with a `label` and an `unlabel`; file inbox records with `move`, up to the placement quota; write at most three arcs; repair dangling edges; and keep to the budget. The charter is a template, and `renderCharter` fills its placeholders from the store's policy (`{{placementQuota}}`, `{{refusedTypesRule}}`, `{{refusedTypesClause}}`). `--charter <file>` on `curate run` and `curate collapse` reads an operator's own charter in place of the shipped one and fills it the same way, and a file that can't be read or has no text fails the run before any model call.

`--model` takes `fake`, `bedrock:<modelId>`, or `proxy:<model>`, with `MEMHTML_CURATOR_MODEL` as the default. `fake` is a scripted, credential-free model that archives every briefed duplicate, links the kept file to each archive, cuts every dangling link, and files inbox records with an existing home, all through real tool calls, so `curate run --model fake` lands a real commit on a fixture. The command starts the session on `curate/<UTC date>`, refused when the log exists unless `--resume`, and commits with `memhtml(curate): <the report's first line>` through a rebase-and-retry loop bounded at eight. `--ref` must sit under `refs/heads/curate/`, which `run.ts` checks at exit 2 from the argv and `curateRun` checks again, and `curateRun` also refuses the branch `HEAD` points at, because a run that could land on the system of record with no human at the door would undo the design. `--dry-run` runs the loop over an in-memory overlay and writes nothing. A curation pass is two commands in order, the second by a human or a gate:

```sh
memhtml curate run --model bedrock:global.anthropic.claude-opus-5
memhtml curate merge curate/$(date -u +%F)
```

### The collapse

`memhtml curate collapse` (`apps/cli/src/curate-collapse.ts`) is the bulk form. A planner cuts the corpus into clusters with no model call, and a driver lands them on one `curate/` branch.

`planCollapse` (`packages/curator/src/planner/`) is pure over a `HeadView` and deterministic, and its output is plain JSON, so a plan can be saved, read, edited, and replayed with `--plan`. Four cuts run in order, each taking what the earlier ones left:

1. Rulings, when `--rulings` names a JSONL file of `{ path, verdict, theme?, reason? }` lines. A ruling is a human's decision, so it can also admit the record classes the charter shields.
2. Source plus memory type, where the source is the record's `memhtml-author`. An analysis of a production store found this the first-order structure, with most records isolated in every other layer.
3. Frame key within a partition. A group folds only when its members agree in value or in claim. Members with different values are contradiction candidates, kept as a `keep` cluster and never folded. Entities join as a weighted graph layer rather than as hard groups, since a person on dozens of records names a subject rather than a duplicate.
4. A kNN similarity graph over what remains, cut by Louvain community detection (`graphology-communities-louvain` with a seeded generator, so the same view yields byte-identical JSON). Similarity is lexical TF-IDF cosine over the head's own tokens, because the planner makes no model call and a store needn't carry a vector cache. PageRank picks each cluster's anchor.

Archive clusters land with no model in chunks of at most 180, each archive with its repoints, and a chunk closes early rather than pass `BATCH_CAP`; a member whose archive and repoints exceed the cap alone is left active with a warning. Each fold runs one curator session under the collapse charter (`packages/curator/prompts/collapse.md`), briefed by code with the members, the entities the canonical must carry, and one member's whole HTML as the format example. The model writes the canonical `put`, and the driver completes the archives, with their repoints, and the `supersedes` links it left, so every member ends archived and reached from the canonical. Folds run through a bounded pool (`--concurrency`, default 4), and every session lands on the one ref through the rebase-and-retry loop. A cluster's failure is data in its outcome, so one refused fold doesn't stop the others. The default ref is `curate/<UTC date>-collapse`, so a same-day `curate run` never shares a session id with it.

Measured 2026-09-24 on an 8,197-record copy of a production store (2,918 active records), the planner took 733 ms without rulings and 27 ms with 2,918 rulings, and two runs over one view were byte-identical. On the 14-record fixture in `apps/cli/tests/curate-collapse.test.ts` the whole fake-driven run, with one archive cluster, three folds, and four commits, takes about 1.1 s.

## 24. Decisions

Each record states the decision, why it was made, and what follows from it.

### D1. The head is an immutable value with structural sharing

Decision. One version of the corpus is a persistent map from path to record, with persistent indexes, and a new commit makes a new version that shares every untouched record with the old one (§16).

Why. A session needs a stable view for as long as it runs, while other sessions commit. A mutable shared index makes every reader and writer contend for one database, and one slow read stalled a write for 124 s. An immutable version can't change under a reader, and sharing makes a new version cost only the records a commit changed.

Consequences. Advancing re-parses only the changed paths, and a property test holds the sharing to object identity. The server can hold one version for weeks by cutting the parent pointer. A cold start still pays for one full load, which the snapshot (§20) and the head server (§22) bound.

### D2. Sessions over a shared index

Decision. Each writer works in a session: a pointer to one version plus an append-only log of its own operations, landed as one commit through a temporary git index and a compare-and-swap on the ref (§17).

Why. A writer that edits a shared index or a shared working tree sees other writers' half-done state, and two writers that interleave there lose each other's files. A log over an immutable version is private until its commit, a commit is judged against exactly the version it lands on, and git's compare-and-swap settles path conflicts with a rebase.

Consequences. A run writes as many times as it likes and lands once. A conflict is `rebase-needed` and a retry, never a merge of two writers' state. The one shared thing left is the checkout, which every writer of it holds the checkout lock for.

### D3. Curation runs off the write path, behind a human merge

Decision. Judgment (dedup, contradiction, placement, arcs) runs as a curator session on a `curate/<date>` branch, and only `curate merge`, with the head gate and a human or a gate at it, lands it (§23).

Why. A model in the write path makes every write wait on a model and makes a wrong judgment land at once. A branch makes a curation pass a reviewable diff, a gate catches a landing that damages retrieval, and a human stays at the decision that can't be undone.

Consequences. The write path stays mechanical. A curation pass is two commands, `curate run` and `curate merge`. The replay lands a branch onto a target that moved, and refuses anything a hand wrote.

### D4. Policy lives in a store file

Decision. The rules every writer to one store must share (the write bar, the v1 doors, the curator's buckets and quota) live in `memhtml.config.json` at the store root, tracked in git, and the library's own defaults are neutral (§19).

Why. Different deployments want different bars, and a bar in the code would name one deployment's choices. A file in the store travels with every clone, applies to every process that writes to the store, and changes with a reviewed commit.

Consequences. A store with no file runs under neutral defaults. A malformed file fails closed with `ERR_STORE_CONFIG`. The file is read per decision, so an edit applies with no restart, and `memhtml config` shows where each value came from.

### D5. Commits go through the head server

Decision. `session commit` and `session rebase` ask the head server first, and the server commits one session at a time over the version it already holds, then holds the new commit as its head (§22).

Why. A local commit loads the head first, which costs seconds on a large store, and then the server has to advance to the commit anyway. The server already holds the version a session is based on, so it can judge and land the commit in about a second and pay no advance after it.

Consequences. On a 10,286-record fixture a commit at the tip took 1.2 s through the server against 3.2 s locally. The CLI falls back to a local commit whenever the server didn't take the request. When the server took it and the answer was lost, the call fails rather than commit twice, and `session status` says whether it landed.

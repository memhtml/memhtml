---
title: Glossary
description: The project's domain vocabulary, one entry each, with the page that develops the term.
---

## 1. How to read this page

The terms are in alphabetical order, ignoring a leading "The". Each entry defines one term and links to the page that develops it.

Several of these words mean something looser elsewhere. Each entry gives the narrow sense this project uses, and says so when a nearby term is easy to confuse with it.

## 2. Terms

### Arc

A memory of type `arc`: a summary of a pattern that runs across many other memories, usually about how the agent itself works. Sleep's `arc-synthesis` phase writes arcs into `areas/arcs/` when a model is bound, one commit per arc.

No MCP write tool lets an agent name the type, because an agent naming an arc would assert a conclusion the corpus has not earned. On the CLI, `memhtml write` and `memhtml apply` accept it, for curated imports. Retention triage and reprieve never archive an arc, and `search` and `recall` refuse `--type arc`. `recall` gives arcs their own 9,000-character budget, apart from the budget other memories share. See [The sleep pipeline](/internals/the-sleep-pipeline/).

### Archive path

`archive/<YYYY>/<original-path>`, where an evicted memory moves. The year is the year of the eviction, and the original path is kept whole beneath it. So `originalPathFor` gets the original path back by stripping exactly one `archive/<YYYY>/` prefix, and sleep's `integrity` phase can compute where a linked file went from its old path, without comparing file contents.

Two cases bend the rule. If a file already sits at the archive path, because the same path was archived earlier in the same year, `memhtml archive`, `memhtml correct`, and `memhtml task status <path> done` fail with `ERR_GIT`, and the file stays where it was. A sleep phase instead adds `-2`, `-3`, and so on to the file name, and that suffixed path no longer maps back to the original. Archiving a file that is already archived nests a second prefix. See [Store layout and path algebra](/internals/store-layout-and-path-algebra/).

### Authored edge and derived edge

The two kinds of link between memories. An authored edge is a `<link rel="memhtml-…">` element in a memory file's head, written by a caller or by a sleep phase. The index stores it as an `edges` row with `derived = 0`, and a rebuild restores it from the file.

A derived edge exists only as an `edges` row with `derived = 1`. Sleep's `relationship-mining` phase writes these from embedding similarity: `relates_to`, plus `laterally_related` under `--deep`. A rebuild drops them, and the next run mines them again.

The retention score counts only authored contradictions. Every edge also has one of four classes, `memory`, `person`, `provenance`, or `task`, decided by its rel, and the memory-graph queries read only the `memory` class. See [Edge encoding](/internals/edge-encoding/).

### Claim

The one `<mark>` span in a memory's `<article>`: the sentence that states the memory's fact. The format requires exactly one. It must contain text other than code, sit inside the article's first `<p>` or `<li>`, and never sit inside an `<aside>` or a `<details>`.

The claim is stored as `files.gist`. Listings show it, it follows the title in the full-text column, and it opens what `recall` quotes. The frame key, the merge veto's number check, and the polarity step all read it. The write path refuses a file that breaks these rules before writing anything. A hand-written file that breaks them is skipped by the indexer. See [The memory file format](/internals/the-memory-file-format/).

### Code-mode

Answering a question with one script over the memory files instead of one tool call per step. The format's fixed set of elements and meta names, the closed vocabulary, works as a selector API: `article mark` is always the claim, and `link[rel^="memhtml-"]` is always an authored edge.

`memhtml exec` runs such a script in a QuickJS sandbox with no network. It mounts a copy of one commit, read-only, so the script cannot change the memory files. A script you run yourself against the checkout is read-only by convention only, and any write it made would bypass the write path.

A code-mode script works on the files alone, so it has no ranked retrieval: under `memhtml exec`, the gitignored `index.db` is not in the mounted commit. Reading files bumps no access count, because the count moves only when a caller reads or reinforces a named path through memhtml. Run `memhtml search` to find starting paths, then traverse from them in code. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Committed sidecar

`.memhtml/state/access.jsonl`, the committed copy of the state plane's `state.access` table. It holds one JSON line per path: the access count, the reinforcement count, the outcome score, and three timestamps. The corroboration tables in `state.db` are not exported, so the sidecar is not a full copy of the state plane.

Two things write it. The `state-export` phase writes and commits it on the run's branch during a sleep run, and that commit reaches `main` only if the run is merged. `memhtml state export` writes and commits it on whatever branch is checked out, and that commit also takes anything already staged.

The file is byte-stable: rows are in path order, the outcome score is rounded to four decimals, and keys are in a fixed order. An unchanged table therefore produces the same bytes and no commit. An empty table, such as a fresh clone before `memhtml state import`, writes an empty file over the committed rows and commits it.

`memhtml state import` reads the file back into `state.db` in one transaction. Counts merge by taking the larger value, and the outcome score takes the file's value. A line that does not parse is skipped and counted, while a line that breaks a table constraint fails the whole import. Reads and reinforcements recorded after the last export are lost if `state.db` is lost. See [The index plane and the state plane](/internals/index-plane-and-state-plane/).

### Conflict assist and frame key

A frame key is a claim cut down to its subject and relation: the words up to and including its last lowercase `of`, `is`, `in`, `to`, `by`, or `as`, lowercased. "The pool ceiling is 64" and "The pool ceiling is 128" share the key `the pool ceiling is`. A claim gets no key when that part has fewer than three words or the rest has more than six. The rule is in `packages/domain/src/frame.ts`.

The conflict assist is an opt-in report on batch writes: `--detect-conflicts` on `memhtml apply`, and `detect_conflicts` on `memory_write_batch`. It matches each op's key against the active memories in the index that are not tasks, and against earlier ops in the same batch. A match comes back as that op's `conflict` and changes nothing about what is written. If the index lookup fails, the batch still checks its own ops against each other.

An op written as `article_html` gets no report, because its claim is inside the markup and is not read until the store renders it. See [The write path](/internals/the-write-path/).

### Content hash

A `sha256` over the text of a memory's `<article>` alone, with whitespace collapsed except inside `<pre>`. Head edits cannot change it, so stamping metadata never looks like new content. The file records it as `memhtml-content-hash`, but the indexer computes it again rather than trusting that value.

It is the duplicate key. A write whose article hashes the same as an active memory that is not a task gets that memory's path back with `deduped: true`, and no file or commit is made. The lookup reads the index, so it misses a memory the index has not seen yet. The second copy is then committed, a unique index on these hashes refuses its row, and every reindex fails until one of the two is archived, so each later write reports an error after its commit.

The git blob sha of the whole file is a different value: any edit to the file, head included, changes it. See [The memory file format](/internals/the-memory-file-format/).

### Degraded retrieval

A search or recall that ran with fewer than four arms because a precondition was not met. The vector arm needs a query vector, so it drops when no embedder is configured, when the embedder call fails, or when too few chunks have vectors. The salience arm needs the state plane. The full-text arm needs at least one indexable word in the query.

The query still answers from the arms that remain. The response's `degraded` field is true only when the vector arm did not run, and `vectorCoverage` tells a coverage drop from an embedder failure. `search` also lists the arms that ran, in `arms`. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Disclosure fold

How `recall` fits ranked memories into a character budget. In rank order, each memory becomes either a quote or an index line. A quote holds the claim, the `<summary>` headlines, the `<dl>` facets, and the citations, but not the prose, any `<details>` body, or any `<aside>`. An index line holds the path, the title, and the claim.

A memory that does not fit becomes an index line, and the fold moves on, so a shorter memory further down can still be quoted. No entity name appears in more than two quotes. Arcs have their own budget, apart from the `--budget` that other memories share. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Discrimination gate

The quality check that can refuse `memhtml sleep merge`. It generates a fixture corpus and, for each probe memory, wrong copies called controls, each made by adding a negation, changing a number, or adding a variant qualifier. A probe passes when search ranks the memory above every one of its controls. The gate fails when any probe fails, which is called an inversion, or when `mrr` is below 0.85.

The gate measures the ranking code on that generated corpus with a deterministic fake embedder. It does not read your store or the run's branch. `memhtml eval discriminate` runs it by hand. `memhtml sleep merge --skip-gate` skips it and logs a warning. A refused merge returns a success envelope with `merged: false` at exit 0. See [Testing posture](/internals/testing-posture/).

### Eviction

Moving a memory out of the active set with `git mv` to its archive path, in the same commit as at least three head stamps: `memhtml-status` set to `archived`, `memhtml-updated`, and `memhtml-archived`. `memhtml archive`, `memhtml correct`, finishing a task, and several sleep phases all evict this way. Nothing in memhtml deletes a committed memory file.

Because the stamps change a few head lines in the same commit, `git diff -M` reports a rename with a similarity below 100, not `R100`. `git log --follow` still reads through the move. Search, recall, and list leave archived memories out unless `--include-archived` is given. See [The write path](/internals/the-write-path/).

### Four-arm RRF

How memhtml merges its four ranked lists into one, in a single SQL statement. This is reciprocal rank fusion. Each arm that runs adds `weight / (rank + 60)` for every path it returned, with the weight taken from `RANK_ARMS`, and the contributions are summed per path. Ties break on `path` in ascending order, so the order is total and never depends on the order rows arrive in. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### The git tree as system of record

The rule that the facts live in the git repository of memory files. A fact that has to survive deleting `index.db` is written into a file: an authored edge is a `<link>`, metadata is a `<meta>`, and a reprieve count is the `memhtml-reprieves` meta. What `index.db` holds beyond that is bookkeeping, described under Index plane.

`state.db` is the exception, because usage counts are in no file. Its access table is backed up to the committed sidecar, and its corroboration counts are not backed up at all. See [Internals](/internals/).

### Index plane

`.memhtml/index.db`, a gitignored SQLite file. Most of it is computed from the tree: the `files` rows, the full-text index, chunks, vectors, and edges. `memhtml index rebuild` recomputes the rows, the full-text index, chunks, and authored edges from `git ls-tree`, drops mined edges, and keeps the current model's vectors for chunks whose text has not changed. After the file is deleted, vectors come back only when an embedder computes them again.

It also holds tables the tree does not record, which a rebuild leaves alone: sleep run rows, the trace-consolidation watermarks, session links, and the index of session transcripts. Deleting the file loses them. `memhtml sleep merge` and `memhtml sleep resume` then cannot find an earlier run, the next sleep run reads already-distilled sessions again, and `memhtml trace index` has to rescan the transcripts. See [The index](/internals/the-index/).

### Last-wins consolidation

Settling a contradiction by keeping the newer claim and dropping the older one. memhtml never does this on its own, because sometimes the contradiction is the answer. A memory saying that a runbook step changed contradicts the memory stating the old step, and the pair is what tells a later reader that the step moved. So sleep and the conflict assist detect contradictions and leave the choice to a writer or a human.

A caller can ask for it explicitly, one batch at a time: `memhtml apply --consolidate last-wins`, or `consolidate: "last-wins"` on `memory_write_batch`. Among ops that share a frame key, the later value wins and one file is written. At most one stored active memory holding the same key is archived, with a `supersedes` link from the new file, in a second commit. A claim with no frame key is never touched.

This is unrelated to the consolidator, the agent that turns session transcripts into memories. See [The write path](/internals/the-write-path/).

### Memory

One fact in one semantic HTML5 file. The file's repo-relative path is its id, and there is no separate uuid. So a memory that moves gets a new id, and `memhtml resolve` follows an old path forward through an archive move or a `supersedes` link. Each file has exactly one `<article>` and one claim, and its `memhtml-type` meta names one of the types in `MEMORY_TYPES`, 10 as of v0.15.1. See [The memory file format](/internals/the-memory-file-format/) and [Store layout and path algebra](/internals/store-layout-and-path-algebra/).

### MMR

Maximal marginal relevance: a pass that picks each next hit by weighing its relevance against its similarity to the hits already picked, so near-copies do not crowd the top. `search` runs it in TypeScript after fusion, with λ = 0.5, over three times as many candidates as the caller asked for. `recall` does not run it.

Relevance there is 1 divided by the candidate's position in the fused order, after the polarity step, which moves down a near-copy that is negated where the query is not, or the reverse. Positions are used because fused scores cannot be compared across queries. A candidate with no vector is never penalized for similarity. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### `mrr` and `corpusMrr`

Two mean-reciprocal-rank numbers in the discrimination report, measured over different sets. `mrr` ranks each probe's target only against that probe's own controls, and the gate requires at least 0.85. `corpusMrr` ranks the target against the whole fixture corpus and is reported, never gated, because the fixture's size moves it more than ranking quality does. See [Testing posture](/internals/testing-posture/).

### PARA

The four fixed top-level directories of a store, `projects`, `areas`, `resources`, and `archive`, named in `PARA_BUCKETS`. The scheme comes from the PARA method of organizing personal files. Archived state is read from the path: the index treats any file under `archive/` as archived, whatever its `memhtml-status` meta says. See [Store layout and path algebra](/internals/store-layout-and-path-algebra/).

### Projection

A copy computed from the tree that can be deleted and computed again. The memory tables of `index.db` are one. `projectFile` is the pure function that turns one parsed file, with its path and blob sha, into its rows. Rebuild and incremental update both call it, which is why a fresh rebuild produces the same rows as a series of updates, apart from their index timestamps. See [The index](/internals/the-index/).

### Retention triage and reprieve

Two separate sleep phases that can archive a memory. Neither one touches an arc or a task.

Retention triage scores each active memory on the eight signals of `SIGNAL_NAMES`: recency, access frequency, confidence, PageRank, bridge importance, reinforcement count, content density, and contested status. The weights depend on the memory type. A score of 0.3 or lower is the evict band, and those memories are archived.

Reprieve handles memories whose `memhtml-valid-until` date has passed. Such a memory stays valid until 14 days after the run's date, and its `memhtml-reprieves` count goes up by one, when its reprieve score is at least 0.5 and it has had fewer than three reprieves. The score sums importance, access, outcome, and recency of use. Otherwise the memory is archived. See [The sleep pipeline](/internals/the-sleep-pipeline/).

### RRF arm

One ranking source in the retrieval registry, `RANK_ARMS`: `fts` (full-text), `vector`, `recency`, or `salience`. An arm returns only `(path, rank)`, with rank counted from 1. It carries a weight and its preconditions, which are a query vector, the state plane, or an indexable query term. An arm whose precondition is unmet is left out of the statement. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Salience arm

The arm that ranks by use. It reads `state.access` from the attached `state.db` in the same SQL statement as the other arms, and sums three terms. The first decays with the hours since the last access, or since the file's `memhtml-updated` stamp when there was no access. The second is the natural log of one plus the access count. The third is the outcome score, with negative values counted as zero.

It returns no row for a task or for anything under `resources/people/`, because salience would reward a stale task and fade a person's identity. Those files can still rank through the other three arms. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Sleep

The curation run, started with `memhtml sleep run`. It creates a branch named `sleep/<YYYY-MM-DD>` from the current commit, adding `-2`, `-3`, and so on for another run on the same date. It runs the sleep phases on that branch and stops for review. The run never commits to `main`.

`memhtml sleep merge` lands the branch on `main` after the discrimination gate passes. It refuses when `main` has since changed a path the run also changed. Deleting the branch with `git branch -D` discards the run's commits, but not what the run wrote to `index.db` and `state.db`.

Nothing in memhtml starts a run. The caller decides when, and `memhtml sleep plan` reports from index counts whether a run would change anything, or `unknown` when it cannot tell. Sleep is not an MCP tool.

A run does not lock the store, so any other write made while the sleep branch is checked out commits onto that branch. See [The sleep pipeline](/internals/the-sleep-pipeline/).

### Sleep phase

One step of a sleep run: the phases of `SLEEP_PHASES`, 17 as of v0.15.1. They run in that order.

A phase makes zero, one, or several commits. `preflight` and `relationship-mining` never commit, as `NON_COMMITTING_PHASES` records. Any other phase commits only when it staged a change, and `arc-synthesis`, `compress`, and `trace-consolidation` can commit more than once. Each phase commit carries `Memhtml-Run`, `Memhtml-Phase`, and `Memhtml-Counts` trailers.

What each phase gets is failure isolation, not one commit. A phase that fails is recorded as failed, and any commits it already made stay. Its uncommitted file changes are undone as far as git allows, but its writes to `index.db` and `state.db` are not. The later phases still run, except those that depend on it: a failed `preflight` skips every later phase, and a failed `dedup-merge` skips `compress` and `retention-triage`.

`memhtml sleep resume` reruns every phase that has no trailer on the branch. So a phase that finished without committing runs again, and a phase that failed after its first commit is skipped. See [The sleep pipeline](/internals/the-sleep-pipeline/).

### State plane

`.memhtml/state.db`, gitignored like the index but not computed from the tree, so no rebuild can reproduce it. It is attached to the index's SQLite connection as the `state` schema.

It holds three tables. `state.access` has, per path, the access count, the reinforcement count, the outcome score, and when the memory was last read and last reinforced; Learn pages call it the access plane. `state.edge_corroboration` counts the separate run dates on which each machine-proposed contradiction was detected. `state.entity_corroboration` does the same for model-proposed entity merges.

Only `state.access` has a durable copy, the committed sidecar. The corroboration counts have none, so losing `state.db` starts them over. Reprieve counts are not here: each is the `memhtml-reprieves` meta in its memory file. See [The index plane and the state plane](/internals/index-plane-and-state-plane/).

### Task

A memory of type `task`: a piece of work rather than a fact. Its claim states what done means. It carries `memhtml-task-status`, one of `todo`, `doing`, `blocked`, or `done`, and may carry a `memhtml-due` deadline. Task files live under `projects/<slug>/tasks/` or `areas/inbox/tasks/`.

Much of the system leaves tasks out on purpose. Search and recall skip them unless `--type task` asks for them, the salience arm never ranks them, and two identical tasks are never merged as duplicates. No sleep phase scores a task or merges one. Some phases write task files of their own, for example to ask a human to review a decision they declined to make, and may later close one, which archives it. `memhtml task status <path> done` also archives a task. See [The memory file format](/internals/the-memory-file-format/).

### The three write doors

The three ways to write a memory: the CLI (`memhtml write`, `memhtml apply`, and the other write commands), the MCP server's write tools, and your own file tools editing the checkout. All three land in the same git tree.

The first two go through the store, which checks the format, picks a free path, looks for a duplicate (not on a correction), and makes the commit. With the third, all of that is yours: check the file with `memhtml read`, pick a path that does not collide, notice duplicates, and commit. A sleep run whose `preflight` finds an uncommitted edit commits nothing. See [Internals](/internals/) and [The write path](/internals/the-write-path/).

### Watermark

A record of how far a process has already read, so that the next pass reads only what changed. Three different watermarks share the word.

`index_state.head_sha` in `index.db` is the commit the index describes. `memhtml index update` diffs from it to `HEAD`, and `indexFresh` is true when it equals `HEAD`. With no watermark row, `update` runs a full rebuild. A rebuild that stopped after emptying the tables leaves `update` failing with `ERR_INDEX_STALE` until a rebuild finishes.

`trace_watermarks` records, for each session transcript, its size, its modification time, and a byte offset, so the trace indexer reads only appended bytes, unless the file shrank or was rewritten.

`trace_consolidations` marks the sessions that sleep's `trace-consolidation` phase has already read. A run records these marks in its pending-mark ledger, and `memhtml sleep merge` writes them after the branch lands. So a discarded run leaves its sessions to be read again, and so does a merge whose write of the marks fell short. See [The index](/internals/the-index/) and [The trace indexer](/internals/the-trace-indexer/).

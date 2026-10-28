---
title: Glossary
description: The project's domain vocabulary, one entry each, with the page that develops the term.
---

## 1. How to read this page

The terms are alphabetical, and each entry names the page that develops it. Several of them mean something looser in the wider literature, so each definition states the narrow sense this project uses and, where a neighboring term is easy to confuse with it, says which one it is.

## 2. Terms

### Archive path

`archive/<YYYY>/<original-path>`, the destination of an eviction. It mirrors the original path whole, so the mapping is injective and `originalPathFor` recovers the source path exactly. A path archived again while its year's slot is held goes to `archive/<YYYY>.<n>/<original-path>`, the year's first free generation, so an archive never writes over an earlier one. See [Store layout and path algebra](/internals/store-layout-and-path-algebra/).

### Checkout lock

`.memhtml/checkout.lock`, the lock every writer of the shared git index holds while it stages and commits: each v1 write, each session commit, and the `curate merge` fast-forward. A writer waits up to 15 seconds for it and then fails with `ERR_STORAGE` (`checkout.locked`), having written nothing unless it is `doctor --fix` or `task status <path> done`. See [Sessions and the commit path](/internals/sessions-and-the-commit-path/).

### Claim

The single `<mark>` span in a memory's `<article>`: the one sentence the memory exists to state. It becomes `files.gist`, the first field of the search surface, the first disclosure line, and the span a correction targets. Exactly one per file, in the first `<p>` or `<li>`. See [The memory file format](/internals/the-memory-file-format/).

### Code-mode

Reading the corpus with an HTML parser and a script instead of a chain of tool calls, using the closed vocabulary as a selector API. It is read-only by contract, sees the structural and lexical planes only, and bumps no access row, because salience counts the deliberate open of a named path and a script's traversal is a scan. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Committed sidecar

`.memhtml/state/access.jsonl`, the only durable copy of the state plane's access rows. It is byte-stable, path-ordered, and four-decimal, and `memhtml state export` rewrites and commits it, so an unchanged plane commits nothing. See [The index plane and the state plane](/internals/index-plane-and-state-plane/).

### Conflict assist and frame key

The propose-only report on `memory_write_batch`. It reduces each op's claim to a frame key (`packages/domain/src/frame.ts`) and matches that key against active non-task memories and against the batch's own earlier ops; a match surfaces as a per-op `conflict` and changes nothing about the write. The assist stays silent on the `article_html` path, where the claim is extracted on the first index pass and so cannot be keyed at write time. See [The write path](/internals/the-write-path/).

### Content hash

`sha256` over the whitespace-normalized text of `<article>` alone, with `<pre>` taken verbatim. It is the dedup key, and it is invariant under head edits by construction. The git blob sha of the whole file is a different key, the one the indexer uses to detect change. See [The memory file format](/internals/the-memory-file-format/).

### Curator

The model-driven loop `memhtml curate run` starts on a `curate/<date>` branch. It works from a briefing code computes, proposes session operations within a step, time, and operation budget, and commits only to its branch, so the run never moves `main` and `memhtml curate merge` lands its work. See [Curate the corpus](/learn/operations/curate-the-corpus/).

### Degraded retrieval

The state in which memhtml dropped one or more arms because a precondition was unmet: no query vector, no state plane, or no indexable query term. The search is narrower and the response carries `degraded`. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Disclosure fold

`recall`'s budgeted pack, whose three tiers map onto the HTML structure rather than onto a truncation of prose. It spends a character budget in rank order, continues past a candidate that does not fit, and caps full quotes at two per entity name. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Discrimination gate

The refusable quality gate. It asks whether the retrieval stack ranks a memory above its own mechanically derived high-cosine wrong twin, and one inversion fails the run regardless of the aggregate. See [Testing posture](/internals/testing-posture/).

### Eviction

Retiring a memory by `git mv` into the archive path, plus the stamps that record it. No file is deleted, so `git log --follow` reads through a memory's whole life and `diff -M` reports the move as `R100`. See [The write path](/internals/the-write-path/).

### Four-arm RRF

The fusion of the four arms in one SQL statement: weighted `1/(rank + 60)` contributions summed per path, with ties broken on `path ASC` so the ordering is total and reproducible. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### The git tree as system of record

The invariant that the repository of HTML files is authoritative and everything else is derived from it: anything that has to survive `rm index.db` lives in a file. See [Internals](/internals/).

### Head

The parsed corpus at one commit, held in memory as an immutable version: a persistent map from path to record plus the indexes search needs. The session commands, `head search`, and the head server all read a head, and none of them opens `index.db`. Advancing to a new commit shares every untouched record with the version before it. See [Sessions and the commit path](/internals/sessions-and-the-commit-path/).

### Head gate

The check `memhtml curate merge` runs before it moves anything. It searches a seeded sample of up to 200 records by title at the target branch's tip and at the curate branch's tip, and refuses with `ERR_DISCRIMINATION_FAILED` when the curate branch's mean reciprocal rank falls more than 0.02 below the target's or the inversion count grows. It's a different gate from the discrimination gate, which measures the ranking code over a generated fixture. See [Curate the corpus](/learn/operations/curate-the-corpus/#the-head-gate).

### Head server

`memhtml head serve`, a long-running process that keeps one store's head loaded and answers the session and head commands over `.memhtml/head.sock`. Every command that asks it falls back to loading the head itself when it can't answer. See [Run a head server](/learn/operations/run-a-head-server/).

### Index plane

`.memhtml/index.db`: gitignored, and holding the projected rows, the full-text index, the vectors, the edges, and the trace tables. Its memory rows are rebuildable from `git ls-tree`; the trace tables are not. See [The index](/internals/the-index/).

### Last-wins resolution

Resolving a contradiction silently in favor of the newer memory. memhtml doesn't do it, because sometimes the contradiction itself is the answer. A batch reports a contradiction through the conflict assist, a session commit links a frame-key rival with `memhtml-contradicts`, and both claims stay live until a writer or a person decides. 0.16 removed `memhtml apply --consolidate last-wins`, the opt-in that applied this policy to a batch. See [The write path](/internals/the-write-path/).

### Memory

One fact in one semantic HTML5 file, identified by its repo-relative path, with no separate uuid, and carrying exactly one `<article>` and one claim. See [The memory file format](/internals/the-memory-file-format/).

### MMR

Maximal marginal relevance, a diversification pass that picks each next hit by balancing its relevance against how similar it already is to the hits picked so far. memhtml applies it greedily in TypeScript after fusion at λ = 0.5, with fusion rank standing in for relevance, because RRF scores are incomparable across queries. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### `mrr` and `corpusMrr`

Two different coordinate spaces, which is why the two field names exist. `mrr` is measured in the space of one probe's target plus that probe's own controls, and it is gated against a floor of 0.85. `corpusMrr` is measured against the whole corpus and is reported, never gated: it is low by construction on a fixture holding many near-identical memories, so reading it as a retrieval defect confuses the two spaces. See [Testing posture](/internals/testing-posture/).

### Overlay operation

One entry in a session's log: `put`, `archive`, `move`, `link`, `unlink`, `label`, or `unlabel`. The last four edit a record's head and never its article, so the record keeps its content hash. See [Sessions and the commit path](/internals/sessions-and-the-commit-path/).

### PARA

The four fixed top-level buckets: `projects`, `areas`, `resources`, and `archive`. `archive` is a bucket rather than a status field, because the path itself records the state. See [Store layout and path algebra](/internals/store-layout-and-path-algebra/).

### Projection

A derived, disposable representation of the tree. The index is one, and `projectFile` is the pure function that produces its rows, so a rebuild and an incremental update write the same rows from the same bytes. See [The index](/internals/the-index/).

### Replay

How `memhtml curate merge` lands a curator branch once `main` has moved past the branch's base. The branch's changes are read back as session operations and committed as one new commit on `main`'s tip, and the merge refuses with nothing moved when a change isn't an operation or collides with what `main` gained. See [Curate the corpus](/learn/operations/curate-the-corpus/#land-it-with-curate-merge).

### RRF arm

One ranking source in the retrieval registry. It returns exactly `(path, rank)` with rank 1-based, and carries a weight and a precondition, so adding a fifth arm is a table entry and dropping one is a filter. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Run session

The session an agent runtime binds to a whole run by exporting `MEMHTML_SESSION` to every subprocess. Every `session` command defaults to it, the first write starts it, and the store's default policy closes the v1 record doors in that process. The runtime commits it once when the run ends. See [Write through a session](/learn/operations/write-through-a-session/#bind-a-whole-run-with-memhtml_session).

### Salience arm

The arm that reads the state plane over the ATTACH: decayed recency of use, log access count, and a clamped outcome score. It excludes tasks and `resources/people/`, where salience would reward a stale task and decay a person's identity. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Session

A pointer to one version of the corpus plus an ordered log of its own operations, stored at `.memhtml/sessions/<id>.json`. Nothing reaches git until `memhtml session commit` lands the whole log as one commit, or answers `refused`, `rebase-needed`, or `worktree-dirty`. See [Write through a session](/learn/operations/write-through-a-session/).

### Snapshot

`.memhtml/snapshots/<sha>.arrow`, a cached copy of the head at one commit, written by each session commit and `curate merge`. Loading from a snapshot skips the git read, and a snapshot that fails to read is treated as a cache miss. The directory keeps the newest four. See [Sessions and the commit path](/internals/sessions-and-the-commit-path/).

### State plane

`.memhtml/state.db`: gitignored like the index, and not rebuildable from the tree. It holds access counts, reinforcement counts, the outcome EWMA, and edge and entity corroboration, and only its access rows have a committed copy. See [The index plane and the state plane](/internals/index-plane-and-state-plane/).

### Store policy

`memhtml.config.json` at the store root, tracked in git and read from the working tree at every decision. It sets the write bar's refused types and anchor rule, the v1 doors mode, and the curator's writer buckets and placement quota. A file that doesn't decode stops every command that needs it with `ERR_STORE_CONFIG`. See [Set the store policy](/learn/operations/set-the-store-policy/).

### v1 doors

The commands that create a record straight in the store with no write bar: `memhtml write`, `apply`, `correct`, `task add`, and the MCP `memory_write`, `memory_write_batch`, and `memory_correct` tools. The store policy's `v1Doors` key decides whether they stay open, and by default they close only inside a run session. See [Set the store policy](/learn/operations/set-the-store-policy/#v1doors).

### Vector cache

`.memhtml/vectors/<model>@<dimension>.arrow`, one vector per article content hash, which the head's vector arm ranks with. `memhtml head embed` fills it and a running head server keeps it current. It's rebuildable and gitignored. See [Run a head server](/learn/operations/run-a-head-server/#keep-the-vector-arm-covered).

### The write doors

The CLI, the MCP server, your own file tools, and a session. All four are legitimate and all four land in the same tree. The file tools hand the caller everything the write path would have done: format validity, path choice, dedup, and the commit. A session is the one door the store's write bar judges. See [The write path](/internals/the-write-path/) and [Sessions and the commit path](/internals/sessions-and-the-commit-path/).

### Write bar

The rule for what a session may commit as a memory. Its fixed half refuses a malformed file, a duplicate, a put over an active record with a different article, a reserved path, and more than 200 operations. Its configurable half is `writeBar` in the store policy, which can refuse whole types and require every record to name its subject. See [Write through a session](/learn/operations/write-through-a-session/#the-write-bar).

### Writer bucket

A directory whose name says who wrote a record rather than what it's about, such as an importer's `*-import` directory. The store policy's `curator.writerBuckets` lists them as globs, and the curator never files a record into one. See [Set the store policy](/learn/operations/set-the-store-policy/#curator).

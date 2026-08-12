---
title: Glossary
description: The project's domain vocabulary, one line each, with the page that develops the term.
---

## 1. How to read this page

Twenty-five terms, alphabetical. Each definition is one line and each names the page that develops it;
where a term is easy to confuse with a neighbouring one, the definition says which. Every term here is
used in its narrow project sense — several of them mean something looser in the wider literature, and the
looser reading is what the definition is guarding against.

## 2. Terms

### Archive path

`archive/<YYYY>/<original-path>`, the destination of an eviction, mirroring the original path whole so the
mapping is injective and `originalPathFor` is its left inverse. See [Store layout and path
algebra](/internals/store-layout-and-path-algebra/).

### Claim

The single `<mark>` span in a memory's `<article>` — the one load-bearing sentence, which becomes
`files.gist`, the first field of the search surface, the first disclosure line, and the span a correction
targets. Exactly one per file, in the first `<p>` or `<li>`. See [The memory file
format](/internals/the-memory-file-format/).

### Code-mode

Reading the corpus with an HTML parser and a script instead of a chain of tool calls, over the closed
vocabulary as a selector API. Read-only by contract, structural and lexical planes only, and it bumps no
access row because it is not a chosen open. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Committed sidecar

`.memhtml/state/access.jsonl`, the state plane's only durable copy — byte-stable, path-ordered,
four-decimal, and committed once per night by the sleep cycle, so an unchanged plane commits nothing. See
[The index plane and the state plane](/internals/index-plane-and-state-plane/).

### Conflict assist and frame key

The propose-only report on `memory_write_batch`: each op's claim is reduced to a **frame key**
(`packages/domain/src/frame.ts`) and matched against active non-task memories and the batch's own earlier
ops, and a match surfaces as a per-op `conflict` while nothing about the write changes. The assist is
silent on the `article_html` path, where the claim is extracted on the first index pass and so cannot be
keyed at write time. See [The write path](/internals/the-write-path/).

### Content hash

`sha256` over the whitespace-normalized text of `<article>` alone, `<pre>` verbatim — the dedup key, and
invariant under head edits by construction. Distinct from the git blob sha of the whole file, which is the
indexer's change key. See [The memory file format](/internals/the-memory-file-format/).

### Degraded retrieval

The state in which one or more arms were dropped because a precondition was unmet — no query vector, no
state plane, no indexable query term — so the search is narrower rather than failed, and the response
carries `degraded`. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Disclosure fold

`recall`'s budgeted pack, whose three tiers map onto the HTML structure rather than onto a truncation of
prose: it spends a character budget in rank order, continues past a candidate that does not fit, and caps
full quotes at two per entity name. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Discrimination gate

The refusable quality gate asking whether the retrieval stack ranks a memory above its own mechanically
derived high-cosine wrong twin; one inversion fails the run regardless of the aggregate. See [Testing
posture](/internals/testing-posture/).

### Eviction

Retiring a memory by `git mv` into the archive path plus stamps — never a delete, so `git log --follow`
reads through a memory's whole life and `diff -M` reports the move as `R100`. See [The write
path](/internals/the-write-path/).

### Four-arm RRF

The fusion of the four arms in one SQL statement: weighted `1/(rank + 60)` contributions summed per path,
ties broken on `path ASC` so the ordering is total and reproducible. See [Four-arm
retrieval](/internals/four-arm-retrieval/).

### The git tree as system of record

The invariant that the repository of HTML files is authoritative and everything else is derived: anything
that must survive `rm index.db` lives in a file. See [Internals](/internals/).

### Index plane

`.memhtml/index.db` — gitignored, rebuildable from `git ls-tree`, holding the projected rows, the FTS
index, the vectors, and the derived edges. See [The index](/internals/the-index/).

### Last-wins consolidation

The policy this system refuses: silently resolving a contradiction in favour of the newer memory.
Sometimes the contradiction *is* the answer, so detection is automatic while resolution stays with a writer
or a human. See [The write path](/internals/the-write-path/).

### Memory

One fact in one semantic HTML5 file, identified by its repo-relative path — there is no separate uuid — and
carrying exactly one `<article>` and one claim. See [The memory file
format](/internals/the-memory-file-format/).

### MMR

Maximal marginal relevance, applied greedily in TypeScript after fusion at λ = 0.5, with fusion *rank*
standing in for relevance because RRF scores are incomparable across queries. See [Four-arm
retrieval](/internals/four-arm-retrieval/).

### `mrr` and `corpusMrr`

Two different coordinate spaces, which is why the two field names exist. `mrr` is measured in the space of
one probe's target plus its own controls and gated against a floor of 0.85; `corpusMrr` is measured against
the whole corpus and is **reported, never gated** — low by construction on a fixture holding many
near-identical memories, so reading it as a retrieval defect confuses the two. See [Testing
posture](/internals/testing-posture/).

### PARA

The four fixed top-level buckets — `projects`, `areas`, `resources`, `archive` — where `archive` is a
bucket rather than a status because the path itself records the state. See [Store layout and path
algebra](/internals/store-layout-and-path-algebra/).

### Projection

A derived, disposable representation of the tree: the index is one, and `projectFile` is the pure function
that produces its rows, which is what makes a fresh rebuild reproduce the incremental row set. See [The
index](/internals/the-index/).

### Retention triage and reprieve

The nightly eviction decision and its appeal: triage archives EVICT-band files by the eight-signal
retention score, and reprieve extends a bounded validity instead, up to a capped number of times. See [The
sleep pipeline](/internals/the-sleep-pipeline/).

### RRF arm

One ranking source in the retrieval registry, returning exactly `(path, rank)` 1-based, with a weight and a
precondition — so adding a fifth is a table entry and dropping one is a filter. See [Four-arm
retrieval](/internals/four-arm-retrieval/).

### Salience arm

The arm reading the state plane over the ATTACH — decayed recency of use, log access count, and a clamped
outcome score — excluding tasks and `resources/people/` because salience there would reward staleness and
decay an identity. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Sleep phase

One of the fifteen ordered curation steps, each an isolated commit on a `sleep/<date>` branch carrying
machine-readable trailers, so a failure is contained and a resume reads what is already done out of `git
log`. See [The sleep pipeline](/internals/the-sleep-pipeline/).

### State plane

`.memhtml/state.db` — gitignored like the index but **not** rebuildable from the tree, holding access
counts, reinforcement counts, the outcome EWMA, reprieve bookkeeping, and edge corroboration. See [The
index plane and the state plane](/internals/index-plane-and-state-plane/).

### The three write doors

The CLI, the MCP server, and your own file tools — all legitimate, all landing in the same tree, with the
third handing the caller what the write path would have done: format validity, path choice, dedup, and the
commit. See [The write path](/internals/the-write-path/).

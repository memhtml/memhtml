---
title: Glossary
description: The project's domain vocabulary, one entry each, with the page that develops the term.
---

## 1. How to read this page

The terms are alphabetical, and each entry names the page that develops it. Several of them mean
something looser in the wider literature, so each definition states the narrow sense this project
uses and, where a neighboring term is easy to confuse with it, says which one it is.

## 2. Terms

### Archive path

`archive/<YYYY>/<original-path>`, the destination of an eviction. It mirrors the original path whole,
so the mapping is injective and `originalPathFor` recovers the source path exactly. See [Store layout
and path algebra](/internals/store-layout-and-path-algebra/).

### Claim

The single `<mark>` span in a memory's `<article>`: the one load-bearing sentence. It becomes
`files.gist`, the first field of the search surface, the first disclosure line, and the span a
correction targets. Exactly one per file, in the first `<p>` or `<li>`. See [The memory file
format](/internals/the-memory-file-format/).

### Code-mode

Reading the corpus with an HTML parser and a script instead of a chain of tool calls, using the
closed vocabulary as a selector API. It is read-only by contract, sees the structural and lexical
planes only, and bumps no access row, because salience counts the deliberate open of a named path and
a script's traversal is a scan. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Committed sidecar

`.memhtml/state/access.jsonl`, the state plane's only durable copy. It is byte-stable, path-ordered,
and four-decimal, and the sleep cycle commits it once per night, so an unchanged plane commits
nothing. See [The index plane and the state plane](/internals/index-plane-and-state-plane/).

### Conflict assist and frame key

The propose-only report on `memory_write_batch`. It reduces each op's claim to a frame key
(`packages/domain/src/frame.ts`) and matches that key against active non-task memories and against
the batch's own earlier ops; a match surfaces as a per-op `conflict` and changes nothing about the
write. The assist stays silent on the `article_html` path, where the claim is extracted on the first
index pass and so cannot be keyed at write time. See [The write path](/internals/the-write-path/).

### Content hash

`sha256` over the whitespace-normalized text of `<article>` alone, with `<pre>` taken verbatim. It is
the dedup key, and it is invariant under head edits by construction. The git blob sha of the whole
file is a different key, the one the indexer uses to detect change. See [The memory file
format](/internals/the-memory-file-format/).

### Degraded retrieval

The state in which memhtml dropped one or more arms because a precondition was unmet: no query
vector, no state plane, or no indexable query term. The search is narrower and the response carries
`degraded`. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Disclosure fold

`recall`'s budgeted pack, whose three tiers map onto the HTML structure rather than onto a truncation
of prose. It spends a character budget in rank order, continues past a candidate that does not fit,
and caps full quotes at two per entity name. See [Four-arm
retrieval](/internals/four-arm-retrieval/).

### Discrimination gate

The refusable quality gate. It asks whether the retrieval stack ranks a memory above its own
mechanically derived high-cosine wrong twin, and one inversion fails the run regardless of the
aggregate. See [Testing posture](/internals/testing-posture/).

### Eviction

Retiring a memory by `git mv` into the archive path, plus the stamps that record it. No file is
deleted, so `git log --follow` reads through a memory's whole life and `diff -M` reports the move as
`R100`. See [The write path](/internals/the-write-path/).

### Four-arm RRF

The fusion of the four arms in one SQL statement: weighted `1/(rank + 60)` contributions summed per
path, with ties broken on `path ASC` so the ordering is total and reproducible. See [Four-arm
retrieval](/internals/four-arm-retrieval/).

### The git tree as system of record

The invariant that the repository of HTML files is authoritative and everything else is derived from
it: anything that has to survive `rm index.db` lives in a file. See [Internals](/internals/).

### Index plane

`.memhtml/index.db`: gitignored, rebuildable from `git ls-tree`, and holding the projected rows, the
full-text index, the vectors, and the derived edges. See [The index](/internals/the-index/).

### Last-wins consolidation

Resolving a contradiction silently in favor of the newer memory. memhtml declines that policy,
because sometimes the contradiction itself is the answer, so it detects a contradiction
automatically and leaves the resolution to a writer or a human. See [The write
path](/internals/the-write-path/).

### Memory

One fact in one semantic HTML5 file, identified by its repo-relative path, with no separate uuid, and
carrying exactly one `<article>` and one claim. See [The memory file
format](/internals/the-memory-file-format/).

### MMR

Maximal marginal relevance, a diversification pass that picks each next hit by balancing its
relevance against how similar it already is to the hits picked so far. memhtml applies it greedily in
TypeScript after fusion at λ = 0.5, with fusion rank standing in for relevance, because RRF scores
are incomparable across queries. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### `mrr` and `corpusMrr`

Two different coordinate spaces, which is why the two field names exist. `mrr` is measured in the
space of one probe's target plus that probe's own controls, and it is gated against a floor of 0.85.
`corpusMrr` is measured against the whole corpus and is reported, never gated: it is low by
construction on a fixture holding many near-identical memories, so reading it as a retrieval defect
confuses the two spaces. See [Testing posture](/internals/testing-posture/).

### PARA

The four fixed top-level buckets: `projects`, `areas`, `resources`, and `archive`. `archive` is a
bucket rather than a status field, because the path itself records the state. See [Store layout and
path algebra](/internals/store-layout-and-path-algebra/).

### Projection

A derived, disposable representation of the tree. The index is one, and `projectFile` is the pure
function that produces its rows, which is what makes a fresh rebuild reproduce the incremental row
set. See [The index](/internals/the-index/).

### Retention triage and reprieve

The nightly eviction decision and its appeal. Triage archives EVICT-band files by the eight-signal
retention score; reprieve extends a bounded validity instead, up to a capped number of times. See
[The sleep pipeline](/internals/the-sleep-pipeline/).

### RRF arm

One ranking source in the retrieval registry. It returns exactly `(path, rank)` with rank 1-based,
and carries a weight and a precondition, so adding a fifth arm is a table entry and dropping one is a
filter. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Salience arm

The arm that reads the state plane over the ATTACH: decayed recency of use, log access count, and a
clamped outcome score. It excludes tasks and `resources/people/`, where salience would reward a stale
task and decay a person's identity. See [Four-arm retrieval](/internals/four-arm-retrieval/).

### Sleep phase

One of the fifteen ordered curation steps. Each is an isolated commit on a `sleep/<date>` branch
carrying machine-readable trailers, so a failure stays contained and a resume reads what is already
done out of `git log`. See [The sleep pipeline](/internals/the-sleep-pipeline/).

### State plane

`.memhtml/state.db`: gitignored like the index, and the one plane a rebuild cannot reproduce. It
holds access counts, reinforcement counts, the outcome EWMA, reprieve bookkeeping, and edge
corroboration. See [The index plane and the state
plane](/internals/index-plane-and-state-plane/).

### The three write doors

The CLI, the MCP server, and your own file tools. All three are legitimate and all three land in the
same tree; the third hands the caller everything the write path would have done: format validity,
path choice, dedup, and the commit. See [The write path](/internals/the-write-path/).

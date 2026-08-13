---
title: Internals
description: Why the system is built the way it is, with the implementing code cited for every decision.
---

These pages explain why the system is shaped the way it is. Each chapter takes one mechanism and says
what it is, how it works, which failure it prevents, and where in the source that lives. Someone who
wants to install the store, write a memory, or operate a nightly curation run is served by
[Learn](/learn/). Someone who wants the exact spelling of a flag or an error code is served by
[Reference](/reference/).

## 1. Two invariants

Two rules hold the design together. Most decisions in the chapters below follow from one of them, and
most of the bugs this system has had came from breaking one of them.

The first rule is that the git repository holds the facts, and `.memhtml/index.db` is a derived copy
that can be thrown away. A derived copy like that is called a projection, meaning every row in it is
computed from files in the tree and nothing is stored there first. `git ls-tree` regenerates the
whole database (`packages/store/src/layout.ts:25`, `packages/store/src/layout.ts:55`), which is why
the index is gitignored. Anything that has to survive `rm index.db` lives in a file instead:
authored links are `<link>` elements and metadata is `<meta>` elements. Embeddings and mined edges
can be recomputed, so they live only in the index. The state plane breaks the pattern, because it
holds access counts and reinforcement history that no file in the tree records, so it carries a
committed sidecar file as its durable copy.

Figure 1 draws that rule. Three ways of writing reach one tree, and two databases are derived from it.

```d2 pad=20 src="_figures/system-topology.d2" title="Three write doors - the CLI, the MCP server, and your own file tools - each commit into a single git tree. The tree moves evicted files to archive/YYYY/ and a git-driven indexer derives index.db from it. index.db supplies three ranking arms and state.db supplies the fourth, salience; both feed one RRF-then-MMR step that produces ranked hits."
```

**Figure 1: every write door lands in the git tree, and every read is served from a database derived
from it.** The three doors differ in who owns the commit and never in where the fact lands. `index.db`
is drawn with a dashed border because deleting it loses nothing. `state.db` is drawn as a database on
disk because a rebuild cannot reproduce it.

The second rule is that each change to the corpus is exactly one git commit. `git log` is then the history of
what the agent learned, and `diff base..HEAD` is a curation run a human can review
(`packages/store/src/store.ts:37-44`). The store stages files itself, because a caller that staged its
own could put two unrelated writes into one commit. Eviction is a `git mv` into `archive/<YYYY>/` that
mirrors the original path underneath, so `git log --follow` reads through a memory's whole life. No
path in the system removes a file from the repository.

Figure 2 follows one memory through that rule. One commit brings it in, and each of the three ways out
is also a commit.

```d2 pad=20 src="_figures/memory-lifecycle.d2" title="A write enters as one commit and the memory becomes active. Three arrows leave the active state: correct makes it superseded, evict makes it archived, and compress makes it compressed. No arrow leaves the corpus, because each of the three is a git mv into the archive rather than a deletion."
```

**Figure 2: a memory has one entry and three exits, and each exit keeps the file.** `memhtml correct`
writes the replacement and archives the original in one commit. Retention triage archives a file whose
score fell into the evict band. Compression archives a member underneath a newly written canonical
memory. All three land under `archive/<YYYY>/` with the original path mirrored beneath, which is what
lets `git log --follow` read straight through.

## 2. The chapters

The chapters run in dependency order: the layers first, then the paths through them, then the
pipelines and the contract surface.

| Chapter | What it settles |
|---|---|
| [Packages and dependency direction](/internals/packages-and-dependency-direction/) | The layering, the enforced purity of the pure packages, and the one composition root |
| [Store layout and path algebra](/internals/store-layout-and-path-algebra/) | The four top-level buckets, placement as a pure total function, the invertible archive mapping |
| [The memory file format](/internals/the-memory-file-format/) | The closed vocabulary, the two hashes, byte-splice head edits, the render gate |
| [Edge encoding](/internals/edge-encoding/) | Authored versus derived edges, the four non-mixing classes, the `derived` firewall |
| [The write path](/internals/the-write-path/) | Ordering as the dedup mechanism, batch atomicity, the propose-only conflict assist |
| [The index](/internals/the-index/) | Two databases on one connection, the schema, projection, rebuild and incremental update |
| [Four-arm retrieval](/internals/four-arm-retrieval/) | The arm registry, rank fusion, degraded mode, diversification, the disclosure fold |
| [The index plane and the state plane](/internals/index-plane-and-state-plane/) | What git cannot reproduce, and the byte-stable committed sidecar that saves it |
| [The trace indexer](/internals/the-trace-indexer/) | A read-only index over session transcripts, and the table-name firewall around it |
| [The sleep pipeline](/internals/the-sleep-pipeline/) | Fifteen phases, per-phase isolation, commit trailers as the resume mechanism |
| [Concurrency and conflicts](/internals/concurrency-and-conflicts/) | Git as the concurrency mechanism, and typed conflict surfacing |
| [The envelope contract](/internals/the-envelope-contract/) | One JSON envelope, append-only codes, the tool surface and its forced choices |
| [Testing posture](/internals/testing-posture/) | Real driver, real git, two fakes, and the quality gate that can refuse a merge |

Three pages sit beside the chapters. [The consolidator](/internals/the-consolidator/) reproduces the
live system prompt of the agent that distils memories out of transcripts.
[Measured standing](/internals/measured-standing/) carries the benchmark numbers together with the
caveat that governs how to read them. The [glossary](/glossary/) defines the domain vocabulary these
pages use and links each term to the chapter that develops it.

## 3. How to read a citation

Every architectural claim on these pages names the code that implements it, in repo-relative
`path:line` form, as in `packages/index/src/retrieval-sql.ts:246-248`. A line number points into the
commit the site was built from, so treat it as a pointer rather than a permanent address. Where a
claim rests on a measurement rather than on code, the measurement carries its date, because a probed
number is a fact about one specific build of one specific dependency.

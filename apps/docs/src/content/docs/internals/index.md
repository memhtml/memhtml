---
title: Internals
description: The reasoning behind the design, for a reader who wants to know why rather than how to.
---

This topic is the explanation tier. It records why the system is shaped the way it is: which
alternatives were rejected, which failure mode each decision prevents, and where in the source the
decision is implemented. It is not a tutorial and not a command reference. A reader who wants to
install the store, write a memory, or operate a nightly run is served by [Learn](/learn/); a reader who
wants the exact spelling of a flag or an error code is served by Reference.

## 1. Two invariants { #two-invariants }

Almost every design decision below is a consequence of one of two invariants, and almost every bug
this system has had was a violation of one of them.

**The git tree is the system of record; `.memhtml/index.db` is a disposable projection.** The index
is gitignored and reproducible from `git ls-tree` (`packages/store/src/layout.ts:25`,
`packages/store/src/layout.ts:55`). Anything that must survive `rm index.db` lives in a file:
authored links are `<link>` elements, metadata is `<meta>` elements. Re-derivable artifacts —
embeddings, mined edges — live only in the index. The one exception is the state plane, which is not
rebuildable from git and therefore carries a committed sidecar.

**Every corpus change is exactly one git commit.** `git log` is the history of what the agent
learned and `diff base..HEAD` is a reviewable curation run (`packages/store/src/store.ts:37-44`).
The store owns staging, because a caller that staged its own files could bundle two unrelated writes
into one commit. Nothing is ever deleted: eviction is a `git mv` into `archive/<YYYY>/` mirroring the
original path, so `git log --follow` reads through a memory's whole life.

## 2. The chapters { #the-chapters }

Each page is one chapter of the architecture, in dependency order — the layers first, then the
paths through them, then the pipelines and the contract surface.

| Chapter | What it settles |
|---|---|
| [Packages and dependency direction](/internals/packages-and-dependency-direction/) | The layering, the enforced purity of the pure packages, and the one composition root |
| [Store layout and path algebra](/internals/store-layout-and-path-algebra/) | PARA, placement as a pure total function, the invertible archive mapping |
| [The memory file format](/internals/the-memory-file-format/) | The closed vocabulary, the two hashes, byte-splice head edits, the render gate |
| [Edge encoding](/internals/edge-encoding/) | Authored versus derived edges, the four non-mixing classes, the `derived` firewall |
| [The write path](/internals/the-write-path/) | Ordering as the dedup mechanism, batch atomicity, the propose-only conflict assist |
| [The index](/internals/the-index/) | Two planes on one connection, the schema, projection, rebuild and incremental update |
| [Four-arm retrieval](/internals/four-arm-retrieval/) | The arm registry, RRF fusion, degraded mode, MMR, the disclosure fold |
| [The index plane and the state plane](/internals/index-plane-and-state-plane/) | What git cannot reproduce, and the byte-stable committed sidecar that saves it |
| [The trace indexer](/internals/the-trace-indexer/) | A read-only index over session transcripts, and the table-name firewall around it |
| [The sleep pipeline](/internals/the-sleep-pipeline/) | Fifteen phases, per-phase isolation, commit trailers as the resume mechanism |
| [Concurrency and conflicts](/internals/concurrency-and-conflicts/) | Git as the optimistic-concurrency mechanism, and typed conflict surfacing |
| [The envelope contract](/internals/the-envelope-contract/) | One JSON envelope, append-only codes, the tool surface and its forced choices |
| [Testing posture](/internals/testing-posture/) | Real driver, real git, two fakes, and the refusable discrimination gate |

Three pages sit beside the chapters. [The consolidator](/internals/the-consolidator/) reproduces the
live system prompt of the agent that distils memories out of transcripts.
[Measured standing](/internals/measured-standing/) carries the benchmark numbers with the caveat that
governs how they may be read. The [glossary](/glossary/) defines the domain vocabulary these pages
use and links each term to the chapter that develops it.

## 3. How to read a citation { #how-to-read-a-citation }

Every architectural claim on these pages names the code that implements it, in repo-relative
`path:line` form — `packages/index/src/retrieval-sql.ts:246-248`. Line numbers are a pointer into the
commit the site was built from, not a permanent address. Where a claim rests on a measurement rather
than on code, the measurement carries its date, because a probed number is a fact about a specific
build of a specific dependency.

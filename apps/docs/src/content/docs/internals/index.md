---
title: Internals
description: Why the system is built the way it is, with the implementing code cited for every decision.
---

These pages explain why the system is shaped the way it is. Each chapter takes one mechanism and says what it is, how it works, which failure it prevents, and where in the source that lives.

To install the store, write a memory, or run a curation pass, read [Learn](/learn/). For the exact spelling of a flag or an error code, read [Reference](/reference/).

## 1. Two invariants

Two rules hold the design together. Most decisions in the chapters below follow from one of them. Most of the bugs this system has had came from breaking one.

The first rule is that the git repository holds the facts, and `.memhtml/index.db` is a derived copy that can be thrown away. A derived copy like that is called a projection: `memhtml index rebuild` computes every memory row in it from the files in the tree (`packages/index/src/indexer.ts::makeIndexer::rebuild`), which is why the index is gitignored (`packages/store/src/layout.ts::INDEX_DB_PATH`, `packages/store/src/layout.ts::GITIGNORE`). Anything that has to survive `rm index.db` lives in a file instead: authored links are `<link>` elements and metadata is `<meta>` elements. Embeddings can be recomputed, so no committed file holds them. The state plane breaks the pattern, because its access and reinforcement counts are in no file in the tree, so `memhtml state export` commits them to a sidecar file, `.memhtml/state/access.jsonl`, as their durable copy.

Figure 1 draws that rule. Three ways of writing reach one tree, `index.db` is derived from it, and `state.db` is the one database that is not.

```d2 pad=20 src="_figures/system-topology.d2" title="The CLI, the MCP server, and your own file tools are three write doors, and each commits into one git tree. An archived file moves within that tree to archive/, and a git-driven indexer derives index.db from the tree. index.db supplies three ranking arms and state.db supplies the fourth, salience; a search on the index fuses them by RRF and diversifies the result by MMR into ranked hits."
```

**Figure 1: every write door lands in the git tree, and the index that ranks a search is derived from it.** The three doors differ in who owns the commit and never in where the fact lands. The CLI's `session` commands are a fourth way in, drawn here under the CLI: a session lands its whole log as one commit through the [commit path](/internals/sessions-and-the-commit-path/), and its reads come from the head held in memory rather than from `index.db`. `index.db` is drawn with a dashed border because `memhtml index rebuild` derives its memory rows again from the tree. `state.db` is drawn as a database on disk because a rebuild cannot reproduce it.

The second rule is that every write through memhtml lands whole, as one git commit (`packages/store/src/store.ts::makeStore`, `packages/session/src/commit.ts::commitSession`). `git log` is then the history of what the agent learned. A curation run commits to its own `curate/` branch, so that branch's diff is the run a human [reviews](/learn/operations/curate-the-corpus/) before `memhtml curate merge` lands it. The store stages files itself, because a caller that staged its own could put two unrelated writes into one commit. Archiving moves a file to `archive/<YYYY>/`, or to `archive/<YYYY>.<n>/` when an earlier archiving holds that slot, with the original path mirrored underneath (`packages/contracts/src/paths.ts::archiveSlotFor`), so `git log --follow` reads through a memory's whole life. No command deletes a memory file.

Figure 2 follows one memory through that rule. One commit brings it in, and each way out is also a commit.

```d2 pad=20 src="_figures/memory-lifecycle.d2" title="A write enters as one commit and the memory becomes active. Two arrows leave the active state: correct or fold archives it under a successor, which makes it superseded, and evict archives it with none, which makes it evicted. No arrow leaves the corpus, because every exit moves the file into the archive rather than deleting it."
```

**Figure 2: a memory has one entry and two exits, and each exit keeps the file.** `memhtml correct` writes the replacement and archives the original in one commit. A fold is `memhtml curate collapse` writing one canonical memory for a cluster of near-duplicates and archiving each member. Both leave a `supersedes` link from the new memory to the archived one, and that link is what makes the old one superseded: `memhtml resolve` follows it forward. Eviction is an archive that no live memory supersedes: `memhtml archive`, `memhtml task status <path> done`, or an `archive` operation a session or the curator commits with no `supersedes` link to it. Every exit sets `memhtml-status` to `archived` and moves the file to `archive/<YYYY>/`, or `archive/<YYYY>.<n>/` when an earlier archiving holds that slot, with the original path mirrored beneath, which is what lets `git log --follow` read straight through. A curator's exits land on its `curate/` branch until `memhtml curate merge` lands them.

## 2. The chapters

The chapters run in dependency order: the layers first, then the paths through them, then the pipelines and the contract surface.

| Chapter                                                                            | What it settles                                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Packages and dependency direction](/internals/packages-and-dependency-direction/) | The layering, the enforced purity of the pure packages, and the one composition root           |
| [Store layout and path algebra](/internals/store-layout-and-path-algebra/)         | The four top-level buckets, placement as a pure total function, the invertible archive mapping |
| [The memory file format](/internals/the-memory-file-format/)                       | The closed vocabulary, the two hashes, byte-splice head edits, the render gate                 |
| [Edge encoding](/internals/edge-encoding/)                                         | Authored versus derived edges, the four non-mixing classes, the `derived` firewall             |
| [The write path](/internals/the-write-path/)                                       | Ordering as the dedup mechanism, batch atomicity, the propose-only conflict assist             |
| [Sessions and the commit path](/internals/sessions-and-the-commit-path/)           | The head as a value, the session log, validation, the commit steps, and the checkout lock      |
| [The index](/internals/the-index/)                                                 | Two databases on one connection, the schema, projection, rebuild and incremental update        |
| [Four-arm retrieval](/internals/four-arm-retrieval/)                               | The arm registry, rank fusion, degraded mode, diversification, the disclosure fold             |
| [The index plane and the state plane](/internals/index-plane-and-state-plane/)     | What git cannot reproduce, and the byte-stable sidecar that saves its access table             |
| [The trace indexer](/internals/the-trace-indexer/)                                 | A read-only index over session transcripts, and the table-name firewall around it              |
| [Concurrency and conflicts](/internals/concurrency-and-conflicts/)                 | Git as the concurrency mechanism, the checkout lock, and `rebase-needed`                       |
| [The envelope contract](/internals/the-envelope-contract/)                         | One JSON envelope, append-only codes, the tool surface and its forced choices                  |
| [The extension contract](/internals/the-extension-contract/)                       | The five open axes a consumer models its domain on, and the six closed vocabularies            |
| [Testing posture](/internals/testing-posture/)                                     | Real driver, real git, three fakes, and the quality gate that can refuse a merge               |

Two pages sit beside the chapters. [Measured standing](/internals/measured-standing/) carries the benchmark numbers together with the caveat that governs how to read them. The [glossary](/glossary/) defines the domain vocabulary these pages use and links each term to the page that develops it.

## 3. How to read a citation

Every architectural claim on these pages names the code that implements it: a repo-relative path and the symbol that path declares, as in `packages/index/src/retrieval-sql.ts::RrfOptions`. A declaration nested inside another is named through its owner, as in `packages/store/src/store.ts::makeStore::writeMemory`. A symbol survives the edits that move lines. The repository's check fails when a cited file stops declaring one, so every citation names code that the source of this site still declares.

Where a claim rests on a measurement rather than on code, the measurement carries its date, because a probed number is a fact about one specific build of one specific dependency.

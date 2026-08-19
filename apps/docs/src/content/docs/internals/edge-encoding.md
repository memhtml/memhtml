---
title: Edge encoding
description: Authored edges live in the HTML, mined edges live only in the index, and four classes that never mix keep a to-do list out of the knowledge graph.
---

## 1. Authored in the HTML, derived in the index

An agent asserting that one memory supersedes another is authorship. It is small, it reads well in a
diff, and git is built for it. A `relates_to` edge mined at cosine 0.87 by the nightly pipeline is a
function of the corpus and the embedding model, computable again at any time, and committing thousands of
them would bury every human diff in machine output while recovering nothing
(`packages/sleep/src/phases/relationship-mining.ts:6-19`).

So authored edges are `<link rel="memhtml-*">` elements in the file, and derived edges exist only as
`edges` rows in the index. Deleting the index costs the derived set and nothing else.

An authored memory edge arises two ways, and both write the same `<link>`. An agent or a human writes it
through the write path, or the nightly `edge-typing` phase promotes one. Promotion is the only path by
which a machine-found relationship crosses from the index into a file, and it is deliberately narrow: the
phase takes the pairs mining and the shared-entity scan already turned up, judges a batch of them over
`{caused_by, leads_to, example_of, supports, part_of, contradicts, none}` with a direction, and writes a
`<link>` only above a confidence floor and under a per-night cap
(`packages/sleep/src/phases/edge-typing.ts:48-59`).

Which file receives the link follows from the rel. A directional rel is written into the **subject's**
file alone, because a `caused_by` read from the wrong end inverts its meaning. `contradicts` is symmetric
and is written into **both**, because a reader arriving at either file must see it, and it is the one rel
that waits for a second night's independent detection before it is written at all. A verdict of `none`, or
anything below the floor, writes nothing and leaves the pair a derived `relates_to` — which is why
`relates_to` and `laterally_related` are outside what the phase may propose: they are what a pair already
carries, so proposing one is a no-op with a model call attached. `supersedes` is outside it too, being a
one-way door that belongs to dedup-merge and compress and rides with an archive
(`packages/sleep/src/llm.ts:24-39`).

## 2. The `derived` column is the firewall

The retention scorer's `contestedStatus` signal counts authored contradictions only, meaning rows with
`derived = 0` (`packages/contracts/src/edges.ts:122-128`,
`packages/domain/src/retention.ts:164-166`). An uncorroborated machine suspicion therefore cannot evict a
memory.

One fact in this area does not survive a rebuild: the counter recording how many times a contradiction
has been detected. It lives in the state plane. The nightly `edge-typing` phase promotes a corroborated
contradiction into both files, after which the counter is decoration and the fact is carried by the files
themselves. A SQL CHECK refuses `derived = 1` outside `provenance = 'sleep'`
(`packages/index/migrations/0008_tasks.sql:147`), and `isWellFormedEdge` states the same condition once
in TypeScript (`packages/contracts/src/edges.ts:146-149`) so a caller can refuse a bad edge before the
driver does.

## 3. Four classes that never mix

`EDGE_CLASSES` (`packages/contracts/src/edges.ts:9`) is `memory`, `person`, `provenance`, `task`.

| Class | Rels | Source |
|---|---|---|
| `memory` | `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related` | `packages/contracts/src/edges.ts:19` |
| `person` | `about_person`, `authored_by` | `packages/contracts/src/edges.ts:35` |
| `provenance` | `from_session` | `packages/contracts/src/edges.ts:41` |
| `task` | `blocks`, `subtask_of` | `packages/contracts/src/edges.ts:54` |

The class is derived from the rel (`packages/contracts/src/edges.ts:70`) rather than stored beside it, so
the two cannot disagree. `relClassFor` is total over `ALL_RELS`, and each rel name appears in exactly one
class.

SQL CHECK constraints pair each class with its vocabulary
(`packages/index/migrations/0008_tasks.sql:168-174`), and every memory-graph query filters on
`edge_class = 'memory'`. A person edge or a task edge therefore cannot enter PageRank, the
diversification pass, or the retention scorer's bridge count.

The HTML `rel` token is the rel with a `memhtml-` prefix and its underscores turned into hyphens
(`packages/contracts/src/edges.ts:106-110`), so `laterally_related` becomes
`memhtml-laterally-related`. `relForToken` inverts that mapping (`packages/contracts/src/edges.ts:116`).

## 4. The store checks the endpoint types SQL cannot

SQL cannot check the type of the files at either end of an edge, so the store refuses an edge whose class
disagrees with its endpoints (`packages/store/src/store.ts:838-870`). Both directions are refusals, with
a distinct failure behind each:

- a memory rel with a task endpoint would let a to-do list reweight the retention of knowledge;
- a task rel with a memory endpoint claims a memory `blocks` something that nothing can close.

`memhtml link` accepts the task rels. The MCP `memory_link` tool refuses one while decoding its
arguments.

## 5. Href form

An `href` value is repository-root-relative with a leading slash. That leading slash is a
document-reference form, converted at the HTML boundary and never stored
(`packages/index/src/project.ts:336-344`). A root-relative href survives a `git mv` of the source file,
greps as a fixed string, and resolves without knowing how deep the referring file sits. A self-loop is
dropped when the file is projected.

## 6. No foreign key on the endpoints

`edges.src_path` and `edges.dst_path` carry no foreign key, on purpose. A `<link>` may name a file the
indexer has not reached yet, or an archived path, and a hard foreign key would make indexing depend on
the order files arrive in (`packages/index/src/indexer.ts:470-473`).

A dangling href is therefore found and repaired instead of refused at write time. A LEFT JOIN finds
them (`packages/sleep/src/sql.ts:524`) and the sleep pipeline's integrity phase repairs them in a
commit, distinguishing an archived target, where it rewrites the href to the derived archive path,
from a target that is simply gone, where it drops the edge with a warning.
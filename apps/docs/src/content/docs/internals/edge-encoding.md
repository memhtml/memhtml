---
title: Edge encoding
description: Authored edges live in the HTML, derived edges live only in the index, and four non-mixing classes keep a to-do list out of the knowledge graph.
---

## 1. Authored in the HTML, derived in the index { #authored-in-the-html-derived-in-the-index }

An agent asserting "this supersedes that" is authorship — small, reviewable in a diff, and exactly
what git is for. A sleep-mined `relates_to` at cosine 0.87 is a re-derivable function of the corpus
and the embedder; committing thousands would bury every real diff in machine noise for zero
recoverable information (`packages/sleep/src/phases/relationship-mining.ts:6-19`).

So authored edges are `<link rel="memhtml-*">` elements in the file, and derived edges exist only as
`edges` rows in the index. Deleting the index costs the derived set and nothing else.

## 2. The `derived` column is the firewall { #the-derived-column-is-the-firewall }

The retention `contestedStatus` signal counts only authored (`derived = 0`) contradictions
(`packages/contracts/src/edges.ts:122-128`, `packages/domain/src/retention.ts:164-166`), so an
uncorroborated machine suspicion can never evict a memory.

The one fact that does not survive a rebuild — the corroboration counter — lives in the state plane,
and the conflict phase promotes a corroborated contradiction into both files, after which the counter
is decoration and the fact is file-borne. `derived = 1` outside `provenance = 'sleep'` is refused by a
SQL CHECK (`packages/index/migrations/0008_tasks.sql:147`), and the same condition is stated once in
`isWellFormedEdge` (`packages/contracts/src/edges.ts:146-149`) so a caller can refuse a bad edge
before the driver does.

## 3. Four non-mixing classes { #four-non-mixing-classes }

`EDGE_CLASSES` (`packages/contracts/src/edges.ts:9`) is `memory`, `person`, `provenance`, `task`.

| Class | Rels | Source |
|---|---|---|
| `memory` | `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related` | `packages/contracts/src/edges.ts:19` |
| `person` | `about_person`, `authored_by` | `packages/contracts/src/edges.ts:35` |
| `provenance` | `from_session` | `packages/contracts/src/edges.ts:41` |
| `task` | `blocks`, `subtask_of` | `packages/contracts/src/edges.ts:54` |

The class is **derived** from the rel (`packages/contracts/src/edges.ts:70`) rather than carried
alongside it, so the two cannot disagree. `relClassFor` is total over `ALL_RELS` and injective per
class — a rel name appears in exactly one class.

SQL CHECKs pair each class with its vocabulary (`packages/index/migrations/0008_tasks.sql:168-174`)
and every memory-graph query filters `edge_class = 'memory'`, so a person or task edge is structurally
incapable of entering PageRank, MMR, or the retention bridge count.

The HTML `rel` token is the rel with the `memhtml-` prefix and its underscores hyphenated
(`packages/contracts/src/edges.ts:106-110`), so `laterally_related` is `memhtml-laterally-related`.
`relForToken` is the inverse on that image (`packages/contracts/src/edges.ts:116`).

## 4. What SQL cannot enforce, the store refuses { #what-sql-cannot-enforce-the-store-refuses }

SQL cannot enforce the *type* of the files at either end, so the store refuses an edge whose class
disagrees with its endpoints (`packages/store/src/store.ts:838-870`). Both directions are refusals
with distinct failure modes:

- a memory rel with a task endpoint would let a to-do list reweight the retention of knowledge;
- a task rel with a memory endpoint claims a memory `blocks` something nothing can close.

`memhtml link` accepts the task rels; the MCP `memory_link` tool does not, refusing one at decode.

## 5. Href form { #href-form }

`href` values are repo-root-relative with a leading slash — a document-reference form converted at the
HTML boundary and never stored (`packages/index/src/project.ts:336-344`). Root-relative survives a
`git mv` of the source, is greppable as a fixed string, and resolves without knowing the referrer's
depth. A self-loop is dropped at projection time.

## 6. No foreign key on the endpoints { #no-foreign-key-on-the-endpoints }

There is deliberately no foreign key on `edges.src_path`/`dst_path`: a `<link>` may name a file the
indexer has not reached, or an archived path, and a hard FK would make indexing order-dependent
(`packages/index/src/indexer.ts:470-473`).

Dangling hrefs are therefore found rather than prevented — by a LEFT JOIN
(`packages/sleep/src/sql.ts:524`) — and repaired in a commit by the sleep pipeline's integrity phase,
which distinguishes an archived target (rewrite the href to the derived archive path) from a target
that is simply gone (drop the edge with a warning).

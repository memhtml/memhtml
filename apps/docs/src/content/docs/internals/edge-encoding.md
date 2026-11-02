---
title: Edge encoding
description: Authored edges live in the HTML, a derived edge could live only in the index and nothing writes one now, and four edge classes that never mix keep task edges out of the memory graph.
---

## 1. Authored in the HTML, derived in the index

An agent asserting that one memory supersedes another is authorship. It is small, it reads well in a diff, and git is built for it. A `relates_to` edge mined at cosine 0.87 would be a function of the corpus and the embedding model, computable again at any time, and committing thousands of them would bury every human diff in machine output while recovering nothing.

So authored edges are `<link rel="memhtml-*">` elements in the file, and a derived edge may exist only as an `edges` row in the index, marked `derived = 1`. No command writes one now: the sleep pipeline mined them until 0.16 removed it, and the projection inserts every row with `derived = 0` (`packages/index/src/project.ts::authoredEdgesFor`). Deleting the index costs no authored edge.

An authored edge is a `<link>` in a file, whoever wrote it: an agent, a human, the curator, or a session commit. The curator writes one as a `link` operation in a session on its `curate/<date>` branch, and the edge reaches `main`, or the branch `--into` names, when `memhtml curate merge` lands that branch. In a session, validation accepts any rel in the closed vocabulary (`packages/session/src/validate.ts::validateOps`). A session commit also adds a `contradicts` link on its own (`packages/session/src/commit.ts::markContradictions`). It compares each new record only with the live records in the session's base whose claims share its frame key, and it links one unless a lexical rule counts the two as agreeing (`packages/domain/src/agreement.ts::frameGroupAgrees`), the new record supersedes it, or the batch archives it. Two records put in the same batch are never compared, and two wordings of one value can still be linked.

A link is written into the **subject's** file alone, whatever the rel. A `caused_by` read from the wrong end inverts its meaning, and `memhtml link` writes `contradicts` the same way (`packages/store/src/store.ts::makeStore::linkMemories`). `relates_to` and `laterally_related` are accepted like any other memory rel, so the link is written and committed and the index carries it as an authored edge. `memhtml correct` writes `supersedes` together with the archive of the record it replaces (`packages/store/src/store.ts::makeStore::correctMemory`). `memhtml link` accepts `supersedes` too and archives nothing, so the record it names stays live.

## 2. The `derived` column is the firewall

The retention scorer in `@memhtml/domain` computes its `contestedStatus` signal from a count of contradictions, and its input contract admits only rows with `derived = 0` to that count, so an edge that exists only in the index could never lower a memory's retention score (`packages/contracts/src/edges.ts::Edge`, `packages/domain/src/retention.ts::RetentionInput`). No 0.18 code calls the scorer, and the rule stays in its input contract for any caller that does.

The state plane's `edge_corroboration` table counted how many times the sleep pipeline had detected a contradiction, and nothing writes it now. A rebuild leaves its rows alone and `memhtml state export` does not copy them, so rows an older store kept survive a rebuild but not a fresh clone (`packages/index/src/schema-const.ts::MEMORY_TABLES`, `apps/cli/src/state.ts::stateExport`).

A SQL CHECK refuses `derived = 1` outside `provenance = 'sleep'` (`packages/index/migrations/0008_tasks.sql`). That provenance, `sleep`, is what the sleep pipeline stamped before 0.16 removed it, and the closed vocabulary still holds it. `isWellFormedEdge` states the same condition once in TypeScript (`packages/contracts/src/edges.ts::isWellFormedEdge`), so a caller can refuse a bad edge before the driver does.

## 3. Four classes that never mix

`EDGE_CLASSES` (`packages/contracts/src/edges.ts::EDGE_CLASSES`) is `memory`, `person`, `provenance`, `task`.

| Class        | Rels                                                                                                                         | Source                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `memory`     | `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related` | `packages/contracts/src/edges.ts::MEMORY_RELS`     |
| `person`     | `about_person`, `authored_by`                                                                                                | `packages/contracts/src/edges.ts::PERSON_RELS`     |
| `provenance` | `from_session`                                                                                                               | `packages/contracts/src/edges.ts::PROVENANCE_RELS` |
| `task`       | `blocks`, `subtask_of`                                                                                                       | `packages/contracts/src/edges.ts::TASK_RELS`       |

A `<link>` carries the rel alone, and the projection computes the class from it (`packages/contracts/src/edges.ts::relClassFor`) to fill the `edge_class` column, so no file can state a class that disagrees with its rel. `relClassFor` is total over `ALL_RELS`, and each rel name appears in exactly one class.

SQL CHECK constraints pair each class with its vocabulary (`packages/index/migrations/0008_tasks.sql`), and every memory-graph query filters on `edge_class = 'memory'`. A person edge or a task edge therefore cannot enter a `memhtml neighbors` walk (`apps/cli/src/operations.ts::neighborsQuery`).

The HTML `rel` token is the rel with a `memhtml-` prefix and its underscores turned into hyphens (`packages/contracts/src/edges.ts::relTokenFor`, `packages/contracts/src/edges.ts::REL_TOKEN_PREFIX`), so `laterally_related` becomes `memhtml-laterally-related`. `relForToken` inverts that mapping (`packages/contracts/src/edges.ts::relForToken`).

## 4. Endpoint types, which SQL cannot check

SQL cannot check the type of the files at either end of an edge, so the store refuses an edge whose class disagrees with its endpoints (`packages/store/src/store.ts::makeStore::requireEndpointClasses`). `memhtml link` and the MCP `memory_link` tool reach that check; a `link` operation in a session, the curator's included, does not. Where the check runs, both directions are refusals, with a distinct failure behind each:

- a memory rel with a task endpoint would put a to-do item into the memory graph that `memhtml neighbors` walks;
- a task rel with a memory endpoint claims a memory `blocks` something that nothing can close.

`memhtml link` accepts the task rels. The MCP `memory_link` tool refuses a task rel while decoding its arguments, before the store sees the call.

## 5. Href form

An `href` value is repository-root-relative with a leading slash. The projection strips that slash, so an `edges` row holds the plain tree path and the slashed form is never stored (`packages/index/src/project.ts::authoredEdgesFor`). A root-relative href survives a `git mv` of the source file, greps as a fixed string, and resolves without knowing how deep the referring file sits. A self-loop is dropped when the file is projected.

## 6. No foreign key on the endpoints

`edges.src_path` and `edges.dst_path` carry no foreign key, on purpose. A `<link>` may name a file the indexer has not reached yet, or an archived path, and a hard foreign key would make indexing depend on the order files arrive in (`packages/index/src/indexer.ts::makeIndexer::movePath`).

Without a foreign key, the index accepts a dangling href. Both link paths refuse one up front: a session `link` operation needs a target that is a record in the head or the batch (`packages/session/src/validate.ts::validateOps`), and `memhtml link` reads its target before it writes (`packages/store/src/store.ts::makeStore::requireEndpointClasses`). An href can still dangle: a `<link>` inside a file a session puts is not checked that way, `memhtml archive` leaves the edges into the archived record on its old path while a session `archive` or `move` repoints them (`packages/session/src/moves.ts::withRepoints`), and a file can be moved, removed or edited outside the doors. `memhtml doctor` finds them and `memhtml doctor --fix` repairs them in one commit (`apps/cli/src/repair.ts`). It rewrites an href whose target was archived to the target's archive path, and it drops an href whose target is simply gone, logging `doctor dropped a dangling <rel> from <path>: target has no file`.

## 7. The two directional indexes carry no predicate

`edges_src (src_path, edge_class)` and `edges_dst (dst_path, edge_class)` cover every row, whatever its `derived` value (`packages/index/migrations/0011_edge_indexes.sql`). The absence of a predicate is the load-bearing part: SQLite may use a partial index only when the query's `WHERE` **implies** the index's, and the memory-graph walk filters `edge_class = 'memory'` without filtering `derived`, because it reads both kinds of row and reports for each node whether a derived edge reached it. A `WHERE derived = 0` index is therefore not a candidate for it at all.

Measured 2026-08-26 on node 24.19.0's `node:sqlite`, with no `ANALYZE`, over the walk's own depth-2 statement. Without a predicate, every arm is a `SEARCH` binding two columns. With `WHERE derived = 0` restored, the `src_path` arms still probe through `sqlite_autoindex_edges_1`, because `src_path` leads `PRIMARY KEY (src_path, rel, dst_path)`. Each `dst_path` arm falls back to a full pass over `edges`. That asymmetry is why the tests assert the list of bound columns: a check for "does something probe" is satisfied by the primary key alone.

The census behind the pair, taken the same day, measured the statements that `packages/index/migrations/0011_edge_indexes.sql` lists as reading `edges`, under both index shapes. Five of those plans changed, and each of the five gained a probe or bound a column more. Both `dst_path` walk arms left a `SCAN`. Both `src_path` walk arms moved off the primary key's autoindex onto `edges_src (src_path, edge_class)`. `retentionEdgeCounts`, which 0.16 removed with the sleep pipeline, stopped building a transient automatic index per call and read `edges_dst` as a covering index instead. `task list`'s blockers subquery moved from `edges_rel` to `edges_dst`, so the bound column became a path rather than the rel `'blocks'`. The indexer's delete-by-source and `movePath`'s `UPDATE` both moved onto `edges_src`. Every other plan it lists was identical under both shapes, including retrieval's `superseded_by` subquery, which names `edge_class` and so probes `edges_dst` either way. A `derived = 0` reader that named no path reached for `edges_derived (derived, rel)` instead, which binds two columns where either directional pair binds one.

Dropping the predicate has a price, and it is not the index count: `edges` carries four either way. A partial index holds only the authored rows, so without the predicate both b-trees also hold every derived row. When the predicate was dropped, the sleep pipeline wrote thousands of derived rows per run; nothing writes one now. Measured on 2026-08-26, 20,000 derived-edge inserts in one transaction took 158 to 162 ms with the predicate and 184 to 188 ms without it over three repetitions, roughly 14 to 19 percent more per derived edge. That was the price of the walk's two probes, paid knowingly: a walk arm had been a full pass over `edges` per hop.

---
title: The index plane and the state plane
description: What git cannot reproduce, why it is gitignored anyway, and the byte-stable committed sidecar that keeps a copy of its access table.
---

## 1. What git cannot reproduce

The system keeps two SQLite databases, and this page calls them planes. The index plane, `.memhtml/index.db`, is mostly computed from the git tree. The state plane, `.memhtml/state.db`, holds usage facts that no file in the tree records (`packages/store/src/layout.ts:24-28`).

The state plane's migrations create three tables (`packages/index/state-migrations/S0001_access.sql:13-48`, `packages/index/state-migrations/S0002_entity_corroboration.sql:34-53`). `state.access` holds, per path, the access count, the reinforcement count, the outcome score, and when the memory was last read and last reinforced. `state.edge_corroboration` and `state.entity_corroboration` count the separate run dates on which each machine-proposed contradiction or entity merge was detected.

Reprieve counts are not in it. A reprieve extends a memory's validity window instead of archiving the memory, and the count is the `memhtml-reprieves` meta in the memory file (`packages/sleep/src/phases/reprieve.ts:72-76`).

The access columns change when an agent opens a memory through `readMemory` (`apps/cli/src/operations.ts:1162-1168`) or reinforces one through `reinforce` (`packages/index/src/reinforce.ts:69-110`), at most once per path every 900 seconds. A commit per bump would be a commit per memory an agent opens.

So `state.db` is gitignored like the index (`packages/store/src/layout.ts:55-59`), and unlike the index it cannot be rebuilt from the tree.

The durable copy of `state.access` is the committed sidecar `.memhtml/state/access.jsonl`, and `accessRows` reads that one table and no other (`packages/sleep/src/sql.ts:652-661`). Nothing exports the corroboration tables, so losing `state.db` starts them over. Losing it also loses every read and reinforcement since the last export.

Two things rewrite the sidecar whole: the `state-export` sleep phase, 16th of the 17 in `SLEEP_PHASES` as of v0.15.1 (`packages/sleep/src/contract.ts:43-61`), and `memhtml state export` through `stateExport` (`apps/cli/src/state.ts:54-89`). Either one commits only when the file's bytes change. The phase commits on the run's branch, which reaches `main` only if the run is merged.

| Plane | File                | In git | Rebuildable                                     |
| ----- | ------------------- | ------ | ----------------------------------------------- |
| index | `.memhtml/index.db` | no     | its memory rows, from `git ls-tree`             |
| state | `.memhtml/state.db` | no     | `state.access` only, from the committed sidecar |

Figure 1 redraws that table as a circuit, which puts the two recovery paths side by side and shows how narrow the state plane's is.

```d2 pad=20 src="_figures/two-planes.d2" title="The git tree and the committed sidecar state/access.jsonl are the two things a fresh clone carries. From the clone, index rebuild reconstructs the memory rows of index.db from ls-tree, and state import refills the access table of state.db from the sidecar. The state-export phase of a sleep run, or memhtml state export by hand, writes that table back to the sidecar and commits only when the bytes changed. Nothing on the drawing refills the two corroboration tables, so a clone starts them empty."
```

**Figure 1: two planes, two recovery paths, and only one of them is free.** `index.db`'s memory rows come back from the tree, which every clone carries. `state.access` comes back only from the sidecar, so its history ends at the last export that was committed. That is why the export is byte-stable: an unchanged table has to produce an identical file and no commit, or every run would add a sidecar commit whether or not anything was read.

On a fresh clone the order matters. An export before `memhtml state import` writes only the rows the clone recorded itself, and with none `renderSidecar` writes an empty file (`packages/sleep/src/phases/state-export.ts:65-66`). The export writes that file over the committed rows and commits it (`packages/sleep/src/phases/state-export.ts:70-86`, `apps/cli/src/state.ts:62-80`), and a sleep run that does this carries the short file to `main` when it is merged.

An import merges the file into the live table. It keeps the larger of each count, but the outcome score and `updated_at` take the file's value (`apps/cli/src/state.ts:137-143`), so importing an older sidecar onto a live plane rolls back a newer score.

## 2. The sidecar is byte-stable or it commits nothing

`accessRows` returns rows in path order from SQL (`packages/sleep/src/sql.ts:652-661`). `round4` rounds the outcome score to four decimals, and `toSidecarEntry` writes the keys in a fixed order (`packages/sleep/src/phases/state-export.ts:42-57`).

When that rendering equals the file on disk, the export returns before writing or staging anything, so an unchanged table makes no commit (`packages/sleep/src/phases/state-export.ts:75-76`, `apps/cli/src/state.ts:62-71`). The guarantee is scoped to one call against the working tree of one checkout, and to an unchanged table: a new count or timestamp, from a read or from an import, gives new bytes and a commit.

`memhtml state export` commits whatever else is already staged along with the sidecar, because its `git.commit` is not limited to that path (`apps/cli/src/state.ts:77-80`).

Four decimals is the grid of the domain's reference arithmetic, whose `SCALE` is 10,000 (`packages/domain/src/decay.ts:19-20`), but the stored score is not on that grid. `reinforce` computes the outcome average in SQL floats (`packages/index/src/reinforce.ts:103-104`), so `state.db` can hold `-0.03806000000000004` where the sidecar holds `-0.0381`. The rounding drops float noise and real digits alike, so a restored score can differ from the original by up to 0.00005.

`round4` also turns `-0` into `0` (`packages/sleep/src/phases/state-export.ts:42-46`), though `JSON.stringify` already writes `-0` as `0`, so the bytes would match without it.

`parseSidecar` skips and counts a line that is not JSON or has no `path` (`packages/sleep/src/phases/state-export.ts:97-125`), so a file cut short by an interrupted write still restores the rows it holds. The import writes its rows through `writeAll` in one transaction (`apps/cli/src/state.ts:131-154`, `packages/index/src/database.ts:374-389`), so a line that parses but breaks a table constraint, such as a negative count, fails the whole import and restores nothing.

## 3. Cross-database references are explicit

SQLite has no cross-database foreign keys, and `state.access` is keyed on the path alone (`packages/index/state-migrations/S0001_access.sql:13-17`). So when the store archives a file, it calls an explicit `onMove` hook after the `git.mv` and before the commit (`packages/store/src/store.ts:587-596`). The CLI wires that hook to an `UPDATE` of `state.access` (`apps/cli/src/api-layer.ts:202-212`).

The hook covers only the moves the store itself makes. Sleep phases archive through their own `archiveFile` and re-file in the `placement-triage` phase, and both call `git.mv` directly (`packages/sleep/src/edits.ts:221`, `packages/sleep/src/phases/placement-triage.ts:373`). Their access rows stay at the old path, as do the rows of a file someone moves by hand.

`memhtml doctor` reports an access row whose path has no `files` row (`apps/cli/src/doctor.ts:266-278`), so `orphanAccess` finds a missed move once the index has caught up with it. `memhtml doctor --fix` issues a `DELETE` for each such row rather than moving it, which drops that memory's access history (`apps/cli/src/doctor.ts:600-612`).

The alternative would be to key the state plane on something other than the path, which means inventing a second identity for a memory. The path is the id: it is the primary key of `files` (`packages/index/migrations/0001_files.sql:15`) and of `state.access` (`packages/index/state-migrations/S0001_access.sql:17`).

## 4. An integration test checks the round trip

`tests-integration/tests/clone.test.ts` builds an origin with two memories, reinforces one, exports the sidecar, and clones the origin with git (`tests-integration/tests/clone.test.ts:31-63`). It asserts that neither database is tracked in the clone and that `.gitignore` names both (`tests-integration/tests/clone.test.ts:70-83`).

After `memhtml init` (`tests-integration/tests/clone.test.ts:62`), the clone runs `state import` and `index rebuild`, and the test compares `path`, `access_count`, and `reinforcement_count` across the two `state.access` tables (`tests-integration/tests/clone.test.ts:104-149`).

Comparing the counts is the point. Asserting that the rows exist would pass against an import that wrote every count as zero.

That proves the round trip for one fixture and those three columns. The test does not compare the outcome score or the timestamps, run the `state-export` phase, try an export before the import, or look at the corroboration tables.

The procedure this implies, exporting before a machine goes away and importing first on a fresh clone, is the operations how-to [Preserve the state plane](/learn/operations/preserve-the-state-plane/).

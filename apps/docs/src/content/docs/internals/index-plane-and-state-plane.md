---
title: The index plane and the state plane
description: What git cannot reproduce, why it is gitignored anyway, and the byte-stable committed sidecar that is the only durable copy of its access rows.
---

## 1. What git cannot reproduce

The system keeps two databases, and this page calls them planes. The index plane, `.memhtml/index.db`, holds memory rows computed from the git tree. The state plane, `.memhtml/state.db`, holds the usage statistics no file in the tree records: access counts, reinforcement counts, the outcome EWMA (a running average of positive and negative signals), and the corroboration counts for edges and entity merges.

The access count moves each time a caller opens or reinforces a memory, at most once per path every 900 seconds, and search and recall leave it alone (`apps/cli/src/operations.ts::readMemory`, `packages/index/src/reinforce.ts::reinforce`). A commit per access bump would be a commit per memory an agent opens.

So `state.db` is gitignored like the index, and unlike the index it cannot be rebuilt from the tree. `memhtml state export` rewrites the whole `access` table, one line per access row, into a JSONL sidecar, `.memhtml/state/access.jsonl`, and commits it (`packages/store/src/layout.ts::STATE_DB_PATH`, `packages/store/src/layout.ts::STATE_SIDECAR_PATH`, `packages/index/src/sidecar.ts::accessRows`, `apps/cli/src/state.ts::stateExport`). The two corroboration tables have no copy outside `state.db`, so a fresh clone starts them empty.

| Plane | File                | In git | Rebuildable                     |
| ----- | ------------------- | ------ | ------------------------------- |
| index | `.memhtml/index.db` | no     | memory rows, from `git ls-tree` |
| state | `.memhtml/state.db` | no     | access rows, from the sidecar   |

Figure 1 redraws that table as a circuit. It puts the two recovery paths side by side and shows how narrow the state plane's is.

```d2 pad=20 src="_figures/two-planes.d2" title="The git tree and the committed sidecar state/access.jsonl are the two things that arrive with a fresh clone. From the clone, index rebuild reconstructs the memory rows of index.db from ls-tree, and state import restores the access rows of state.db from the sidecar only. memhtml state export rewrites the sidecar from those rows, byte-stable, and commits only when the file changes. On a fresh clone nothing else restores state.db, so the sidecar is the only path by which access history survives."
```

**Figure 1: two planes, two recovery paths, and only one of them is free.** The memory rows of `index.db` come back from the tree, which every clone carries. `state.db` has exactly one inbound arrow, from the sidecar, so on a fresh clone its access history ends at the last export that ran. That is why the export is byte-stable: over an unchanged plane it must leave the file alone and make no commit, or every routine export churns a commit that nobody reviews.

## 2. The sidecar is byte-stable or it commits nothing

Rows arrive from SQL in path order, floats round to four decimals, and keys are written in a fixed order (`packages/index/src/sidecar.ts::accessRows`, `packages/index/src/sidecar.ts::toSidecarEntry`). When the rendered file matches the one on disk, `memhtml state export` writes nothing and makes no commit (`apps/cli/src/state.ts::stateExport`).

Four decimals is the export's own rounding (`packages/index/src/sidecar.ts::round4`), not a grid the outcome EWMA lives on. The EWMA is computed in float SQL (`packages/index/src/reinforce.ts::reinforce`) and can carry a fifth digit, which the sidecar drops. `-0` is normalized to `0`, so two equal planes render identically.

`parseSidecar` (`packages/index/src/sidecar.ts::parseSidecar`) skips an unparseable line and counts it rather than failing the import. The sidecar is the only durable copy of the access rows, and refusing a file that an interrupted write left truncated would turn a partial loss into a total one.

## 3. Cross-database references are explicit

SQLite has no cross-database foreign keys, so a path move is mirrored by an explicit `onMove` hook that the store calls when it archives a path (`packages/store/src/store.ts::MoveCallback`, `packages/store/src/store.ts::makeStore::stageArchive`, `apps/cli/src/api-layer.ts::layerStore`). A session commit moves and archives paths without calling it (`packages/session/src/commit.ts::stage`), so the access row of a path it moves stays under the old path.

`memhtml doctor` reports every access row whose path the index does not hold, and `doctor --fix` deletes those rows (`apps/cli/src/doctor.ts::orphanAccess`).

The alternative to the explicit hook would be to key the state plane on something other than the path, which means inventing a second identity for a memory. The path is the id (`packages/contracts/src/types.ts::MemoryPath`).

## 4. An integration test proves the claim

`tests-integration/tests/clone.test.ts` runs the whole path. It clones the memory repository and runs `memhtml init`, asserts that the clone tracks neither database, then runs `state import` and `index rebuild` and checks that the origin's access and reinforcement counts come back. It compares the counts themselves rather than the presence of the rows.

Asserting that the rows exist would pass against a sidecar that wrote every count as zero.

The operational procedure this implies, exporting, committing, and importing the sidecar around any move of the store, is in [Preserve the state plane](/learn/operations/preserve-the-state-plane/).

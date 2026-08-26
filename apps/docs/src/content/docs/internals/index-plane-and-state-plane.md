---
title: The index plane and the state plane
description: What git cannot reproduce, why it is gitignored anyway, and the byte-stable committed sidecar that is its only durable copy.
---

## 1. What git cannot reproduce

The system keeps two databases, and this page calls them planes. The index plane, `.memhtml/index.db`, is computed from the git tree. The state plane, `.memhtml/state.db`, holds the usage statistics no file in the tree records: access counts, reinforcement counts, the outcome average, the bookkeeping behind reprieves, and edge corroboration counts. A reprieve is an extension of a memory's validity window granted instead of evicting it, and the count of how many a memory has already had lives here.

Those numbers change on every read. A commit per access bump would be a commit per memory an agent opens.

So `state.db` is gitignored like the index, and unlike the index it cannot be rebuilt from the tree. Its durable copy is an append-only JSONL sidecar, `.memhtml/state/access.jsonl`, which the sleep cycle commits once per run (`packages/store/src/layout.ts:27-31`, `packages/sleep/src/phases/state-export.ts:9-25`).

| Plane | File                | In git | Rebuildable                     |
| ----- | ------------------- | ------ | ------------------------------- |
| index | `.memhtml/index.db` | no     | yes, from `git ls-tree`         |
| state | `.memhtml/state.db` | no     | only from the committed sidecar |

Figure 1 redraws that table as a circuit, which puts the two recovery paths side by side and shows how narrow the state plane's is.

```d2 pad=20 src="_figures/two-planes.d2" title="The git tree and the committed sidecar state/access.jsonl are the two things that arrive with a fresh clone. From the clone, index rebuild reconstructs index.db from ls-tree, and state import reconstructs state.db from the sidecar only. state.db is exported back to the sidecar on every run by phase fourteen, byte-stable or committing nothing. Nothing else reaches state.db, so the sidecar is the only path by which the plane survives."
```

**Figure 1: two planes, two recovery paths, and only one of them is free.** `index.db` comes back from the tree, which every clone carries. `state.db` has exactly one inbound arrow, from the sidecar, so if that export has not run then the plane's history ends at the last export that did. That is why the export is byte-stable: an unchanged plane has to produce an identical file whose commit is empty, or the sidecar churns a commit every night and nobody reviews it.

## 2. The sidecar is byte-stable or it commits nothing

Rows arrive from SQL in path order, floats round to four decimals, keys are written in a fixed order, and an unchanged plane produces an identical file whose commit is empty (`packages/sleep/src/phases/state-export.ts:65`, `packages/sleep/src/phases/state-export.ts:75-78`).

Four decimals is the grid the outcome average already lives on (`packages/domain/src/decay.ts:13`), so a fifth digit would be float noise that changes the file's bytes without changing its meaning. `-0` is normalized to `0`, so two equal planes render identically.

`parseSidecar` (`packages/sleep/src/phases/state-export.ts:97`) skips an unparseable line and counts it rather than failing the import. This is the only durable copy of the plane, and refusing a file that an interrupted write left truncated would turn a partial loss into a total one.

## 3. Cross-database references are explicit

SQLite has no cross-database foreign keys, so a path move is mirrored by an explicit `onMove` hook that the store calls at the single place a path can change (`packages/store/src/store.ts:174-181`, `apps/cli/src/api-layer.ts:209`), and `memhtml doctor` reports rows the hook missed.

The alternative would be to key the state plane on something other than the path, which means inventing a second identity for a memory. The path is the id (`packages/contracts/src/types.ts:102-107`).

## 4. An integration test proves the claim

`tests-integration/tests/clone.test.ts` runs the whole path. It clones the memory repository, asserts that neither database came with the clone, then runs `memhtml init`, `state import`, and `index rebuild`, and checks that the origin's access counts come back. It checks the counts themselves rather than the presence of the rows.

Asserting that the rows exist would pass against a sidecar that wrote every count as zero.

The operational procedure this implies, exporting, committing, and importing the sidecar around any move of the store, is an operations how-to under [Learn](/learn/).

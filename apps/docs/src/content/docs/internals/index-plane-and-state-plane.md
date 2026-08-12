---
title: The index plane and the state plane
description: What git cannot reproduce, why it is gitignored anyway, and the byte-stable committed sidecar that is its only durable copy.
---

## 1. The one thing git cannot reproduce

Access counts, reinforcement counts, the outcome EWMA, reprieve bookkeeping, and edge corroboration are
the only state git cannot reproduce, and they are high-churn: a commit per access bump would be a commit
per memory an agent opens.

So `state.db` is gitignored like the index — but unlike the index it is **not** rebuildable from the
tree. Its durability story is an append-only JSONL sidecar, `.memhtml/state/access.jsonl`, committed once
per night by the sleep cycle (`packages/store/src/layout.ts:27-31`,
`packages/sleep/src/phases/state-export.ts:9-25`).

Two planes, two properties:

| Plane | File | In git | Rebuildable |
|---|---|---|---|
| index | `.memhtml/index.db` | no | yes, from `git ls-tree` |
| state | `.memhtml/state.db` | no | only from the committed sidecar |

Figure 1 is that table as a circuit, which is what the table cannot be: it puts the two recovery paths
side by side and shows how narrow the state plane's is.

```d2 pad=20 src="_figures/two-planes.d2" title="The git tree and the committed sidecar state/access.jsonl are the two things that arrive with a fresh clone. From the clone, index rebuild reconstructs index.db from ls-tree, and state import reconstructs state.db from the sidecar only. state.db is exported back to the sidecar nightly by phase fourteen, byte-stable or committing nothing. Nothing else reaches state.db, so the sidecar is the only path by which the plane survives."
```

**Figure 1: two planes, two recovery paths, and only one of them is free.** `index.db` comes back from
the tree, which every clone carries. `state.db` has exactly one inbound arrow — from the sidecar — so if
the nightly export has not run, the plane's history ends at the last one that did. That is why the export
is byte-stable: an unchanged plane must produce an identical file whose commit is empty, or the sidecar
churns a commit every night and nobody reviews it.

## 2. The sidecar is byte-stable or it commits nothing

Rows arrive path-ordered from SQL, floats round to four decimals, keys are written in fixed order, and an
unchanged plane produces an identical file whose commit is empty
(`packages/sleep/src/phases/state-export.ts:65`,
`packages/sleep/src/phases/state-export.ts:75-78`).

Four decimals is the grid the outcome EWMA lives on (`packages/domain/src/decay.ts:13`), so a fifth digit
would be float noise that changes the file's bytes without changing its meaning. `-0` normalizes to `0`
so two equal planes render identically.

`parseSidecar` (`packages/sleep/src/phases/state-export.ts:97`) skips and counts an unparseable line
rather than failing the import — this is the only durable copy of the plane, and refusing a file truncated
by an interrupted write would turn a partial loss into a total one.

## 3. Cross-database references are explicit

Cross-database foreign keys do not exist, so a path move is mirrored by an explicit `onMove` hook the
store calls at the one place a path can change (`packages/store/src/store.ts:160-168`,
`apps/cli/src/api-layer.ts:203`), and `memhtml doctor` reports orphaned rows.

The alternative — deriving the state plane's keys from something other than the path — would mean
inventing a second identity for a memory, and the path is the id
(`packages/contracts/src/types.ts:102-107`).

## 4. The claim is tested end to end

`tests-integration/tests/clone.test.ts` exercises the whole claim: clone the memory repo, assert neither
database came with it, then `memhtml init` + `state import` + `index rebuild` and check that the origin's
access *counts* — not merely the rows' existence — come back.

Asserting the rows exist would pass against a sidecar that wrote every count as zero. The counts are the
fact; their presence is not.

The operational procedure this implies — export, commit, and import the sidecar around any move of the
store — is an operations how-to under [Learn](/learn/).

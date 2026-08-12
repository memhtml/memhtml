---
title: Recover from a lost index
description: Restore a store from a clone in four commands, in the order that matters, and know exactly what a rebuild cannot bring back.
---

**Losing `.memhtml/` costs nothing but time, provided the tree and the sidecar are pushed.**

```bash
git clone <remote> ~/memhtml
cd ~/memhtml
export MEMHTML_ROOT=~/memhtml

memhtml init                      # re-set merge.ours.driver — per-clone, not cloned
memhtml state import              # restore the access plane from .memhtml/state/access.jsonl
memhtml index rebuild --embed     # reproject the tree

memhtml status                    # indexFresh true, embedderUp true, counts match the tree
memhtml doctor                    # expect healthy
memhtml eval discriminate         # expect passed true
```

## Order matters

- **`memhtml init` first**, because the merge driver is per-clone. `.gitattributes` travels with the clone
  and the `merge.ours.driver` config does not, so until you run it, the first merge touching a generated
  file writes conflict markers into it.
- **`memhtml state import` before the rebuild**, so the salience arm has signal on the first query rather
  than after the first night.
- **The rebuild last**, because it is the only step that costs Bedrock calls and the one you re-run if it
  is interrupted.

None of the three is destructive and all three are idempotent, so a recovery interrupted anywhere is
resumed by running the sequence again.

## What survives, and what it survives as

The git tree is the system of record: every memory, every authored `<link>`, every `<meta>`, and the
history of every eviction via `git log --follow`. `.memhtml/state/access.jsonl` and
`.memhtml/sleep/<run-id>.html` are committed too.

| Artifact | Rebuilds from | Cost |
|---|---|---|
| `index.db` — embeddings, mined edges, chunks, FTS | The tree | `memhtml index rebuild --embed`. The Bedrock calls are the only real expense. |
| `state.db` — access counts, reinforcement counts, the outcome EWMA | **The sidecar only** | `memhtml state import`. Anything since the last export is gone. |
| The trace tables | `$MEMHTML_TRACE_ROOT` | `memhtml trace index` from a zero watermark: slow, not lossy. |
| An unmerged `sleep/<date>` branch | Nothing, unless it was pushed | Re-run the sleep. Every phase is idempotent. |

The one lossy row in that table is `state.db`, and the loss is bounded by how recently `state export` ran.
Sleep runs `state-export` as its penultimate phase, which is why it refreshes every night regardless of
query volume — and why you should run it by hand before a machine goes away. See [preserve the state
plane](/learn/operations/preserve-the-state-plane/).

## Confirming the recovery

`memhtml status` is the check, and three fields are the answer:

```bash
memhtml status --dense | jq '{indexFresh: .data.indexFresh, embedderUp: .data.embedderUp, counts: .data.countsByType}'
```

`indexFresh: true` means the projection describes the current HEAD. `embedderUp: true` means the stored
vector space is the configured one and there is at least one vector — it is read off the stored watermark,
so it is a statement about this index rather than about Bedrock's availability. `countsByType` is the
per-type census; compare it against the store you remember, and against `memhtml index status`'s
`activeFiles`.

Then `memhtml doctor` for `healthy: true`, and `memhtml eval discriminate` for `passed: true`. The gate is
worth running here specifically: it proves the rebuilt vector space discriminates, which a row count
cannot.

## Recovering without a remote

If the tree is intact on disk and only `.memhtml/` is gone, skip the clone:

```bash
memhtml state import
memhtml index rebuild --embed
```

And if only the database file is gone and you do nothing at all, the cron heals it: `memhtml index update`
with no recorded watermark falls through to a rebuild on its own
(`packages/index/src/indexer.ts:565`). The next scheduled pass is simply slower than usual.

## What a rebuild deliberately does not touch

A rebuild drops the FTS index, deletes every memory table, reprojects, and recreates the index
(`packages/index/src/indexer.ts:389`). It destroys nothing outside `.memhtml/`, and inside it touches
neither the trace tables nor the attached state plane.

So running `memhtml index rebuild` as a diagnostic is cheap and safe: it cannot lose an access count and it
cannot cost you a re-walk of `$MEMHTML_TRACE_ROOT`.

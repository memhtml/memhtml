---
title: Recover from a lost index
description: Restore a store from a clone in four commands, in the order that matters, and know exactly what a rebuild cannot bring back.
---

Losing `.memhtml/` costs you time and nothing else, as long as the tree and the sidecar are pushed.

```bash
git clone <remote> ~/memhtml
cd ~/memhtml
export MEMHTML_ROOT=~/memhtml

memhtml init                      # re-set merge.ours.driver: per-clone config, never cloned
memhtml state import              # restore the access plane from .memhtml/state/access.jsonl
memhtml index rebuild --embed     # reproject the tree

memhtml status                    # indexFresh true, embedderUp true, counts match the tree
memhtml doctor                    # expect healthy
memhtml eval discriminate         # expect passed true
```

## Run them in this order

Run `memhtml init` first, because the merge driver it configures lives in this clone and nowhere else.
`.gitattributes` travels with the clone and the `merge.ours.driver` config does not, so until you run
it, the first merge that touches a generated file writes conflict markers into that file.

Run `memhtml state import` before the rebuild. Retrieval ranks a query with four arms: full-text
search, vector similarity, recency, and salience, which favors memories you have opened and
reinforced before. The import gives the salience arm signal on your first query instead of after the
first night.

Run the rebuild last, because it is the only step that spends Bedrock calls and the one you re-run if
it gets interrupted.

None of the three destroys anything and all three are safe to repeat, so a recovery interrupted
anywhere is finished by running the sequence again.

## What survives, and what it survives as

The git tree is the system of record. It holds every memory, every authored `<link>`, every `<meta>`,
and, through `git log --follow`, the history of every eviction. `.memhtml/state/access.jsonl` and
`.memhtml/sleep/<run-id>.html` are committed too.

| Artifact | Rebuilds from | Cost |
|---|---|---|
| `index.db`: embeddings, mined edges, chunks, full-text search | The tree | `memhtml index rebuild --embed`. The Bedrock calls are the only real expense. |
| `state.db`: access counts, reinforcement counts, and the outcome EWMA, a running average of positive and negative signals | The sidecar only | `memhtml state import`. Anything since the last export is gone. |
| The trace tables | `$MEMHTML_TRACE_ROOT` | `memhtml trace index` from a zero watermark: slow, and it loses nothing. |
| An unmerged `sleep/<date>` branch | Nothing, unless it was pushed | Re-run the sleep cycle. Every phase is safe to repeat. |

:::agent
**For an agent.** A path that returns nothing can still hold a live memory. A lost or stale index
makes a memory impossible to retrieve while the file sits in the tree, and eviction moves a file with
`git mv` into `archive/<YYYY>/` instead of deleting it. So before you report anything as gone, retry
with `--include-archived` and check `memhtml status` for a stale index. Reporting an absence as a
deletion writes a false fact into the corpus.
:::

The one lossy row in that table is `state.db`, and the size of the loss is bounded by how recently
`state export` ran. The sleep cycle runs `state-export` as its second-to-last phase, which refreshes
the sidecar every night whatever the query volume. Run it by hand as well before a machine goes away.
See [preserve the state plane](/learn/operations/preserve-the-state-plane/).

## Confirming the recovery

`memhtml status` is the check, and three fields carry the answer:

```bash
memhtml status --dense | jq '{indexFresh: .data.indexFresh, embedderUp: .data.embedderUp, counts: .data.countsByType}'
```

`indexFresh: true` means the index describes the current HEAD. `embedderUp: true` means the stored
vectors are in the configured model's space and there is at least one of them. That field is read off
the stored watermark, so it tells you about this index rather than about whether Bedrock is reachable.
`countsByType` is the per-type census: compare it against the store you remember, and against
`activeFiles` on `memhtml index status`.

Then run `memhtml doctor` and expect `healthy: true`, and `memhtml eval discriminate` and expect
`passed: true`. That second command is the discrimination gate: it checks that every probe query
ranks its target fact above deliberately wrong versions of the same fact. Run it here specifically,
because it proves the rebuilt vectors still separate a fact from a near-copy that contradicts it, and
a row count cannot show you that.

## Recovering without a remote

If the tree is intact on disk and only `.memhtml/` is gone, skip the clone:

```bash
memhtml state import
memhtml index rebuild --embed
```

If only the database file is gone, the next cron pass rebuilds it with no action from you.
`memhtml index update` with no recorded watermark falls through to a rebuild on its own
(`packages/index/src/indexer.ts:565`), so that pass just takes longer than usual.

## What a rebuild leaves alone

A rebuild drops the full-text search index, deletes every memory table, reads the tree again, and
recreates the search index (`packages/index/src/indexer.ts:389`). It destroys nothing outside
`.memhtml/`, and inside `.memhtml/` it leaves the trace tables and the attached state plane
untouched.

So running `memhtml index rebuild` as a diagnostic is cheap and safe: it cannot lose an access count,
and it cannot cost you a re-walk of `$MEMHTML_TRACE_ROOT`.

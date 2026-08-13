---
title: Preserve the state plane
description: Export and import the access plane, the one set of facts the git tree cannot reproduce, and handle the hazard it carries across two machines.
---

```bash
memhtml state export      # write .memhtml/state/access.jsonl and commit it
memhtml state import      # replay the sidecar into state.db
```

`state.db` is gitignored, and unlike the index it cannot be rebuilt from git. It holds three things
the tree never records: how often each memory was opened, how often it was reinforced, and the outcome
EWMA, a running average of the positive and negative signals a memory has collected. The committed
sidecar `.memhtml/state/access.jsonl` is what survives (`apps/cli/src/state.ts:54`).

## Export

```json
{
  "apiVersion": "1",
  "type": "state.export",
  "data": {
    "path": ".memhtml/state/access.jsonl",
    "rows": 0,
    "bytes": 0,
    "written": true,
    "commitSha": "7ebc0ce7226c84b0ab29a77d0289bf6c8ade9280"
  }
}
```

The export is byte-stable: an unchanged plane produces an identical file. So `written: false` and
`commitSha: null` on a re-run mean the sidecar already held exactly this state, and that is what makes
the command safe to run on a schedule.

The sleep cycle runs `state-export` as its second-to-last phase, so the sidecar refreshes once a night
whatever the query volume. Run it by hand before a machine goes away, because anything since the last
export is what you lose.

## Import

```json
{
  "apiVersion": "1",
  "type": "state.import",
  "data": {
    "path": ".memhtml/state/access.jsonl",
    "rows": 0,
    "restored": 0,
    "skipped": 0,
    "hasState": true
  }
}
```

The import upserts with `max()` on the counters that only ever climb, rather than truncating the table
(`apps/cli/src/state.ts:131`). Importing onto a live plane therefore keeps any counter the sidecar
predates. An import is non-destructive every time, which is what makes it safe on a machine that has
been reading for a week.

`rows` is what the sidecar held and `restored` is what was written into `state.access`. The two differ
when the live plane already held higher counters. `skipped` counts sidecar lines that did not parse,
which is never fatal, because a partial file restores what it holds.

## The hazard with two machines

Two machines both committing memories is the conflict path git handles well.

`.memhtml/state/access.jsonl` merges as a whole file, so two machines' access counts never combine.
The later commit wins and the other machine's reads are lost. `memhtml state import` merges by taking
the larger of each pair of counters, which is what makes an import non-destructive; the file merge
underneath it is still last-writer-wins.

Run one writer. A second machine that reads the repo should run `memhtml state import` and leave
`memhtml state export` alone.

You detect a loss by hand, because nothing alarms on it. The symptom is an access count that goes down
across a pull:

```bash
memhtml state export        # note `rows`
git pull
memhtml state import        # `rows` from the sidecar; a drop is the symptom
```

Real multi-machine use needs counters that merge in any order, either by taking the larger value or by
summing per-machine sub-counters. Until someone builds that, treat a second machine as read-only for
state.

## Why this plane exists

It feeds one of retrieval's four ranking arms. A query is ranked by full-text search, vector
similarity, recency, and salience, and salience is the durable record of which memories were chosen,
read in the same SQL statement as the other three. A store with no state plane still retrieves: the
salience arm drops out and the ranking blends three arms instead of four. Losing the plane therefore
costs you ranking quality quietly rather than raising an error.

That is also why [recovery](/learn/operations/recover-from-a-lost-index/) runs `memhtml state import`
before the index rebuild, so the arm has signal on the very first query rather than after the first
night.

[The state plane and its committed sidecar](/internals/index-plane-and-state-plane/) covers the two
planes and how they are attached.

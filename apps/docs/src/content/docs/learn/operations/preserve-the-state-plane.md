---
title: Preserve the state plane
description: Export and import the access plane, the one set of facts the git tree cannot reproduce, and handle the hazard it carries across two machines.
---

```bash
memhtml state export      # write .memhtml/state/access.jsonl and commit it
memhtml state import      # replay the sidecar into state.db
```

`state.db` is gitignored, and unlike the index it cannot be rebuilt from git. Its access rows hold three things the tree never records: how often each memory was opened or reinforced, how often it got a positive or negative signal, and the outcome EWMA, a running average of those signals. The committed sidecar `.memhtml/state/access.jsonl` is what survives of them (`apps/cli/src/state.ts::stateExport`).

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

The export is byte-stable: an unchanged plane produces an identical file. So `written: false` and `commitSha: null` on a re-run mean the sidecar already held exactly this state, and that is what makes the command safe to run on a schedule.

Nothing runs `state export` for you, so put it on the cron beside `memhtml publish` and run it by hand before a machine goes away, because anything since the last export is what you lose.

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

The import upserts with `max()` on the counters that only ever climb, rather than truncating the table (`apps/cli/src/state.ts::stateImport`). Importing onto a live plane therefore keeps any counter the sidecar predates, which is what makes it safe on a machine that has been reading for a week. It does set each outcome EWMA back to the file's value.

`rows` is what the sidecar held and `restored` is what was written into `state.access`. `skipped` counts sidecar lines that did not parse, which is never fatal, because a partial file restores what it holds.

## The hazard with two machines

Two machines both committing memories is the conflict path git handles well.

Git merges `.memhtml/state/access.jsonl` line by line, with no merge driver, so two machines' counts for one memory never add up: changes to rows that are not adjacent merge cleanly, and changes to the same or adjacent rows conflict. `memhtml state import` keeps the larger of each access count and reinforcement count, and it overwrites the outcome EWMA with the file's value.

Run one writer. A second machine that reads the repo should run `memhtml state import` and leave `memhtml state export` alone.

You detect a loss by hand, because nothing alarms on it. The symptom is an access count that goes down across a pull:

```bash
memhtml state export        # note `rows`
git pull
memhtml state import        # `rows` from the sidecar; a drop is the symptom
```

Real multi-machine use needs counters that merge in any order, either by taking the larger value or by summing per-machine sub-counters. Until someone builds that, treat a second machine as read-only for state.

## Why this plane exists

It feeds one of retrieval's four ranking arms. A query is ranked by full-text search, vector similarity, recency, and salience, and salience is the durable record of which memories were chosen, read in the same SQL statement as the other three. A store with no state plane still retrieves: the salience arm drops out and the ranking blends three arms instead of four. Losing the plane therefore costs you ranking quality quietly rather than raising an error.

That is also why [recovery](/learn/operations/recover-from-a-lost-index/) runs `memhtml state import` before the index rebuild, so the arm has signal on the very first query rather than after the first night.

[The state plane and its committed sidecar](/internals/index-plane-and-state-plane/) covers the two planes and how they are attached.

---
title: Preserve the state plane
description: Export and import the access rows in state.db, which the git tree cannot reproduce, and handle the hazard they carry across two machines.
---

```bash
memhtml state export      # write .memhtml/state/access.jsonl and commit it
memhtml state import      # replay the sidecar into state.db
```

`state.db` is gitignored, and unlike the index it cannot be rebuilt from git. Its access rows hold what the tree never records: how often each memory was opened or reinforced, how often it got a positive or negative signal, the outcome EWMA (a running average of those signals), and the times of its last bump and its last signal. The committed sidecar `.memhtml/state/access.jsonl` carries those rows, timestamps included, and nothing else from `state.db` (`apps/cli/src/state.ts::stateExport`, `packages/index/src/sidecar.ts::accessRows`).

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

The export is byte-stable: an unchanged plane produces an identical file. So `written: false` and `commitSha: null` on a re-run mean the file on disk already held exactly this state, and that is what makes the command safe to repeat.

Nothing runs `state export` for you. Run it on one machine only, with the other [upkeep commands](/learn/operations/run-the-store-day-to-day/), and run it and push before that machine goes away, because a machine that goes away takes every access-row change since its last pushed export with it.

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

The import upserts each line rather than truncating the table (`apps/cli/src/state.ts::stateImport`). It keeps the larger of each access count and reinforcement count, so an import never lowers a count, though it never adds one machine's bumps to another's either. It sets each outcome EWMA back to the file's value, and it leaves a row the sidecar lacks as it was.

`rows` counts the sidecar lines that parsed, and `restored` counts the ones written into `state.access`. `skipped` counts the lines that did not parse, and it is never fatal: the import still exits 0, because a partial file restores what it holds.

## The hazard with two machines

Two machines both committing memories is the conflict path git handles well.

Git merges `.memhtml/state/access.jsonl` line by line, with no merge driver. Changes to lines that are not adjacent merge cleanly, and changes to the same or adjacent lines conflict, so two machines' counts for one memory never add up. `memhtml state import` keeps the larger of each access count and reinforcement count, and it overwrites the outcome EWMA with the file's value.

Export from one machine only. Any other machine should run `memhtml state import` and leave `memhtml state export` alone. Its own reads still bump its `state.db`, but they never reach the sidecar.

You detect a loss in the sidecar by hand, because nothing alarms on it. Before you pull, look for a sidecar line whose `accessCount` goes down, or that disappears, in the commits the pull would bring in:

```bash
git fetch
git diff HEAD...@{upstream} -- .memhtml/state/access.jsonl   # a lower accessCount on a + line, or a removed line not re-added under archive/
```

Real multi-machine use needs counters that merge in any order, either by taking the larger value or by summing per-machine sub-counters. Until someone builds that, keep `memhtml state export` on one machine.

## Why this plane exists

It feeds the salience arm, one of the four ranking arms `memhtml search` and `memhtml recall` fuse in one SQL statement, beside full-text search, vector similarity, and recency (`packages/index/src/retrieval-sql.ts::salienceArm`). Salience is the durable record of which memories were chosen. The MCP tools `memory_search` and `memory_recall` ask a running head server first, and a head ranks with a lexical and a vector arm only, so its answers never read this plane (`apps/cli/src/head-retrieval.ts::routeFor`).

A store that loses `state.db` still retrieves. The next command opens an empty one, and the salience arm then ranks files by their `updated_at` alone. Losing the plane therefore costs you ranking quality quietly rather than raising an error.

[Recovery](/learn/operations/recover-from-a-lost-index/) runs `memhtml state import` right after `memhtml init` and before any export for two reasons: the arm then has the sidecar's history on the first query, and an export on a clone that has not imported commits that clone's own rows, or an empty file, over the sidecar.

[The index plane and the state plane](/internals/index-plane-and-state-plane/) covers what each database holds, why the sidecar is byte-stable, and how a path move reaches `state.access`.

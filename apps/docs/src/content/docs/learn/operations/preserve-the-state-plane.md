---
title: Preserve the state plane
description: Export and import the access table that git cannot rebuild, and keep a new clone or a second machine from overwriting it.
---

```bash
memhtml state export      # write state.access to .memhtml/state/access.jsonl, and commit it if the bytes changed
memhtml state import      # merge that file into state.db; on a new clone, run this first
```

`state.db` is gitignored, and unlike the index it cannot be rebuilt from the tree (`packages/store/src/layout.ts:55-59`). Its `state.access` table holds, per memory, the access count, the reinforcement count, the outcome score, and three timestamps. The outcome score is a running average of the positive and negative reinforcement signals a memory has received.

The committed sidecar `.memhtml/state/access.jsonl` is a copy of that one table (`packages/sleep/src/sql.ts:652-661`). `state.db` also holds the corroboration tables `edge_corroboration` and `entity_corroboration`, and nothing exports them (`packages/index/state-migrations/S0001_access.sql:39-48`, `packages/index/state-migrations/S0002_entity_corroboration.sql:34-53`). So losing `state.db` starts the corroboration counts over and loses every read and reinforcement since the last export.

## Export

```json
{
  "apiVersion": "1",
  "type": "state.export",
  "data": {
    "path": ".memhtml/state/access.jsonl",
    "rows": 5,
    "bytes": 1131,
    "written": true,
    "commitSha": "47be14906a9938e3d8516f32e92850d0a9a5a86f"
  }
}
```

`rows` is the number of rows in `state.access`, one line each. `written: true` means the export rewrote the file and staged it, and `commitSha` names the commit it made, or is `null` if nothing staged differed from `HEAD` (`apps/cli/src/state.ts:73-88`, `packages/store/src/git.ts:402-405`). That commit lands on the checked-out branch, takes anything else already staged with it, and is not pushed.

A second run with nothing changed returns `written: false` and `commitSha: null`, and it writes, stages and commits nothing (`apps/cli/src/state.ts:62-71`). The export is byte-stable: rows come out in path order, the outcome score is rounded to four decimals, and the keys are in a fixed order (`packages/sleep/src/sql.ts:652-661`, `packages/sleep/src/phases/state-export.ts:42-57`). So an unchanged table renders the same bytes in any checkout, and an export right after a new clone's import is a no-op too. The check is one call against this checkout's working-tree file. Any read, reinforcement or import that changes the table gives new bytes and a commit.

Each sleep run does the same in its `state-export` phase, 16th of the 17 in `SLEEP_PHASES` as of v0.15.1 (`packages/sleep/src/contract.ts:43-61`). It runs whether or not anything was read since the last run, unless `--phases` leaves it out or `preflight` failed (`packages/sleep/src/contract.ts:123`). It commits on the run's branch, so its file reaches `main` only when the run is merged.

Before the machine that exports goes away, run `memhtml state export`, check that `git status` no longer lists the sidecar, and push. A push saves only the access table, so the corroboration counts are lost either way.

## Import

```json
{
  "apiVersion": "1",
  "type": "state.import",
  "data": {
    "path": ".memhtml/state/access.jsonl",
    "rows": 5,
    "restored": 5,
    "skipped": 0,
    "hasState": true
  }
}
```

`rows` counts the sidecar lines that parsed. From the CLI, `restored` always equals it and `hasState` is always `true`, because the CLI always attaches `state.db` (`apps/cli/src/api-layer.ts:126-136`, `apps/cli/src/state.ts:121-162`). A path listed twice counts twice in both, and a missing or empty file reports 0 for both.

`skipped` counts lines that are not JSON or have no `path`. They do not stop the import, so a file cut short still restores the lines it holds (`packages/sleep/src/phases/state-export.ts:97-125`). Conflict markers are such lines, so a nonzero `skipped` after a pull can mean you imported an unresolved merge. A line that parses but breaks a table constraint, such as a negative count, is fatal. The import writes every row through `writeAll` in one transaction, so it exits 1 and restores nothing (`apps/cli/src/state.ts:131-154`, `packages/index/src/database.ts:374-389`).

The import merges into the live table rather than replacing it. Counts take the larger value, but the outcome score and `updated_at` take the file's value (`apps/cli/src/state.ts:137-143`). So an import onto a table that has moved on since the export keeps its counts and rolls back its newer scores. That merge rule holds inside one import into one `state.db`. Git applies nothing like it when it merges the file, as the two-machine section below shows.

## A new clone imports first

On a new clone, run `memhtml state import` right after `memhtml init`, before any `memhtml state export` and before any sleep run. Both of those write this clone's own table over the committed file (`apps/cli/src/state.ts:62-80`, `packages/sleep/src/phases/state-export.ts:68-88`).

With no reads or reinforcements yet, even after a write, `renderSidecar` turns the empty table into an empty file (`packages/sleep/src/phases/state-export.ts:65-66`). After one read the file holds only that row, because `readMemory` adds it (`apps/cli/src/operations.ts:1162-1168`). Either way the commit deletes every other row, and a merged sleep run carries it to `main`. No check looks at the file, so nothing warns you.

[Recovery](/learn/operations/recover-from-a-lost-index/) runs the import straight after `memhtml init`, and that is the part of its order that matters. The index rebuild deletes only the index's memory tables (`packages/index/src/indexer.ts:414`), so the import works the same before or after it.

## The hazard with two machines

`.gitattributes` gives the sidecar no merge driver (`packages/store/src/layout.ts:70-73`). So git merges it line by line, like any text file, with one line per memory in path order.

If two machines exported changes to memories whose lines are not adjacent, the merge is clean and each line comes from the side that changed it. If they changed the same line or adjacent lines, the merge stops with a conflict and leaves the usual `<<<<<<<`, `=======` and `>>>>>>>` markers around those lines. Either way, git never adds the two machines' counts together.

Run one writer: one machine runs `memhtml state export` and the sleep cycle, and no other machine runs either. Nothing enforces this, so it holds only as long as you keep it. Set up any other machine as a new clone, importing first, and let it run `memhtml state import` after a pull to rank with the writer's counts. Its own reads stay on that machine.

On the writer, look at each pull before importing anything:

```bash
git pull --no-rebase
git diff --stat ORIG_HEAD HEAD -- .memhtml/state/access.jsonl   # any change here came from another machine
memhtml state export                                             # if it did: rewrite the file from this machine's table
```

The writer's own exports are already in `ORIG_HEAD`, so a change the diff shows came from a second writer, often a clone that exported before importing. Do not import it. An import would keep the larger counts but take the file's outcome scores, which rolls back any score the writer changed since. Run `memhtml state export` instead, which rewrites the file from the writer's table and commits it, and push.

If the pull stopped on a conflict in the sidecar, keep the writer's side with `git checkout --ours -- .memhtml/state/access.jsonl`, then `git add` the file and `git commit`.

For example, a clone that read one memory and then exported pushed a one-line file. The writer's import of that file reported `rows: 1` instead of 5 and reset the memory's outcome score from 0.3 to 0. An export without the import put all five rows back.

## Why this plane exists

It feeds the salience arm, one of the four ranking arms in `RANK_ARMS` as of v0.15.1, beside full-text search, vector similarity, and recency (`packages/index/src/retrieval-sql.ts:268`). Salience scores a memory from its access count, how recently it was accessed, and its outcome score. `salienceArm` reads `state.access` through a `LEFT JOIN`, and `buildRrfSql` puts every arm in one SQL statement (`packages/index/src/retrieval-sql.ts:246-265`, `packages/index/src/retrieval-sql.ts:307-319`).

Losing the plane does not drop the arm. `layerDatabase` attaches `state.db` on every CLI connection, and `attachState` creates an empty one when the file is missing (`apps/cli/src/api-layer.ts:126-136`, `packages/index/src/database.ts:286-295`). `activeArms` drops the arm only when `hasState` is false, and from the CLI it never is (`packages/index/src/retrieval-sql.ts:288-295`, `packages/index/src/retrieval.ts:355-360`). With no access rows, salience ranks memories by their `updated_at`, much like the recency arm (`packages/index/src/retrieval-sql.ts:255`). A search on a new clone with no import still lists `salience` in its `arms`. So a lost plane costs ranking quality quietly instead of raising an error.

The sleep cycle reads the table too. The retention score that picks memories to archive counts accesses, and confidence decay skips any memory that has been reinforced (`packages/sleep/src/retention.ts:110-118`, `packages/sleep/src/phases/confidence-decay.ts:34-37`). On an empty table, a sleep run scores every memory as never read and no longer spares reinforced memories from decay.

[The index plane and the state plane](/internals/index-plane-and-state-plane/) covers the two planes and how the sidecar is rendered.

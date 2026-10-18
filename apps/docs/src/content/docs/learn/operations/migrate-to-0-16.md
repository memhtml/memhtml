---
title: Migrate to 0.16
description: What 0.16 removes and what replaces each piece, and the upgrade in order, from settling the sleep branches on 0.15.x to replacing a sleep schedule with curate run and a reviewed curate merge.
---

0.16 removes the sleep pipeline and adds sessions, a head server, a curator that works on a branch, and a store policy file. The git tree, the memory file format, `index.db`, and `state.db` carry over unchanged, and every command that reads or searches the store works as it did in 0.15.x.

Upgrade in this order:

1. On 0.15.x, merge or discard every `sleep/<date>` branch.
2. If you want a strict write bar, write and commit `memhtml.config.json`.
3. Install 0.16.
4. Replace a `sleep run` schedule with `curate run` and a reviewed `curate merge`.
5. Put `session prune` on the schedule, and decide whether to run a head server.

## What 0.16 removes

| Removed in 0.16                                                                                       | What to use instead                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memhtml sleep run` and `sleep resume`                                                                | `memhtml curate run`, and `curate run --resume` to continue a stopped run                                                                        |
| `memhtml sleep review`                                                                                | `git log` and `git diff` over the `curate/<date>` branch, and the report in the `curate.run` payload and the commit message                      |
| `memhtml sleep merge`                                                                                 | `memhtml curate merge`                                                                                                                           |
| `memhtml sleep plan`                                                                                  | `memhtml curate run --dry-run`, which shows what a run would do and writes nothing                                                               |
| `memhtml sleep status`                                                                                | The `curate/<date>` branches themselves: `git branch --list 'curate/*'`                                                                          |
| `memhtml apply --consolidate last-wins`                                                               | `--detect-conflicts`, which reports a contradiction without changing the write, and `memhtml correct` to supersede a fact                        |
| MCP `memory_write_batch` `consolidate`                                                                | `detect_conflicts`, and `memory_correct`                                                                                                         |
| The `consolidated_into` and `superseded_path` fields on each batch result, and `summary.consolidated` | Nothing. A batch result carries `conflict` and `near_duplicates`, and the summary counts `total`, `written`, `deduped`, `failed`, and `skipped`. |
| `lastSleep` on `memhtml status`, and `last_sleep` on MCP `memory_status`                              | Nothing. A curator run's record is its branch and its commit.                                                                                    |
| `stuckSleepRuns` on `memhtml doctor`                                                                  | Nothing. A curator run that stops keeps its operations in its session for `--resume`.                                                            |
| The MCP resource `memhtml://sleep/{run-id}`                                                           | The `curate.run` payload's `report`, which is also the curator commit's message                                                                  |
| The consolidator, which distilled session transcripts into memories during a sleep run                | Nothing writes memories from transcripts in 0.16. The trace index stays, and `memhtml trace search` and `trace links` still read it.             |

The `sleep.report`, `sleep.review`, `sleep.merge`, and `sleep.plan` response types no command answers any more. They stay in the [response-type list](/reference/response-types/) because that list is append-only.

## Settle the sleep branches before you upgrade

0.16 can't finish a sleep run. A `sleep/<date>` branch carries a ledger, `.memhtml/sleep/sleep-<date>.pending.jsonl`, of state-plane writes the run earned, such as which transcripts it consolidated, which edges it promoted, and which entity merges it applied. `memhtml sleep merge` lands the branch and then applies that ledger to `state.db`. No 0.16 command reads a ledger, so a sleep branch you merge with plain git after the upgrade lands its files and loses its ledger. Settle every branch while 0.15.x is still installed:

```bash
git -C ~/memhtml branch --list 'sleep/*'
memhtml sleep status                          # let a run in progress finish, or discard it
memhtml sleep review sleep/2026-10-17
memhtml sleep merge sleep/2026-10-17          # land it, ledger included
git -C ~/memhtml branch -D sleep/2026-10-16   # or discard it, ledger and all
```

Check out `main` before `sleep merge`, as 0.15.x requires. When `git branch --list 'sleep/*'` prints nothing, the store is ready.

After the upgrade, the reports that earlier merges committed under `.memhtml/sleep/` stay in the tree as history. Nothing in 0.16 reads or writes them, and you can leave the directory where it is. `memhtml init` still creates `.memhtml/sleep/.gitkeep` in a new store.

## Write the store policy first

In 0.16, records written through a session meet a write bar, and the store's `memhtml.config.json` decides how strict it is. With no file, the bar refuses no memory type and doesn't ask a record to name its subject. If you want a strict bar, write the file and commit it before you install 0.16, so the first session commit on the new build is already judged by it:

```json
{
  "writeBar": {
    "refusedTypes": [{ "type": "episodic", "reason": "a run narrative belongs in the trace index, not in memory" }],
    "requireAnchor": true
  }
}
```

0.15.x ignores the file, so committing it early is safe. Once 0.16 is installed, run `memhtml config` to check the policy in force. [Set the store policy](/learn/operations/set-the-store-policy/) lists every key, its default, and why a typo in the file stops writes instead of loosening them.

The same file decides what `MEMHTML_SESSION` does to the old write commands. With the default `v1Doors` mode, `closed-in-session`, a process that has the variable set gets `ERR_SESSION_BOUND` from `memhtml write`, `apply`, `correct`, and `task add`, and from the MCP `memory_write`, `memory_write_batch`, and `memory_correct` tools when the MCP server's own environment has it. 0.15.x never read the variable, so this only matters for an agent runtime that sets it. Set `"v1Doors": "open"` to keep those commands open everywhere. [Write through a session](/learn/operations/write-through-a-session/) shows how a run writes instead.

## Install 0.16

```bash
npm i -g memhtml
memhtml manifest | jq '.data.commands | map(.name) | map(select(startswith("session") or startswith("curate") or startswith("head") or . == "config"))'
```

The store needs no conversion. 0.16 adds no index or state migration, and `memhtml index update` picks up where 0.15.x left it.

0.16 adds a few gitignored paths under `.memhtml/`: `sessions/` for session logs, `snapshots/` for cached copies of the corpus, `vectors/` for the head's vector cache, `head.sock` for a running head server, and `checkout.lock` while a writer holds the checkout. A new store's `.gitignore` names the first four. A store scaffolded before 0.16 has an older `.gitignore`, so the first session start, snapshot write, `head embed`, and `head serve` each add their path to `.git/info/exclude`, which stays local to the clone. `git status` stays clean either way.

If the store already has `.memhtml/snapshots/` or `.memhtml/vectors/` from a pre-release build, those files keep working. Snapshots and vector caches now carry a `format` key, and a file without one reads as format 1, which is the current format, so nothing needs re-embedding.

## Replace the sleep schedule

A 0.15.x schedule ran the whole pipeline on a branch and left the merge to you:

```cron
30 3 * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml sleep run >> /var/log/memhtml/sleep.log 2>&1
```

In 0.16 the curator is one command on the same schedule, and the merge stays a reviewed step:

```cron
30 3 * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml MEMHTML_CURATOR_MODEL=bedrock:global.anthropic.claude-opus-5 memhtml curate run --dense >> /var/log/memhtml/curate.jsonl 2>> /var/log/memhtml/curate.err
```

The run commits to `curate/<UTC date>` and never moves `main`. Review the branch with git, then land it:

```bash
git -C ~/memhtml log --oneline main..curate/2026-10-18
git -C ~/memhtml diff --stat main...curate/2026-10-18
memhtml curate merge curate/2026-10-18
```

`curate merge` runs the head gate first and refuses with `ERR_DISCRIMINATION_FAILED` when the landing would make retrieval worse. To throw a run away, `git branch -D` its branch. `--model fake` runs the curator with no credential, which is how to try the schedule on a test store first. [Curate the corpus](/learn/operations/curate-the-corpus/) covers the run, the review, the gate, `curate collapse`, and `--charter`.

Some sleep phases have no replacement. Confidence decay, retention triage, reprieve, relationship mining, edge typing, task detection, and trace consolidation don't run in 0.16. The curator's charter covers deduplication, labels, entity aliases, inbox placement, arcs, and dangling links. The sleep run's state-export phase is gone too, so put `memhtml state export` on the schedule yourself, as [preserve the state plane](/learn/operations/preserve-the-state-plane/) describes.

## New environment variables

| Variable                      | Default                                                    | What it does                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMHTML_SESSION`             | unset                                                      | The session every process of one agent run writes through. See [bind a whole run](/learn/operations/write-through-a-session/#bind-a-whole-run-with-memhtml_session). |
| `MEMHTML_COMMIT_DEADLINE_MS`  | `60000`                                                    | How long `session commit` and `session rebase` wait for a head server's answer. `0` means no bound.                                                                  |
| `MEMHTML_EXEC_POOL_SIZE`      | one fewer than the machine's available parallelism, 1 to 4 | How many `session exec` scripts a head server runs at once.                                                                                                          |
| `MEMHTML_EXEC_WORKER_HEAP_MB` | `2048`                                                     | The heap limit of each head server script worker.                                                                                                                    |
| `MEMHTML_EMBED_WARM_IDLE_MS`  | `0`                                                        | Off by default. Set above 0, a head server sends one tiny embed after that many quiet milliseconds so the next search finds a warm connection.                       |
| `MEMHTML_EMBED_DEADLINE_MS`   | `450`                                                      | How long a head search waits for its query embed before it answers without the vector arm.                                                                           |
| `MEMHTML_CURATOR_MODEL`       | unset                                                      | The default `--model` for `curate run` and `curate collapse`.                                                                                                        |
| `MEMHTML_MCP_HEAD`            | `on`                                                       | Whether the MCP server's `memory_search` and `memory_recall` ask a head server first.                                                                                |

[Configure the environment](/learn/operations/configure-the-environment/) lists every variable the binary reads.

## The MCP server asks the head server first

In 0.16, `memory_search` and `memory_recall` ask a running head server before they read the index, so a record a session committed a moment ago is found before `index update` runs. With no head server running, the connection fails in a few milliseconds and both tools answer from the index exactly as 0.15.x did. A call that names `include_archived` or `as_of`, a query with a quoted phrase, or a query with no term the head indexes always goes to the index.

Set `MEMHTML_MCP_HEAD=off` in the MCP server's environment to keep the 0.15.x behavior. The variable is read on every call, so the switch needs no restart. The other MCP tools are unchanged.

## Keep the index fresh

A session commit doesn't update `index.db`. `memhtml search`, `memhtml recall`, and any MCP call that answers from the index see a session's records after the next `memhtml index update`. Keep the `index update` line from [the cron schedule](/learn/operations/run-the-store-day-to-day/#the-cron-schedule). `memhtml status` reports `indexFresh: false` while the index is behind.

## Prune session state

Each session leaves a small log under `.memhtml/sessions/`, and a run's id is never written again. Add a weekly prune:

```cron
0 5 * * 0  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml session prune --older-than 7d --dense >> /var/log/memhtml/prune.jsonl 2>> /var/log/memhtml/prune.err
```

`session prune` never removes a log that still holds operations. It lists it under `unlanded` so you can land it with `memhtml session commit --id <id> --message <summary> --drop-refused`. Run `memhtml session prune --older-than 7d --dry-run` first to see what it would remove.

## Run a head server, if you want one

A head server is optional. It keeps the corpus loaded so the session and head commands answer in well under a second instead of several seconds, and it serves the MCP search tools a corpus that's never behind the ref. [Run a head server](/learn/operations/run-a-head-server/) covers starting it, the fallback rules, and a service-manager unit.

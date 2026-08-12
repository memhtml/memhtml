---
title: Run the store day to day
description: The daily verbs, the cron schedule that keeps a store fresh, and exactly what moves the access plane.
---

```bash
memhtml write --title "One writer and many readers share the index" --type semantic \
  --claim "WAL admits a single writer at a time and any number of concurrent readers."
memhtml apply --file ops.jsonl        # many memories, ONE commit, ONE index pass
memhtml search "one writer many readers"
memhtml recall "one writer many readers" --budget 16000
memhtml read areas/inbox/some-memory.html
memhtml list --type semantic --limit 50
```

Reach for `memhtml apply` past about three memories in one task. A batch stages every file, makes one
commit, and reindexes once, where N writes make N commits and pay N index passes. It is atomic by
default; `--continue-on-error` is best-effort. Both `apply` and `exec` read stdin when `--file` is
omitted or is `-`.

## Nothing is deleted

- `memhtml correct <target>` writes the superseding file and archives the target in **one** commit, so an
  interrupted run can never leave two live memories contradicting each other.
- `memhtml archive <path> --reason ...` is a `git mv` into `archive/<YYYY>/` with the original path
  mirrored beneath.
- `--include-archived` on `search`, `recall`, `list`, and `task list` brings evicted memories back into
  view. They still exist; eviction moved them.

`git log --follow` therefore reads straight through a memory's whole life, including the eviction.

## Reinforcement has a cooldown

`memhtml reinforce <path>` bumps access bookkeeping under a **900-second per-path cooldown**
(`packages/domain/src/ranking.ts:17`), so a loop reinforcing one path records one bump. That number is
stated once in the domain layer and once in the salience arm's SQL, and a property test pins the two to
agree at the boundary.

```bash
memhtml reinforce areas/inbox/some-memory.html --signal positive
```

`--signal` is `positive`, `negative`, or `neutral` (the default). `neutral` bumps access without claiming
the memory was right; `positive` and `negative` are the only things that move the outcome EWMA.

## What moves the access plane

Worth knowing precisely, because it is the first thing to check when a salience number surprises you.

**Bumps it:**

- `memhtml read <path>` and the `memory_read` tool — an explicit open is a chosen memory.
- The `memhtml://file/{path}` MCP resource, which funnels through the same use case.
- `memhtml reinforce`, which is the explicit channel.

**Does not bump it:**

- `memhtml search` and `memhtml recall`, however many paths they return.
- Any sleep phase.

Those two are the ranker's guess and the schedule's sweep, and counting either makes the ranking teach
itself: today's top five would rank higher tomorrow purely for having been listed, while the memory that
should displace them never appears to earn a first bump.

So **a corpus that has been searched all day and never read has an empty `state.access`, and that is
correct rather than a bug.**

The salience arm additionally ignores `task` rows and everything under `resources/people/` entirely.
Their access counts exist but never affect a rank — those are reached by predicate and by key, and
salience there would reward a stale task and decay a person's identity.

## Working-tree edits are legitimate

`memhtml index update` projects uncommitted changes as well as committed ones, so a hand-edited file is
searchable before you commit it. You own the commit, though, and `memhtml sleep run` refuses on a dirty
tree.

## The cron schedule

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed >> /var/log/memhtml/index.log 2>&1
17 * * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml trace index      >> /var/log/memhtml/trace.log 2>&1
30 3 * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml sleep run        >> /var/log/memhtml/sleep.log 2>&1
0 6 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml publish         >> /var/log/memhtml/publish.log 2>&1
0 7 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml doctor          >> /var/log/memhtml/doctor.log 2>&1
```

Each line is idempotent: an unchanged HEAD and a clean tree touch nothing. `index update` on a converged
store answers `unchanged: true` and writes nothing:

```json
{
  "apiVersion": "1",
  "type": "index.report",
  "data": {
    "mode": "update",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "unchanged": true,
    "added": 0,
    "modified": 0,
    "removed": 0,
    "renamed": 0,
    "dirty": 0,
    "embeddingsWritten": 0,
    "skipped": []
  }
}
```

`memhtml publish` is deterministic to the byte, so two runs over an unchanged corpus write nothing and
commit nothing.

**`memhtml sleep merge` is deliberately not on the cron.** A run rewrites confidence across the corpus
and archives memories, so the branch exists for a human to read `memhtml sleep review` first. The nightly
`sleep run` produces the branch; landing it is a decision. See [run and review a sleep
cycle](/learn/operations/run-and-review-a-sleep-cycle/).

## Reading the log files

The cron lines above send both streams to one file, which is fine for a human but not for a parser:
the envelope is pretty-printed across many lines by default, and stderr's progress and warning lines
interleave with it. Split the streams and add `--dense` when you want the log to be machine-readable —
`--dense` minifies the JSON and drops null fields, so each run contributes exactly one line:

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed --dense >> /var/log/memhtml/index.jsonl 2>> /var/log/memhtml/index.err
```

```bash
tail -1 /var/log/memhtml/index.jsonl | jq '.data | {added, modified, embeddingsWritten}'
```

`--dense` is also what you want when the output goes into a model's context window rather than a log.

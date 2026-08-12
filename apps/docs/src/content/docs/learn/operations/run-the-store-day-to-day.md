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

Reach for `memhtml apply` once a task writes more than about three memories. A batch stages every
file, makes one commit, and reindexes once, where the same memories written one at a time make one
commit and one index pass each. `apply` is atomic by default, and `--continue-on-error` makes it
best-effort. Both `apply` and `exec` read stdin when you omit `--file` or pass `-`.

## Nothing is deleted

- `memhtml correct <target>` writes the superseding file and archives the target in one commit, so an
  interrupted run can never leave two live memories contradicting each other.
- `memhtml archive <path> --reason ...` is a `git mv` into `archive/<YYYY>/`, with the original path
  mirrored beneath.
- `--include-archived` on `search`, `recall`, `list`, and `task list` brings evicted memories back
  into view. They still exist; eviction moved them.

`git log --follow` therefore reads straight through a memory's whole life, including the eviction.

## Reinforcement has a cooldown

`memhtml reinforce <path>` bumps the access bookkeeping for a path at most once every 900 seconds
(`packages/domain/src/ranking.ts:17`), so a loop reinforcing one path records one bump. That number is
written once in the domain layer and once in the salience arm's SQL, and a property test pins the two
to agree at the boundary.

```bash
memhtml reinforce areas/inbox/some-memory.html --signal positive
```

`--signal` takes `positive`, `negative`, or `neutral`, and `neutral` is the default. A `neutral`
signal bumps the access count without claiming the memory was right. `positive` and `negative` are the
two values that move the outcome EWMA, a running average of how well a memory has served.

## What moves the access plane

Read this section when a salience number surprises you. Salience is one of retrieval's four ranking
arms, alongside full-text search, vector similarity, and recency, and it favours memories you have
opened before by reading the access plane.

Three things bump a memory's access count:

- `memhtml read <path>` and the `memory_read` tool, because an explicit open is a chosen memory.
- The `memhtml://file/{path}` MCP resource, which funnels through the same use case.
- `memhtml reinforce`, which is the explicit channel.

Two things leave the count alone:

- `memhtml search` and `memhtml recall`, however many paths they return.
- Every sleep phase.

Those two are the ranker's guess and the schedule's sweep, and counting either would let the ranking
teach itself. Today's top five would rank higher tomorrow purely for having been listed, while the
memory that should displace them would never get a first bump.

So a corpus that has been searched all day and never read has an empty `state.access`. That is the
expected state.

The salience arm also ignores `task` rows and everything under `resources/people/`. Their access
counts exist and never affect a rank, because you reach a task by predicate and a person by key.
Salience there would reward a stale task and decay a person's identity.

## Working-tree edits are legitimate

`memhtml index update` projects uncommitted changes as well as committed ones, so a file you edited by
hand is searchable before you commit it. You own the commit, though, and `memhtml sleep run` refuses
to run on a dirty tree.

## The cron schedule

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed >> /var/log/memhtml/index.log 2>&1
17 * * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml trace index      >> /var/log/memhtml/trace.log 2>&1
30 3 * * *    cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml sleep run        >> /var/log/memhtml/sleep.log 2>&1
0 6 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml publish         >> /var/log/memhtml/publish.log 2>&1
0 7 * * *     cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml doctor          >> /var/log/memhtml/doctor.log 2>&1
```

Each line is safe to repeat. An unchanged HEAD and a clean tree touch nothing, and `index update` on a
converged store answers `unchanged: true` and writes nothing:

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

`memhtml sleep merge` stays off the cron deliberately. A curation run rewrites confidence across the
corpus and archives memories, so the branch waits for a person to read `memhtml sleep review` first.
The nightly `sleep run` produces the branch, and landing it is a decision. See
[run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/).

## Reading the log files

The cron lines above send both streams to one file, which suits a human reader and defeats a parser.
The envelope is pretty-printed across many lines by default, and the progress and warning lines on
stderr interleave with it. Split the streams and add `--dense`, which minifies the JSON and drops null
fields, so each run contributes exactly one line:

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed --dense >> /var/log/memhtml/index.jsonl 2>> /var/log/memhtml/index.err
```

```bash
tail -1 /var/log/memhtml/index.jsonl | jq '.data | {added, modified, embeddingsWritten}'
```

`--dense` is also what you want when the output goes into a model's context window rather than a log.

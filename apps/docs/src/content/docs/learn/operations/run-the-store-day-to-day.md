---
title: Run the store day to day
description: The everyday commands, the upkeep commands that keep a store current, and exactly what moves the access plane.
---

```bash
memhtml write --title "One writer and many readers share the index" --type semantic \
  --claim "WAL admits a single writer at a time and any number of concurrent readers."
memhtml apply --file ops.jsonl        # many memories, ONE commit, ONE index pass
memhtml search "one writer many readers"
memhtml recall "one writer many readers" --budget 16000
memhtml read areas/inbox/one-writer-and-many-readers-share-the-index.html
memhtml list --type semantic --limit 50
```

Reach for `memhtml apply` once a task writes more than about three memories. A batch stages every file, makes one commit, and reindexes once. The same memories written one at a time make one commit and one index pass each. `apply` is atomic by default, so one refused line means nothing is written. `--continue-on-error` makes it best-effort instead. Both `apply` and `exec` read stdin when you omit `--file` or pass `-`.

Inside an agent run that exports `MEMHTML_SESSION`, `memhtml write` and `memhtml apply` refuse with `ERR_SESSION_BOUND` at exit 2 under the store's default `v1Doors` policy, and write nothing. Write through the session instead: `memhtml session put` takes the same lines `apply` does, and `memhtml session exec` takes a heredoc script. Nothing reaches git until the agent runtime runs `memhtml session commit` when the run ends. [Write through a session](/learn/operations/write-through-a-session/) covers it.

## Every removal is a move into the archive

- `memhtml correct <target>` writes the superseding file and archives the target in one commit. An interrupted run therefore never leaves two live memories contradicting each other.
- `memhtml archive <path> --reason ...` is a `git mv` to `archive/<YYYY>/<path>`, plus the archive stamps in the file's head.
- `--include-archived` on `search`, `recall`, `list`, and `task list` brings evicted memories back into view. They still exist; eviction moved them.

`git log --follow` on the archive path therefore reads straight through a memory's whole life, including the eviction.

## Reinforcement has a cooldown

`memhtml reinforce <path>` bumps the access bookkeeping for a path at most once every 900 seconds (`REINFORCE_COOLDOWN_S` in `packages/domain/src/ranking.ts`), so a loop reinforcing one path records one bump. A `memhtml read` of the path starts the same window. The `state.access` upsert in `packages/index/src/reinforce.ts` binds that constant into its SQL guard, and a property test pins the guard to the domain layer's `shouldBumpAccess` at the boundary.

```bash
memhtml reinforce areas/inbox/one-writer-and-many-readers-share-the-index.html --signal positive
```

`--signal` takes `positive`, `negative`, or `neutral`, and `neutral` is the default. A `neutral` signal bumps the access count without claiming the memory was right. `positive` and `negative` are the two values that move the outcome EWMA, a running average of how well a memory has served.

## What moves the access plane

Read this section when a salience number surprises you. Salience is one of the four ranking arms `memhtml search` and `memhtml recall` fuse, beside full-text search, vector similarity, and recency. It reads the access plane and favors memories you have opened before.

Three things bump a memory's access count:

- `memhtml read <path>` and the `memory_read` tool, because an explicit open is a chosen memory.
- The `memhtml://file/{path}` MCP resource, which funnels through the same use case.
- `memhtml reinforce`, which is the explicit channel.

Two things leave the count alone:

- `memhtml search` and `memhtml recall`, however many paths they return.
- Every curation pass over the whole corpus.

Those two are the ranker's guess and the curator's sweep. Counting either would feed the ranker's own output back into its input. Today's top five would rank higher tomorrow purely for having been listed. The memory that should displace them would never get a first bump.

So a corpus that has been searched all day and never read has an empty `state.access`. That is the expected state.

The salience arm also ignores `task` rows and everything under `resources/people/`. Their access counts still grow but never affect a rank. You reach a task by predicate and a person by key. Salience there would reward a stale task and decay a person's identity.

## Working-tree edits are legitimate

`memhtml index update` projects uncommitted changes as well as committed ones, so a file you edited by hand shows up in `memhtml search` and `memhtml recall` before you commit it. A head server and `memhtml head search` read commits only, so they see the edit after you commit it. You own the commit, though.

## The upkeep commands

```bash
memhtml index update --repo $HOME/memhtml >> /var/log/memhtml/index.log 2>> /var/log/memhtml/index.err
MEMHTML_TRACE_ROOT=$HOME/.claude memhtml trace index --repo $HOME/memhtml >> /var/log/memhtml/trace.log 2>> /var/log/memhtml/trace.err
memhtml curate run --repo $HOME/memhtml --model bedrock:global.anthropic.claude-opus-5 >> /var/log/memhtml/curate.log 2>> /var/log/memhtml/curate.err
memhtml publish --repo $HOME/memhtml >> /var/log/memhtml/publish.log 2>> /var/log/memhtml/publish.err
memhtml state export --repo $HOME/memhtml >> /var/log/memhtml/state.log 2>> /var/log/memhtml/state.err
memhtml doctor --repo $HOME/memhtml >> /var/log/memhtml/doctor.log 2>> /var/log/memhtml/doctor.err
memhtml session prune --repo $HOME/memhtml --older-than 7d >> /var/log/memhtml/prune.log 2>> /var/log/memhtml/prune.err
```

`index update` and `trace index` want to run often. `index update` catches the index up after session commits, `curate merge`, `publish`, and `state export`, which all land commits without touching it. `trace index` reads only the transcripts that changed since its last run. The other five want to run once in a while. Run `publish` after an `index update`, because it lists what the index holds. Run `doctor` after the `index update` that follows `publish` and `state export`, because it reports `healthy: false` while the index is behind. `state export` writes and commits the access sidecar, which nothing else writes for you.

`curate run` takes its model from `--model`, else `MEMHTML_CURATOR_MODEL`, else a proxy model when `MEMHTML_LLM_BASE_URL` is set. It only commits to a `curate/<date>` branch. Landing that branch with `memhtml curate merge` stays a step a person takes after reading it, as [curate the corpus](/learn/operations/curate-the-corpus/) describes.

Every command in the block except `curate run` is safe to repeat. A second `curate run` on the same UTC date is refused with `ERR_STORAGE` (`session.exists`) at exit 1, and `--resume` reopens that date's session instead. On a converged store, `index update` answers `unchanged: true` with every count at zero:

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

`memhtml publish` is deterministic to the byte, so two runs over an unchanged corpus write nothing and commit nothing.

## Reading the log files

The upkeep commands send stdout and stderr to separate files, so the progress and warning lines on stderr stay out of the envelope's file. The envelope is still pretty-printed across many lines by default. Add `--dense`, which minifies the JSON and drops null fields, so each run adds exactly one line to the stdout file:

```bash
memhtml index update --repo $HOME/memhtml --dense >> /var/log/memhtml/index.jsonl 2>> /var/log/memhtml/index.err
```

```bash
tail -1 /var/log/memhtml/index.jsonl | jq '.data | {added, modified, embeddingsWritten}'
```

`--dense` is also what you want when the output goes into a model's context window rather than a log.

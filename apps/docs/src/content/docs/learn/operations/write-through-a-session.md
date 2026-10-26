---
title: Write through a session
description: Start a session, add records with session put or a heredoc script, land them as one commit, rebase when the ref moved, bind a whole agent run with MEMHTML_SESSION, and prune what sessions leave behind.
---

```bash
memhtml session start --id s1
memhtml session put --id s1 --file ops.jsonl
memhtml session exec --id s1 <<'SH'
grep -rl 'checkout-api' /mnt/memhtml/projects
SH
memhtml session status --id s1
memhtml session commit --id s1 --message "two facts about the checkout api"
memhtml session rebase --id s1        # only after a rebase-needed answer
memhtml session prune --older-than 7d --dry-run
```

A session is a small log of operations that sits on top of one version of the corpus. Each `session put` or `session exec` adds operations to the log. Nothing reaches git until `session commit` lands the whole log as one commit. The store's write bar judges every record when you add it and again when you commit it.

`memhtml write` and `memhtml apply` still commit straight to the store, with no write bar. Inside an agent run that exports `MEMHTML_SESSION`, the store's default policy closes them and points you at the session commands instead. [Bind a whole run](#bind-a-whole-run-with-memhtml_session) covers that case.

## Start a session

```bash
memhtml session start --id s1
```

```json
{
  "apiVersion": "1",
  "type": "session.started",
  "data": {
    "id": "s1",
    "baseSha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "ref": "refs/heads/main",
    "ops": 0,
    "head": {
      "sha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
      "records": 3,
      "skipped": 1,
      "loadMs": 44,
      "source": "git",
      "snapshotPath": null,
      "ancestorSha": null,
      "reparsed": null
    }
  }
}
```

The id is one path segment of letters, digits, `.`, `_`, and `-`, starting with a letter or digit. The session's log lives at `.memhtml/sessions/<id>.json`, which git ignores. `baseSha` is the commit the session sees, and `ref` is where its commit will land. The ref is `refs/heads/main` whatever branch the checkout has open, unless you pass `--ref`, so a store on `master` passes `--ref master`.

Starting an id that already has a log is refused with `ERR_STORAGE` (`session.exists`), so a retried start can't throw away work in progress. `--force` replaces the log on purpose.

`head` says how the corpus was loaded. `git` is a full read of the tree. `snapshot` means a cached copy of that exact commit was read from `.memhtml/snapshots/`, and `snapshot+advance` means an older snapshot was read and brought forward over the files that changed. A session commit and `curate merge` write a snapshot of the commit they land, so once a session has committed, most loads are fast. A `memhtml write` or a hand `git commit` writes none, so the next load advances an older snapshot, or reads git when there is none.

## Add records with session put

`session put` reads JSONL, one operation per line. A `write` line takes the same fields as a [`memhtml apply`](/learn/tutorial/first-memory/#write-many-at-once) line:

```bash
cat > ops.jsonl <<'EOF'
{"op":"write","title":"The checkout api retries twice","type":"semantic","body":"The checkout api retries a failed charge twice before it gives up.","entity":"service:checkout-api"}
EOF
memhtml session put --id s1 --file ops.jsonl
```

```json
{
  "apiVersion": "1",
  "type": "session.appended",
  "data": {
    "id": "s1",
    "started": false,
    "baseSha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "appended": 1,
    "ops": 1,
    "paths": ["areas/inbox/the-checkout-api-retries-twice.html"],
    "labels": [],
    "neighbors": [
      {
        "path": "areas/inbox/the-checkout-api-retries-twice.html",
        "hits": [
          {
            "path": "resources/runbook/drain-the-vip-before-reverting-a-deploy.html",
            "score": 0.01639344262295082,
            "arms": ["lexical"],
            "claim": "If a prod rollback is issued, drain the VIP before reverting the deploy."
          }
        ]
      }
    ],
    "vector": {
      "used": false,
      "reason": "embedder-off",
      "detail": null,
      "cached": null,
      "coverage": null,
      "loadMs": null,
      "embedMs": null
    },
    "violations": [],
    "head": {
      "sha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
      "records": 3,
      "skipped": 1,
      "loadMs": 39,
      "source": "git",
      "snapshotPath": null,
      "ancestorSha": null,
      "reparsed": null
    }
  }
}
```

The store renders each line into the file it would write and picks the path it would pick. `neighbors` lists up to three records nearest each new one, ranked the way `memhtml head search` ranks. Read them before you commit. A neighbor that already states your fact means you can drop the line, and a related one is worth a `link`. `vector` says whether the vector arm ranked the neighbors. When it can't run, the neighbors come from the lexical arm alone and the put still succeeds.

Two more line shapes edit an existing record's entities without touching its article, so the record keeps its content hash:

```json
{"op":"label","path":"areas/inbox/the-checkout-api-retries-twice.html","entity":"system:payments"}
{"op":"unlabel","path":"areas/inbox/the-checkout-api-retries-twice.html","entity":"system:payments"}
```

A label value is a lowercase `type:name` the record doesn't carry yet. An unlabel names a value the record carries, spelled exactly as the record spells it.

`--file -` reads stdin, which suits a one-line put:

```bash
printf '%s\n' '{"op":"write","title":"Refunds settle within five days","type":"semantic","body":"A refund on the checkout api settles within five business days.","entity":"service:checkout-api"}' \
  | memhtml session put --id s1 --file -
```

## Write files with session exec

`session exec` runs a script over the session's view of the corpus and turns what the script changed into operations. The corpus is mounted writable at `/mnt/memhtml`, and the script is bash unless you pass `--lang js`. A quoted heredoc opener (`<<'SH'`) keeps your own shell from expanding anything, so the script arrives byte for byte:

```bash
memhtml session exec --id s1 <<'SH'
mkdir -p /mnt/memhtml/projects/checkout
cat > /mnt/memhtml/projects/checkout/charges-settle-within-a-day.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Charges settle within a day</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-10-18T12:00:00Z">
<meta name="memhtml-updated" content="2026-10-18T12:00:00Z">
<meta name="memhtml-entity" content="service:checkout-api">
</head>
<body>
<article>
<p><mark>A card charge on the checkout api settles within one business day.</mark> Refunds take longer.</p>
</article>
</body>
</html>
HTML
SH
```

```json
{
  "apiVersion": "1",
  "type": "session.exec.report",
  "data": {
    "id": "s1",
    "baseSha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "lang": "bash",
    "corpusMount": "/mnt/memhtml",
    "sha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "exitCode": 0,
    "stdout": "",
    "stderr": "",
    "durationMs": 23,
    "timeoutMs": 30000,
    "timedOut": false,
    "ops": 1,
    "appended": 1,
    "opsTotal": 2,
    "harvested": [{ "kind": "put", "path": "projects/checkout/charges-settle-within-a-day.html" }],
    "rejected": [],
    "violations": [],
    "blocking": [],
    "started": false,
    "head": {
      "sha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
      "records": 3,
      "skipped": 1,
      "loadMs": 41,
      "source": "git",
      "snapshotPath": null,
      "ancestorSha": null,
      "reparsed": null
    },
    "server": { "used": false, "base": null, "reason": "no-server", "detail": "ENOENT" }
  }
}
```

After the script exits, the harvester compares every file with what it seeded and reads each change as one operation:

| What the script did                                                                 | What the log gets                         |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| Wrote a new `.html` file                                                            | a `put`                                   |
| Added or removed a `<link rel="memhtml-...">` line in an existing record's head     | a `link` or an `unlink`                   |
| Added or removed a `<meta name="memhtml-entity">` line in an existing record's head | a `label` or an `unlabel`                 |
| Moved a record to its `archive/<YYYY>/<path>` twin                                  | an `archive`                              |
| Moved a record, bytes unchanged, to exactly one new live path                       | a `move`                                  |
| Deleted a record with no copy, or edited its head in any other way                  | a `rejected` entry naming the reason      |
| Changed an existing record's article                                                | a `put` the commit refuses (`claim-edit`) |

A record archived earlier in the year already holds `archive/<YYYY>/<path>`, so the next archive of that path goes to `archive/<YYYY>.2/<path>`, then `.3`, and so on. A move onto a held slot is blocked, and its violation names the free one.

A `move` keeps the record's bytes, so its content hash and its history come with it. Every live record that links to the old path has to drop that edge in the same script: cut the old `<link>` line, and add one with the new path to keep the edge. Otherwise the harvest is blocked and names the edge to fix.

The harvest is added to the log only when the script exits 0 and no harvested operation breaks a rule a rebase can't fix. `blocking` lists those violations, and `appended` is 0 when it lists any. A non-zero `exitCode` means your script failed, and `memhtml` itself still exits 0.

The sandbox has no network, and `curl` isn't a command. `--timeout-ms` bounds the run (30000 by default, 600000 at most). A run past it reports `exitCode` 124 with `timedOut: true`. The script and its request together can't exceed 1 MiB, so a bigger batch is several calls.

## Check the session

```bash
memhtml session status --id s1
```

```json
{
  "apiVersion": "1",
  "type": "session.status",
  "data": {
    "id": "s1",
    "ref": "refs/heads/main",
    "baseSha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "refSha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "behind": false,
    "ops": 2,
    "puts": 2,
    "archives": 0,
    "links": 0,
    "unlinks": 0,
    "labels": 0,
    "unlabels": 0,
    "moves": 0,
    "paths": [
      "areas/inbox/the-checkout-api-retries-twice.html",
      "projects/checkout/charges-settle-within-a-day.html"
    ],
    "pending": null
  }
}
```

`behind: true` means the ref moved past the session's base, so the session needs a rebase before its commit can land. `pending` names a commit that a killed `session commit` built and may have landed. The next commit settles it, as [a commit killed halfway](#a-commit-killed-halfway) describes.

## Commit

```bash
memhtml session commit --id s1 --message "two facts about the checkout api"
```

```json
{
  "apiVersion": "1",
  "type": "session.committed",
  "data": {
    "id": "s1",
    "ref": "refs/heads/main",
    "baseSha": "3f8a37e2af22c26d600a68e5f5179145c25318d3",
    "kind": "committed",
    "sha": "9b6299d3c2eaac79290a789522aa39a32d2f9282",
    "paths": [
      "areas/inbox/the-checkout-api-retries-twice.html",
      "projects/checkout/charges-settle-within-a-day.html"
    ],
    "contradictions": [],
    "worktreeSynced": true,
    "recovered": false,
    "snapshot": {
      "sha": "9b6299d3c2eaac79290a789522aa39a32d2f9282",
      "path": "/home/you/memhtml/.memhtml/snapshots/9b6299d3c2eaac79290a789522aa39a32d2f9282.arrow",
      "bytes": 9426,
      "rows": 5,
      "ms": 25,
      "pruned": []
    },
    "dropped": [],
    "via": "local",
    "server": { "used": false, "base": null, "reason": "no-server", "detail": "ENOENT" }
  }
}
```

The commit's subject is `memhtml(session): <message>`, and a `Memhtml-Session: s1` trailer records which session made it. `kind` is the field to branch on:

| `kind`           | What happened                                                                                                                        | What to do                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `committed`      | The log landed as one commit. `sha` names it, and the log is empty again.                                                            | Nothing.                                             |
| `rebase-needed`  | The ref moved past the session's base. `mainSha` is the new tip, and `overlapping` lists the session's paths that changed meanwhile. | `memhtml session rebase`, then commit again.         |
| `refused`        | An operation breaks a rule, and `violations` names each one. An empty log is `refused` with no violations. Nothing moved.            | Fix or drop the operation, or pass `--drop-refused`. |
| `worktree-dirty` | The ref is checked out, and the checkout holds uncommitted changes at a path this commit writes. Nothing moved.                      | Commit or stash those changes, then commit again.    |

When the ref is the branch your checkout has open, the working tree moves with the commit (`worktreeSynced: true`), and uncommitted edits at other paths survive.

When a new record's claim has the same frame key as an active record at another path, both stay live. The new file gets a `memhtml-contradicts` link to the old one, and `contradictions` lists the pair. Deciding which claim is right stays with a writer or a person.

`index.db` doesn't move with a session commit. When the session's ref is the branch the checkout has open, `memhtml head search` and a running [head server](/learn/operations/run-a-head-server/) see the new records at once. `memhtml search`, `memhtml recall`, and the MCP tools that read the index see them after the next `memhtml index update`, which is why that command stays on the [cron schedule](/learn/operations/run-the-store-day-to-day/#the-cron-schedule).

## When the ref moved, rebase

A commit without `--drop-refused` never retries on its own. When it answers `rebase-needed`, move the session's base to the ref's new tip and commit again:

```bash
memhtml session rebase --id s1
memhtml session commit --id s1 --message "two facts about the checkout api"
```

`session rebase` keeps every operation and judges nothing. The commit after it judges the log against the new tip, so it can answer `refused` when the ref gained the same fact meanwhile (`duplicate`) or a new version of a file this session also wrote (`claim-edit`). The caller owns that loop, because only the caller knows whether a refused line still matters.

## The write bar

The write bar is the rule for what any session may commit as a memory, and it has a fixed half and a configurable half.

The fixed half holds in every store:

- `format`: the file has to parse as a memory, with exactly one claim.
- `duplicate`: the article already exists in an active record.
- `claim-edit`: a put over an active record with a different article. Write the new fact under its own title with a `memhtml-supersedes` link.
- `reserved-path`: `.memhtml/`, `memhtml.config.json`, and any `index.html` or `sitemap.xml` are never writable. `areas/arcs/` and `resources/people/` are writable only by curation.
- `batch-cap`: one commit holds at most 200 operations.

The configurable half is the store's policy, `writeBar` in `memhtml.config.json`. With no file, it refuses no type and asks for no anchor. A strict store can refuse whole types (a run narrative, a review verdict) and can require every record to name what it's about through a `memhtml-entity` or a `projects/<slug>/` path. [Set the store policy](/learn/operations/set-the-store-policy/) lists the keys.

The file is read at every put, exec, and commit, so a commit judges the log by the policy in force when the commit runs.

`session put` refuses the whole call for a format problem, a reserved path, the batch cap, or a write-bar reason, because no rebase can fix those. `session exec` appends none of its harvest for the same reasons, except a reserved path: that file is only listed under `rejected`, and the rest still lands. A `duplicate` or a `claim-edit` is reported under `violations` and still added, because a rebase can change the answer, and the commit refuses it. In a run-bound session those two refuse the call too.

## Bind a whole run with MEMHTML_SESSION

An agent runtime runs many short CLI processes in one run. When it exports `MEMHTML_SESSION` to all of them, the whole run writes through one session:

- Every `session` command takes the variable as its default `--id`.
- The first `session put` or `session exec` starts the session on `refs/heads/main`, so the run needs no `session start` (on a store whose branch isn't `main`, run `session start --ref <branch>` first). Two subagents starting at once share the one session, but when two puts reach it at the same instant one can fail with `ERR_STORAGE` and append nothing.
- `memhtml write`, `apply`, `correct`, and `task add` refuse with `ERR_SESSION_BOUND` at exit 2. The refusal's `suggestions` carry a `session put` line with placeholders to fill in. `link`, `archive`, `task status`, `reinforce`, and every read stay open.
- `duplicate` and `claim-edit` refuse a put or an exec at once, so the agent sees the problem inside the turn.

```bash
export MEMHTML_SESSION=run-42
printf '%s\n' '{"op":"write","title":"The cache ttl is five minutes","type":"semantic","body":"The cache ttl is five minutes.","entity":"system:cache"}' \
  | memhtml session put --file -
```

The store's `v1Doors` setting decides whether the record-creating doors close. The default, `closed-in-session`, closes them only in a process that carries the variable. See [set the store policy](/learn/operations/set-the-store-policy/#v1doors).

The runtime commits the session when the run ends:

```bash
memhtml session commit --message "run 42" --drop-refused
```

On `rebase-needed` it runs `session rebase` once and commits again. Through a head server, `--drop-refused` has already rebased and committed again up to 3 times before it answers `rebase-needed`. `--drop-refused` is for this commit, where no agent turn is left to fix a line. It takes out of the log every operation that touches a path a refusal names, and commits the rest. Each dropped operation is appended to `.memhtml/sessions/<id>.dropped.jsonl` with the time and the reasons, and `dropped` in the payload lists them. A batch-cap refusal names no path, so it's never dropped.

An id given with `--id` must name a session that already started. A typo then fails with `ERR_STORAGE` (`session.read`) instead of quietly opening a new session. A blank variable counts as unset, and a value that isn't a valid id is `ERR_INVALID_FLAG` naming the variable.

## Two writers on one checkout

Every writer that changes the shared git index holds the checkout lock, `.memhtml/checkout.lock`, while it stages and commits. That covers every `memhtml write`, `apply`, `correct`, `link`, `archive`, `task status`, `publish`, `state export`, and `doctor --fix`, every session commit, and the fast-forward in `curate merge`. So a session commit and a `memhtml write` in another process never commit each other's files.

A writer waits up to 15 seconds for the lock. Past that it fails with `ERR_STORAGE` (`checkout.locked`). Every writer but `doctor --fix` and `task status <path> done` has then written nothing, so running it again is safe. A lock left by a killed process goes stale after 10 seconds and the next writer takes it.

## A commit killed halfway

Before anything shared moves, `session commit` writes the commit it built into the log as `pending`. The next `session commit` on that id settles it. If the earlier commit landed, the answer is `committed` with `recovered: true` and nothing is committed twice. If it didn't land, the checkout is put back and the commit is made again.

## Make these calls faster with a head server

`session start`, `put`, `exec`, `commit`, and `rebase` each load the corpus when they start, which takes seconds on a large store. A running [head server](/learn/operations/run-a-head-server/) keeps it loaded, and `session put`, `session exec`, `session commit`, and `session rebase` ask the server first. The payload then says `head.source: "server"` or `via: "server"`. `--no-server` makes any of them work alone.

## Clean up with session prune

A session leaves files behind under `.memhtml/sessions/`, and a runtime that gives every run a new id never reads them again. `session prune` removes the ones nothing reads any more:

```bash
memhtml session prune --older-than 7d --dry-run
```

```json
{
  "apiVersion": "1",
  "type": "session.pruned",
  "data": {
    "dryRun": true,
    "cutoff": "2026-10-11T05:51:45.347Z",
    "olderThanMs": 604800000,
    "indexes": { "count": 0, "bytes": 0 },
    "refs": { "count": 0 },
    "locks": { "count": 0 },
    "logs": { "count": 0 },
    "unlanded": [],
    "busy": [],
    "unreadable": [],
    "olderThan": "7d"
  }
}
```

Past the cutoff it removes logs with no operations left, lock directories a killed writer left behind, and the `<id>.idx` index files and `refs/memhtml/sessions/<id>` refs that earlier builds wrote. The `.dropped.jsonl` trails are kept.

It never removes a log that still holds operations. That log is a run whose writes haven't landed, so it's listed under `unlanded` with its id, operation count, `pending`, and age. Land it with `memhtml session rebase --id <id>` and then `memhtml session commit --id <id> --message <summary> --drop-refused`. An id whose lock is held is listed under `busy`, and a log that doesn't decode is kept and listed under `unreadable`.

`--older-than` takes a duration with a unit: `7d`, `48h`, `90m`, or `2 weeks`. A bare number is `ERR_INVALID_FLAG`. `--dry-run` reports the same counts and removes nothing. A weekly cron line keeps the directory small:

```cron
0 5 * * 0  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml session prune --older-than 7d --dense >> /var/log/memhtml/prune.jsonl 2>> /var/log/memhtml/prune.err
```

[Sessions and the commit path](/internals/sessions-and-the-commit-path/) explains how a commit validates, builds its tree, and moves the ref.

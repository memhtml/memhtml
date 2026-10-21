---
title: Run a head server
description: What memhtml head serve keeps in memory, where it listens, the routes it answers, when each command falls back to working alone, the deadlines and pool settings, and how to run it under a service manager.
---

```bash
memhtml head serve                          # follows the branch HEAD points at, else main
memhtml head serve --ref main --poll-ms 500
memhtml head status                         # answered by the server when one is running
```

Every `head` and `session` command needs the corpus loaded in memory, which this site calls the head. Without a server, each command loads it when it starts, and on a store of several thousand records that costs a few seconds per call. `memhtml head serve` loads the head once, keeps it current, and answers the other commands over a socket inside the store. It's optional. With no server running, every command still works and loads the head itself.

## Start it

```bash
memhtml head serve
```

The server logs one line to stderr when it's ready, then serves until it gets SIGTERM or SIGINT:

```
head serve: listening on /home/you/memhtml/.memhtml/head.sock for refs/heads/main at eae19b069aaaefc95f78f53202c2997a28e0f68d (6 records, snapshot+advance in 75 ms, poll 1000 ms)
```

On a signal it stops taking requests, waits up to 2 seconds for the ones in flight, stops its script workers, removes the socket, and writes its one envelope to stdout:

```json
{
  "apiVersion": "1",
  "type": "head.served",
  "data": {
    "socket": "/home/you/memhtml/.memhtml/head.sock",
    "ref": "refs/heads/main",
    "sha": "e70b0e24ef58dc7495494482052962378af631e5",
    "records": 8,
    "signal": "SIGTERM",
    "loadSource": "snapshot+advance",
    "loadMs": 75,
    "advances": 3,
    "requests": 11,
    "uptimeMs": 70075
  }
}
```

## What it holds

The server holds three things in memory:

- The version of the corpus at its ref's tip, with the indexes search needs. It loads that version the cheapest way it can: from the commit's own snapshot in `.memhtml/snapshots/`, from an older snapshot brought forward over the changed files, or from git.
- The vector cache, `.memhtml/vectors/<model>@<dimension>.arrow`, when an embedder is configured. `memhtml head embed` writes that file. The server reads it again when the file changes, and after a commit lands it embeds the new records in the background and writes them to the same file.
- A pool of worker threads that run `session exec` scripts, so a slow script never holds up a search.

It never opens `.memhtml/index.db`.

An answer is never older than the ref. Before every answer the server reads the ref, and when it has moved, the server brings its version forward over the files that changed. Between requests it does the same every `--poll-ms` milliseconds (1000 by default, `0` to turn polling off), so most requests find the version already current. When a commit lands, the server writes that commit's snapshot in the background if none exists yet.

## Where it listens

The server listens on `.memhtml/head.sock`, a Unix domain socket inside the store, and never on a TCP port. The socket is created with mode 0600, so only its owner can connect, and the store's `.gitignore` names it.

A socket path has a length limit, counted in UTF-8 bytes: 107 on Linux and 103 on macOS and the BSDs. For a store whose socket path would pass the limit, `head serve` refuses with `ERR_STORAGE` before it loads anything, and every client loads locally without trying to connect.

On Windows the server and its clients use the named pipe `\\.\pipe\memhtml-<hash>`, where `<hash>` is the first 16 hex digits of the SHA-256 of the store's resolved path. That path hasn't been tested on a real Windows host yet.

One server serves one store. A second `head serve` on a store whose server is live exits 1 with `ERR_HEAD_SERVER_RUNNING`, naming the live server's pid, ref, and sha. A socket file left by a server that was killed is detected and replaced with a warning. Two servers started in the same instant can both see a stale file, so let one supervisor start one server per store.

## The routes

The protocol is JSON over HTTP/1.1 on the socket. Every route sits under `/v1/`.

| Route                | Request body                                                 | What it answers                                                                                                            |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`     | none                                                         | The server's ref, sha, record count, load source, advances, requests, uptime, vector cache, embed counters, and exec pool. |
| `POST /v1/search`    | `{ query, limit?, now?, embedDeadlineMs?, scope?, detail? }` | The hits `memhtml head search` returns.                                                                                    |
| `POST /v1/read`      | `{ path }`                                                   | One record, or `null` for a path the version lacks.                                                                        |
| `POST /v1/neighbors` | `{ sha, ops, lines, at, runBound? }`                         | What `session put` computes before it appends: placements, violations, and neighbors.                                      |
| `POST /v1/exec`      | `{ id, script, lang, timeoutMs?, runBound? }`, at most 1 MiB | The `session exec` report, with the harvest already added to the log.                                                      |
| `POST /v1/commit`    | `{ id, message, dropRefused? }`                              | The `session commit` outcome.                                                                                              |
| `POST /v1/rebase`    | `{ id }`                                                     | The `session rebase` result.                                                                                               |

A body with an unknown field is refused with `400` and `ERR_INVALID_FLAG`, the same way the CLI refuses an unknown flag. An unknown route is `404`, and a failure while answering is `500` with the CLI's failure envelope.

`/v1/exec`, `/v1/commit`, and `/v1/rebase` read the session's log themselves, so a request names the session and nothing about its state. They answer either `{ served: true, base, outcome, head }` or `{ served: false, reason, detail }` when the server declines. `base` says which version the server used. `tip` is the version it holds, and `ancestor` is a version built from it for a session whose base is an older commit on the same ref. A commit can also be `loaded`, for a base off the ref's history.

`/v1/commit` runs the same commit the CLI runs, one at a time. Once a commit lands, the server holds the new commit as its head and writes its snapshot, so a commit through the server costs no head load at all.

Any HTTP client that can dial a Unix socket can talk to the server directly, which skips the CLI's own start-up time:

```bash
curl -s --unix-socket ~/memhtml/.memhtml/head.sock \
  -H 'content-type: application/json' \
  -d '{"query":"refund settle","limit":2}' http://memhtml/v1/search
```

```json
{"query":"refund settle","hits":[{"path":"projects/checkout/charges-settle-within-a-day.html","score":0.01639344262295082,"arms":["lexical"],"claim":"A card charge on the checkout api settles within one business day."}],"vector":{"used":false,"reason":"embedder-off","detail":null,"cached":null,"coverage":null,"loadMs":null,"embedMs":null},"searchMs":0.18,"head":{"sha":"eae19b069aaaefc95f78f53202c2997a28e0f68d","ref":"refs/heads/main","records":6,"skipped":null}}
```

## Who asks it, and when they work alone

A server can make a call faster, and the fallback rules make sure it can't make a call fail where working alone would have succeeded. Each command connects with a 100 ms timeout. `--no-server` on any of them skips the socket.

| Command                                 | Works alone when                                                                                                                                                         | Fails instead when                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `head status`, `head search`            | No server answers within 10 s, or the answer isn't a 200 the client can read.                                                                                            | Never because of the server.                                                                                               |
| `session put`                           | The same as above.                                                                                                                                                       | Never because of the server. The append always happens in the client.                                                      |
| `session exec`                          | The server never took the request, answered anything but 200, or declined with `base-unservable` or `busy`.                                                              | The server took the script and its answer was lost. Read `session status` before running it again.                         |
| `session commit`, `session rebase`      | The server never took the request, answered a 4xx (an older server has no such route), or declined with `other-ref`, `session-unreadable`, `base-unservable`, or `busy`. | The server answered 5xx, or gave no answer within `MEMHTML_COMMIT_DEADLINE_MS`. Read `session status` before trying again. |
| MCP `memory_search` and `memory_recall` | No server answers within 2 s, `MEMHTML_MCP_HEAD=off` is set, or the call names `include_archived`, `as_of`, a quoted phrase, or a query with no term the head indexes.   | Never because of the server. These calls answer from the index instead.                                                    |

`session exec`, `session commit`, and `session rebase` fail with `ERR_STORAGE` in the last column on purpose. The server may already have appended the harvest or moved the ref, and doing the work again locally could do it twice. After a lost commit, `session status` with zero operations means the commit landed.

`curate run`, `curate merge`, and `curate collapse` never ask the server. They judge the exact version they commit against, so they always load it themselves.

Payloads say which path a call took. `head.source` is `server` when the server answered. The session commands also carry `via` (`server` or `local`) and `server: { used, base, reason, detail }`, where `reason` names why the call worked alone: `disabled` under `--no-server`, `no-server`, `refused`, or the server's decline.

## Deadlines and pool settings

| Variable                      | Read by                                      | Default                                                                      | What it bounds                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMHTML_EMBED_DEADLINE_MS`   | `head search`, and the server's `/v1/search` | `450`                                                                        | How long a search waits for its query embed. Past it the search answers without the vector arm and reports `reason: "embed-timeout"`. `0` waits as long as the embed takes.                          |
| `MEMHTML_EMBED_WARM_IDLE_MS`  | `head serve`                                 | `0`, off                                                                     | Set above 0, the server sends one tiny embed after that many quiet milliseconds, so the first search after a lull finds a warm connection. `45000` keeps a pool with a one-minute idle timeout warm. |
| `MEMHTML_EXEC_POOL_SIZE`      | `head serve`                                 | one fewer than the machine's available parallelism, at least 1 and at most 4 | How many `session exec` scripts run at once. Accepts 1 to 64.                                                                                                                                        |
| `MEMHTML_EXEC_WORKER_HEAP_MB` | `head serve`                                 | `2048`                                                                       | Each script worker's heap limit, 64 to 65536. A worker past it is stopped and replaced, and its job fails with `ERR_STORAGE`.                                                                        |
| `MEMHTML_COMMIT_DEADLINE_MS`  | `session commit`, `session rebase`           | `60000`                                                                      | How long the client waits for the server's answer. `0` waits as long as the server takes. A malformed value exits 2.                                                                                 |

`memhtml config` shows three of the variables `head serve` reads, with the value each one resolves to and whether it came from the environment. A value the server would refuse is reported there with a `problem`.

The server also bounds its own queues. One `session exec` per session runs at a time, and a request waits at most 30 seconds for that session's earlier exec and 30 more for a free worker before it's declined as `busy`. A script still running 5 seconds past its own timeout has its worker stopped, and it reports exit 124 with nothing harvested. One commit or rebase runs at a time, and one that waits more than 20 seconds to start is declined as `busy`, so the client commits locally with time to spare.

## Run it under a service manager

`head serve` runs in the foreground, logs to stderr, and exits 0 on SIGTERM after removing its socket. Any service manager can run it with no wrapper script. Four things matter:

- Give the absolute path to Node 24 and to the installed entry point. A service starts with a short `PATH` that won't hold a version-managed Node. The entry point is `dist/memhtml.mjs` in the published package and `apps/cli/dist/bin.js` in a clone.
- Keep `git` on the service's `PATH`, because the server reads the ref and the tree through it.
- Run one server per store, and pass the store with `--repo`.
- Restart it on failure. A second server exits 1 only while another one is live, and a socket left by a killed server is replaced on the next start, so a restart loop settles.

Under systemd, one template unit can serve every store, with the store path as the instance name:

```ini
# ~/.config/systemd/user/memhtml-head@.service
[Unit]
Description=memhtml head server for %f

[Service]
Type=exec
ExecStart=/path/to/node /path/to/memhtml/dist/memhtml.mjs head serve --repo %f
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

```bash
unit="memhtml-head@$(systemd-escape --path /path/to/store).service"
systemctl --user daemon-reload
systemctl --user enable --now "$unit"
journalctl --user -u "$unit" -f
systemctl --user stop "$unit"     # SIGTERM: the socket is removed and the envelope lands in the journal
```

launchd, runit, and supervisord need the same four things: the absolute command, `git` on the path, one instance per store, and a restart on failure. The environment variables in the table above go in the unit's environment, because the server reads them when it starts.

## Keep the vector arm covered

With an embedder configured, the vector arm only covers records the cache has a vector for. Run `memhtml head embed` once to fill the cache for the whole corpus. After that, a running server embeds new records in the background as commits land, and `memhtml head status` reports `vectors.pending` and `vectors.backfill` under `server`. Without a server, run `head embed` after commits land, for example from the same cron schedule as `index update`.

[Write through a session](/learn/operations/write-through-a-session/) covers the session commands this server speeds up.

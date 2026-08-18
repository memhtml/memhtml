---
title: Wire up the MCP server
description: Run memhtml serve mcp over stdio, see the tools and resources a client gets, and call one by hand.
---

`memhtml serve mcp` exposes the same store over the Model Context Protocol on stdio: fourteen tools
and two resources (`apps/mcp/src/tools.ts:735`). This tutorial starts the server, lists what a client
sees, calls a tool by hand so you can verify the wiring without a client, and then configures a
client.

You need a store with something in it, so [write a memory](/learn/tutorial/first-memory/) first.

## Start it

```bash
export MEMHTML_ROOT=~/memhtml
memhtml serve mcp
```

Nothing appears on stdout, and that is correct: stdout is the JSON-RPC stream. Anything else written
there would corrupt the protocol, so every log goes to stderr. The server then waits for a client to
speak first.

`memhtml serve mcp` holds no database of its own. It spawns the `memhtml-mcp` entry point with
inherited stdio and waits (`apps/cli/src/serve.ts:72`), so the supervisor holds no handle that could
conflict with the child. Interrupting the supervisor kills the child, so Ctrl-C never leaves an
orphaned server holding the database open (`apps/cli/src/serve.ts:97`). On exit you get the one
envelope the contract promises:

```json
{
  "apiVersion": "1",
  "type": "serve.exit",
  "data": {
    "server": "/path/to/memhtml/apps/mcp/dist/bin.js",
    "exitCode": 130,
    "signal": null
  }
}
```

The two apps ship as one build, so the supervisor finds the server by sibling path. For a split
deployment that does not keep them side by side, set `MEMHTML_MCP_BIN` to an explicit path. That
variable locates the server and configures no store behavior at all.

## See what a client sees

You do not need a client to check the wiring. Speak the protocol on stdin:

```bash
{ printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 1
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 2
} | memhtml serve mcp 2>/dev/null
```

The handshake answers:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"logging":{},"completions":{},"resources":{"subscribe":true,"listChanged":true},"tools":{"listChanged":true}},"serverInfo":{"name":"memhtml","version":"0.2.2"}}}
```

`2025-06-18` is the protocol revision this server speaks, and it is the only adapter shipped, so a
client negotiating a different revision will not connect. `serverInfo.version` is the released
package version, so expect it to read higher than this transcript.

`tools/list` publishes the tools in this order:

```
memory_write        memory_write_batch  memory_read      memory_search
memory_recall       memory_correct      memory_link      memory_neighbors
memory_archive      memory_reinforce    memory_list      trace_search
trace_links         memory_status
```

The order is deliberate, because a client publishes it and an agent reads it top-down.
`memory_write_batch` sits second, directly after `memory_write`, so the tool that `memory_write`'s own
description points at is the very next entry rather than thirteen tools away.

Two resource templates come with them:

```json
{
  "resourceTemplates": [
    {
      "uriTemplate": "memhtml://file/{path}",
      "name": "Memory file",
      "description": "One memory's title, claim, and body text, by repo-root-relative path. For showing a human the file behind an answer.",
      "mimeType": "text/plain"
    },
    { "uriTemplate": "memhtml://sleep/{run-id}", "name": "Sleep run report" }
  ]
}
```

`memhtml://file/{path}` funnels through the same use case `memory_read` does, so fetching it bumps the
access plane: it is a chosen open. `memhtml://sleep/{run-id}` serves one curation run's committed HTML
report.

Sleep is absent from the tool surface, because it is a cron and operator action that produces a
reviewable branch and an agent should not start one mid-conversation. The other operator commands
are absent with it: `doctor`, `publish`, `index rebuild`, `sleep merge`, and the discrimination gate
all stay on the CLI, so reach for `memhtml` for anything on the operations pages.

## Call a tool

```bash
{ printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 1
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"drain the VIP"}}}'
  sleep 3
} | memhtml serve mcp 2>/dev/null
```

The result carries the answer twice, once as text and once as `structuredContent`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "{\"hits\":[…]}" }],
    "structuredContent": {
      "hits": [
        {
          "path": "resources/runbook/drain-the-vip-before-reverting-a-deploy.html",
          "title": "Drain the VIP before reverting a deploy",
          "gist": "If a prod rollback is issued, drain the VIP before reverting the deploy.",
          "memory_type": "procedural",
          "score": 1,
          "confidence": 1,
          "updated_at": "2026-08-12T19:23:15Z",
          "snippet": "If a prod rollback is issued, drain the VIP before reverting the deploy.",
          "entities": [],
          "superseded_by": null
        }
      ],
      "degraded": true,
      "arms": ["fts", "recency", "salience"],
      "entity_scope": null,
      "scope_empty": false
    }
  }
}
```

The fields are the same as `memhtml search`'s, spelled in snake_case on this surface: `memory_type`,
`updated_at`, `superseded_by`, `scope_empty`, where the CLI's own envelope is camelCase. Read the
key from the surface you are on.

`degraded`, `arms`, and `scope_empty` mean exactly what they mean on the
[CLI](/learn/tutorial/first-retrieval/), and they are on the tool result for the same reason: a client
that cannot tell a narrow answer from a complete one will present a narrow one as complete.

## Configure a client

An MCP client launches the server as a subprocess. The entry looks like this, and while the wrapper key
differs between clients, the `command` / `args` / `env` triple is the shape they share:

```json
{
  "mcpServers": {
    "memhtml": {
      "command": "memhtml-mcp",
      "env": {
        "MEMHTML_ROOT": "/home/you/memhtml"
      }
    }
  }
}
```

`memhtml-mcp` is the server itself, installed beside `memhtml` by the same package. `"command":
"memhtml", "args": ["serve", "mcp"]` reaches the same server through a supervisor process and is
equally valid — use it when you want the CLI's own resolution of the entry point, and the direct
binary when you would rather not spawn a process to spawn a process.

Set `MEMHTML_ROOT` explicitly in the client config rather than relying on a shell profile. A client
launches the server from its own environment, which is not your interactive shell, and the default
`~/memhtml` may not be the store you meant. The binary expands a leading `~` itself, so `~/memhtml` is
a legal value here.

When your `memhtml` is a symlink into `~/.local/bin` and the client does not inherit that on its
`PATH`, give the absolute path to `apps/cli/dist/bin.js` as `command` instead.

## Run it alongside the CLI

A CLI command and a running server can share one store. The index is WAL SQLite: it admits one writer
at a time and any number of concurrent readers, readers never block the writer, a second writer waits
rather than failing, and a wait that outlives `busy_timeout` is retried with jittered exponential
backoff for up to 20 seconds (`packages/index/src/database.ts`). So running `memhtml write` while a
server serves the same store is supported, and so is the every-ten-minutes `index update` cron.

The exception is `memhtml sleep run`, for a git reason rather than a database one. A run holds a
checked-out `sleep/<date>` branch, so a concurrent write commits onto that branch and is then either
merged as if it were curation or lost when the branch is dropped. Quiesce writes for the duration of a
run.

[Share one store between a CLI and a server](/learn/operations/share-one-store/) is the operational
version of this, with the concurrency probe you can run yourself. [The envelope contract and the tool
surface](/internals/the-envelope-contract/) explains why the two surfaces carry the same answers.

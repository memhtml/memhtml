---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Processes

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

Every process starts at one of two binaries: `memhtml`, whose `run` parses argv, routes the command and prints one envelope, and `memhtml-mcp`, which serves MCP tools over stdio. Both run over the same `layerApp` composition (`apps/mcp/src/server.ts:53`, `apps/cli/src/run.ts:711`). Writes go to git first and then reproject the SQLite index (`apps/cli/src/operations.ts:353-355`), MCP searches go to the head server when one answers and to the index otherwise (`apps/mcp/src/handlers.ts:618`), and `memhtml search` goes straight to the index (`apps/cli/src/run.ts:442-450`). This page was built from the source at HEAD: `apps/cli/src/run.ts`, `apps/cli/src/operations.ts`, `apps/cli/src/v2.ts`, `apps/cli/src/head-server.ts`, `apps/mcp/src`, `packages/store/src/store.ts` and `packages/index/src`.

## CLI invocation

Entry point: `apps/cli/src/bin.ts:5`

1. The binary passes `process.argv.slice(2)` to `run` and waits for its result. `apps/cli/src/bin.ts:5`
2. `run` parses argv and reads `--dense`, which picks the envelope rendering. `apps/cli/src/run.ts:1774-1780`
3. `help` or `--help` returns help, and a bare invocation returns the manifest envelope at exit 0. `apps/cli/src/run.ts:1784-1788`
4. For the record-creating v1 commands, `run` loads the store policy before validation when the root is known without a layer, so a closed `v1Doors` mode refuses before anything opens. `apps/cli/src/run.ts:1798-1806`
5. `validate` checks the parsed call and a usage error returns at `EXIT_USAGE`. `apps/cli/src/run.ts:1808-1809`
6. `manifest`, `agents-doc` and `eval discriminate` answer without building the app layer. `apps/cli/src/run.ts:1824-1881`
7. `hook`, `integrations *`, `serve mcp`, `config`, `exec` and the v2 session and head commands each take their own branch before the generic path. `apps/cli/src/run.ts:1912-2164`
8. Every other command goes through `dispatch`, provided with `layerApp`, the telemetry layer and a stderr logger; typed failures map through `failureFor`, and `V1DoorClosed` exits with `EXIT_USAGE`. `apps/cli/src/run.ts:2543-2575`
9. The binary writes the envelope to stdout and calls `process.exit` from the write callback, so a slow pipe reader still gets the whole envelope. `apps/cli/src/bin.ts:22`

### Related

- `apps/cli/src/run.ts:363 dispatch()`
- `apps/cli/src/api-layer.ts:409 layerApp()`
- `apps/cli/src/commands.ts:186`
- `apps/cli/src/run.ts:2027-2028`

## MCP server startup and tool call

Entry point: `apps/mcp/src/bin.ts:15`

1. The binary launches `layerServer()` over `NodeStdio.layer` with `Layer.launch`, so the server lives as long as the process. `apps/mcp/src/bin.ts:15`
2. `layerServer` merges the `MemhtmlToolkit` toolkit and the `Resources` layer and provides `ToolHandlers`. `apps/mcp/src/server.ts:40-42`
3. It binds `McpServer.layerStdio` with the server name, version and `McpProtocol.v2025_06_18` as the only protocol. `apps/mcp/src/server.ts:44-51`
4. It provides the CLI's own `layerApp`, so both doors read the same root, database and vector space. `apps/mcp/src/server.ts:53`
5. On a tool call, the handler from `MemhtmlToolkit.toLayer` runs; `memory_write` first runs `guardV1Door` and then the shared `writeMemory` operation. `apps/mcp/src/handlers.ts:373-394`
6. `handled` maps every typed error to a `ToolFailure` through `toToolFailure`. `apps/mcp/src/handlers.ts:84-85`
7. `memory_search` asks the head server first through `searchOnHead` and falls back to `searchMemories` on the index when that answers `null`. `apps/mcp/src/handlers.ts:618-619`

### Related

- `apps/mcp/src/tools.ts`
- `apps/mcp/src/resources.ts`
- `apps/mcp/src/handlers.ts:368 ToolHandlers`
- `apps/cli/src/head-retrieval.ts:128 searchOnHead()`

## Single memory write

Entry point: `apps/cli/src/operations.ts:349`

1. The CLI `write` case runs `guardV1Door("write")` and calls `ops.writeMemory` with the parsed flags. `apps/cli/src/run.ts:378-400`
2. `writeMemory` decodes the parameters into the store's `WriteInput` with `toWriteInput` and calls `store.writeMemory`. `apps/cli/src/operations.ts:351-353`
3. The store wraps the write in `exclusive`, which takes the in-process writer permit and the checkout lock. `packages/store/src/store.ts:1465-1474`
4. The store refuses a strict-path conflict, renders the HTML, and hashes it. `packages/store/src/store.ts:763-767`
5. A content-hash match in `dedupeLookup` returns the existing path with `deduped: true` and no commit. `packages/store/src/store.ts:773-783`
6. `freePathFor` picks the file path from title, type, time, workspace, entities and tags. `packages/store/src/store.ts:785-793`
7. Inside `compensated`, the store journals the path, writes the file, runs `git add` and commits with provenance trailers. `packages/store/src/store.ts:801-812`
8. When the write created a file, `reindex` runs `indexer.update` with embeddings on. `apps/cli/src/operations.ts:355`
9. `recordLink` records a `wrote` link for the session when a session id was given. `apps/cli/src/operations.ts:356`

### Related

- `apps/cli/src/operations.ts:304 toWriteInput()`
- `apps/cli/src/operations.ts:272 reindex()`
- `apps/cli/src/operations.ts:206 recordLink()`
- `packages/store/src/store.ts:761`

## Batch apply

Entry point: `apps/cli/src/operations.ts:751`

1. The CLI `apply` case runs `guardV1Door("apply")` and calls `ops.batchWrite` with the decoded ops and the conflict flags. `apps/cli/src/run.ts:408-419`
2. When asked, `batchWrite` detects frame conflicts and near duplicates across the ops before writing. `apps/cli/src/operations.ts:768-781`
3. Each op is decoded through the same `toWriteInput` the single write uses. `apps/cli/src/operations.ts:796-797`
4. The extractor adds extracted entities to each op's declared ones, and a failed extraction only logs a warning. `apps/cli/src/operations.ts:836-855`
5. `store.writeMemories` validates every op and then writes all files and makes one batch commit inside `compensated`. `packages/store/src/store.ts:979-1046`
6. When any path was written, `batchWrite` reindexes once and records a `wrote` link per path. `apps/cli/src/operations.ts:883-884`

### Related

- `packages/store/src/store.ts:947 writeMemories()`
- `apps/cli/src/operations.ts:862`
- `apps/mcp/src/handlers.ts:209`

## Index update

Entry point: `packages/index/src/indexer.ts:808`

1. `update` checks the embedding model, reads `HEAD` and reads the stored index state. `packages/index/src/indexer.ts:810-812`
2. With no state row, it reprojects the whole tree and reports every file as added. `packages/index/src/indexer.ts:821-834`
3. A state whose `head_sha` is null fails with `IndexStale`, because a rebuild didn't finish. `packages/index/src/indexer.ts:842-846`
4. Otherwise it diffs the watermark against `HEAD` and reads `git status`, keeping indexable paths only. `packages/index/src/indexer.ts:854-858`
5. It reads changed blobs from the tree and projects each one. `packages/index/src/indexer.ts:870-945`
6. It applies the projection writes and moves the watermark to `HEAD`. `packages/index/src/indexer.ts:994-995`
7. With embedding on, it embeds the missing chunks, logs the report and returns it. `packages/index/src/indexer.ts:1002-1019`

### Related

- `packages/index/src/indexer.ts:857`
- `packages/index/src/indexer.ts:981`
- `apps/cli/src/operations.ts:272 reindex()`

## Ranked search

Entry point: `packages/index/src/retrieval.ts:506`

1. The CLI `search` case calls `ops.searchMemories`, which hands the query to `Retrieval.search`. `apps/cli/src/run.ts:442-450`
2. `search` gets a gated query vector, which can be absent when embeddings are off. `packages/index/src/retrieval.ts:508-510`
3. It fuses the ranking arms into one path list and hydrates the rows. `packages/index/src/retrieval.ts:511-517`
4. It scores rows by polarity and reorders them with MMR up to the limit. `packages/index/src/retrieval.ts:530-539`
5. It fetches snippets and, when a scope filter emptied the result, looks for archived matches in scope. `packages/index/src/retrieval.ts:545-557`
6. It returns the hits under the `retrieval.search` span. `packages/index/src/retrieval.ts:560-598`

### Related

- `apps/cli/src/operations.ts:999 searchMemories()`
- `packages/index/src/retrieval.ts:600 recall()`
- `apps/cli/src/head-retrieval.ts:94 ask()`

## Session commit

Entry point: `apps/cli/src/v2.ts:1310`

1. The v2 dispatcher routes `session commit` to `sessionCommit`. `apps/cli/src/v2.ts:2192-2193`
2. `sessionCommit` loads the store policy for its `writeBar`. `apps/cli/src/v2.ts:1327`
3. Unless disabled, it asks the head server to commit; a served answer returns with `via: "server"`. `apps/cli/src/v2.ts:1329-1347`
4. A refusal or no answer records why the server wasn't used and falls through to a local commit. `apps/cli/src/v2.ts:1348-1351`
5. Locally, it resumes the session and loads the head at the session's base sha. `apps/cli/src/v2.ts:1353-1354`
6. `commitOverHead` refuses an empty session, adds missing repoints, and commits through `commitSession`. `apps/cli/src/v2.ts:1104-1130`
7. The result returns with `via: "local"` and the server's reason. `apps/cli/src/v2.ts:1362`

### Related

- `apps/cli/src/v2.ts:1091 commitOverHead()`
- `apps/cli/src/head-client.ts:148 askHeadFor()`
- `apps/cli/src/v2.ts:1377 opsToDrop()`
- `apps/cli/src/v2.ts:1482 sessionRebase()`

## Head server lifecycle

Entry point: `apps/cli/src/head-server.ts:1686`

1. `run` routes `head serve` to `serveHead` with the configured or overridden root. `apps/cli/src/run.ts:2395-2402`
2. `startHeadServer` resolves the followed ref and fails when it doesn't resolve, then loads the head at its tip. `apps/cli/src/head-server.ts:595-603`
3. For a socket endpoint, it excludes the socket from git, creates its directory and registers a finalizer that removes it. `apps/cli/src/head-server.ts:1543-1549`
4. It binds a Node HTTP server on the socket under a restrictive umask, then sets the socket mode to `0600`. `apps/cli/src/head-server.ts:1559-1587`
5. It starts the embedding backfill, and when `pollMs` is positive it forks a poll of the ref on a fixed schedule that logs and retries on failure. `apps/cli/src/head-server.ts:1590-1607`
6. `serveHead` logs the listening line and waits for `SIGTERM` or `SIGINT` through `untilSignal`. `apps/cli/src/head-server.ts:1694-1699`
7. On a signal it logs the close and returns the final stats, and the scope closes the server and removes the socket. `apps/cli/src/head-server.ts:1701-1715`

### Related

- `apps/cli/src/head-server.ts:543 startHeadServer()`
- `apps/cli/src/head-server.ts:1668 untilSignal`
- `apps/cli/src/head-server.ts:525`

## Minor flows

- Hook invocation: entry at `apps/cli/src/run.ts:1912`. An unknown event or host, a refused environment root, or a missing store prints nothing and exits 0, and otherwise `hookText` runs `runHook` under a per-event deadline (`apps/cli/src/run.ts:1918-1965`). `runHook` turns a timeout or any failure into an empty string (`apps/cli/src/hook.ts:329-333`).
- `serve mcp`: entry at `apps/cli/src/run.ts:2043`. It resolves the root from `--repo` or `MemhtmlRoot` and runs `serveMcp`. The exit is reported in a `serve.exit` envelope (`apps/cli/src/run.ts:2052`).
- `exec`: entry at `apps/cli/src/run.ts:2102`. It reads the script from `--script`, `--file` or stdin and refuses a blank one at usage exit (`apps/cli/src/run.ts:2107-2123`). It then runs `execCommand` against the resolved root (`apps/cli/src/run.ts:2131-2136`).
- `manifest`: entry at `apps/cli/src/run.ts:1824`. It returns `buildManifest()` without building the app layer. That keeps it working on a machine with no repo or database, since the arm returns before any app layer is built (`apps/cli/src/run.ts:1824-1826`).

## See also

- [data flow](../architecture/data-flow.md): 11 shared source citations
- [REPORT](../REPORT.md): 9 shared source citations
- [sequences](../diagrams/behavioral/sequences.md): 9 shared source citations
- [components](../diagrams/architecture/components.md): 8 shared source citations
- [dependency graph](../diagrams/structural/dependency-graph.md): 7 shared source citations

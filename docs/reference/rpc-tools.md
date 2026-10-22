# memhtml-public · RPC tools

Describes the source at 0.16.0 (2026-10-18). Citations are `path:line` into that tree.

This repository ships an MCP server, `memhtml-mcp`, that speaks MCP over stdio. It publishes fifteen tools and two resource templates (`apps/mcp/src/tools.ts:1041-1057`, `apps/mcp/src/resources.ts:322-326`). A coding agent calls it to operate a memhtml root.

**Removed in 0.16.** The resource `memhtml://sleep/{run-id}`, the `memory_status` field `last_sleep`, and `memory_write_batch`'s `consolidate` parameter with its per-op `consolidated_into` and `superseded_path` fields and its `summary.consolidated` count went away with the v1 sleep pipeline and the consolidator. Curation runs on a branch through `memhtml curate` (see `docs/design.md` §23). The operator's migration guide is at https://memhtml.github.io/learn/operations/migrate-to-0-16/.

The repository stores no memory of its own. The server acts on whatever root `MEMHTML_ROOT` names, so one binary serves many roots (see [Environment](#environment)).

The server is one Effect layer, `layerServer` (`apps/mcp/src/server.ts:40-63`). It merges `McpServer.toolkit(MemhtmlToolkit)` with the two resources. It then provides the handlers, the stdio transport, the CLI's `layerApp`, telemetry, and a stderr logger.

The server shares the CLI's app layer, so an agent's `memory_write` and an operator's `memhtml search` resolve to one database, one git root, and one vector space (`apps/mcp/src/server.ts:13-19`).

The transport is `McpServer.layerStdio` at protocol revision `v2025_06_18` (`apps/mcp/src/server.ts:44-51`). Effect `4.0.5` ships five protocol adapters: `v2026_07_28`, `v2025_11_25`, `v2025_06_18`, `v2025_03_26`, and `v2024_11_05`. The server names one, so a new revision is an explicit, reviewable choice and never a default that moves the wire format. The initialize result reports `serverInfo` as `memhtml` with `SERVER_VERSION`, a literal the release tooling rewrites at each release through its `x-release-please-version` marker (`apps/mcp/src/server.ts:10-11`).

Logs go to stderr through `Logger.LogToStderr`. Stdout carries the NDJSON-RPC frames, and Effect's default logger writes to stdout (`apps/mcp/src/server.ts:21-23`, `apps/mcp/src/server.ts:62`). `bin.ts` runs the layer with `Layer.launch` for the life of the process, because a built-then-released layer would close stdin under the client (`apps/mcp/src/bin.ts:7-15`).

The server passes no `instructions` to `layerStdio`, so the initialize result carries none. Tool descriptions are the only guidance channel. That's why shared contracts such as `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` are appended to every description they apply to (`apps/mcp/src/server.ts:25-38`). The source gives the reason as effect offering no way to set the field, which held at rc.109. At 4.0.5, `layerStdio` accepts an `instructions` option.

Every tool binds its handler by name in `MemhtmlToolkit.toLayer({...})` (`apps/mcp/src/handlers.ts:330-334`). A handler decodes the snake_case wire parameters, calls the same operation function the matching CLI command calls, and renames the result back to snake_case (`apps/mcp/src/handlers.ts:40-50`).

Every tool declares `failure: ToolFailure` (`apps/mcp/src/failure.ts:34-41`). The declaration puts a tool's failures on the `McpServer` branch that passes the message text through. Without it, the failure schema defaults to `Schema.Never`, and every failure, typed domain errors included, reaches the caller as a generic internal-error sentence (`apps/mcp/src/tools.ts:47-55`). `failureMode` stays at its `"error"` default, because `"return"` would fold a failure into the success payload where no MCP client looks for it.

`tools/list` publishes the tools in toolkit order: `memory_write`, `memory_write_batch`, `memory_read`, `memory_search`, `memory_recall`, `memory_correct`, `memory_link`, `memory_neighbors`, `memory_resolve`, `memory_archive`, `memory_reinforce`, `memory_list`, `trace_search`, `trace_links`, `memory_status`. The batch tool sits second, so the tool `memory_write`'s description points at is the next entry an agent reads (`apps/mcp/src/tools.ts:1028-1040`). The entries below are alphabetical.

The toolkit has no session, head, or curation tool. Curation is an operator action that produces a branch a human reads, so no tool fires it (`apps/mcp/src/tools.ts:31-34`). Two v2 behaviors reach the tools anyway. The store's policy file can close the three tools that create a record (see [The store policy and the record-creating tools](#the-store-policy-and-the-record-creating-tools)). `memory_search` and `memory_recall` ask the head server before the index (see [Search and recall on the head server](#search-and-recall-on-the-head-server)).

### Conventions

`Optional(X)` is `Schema.optionalKey(Schema.NullOr(X))` (`apps/mcp/src/tools.ts:105`). A client may omit the key, send a value, or send `null`. The published JSON Schema is a flat `anyOf` of `X` and `null`. The handlers treat `null` and absence alike (`apps/mcp/src/handlers.ts:109`). A bare `Schema.optional` would publish `null` as valid and then refuse it at decode (`apps/mcp/src/tools.ts:87-104`).

`MemoryPath` is `Schema.String` holding a path relative to the root's git tree with no leading slash, such as `areas/oncall/rollback-order.html` (`apps/mcp/src/tools.ts:64-71`). The schema checks nothing else. Most operations drop a leading slash. `memory_reinforce` uses its paths as given.

`Finite` is `Schema.Finite` and publishes `{"type":"number"}`. `Count` is `Schema.Int` and publishes `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`, the safe-integer bounds (`apps/mcp/src/tools.ts:73-85`). `Finite` stands in for `Schema.Number`, which publishes an `anyOf` with a string branch for `Infinity`, `-Infinity`, and `NaN`. `Count` accepts negative integers.

No tool sets strict mode. Every published `inputSchema` except `memory_status`'s allows additional properties, and the tool ignores a key it doesn't declare. A `path` or `memory_type` sent to `memory_correct`, for example, has no effect.

Each entry quotes its registration block verbatim, with two mechanical elisions. The value of every `description` property becomes `/* … */`. The write tools' descriptions run to several paragraphs built from shared constants (`apps/mcp/src/tools.ts:154-290`). Every doc comment that spans more than one line inside the block becomes `// …` at its own indentation. One-line doc comments and `//` line comments are kept. Nothing else is altered, and each entry's source line points at the full block.

### How a call fails

A tool call fails in one of three wire shapes at effect `4.0.5` (`pnpm-workspace.yaml:61`).

- A parameter that doesn't decode is a JSON-RPC error with code `-32602` and the message `Invalid parameters for tool '<name>': ...`. It carries no `ERR_*` code, and the handler never ran. A `memory_type` outside the writable types, a missing required key, and a `rel` outside the nine memory rels all fail this way.
- A typed failure is a tool result with `isError: true` and one text block, `ERR_<CODE>: <reason>. Try: <suggestion>; <suggestion>`. The `Try:` clause is left out when there are no suggestions (`apps/mcp/src/failure.ts:183-191`).
- Anything else, such as a defect, is a tool result with `isError: true` and the text "Tool execution failed due to an internal server error." The cause goes to stderr.

Every handler maps its error through `toToolFailure` once, in `handled` (`apps/mcp/src/handlers.ts:77-78`, `apps/mcp/src/failure.ts:207-224`). The code comes from `codeFor`, the reason from `messageFor`, and the suggestions from `mcpSuggestionsFor` (`apps/cli/src/errors.ts:42-102`, `apps/cli/src/errors.ts:113-164`, `apps/mcp/src/failure.ts:80-149`). A tag `codeFor` doesn't know becomes `ERR_UNKNOWN`. A `ToolFailure` that a handler composed itself, such as a batch abort, passes through unchanged (`apps/mcp/src/failure.ts:221`). One reason comes from the MCP side. For a closed record door, `mcpReasonFor` replaces the CLI's wording, which names `memhtml session` commands a tool caller can't run (`apps/mcp/src/failure.ts:151-165`).

The code is the only machine-readable part. MCP's tool-error channel is one text block, so a client reads the code from the prefix before the first colon (`apps/mcp/src/failure.ts:20-25`). The reason never carries a driver message, SQL, a git argv, or a memory body (`apps/mcp/src/failure.ts:202-205`).

These are the codes a tool can reach, and the suggestions each one carries (`apps/mcp/src/failure.ts:80-149`):

| Code                             | Suggestions                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_INVALID_MEMORY`             | fix the named constraint and call the same tool again; nothing was written                                                                              |
| `ERR_PATH_NOT_FOUND`             | call `memory_resolve` on the path, then `memory_search`, then `memory_list`                                                                             |
| `ERR_WRITE_CONFLICT`             | call `memory_read` on the path; re-apply the change and retry the write                                                                                 |
| `ERR_GIT`, `ERR_STORAGE`         | call `memory_status`; report to the operator if it persists                                                                                             |
| `ERR_EMBED_MODEL_MISMATCH`       | keep working on the other arms; the vector arm waits for an operator rebuild                                                                            |
| `ERR_SESSION_BOUND`              | keep the record for the run's session and write it from a shell with the session commands; edit existing records with `memory_link` or `memory_archive` |
| `ERR_V1_DOOR_CLOSED`             | report to the operator if the record has to land; edit existing records with `memory_link` or `memory_archive`                                          |
| `ERR_STORE_CONFIG`               | report to the operator, who has to fix `memhtml.config.json`; keep working with `memory_search`, `memory_read`, and `memory_link`                       |
| `ERR_INDEX_STALE`, `ERR_UNKNOWN` | none                                                                                                                                                    |

Two suggestion texts don't fit every case they reach. The `ERR_INVALID_MEMORY` text says the store refused "at the render gate", but the same text follows a `body`/`article_html` refusal, a self-link, and a `trace_links` call with neither key. The `ERR_WRITE_CONFLICT` text says to retry the write, but a retry at the same occupied path conflicts again. `memory_correct` is the replacement (`apps/mcp/src/tools.ts:191-192`).

`mcpSuggestionsFor` also has arms for `ERR_DUPLICATE_CONTENT`, `ERR_MODEL_UNAVAILABLE`, `ERR_DIRTY_TREE`, and `ERR_DISCRIMINATION_FAILED`. No tool or resource raises those codes at this tree. A duplicate is a successful dedupe, and an embedder or extractor failure degrades the call instead of failing it. Only the CLI's `curate merge` raises a dirty-tree refusal (`apps/cli/src/v2.ts:1741-1743`).

### What a failed write leaves behind

The five write tools are `memory_write`, `memory_write_batch`, `memory_correct`, `memory_link`, and `memory_archive`. The first three create a record, and each of them runs the store-policy guard before anything else. A refusal there reads one file and touches nothing (see [The store policy and the record-creating tools](#the-store-policy-and-the-record-creating-tools)). Past the guard, each write fails in one of three phases, and the phase decides what's left behind.

1. Validation runs before anything touches disk. For a new memory, that's the strict-path gate, the render gate, the dedupe lookup, and the path claim (`packages/store/src/store.ts:722-754`). For a correction, a link, or an archive, it's the check that the target or both endpoints exist. A refusal here leaves the tree byte-identical.
2. The write, the stage, and the commit run under a journal. On a failure or an interruption, the store unstages every path it touched and puts back each one's earlier bytes (`packages/store/src/store.ts:490-577`). If that restore fails too, the failure is logged and the tree is left dirty.
3. After the commit, the operation calls `reindex` (`apps/cli/src/operations.ts:267-271`). That step can fail with `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` after the commit has landed. The call reports a failure, but the memory is in git.

A blind retry after a phase-3 failure can store the memory twice. Dedupe reads the index through `activePathForHash`, and the index hasn't caught up with the commit (`packages/index/src/traces-persist.ts:196-203`). `memory_status` shows the gap as `index_fresh: false`.

The commit is a plain `git commit -m`, so it also commits any path that was already staged in the root (`packages/store/src/git.ts:403-422`).

Writes in one process take turns behind one permit, `oneWriterAtATime`, and reads don't wait for it. Inside the permit, each write holds the checkout lock, the directory `.memhtml/checkout.lock`, for the whole operation (`packages/store/src/store.ts:1397-1424`). `git commit` takes the same lock as a backstop (`packages/store/src/git.ts:403-406`). The lock is shared across processes, so a CLI command beside the server and a session commit in any process take turns with the server's writes. A write that waits 15 s for the lock fails with `ERR_STORAGE` (`checkout.locked`) before anything is written (`packages/store/src/checkout-lock.ts:31-44`). `docs/design.md` §17 gives the lock's timings.

### The store policy and the record-creating tools

Three tools create a record: `memory_write`, `memory_write_batch`, and `memory_correct`. Each handler runs `guardV1Door` before anything else. The CLI's `write`, `apply`, `correct`, and `task add` run the same guard (`apps/mcp/src/handlers.ts:316-329`, `apps/mcp/src/handlers.ts:338`, `apps/mcp/src/handlers.ts:405-406`, `apps/mcp/src/handlers.ts:658`). These doors commit straight to the store and skip the write bar every session is held to, which is why the policy can close them (`apps/cli/src/doors.ts:5-17`). `memory_write_batch` runs the guard once per call, before it looks at any op, so a closed door refuses the whole call.

The guard reads `memhtml.config.json` at the store root on every call. It reads the working-tree copy and caches nothing, so an edit applies to the next call with no restart (`apps/cli/src/store-config.ts:23-44`). It also reads `MEMHTML_SESSION` from the server's own environment, because MCP has no per-call session binding (`apps/cli/src/store-config.ts:101-133`). A blank value counts as unset (`apps/cli/src/config.ts:101-105`). The file's `v1Doors` key picks one of three modes. With no key or no file, the mode is `closed-in-session` (`packages/contracts/src/store-config.ts:23-38`, `packages/contracts/src/store-config.ts:123`).

| `v1Doors`                     | Server without `MEMHTML_SESSION` | Server with `MEMHTML_SESSION` |
| ----------------------------- | -------------------------------- | ----------------------------- |
| `open`                        | open                             | open                          |
| `closed-in-session` (default) | open                             | refused, `ERR_SESSION_BOUND`  |
| `closed`                      | refused, `ERR_V1_DOOR_CLOSED`    | refused, `ERR_SESSION_BOUND`  |

The code says whether a session closed the door. `codeFor` answers `ERR_SESSION_BOUND` when the refusal carries a session, and `ERR_V1_DOOR_CLOSED` when the `closed` mode closed it alone (`apps/cli/src/errors.ts:95-98`). So under the default, a shared server started outside any run stays open. A server that an agent runtime starts inside a run, with the variable exported to it, is closed. `memhtml serve mcp` passes its whole environment to the child, so a `MEMHTML_SESSION` set for it reaches the server (`apps/cli/src/serve.ts:86-90`).

The refusal names the tool and says nothing was written (`apps/mcp/src/failure.ts:158-165`). Its first suggestion depends on the case. With a session, the record belongs in the run's session, written from a shell with the session commands, and the run commits the session when it ends. Without one, the store takes records only through sessions, and the record is the operator's call. Both refusals point at `memory_link` and `memory_archive` for records that already exist (`apps/mcp/src/failure.ts:128-140`). The toolkit carries no session tool, so a caller with only these tools can't write through a session (see `docs/design.md` §18 and §19).

The edits of existing records aren't doors. `memory_link`, `memory_archive`, and `memory_reinforce` run no guard, and no mode closes them (`packages/contracts/src/store-config.ts:34-35`). The reads never open the policy file.

A policy file that exists and doesn't decode, or that can't be read, fails every record-creating call with `ERR_STORE_CONFIG`. The reason names the file and what's wrong with it (`apps/cli/src/store-config.ts:63-93`, `apps/cli/src/errors.ts:152-153`). Decoding is strict. An unknown key, a value of the wrong type, and an unknown memory type are refused, and none of them reads as unset (`packages/contracts/src/store-config.ts:14-17`). The tools that create no record keep working (`apps/mcp/src/failure.ts:141-145`).

### Search and recall on the head server

`memory_search` and `memory_recall` ask the head server first and fall back to the SQLite index (`apps/mcp/src/handlers.ts:573-581`, `apps/mcp/src/handlers.ts:617-619`). The head server is `memhtml head serve`, a long-lived process that holds the parsed corpus of one ref and answers on the store's socket, `.memhtml/head.sock`, or a named pipe on win32 (see `docs/design.md` §22). It reads the ref before every answer, so a record a run session committed a moment ago is in its next answer. The index has that record only after the next `memhtml index update` (`apps/cli/src/head-retrieval.ts:19-33`). The MCP server never starts a head server, so with none running every call takes the index path.

`routeFor` decides where one call goes. It checks these conditions in order (`apps/cli/src/head-retrieval.ts:64-80`):

| Condition                                                                                | Route | Reason             |
| ---------------------------------------------------------------------------------------- | ----- | ------------------ |
| `MEMHTML_MCP_HEAD` is `off`, trimmed, any case                                           | index | `disabled`         |
| `include_archived` is true                                                               | index | `include-archived` |
| `as_of` is set and isn't empty                                                           | index | `as-of`            |
| `query` contains a `"`                                                                   | index | `phrase`           |
| `query` has no term the index's FTS sanitizer keeps, or no token the head's BM25 indexes | index | `no-terms`         |
| anything else                                                                            | head  |                    |

The reasons are `IndexReason`'s values, and each routing decision goes to the debug log (`apps/cli/src/head-retrieval.ts:44-60`, `apps/cli/src/head-retrieval.ts:133-143`). The head's arms rank active records only, and a record carries no validity window, which is why `include_archived` and `as_of` stay on the index. BM25 has no phrases, which is why a quoted span does too. Every other parameter goes to the head: `query`, `limit`, `memory_types`, `workspace`, `tags`, `entity`, `facets`, and recall's `budget_chars`. The scope travels in the request's `scope` field and carries only the axes the call named (`apps/cli/src/head-retrieval.ts:82-91`). The head applies each axis inside each arm, the way the index does. Tasks drop out unless `memory_types` names `task`. `workspace` matches the directory under `projects/`. `tags` matches any of the tags. `entity` matches a `type:name` reference with ASCII case folding. `facets` compose as the index composes them (`apps/cli/src/head-scope.ts:94-139`).

A call routed to the head still falls back to the index when the socket gives no usable answer. `askHead` never fails. It answers `null` when there's no socket file, nobody listens, the socket path is past the platform's limit, the connection doesn't complete within 100 ms (`CONNECT_TIMEOUT_MS`), any other connect error occurs, the server answers with a status other than 200, or the body doesn't decode (`apps/cli/src/head-client.ts:14-19`, `apps/cli/src/head-client.ts:40-44`, `apps/cli/src/head-client.ts:221-229`). These two tools pass an answer timeout of 2,000 ms, `HEAD_RETRIEVAL_TIMEOUT_MS`, and the timeout bounds the whole ask (`apps/cli/src/head-retrieval.ts:37-42`, `apps/cli/src/head-client.ts:188`). An answer without a `scope` report, or with a hit that lacks its `detail`, also counts as no answer, which is how an older server's answer is handled (`apps/cli/src/head-retrieval.ts:93-118`). A search changes nothing, so a fallback after a lost answer can't repeat an effect. A head failure never fails the tool call.

The answer through the head has the index answer's fields and types, so the handler shapes both with the same code (`apps/cli/src/head-retrieval.ts:127-165`). What the fields hold differs in six ways.

- The ranking is the head's. It fuses a BM25 lexical arm and an optional vector arm with RRF, each arm capped at 40 records, and recency only breaks an exact tie in the fused score (`packages/head/src/search.ts:9-25`, `packages/head/src/search.ts:57-80`). It has no salience arm. It also skips the two steps the index path runs after fusion, the polarity step that demotes a negation-flipped twin and MMR diversification (`packages/index/src/retrieval.ts:519-539`). `docs/design.md` §16 explains the head's choices.
- `score` is the fused RRF score. On the index path it's the polarity step's score, the reciprocal of the candidate's fused rank, lowered for a demoted twin (`packages/index/src/polarity.ts:78-109`). Either way it's comparable only within one result set.
- `arms` is `["fts", "vector", "recency"]` when the vector arm ran and `["fts", "recency"]` when it didn't, in the index's vocabulary (`apps/cli/src/head-retrieval.ts:120-125`). `recency` is always named, though it only breaks ties. The index path names the arms its statement declared, from `fts`, `vector`, `recency`, and `salience` (`packages/index/src/retrieval.ts:670-672`).
- `degraded` is true when the head's vector arm didn't run. That happens when the head server has no embedder bound, holds no vector cache, can't read its cache, or its query embed fails or passes its deadline (`apps/cli/src/head-vectors.ts:206-266`). The coverage floor, `MEMHTML_VECTOR_COVERAGE_FLOOR`, doesn't apply on this path. The MCP server sends no embed deadline, so the head server's own `MEMHTML_EMBED_DEADLINE_MS` applies, 450 ms by default (`apps/cli/src/head-protocol.ts:123`, `apps/cli/src/head-protocol.ts:156-163`).
- `vector_coverage` is the share of the served version's active records whose content hash has a vector in the head server's cache, 0 to 1 (`apps/cli/src/head-vectors.ts:125-135`). It's `0` when the server holds no cache or has no embedder bound (`apps/cli/src/head-retrieval.ts:157-158`). The index path reports the share of indexed chunks that carry a vector.
- `snippet` is always the article's opening chunk, cut to the snippet size (`apps/cli/src/head-scope.ts:77`). The index path takes the chunk that best matches the query when the vector arm fired.

`memory_recall` on the head asks for 30 candidates, the index path's pool size, in fused order. It folds them with the index's own `foldDisclosure`, arcs under their 9,000-character envelope and the rest under `budget_chars` (`apps/cli/src/head-retrieval.ts:167-214`). Each quote is the record's disclosure text, which the head derives the way the index does (`apps/cli/src/head-protocol.ts:545-563`). `degraded` and `vector_coverage` mean what they mean on a head search.

Neither path bumps salience.

### Environment

The server reads its configuration from its own environment at startup. `bin.ts` calls `layerServer` with no root override, so the root is `MEMHTML_ROOT` (`apps/mcp/src/bin.ts:15`, `apps/cli/src/api-layer.ts:100-109`). `memhtml serve mcp` runs the server as a child process and sets `MEMHTML_ROOT` for it, which is how `--repo` reaches the server (`apps/cli/src/serve.ts:82-90`).

| Variable                                                                                           | Effect on the server                                                                                                                                                                                  | Default                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `MEMHTML_ROOT`                                                                                     | The memory repo's root; a leading `~` is expanded (`apps/cli/src/config.ts:282-286`)                                                                                                                  | `~/memhtml`                |
| `MEMHTML_TRACE_ROOT`                                                                               | Read at startup; no tool reads the directory (`apps/cli/src/config.ts:294-297`)                                                                                                                       | `~/.claude`                |
| `MEMHTML_SESSION`                                                                                  | Read on every record-creating call; set, it closes `memory_write`, `memory_write_batch`, and `memory_correct` unless `v1Doors` is `open` (`apps/cli/src/store-config.ts:125-133`)                     | unset                      |
| `MEMHTML_MCP_HEAD`                                                                                 | Read on every `memory_search` and `memory_recall`; `off` sends each call to the index (`apps/cli/src/head-retrieval.ts:68-73`)                                                                        | `on`                       |
| `MEMHTML_EMBED`                                                                                    | `off` binds no embedder, so search and recall on the index path report `degraded`, and a batch that asks for near-duplicates reports `near_duplicates_degraded` (`apps/cli/src/api-layer.ts:232-244`) | `on`                       |
| `MEMHTML_VECTOR_COVERAGE_FLOOR`                                                                    | The coverage below which search and recall on the index path drop the vector arm, reported as `vector_coverage_floor`; a value outside (0, 1] stops startup (`apps/cli/src/api-layer.ts:294-306`)     | `0.95`                     |
| `MEMHTML_LLM`, `MEMHTML_EXTRACT_ENTITIES`                                                          | Either one `off` binds no entity extractor, so `memory_write_batch` extracts nothing (`apps/cli/src/api-layer.ts:362-376`)                                                                            | `on`                       |
| `MEMHTML_AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`                                                   | The Bedrock region and credential for embeddings and the extractor (`packages/llm/src/client.ts:162-163`)                                                                                             | `us-east-1`, default chain |
| `MEMHTML_LLM_BASE_URL`, `MEMHTML_LLM_API_KEY`, `MEMHTML_LLM_MODEL_PREFIX`, `MEMHTML_LLM_MODEL_MAP` | Route model and embedding calls through an LLM proxy; `normalizeProxyBaseUrl` or `parseProxyModelMap` stops startup on a malformed value (`packages/llm/src/client.ts:174-192`)                       | unset                      |
| `MEMHTML_OPENAI_PROMPT_CACHE`                                                                      | Read with the model client; a value other than `off` or `implicit` stops startup (`packages/llm/src/wire.ts:76`)                                                                                      | `off`                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                      | Exports one trace per tool call, as service `memhtml-mcp` (`apps/mcp/src/server.ts:54-61`)                                                                                                            | unset                      |
| `OTEL_SERVICE_NAME`                                                                                | Overrides that service name (`apps/cli/src/config.ts:258-263`)                                                                                                                                        | unset                      |

A value that stops startup is logged on stdout, and the process exits with status 1. `NodeRuntime.runMain` reports the failure outside the layer that routes logs to stderr (`apps/mcp/src/bin.ts:15`).

Some variables in the CLI's manifest aren't read by the server. `MEMHTML_REFUSE_ENV_ROOT` is read by `memhtml` only (`apps/cli/src/config.ts:123-127`). `MEMHTML_MCP_BIN` only locates the server for `memhtml serve mcp` (`apps/cli/src/serve.ts:56-59`). `MEMHTML_CURATOR_MODEL` belongs to `curate run`. `MEMHTML_COMMIT_DEADLINE_MS` belongs to `session commit` and `session rebase`. `MEMHTML_EMBED_DEADLINE_MS`, `MEMHTML_EMBED_WARM_IDLE_MS`, `MEMHTML_EXEC_POOL_SIZE`, and `MEMHTML_EXEC_WORKER_HEAP_MB` belong to the head commands (`apps/cli/src/config.ts:180-185`, `apps/cli/src/config.ts:198-222`). The head server reads its own environment, so its embedder and its embed deadline are set where it runs.

### How the resources route

`memhtml://file/{path}` and `memhtml://at/{commit}/{path}` are the same read at two grains. A path alone names whatever lives there now, while a commit sha pins the bytes (`apps/mcp/src/resources.ts:16-21`).

Both templates are registered by one helper, `templateLayer` (`apps/mcp/src/resources.ts:123-156`). It calls `McpServer.addResourceTemplate` directly and skips the `McpServer.resource` tagged template. The reason is the router.

`McpServer` matches a `resources/read` URI with find-my-way (`effect/http/FindMyWay`). Two of that router's rules decide the pattern each resource registers, `memhtml:://<section>/*`, which `routerPathFor` builds (`apps/mcp/src/resources.ts:47`).

- A `:` that isn't followed by another `:` opens a named parameter, and `::` is the escape for a literal colon. So the scheme's colon is doubled. Left single, `memhtml:` would register a parameter named `""`.
- A named parameter's value ends at the next `/`, so it matches one segment. Every memory path has at least two segments, and an archived one has at least four. `*` is the only construct that matches across `/`, and the router requires it to be the pattern's last character. The tagged template compiles its holes to named parameters, which is why it isn't used.

The captured value doesn't arrive through the parameter array. `McpServer` folds matched parameters into a positional array by `Number(name)`, and `Number("*")` is `NaN`, so that slot is never filled. Each handler reads its value back out of the URI with `capturedOf` (`apps/mcp/src/resources.ts:68-80`).

`capturedOf` requires the `memhtml://<section>/` prefix verbatim. The router ignores repeated slashes and `capturedOf` doesn't, so `memhtml:///file/x.html` matches the route and is then refused. One `decodeURIComponent` covers both spellings a client can send, so `areas/oncall/x.html` and `areas%2Foncall%2Fx.html` name the same resource.

A URI that matches no template never reaches a handler. Effect answers it with JSON-RPC code `-32002` and the message `Resource '<uri>' not found`.

The RFC 6570 templates that `resources/templates/list` publishes are literals in `RESOURCE_TEMPLATES` (`apps/mcp/src/resources.ts:326`). They aren't composed from the route. So the template a client reads and the route the server matches are two independent readings of one URI shape. The tests expand their request URIs from those templates, so a template that drifts from its route fails a read (`apps/mcp/tests/resources.test.ts:29-46`). Another test checks that the registry publishes exactly that list (`apps/mcp/tests/resources.test.ts:249-257`).

**Every failure is sanitized, and no handler dies.** `tapCause` first logs the real cause to stderr. Then `catchDefect` turns a defect into `ERR_UNKNOWN`, and `toResourceFailure` maps a typed failure (`apps/mcp/src/resources.ts:138-153`). An `Effect.orDie` in their place would hand the client `Cause.prettyErrors(cause)[0].message`, which is an absolute filesystem path for a missing file and a `PathNotFound` without its code or suggestions.

A resource failure is a JSON-RPC error, and a tool result never carries one. `ERR_PATH_NOT_FOUND` maps to `-32602` (`InvalidParams`) and every other code to `-32603` (`InternalError`) (`apps/mcp/src/failure.ts:261-268`). The `message` carries the same `ERR_<CODE>: <reason>. Try: ...` text a tool failure does. A resource read never writes to the tree.

## `memhtml://at/{commit}/{path}`

```ts
export const PinnedResource = templateLayer({
  section: "at",
  uriTemplate: "memhtml://at/{commit}/{path}",
  name: "Memory file at a commit",
  description: /* … */,
  mimeType: "text/plain",
  refuse: pinnedRefusal,
  read: (uri, captured) =>
    Effect.gen(function* () {
      const at = captured.indexOf("/")
      if (at <= 0) return yield* Effect.fail(pinnedRefusal(uri))
      const commit = captured.slice(0, at)
      const path = captured.slice(at + 1)
      if (!COMMIT_SHA.test(commit) || !isValidMemoryPath(path)) {
        return yield* Effect.fail(pinnedRefusal(uri))
      }

      const store = yield* Store
      const normalized = normalizePath(path)
      const entries = yield* store.git.lsTreeR(commit, [normalized]).pipe(
        Effect.tapError(Effect.logError),
        Effect.catchTag("GitFailure", () => Effect.fail(pinnedRefusal(uri)))
      )
      // `ls-tree -r` over one pathspec returns that blob or nothing. A submodule entry is an
      // `objectType` of `commit` and holds no memory, so it is refused rather than read.
      const blob = entries.find((entry) => entry.path === normalized && entry.objectType === "blob")
      if (blob === undefined) return yield* Effect.fail(pinnedRefusal(uri))

      const bytes = yield* store.git.catFileBatch([blob.sha]).pipe(
        Effect.tapError(Effect.logError),
        Effect.catchTag("GitFailure", () => Effect.fail(pinnedRefusal(uri)))
      )
      const body = bytes.get(blob.sha)
      if (body === undefined) return yield* Effect.fail(pinnedRefusal(uri))

      const doc = yield* parseMemory(new TextDecoder().decode(body))
      return [`# ${doc.title}`, "", doc.article.gist, "", doc.article.bodyText].join("\n")
    })
})
```

Returns one memory's title, claim, and body text as of a commit. It's a citation whose bytes can't move.

**Input:** two holes, captured as one value and split at the first `/`. A commit sha can't contain a slash and a memory path must, so that's the only place the split can fall.

The commit half must match `COMMIT_SHA`, `/^[0-9a-f]{7,64}$/`, which runs from git's abbreviation floor through the width of SHA-256 (`apps/mcp/src/resources.ts:210-222`). That refuses `HEAD`, a branch, and a tag, and the refusal is the contract. A URI whose target can move isn't a citation, and `memhtml://at/main/x.html` would read as a pin while resolving to different bytes next week. Hex also keeps a leading `-` out of `git ls-tree`'s argv.

The path half passes the same `isValidMemoryPath` gate as the file resource, because the captured value accepts `..` (`apps/mcp/src/resources.ts:258-260`).

**Output:** `text/plain`, in the shape `memhtml://file/{path}` returns, parsed from the historical bytes. `lsTreeR` resolves the path in that commit's tree to a blob, and `catFileBatch` reads it. So a path corrected, archived, or evicted since still reads, and a seven-character sha works. A submodule entry has `objectType` `commit`, holds no memory, and is refused.

This read doesn't bump salience, while `memhtml://file/{path}` does. `state.access` is keyed on the path with no notion of a commit, so a bump would credit whatever occupies the path today for a read of a version it may not contain. Verifying a receipt is auditing, and only a chosen open earns salience. The resource reads `Store` and leaves `IndexRecorder` out, which makes that rule structural (`apps/mcp/src/resources.ts:250-256`).

**Failure:** `ERR_PATH_NOT_FOUND` (`-32602`) for an unknown commit, a path absent from a known commit, a movable ref, and an unusable path alike. From a client's side these are one answer, "this URI names nothing here". A `GitFailure` becomes the same refusal, and the real cause goes to stderr. The suggestions name the published template form and `memory_resolve` for the path the memory occupies now (`apps/mcp/src/resources.ts:225-230`). Bytes that don't parse as a memory fail with `ERR_INVALID_MEMORY`, and a defect with `ERR_UNKNOWN`, both `-32603`.

`memory_resolve` publishes a ready-made URI for this template as `pinned_uri`, built by `pinnedUri`, so a client stores a citation without composing one (`apps/mcp/src/resources.ts:319-320`).

Source: `PinnedResource` at `apps/mcp/src/resources.ts:267-306`.

## `memhtml://file/{path}`

```ts
export const FileResource = templateLayer({
  section: "file",
  uriTemplate: "memhtml://file/{path}",
  name: "Memory file",
  description: /* … */,
  mimeType: "text/plain",
  refuse: fileRefusal,
  read: (uri, captured) =>
    Effect.gen(function* () {
      if (!isValidMemoryPath(captured)) return yield* Effect.fail(fileRefusal(uri))
      const result = yield* readMemory(normalizePath(captured))
      return [
        `# ${result.doc.title}`,
        "",
        result.doc.article.gist,
        "",
        result.doc.article.bodyText
      ].join("\n")
    })
})
```

Returns one memory's readable text by path. A client that holds a path from `memory_search` can show a human the file behind an answer without spending a tool call. The captured rest value is what lets a multi-segment path such as `areas/oncall/rollback-order.html` resolve.

**Input:** the whole tail after `memhtml://file/`, as a root-relative path. `isValidMemoryPath` gates it before the store sees it, and that gate is containment (`apps/mcp/src/resources.ts:182-186`). The captured value accepts `/`, so it accepts `../../etc/passwd`, and the store joins a relative path onto the root with no traversal check of its own. The gate refuses any `.` or `..` segment, any path outside the four PARA buckets, and anything that doesn't end in `.html`. An archive path passes, so an archived memory reads here.

**Output:** `text/plain`, an H1 of the title, the gist, then the article's body text, joined by newlines. The body text, `bodyText`, includes `<details>` bodies (`packages/html/src/document.ts:135-139`). The resource returns the body and leaves the raw HTML file out, because a client asking for a citation wants the text a human reads. Head metadata is `memory_read`'s job.

A missing path fails the read, and the resource never answers empty. A citation that silently resolves to nothing is worse than one that says the file is gone.

This read bumps salience through the same `readMemory` that `memory_read` calls (`apps/cli/src/operations.ts:968-975`). The caller named one path, which is a chosen open, so the access plane shouldn't be able to tell the two surfaces apart. A failed bump is logged and doesn't fail the read.

**Failure:** `ERR_PATH_NOT_FOUND` (`-32602`). A path the gate refuses gets the resource's own suggestions, which are the template form, `memory_resolve`, then `memory_search` or `memory_list` (`apps/mcp/src/resources.ts:159-164`). A missing file gets the tool suggestions, which are `memory_resolve`, `memory_search`, then `memory_list`. A file that doesn't parse fails with `ERR_INVALID_MEMORY`, a read error with `ERR_STORAGE`, and a defect with `ERR_UNKNOWN`, all `-32603`.

Source: `FileResource` at `apps/mcp/src/resources.ts:188-208`.

## `memory_archive`

```ts
const MemoryArchive = Tool.make("memory_archive", {
  description: /* … */,
  dependencies: [Store, Indexer],
  parameters: Schema.Struct({
    path: MemoryPath,
    reason: Schema.String
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    archive_path: MemoryPath
  })
})
```

Soft-evicts a memory with a `git mv` into `archive/<YYYY>/` and the archive stamps. Nothing is deleted, and `git log --follow` reads straight through the move.

**Input:** `path`, the memory to evict, and `reason`, both required. `reason` is recorded only in the commit subject, after the path (`packages/store/src/store.ts:1166`). An archive path isn't refused. Archiving one again nests it under a second `archive/<YYYY>/`.

No store policy closes this tool, because it edits a record that already exists.

**Output:** `path`, normalized, and `archive_path`, where the file now lives. The archive path mirrors the original path under the year (`packages/contracts/src/paths.ts:217-218`).

**Failure:**

- `ERR_PATH_NOT_FOUND` when no file is at `path`, found before anything is written (`packages/store/src/store.ts:1151-1153`).
- `ERR_GIT` or `ERR_STORAGE` from the move or the commit. The journal, `compensated`, puts the file back at its original path (`packages/store/src/store.ts:1155-1169`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the archive commit has landed (`apps/cli/src/operations.ts:1118`).

Source: `MemoryArchive` at `apps/mcp/src/tools.ts:877-890`, its handler at `apps/mcp/src/handlers.ts:761-767`, and `archiveMemory` at `apps/cli/src/operations.ts:1112-1120`.

## `memory_correct`

```ts
const MemoryCorrect = Tool.make("memory_correct", {
  description: /* … */,
  dependencies: WRITES(),
  parameters: Schema.Struct({
    target_path: MemoryPath,
    title: Schema.String,
    /** The corrected prose; first sentence becomes the new `<mark>`. Exclusive with `article_html`. */
    body: Optional(Schema.String),
    /** Pre-authored markup for the superseding article, used verbatim. Exclusive with `body`. */
    article_html: Optional(Schema.String),
    reason: Schema.String,
    session_id: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    superseded: Schema.Array(MemoryPath),
    archived: Schema.Array(MemoryPath)
  })
})
```

Supersedes a memory. It writes the corrected version and archives the target in one commit, with links in both directions. The target file is never edited in place, and it stays readable under `archive/`.

**Input:** `target_path`, `title`, and `reason` are required, plus exactly one of `body` or `article_html`, and an optional `session_id`. The handler's `authored` helper enforces the one-of rule, and a blank string counts as absent (`apps/mcp/src/handlers.ts:150-174`). The schema doesn't enforce it. A schema union would publish two near-identical parameter shapes and would name neither branch's problem on a decode failure (`apps/mcp/src/handlers.ts:114-122`).

The correction inherits the target's type, `memoryType`, and nothing else (`apps/cli/src/operations.ts:1065-1067`). It doesn't inherit the workspace, tags, entities, importance, or confidence. `memory_correct` takes no `path`, and the operation passes no placement fields, so placement comes from the type and the new title alone (`apps/cli/src/operations.ts:1070-1083`). A correction of `projects/oncall/x.html` can therefore land in `areas/inbox/`.

A correction never lands at the target's own path. The target is still on disk when `freePathFor` chooses the new path, so a same-title correction in the same directory takes the `-2` suffix (`packages/store/src/store.ts:432-472`). The store's `vacating` exemption covers only an explicit path, and `CorrectParams` has no path to pass (`apps/cli/src/operations.ts:1037-1046`, `packages/store/src/store.ts:1072-1090`).

`reason` is required but not recorded. The store accepts it and uses it nowhere, and `commitSubject` builds the commit subject from the title (`packages/store/src/store.ts:1131`).

The new file gets `memhtml-valid-from` and a `supersedes` link to the target's archive path. The archived target gets `memhtml-superseded-by`, a valid-until stamp, and the archive stamps (`packages/store/src/store.ts:1091-1127`).

The store policy can close this tool, because it creates a record (see [The store policy and the record-creating tools](#the-store-policy-and-the-record-creating-tools)).

**Output:** `path`, the new file, plus `superseded` and `archived`. Each is a one-element array holding the target's archive path, which is where the file lives once the commit lands and what the new file's `supersedes` link points at (`apps/mcp/src/handlers.ts:669-678`).

**Failure:**

- `ERR_SESSION_BOUND`, `ERR_V1_DOOR_CLOSED`, or `ERR_STORE_CONFIG` from `guardV1Door`, before anything else runs (`apps/mcp/src/handlers.ts:658`).
- `ERR_INVALID_MEMORY` before anything is written, for both or neither of `body` and `article_html`, a target that doesn't parse, or markup the render gate, `renderChecked`, refuses (`packages/store/src/store.ts:1062`).
- `ERR_PATH_NOT_FOUND` before anything is written, when the first `readMemory` finds no file at `target_path` (`apps/cli/src/operations.ts:1065`).
- `ERR_GIT` or `ERR_STORAGE` from the move, the write, or the commit. The journal, `compensated`, puts the target back and removes the new file (`packages/store/src/store.ts:1100-1136`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the commit has landed (`apps/cli/src/operations.ts:1087`).

Source: `MemoryCorrect` at `apps/mcp/src/tools.ts:685-706`, its handler at `apps/mcp/src/handlers.ts:655-680`, and `correctMemory` at `apps/cli/src/operations.ts:1062-1090`.

## `memory_link`

```ts
const MemoryLink = Tool.make("memory_link", {
  description: /* … */,
  dependencies: [Store, Indexer],
  parameters: Schema.Struct({
    src_path: MemoryPath,
    rel: MemoryRelSchema,
    dst_path: MemoryPath,
    strength: Optional(Finite)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    ok: Schema.Boolean,
    rel: Schema.String,
    src_path: MemoryPath,
    dst_path: MemoryPath
  })
})
```

Asserts an edge between two memories. The edge is written into the source file's head as a `<link>`, so it survives an index rebuild. Re-linking the same pair commits nothing.

**Input:** `src_path`, `rel`, and `dst_path` are required. `rel` is `MemoryRelSchema`, the nine memory-class rels: `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, and `laterally_related` (`apps/mcp/src/tools.ts:61-62`, `packages/contracts/src/edges.ts:19-29`). A person, provenance, or task rel fails decode with `-32602`.

`strength` is accepted and dropped. The handler never passes it to `linkMemories`, and nothing stores it (`apps/mcp/src/handlers.ts:685`).

No store policy closes this tool, because it edits a record that already exists.

**Output:** `ok`, `rel`, `src_path`, and `dst_path`, with both paths normalized. `ok` is `true` whether or not this call wrote the link. The edge exists either way, and a `false` on a re-link would read as a failure (`apps/mcp/src/handlers.ts:686-694`).

**Failure:**

- `ERR_INVALID_MEMORY` when `src_path` and `dst_path` are the same, or when `requireEndpointClasses` finds a task at either end, before anything is written (`packages/store/src/store.ts:1279-1311`, `packages/store/src/store.ts:1331-1335`).
- `ERR_PATH_NOT_FOUND` when `typeOf` finds no file at either endpoint, before anything is written (`packages/store/src/store.ts:1320-1321`).
- `ERR_GIT` or `ERR_STORAGE` from the write or the commit. The journal, `compensated`, restores the source file's earlier bytes (`packages/store/src/store.ts:1345-1356`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the commit has landed. A re-link makes no commit and skips the reindex (`apps/cli/src/operations.ts:1105-1107`).

Source: `MemoryLink` at `apps/mcp/src/tools.ts:708-725`, its handler at `apps/mcp/src/handlers.ts:682-696`, and `linkMemories` at `apps/cli/src/operations.ts:1099-1109`.

## `memory_list`

```ts
const MemoryList = Tool.make("memory_list", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({
    memory_type: Optional(WritableType),
    workspace: Optional(Schema.String),
    tag: Optional(Schema.String),
    entity: Optional(Schema.String),
    /** `<dl>` facet predicates as `name=value` strings, composing exactly as `memory_search`'s do. */
    facets: Optional(Schema.Array(Schema.String)),
    para: Optional(Schema.Literals(PARA_BUCKETS)),
    limit: Optional(Count),
    cursor: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        memory_type: Schema.String,
        gist: Schema.String,
        workspace: Schema.NullOr(Schema.String),
        para: Schema.String,
        confidence: Finite,
        importance: Count,
        archived: Schema.Boolean,
        updated_at: Schema.String
      })
    ),
    next_cursor: Schema.NullOr(Schema.String)
  })
})
```

Pages through the corpus by facet. `next_cursor` is a keyset on the path, so a page stays correct while a curator archives files (`apps/mcp/src/tools.ts:909`, `apps/cli/src/operations.ts:1624-1631`). It reads the index only.

**Input:** every parameter is optional, and they combine with AND.

- `memory_type`: one of the nine writable types. Tasks are listed like any other type.
- `workspace`: an exact match.
- `tag`: one tag, an exact match.
- `entity`: one `type:name` reference, trimmed and matched case-insensitively, the same spelling `memory_search` accepts (`apps/cli/src/operations.ts:1658-1668`).
- `facets`: `name=value` specs over the article's `<dl>` pairs, composed exactly as `memory_search` composes them. A malformed spec is dropped.
- `para`: one of `projects`, `areas`, `resources`, or `archive` (`packages/contracts/src/types.ts:63`).
- `limit`: clamped to 1..500, default 50 (`apps/cli/src/operations.ts:1634`).
- `cursor`: the previous page's `next_cursor`.

Archived files are never listed. The handler's `listMemories` call doesn't pass `includeArchived`, so the operation always filters on `archived = 0` (`apps/mcp/src/handlers.ts:780-789`, `apps/cli/src/operations.ts:1638`). `para: "archive"` therefore returns an empty page, and every row has `archived: false`.

**Output:** `files`, rows of ten fields in path order, and `next_cursor`, which is `null` on the last page.

**Failure:** `ERR_STORAGE` from the query. Nothing is written.

Source: `MemoryList` at `apps/mcp/src/tools.ts:907-941`, its handler at `apps/mcp/src/handlers.ts:777-806`, and `listMemories` at `apps/cli/src/operations.ts:1631-1726`.

## `memory_neighbors`

```ts
const MemoryNeighbors = Tool.make("memory_neighbors", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({
    path: MemoryPath,
    depth: Optional(Count),
    rels: Optional(Schema.Array(MemoryRelSchema)),
    // …
    limit: Optional(Count)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        /** 1-based distance from the center: 1 or 2, never 0. */
        hop: Count,
        rel: Schema.String,
        // …
        derived: Schema.Boolean
      })
    ),
    // …
    edges: Count,
    // …
    node_limit: Count,
    // …
    dropped_node_count: Count,
    // …
    scan_saturated: Schema.Boolean
  })
})
```

Returns the memory graph around one path, to at most two hops, in both directions. The walk includes machine-mined edges, and each node says whether one reached it.

**Input:**

- `path` is required.
- `depth` is clamped to 1..2, default 1 (`apps/cli/src/operations.ts:1294`).
- `rels` narrows the walk to some of the nine memory rels.
- `limit` caps the distinct paths in `nodes`. It's clamped into 1..200 (`NEIGHBORS_LIMIT`) and never refused, default 200, the same shape `memory_list` and `trace_search` have (`apps/cli/src/operations.ts:1295-1298`).

**Output:** `nodes`, each with `path`, `title`, `hop` (1 or 2, never 0), `rel`, and `derived`, plus four scalars, `edges`, `node_limit`, `dropped_node_count`, and `scan_saturated` (`apps/mcp/src/handlers.ts:716-722`). Each path appears once, at its minimal hop, and `rel` is the rel of an edge at that hop.

`derived` is true when a machine-mined edge reaches the node and false when only authored `<link>` edges do. It's the max over every edge that reached the node, and `rel` doesn't pair with it. The question a caller asks of it is whether the connection may be a machine's suspicion, and one mined route is enough for yes (`apps/mcp/src/tools.ts:756-768`).

Nothing in this tree mines an edge. A mined edge lives only in the index, as an `edges` row with `derived = 1` (`packages/index/migrations/0004_edges.sql:1-4`). An index rebuild deletes every `edges` row (`packages/index/src/schema-const.ts:51-60`), and reindexing a file deletes the edges it sources (`packages/index/src/indexer.ts:741`). So `derived` is false on an index built at this tree. It's true only for a mined row that an older build left in an index nobody has rebuilt since.

**`edges` counts edges, and nodes are a separate count.** It counts the distinct edges the walk enumerated, keyed on `(src, rel, dst)`, over both hops and both directions. Two memories joined by two rels are one node and two edges. An edge to a path the node clamp dropped is counted here and absent from `nodes`. Its scope is this call's walk. `memory_status.edges` is the corpus total.

**Two markers report truncation, because the recoveries differ.** `dropped_node_count` is the distinct paths the walk reached that `node_limit` turned away. `nodes.length + dropped_node_count` is every path the walk found, and a larger `limit` returns them. `scan_saturated` means the walk stopped at its own 10,000-edge-row cap, `NEIGHBORS_SCAN_LIMIT` (`apps/cli/src/operations.ts:1189`). Edges past the cap were never enumerated, and no `limit` recovers them. Narrow with `rels` or `depth: 1` instead. It's a plain boolean, because an absent marker can't be told from a server that doesn't report saturation.

`node_limit` echoes the server's clamp of the caller's ask, so a client that sent 10000 reads back 200. It's named `node_limit` because the answer carries two bounds. This one governs `nodes`, and the scan cap governs everything. `dropped_node_count` carries `_count` because it's a quantity, and this repo's numeric suffixes aren't interchangeable. `edges` keeps its bare name because clients already branch on it (`apps/mcp/src/tools.ts:781-804`).

A center the tree doesn't hold isn't an error, and the walk never checks it against `files`. It matches the center against `edges` only (`apps/cli/src/operations.ts:1219-1228`). With no edge naming it, the neighborhood is empty. Edges carry no foreign key on either endpoint (`packages/index/migrations/0004_edges.sql:6-7`), so an authored edge that still names a deleted center returns its other endpoint when that file exists. Only the returned node is joined to `files`. So archived files appear as nodes, and an edge whose far endpoint the tree doesn't hold contributes nothing (`apps/cli/src/operations.ts:1247-1253`).

**Failure:** `ERR_STORAGE` from the query. Nothing is written.

Source: `MemoryNeighbors` at `apps/mcp/src/tools.ts:727-816`, its handler at `apps/mcp/src/handlers.ts:698-724`, and `neighborsOf` at `apps/cli/src/operations.ts:1290-1384`.

## `memory_read`

```ts
const MemoryRead = Tool.make("memory_read", {
  description: /* … */,
  // …
  dependencies: [Store, IndexRecorder, DatabaseService],
  parameters: Schema.Struct({
    path: MemoryPath,
    session_id: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    title: Schema.String,
    body: Schema.String,
    gist: Schema.String,
    memory_type: Schema.String,
    meta: Schema.Record(Schema.String, Schema.String),
    links: Schema.Array(Schema.Struct({ rel: Schema.String, href: Schema.String })),
    archived: Schema.Boolean,
    warnings: Schema.Array(Schema.String)
  })
})
```

Reads one memory in full, with head metadata, authored links, and the whole article body, `<details>` bodies included. Recall never quotes a `<details>` body.

**Input:** `path` is required and `session_id` optional. A leading slash is dropped. With `session_id`, the read also records a `read` session link.

An explicit open counts as salience. `readMemory` reaches the state plane through `bumpAccess`, so the tool declares `DatabaseService`, and the dependency list shows that rule (`apps/mcp/src/tools.ts:520-526`). A search or recall hit doesn't move the plane. The read takes the file from the working tree and never asks the head server.

**Output:** nine fields.

- `meta` is a flat `Record<string, string>` of the head's metas under camelCase keys, such as `memoryType`, `status`, `createdAt`, `contentHash`, and `validFrom`. Each entity adds an `entity:<ref>` key and each tag a `tag:<tag>` key, both set to `"true"` (`apps/mcp/src/handlers.ts:89-98`). Numbers arrive as strings, because that's what a `<meta content>` attribute holds.
- `meta` is open. The head's optional metas are open at the edges, and a client bound to a closed set would break on the first addition.
- `links` carries `rel` and `href` for each authored link. An `href` keeps its leading slash.
- `archived` is true when the head's status is `archived` (`apps/mcp/src/handlers.ts:551`).
- `warnings` carries the parser's warnings.

**Failure:** `ERR_PATH_NOT_FOUND` when no file is at `path`, `ERR_INVALID_MEMORY` when the file doesn't parse as a memory, and `ERR_STORAGE` on another read error, from `readRaw`, `parseMemory`, and `readFileOrNull` (`packages/store/src/store.ts:1037-1043`, `packages/store/src/layout.ts:161-176`). Nothing is written. The access bump and the session link swallow their own failures (`apps/cli/src/operations.ts:1017-1035`).

Source: `MemoryRead` at `apps/mcp/src/tools.ts:517-543`, its handler at `apps/mcp/src/handlers.ts:539-555`, and `readMemory` at `apps/cli/src/operations.ts:968-975`.

## `memory_recall`

```ts
const MemoryRecall = Tool.make("memory_recall", {
  description: /* … */,
  dependencies: RETRIEVES(),
  parameters: Schema.Struct({
    query: Schema.String,
    budget_chars: Optional(Count),
    workspace: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    sections: Schema.Struct({
      arcs: Schema.Array(
        Schema.Struct({
          path: MemoryPath,
          title: Schema.String,
          gist: Schema.String,
          body: Schema.String
        })
      ),
      memories: Schema.Array(
        Schema.Struct({
          path: MemoryPath,
          title: Schema.String,
          gist: Schema.String,
          body: Schema.String
        })
      ),
      /** What did not fit: claim plus path, for a deliberate drill-down. */
      lateral: Schema.Array(
        Schema.Struct({ path: MemoryPath, title: Schema.String, gist: Schema.String })
      )
    }),
    spent_chars: Count,
    truncated: Schema.Boolean,
    degraded: Schema.Boolean,
    /** The same ratio `memory_search` reports, for the same reason. */
    vector_coverage: Finite
  })
})
```

Returns a context pack under a character budget. What fits is quoted, and what doesn't gets one index line. Arcs are folded under their own envelope, so a synthesis can't crowd out the evidence behind it.

The call asks the head server first and falls back to the index (see [Search and recall on the head server](#search-and-recall-on-the-head-server)). `RETRIEVES` declares `Roots` for the socket path, and the tool still can't reach the store (`apps/mcp/src/tools.ts:132-134`).

**Input:** `query` is required. `budget_chars` defaults to 16,000, `MEMORY_BODY_BUDGET`, and isn't clamped (`packages/index/src/disclosure.ts:23`, `packages/index/src/retrieval.ts:602`). It governs ordinary memories only. `budgetFor` always gives arcs a 9,000-character envelope, `ARC_BODY_BUDGET` (`packages/index/src/disclosure.ts:20`, `packages/index/src/retrieval.ts:635-638`). A budget of 0 or less quotes no ordinary memory. `workspace` is the only scope, and tasks are excluded as in search's default scope.

**Output:** `sections` with three arrays, plus `spent_chars`, `truncated`, `degraded`, and `vector_coverage`.

- `arcs` and `memories` hold the quoted entries. A quote's `body` is the memory's disclosure text, one line each for the `<mark>` claim, each `<summary>` text, each `<dl>` pair as `name: value`, and each citation's text (`packages/index/src/project.ts:74-83`). The article's prose and its `<details>` bodies stay out. `memory_read` returns those.
- At most two memories are quoted per entity name, and the rest become index lines (`packages/index/src/disclosure.ts:25-32`).
- `lateral` is the union of both folds' index lines. It holds what didn't fit the budget, and no third retrieval arm feeds it. Dropping it would make a truncated pack look like a small corpus (`apps/mcp/src/handlers.ts:620-645`).
- `truncated` is true when anything became an index line. `degraded` and `vector_coverage` mean what they mean on `memory_search`, on the path that answered.

The pool is the top 30 fused candidates on either path (`packages/index/src/retrieval.ts:605-610`). Recall doesn't bump salience.

**Failure:** `ERR_STORAGE` from the index query. An embedder failure degrades the pack instead of failing it, in `queryVector` on the index path and on the server's side through the head (`packages/index/src/retrieval.ts:266-280`). A head server that gives no answer sends the call to the index. Nothing is written.

Source: `MemoryRecall` at `apps/mcp/src/tools.ts:644-683`, its handler at `apps/mcp/src/handlers.ts:609-653`, `recallMemories` at `apps/cli/src/operations.ts:1011-1015`, and `recallOnHead` at `apps/cli/src/head-retrieval.ts:172-214`.

## `memory_reinforce`

```ts
const MemoryReinforce = Tool.make("memory_reinforce", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({
    paths: Schema.Array(MemoryPath),
    signal: Schema.Literals(REINFORCE_SIGNALS)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    bumped: Schema.Array(MemoryPath),
    cooled_down: Schema.Array(MemoryPath)
  })
})
```

Records that a memory helped or misled. A per-path cooldown gates the signal, so a replayed query can't inflate a memory's ranking.

**Input:** `paths`, an array of memory paths, and `signal`, one of `positive`, `negative`, or `neutral` (`packages/domain/src/reinforce.ts:31`). Paths are deduplicated, and empty strings are dropped. They're used as given. They aren't normalized or checked for existence, so an unknown path gets an access row of its own (`packages/index/src/reinforce.ts:77`).

No store policy closes this tool, because it edits state about records that already exist.

**Output:** `bumped`, the paths whose signal landed, and `cooled_down`, the paths the cooldown held back (`apps/mcp/src/handlers.ts:769-775`).

The cooldown is 900 seconds per path, `REINFORCE_COOLDOWN_S` (`packages/domain/src/ranking.ts:24`). It's keyed on `last_accessed_at`, the last access of any kind, which may be a read and not a reinforcement (`packages/index/src/reinforce.ts:100-109`). A `memory_read` or a file-resource read stamps that time. So a reinforce within 900 seconds of reading the same path lands in `cooled_down`, even though `memory_search`'s description says to read the chosen hit and then reinforce it.

`neutral` counts an access only. `positive` and `negative` also count a reinforcement and move the memory's outcome score. The salience these signals feed ranks only on the index path, because the head has no salience arm.

Nothing is committed to git. The signal lives in the state database. The `reinforced` session-link kind exists, but no tool records it (`packages/index/src/traces-persist.ts:79`).

**Failure:** `ERR_STORAGE` from the upsert. Nothing is committed.

Source: `MemoryReinforce` at `apps/mcp/src/tools.ts:892-905`, its handler at `apps/mcp/src/handlers.ts:769-775`, and `reinforceMemories` at `apps/cli/src/operations.ts:1123-1133`.

## `memory_resolve`

```ts
const MemoryResolve = Tool.make("memory_resolve", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({ path: MemoryPath }),
  failure: ToolFailure,
  success: Schema.Struct({
    /** The path asked about, normalized, so an answer can be matched back to the receipt. */
    requested: MemoryPath,
    /** Where the walk ended. What that MEANS is `stop_reason`'s, not this field's. */
    path: MemoryPath,
    /** Hops taken, equal to `steps.length`. A quantity, `0` when the path needed no walk. */
    hops: Count,
    steps: Schema.Array(
      Schema.Struct({
        from: MemoryPath,
        to: MemoryPath,
        // …
        via: Schema.Literals(RESOLVE_STEP_VIA)
      })
    ),
    /** Why the walk stopped, from the five values the operation declares. Only `live` is citable. */
    stop_reason: Schema.Literals(RESOLVE_STOP_REASONS),
    /** The title at `path`, or null when the index holds no row for it. */
    title: Schema.NullOr(Schema.String),
    // …
    indexed_commit: Schema.NullOr(Schema.String),
    // …
    pinned_uri: Schema.NullOr(Schema.String)
  })
})
```

Follows a path that an older answer, receipt, or external citation recorded forward to the memory that carries the fact now. A path is the id of a memory and is derived from the title. So a correction that rewords the title moves the file, and the cited path stops resolving through no fault of the citation.

**Input:** `path` only. The walk follows both mechanisms that move a memory, and neither is optional. The hop bound, `RESOLVE_MAX_HOPS` (16), is a property of the answer and a caller can't change it (`apps/cli/src/operations.ts:1394`).

**Output:**

- `requested` echoes the normalized path. `path` is where the walk ended, and `hops` equals `steps.length`.
- `stop_reason` decides whether the answer is citable, and only `live` means yes. The five values are `RESOLVE_STOP_REASONS`: `live`, `archived`, `unindexed`, `cycle`, and `hop_limit` (`apps/cli/src/operations.ts:1419`).
- `archived` is a memory evicted with no correction, so nothing supersedes it.
- `unindexed` is no such path in the index. It can also mean the index doesn't yet describe the commit that holds the path. `indexed_commit` names the commit it does describe.
- `cycle` is two memories each claiming to supersede the other, an authoring defect.
- `hop_limit` means `path` is where the walk stopped and the chain may go on, so resolving it again continues.
- `steps` names each hop's mechanism from a closed vocabulary, `RESOLVE_STEP_VIA`. `supersedes` is an authored `<link>`, and `archive_move` is a `git mv` recorded by `origin_path` (`apps/cli/src/operations.ts:1429`). Every node is named by the path holding that memory now, because a `supersedes` link travels with the file that carries it.
- `title` is the title at `path`, or `null` when the index has no row for it.
- `indexed_commit` is the commit the index describes, or `null` before the first rebuild.
- `pinned_uri` is a `memhtml://at/{commit}/{path}` URI for `path` at `indexed_commit`. The server composes it with `pinnedUri`, because the URI's spelling belongs to the resource that routes it. It's `null` when there's no commit to pin to, and when `stop_reason` is `unindexed`, the one ending whose path that commit doesn't hold (`apps/mcp/src/handlers.ts:745-757`).

A correction moves a memory in two hops, an `archive_move` from the cited path to its archive path, then a `supersedes` hop to the new file. For example, `areas/inbox/drain-order.html` resolves through `archive/2026/areas/inbox/drain-order.html` to `areas/inbox/drain-order-2.html`.

`hops: 0` with `stop_reason: live` doesn't mean the bytes are unchanged. A correction always lands at a new path (see `memory_correct`), but other writes, such as `memory_link`, rewrite a file in place. `pinned_uri` is the grain that pins bytes.

The walk reads the index, so a record a session committed after the last `memhtml index update` resolves as `unindexed` until the next one.

**Failure:** `ERR_STORAGE` from the index reads. An unknown path is `stop_reason: unindexed` and never an error. Nothing is written.

Source: `MemoryResolve` at `apps/mcp/src/tools.ts:818-875`, its handler at `apps/mcp/src/handlers.ts:726-759`, and `resolveMemory` at `apps/cli/src/operations.ts:1539-1604`.

## `memory_search`

```ts
const MemorySearch = Tool.make("memory_search", {
  description: /* … */,
  dependencies: RETRIEVES(),
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Optional(Count),
    memory_types: Optional(Schema.Array(WritableType)),
    workspace: Optional(Schema.String),
    tags: Optional(Schema.Array(Schema.String)),
    // …
    entity: Optional(Schema.String),
    // …
    facets: Optional(Schema.Array(Schema.String)),
    include_archived: Optional(Schema.Boolean),
    // …
    as_of: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        gist: Schema.String,
        memory_type: Schema.String,
        /** The fused RRF score. Unitless and comparable only within one result set. */
        score: Finite,
        confidence: Finite,
        updated_at: Schema.String,
        // …
        snippet: Schema.String,
        // …
        entities: Schema.Array(Schema.String),
        // …
        superseded_by: Schema.NullOr(Schema.String)
      })
    ),
    degraded: Schema.Boolean,
    // …
    vector_coverage: Finite,
    arms: Schema.Array(Schema.String),
    /** The `entity` this search was scoped to, or `null` when it was not scoped by entity. */
    entity_scope: Schema.NullOr(Schema.String),
    // …
    scope_empty: Schema.Boolean,
    // …
    archived_matches: Finite,
    /** Up to `limit` of those archived paths, sorted, each with what superseded it or `null`. */
    archived: Schema.Array(
      Schema.Struct({ path: Schema.String, superseded_by: Schema.NullOr(Schema.String) })
    )
  })
})
```

Runs ranked search over the corpus. The call asks the head server first and falls back to the index (see [Search and recall on the head server](#search-and-recall-on-the-head-server)). On the index path it fuses the lexical, vector, recency, and salience arms with RRF, then diversifies the result. Through the head it fuses the lexical and vector arms, with recency as the tie-break. `RETRIEVES` declares `Roots` for the socket path, and the tool still can't reach the store (`apps/mcp/src/tools.ts:132-134`).

**Input:** `query` is required and the rest optional.

- `query` is prose. A double-quoted span demands those words in that order, and nothing else is syntax (`apps/mcp/src/tools.ts:547`). A quoted span sends the call to the index.
- `limit` defaults to 10 and isn't clamped (`packages/index/src/retrieval.ts:47`, `packages/index/src/retrieval.ts:508`). A limit of 0 or less returns no hits.
- `memory_types` draws from the nine writable types. An explicit list is honored verbatim, `task` included. Without one, tasks are excluded (`packages/index/src/scope.ts:262-280`).
- `workspace` is an exact match, and `tags` matches a memory that carries any of the tags.
- `entity` takes one reference in `type:name` form, matched case-insensitively. It's the spelling `memory_list` accepts and the spelling a hit's `entities` publishes, so an agent chains by copying a value it already holds (`apps/mcp/src/tools.ts:556-560`).
- `facets` takes `name=value` specs over the article's authored `<dl>` pairs (`apps/mcp/src/tools.ts:285-290`). Values under the same name broaden (OR), and different names narrow (AND). So `["doc-type=runbook", "doc-type=guide"]` is either, and `["doc-type=runbook", "tier=1"]` is both. A caller who read it the other way round acts on a superset or an empty set, and the rows report neither.
- A facet matches on its text with no case folding, unlike `entity`, because a facet is the consumer's own machine-written vocabulary.
- A facet spec with an empty half is dropped and never refused. So a malformed spec widens the answer instead of narrowing it, and the rows can't show that either (`packages/index/src/scope.ts:57-63`).
- `include_archived` admits archived memories, and it sends the call to the index.
- `as_of` is a point-in-time view over `coalesce(valid_from, event_at, created_at) <= as_of < valid_until`, including since-superseded memories (`apps/mcp/src/tools.ts:567-573`). In the scope, `asOf` replaces the archived filter, so `include_archived` has no effect beside it (`packages/index/src/scope.ts:246-260`). The value is compared as text and not validated. A non-empty `as_of` sends the call to the index.

**Output:** `hits` plus seven result-level fields.

- Each hit's `score` is unitless and comparable only within one result set. The schema calls it the fused RRF score. On the index path it's the polarity step's reciprocal-rank score over the fused order (`packages/index/src/retrieval.ts:519-539`), and through the head it's the fused RRF score itself.
- `snippet` holds the best-matching chunk's text for this query, or the opening chunk when the vector arm didn't fire, ending in `…` when cut. Through the head it's always the opening chunk.
- `entities` lists the hit's references in `type:name` form, sorted.
- `superseded_by` is present and nullable, and non-null only for an archived hit. A client can tell "not superseded" from "this build doesn't report supersession" (`apps/mcp/src/tools.ts:599-606`).
- `degraded` is true when the vector arm didn't fire.
- `vector_coverage` is the share of indexed chunks carrying a vector, 0 to 1, and it tells the two causes of `degraded` apart (`apps/mcp/src/tools.ts:610-616`). Below the coverage floor, `gatedQueryVector` drops the arm on purpose, because a few embedded files would outrank every exact match. A high value with `degraded: true` means the embedder failed (`packages/index/src/retrieval.ts:308-320`). Through the head it's the share of active records with a vector in the server's cache, and no floor applies.
- `arms` names the arms that ran, and `entity_scope` echoes the `entity` scope or `null`.
- `scope_empty` is true when a named scope narrowed the query and nothing survived. The tool reports a scope it couldn't satisfy and never widens it (`scopeEmpty`, `packages/index/src/retrieval.ts:549`).
- `archived_matches` and `archived` are the pointer behind an empty scope. When `scope_empty` is true and `as_of` is absent, they count and list the archived memories the same scope matches, up to `limit` and at least one, each with the path that superseded it or `null` (`packages/index/src/retrieval.ts:474-498`, `packages/index/src/retrieval.ts:555-558`). Otherwise they're `0` and empty. The head computes the same pointer over its own version (`apps/cli/src/head-scope.ts:183-210`). An agent follows this pointer when an eviction or a collapse moved a record into `archive/`.

Returning a path changes nothing on the access plane, because a hit is the ranker's guess and only a deliberate open counts (`apps/cli/src/operations.ts:982-993`).

**Failure:** `ERR_STORAGE` from the index query. An embedder failure degrades the search instead of failing it, in `queryVector` on the index path and on the server's side through the head (`packages/index/src/retrieval.ts:266-280`). A head server that gives no answer sends the call to the index. Nothing is written.

Source: `MemorySearch` at `apps/mcp/src/tools.ts:545-642`, its handler at `apps/mcp/src/handlers.ts:557-607`, `searchMemories` at `apps/cli/src/operations.ts:994-998`, and `searchOnHead` at `apps/cli/src/head-retrieval.ts:128-165`.

## `memory_status`

```ts
const MemoryStatus = Tool.make("memory_status", {
  description: /* … */,
  // `RetrievalPolicy` because the status names the coverage floor a search degrades at.
  dependencies: [Store, DatabaseService, RetrievalPolicy],
  // …
  parameters: Tool.EmptyParams,
  failure: ToolFailure,
  success: Schema.Struct({
    head_sha: Schema.NullOr(Schema.String),
    dirty: Schema.Boolean,
    counts_by_type: Schema.Record(Schema.String, Count),
    archived_count: Count,
    edges: Count,
    /** True when the index's watermark IS the current HEAD. A row count cannot answer this. */
    index_fresh: Schema.Boolean,
    embedder_up: Schema.Boolean,
    // …
    vector_coverage: Finite,
    vector_coverage_floor: Finite
  })
})
```

Reports corpus health in one call. It returns HEAD, dirty state, counts by type, edge totals, whether the index describes the current commit, and how much of the index the vector arm can see. It reads the git root and the index, and it doesn't ask the head server.

**Input:** none. `parameters` is `Tool.EmptyParams`, which publishes `{"type":"object","additionalProperties":false}` and refuses any key with `-32602`. An empty `Schema.Struct({})` wouldn't publish "an object with no fields". At 4.0.5 it derives `{"not":{"type":"null"}}`. The source comment records rc.109's derivation, an `anyOf` with an array branch (`apps/mcp/src/tools.ts:997-1007`).

**Output:** nine fields.

- `head_sha` is `null` on an unborn repository.
- `dirty` is true when `git status` lists any path that isn't ignored.
- `counts_by_type` counts the active indexed files by type, `archived_count` the archived ones, and `edges` every edge in the corpus.
- `index_fresh` is true when the index's watermark is the current HEAD, which a row count can't answer. While the operation's `indexFresh` is false, every call also logs a warning to stderr (`apps/cli/src/operations.ts:2526-2531`). A session commit moves HEAD and leaves the index behind, so the flag reads false after one until the next `memhtml index update`.
- `embedder_up` reads the index and never probes the live embedder. The operation's `embedderUp` is true when the stored vector space matches the configured one and at least one embedding exists, so it can be true at 2 percent coverage (`apps/cli/src/operations.ts:2551`).
- `vector_coverage` is the share of chunks with a vector in the configured space, and `1` on an empty index. `vector_coverage_floor` is the floor below which `memory_search` drops the vector arm on the index path (`apps/mcp/src/tools.ts:1018-1024`).

**Failure:** `ERR_GIT` from `rev-parse` or `status`, and `ERR_STORAGE` from a count statement (`apps/cli/src/operations.ts:2495-2510`). Nothing is written.

The suggestions for `GitFailure` and `StorageFailure`, the tags behind `ERR_GIT` and `ERR_STORAGE`, point an agent at this tool (`apps/mcp/src/failure.ts:119-125`). The `DirtyTree` arm does too, but no tool raises `ERR_DIRTY_TREE`.

Source: `MemoryStatus` at `apps/mcp/src/tools.ts:992-1026`, its handler at `apps/mcp/src/handlers.ts:851-867`, and `statusReport` at `apps/cli/src/operations.ts:2489-2556`.

## `memory_write`

```ts
const MemoryWrite = Tool.make("memory_write", {
  description: /* … */,
  dependencies: WRITES(),
  parameters: Schema.Struct(writeFields()),
  failure: ToolFailure,
  success: Schema.Struct({
    path: MemoryPath,
    created: Schema.Boolean,
    deduped: Schema.Boolean,
    existing_path: Schema.NullOr(MemoryPath)
  })
})
```

Writes one memory. When an active memory already holds this exact content, the call returns that path with `deduped: true` and creates no file and no commit.

**Input:** `Schema.Struct(writeFields())`, fourteen fields that `writeFields` shares with each `memory_write_batch` op (`apps/mcp/src/tools.ts:305-338`).

- `title` and `memory_type` are required. `memory_type` is one of the nine writable types: `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, and `task` (`packages/contracts/src/types.ts:38-40`). `arc` fails decode against `WritableType`, because only the system writes an arc (`apps/mcp/src/tools.ts:58-59`, `packages/contracts/src/types.ts:34-37`).
- Exactly one of `body` or `article_html` is required. The handler enforces the rule and the schema doesn't, and a blank string counts as absent (`apps/mcp/src/handlers.ts:150-174`).
- On the prose path, `body`'s first sentence becomes the `<mark>` claim and each blank-line paragraph becomes one `<p>`.
- On the markup path, the caller owns the format. That means one `<mark>` inside the first `<p>` or `<li>`, the closed element vocabulary, and no `class`, `style`, or `<script>`. The first `<time datetime>` becomes the event time the recency arm ranks by (`apps/mcp/src/tools.ts:154-165`).
- The rest are optional: `path`, `strict_path`, `workspace`, `tags`, `entities`, `importance`, `confidence`, `session_id`, `prompt_id`, and `turn_uuid`.

Without `path`, the directory comes from the type, the workspace, and the first non-blank tag, and the filename from the title (`packages/contracts/src/paths.ts:148-187`). A task files under its workspace's `tasks/` or the inbox's. Any other memory with a workspace files under `projects/<workspace>/`. A `semantic`, `procedural`, or `precedent` memory with a tag files under `resources/<tag>/`. Everything else lands in `areas/inbox/`. No rule files a memory under `resources/people/`. A taken filename gets a `-2`, `-3`, and so on.

An explicit `path` has two surprising branches (`apps/mcp/src/tools.ts:187-192`).

- An unusable `path` is ignored, and the placement rule decides instead, so the memory lands somewhere the caller didn't name. `strict_path: true` turns that into `ERR_INVALID_MEMORY`, with nothing written, staged, or committed. It governs only a `path` that was sent.
- An occupied `path` is refused with `ERR_WRITE_CONFLICT`, and nothing is written. An explicit path gets no `-2` suffix, because the caller named one path. To replace what a memory says, call `memory_correct`.

A `path` in the `archive` bucket is accepted. The index derives `archived` from the bucket, so such a memory is archived from the start, and default search and list skip it (`packages/index/src/project.ts:150-151`).

`importance` and `confidence` are written into the head unchecked. A value outside 1..10 or 0..1 is dropped when the file is parsed, and the index falls back to importance 5 and confidence 1.0 (`packages/html/src/parse.ts:130-131`, `packages/index/src/project.ts:166-167`).

`memory_write` runs no entity extraction. Only `memory_write_batch` does. With `session_id`, the call records a `wrote` session link, on a dedupe too (`apps/cli/src/operations.ts:350-351`).

The write commits straight to the store and skips the session write bar, so the store policy can close this tool (see [The store policy and the record-creating tools](#the-store-policy-and-the-record-creating-tools)).

**Output:** `path`, `created`, `deduped`, and `existing_path`. On a dedupe, `path` and `existing_path` both name the stored memory and `created` is false. `existing_path` is present and nullable, so a client can tell "this write didn't dedupe" from "this server doesn't report dedupes" (`apps/mcp/src/tools.ts:377-381`).

**Failure:**

- `ERR_SESSION_BOUND`, `ERR_V1_DOOR_CLOSED`, or `ERR_STORE_CONFIG` from `guardV1Door`, before anything else runs (`apps/mcp/src/handlers.ts:338`).
- `ERR_INVALID_MEMORY` before anything is written, for both or neither of `body` and `article_html`, a `strict_path` refusal from `strictPathRefusal`, or markup `renderChecked` refuses (`packages/store/src/store.ts:722-727`).
- `ERR_WRITE_CONFLICT` before anything is written, when an explicit `path` is taken. The message reads `ours , theirs <sha>`. `ours` is empty because the write had no base, and `theirs` is the blob now at the path (`packages/store/src/store.ts:445-456`). Its suggestions say to retry, but a retry at the same path conflicts again.
- `ERR_STORAGE` before anything is written, when the checkout lock stays held for 15 s, the dedupe lookup fails, or a title has used up 1,000 filename ordinals, reported as `write.pathExhausted` (`packages/store/src/store.ts:462-471`).
- `ERR_GIT` or `ERR_STORAGE` from the write, the stage, or the commit. The journal, `compensated`, removes the file (`packages/store/src/store.ts:756-773`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the commit has landed (`apps/cli/src/operations.ts:350`). A blind retry can then write a second copy. See [What a failed write leaves behind](#what-a-failed-write-leaves-behind).

Source: `MemoryWrite` at `apps/mcp/src/tools.ts:340-357`, its handler at `apps/mcp/src/handlers.ts:335-364`, and `writeMemory` at `apps/cli/src/operations.ts:344-353`.

## `memory_write_batch`

```ts
const MemoryWriteBatch = Tool.make("memory_write_batch", {
  description: /* … */,
  dependencies: WRITES(),
  parameters: Schema.Struct({
    ops: Schema.Array(BatchOp),
    /** Best-effort mode: a refused op is reported and skipped, survivors land in the one commit. */
    continue_on_error: Optional(Schema.Boolean),
    // …
    detect_conflicts: Optional(Schema.Boolean),
    // …
    detect_near_duplicates: Optional(Schema.Boolean),
    // …
    session_id: Optional(Schema.String),
    prompt_id: Optional(Schema.String),
    turn_uuid: Optional(Schema.String)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    results: Schema.Array(BatchOpResult),
    /** Derived from `results` in one pass, so the counts cannot disagree with the array. */
    summary: Schema.Struct({
      total: Count,
      written: Count,
      deduped: Count,
      failed: Count,
      skipped: Count
    }),
    commit_sha: Schema.NullOr(Schema.String),
    // …
    near_duplicates_degraded: Schema.Boolean
  })
})
```

Writes many memories in one commit. It validates every op first, stages every surviving file, then commits and reindexes once.

**Input:**

- `ops` is an array of `BatchOp`, which is `Schema.Struct(writeFields())`. That's the same fourteen fields as `memory_write`, with the same one-of rule for `body` and `article_html` (`apps/mcp/src/tools.ts:370`). Both tools read one field record, so adding a field can't leave the two published schemas disagreeing (`apps/mcp/src/tools.ts:292-304`).
- `continue_on_error` switches from the atomic default to best-effort.
- `detect_conflicts` adds a per-op `conflict` field and changes nothing about what is written (`apps/mcp/src/tools.ts:237-246`).
- `detect_near_duplicates` adds a per-op `near_duplicates` list, the vector sibling of the conflict rule, which catches rewordings that rule can't key. It also changes nothing written, and it costs one embedding call per batch (`apps/mcp/src/tools.ts:261-267`).
- `session_id`, `prompt_id`, and `turn_uuid` are batch-level provenance.

Provenance has two homes. In `provenanceOf`, an op's own values win for its file's head, and the commit trailers come from the first op that carries provenance (`apps/cli/src/operations.ts:902-907`, `packages/store/src/store.ts:1007-1012`). The `wrote` session link uses only the batch-level `session_id`, so an op's own `session_id` never reaches `trace_links` (`apps/cli/src/operations.ts:879`).

When entity extraction is on, one model call per batch extracts entities the ops didn't declare. They land in the files as if authored. A failed extraction is a logged warning, and the batch is written without them (`apps/cli/src/operations.ts:820-854`).

The batch commits straight to the store and skips the session write bar, so the store policy can close this tool. The handler checks once, before it looks at any op, and a closed door refuses the whole call in either mode (`apps/mcp/src/handlers.ts:405-406`).

**Output:** `results`, `summary`, `commit_sha`, and `near_duplicates_degraded`.

- `results` holds one `BatchOpResult` per op, in input order. Each has `index`, `ok`, `path`, `deduped`, `existing_path`, `code`, `error`, `skipped`, `conflict`, and `near_duplicates`. Every nullable field is present and never optional, so an absent key never has to be read as a negative answer (`apps/mcp/src/tools.ts:373-444`).
- `conflict` names what the op's claim contradicts. It carries `path` for a stored active memory, or `batch_index` for an earlier op in the same call, plus that other claim's text.
- `near_duplicates` lists what the op's text matches at or above cosine 0.92. Each entry carries `path` or `batch_index`, the measured `similarity`, and the other `claim`.
- `near_duplicates` is `null` when the flag was off, when nothing matched, on an `article_html` op, and whenever `near_duplicates_degraded` is true. That flag means the assist couldn't run, for example under `MEMHTML_EMBED=off`, so `null` then means unchecked.
- The handler translates each `batch_index`, on `conflict` and on every `near_duplicates` entry, from the survivor positions `batchWrite` saw back into the caller's op indices. So an op refused earlier in the batch can't make a pointer name the wrong op (`apps/mcp/src/handlers.ts:489-520`).
- `summary` is derived from `results` in one pass, so the counts can't disagree with the array (`apps/mcp/src/handlers.ts:291-314`).
- `commit_sha` is `null` when nothing was written. That covers an empty `ops`, an all-deduped batch, and a continue-mode batch in which every op failed.

**Failure:** an atomic batch aborts on its first refused op and reaches the caller through the error channel, and `results` never carries it. The message names the op: `ERR_<CODE>: ops[N]: <reason>. The batch is atomic, so nothing was written and no commit was made. Try: fix ops[N] and call memory_write_batch again; set continue_on_error to true to write the ops that would have succeeded` (`apps/mcp/src/failure.ts:298-311`). The code is the op's own, so the batch and the singular report one refusal under one code.

- `ERR_SESSION_BOUND`, `ERR_V1_DOOR_CLOSED`, or `ERR_STORE_CONFIG` from `guardV1Door`, before any op is read. These carry no `ops[N]`.
- `ERR_INVALID_MEMORY` for a one-of violation, a `strict_path` refusal, or markup the render gate refuses. `ERR_WRITE_CONFLICT` for a taken explicit path, including one an earlier op in the same batch claimed. All are found before anything is written, by the handler and by `validateOp` (`apps/mcp/src/handlers.ts:413-471`, `packages/store/src/store.ts:937-980`).
- In continue mode, the same refusals become failed results carrying their own `code` and `error`, and the survivors land in the one commit.
- `ERR_GIT` or `ERR_STORAGE` from the write pass, the stage, or the commit fails the whole call in either mode. The journal, `compensated`, restores every path the pass reached (`packages/store/src/store.ts:991-1014`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the batch commit has landed (`apps/cli/src/operations.ts:878`).

Source: `MemoryWriteBatch` at `apps/mcp/src/tools.ts:446-515`, its handler at `apps/mcp/src/handlers.ts:402-537`, and `batchWrite` at `apps/cli/src/operations.ts:746-893`.

## `trace_links`

```ts
const TraceLinks = Tool.make("trace_links", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({
    session_id: Optional(Schema.String),
    path: Optional(MemoryPath)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    links: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        session_id: Schema.String,
        prompt_id: Schema.NullOr(Schema.String),
        turn_uuid: Schema.NullOr(Schema.String),
        link_kind: Schema.String,
        at: Schema.String
      })
    )
  })
})
```

Returns which memories a session produced, or which sessions touched a memory. A session here is a `session_id` an agent passed to a tool call. A v2 session's commit records its id in a `Memhtml-Session:` commit trailer, and this table never sees it.

**Input:** `session_id` and `path`, both optional, but at least one is required. Both together narrow with AND. A call with neither is refused, so no call answers with every link ever recorded.

**Output:** `links`, newest first, capped at 500, `TRACE_LINKS_LIMIT` (`apps/cli/src/operations.ts:2412`). Each row carries `path`, `session_id`, `prompt_id`, `turn_uuid`, `link_kind`, and `at`, with `prompt_id` and `turn_uuid` nullable (`apps/mcp/src/handlers.ts:838-847`).

A link is recorded only when a call carries a `session_id`. `memory_write` and `memory_write_batch` record `wrote`, `memory_read` records `read`, and `memory_correct` records `corrected`. A failed link is logged and never fails the call (`apps/cli/src/operations.ts:201-218`). `memory_link`, `memory_archive`, `memory_reinforce`, and the resources record none.

**Failure:** `ERR_INVALID_MEMORY`, an `InvalidMemory` reading "trace links needs a session_id or a path", when both are absent or blank (`apps/cli/src/operations.ts:2425-2431`). `ERR_STORAGE` from the query. Nothing is written.

Source: `TraceLinks` at `apps/mcp/src/tools.ts:969-990`, its handler at `apps/mcp/src/handlers.ts:831-849`, and `traceLinks` at `apps/cli/src/operations.ts:2420-2471`.

## `trace_search`

```ts
const TraceSearch = Tool.make("trace_search", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({
    query: Schema.String,
    cwd: Optional(Schema.String),
    since: Optional(Schema.String),
    limit: Optional(Count)
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({
        session_id: Schema.String,
        slug: Schema.String,
        cwd: Schema.NullOr(Schema.String),
        started_at: Schema.NullOr(Schema.String),
        prompt_count: Count,
        first_prompt: Schema.String,
        ai_title: Schema.NullOr(Schema.String)
      })
    )
  })
})
```

Finds past Claude Code sessions by what was asked in them. It reads the `traces` table, an index of pointers and capped heads that stores no session content.

**Input:** `query` is required. `cwd`, `since`, and `limit` are optional. `limit` is clamped to 1..200 and defaults to 20 (`apps/cli/src/operations.ts:2348`). `cwd` is an exact match, and `since` is compared as text against `started_at`.

**Output:** `sessions`, each row carrying `session_id`, `slug`, `cwd`, `started_at`, `prompt_count`, `first_prompt`, and `ai_title`, with `cwd`, `started_at`, and `ai_title` nullable (`apps/mcp/src/handlers.ts:817-827`).

A matched query is ordered by bm25. The all-terms form runs first, and the any-of form runs only when that finds nothing. A query with no searchable terms lists the most recent sessions instead (`apps/cli/src/operations.ts:2355-2391`).

No tool fills the table. `memhtml trace index` does, from `MEMHTML_TRACE_ROOT`, so a root that was never indexed answers with no sessions.

**Failure:** `ERR_STORAGE` from the query. Nothing is written.

Source: `TraceSearch` at `apps/mcp/src/tools.ts:943-967`, its handler at `apps/mcp/src/handlers.ts:808-829`, and `searchTraces` at `apps/cli/src/operations.ts:2344-2405`.

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at cf76951.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 38 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 36 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 35 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 34 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 33 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 28 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 24 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 22 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 22 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 19 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 18 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 17 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 16 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 12 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 11 shared source citations

# memhtml-public · RPC tools

Describes the source at 0.15.1 (main 73871c2, 2026-10-06). Citations are `path:line` into that tree.

This repository ships an MCP server, `memhtml-mcp`, that speaks MCP over stdio. It publishes fifteen tools and three resource templates (`apps/mcp/src/tools.ts:1082-1098`, `apps/mcp/src/resources.ts:369-376`). A coding agent calls it to operate a memhtml root.

The repository stores no memory of its own. The server acts on whatever root `MEMHTML_ROOT` names, so one binary serves many roots (see [Environment](#environment)).

The server is one Effect layer, `layerServer` (`apps/mcp/src/server.ts:40-63`). It merges `McpServer.toolkit(MemhtmlToolkit)` with the three resources. It then provides the handlers, the stdio transport, the CLI's `layerApp`, telemetry, and a stderr logger.

The server shares the CLI's app layer, so an agent's `memory_write` and an operator's `memhtml search` resolve to one database, one git root, and one vector space (`apps/mcp/src/server.ts:13-19`).

The transport is `McpServer.layerStdio` at protocol revision `v2025_06_18` (`apps/mcp/src/server.ts:44-51`). Effect `4.0.0-rc.117` ships five protocol adapters: `v2026_07_28`, `v2025_11_25`, `v2025_06_18`, `v2025_03_26`, and `v2024_11_05`. The server names one, so a new revision is an explicit, reviewable choice rather than a default that moves the wire format. The initialize result reports `serverInfo` as `memhtml` `0.15.1` (`apps/mcp/src/server.ts:10-11`).

Logs go to stderr through `Logger.LogToStderr`. Stdout carries the NDJSON-RPC frames, and Effect's default logger writes to stdout (`apps/mcp/src/server.ts:21-23`, `apps/mcp/src/server.ts:62`). `bin.ts` runs the layer with `Layer.launch` for the life of the process, because a built-then-released layer would close stdin under the client (`apps/mcp/src/bin.ts:7-15`).

The server passes no `instructions` to `layerStdio`, so the initialize result carries none. Tool descriptions are the only guidance channel. That is why shared contracts such as `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` are appended to every description they apply to (`apps/mcp/src/server.ts:25-38`). The source gives the reason as effect offering no way to set the field, which held at rc.109. At rc.117, `layerStdio` accepts an `instructions` option.

Every tool binds its handler by name in `MemhtmlToolkit.toLayer({...})` (`apps/mcp/src/handlers.ts:324-328`). A handler decodes the snake_case wire parameters, calls the same operation function the matching CLI command calls, and renames the result back to snake_case (`apps/mcp/src/handlers.ts:36-46`).

Every tool declares `failure: ToolFailure` (`apps/mcp/src/failure.ts:34-41`). The declaration puts a tool's failures on the `McpServer` branch that passes the message text through. Without it, the failure schema defaults to `Schema.Never`, and every failure, typed domain errors included, reaches the caller as a generic internal-error sentence (`apps/mcp/src/tools.ts:47-55`). `failureMode` stays at its `"error"` default, because `"return"` would fold a failure into the success payload where no MCP client looks for it.

`tools/list` publishes the tools in toolkit order: `memory_write`, `memory_write_batch`, `memory_read`, `memory_search`, `memory_recall`, `memory_correct`, `memory_link`, `memory_neighbors`, `memory_resolve`, `memory_archive`, `memory_reinforce`, `memory_list`, `trace_search`, `trace_links`, `memory_status`. The batch tool sits second, so the tool `memory_write`'s description points at is the next entry an agent reads (`apps/mcp/src/tools.ts:1069-1081`). The entries below are alphabetical.

### Conventions

`Optional(X)` is `Schema.optionalKey(Schema.NullOr(X))` (`apps/mcp/src/tools.ts:105`). A client may omit the key, send a value, or send `null`. The published JSON Schema is a flat `anyOf` of `X` and `null`. The handlers treat `null` and absence alike (`apps/mcp/src/handlers.ts:105`). A bare `Schema.optional` would publish `null` as valid and then refuse it at decode (`apps/mcp/src/tools.ts:87-104`).

`MemoryPath` is `Schema.String` holding a path relative to the root's git tree with no leading slash, such as `areas/oncall/rollback-order.html` (`apps/mcp/src/tools.ts:64-71`). The schema checks nothing else. Most operations drop a leading slash; `memory_reinforce` uses its paths as given.

`Finite` is `Schema.Finite` and publishes `{"type":"number"}`. `Count` is `Schema.Int` and publishes `{"type":"integer"}` (`apps/mcp/src/tools.ts:73-85`). `Finite` stands in for `Schema.Number`, which publishes an `anyOf` with a string branch for `Infinity`, `-Infinity`, and `NaN`. `Count` accepts negative integers.

No tool sets strict mode. Every published `inputSchema` except `memory_status`'s allows additional properties, and a key a tool does not declare is ignored rather than refused. A `path` or `memory_type` sent to `memory_correct`, for example, has no effect.

Each entry quotes its registration block verbatim, with two mechanical elisions. The value of every `description` property becomes `/* … */`; the write tools' descriptions run to several paragraphs built from shared constants (`apps/mcp/src/tools.ts:150-299`). Every doc comment that spans more than one line inside the block becomes `// …` at its own indentation. One-line doc comments and `//` line comments are kept. Nothing else is altered, and each entry's source line points at the full block.

### How a call fails

A tool call fails in one of three wire shapes at effect `4.0.0-rc.117` (`pnpm-workspace.yaml:93`).

- A parameter that does not decode is a JSON-RPC error with code `-32602` and the message `Invalid parameters for tool '<name>': ...`. It carries no `ERR_*` code, and the handler never ran. A `memory_type` outside the writable types, a missing required key, and a `rel` outside the nine memory rels all fail this way.
- A typed failure is a tool result with `isError: true` and one text block: `ERR_<CODE>: <reason>. Try: <suggestion>; <suggestion>`. The `Try:` clause is left out when there are no suggestions (`apps/mcp/src/failure.ts:149-157`).
- Anything else, such as a defect, is a tool result with `isError: true` and the text "Tool execution failed due to an internal server error." The cause goes to stderr.

Every handler maps its error through `toToolFailure` once, in `handled` (`apps/mcp/src/handlers.ts:73-74`, `apps/mcp/src/failure.ts:173-190`). The code comes from `codeFor`, the reason from `messageFor`, and the suggestions from `mcpSuggestionsFor` (`apps/cli/src/errors.ts:41-79`, `apps/cli/src/errors.ts:90-124`, `apps/mcp/src/failure.ts:80-131`). A tag `codeFor` does not know becomes `ERR_UNKNOWN`. A `ToolFailure` that a handler composed itself, such as a batch abort, passes through unchanged (`apps/mcp/src/failure.ts:187`).

The code is the only machine-readable part. MCP's tool-error channel is one text block, so a client reads the code from the prefix before the first colon (`apps/mcp/src/failure.ts:20-25`). The reason never carries a driver message, SQL, a git argv, or a memory body (`apps/mcp/src/failure.ts:168-171`).

These are the codes a tool can reach, and the suggestions each one carries (`apps/mcp/src/failure.ts:80-131`):

| Code                             | Suggestions                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `ERR_INVALID_MEMORY`             | fix the named constraint and call the same tool again; nothing was written   |
| `ERR_PATH_NOT_FOUND`             | call `memory_resolve` on the path, then `memory_search`, then `memory_list`  |
| `ERR_WRITE_CONFLICT`             | call `memory_read` on the path; re-apply the change and retry the write      |
| `ERR_GIT`, `ERR_STORAGE`         | call `memory_status`; report to the operator if it persists                  |
| `ERR_EMBED_MODEL_MISMATCH`       | keep working on the other arms; the vector arm waits for an operator rebuild |
| `ERR_INDEX_STALE`, `ERR_UNKNOWN` | none                                                                         |

Two suggestion texts do not fit every case they reach. The `ERR_INVALID_MEMORY` text says the store refused "at the render gate", but the same text follows a `body`/`article_html` refusal, a self-link, and a `trace_links` call with neither key. The `ERR_WRITE_CONFLICT` text says to retry the write, but a retry at the same occupied path conflicts again; `memory_correct` is the replacement (`apps/mcp/src/tools.ts:187-188`).

`mcpSuggestionsFor` also has arms for `ERR_DUPLICATE_CONTENT`, `ERR_MODEL_UNAVAILABLE`, `ERR_DIRTY_TREE`, and `ERR_DISCRIMINATION_FAILED`. No tool or resource raises those codes at this tree. A duplicate is a successful dedupe, an embedder or extractor failure degrades the call instead of failing it, and only sleep checks for a clean tree.

### What a failed write leaves behind

The five write tools are `memory_write`, `memory_write_batch`, `memory_correct`, `memory_link`, and `memory_archive`. Each one fails in one of three phases, and the phase decides what is left behind.

1. Validation runs before anything touches disk. For a new memory, that is the strict-path gate, the render gate, the dedupe lookup, and the path claim (`packages/store/src/store.ts:707-739`). For a correction, a link, or an archive, it is the check that the target or both endpoints exist. A refusal here leaves the tree byte-identical.
2. The write, the stage, and the commit run under a journal. On a failure or an interruption, the store unstages every path it touched and puts back each one's earlier bytes (`packages/store/src/store.ts:475-562`). If that restore fails too, the failure is logged and the tree is left dirty.
3. After the commit, the operation calls `reindex` (`apps/cli/src/operations.ts:267-271`). That step can fail with `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` after the commit has landed. The call reports a failure, but the memory is in git.

A blind retry after a phase-3 failure can store the memory twice. Dedupe reads the index through `activePathForHash`, and the index has not caught up with the commit (`packages/index/src/traces-persist.ts:196-203`). `memory_status` shows the gap as `index_fresh: false`.

The commit is a plain `git commit -m`, so it also commits any path that was already staged in the root (`packages/store/src/git.ts:397-413`).

Writes in one process take turns behind one permit, `oneWriterAtATime`, and reads do not wait for it (`packages/store/src/store.ts:1382-1416`). `makeStore` creates that permit, so a second process on the same root, such as a CLI command beside the server, does not share it. Git's index lock serializes single git commands, not whole writes, so two processes can interleave in two ways. A git command that finds the lock held fails, and its write fails with `ERR_GIT`. A `git commit` that runs after the other process's `git add` takes both staged paths into one commit, as the paragraph above describes. Two processes writing one root are not isolated from each other.

### Environment

The server reads its configuration from its own environment at startup. `bin.ts` calls `layerServer` with no root override, so the root is `MEMHTML_ROOT` (`apps/mcp/src/bin.ts:15`, `apps/cli/src/api-layer.ts:107-116`). `memhtml serve mcp` runs the server as a child process and sets `MEMHTML_ROOT` for it, which is how `--repo` reaches the server (`apps/cli/src/serve.ts:82-90`).

| Variable                                                                                           | Effect on the server                                                                                                                                                                | Default                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `MEMHTML_ROOT`                                                                                     | The memory repo's root; a leading `~` is expanded (`apps/cli/src/config.ts:188-191`)                                                                                                | `~/memhtml`                |
| `MEMHTML_TRACE_ROOT`                                                                               | Read at startup; no tool reads the directory (`apps/cli/src/config.ts:199-202`)                                                                                                     | `~/.claude`                |
| `MEMHTML_EMBED`                                                                                    | `off` binds no embedder, so search and recall report `degraded`, and a batch that asks for near-duplicates reports `near_duplicates_degraded` (`apps/cli/src/api-layer.ts:239-251`) | `on`                       |
| `MEMHTML_VECTOR_COVERAGE_FLOOR`                                                                    | The coverage below which search and recall drop the vector arm, reported as `vector_coverage_floor`; a value outside (0, 1] stops startup (`apps/cli/src/api-layer.ts:307-319`)     | `0.95`                     |
| `MEMHTML_LLM`, `MEMHTML_EXTRACT_ENTITIES`                                                          | Either one `off` binds no entity extractor, so `memory_write_batch` extracts nothing (`apps/cli/src/api-layer.ts:404-418`)                                                          | `on`                       |
| `MEMHTML_AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`                                                   | The Bedrock region and credential for embeddings and the extractor (`packages/llm/src/client.ts:162-163`)                                                                           | `us-east-1`, default chain |
| `MEMHTML_LLM_BASE_URL`, `MEMHTML_LLM_API_KEY`, `MEMHTML_LLM_MODEL_PREFIX`, `MEMHTML_LLM_MODEL_MAP` | Route model and embedding calls through an LLM proxy; `normalizeProxyBaseUrl` or `parseProxyModelMap` stops startup on a malformed value (`packages/llm/src/client.ts:174-192`)     | unset                      |
| `MEMHTML_OPENAI_PROMPT_CACHE`                                                                      | Read with the model client; a value other than `off` or `implicit` stops startup (`packages/llm/src/wire.ts:76`)                                                                    | `off`                      |
| `MEMHTML_CONSOLIDATOR_TURN_TIMEOUT_MS`                                                             | Read when models are on and a credential or proxy is present; a value that is not a positive integer stops startup (`apps/cli/src/api-layer.ts:511-522`)                            | unset                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                      | Exports one trace per tool call, as service `memhtml-mcp` (`apps/mcp/src/server.ts:54-61`)                                                                                          | unset                      |
| `OTEL_SERVICE_NAME`                                                                                | Overrides that service name (`apps/cli/src/config.ts:164-169`)                                                                                                                      | unset                      |

No tool runs the consolidator, but the server builds its layer, which is why `MEMHTML_CONSOLIDATOR_TURN_TIMEOUT_MS` can stop it.

A value that stops startup is logged on stdout, not stderr, and the process exits with status 1. `NodeRuntime.runMain` reports the failure outside the layer that routes logs to stderr (`apps/mcp/src/bin.ts:15`).

Two variables in the CLI's manifest are not read by the server. `MEMHTML_REFUSE_ENV_ROOT` is read by `memhtml` only (`apps/cli/src/config.ts:73-77`). `MEMHTML_MCP_BIN` only locates the server for `memhtml serve mcp` (`apps/cli/src/serve.ts:56-59`).

### How the resources route

`memhtml://file/{path}` and `memhtml://at/{commit}/{path}` are the same read at two grains. A path alone names whatever lives there now, while a commit sha pins the bytes (`apps/mcp/src/resources.ts:20-25`).

All three templates are registered by one helper, `templateLayer` (`apps/mcp/src/resources.ts:126-159`). It calls `McpServer.addResourceTemplate` directly rather than using the `McpServer.resource` tagged template. The reason is the router.

`McpServer` matches a `resources/read` URI with find-my-way (`effect/unstable/http/FindMyWay`, effect `4.0.0-rc.117`). Two of that router's rules decide the pattern each resource registers, `memhtml:://<section>/*`, which `routerPathFor` builds (`apps/mcp/src/resources.ts:50`):

- A `:` that is not followed by another `:` opens a named parameter, and `::` is the escape for a literal colon. So the scheme's colon is doubled. Left single, `memhtml:` would register a parameter named `""`.
- A named parameter's value ends at the next `/`, so it matches one segment. Every memory path has at least two segments, and an archived one has at least four. `*` is the only construct that matches across `/`, and the router requires it to be the pattern's last character. The tagged template compiles its holes to named parameters, which is why it is not used.

The captured value does not arrive through the parameter array. `McpServer` folds matched parameters into a positional array by `Number(name)`, and `Number("*")` is `NaN`, so that slot is never filled. Each handler reads its value back out of the URI with `capturedOf` (`apps/mcp/src/resources.ts:71-83`).

`capturedOf` requires the `memhtml://<section>/` prefix verbatim. The router ignores repeated slashes and `capturedOf` does not, so `memhtml:///file/x.html` matches the route and is then refused. One `decodeURIComponent` covers both spellings a client can send: `areas/oncall/x.html` and `areas%2Foncall%2Fx.html` name the same resource.

A URI that matches no template never reaches a handler. Effect answers it with JSON-RPC code `-32002` and the message `Resource '<uri>' not found`.

The RFC 6570 templates that `resources/templates/list` publishes are literals, `RESOURCE_TEMPLATES` (`apps/mcp/src/resources.ts:372-376`), not composed from the route. So the template a client reads and the route the server matches are two independent readings of one URI shape. The tests expand their request URIs from those templates, so a template that drifts from its route fails a read (`apps/mcp/tests/resources.test.ts:33-50`). Another test checks that the registry publishes exactly that list (`apps/mcp/tests/resources.test.ts:265-273`).

**Every failure is sanitized, and no handler dies.** `tapCause` first logs the real cause to stderr. Then `catchDefect` turns a defect into `ERR_UNKNOWN`, and `toResourceFailure` maps a typed failure (`apps/mcp/src/resources.ts:141-156`). An `Effect.orDie` in their place would hand the client `Cause.prettyErrors(cause)[0].message`: an absolute filesystem path for a missing sleep report, and a `PathNotFound` without its code or suggestions.

A resource failure is a JSON-RPC error, not a tool result. `ERR_PATH_NOT_FOUND` maps to `-32602` (`InvalidParams`) and every other code to `-32603` (`InternalError`) (`apps/mcp/src/failure.ts:227-234`). The `message` carries the same `ERR_<CODE>: <reason>. Try: ...` text a tool failure does. A resource read never writes to the tree.

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

Returns one memory's title, claim, and body text as of a commit: a citation whose bytes cannot move.

**Input:** two holes, captured as one value and split at the first `/`. A commit sha cannot contain a slash and a memory path must, so that is the only place the split can fall.

The commit half must match `COMMIT_SHA`, `/^[0-9a-f]{7,64}$/`: git's abbreviation floor through the width of SHA-256 (`apps/mcp/src/resources.ts:255-267`). That refuses `HEAD`, a branch, and a tag, and the refusal is the contract. A URI whose target can move is not a citation, and `memhtml://at/main/x.html` would read as a pin while resolving to different bytes next week. Hex also keeps a leading `-` out of `git ls-tree`'s argv.

The path half passes the same `isValidMemoryPath` gate as the file resource, because the captured value accepts `..` (`apps/mcp/src/resources.ts:303-305`).

**Output:** `text/plain`, in the shape `memhtml://file/{path}` returns, parsed from the historical bytes. `lsTreeR` resolves the path in that commit's tree to a blob, and `catFileBatch` reads it. So a path corrected, archived, or evicted since still reads, and a seven-character sha works. A submodule entry has `objectType` `commit`, holds no memory, and is refused.

This read does not bump salience, while `memhtml://file/{path}` does. `state.access` is keyed on the path with no notion of a commit, so a bump would credit whatever occupies the path today for a read of a version it may not contain. Verifying a receipt is auditing, not choosing. The resource reads `Store` and not `IndexRecorder`, which makes that rule structural (`apps/mcp/src/resources.ts:295-301`).

**Failure:** `ERR_PATH_NOT_FOUND` (`-32602`) for an unknown commit, a path absent from a known commit, a movable ref, and an unusable path alike. From a client's side these are one answer, "this URI names nothing here". A `GitFailure` becomes the same refusal, and the real cause goes to stderr. The suggestions name the published template form and `memory_resolve` for the path the memory occupies now (`apps/mcp/src/resources.ts:270-275`). Bytes that do not parse as a memory fail with `ERR_INVALID_MEMORY`, and a defect with `ERR_UNKNOWN`, both `-32603`.

`memory_resolve` publishes a ready-made URI for this template as `pinned_uri`, built by `pinnedUri`, so a client stores a citation without composing one (`apps/mcp/src/resources.ts:365-366`).

Source: `PinnedResource` at `apps/mcp/src/resources.ts:312-351`.

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

**Input:** the whole tail after `memhtml://file/`, as a root-relative path. `isValidMemoryPath` gates it before the store sees it, and that gate is containment rather than validation (`apps/mcp/src/resources.ts:185-189`). The captured value accepts `/`, so it accepts `../../etc/passwd`, and the store joins a relative path onto the root with no traversal check of its own. The gate refuses any `.` or `..` segment, any path outside the four PARA buckets, and anything not ending in `.html`. An archive path passes, so an archived memory reads here.

**Output:** `text/plain`: an H1 of the title, the gist, then the article's body text, joined by newlines. The body text, `bodyText`, includes `<details>` bodies (`packages/html/src/document.ts:135-139`). The body is returned rather than the raw HTML file, because a client asking for a citation wants the text a human reads. Head metadata is `memory_read`'s job.

A missing path fails the read rather than returning an empty resource. A citation that silently resolves to nothing is worse than one that says the file is gone.

This read bumps salience through the same `readMemory` that `memory_read` calls (`apps/cli/src/operations.ts:1162-1169`). The caller named one path, which is a chosen open, so the access plane should not be able to tell the two surfaces apart. A failed bump is logged and does not fail the read.

**Failure:** `ERR_PATH_NOT_FOUND` (`-32602`). A path the gate refuses gets the resource's own suggestions: the template form, `memory_resolve`, then `memory_search` or `memory_list` (`apps/mcp/src/resources.ts:162-167`). A missing file gets the tool suggestions: `memory_resolve`, `memory_search`, then `memory_list`. A file that does not parse fails with `ERR_INVALID_MEMORY`, a read error with `ERR_STORAGE`, and a defect with `ERR_UNKNOWN`, all `-32603`.

Source: `FileResource` at `apps/mcp/src/resources.ts:191-211`.

## `memhtml://sleep/{run-id}`

```ts
export const SleepResource = templateLayer({
  section: "sleep",
  uriTemplate: "memhtml://sleep/{run-id}",
  name: "Sleep run report",
  description: /* … */,
  mimeType: "text/html",
  refuse: sleepRefusal,
  read: (uri, runId) =>
    Effect.gen(function* () {
      const roots = yield* Roots
      const html = yield* readFileOrNull(
        join(roots.memhtmlRoot, SLEEP_REPORTS_DIR, reportFilename(runId))
      )
      return html === null ? yield* Effect.fail(sleepRefusal(uri)) : html
    })
})
```

Returns one sleep run's committed HTML report: per-phase counts, commits, and what the run changed.

**Input:** the run id, verbatim, in the `sleep/<date>` spelling that `memory_status.last_sleep.run_id` publishes, so a URI reads `memhtml://sleep/sleep/2026-08-02`. The value a client copies out of a status call is the value this resource takes (`apps/mcp/src/resources.ts:234-235`).

**Output:** `text/html`, read from the root's tree under `.memhtml/sleep/`. The filename comes from `reportFilename`, imported from `@memhtml/sleep`, the function the report phase writes the file with (`packages/sleep/src/phases/report.ts:64`). It folds each `/` in the run id to a hyphen, so `sleep/2026-08-02` is `sleep-2026-08-02.html`.

Importing the function means the reader and the writer cannot disagree about the name. Deriving the rule a second time would be a consumer reimplementing a producer's naming rule, which this repo forbids. It also contains the read for free: with every `/` folded, a caller cannot name a directory (`apps/mcp/src/resources.ts:227-232`).

The resource reads the tree rather than the database. The committed report is the durable artifact of a run, and the `sleep_runs` row is a reporting convenience.

**Failure:** `ERR_PATH_NOT_FOUND` (`-32602`) when no report exists. It suggests `memory_status` for the id and status of the last run. It also says that a run `memory_status` names but whose report is absent never committed one (`apps/mcp/src/resources.ts:214-218`). A read error other than a missing file is `ERR_STORAGE` from `readFileOrNull`, and a defect is `ERR_UNKNOWN`, both `-32603` (`packages/store/src/layout.ts:131-146`).

Source: `SleepResource` at `apps/mcp/src/resources.ts:237-253`.

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

Soft-evicts a memory: a `git mv` into `archive/<YYYY>/` with the archive stamps. Nothing is deleted, and `git log --follow` reads straight through the move.

**Input:** `path`, the memory to evict, and `reason`, both required. `reason` is recorded only in the commit subject, after the path (`packages/store/src/store.ts:1151`). An archive path is not refused: archiving one again nests it under a second `archive/<YYYY>/`.

**Output:** `path`, normalized, and `archive_path`, where the file now lives. The archive path mirrors the original path under the year (`packages/contracts/src/paths.ts:213-214`).

**Failure:**

- `ERR_PATH_NOT_FOUND` when no file is at `path`, found before anything is written (`packages/store/src/store.ts:1136-1138`).
- `ERR_GIT` or `ERR_STORAGE` from the move or the commit. The journal, `compensated`, puts the file back at its original path (`packages/store/src/store.ts:1140-1154`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the archive commit has landed (`apps/cli/src/operations.ts:1312`).

Source: `MemoryArchive` at `apps/mcp/src/tools.ts:911-924`, its handler at `apps/mcp/src/handlers.ts:754-760`, and `archiveMemory` at `apps/cli/src/operations.ts:1306-1314`.

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

**Input:** `target_path`, `title`, and `reason` are required, plus exactly one of `body` or `article_html`, and an optional `session_id`. The handler's `authored` helper enforces the one-of rule, and a blank string counts as absent (`apps/mcp/src/handlers.ts:146-170`). The schema does not enforce it. A schema union would publish two near-identical parameter shapes and would name neither branch's problem on a decode failure (`apps/mcp/src/handlers.ts:110-118`).

The correction inherits the target's type, `memoryType`, and nothing else (`apps/cli/src/operations.ts:1259-1261`). It does not inherit the workspace, tags, entities, importance, or confidence. `memory_correct` takes no `path`, and the operation passes no placement fields, so placement comes from the type and the new title alone (`apps/cli/src/operations.ts:1264-1277`). A correction of `projects/oncall/x.html` can therefore land in `areas/inbox/`.

A correction never lands at the target's own path. The target is still on disk when `freePathFor` chooses the new path, so a same-title correction in the same directory takes the `-2` suffix (`packages/store/src/store.ts:417-457`). The store's `vacating` exemption covers only an explicit path, and `CorrectParams` has no path to pass (`apps/cli/src/operations.ts:1231-1240`, `packages/store/src/store.ts:1057-1075`).

`reason` is required but not recorded. The store accepts it and uses it nowhere, and `commitSubject` builds the commit subject from the title (`packages/store/src/store.ts:1116`).

The new file gets `memhtml-valid-from` and a `supersedes` link to the target's archive path. The archived target gets `memhtml-superseded-by`, a valid-until stamp, and the archive stamps (`packages/store/src/store.ts:1076-1112`).

**Output:** `path`, the new file, plus `superseded` and `archived`. Each is a one-element array holding the target's archive path, which is where the file lives once the commit lands and what the new file's `supersedes` link points at (`apps/mcp/src/handlers.ts:662-671`).

**Failure:**

- `ERR_INVALID_MEMORY` before anything is written: both or neither of `body` and `article_html`, a target that does not parse, or markup the render gate, `renderChecked`, refuses (`packages/store/src/store.ts:1047`).
- `ERR_PATH_NOT_FOUND` before anything is written, when the first `readMemory` finds no file at `target_path` (`apps/cli/src/operations.ts:1259`).
- `ERR_GIT` or `ERR_STORAGE` from the move, the write, or the commit. The journal, `compensated`, puts the target back and removes the new file (`packages/store/src/store.ts:1085-1121`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the commit has landed (`apps/cli/src/operations.ts:1281`).

Source: `MemoryCorrect` at `apps/mcp/src/tools.ts:719-740`, its handler at `apps/mcp/src/handlers.ts:649-673`, and `correctMemory` at `apps/cli/src/operations.ts:1256-1284`.

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

`strength` is accepted and dropped. The handler never passes it to `linkMemories`, and nothing stores it (`apps/mcp/src/handlers.ts:678`).

**Output:** `ok`, `rel`, `src_path`, and `dst_path`, with both paths normalized. `ok` is `true` whether or not this call wrote the link. The edge exists either way, and a `false` on a re-link would read as a failure (`apps/mcp/src/handlers.ts:679-687`).

**Failure:**

- `ERR_INVALID_MEMORY` when `src_path` and `dst_path` are the same, or when `requireEndpointClasses` finds a task at either end, before anything is written (`packages/store/src/store.ts:1264-1296`, `packages/store/src/store.ts:1316-1320`).
- `ERR_PATH_NOT_FOUND` when `typeOf` finds no file at either endpoint, before anything is written (`packages/store/src/store.ts:1305-1306`).
- `ERR_GIT` or `ERR_STORAGE` from the write or the commit. The journal, `compensated`, restores the source file's earlier bytes (`packages/store/src/store.ts:1330-1341`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the commit has landed. A re-link makes no commit and skips the reindex (`apps/cli/src/operations.ts:1299-1301`).

Source: `MemoryLink` at `apps/mcp/src/tools.ts:742-759`, its handler at `apps/mcp/src/handlers.ts:675-689`, and `linkMemories` at `apps/cli/src/operations.ts:1293-1303`.

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

Pages through the corpus by facet. `next_cursor` is a keyset on the path, so a page stays correct while a sleep run archives files (`listMemories`, `apps/cli/src/operations.ts:1818-1825`).

**Input:** every parameter is optional, and they combine with AND.

- `memory_type`: one of the nine writable types. Tasks are listed like any other type.
- `workspace`: an exact match.
- `tag`: one tag, an exact match.
- `entity`: one `type:name` reference, trimmed and matched case-insensitively, the same spelling `memory_search` accepts (`apps/cli/src/operations.ts:1852-1862`).
- `facets`: `name=value` specs over the article's `<dl>` pairs, composed exactly as `memory_search` composes them. A malformed spec is dropped.
- `para`: one of `projects`, `areas`, `resources`, or `archive` (`packages/contracts/src/types.ts:63`).
- `limit`: clamped to 1..500, default 50 (`apps/cli/src/operations.ts:1828`).
- `cursor`: the previous page's `next_cursor`.

Archived files are never listed. The handler's `listMemories` call does not pass `includeArchived`, so the operation always filters on `archived = 0` (`apps/mcp/src/handlers.ts:773-782`, `apps/cli/src/operations.ts:1832`). `para: "archive"` therefore returns an empty page, and every row has `archived: false`.

**Output:** `files`, rows of ten fields in path order, and `next_cursor`, which is `null` on the last page.

**Failure:** `ERR_STORAGE` from the query. Nothing is written.

Source: `MemoryList` at `apps/mcp/src/tools.ts:941-975`, its handler at `apps/mcp/src/handlers.ts:770-799`, and `listMemories` at `apps/cli/src/operations.ts:1825-1920`.

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

Returns the memory graph around one path, to at most two hops, in both directions, including sleep-mined edges. Lateral retrieval is what the mined edges are for, so each node says whether one reached it.

**Input:**

- `path` is required.
- `depth` is clamped to 1..2, default 1 (`apps/cli/src/operations.ts:1488`).
- `rels` narrows the walk to some of the nine memory rels.
- `limit` caps the distinct paths in `nodes`. It is clamped into 1..200 (`NEIGHBORS_LIMIT`) rather than refused, default 200, the same shape `memory_list` and `trace_search` have (`apps/cli/src/operations.ts:1489-1492`).

**Output:** `nodes`, each with `path`, `title`, `hop` (1 or 2, never 0), `rel`, and `derived`, plus four scalars: `edges`, `node_limit`, `dropped_node_count`, and `scan_saturated` (`apps/mcp/src/handlers.ts:709-715`). Each path appears once, at its minimal hop, and `rel` is the rel of an edge at that hop.

`derived` is true when a sleep-mined edge reaches the node and false when only authored `<link>` edges do. It is the max over every edge that reached the node, not `rel`'s companion. The question a caller asks of it is whether the connection may be a machine's suspicion, and one mined route is enough for yes (`apps/mcp/src/tools.ts:790-802`).

**`edges` is not a node count.** It counts the distinct edges the walk enumerated, keyed on `(src, rel, dst)`, over both hops and both directions. Two memories joined by two rels are one node and two edges. An edge to a path the node clamp dropped is counted here and absent from `nodes`. Its scope is this call's walk; `memory_status.edges` is the corpus total.

**Two markers report truncation, because the recoveries differ.** `dropped_node_count` is the distinct paths the walk reached that `node_limit` turned away. `nodes.length + dropped_node_count` is every path the walk found, and a larger `limit` returns them. `scan_saturated` means the walk stopped at its own 10,000-edge-row cap, `NEIGHBORS_SCAN_LIMIT` (`apps/cli/src/operations.ts:1383`). Edges past the cap were never enumerated, and no `limit` recovers them; narrow with `rels` or `depth: 1` instead. It is a plain boolean, because an absent marker cannot be told from a server that does not report saturation.

`node_limit` echoes the server's clamp, not the raw ask, so a client that sent 10000 reads back 200. It is named `node_limit` rather than `limit` because the answer carries two bounds: this one governs `nodes`, and the scan cap governs everything. `dropped_node_count` carries `_count` because it is a quantity, and this repo's numeric suffixes are not interchangeable. `edges` keeps its bare name because clients already branch on it (`apps/mcp/src/tools.ts:826-838`).

A center the tree does not hold is not an error, and the walk never checks it against `files`: it matches the center against `edges` only (`apps/cli/src/operations.ts:1413-1422`). With no edge naming it, the neighborhood is empty. Edges carry no foreign key on either endpoint (`packages/index/migrations/0004_edges.sql:6-7`), so an authored edge that still names a deleted center returns its other endpoint when that file exists. Only the returned node is joined to `files`. So archived files appear as nodes, and an edge whose far endpoint the tree does not hold contributes nothing (`apps/cli/src/operations.ts:1441-1447`).

**Failure:** `ERR_STORAGE` from the query. Nothing is written.

Source: `MemoryNeighbors` at `apps/mcp/src/tools.ts:761-850`, its handler at `apps/mcp/src/handlers.ts:691-717`, and `neighborsOf` at `apps/cli/src/operations.ts:1484-1578`.

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

Reads one memory in full: head metadata, authored links, and the whole article body, `<details>` bodies included. Recall never quotes a `<details>` body.

**Input:** `path` is required and `session_id` optional. A leading slash is dropped. With `session_id`, the read also records a `read` session link.

An explicit open counts as salience. `readMemory` reaches the state plane through `bumpAccess`, so the tool declares `DatabaseService`, and the dependency list shows that rule (`apps/mcp/src/tools.ts:554-560`). A search or recall hit does not move the plane.

**Output:** nine fields.

- `meta` is a flat `Record<string, string>` of the head's metas under camelCase keys, such as `memoryType`, `status`, `createdAt`, `contentHash`, and `validFrom`. Each entity adds an `entity:<ref>` key and each tag a `tag:<tag>` key, both set to `"true"` (`apps/mcp/src/handlers.ts:85-94`). Numbers arrive as strings, because that is what a `<meta content>` attribute holds.
- `meta` is open rather than typed. The head's optional metas are open at the edges, and a client bound to a closed set would break on the first addition.
- `links` carries `rel` and `href` for each authored link. An `href` keeps its leading slash.
- `archived` is true when the head's status is `archived` (`apps/mcp/src/handlers.ts:557`).
- `warnings` carries the parser's warnings.

**Failure:** `ERR_PATH_NOT_FOUND` when no file is at `path`, `ERR_INVALID_MEMORY` when the file does not parse as a memory, and `ERR_STORAGE` on another read error, from `readRaw`, `parseMemory`, and `readFileOrNull` (`packages/store/src/store.ts:1022-1028`, `packages/store/src/layout.ts:131-146`). Nothing is written. The access bump and the session link swallow their own failures (`apps/cli/src/operations.ts:1211-1229`).

Source: `MemoryRead` at `apps/mcp/src/tools.ts:551-577`, its handler at `apps/mcp/src/handlers.ts:545-561`, and `readMemory` at `apps/cli/src/operations.ts:1162-1169`.

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

Returns a context pack under a character budget. What fits is quoted, and what does not gets one index line. Arcs are folded under their own envelope, so a synthesis cannot crowd out the evidence behind it.

**Input:** `query` is required. `budget_chars` defaults to 16,000, `MEMORY_BODY_BUDGET`, and is not clamped (`packages/index/src/disclosure.ts:23`, `packages/index/src/retrieval.ts:598`). It governs ordinary memories only; `budgetFor` always gives arcs a 9,000-character envelope, `ARC_BODY_BUDGET` (`packages/index/src/disclosure.ts:20`, `packages/index/src/retrieval.ts:631-634`). A budget of 0 or less quotes no ordinary memory. `workspace` is the only scope, and tasks are excluded as in search's default scope.

**Output:** `sections` with three arrays, plus `spent_chars`, `truncated`, `degraded`, and `vector_coverage`.

- `arcs` and `memories` hold the quoted entries. A quote's `body` is the memory's disclosure text: the `<mark>` claim, each `<summary>` text, each `<dl>` pair as `name: value`, and each citation's text, one per line (`packages/index/src/project.ts:74-83`). It is not the article's prose and never a `<details>` body; `memory_read` returns those.
- At most two memories are quoted per entity name, and the rest become index lines (`packages/index/src/disclosure.ts:25-32`).
- `lateral` is the union of both folds' index lines. It holds what did not fit the budget, not the output of a third retrieval arm. Dropping it would make a truncated pack look like a small corpus (`apps/mcp/src/handlers.ts:614-639`).
- `truncated` is true when anything became an index line. `degraded` and `vector_coverage` mean what they mean on `memory_search`.

The pool is the top 30 fused candidates (`packages/index/src/retrieval.ts:601-606`). Recall does not bump salience.

**Failure:** `ERR_STORAGE` from the query. An embedder failure degrades the pack instead of failing it, in `queryVector` (`packages/index/src/retrieval.ts:262-276`). Nothing is written.

Source: `MemoryRecall` at `apps/mcp/src/tools.ts:678-717`, its handler at `apps/mcp/src/handlers.ts:606-647`, and `recallMemories` at `apps/cli/src/operations.ts:1205-1209`.

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

Records that a memory helped or misled. A per-path cooldown gates the signal, so a replayed query cannot inflate a memory's ranking.

**Input:** `paths`, an array of memory paths, and `signal`, one of `positive`, `negative`, or `neutral` (`packages/domain/src/reinforce.ts:31`). Paths are deduplicated, and empty strings are dropped. They are used as given: not normalized and not checked for existence, so an unknown path gets an access row of its own (`packages/index/src/reinforce.ts:77`).

**Output:** `bumped`, the paths whose signal landed, and `cooled_down`, the paths the cooldown held back (`apps/mcp/src/handlers.ts:762-768`).

The cooldown is 900 seconds per path, `REINFORCE_COOLDOWN_S` (`packages/domain/src/ranking.ts:17`). It is keyed on `last_accessed_at`, the last access of any kind, not the last reinforcement (`packages/index/src/reinforce.ts:100-109`). A `memory_read` or a file-resource read stamps that time. So a reinforce within 900 seconds of reading the same path lands in `cooled_down`, even though `memory_search`'s description says to read the chosen hit and then reinforce it.

`neutral` counts an access only. `positive` and `negative` also count a reinforcement and move the memory's outcome score.

Nothing is committed to git; the signal lives in the state database. The `reinforced` session-link kind exists, but no tool records it (`packages/index/src/traces-persist.ts:79`).

**Failure:** `ERR_STORAGE` from the upsert. Nothing is committed.

Source: `MemoryReinforce` at `apps/mcp/src/tools.ts:926-939`, its handler at `apps/mcp/src/handlers.ts:762-768`, and `reinforceMemories` at `apps/cli/src/operations.ts:1317-1327`.

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

**Input:** `path` only. The walk follows both mechanisms that move a memory, and neither is optional. The hop bound, `RESOLVE_MAX_HOPS` (16), is a property of the answer rather than a preference (`apps/cli/src/operations.ts:1588`).

**Output:**

- `requested` echoes the normalized path. `path` is where the walk ended, and `hops` equals `steps.length`.
- `stop_reason` decides whether the answer is citable, and only `live` means yes. The five values are `RESOLVE_STOP_REASONS`: `live`, `archived`, `unindexed`, `cycle`, and `hop_limit` (`apps/cli/src/operations.ts:1613`).
- `archived` is a memory evicted rather than corrected, so nothing supersedes it.
- `unindexed` is no such path in the index. It can also mean the index does not yet describe the commit that holds the path; `indexed_commit` names the commit it does describe.
- `cycle` is two memories each claiming to supersede the other, an authoring defect.
- `hop_limit` means `path` is where the walk stopped rather than the end of the chain, so resolving it again continues.
- `steps` names each hop's mechanism from a closed vocabulary, `RESOLVE_STEP_VIA`: `supersedes` for an authored `<link>`, and `archive_move` for a `git mv` recorded by `origin_path` (`apps/cli/src/operations.ts:1623`). Every node is named by the path holding that memory now, because a `supersedes` link travels with the file that carries it.
- `title` is the title at `path`, or `null` when the index has no row for it.
- `indexed_commit` is the commit the index describes, or `null` before the first rebuild.
- `pinned_uri` is a `memhtml://at/{commit}/{path}` URI for `path` at `indexed_commit`. The server composes it with `pinnedUri`, because the URI's spelling belongs to the resource that routes it. It is `null` when there is no commit to pin to, and when `stop_reason` is `unindexed`, the one ending whose path that commit does not hold (`apps/mcp/src/handlers.ts:738-750`).

A correction moves a memory in two hops: an `archive_move` from the cited path to its archive path, then a `supersedes` hop to the new file. For example, `areas/inbox/drain-order.html` resolves through `archive/2026/areas/inbox/drain-order.html` to `areas/inbox/drain-order-2.html`.

`hops: 0` with `stop_reason: live` does not mean the bytes are unchanged. A correction always lands at a new path (see `memory_correct`), but other writes, such as `memory_link`, rewrite a file in place. `pinned_uri` is the grain that pins bytes.

**Failure:** `ERR_STORAGE` from the index reads. An unknown path is `stop_reason: unindexed`, not an error. Nothing is written.

Source: `MemoryResolve` at `apps/mcp/src/tools.ts:852-909`, its handler at `apps/mcp/src/handlers.ts:719-752`, and `resolveMemory` at `apps/cli/src/operations.ts:1733-1798`.

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

Runs ranked search over the corpus. It fuses the lexical, vector, recency, and salience arms with RRF, then diversifies the result.

**Input:** `query` is required and the rest optional.

- `query` is prose. A double-quoted span demands those words in that order, and nothing else is syntax (`apps/mcp/src/tools.ts:581`).
- `limit` defaults to 10 and is not clamped (`packages/index/src/retrieval.ts:43`, `packages/index/src/retrieval.ts:504`). A limit of 0 or less returns no hits.
- `memory_types` draws from the nine writable types. An explicit list is honored verbatim, `task` included; without one, tasks are excluded (`packages/index/src/scope.ts:262-280`).
- `workspace` is an exact match, and `tags` matches a memory that carries any of the tags.
- `entity` takes one reference in `type:name` form, matched case-insensitively. It is the spelling `memory_list` accepts and the spelling a hit's `entities` publishes, so an agent chains by copying a value rather than reconstructing one (`apps/mcp/src/tools.ts:590-594`).
- `facets` takes `name=value` specs over the article's authored `<dl>` pairs (`apps/mcp/src/tools.ts:294-299`). Values under the same name broaden (OR), and different names narrow (AND). So `["doc-type=runbook", "doc-type=guide"]` is either, and `["doc-type=runbook", "tier=1"]` is both. A caller who read it the other way round acts on a superset or an empty set, and the rows report neither.
- A facet matches on its text with no case folding, unlike `entity`, because a facet is the consumer's own machine-written vocabulary.
- A facet spec with an empty half is dropped rather than refused. So a malformed spec widens the answer instead of narrowing it, and the rows cannot show that either (`packages/index/src/scope.ts:57-63`).
- `include_archived` admits archived memories.
- `as_of` is a point-in-time view over `coalesce(valid_from, event_at, created_at) <= as_of < valid_until`, including since-superseded memories (`apps/mcp/src/tools.ts:601-607`). In the scope, `asOf` replaces the archived filter, so `include_archived` has no effect beside it (`packages/index/src/scope.ts:246-260`). The value is compared as text and not validated.

**Output:** `hits` plus seven result-level fields.

- Each hit's `score` is the fused RRF score, unitless and comparable only within one result set.
- `snippet` holds the best-matching chunk's text for this query, or the opening chunk when the vector arm did not fire, ending in `…` when cut.
- `entities` lists the hit's references in `type:name` form, sorted.
- `superseded_by` is present and nullable, and non-null only for an archived hit. A client can tell "not superseded" from "this build does not report supersession" (`apps/mcp/src/tools.ts:633-640`).
- `degraded` is true when the vector arm did not fire.
- `vector_coverage` is the share of indexed chunks carrying a vector, 0 to 1, and it tells the two causes of `degraded` apart (`apps/mcp/src/tools.ts:644-650`). Below the coverage floor, `gatedQueryVector` drops the arm on purpose, because a few embedded files would outrank every exact match. A high value with `degraded: true` means the embedder failed (`packages/index/src/retrieval.ts:304-315`).
- `arms` names the arms that ran, and `entity_scope` echoes the `entity` scope or `null`.
- `scope_empty` is true when a named scope narrowed the query and nothing survived. The tool reports a scope it could not satisfy rather than widening it (`scopeEmpty`, `packages/index/src/retrieval.ts:545`).
- `archived_matches` and `archived` are the pointer behind an empty scope. When `scope_empty` is true and `as_of` is absent, they count and list the archived memories the same scope matches, up to `limit` and at least one, each with the path that superseded it or `null` (`packages/index/src/retrieval.ts:470-494`, `packages/index/src/retrieval.ts:551-554`). Otherwise they are `0` and empty. An agent follows this pointer when an eviction or a compress moved a record into `archive/`.

Returning a path changes nothing on the access plane, because a hit is the ranker's guess rather than a deliberate open (`apps/cli/src/operations.ts:1176-1187`).

**Failure:** `ERR_STORAGE` from the query. An embedder failure degrades the search instead of failing it, in `queryVector` (`packages/index/src/retrieval.ts:262-276`). Nothing is written.

Source: `MemorySearch` at `apps/mcp/src/tools.ts:579-676`, its handler at `apps/mcp/src/handlers.ts:563-604`, and `searchMemories` at `apps/cli/src/operations.ts:1188-1192`.

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
    vector_coverage_floor: Finite,
    last_sleep: Schema.NullOr(
      Schema.Struct({
        run_id: Schema.String,
        status: Schema.String,
        started_at: Schema.String
      })
    )
  })
})
```

Reports corpus health in one call: HEAD, dirty state, counts by type, edge totals, whether the index describes the current commit, vector coverage, and the last sleep run.

**Input:** none. `parameters` is `Tool.EmptyParams`, which publishes `{"type":"object","additionalProperties":false}` and refuses any key with `-32602`. An empty `Schema.Struct({})` would not publish "an object with no fields": at rc.117 it derives `{"not":{"type":"null"}}`. The source comment records rc.109's derivation, an `anyOf` with an array branch (`apps/mcp/src/tools.ts:1031-1041`).

**Output:** ten fields.

- `head_sha` is `null` on an unborn repository.
- `dirty` is true when `git status` lists any path that is not ignored.
- `counts_by_type` counts the active indexed files by type, `archived_count` the archived ones, and `edges` every edge in the corpus.
- `index_fresh` is true when the index's watermark is the current HEAD, which a row count cannot answer. While the operation's `indexFresh` is false, every call also logs a warning to stderr (`apps/cli/src/operations.ts:2719-2724`).
- `embedder_up` reads the index, not the live embedder. The operation's `embedderUp` is true when the stored vector space matches the configured one and at least one embedding exists, so it can be true at 2 percent coverage (`apps/cli/src/operations.ts:2744`).
- `vector_coverage` is the share of chunks with a vector in the configured space, and `1` on an empty index. `vector_coverage_floor` is the floor below which `memory_search` drops the vector arm (`apps/mcp/src/tools.ts:1052-1058`).
- `last_sleep` is `null` when no run is recorded, and otherwise carries `run_id`, `status`, and `started_at` (`apps/mcp/src/handlers.ts:858-865`). A failed read of that row also reads as `null` (`apps/cli/src/operations.ts:2699-2703`).

**Failure:** `ERR_GIT` from `rev-parse` or `status`, and `ERR_STORAGE` from a count statement (`apps/cli/src/operations.ts:2682-2697`). Nothing is written.

The suggestions for `GitFailure` and `StorageFailure`, the tags behind `ERR_GIT` and `ERR_STORAGE`, point an agent at this tool (`apps/mcp/src/failure.ts:119-125`). The `DirtyTree` arm does too, but no tool raises `ERR_DIRTY_TREE`.

Source: `MemoryStatus` at `apps/mcp/src/tools.ts:1026-1067`, its handler at `apps/mcp/src/handlers.ts:844-868`, and `statusReport` at `apps/cli/src/operations.ts:2676-2753`.

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

**Input:** `Schema.Struct(writeFields())`, fourteen fields that `writeFields` shares with each `memory_write_batch` op (`apps/mcp/src/tools.ts:314-347`).

- `title` and `memory_type` are required. `memory_type` is one of the nine writable types: `episodic`, `semantic`, `procedural`, `agent_insight`, `user_preference`, `error_pattern`, `verdict`, `precedent`, and `task` (`packages/contracts/src/types.ts:38-40`). `arc` fails decode against `WritableType`, because the sleep cycle writes arcs itself (`apps/mcp/src/tools.ts:58-59`).
- Exactly one of `body` or `article_html` is required. The handler enforces the rule rather than the schema, and a blank string counts as absent (`apps/mcp/src/handlers.ts:146-170`).
- On the prose path, `body`'s first sentence becomes the `<mark>` claim and each blank-line paragraph becomes one `<p>`.
- On the markup path, the caller owns the format: one `<mark>` inside the first `<p>` or `<li>`, the closed element vocabulary, and no `class`, `style`, or `<script>`. The first `<time datetime>` becomes the event time the recency arm ranks by (`apps/mcp/src/tools.ts:150-161`).
- The rest are optional: `path`, `strict_path`, `workspace`, `tags`, `entities`, `importance`, `confidence`, `session_id`, `prompt_id`, and `turn_uuid`.

Without `path`, the directory comes from the type, a person entity, the workspace, and the first non-blank tag, and the filename from the title (`packages/contracts/src/paths.ts:145-183`). A taken filename gets a `-2`, `-3`, and so on.

An explicit `path` has two surprising branches (`apps/mcp/src/tools.ts:183-188`).

- An unusable `path` is ignored, and the placement rule decides instead, so the memory lands somewhere the caller did not name. `strict_path: true` turns that into `ERR_INVALID_MEMORY`, with nothing written, staged, or committed. It governs only a `path` that was sent.
- An occupied `path` is refused with `ERR_WRITE_CONFLICT`, and nothing is written. An explicit path gets no `-2` suffix, because the caller named one path. To replace what a memory says, call `memory_correct`.

A `path` in the `archive` bucket is accepted. The index derives `archived` from the bucket, so such a memory is archived from the start, and default search and list skip it (`packages/index/src/project.ts:150-151`).

`importance` and `confidence` are written into the head unchecked. A value outside 1..10 or 0..1 is dropped when the file is parsed, and the index falls back to importance 5 and confidence 1.0 (`packages/html/src/parse.ts:130-131`, `packages/index/src/project.ts:166-167`).

`memory_write` runs no entity extraction; only `memory_write_batch` does. With `session_id`, the call records a `wrote` session link, on a dedupe too (`apps/cli/src/operations.ts:341-342`).

**Output:** `path`, `created`, `deduped`, and `existing_path`. On a dedupe, `path` and `existing_path` both name the stored memory and `created` is false. `existing_path` is present and nullable rather than optional, so a client can tell "this write did not dedupe" from "this server does not report dedupes" (`apps/mcp/src/tools.ts:386-390`).

**Failure:**

- `ERR_INVALID_MEMORY` before anything is written: both or neither of `body` and `article_html`, a `strict_path` refusal from `strictPathRefusal`, or markup `renderChecked` refuses (`packages/store/src/store.ts:707-712`).
- `ERR_WRITE_CONFLICT` before anything is written, when an explicit `path` is taken. The message reads `ours , theirs <sha>`: `ours` is empty because the write had no base, and `theirs` is the blob now at the path (`packages/store/src/store.ts:430-441`). Its suggestions say to retry, but a retry at the same path conflicts again.
- `ERR_STORAGE` before anything is written, when the dedupe lookup fails or a title has used up 1,000 filename ordinals, reported as `write.pathExhausted` (`packages/store/src/store.ts:447-456`).
- `ERR_GIT` or `ERR_STORAGE` from the write, the stage, or the commit. The journal, `compensated`, removes the file (`packages/store/src/store.ts:741-758`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the commit has landed (`apps/cli/src/operations.ts:341`). A blind retry can then write a second copy; see [What a failed write leaves behind](#what-a-failed-write-leaves-behind).

Source: `MemoryWrite` at `apps/mcp/src/tools.ts:349-366`, its handler at `apps/mcp/src/handlers.ts:329-357`, and `writeMemory` at `apps/cli/src/operations.ts:335-344`.

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
    consolidate: Optional(Schema.Literals(["last-wins"])),
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
      skipped: Count,
      /** Batch-internal losers under `consolidate: "last-wins"`: neither written nor failed. */
      consolidated: Count
    }),
    commit_sha: Schema.NullOr(Schema.String),
    // …
    near_duplicates_degraded: Schema.Boolean
  })
})
```

Writes many memories in one commit. It validates every op first, stages every surviving file, then commits and reindexes once.

**Input:**

- `ops` is an array of `BatchOp`, which is `Schema.Struct(writeFields())`: the same fourteen fields as `memory_write`, with the same one-of rule for `body` and `article_html` (`apps/mcp/src/tools.ts:379`). Both tools read one field record, so adding a field cannot leave the two published schemas disagreeing (`apps/mcp/src/tools.ts:301-313`).
- `continue_on_error` switches from the atomic default to best-effort.
- `detect_conflicts` adds a per-op `conflict` field and changes nothing about what is written (`apps/mcp/src/tools.ts:233-242`).
- `detect_near_duplicates` adds a per-op `near_duplicates` list, the vector sibling of the conflict rule, which catches rewordings that rule cannot key. It also changes nothing written, and it costs one embedding call per batch (`apps/mcp/src/tools.ts:270-276`).
- `consolidate` accepts the single literal `"last-wins"`. A one-value `Literals` was chosen over a boolean, so the vocabulary can widen without a shipped `true` changing meaning (`apps/mcp/src/tools.ts:513-518`).
- `session_id`, `prompt_id`, and `turn_uuid` are batch-level provenance.

Provenance has two homes. In `provenanceOf`, an op's own values win for its file's head, and `provenanceTrailers` takes the commit trailers from the first op that carries provenance (`apps/cli/src/operations.ts:1092-1097`, `packages/store/src/store.ts:992-997`). The `wrote` session link uses only the batch-level `session_id`, so an op's own `session_id` never reaches `trace_links` (`apps/cli/src/operations.ts:1023`).

When entity extraction is on, one model call per batch extracts entities the ops did not declare. They land in the files as if authored. A failed extraction is a logged warning, and the batch is written without them (`apps/cli/src/operations.ts:964-998`).

**Output:** `results`, `summary`, `commit_sha`, and `near_duplicates_degraded`.

- `results` holds one `BatchOpResult` per op, in input order. Each has `index`, `ok`, `path`, `deduped`, `existing_path`, `code`, `error`, `skipped`, `conflict`, `near_duplicates`, `consolidated_into`, and `superseded_path`. Every nullable field is present rather than optional, so an absent key never has to be read as a negative answer (`apps/mcp/src/tools.ts:382-467`).
- `conflict` names what the op's claim contradicts: `path` for a stored active memory, or `batch_index` for an earlier op in the same call, plus that other claim's text.
- `near_duplicates` lists what the op's text matches at or above cosine 0.92. Each entry carries `path` or `batch_index`, the measured `similarity`, and the other `claim`.
- `near_duplicates` is `null` when the flag was off, when nothing matched, on an `article_html` op, and whenever `near_duplicates_degraded` is true. That flag means the assist could not run, for example under `MEMHTML_EMBED=off`, so `null` then means unchecked rather than unique.
- The handler translates `batch_index` and `consolidated_into` from the survivor positions `batchWrite` saw back into the caller's op indices. So an op refused earlier in the batch cannot make a pointer name the wrong op (`apps/mcp/src/handlers.ts:486-526`).
- `summary` is derived from `results` in one pass, so the counts cannot disagree with the array (`apps/mcp/src/handlers.ts:298-316`).
- `commit_sha` is `null` when nothing was written: an empty `ops`, an all-deduped batch, or a continue-mode batch in which every op failed.

Under `consolidate: "last-wins"`, ops that share a frame key collapse to one file, at the first index that claimed the slot, carrying the later value. Each later op reports `ok: true`, `path: null`, and `consolidated_into` naming that index. A stored active memory in a surviving slot is archived with a `supersedes` link from the new file and reported as `superseded_path` (`apps/mcp/src/tools.ts:252-255`). That supersede, `supersedeMemories`, is a second commit with a second reindex. A failed supersede is logged, and the batch stays written (`apps/cli/src/operations.ts:1039-1068`).

**Failure:** an atomic batch aborts on its first refused op and reaches the caller through the error channel, not as a result. The message names the op: `ERR_<CODE>: ops[N]: <reason>. The batch is atomic, so nothing was written and no commit was made. Try: fix ops[N] and call memory_write_batch again; set continue_on_error to true to write the ops that would have succeeded` (`apps/mcp/src/failure.ts:264-277`). The code is the op's own, so the batch and the singular report one refusal under one code.

- `ERR_INVALID_MEMORY` for a one-of violation, a `strict_path` refusal, or markup the render gate refuses. `ERR_WRITE_CONFLICT` for a taken explicit path, including one an earlier op in the same batch claimed. All are found before anything is written, by the handler and by `validateOp` (`apps/mcp/src/handlers.ts:404-468`, `packages/store/src/store.ts:922-965`).
- In continue mode, the same refusals become failed results carrying their own `code` and `error`, and the survivors land in the one commit.
- `ERR_GIT` or `ERR_STORAGE` from the write pass, the stage, or the commit fails the whole call in either mode. The journal, `compensated`, restores every path the pass reached (`packages/store/src/store.ts:976-999`).
- `ERR_STORAGE`, `ERR_EMBED_MODEL_MISMATCH`, or `ERR_INDEX_STALE` from `reindex`, after the batch commit has landed (`apps/cli/src/operations.ts:1022`). The `reindex` after a consolidation supersede can fail the same way after both commits (`apps/cli/src/operations.ts:1065`).

Source: `MemoryWriteBatch` at `apps/mcp/src/tools.ts:469-549`, its handler at `apps/mcp/src/handlers.ts:395-543`, and `batchWrite` at `apps/cli/src/operations.ts:882-1083`.

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

Returns which memories a session produced, or which sessions touched a memory.

**Input:** `session_id` and `path`, both optional, but at least one is required. Both together narrow with AND. A call with neither is refused, rather than answered with every link ever recorded.

**Output:** `links`, newest first, capped at 500, `TRACE_LINKS_LIMIT` (`apps/cli/src/operations.ts:2599`). Each row carries `path`, `session_id`, `prompt_id`, `turn_uuid`, `link_kind`, and `at`, with `prompt_id` and `turn_uuid` nullable (`apps/mcp/src/handlers.ts:831-840`).

A link is recorded only when a call carries a `session_id`: `wrote` by `memory_write` and `memory_write_batch`, `read` by `memory_read`, and `corrected` by `memory_correct`. A failed link is logged and never fails the call (`apps/cli/src/operations.ts:201-218`). `memory_link`, `memory_archive`, `memory_reinforce`, and the resources record none.

**Failure:** `ERR_INVALID_MEMORY`, an `InvalidMemory` reading "trace links needs a session_id or a path", when both are absent or blank (`apps/cli/src/operations.ts:2612-2618`). `ERR_STORAGE` from the query. Nothing is written.

Source: `TraceLinks` at `apps/mcp/src/tools.ts:1003-1024`, its handler at `apps/mcp/src/handlers.ts:824-842`, and `traceLinks` at `apps/cli/src/operations.ts:2607-2658`.

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

Finds past Claude Code sessions by what was asked in them. It reads the `traces` table, an index of pointers and capped heads rather than session content.

**Input:** `query` is required; `cwd`, `since`, and `limit` are optional. `limit` is clamped to 1..200 and defaults to 20 (`apps/cli/src/operations.ts:2535`). `cwd` is an exact match, and `since` is compared as text against `started_at`.

**Output:** `sessions`, each row carrying `session_id`, `slug`, `cwd`, `started_at`, `prompt_count`, `first_prompt`, and `ai_title`, with `cwd`, `started_at`, and `ai_title` nullable (`apps/mcp/src/handlers.ts:810-820`).

A matched query is ordered by bm25. The all-terms form runs first, and the any-of form runs only when that finds nothing. A query with no searchable terms lists the most recent sessions instead (`apps/cli/src/operations.ts:2542-2578`).

No tool fills the table. `memhtml trace index` does, from `MEMHTML_TRACE_ROOT`, so a root that was never indexed answers with no sessions.

**Failure:** `ERR_STORAGE` from the query. Nothing is written.

Source: `TraceSearch` at `apps/mcp/src/tools.ts:977-1001`, its handler at `apps/mcp/src/handlers.ts:801-822`, and `searchTraces` at `apps/cli/src/operations.ts:2531-2592`.

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at 73871c2.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 24 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 23 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 23 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 19 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 14 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 14 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 13 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 12 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 11 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 10 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 10 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 10 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 9 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 8 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 7 shared source citations

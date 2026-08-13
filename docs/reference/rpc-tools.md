# memhtml-public · RPC tools

This repository ships an MCP server, `memhtml-mcp`, over stdio. It publishes fourteen tools and two resource templates, and a coding agent calls it to operate a memhtml root. The repository stores no memory of its own. The server acts on whatever root `$MEMHTML_ROOT` points the process at, and the same binary serves many roots.

The server is one Effect layer that merges `McpServer.toolkit(MemhtmlToolkit)` with the two resources, over the CLI's own app layer, on the stdio transport at protocol revision `v2025_06_18` (`apps/mcp/src/server.ts:39-54`). The server shares the CLI's layer, so an agent's `memory_write` and an operator's `memhtml search` resolve to one database, one git root, and one vector space (`apps/mcp/src/server.ts:12-19`). Logs are pinned to stderr because stdout carries the NDJSON-RPC frames (`apps/mcp/src/server.ts:20-22`, `apps/mcp/src/bin.ts:7-13`).

Every tool binds its handler by name in `MemhtmlToolkit.toLayer({...})` (`apps/mcp/src/handlers.ts:309`). A handler decodes the snake_case wire parameters, calls the same operation function the matching CLI command calls, and renames the result back to snake_case (`apps/mcp/src/handlers.ts:33-43`).

Every tool declares `failure: ToolFailure`, a tagged error carrying a stable `ERR_*` code, a composed message, and suggestions phrased as tool calls the agent can make (`apps/mcp/src/failure.ts:32-39`). The declaration routes a failure down the branch that passes the message text through to the caller. Omitting it rewrites every failure, typed domain errors included, to a generic internal-error sentence before the caller sees it (`apps/mcp/src/tools.ts:33-41`, `apps/mcp/src/failure.ts:8-16`).

Three conventions apply to every entry below.

`Optional(X)` in a signature is `Schema.optionalKey(Schema.NullOr(X))`, so a client may omit the key, send a value, or send `null`, and the handler normalizes `null` and absence to the same thing (`apps/mcp/src/tools.ts:91`, `apps/mcp/src/handlers.ts:102`). `MemoryPath` is `Schema.String` holding a path relative to the root's git tree with no leading slash, such as `areas/oncall/rollback-order.html` (`apps/mcp/src/tools.ts:51-57`). `Count` is `Schema.Int` and `Finite` is `Schema.Finite`, chosen over `Schema.Number` so the published JSON Schema is a plain `{"type":"number"}` rather than a union with a string branch (`apps/mcp/src/tools.ts:59-71`).

Signatures are quoted verbatim from the registration site with two mechanical elisions, both marked where they occur. `description: /* … */,` stands for the description string, which for the write tools runs to several paragraphs assembled from shared constants (`apps/mcp/src/tools.ts:133-211`). `// …` stands for a nested doc comment explaining a schema choice. No identifier, schema, or punctuation is altered. Each entry's citation points at the full block.

## `memhtml://file/{path}`

```ts
export const FileResource = McpServer.resource`memhtml://file/${pathParam}`({
  name: "Memory file",
  description:
    "One memory's title, claim, and body text, by repo-root-relative path. For showing a human the file behind an answer.",
  mimeType: "text/plain",
  content: (_uri, path) =>
    Effect.gen(function* () {
      const result = yield* readMemory(path)
      return [
        `# ${result.doc.title}`,
        "",
        result.doc.article.gist,
        "",
        result.doc.article.bodyText
      ].join("\n")
    }).pipe(Effect.orDie)
})
```

Returns one memory's readable text by path, for a client that holds a path from `memory_search` and wants to show a human the file behind an answer without spending a tool call.

**Input:** one template parameter, `path`, declared as `McpSchema.param("path", Schema.String)` so `resources/templates` publishes it as a named hole rather than a positional one (`apps/mcp/src/resources.ts:21`).

**Output:** a `text/plain` body holding an H1 of the title, the gist, then the article body text, joined by newlines. The markup is not returned, and head metadata is `memory_read`'s job (`apps/mcp/src/resources.ts:28-32`). A missing path fails the read rather than resolving to an empty resource. This read bumps salience through the same `readMemory` the `memory_read` tool calls, because naming one path counts as a deliberate open (`apps/mcp/src/resources.ts:36-40`).

`apps/mcp/src/resources.ts:42-58`

## `memhtml://sleep/{run-id}`

```ts
export const SleepResource = McpServer.resource`memhtml://sleep/${runIdParam}`({
  name: "Sleep run report",
  description:
    "One sleep run's committed HTML report: per-phase counts, commits, and what the run changed.",
  mimeType: "text/html",
  content: (_uri, runId) =>
    Effect.gen(function* () {
      const roots = yield* Roots
      // …
      const name = runId.split("/").at(-1) ?? runId
      const path = join(roots.memhtmlRoot, SLEEP_REPORTS_DIR, `${name}.html`)
      return yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => cause
      })
    }).pipe(Effect.orDie)
})
```

Returns one sleep run's committed HTML report: per-phase counts, commits, and what the run changed.

**Input:** one template parameter, `run-id`, declared as `McpSchema.param("run-id", Schema.String)` (`apps/mcp/src/resources.ts:24`). A run id arrives in the form `sleep/2026-08-02`, and only its last segment names the file.

**Output:** a `text/html` body read from the root's tree at `<memhtmlRoot>/<SLEEP_REPORTS_DIR>/<date>.html`. The resource reads the tree rather than the database, because the committed report is the durable artifact of a run and the `sleep_runs` row exists for reporting convenience (`apps/mcp/src/resources.ts:60-66`).

`apps/mcp/src/resources.ts:67-84`

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

Soft-evicts a memory by `git mv` into `archive/<YYYY>/` and applies the archive stamps. Nothing is deleted, and `git log --follow` reads straight through the move.

**Input:** `path` (the memory to evict) and `reason`, both required strings.

**Output:** `path` and `archive_path`. The handler calls `archiveMemory(params.path, params.reason)` and returns the operation's `path` and `archivePath` (`apps/mcp/src/handlers.ts:654-660`).

`apps/mcp/src/tools.ts:615-628`

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

Supersedes a memory. It writes the corrected version and archives the target in one commit, with links in both directions. The target file is not edited in place.

**Input:** `target_path`, `title`, and `reason` required; exactly one of `body` or `article_html`; `session_id` optional. The handler's `authored` helper enforces the one-of rule between `body` and `article_html` (`apps/mcp/src/handlers.ts:107-136`). The schema does not, because a schema union would publish two near-identical full parameter shapes and would name neither branch's problem on a decode failure.

**Output:** `path` (the new file), plus `superseded` and `archived`, each a one-element array holding the target's archive path. Both report the post-commit archive path rather than the pre-archive one, because that is where the file lives once the commit lands and what the new file's `memhtml-supersedes` link points at (`apps/mcp/src/handlers.ts:613-622`).

`apps/mcp/src/tools.ts:549-570`

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

Asserts an edge between two memories. The edge is written into the source file's head, so it survives an index rebuild, and a repeated call on the same pair changes nothing.

**Input:** `src_path`, `dst_path`, and `rel` required; `strength` an optional finite number. `rel` is `MemoryRelSchema`, a closed set of nine MEMORY-class rels: `supersedes`, `contradicts`, `caused_by`, `leads_to`, `part_of`, `relates_to`, `example_of`, `supports`, `laterally_related` (`apps/mcp/src/tools.ts:48`, `packages/contracts/src/edges.ts:19-29`). A person or provenance rel cannot be named here.

**Output:** `ok`, `rel`, `src_path`, `dst_path`. `ok` is `true` whether or not this call wrote the link, since the edge exists either way and a `false` on a re-link would read as a failure (`apps/mcp/src/handlers.ts:631-638`).

`apps/mcp/src/tools.ts:572-589`

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

Pages through the corpus by facet. A keyset cursor on the path keeps a page correct while a sleep cycle archives files.

**Input:** every parameter optional. `memory_type` is one of the nine writable types; `para` is one of `projects`, `areas`, `resources`, `archive` (`packages/contracts/src/types.ts:63`); `entity` takes the same `type:name` spelling `memory_search` accepts; `limit` is clamped to 1..500 and defaults to 50 (`apps/cli/src/operations.ts:1196`).

**Output:** `files`, an array of ten-field rows, and `next_cursor`, null on the last page.

`apps/mcp/src/tools.ts:645-676`

## `memory_neighbors`

```ts
const MemoryNeighbors = Tool.make("memory_neighbors", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({
    path: MemoryPath,
    depth: Optional(Count),
    rels: Optional(Schema.Array(MemoryRelSchema))
  }),
  failure: ToolFailure,
  success: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        path: MemoryPath,
        title: Schema.String,
        /** 1-based distance from the centre: 1 or 2, never 0. */
        hop: Count,
        rel: Schema.String
      })
    ),
    edges: Count
  })
})
```

Returns the memory graph around one path, to at most two hops, in both directions, and includes sleep-mined edges.

**Input:** `path` required; `depth` optional and clamped to 1..2 with a default of 1 (`apps/cli/src/operations.ts:1097`); `rels` an optional array drawn from the same nine MEMORY-class rels `memory_link` accepts.

**Output:** `nodes`, each carrying `path`, `title`, `hop` (1 or 2, never 0), and `rel`, plus `edges` as a count. The handler returns the operation's `nodes` and `edges` unchanged (`apps/mcp/src/handlers.ts:642-652`).

`apps/mcp/src/tools.ts:591-613`

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

Reads one memory in full: head metadata, authored links, and the complete article body. It is also the only way to reach a `<details>` body, which recall never quotes.

**Input:** `path` required, `session_id` optional. An explicit open counts as salience, so this tool declares `DatabaseService`. `readMemory` reaches the state plane through `bumpAccess`, and the dependency list makes that salience rule visible at the declaration site (`apps/mcp/src/tools.ts:412-417`). A search or recall hit does not move the plane.

**Output:** nine fields. `meta` is a flat `Record<string, string>` rather than a typed shape, because the head's optional metas are open at the edges and a client bound to a closed set would break on the first addition. Numbers arrive stringified because that is what the `<meta content>` attribute holds (`apps/mcp/src/handlers.ts:73-91`). `links` carries `rel` and `href` per authored link. `archived` is true when the head's status is `archived` (`apps/mcp/src/handlers.ts:518`).

`apps/mcp/src/tools.ts:409-435`

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
    degraded: Schema.Boolean
  })
})
```

Returns a context pack under a character budget. What fits gets a full body, and what does not gets one index line. Arcs are folded under their own envelope, so a synthesis cannot crowd out the evidence behind it.

**Input:** `query` required; `budget_chars` optional, defaulting to 16000 (`packages/index/src/disclosure.ts:23`, `packages/index/src/retrieval.ts:404`); `workspace` optional.

**Output:** `sections` with three arrays, plus `spent_chars`, `truncated`, and `degraded`. `arcs` and `memories` carry full bodies. `lateral` is the union of both folds' index lines, so it holds what did not fit the budget rather than the output of a third retrieval arm. Dropping it would make a truncated pack indistinguishable from a small corpus (`apps/mcp/src/handlers.ts:566-572`).

`apps/mcp/src/tools.ts:510-547`

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

**Input:** `paths`, an array of memory paths, and `signal`, one of `positive`, `negative`, `neutral` (`packages/domain/src/reinforce.ts:31`). The cooldown is 900 seconds per path (`packages/domain/src/ranking.ts:17`).

**Output:** `bumped`, the paths whose signal landed, and `cooled_down`, the paths the cooldown held back (`apps/mcp/src/handlers.ts:662-668`).

`apps/mcp/src/tools.ts:630-643`

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
    arms: Schema.Array(Schema.String),
    /** The `entity` this search was scoped to, or `null` when it was not scoped by entity. */
    entity_scope: Schema.NullOr(Schema.String),
    // …
    scope_empty: Schema.Boolean
  })
})
```

Runs ranked search over the corpus. It fuses the lexical, vector, recency, and salience arms with RRF and then diversifies the result.

**Input:** `query` required; the rest optional. `limit` defaults to 10 (`packages/index/src/retrieval.ts:29`). `memory_types` draws from the nine writable types. `entity` takes one reference in `type:name` form. That is the same spelling `memory_list` accepts and the same spelling a hit's `entities` publishes, so an agent chains by copying a value rather than reconstructing one (`apps/mcp/src/tools.ts:447-451`). `as_of` takes an ISO instant and returns what was believed valid at that moment, over the window `coalesce(valid_from, event_at, created_at) <= as_of < valid_until` (`apps/mcp/src/tools.ts:452-458`).

**Output:** `hits` plus four result-level fields. Each hit carries `snippet`, which holds the best-matching chunk's text for this query, or the file's opening chunk on the degraded path, truncated with a trailing ellipsis when cut. `superseded_by` is present and nullable so a client can tell "not superseded" from "this build does not report supersession" (`apps/mcp/src/tools.ts:485-491`). `degraded` is true when the vector arm did not fire. `arms` names the arms that ran. `scope_empty` is true when an `entity` scope narrowed the query and nothing survived, so an empty scoped result is attributable to the scope. A scope the tool could not satisfy is reported rather than widened (`apps/mcp/src/tools.ts:499-505`). Returning a path changes nothing on the access plane, because a hit is the ranker's guess rather than a deliberate open.

`apps/mcp/src/tools.ts:437-508`

## `memory_status`

```ts
const MemoryStatus = Tool.make("memory_status", {
  description: /* … */,
  dependencies: [Store, DatabaseService],
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

Reports corpus health in one call. It returns HEAD, dirty state, counts by type, edge totals, whether the index describes the current commit, and when sleep last ran.

**Input:** none. `parameters` is `Tool.EmptyParams` rather than `Schema.Struct({})`, because an empty struct derives a union with an array branch that a strict client may refuse to call, while `Tool.EmptyParams` derives `{"type":"object","additionalProperties":false}` (`apps/mcp/src/tools.ts:731-740`). The handler takes no argument (`apps/mcp/src/handlers.ts:743`).

**Output:** eight fields. `index_fresh` is true when the index's watermark is the current HEAD, which a row count cannot answer. `last_sleep` is null when no run is recorded, otherwise it carries `run_id`, `status`, and `started_at` (`apps/mcp/src/handlers.ts:755-762`). The failure suggestions point an agent at this read when a write fails on a dirty tree, a git error, or a storage error (`apps/mcp/src/failure.ts:111-117`).

`apps/mcp/src/tools.ts:727-760`

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

Writes one memory to the corpus. When an active memory already holds this exact content, the call returns that existing path with `deduped: true` and creates no file and no commit.

**Input:** `Schema.Struct(writeFields())`, thirteen fields shared with each `memory_write_batch` op (`apps/mcp/src/tools.ts:226-247`). Required: `title` and `memory_type`, the latter one of the nine writable types, since the sleep cycle writes `arc` itself (`apps/mcp/src/tools.ts:44-45`, `packages/contracts/src/types.ts:34-40`). Optional: `body`, `article_html`, `path`, `workspace`, `tags`, `entities`, `importance`, `confidence`, `session_id`, `prompt_id`, `turn_uuid`. Exactly one of `body` or `article_html` must be supplied. The handler enforces that rule rather than the schema, and a blank string counts as absent on both sides (`apps/mcp/src/handlers.ts:107-136`). On the prose path the first sentence becomes the `<mark>` claim and each blank-line paragraph becomes one `<p>`. On the markup path the caller owns the format, which includes the single `<mark>` rule, the closed element vocabulary, and the first `<time datetime>` becoming the memory's event time that the recency arm ranks by (`apps/mcp/src/tools.ts:133-144`).

**Output:** `path`, `created`, `deduped`, and `existing_path`. `existing_path` is present and nullable rather than optional, so a client can tell "this op did not dedupe" from "this server does not report dedupes" (`apps/mcp/src/tools.ts:284-288`).

`apps/mcp/src/tools.ts:249-264`

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
    commit_sha: Schema.NullOr(Schema.String)
  })
})
```

Writes many memories in one commit. It validates every op first, stages every surviving file, then commits and reindexes exactly once.

**Input:** `ops`, an array of `BatchOp`, which is `Schema.Struct(writeFields())` and therefore carries the same thirteen fields as `memory_write`, including the same one-of-`body`-or-`article_html` rule (`apps/mcp/src/tools.ts:277`). Both tools read the same field record, so adding a field cannot leave the two published schemas disagreeing (`apps/mcp/src/tools.ts:213-225`). `continue_on_error` switches from the atomic default to best-effort. `detect_conflicts` adds a per-op `conflict` field and changes nothing about what is written. `consolidate` accepts the single literal `"last-wins"`. A one-value `Literals` was used rather than a boolean so the vocabulary can widen without a shipped `true` changing meaning (`apps/mcp/src/tools.ts:377-382`). `session_id`, `prompt_id`, and `turn_uuid` are batch-level provenance that an op's own value overrides.

**Output:** `results`, `summary`, and `commit_sha`. `results` holds one `BatchOpResult` per op in input order, each with `index`, `ok`, `path`, `deduped`, `existing_path`, `code`, `error`, `skipped`, `conflict`, `consolidated_into`, and `superseded_path`. Every nullable field is present rather than optional, so an absent key never has to be read as a negative answer (`apps/mcp/src/tools.ts:280-341`). `conflict` names what an op's claim contradicts, by `path` for a stored active memory or by `batch_index` for an earlier op in the same call, plus that other claim's `claim` text. The handler translates both `batch_index` and `consolidated_into` from the survivor-array space `batchWrite` saw back into the caller's own op indices, so a refused op earlier in the batch cannot make a pointer name the wrong op (`apps/mcp/src/handlers.ts:446-488`). `summary` is derived from `results` in one pass so the counts cannot disagree with the array (`apps/mcp/src/handlers.ts:285-297`). `commit_sha` is null when nothing was written, which covers an all-deduped batch and an aborted one. An atomic abort does not arrive here at all. It reaches the caller through the error channel as `batchAbortFailure`, whose message names the offending op as `ops[N]` and states that nothing was written (`apps/mcp/src/failure.ts:206-219`, `apps/mcp/src/handlers.ts:431-444`).

`apps/mcp/src/tools.ts:343-407`

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

**Input:** `session_id` and `path`, both optional, but at least one required. A call that supplies neither is refused, rather than answered with every link ever recorded.

**Output:** `links`, each row carrying `path`, `session_id`, `prompt_id`, `turn_uuid`, `link_kind`, and `at`, with `prompt_id` and `turn_uuid` nullable (`apps/mcp/src/handlers.ts:730-739`).

`apps/mcp/src/tools.ts:704-725`

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

Finds past Claude Code sessions by what was asked in them. It reads a read-only index that stores pointers and capped heads rather than session content.

**Input:** `query` required; `cwd`, `since`, and `limit` optional. `limit` is clamped to 1..200 and defaults to 20 (`apps/cli/src/operations.ts:1610`).

**Output:** `sessions`, each row carrying `session_id`, `slug`, `cwd`, `started_at`, `prompt_count`, `first_prompt`, and `ai_title`, with `cwd`, `started_at`, and `ai_title` nullable (`apps/mcp/src/handlers.ts:709-719`).

`apps/mcp/src/tools.ts:678-702`

## See also

- [memhtml-public · Processes](../behavior/processes.md): 6 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 4 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 4 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 2 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 2 shared source citations

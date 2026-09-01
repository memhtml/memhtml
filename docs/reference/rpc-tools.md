# memhtml-public · RPC tools

This repository ships an MCP server, `memhtml-mcp`, over stdio. It publishes fifteen tools and three resource templates, and a coding agent calls it to operate a memhtml root. The repository stores no memory of its own. The server acts on whatever root `$MEMHTML_ROOT` points the process at, and the same binary serves many roots.

The server is one Effect layer that merges `McpServer.toolkit(MemhtmlToolkit)` with the three resources, over the CLI's own app layer, on the stdio transport at protocol revision `v2025_06_18`, the only adapter this dependency ships (`apps/mcp/src/server.ts:40-53`). The server shares the CLI's layer, so an agent's `memory_write` and an operator's `memhtml search` resolve to one database, one git root, and one vector space (`apps/mcp/src/server.ts:12-19`). Logs are pinned to stderr with `Logger.LogToStderr` because stdout carries the NDJSON-RPC frames, and Effect's default logger writes to stdout (`apps/mcp/src/server.ts:20-22`, `apps/mcp/src/server.ts:53`, `apps/mcp/src/bin.ts:7-13`).

Every tool binds its handler by name in `MemhtmlToolkit.toLayer({...})` (`apps/mcp/src/handlers.ts:309`). A handler decodes the snake_case wire parameters, calls the same operation function the matching CLI command calls, and renames the result back to snake_case (`apps/mcp/src/handlers.ts:33-43`).

Every tool declares `failure: ToolFailure`, a tagged error carrying a stable `ERR_*` code, a composed message, and suggestions phrased as tool calls the agent can make (`apps/mcp/src/failure.ts:32-39`). The declaration routes a failure down the branch that passes the message text through to the caller. Omitting it rewrites every failure, typed domain errors included, to a generic internal-error sentence before the caller sees it (`apps/mcp/src/tools.ts:33-41`, `apps/mcp/src/failure.ts:8-16`).

Three conventions apply to every entry below.

`Optional(X)` in a signature is `Schema.optionalKey(Schema.NullOr(X))`, so a client may omit the key, send a value, or send `null`, and the handler normalizes `null` and absence to the same thing (`apps/mcp/src/tools.ts:91`, `apps/mcp/src/handlers.ts:102`). `MemoryPath` is `Schema.String` holding a path relative to the root's git tree with no leading slash, such as `areas/oncall/rollback-order.html` (`apps/mcp/src/tools.ts:51-57`). `Count` is `Schema.Int` and `Finite` is `Schema.Finite`, chosen over `Schema.Number` so the published JSON Schema is a plain `{"type":"number"}` rather than a union with a string branch (`apps/mcp/src/tools.ts:59-71`).

Signatures are quoted verbatim from the registration site with two mechanical elisions, both marked where they occur. `description: /* … */,` stands for the description string, which for the write tools runs to several paragraphs assembled from shared constants (`apps/mcp/src/tools.ts:143-211`). `// …` stands for a nested doc comment explaining a schema choice. No identifier, schema, or punctuation is altered. Each entry's citation points at the full block.

### How the resources route

All three templates are registered by one helper, `templateLayer` (`apps/mcp/src/resources.ts:118`), which calls `McpServer.addResourceTemplate` directly rather than using the `McpServer.resource` tagged template. The reason is the router. `McpServer` matches a `resources/read` URI with find-my-way (`effect/unstable/http/FindMyWay`, effect `4.0.0-rc.109`), and two of that router's rules decide the pattern each resource registers, `memhtml:://<section>/*` (`apps/mcp/src/resources.ts:42`):

- A single `:` opens a NAMED PARAMETER and `::` is the escape for a literal colon, so the scheme's colon has to be doubled — left single, `memhtml:` registers a parameter named `""`.
- A named parameter's value ENDS AT THE NEXT `/`, so it matches exactly one segment. Every memory path has at least two segments and an archived one has at least four, so a single-segment route would leave the file resource unreachable in normal use. `*` is the rest parameter, the only construct that matches across `/`, and the router requires it to be the pattern's LAST character. The tagged template compiles its parameters to named parameters, which is why it is not used here.

The captured value does not arrive through the parameter array: `McpServer` folds a matched route's parameters into a POSITIONAL array by `Number(name)`, and `Number("*")` is `NaN`, so the slot is never filled. Each handler reads its one parameter back out of the URI with `capturedOf` (`apps/mcp/src/resources.ts:63`), which requires the `memhtml://<section>/` prefix VERBATIM — the router tolerates repeated slashes and this does not, so `memhtml:///file/x.html` matches the route and is then refused, rather than being sliced at an offset a character away from the one that matched. One `decodeURIComponent` covers both spellings a client can send, so `areas/oncall/x.html` and `areas%2Foncall%2Fx.html` name the same resource.

The RFC 6570 templates `resources/templates` publishes are LITERALS on each spec (`RESOURCE_TEMPLATES`, `apps/mcp/src/resources.ts:250`) rather than composed from the route, so the template a client reads and the route the server matches are two independent readings of one URI shape. `tests/resources.test.ts` builds its request URI out of the PUBLISHED template and expects the read to resolve, so a template that drifted from its route fails a read rather than a literal comparison.

**Every failure is sanitized, and no handler dies.** A defect becomes a stated refusal through `catchDefect` and a typed failure becomes one through `toResourceFailure`, both after `tapCause` has put the real cause on stderr where an operator reads it (`apps/mcp/src/resources.ts:130-146`). An `Effect.orDie` in their place hands the client `Cause.prettyErrors(cause)[0].message`: an absolute filesystem path for a missing sleep report, and a `PathNotFound` stripped of its `ERR_*` code and its suggestions.

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
      // …
    })
})
```

Returns one memory's title, claim, and body text AS OF a commit: a citation whose bytes cannot move.

**Input:** two holes, captured as one rest parameter and split at the FIRST `/`. A commit sha cannot contain a slash and a memory path must, so that separator is the only place the split can be. The commit half must match `/^[0-9a-f]{7,64}$/` — git's abbreviation floor through the width of SHA-256 — so `HEAD`, a branch, and a tag are all refused, which is the whole contract: a URI whose target can move is not a citation, and `memhtml://at/main/x.html` would read as a pin while resolving to different bytes next week. Hex also keeps a leading `-` out of `git ls-tree`'s argv. The path half is gated by `isValidMemoryPath` for `memhtml://file/{path}`'s reason, since a rest parameter accepts `..` (`apps/mcp/src/resources.ts:255-274`).

**Output:** a `text/plain` body in the same shape `memhtml://file/{path}` returns, parsed from the HISTORICAL bytes. `lsTreeR` resolves the path in that commit's tree to a blob sha and `catFileBatch` reads the object, so a path since corrected, archived, or evicted still reads. A submodule entry is an `objectType` of `commit`, holds no memory, and is refused rather than read.

**This read does NOT bump salience, where `memhtml://file/{path}` does.** `state.access` is keyed on PATH with no notion of a commit, so a bump would credit whatever occupies that path today for a read of a version it may not contain. Verifying a receipt is auditing rather than choosing. The resource declares `Store` and not `IndexRecorder`, which makes the refusal structural.

**Refusal:** `ERR_PATH_NOT_FOUND` for an unknown commit, a path absent from a known commit, a movable ref, and an unusable path alike — from a client's side those are one answer, "this URI names nothing here", and the real cause goes to stderr. Its suggestions name the published template form and `memory_resolve` for the path a memory occupies now (`apps/mcp/src/resources.ts:268-274`).

`memory_resolve` publishes a ready-made URI for this template as `pinned_uri`, so a client stores a citation without composing one.

`apps/mcp/src/resources.ts:311-350`

## `memhtml://file/{path}`

```ts
export const FileResource = templateLayer({
  section: "file",
  uriTemplate: "memhtml://file/{path}",
  name: "Memory file",
  description:
    "One memory's title, claim, and body text, by repo-root-relative path. For showing a human the file behind an answer.",
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

Returns one memory's readable text by path, for a client that holds a path from `memory_search` and wants to show a human the file behind an answer without spending a tool call. The rest parameter is what makes a multi-segment PARA path such as `areas/oncall/rollback-order.html` resolve.

**Input:** the whole tail after `memhtml://file/`, as a repo-root-relative path. `isValidMemoryPath` gates it before the store sees it, and that gate is CONTAINMENT rather than validation: the rest parameter accepts `/`, so it also accepts `../../etc/passwd`, and the store's reader joins a repo-relative path onto the git root with no traversal check of its own. The gate refuses any path carrying a `.` or `..` segment, any path outside the four PARA buckets, and anything not ending in `.html` — which is every memory path and nothing else.

**Output:** a `text/plain` body holding an H1 of the title, the gist, then the article body text, joined by newlines. The BODY is returned and not the raw HTML file: a client asking a resource for a citation wants the text a human reads, and handing back a full document with a head full of `memhtml-*` metas would spend the client's rendering budget on bookkeeping. Head metadata is `memory_read`'s job. A missing path fails the read rather than resolving to an empty resource, because a citation that silently resolves to nothing is worse than one that says the file is gone. This read bumps salience through the same `readMemory` the `memory_read` tool calls: the caller named one specific path, which is a chosen open, and the plane should not be able to tell the two surfaces apart.

**Refusal:** `ERR_PATH_NOT_FOUND`, whose suggestions name the published template form and point at `memory_search` / `memory_list` for a path this corpus holds (`apps/mcp/src/resources.ts:153`).

`apps/mcp/src/resources.ts:182-226`

## `memhtml://sleep/{run-id}`

```ts
export const SleepResource = templateLayer({
  section: "sleep",
  uriTemplate: "memhtml://sleep/{run-id}",
  name: "Sleep run report",
  description:
    "One sleep run's committed HTML report: per-phase counts, commits, and what the run changed.",
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

**Input:** the run id, taken VERBATIM in the `sleep/<date>` spelling `memory_status.last_sleep.run_id` publishes, so the value a client copies out of a status call is the value this resource takes.

**Output:** a `text/html` body read from the root's tree under `.memhtml/sleep/`. The filename comes from `reportFilename`, imported from `@memhtml/sleep` — the same function the report phase writes the file with, which folds each `/` in the run id to a hyphen so `sleep/2026-08-02` is `sleep-2026-08-02.html`. Deriving that rule here a second time would be the consumer-side reimplementation of a producer's naming semantics this repo forbids; importing it means the two cannot disagree, and it contains the read for free, since folding every `/` leaves a caller no way to name a directory. The resource reads the tree rather than the database, because the committed report is the durable artifact of a run and the `sleep_runs` row exists for reporting convenience.

**Refusal:** `ERR_PATH_NOT_FOUND`, suggesting `memory_status` for the id and status of the last run, and noting that a run `memory_status` does name whose report is absent never committed one (`apps/mcp/src/resources.ts:205`).

`apps/mcp/src/resources.ts:228-248`

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
    // …
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

Pages through the corpus by facet. A keyset cursor on the path keeps a page correct while a sleep cycle archives files.

**Input:** every parameter optional. `memory_type` is one of the nine writable types; `para` is one of `projects`, `areas`, `resources`, `archive` (`packages/contracts/src/types.ts:63`); `entity` takes the same `type:name` spelling `memory_search` accepts; `facets` takes `name=value` specs over the article's authored `<dl>` pairs, composed exactly as `memory_search` composes them — AND across distinct names, OR within one name — and matched as TEXT with no case fold; `limit` is clamped to 1..500 and defaults to 50.

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
    rels: Optional(Schema.Array(MemoryRelSchema)),
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
        derived: Schema.Boolean
      })
    ),
    edges: Count,
    node_limit: Count,
    dropped_node_count: Count,
    scan_saturated: Schema.Boolean
  })
})
```

Returns the memory graph around one path, to at most two hops, in both directions, and includes sleep-mined edges. Lateral retrieval is what those mined edges are for, which is why each node says whether one reached it.

**Input:** `path` required; `depth` optional and clamped to 1..2 with a default of 1 (`apps/cli/src/operations.ts:1218`); `rels` an optional array drawn from the same nine MEMORY-class rels `memory_link` accepts; `limit` the ceiling on distinct paths in `nodes`, clamped into `1..NEIGHBORS_LIMIT` (200) rather than refused, which is the shape `memory_list` and `trace_search` already have (`apps/cli/src/operations.ts:1090`, `apps/cli/src/operations.ts:1219-1221`).

**Output:** `nodes`, each carrying `path`, `title`, `hop` (1 or 2, never 0), `rel`, and `derived`, plus four scalars: `edges`, `node_limit`, `dropped_node_count`, and `scan_saturated`. `apps/mcp/src/handlers.ts:645-665`

`derived` is true when a SLEEP-MINED edge reaches the node and false when only authored `<link>` edges do. It is the max over every edge that reached the node rather than `rel`'s companion, because the question a caller asks of it is whether the connection may be a machine's suspicion, and one mined route is enough for that answer to be yes. Without the field a caller cannot tell a suspicion from an assertion, which is exactly what it needs in order to decide how far to trust a lateral hop.

**`edges` is not a node count and must not be read as one.** It counts DISTINCT edges the walk enumerated, keyed on `(src, rel, dst)`, over both hops and both directions — so two memories joined by two rels are one node and two edges, and an edge landing on a path the node clamp dropped is counted here and absent from `nodes`. Its scope is this one call's walk, not the corpus: `memory_status.edges` is the corpus total, and the two are different coordinate spaces.

**Two markers report truncation, because the recoveries differ.** `dropped_node_count` is the distinct paths the walk reached and `node_limit` turned away, so `nodes.length + dropped_node_count` is every path the walk found and a larger `limit` returns them; `0` is how a client tells a complete neighborhood from a clamped one. `scan_saturated` is the walk stopping at its own 10000-edge-row cap, so edges past the cap were never enumerated and no `limit` recovers them — narrow with `rels` or `depth: 1` instead. It is a plain boolean rather than a nullable one, because an absent marker cannot be told from a server that does not report saturation.

`node_limit` echoes the ceiling the answer was built under — the SERVER's clamp, not the raw ask — so a client that sent 10000 reads back 200 and knows the bound is a ceiling rather than a corpus fact. It is named `node_limit` and not `limit` because the answer carries two bounds that are not interchangeable: this one governs `nodes`, and the 10000-row scan cap governs everything. `dropped_node_count` carries the `_count` suffix because it is a quantity, and this repo's four numeric suffixes are not interchangeable; `edges` keeps its bare name because it is already a published field clients branch on.

`apps/mcp/src/tools.ts:631-717`

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

## `memory_resolve`

```ts
const MemoryResolve = Tool.make("memory_resolve", {
  description: /* … */,
  dependencies: READS(),
  parameters: Schema.Struct({ path: MemoryPath }),
  failure: ToolFailure,
  success: Schema.Struct({
    requested: MemoryPath,
    path: MemoryPath,
    hops: Count,
    steps: Schema.Array(
      Schema.Struct({
        from: MemoryPath,
        to: MemoryPath,
        // …
        via: Schema.Literals(RESOLVE_STEP_VIA)
      })
    ),
    stop_reason: Schema.Literals(RESOLVE_STOP_REASONS),
    title: Schema.NullOr(Schema.String),
    // …
    indexed_commit: Schema.NullOr(Schema.String),
    // …
    pinned_uri: Schema.NullOr(Schema.String)
  })
})
```

Follows a path an older answer, receipt, or external citation recorded FORWARD to the memory that carries the fact now. A path is the id of a memory and it is derived from the title, so a correction that rewords the title moves the file and the cited path stops resolving through no fault of the citation.

**Input:** `path` only. The walk follows both mechanisms that move a memory and neither is optional, and the hop bound is a property of the answer rather than a preference.

**Output:** `stop_reason` decides whether the answer is citable, and only `live` means yes. `archived` is a memory EVICTED rather than corrected, so nothing supersedes it. `unindexed` is no such path here, which can also mean the index does not yet describe the commit that holds it — `indexed_commit` names the commit it does describe. `cycle` is two memories each claiming to supersede the other, an authoring defect. `hop_limit` means `path` is where the walk stopped rather than the end of the chain, so resolving it again continues. The five values are the shipped enum `RESOLVE_STOP_REASONS`, spelled exactly as `live`, `archived`, `unindexed`, `cycle`, `hop_limit`.

`steps` names each hop's mechanism from a closed vocabulary — `supersedes` for an authored `<link>` inside a file, `archive_move` for a `git mv` recorded by `origin_path` — and every node is named by the path holding that memory NOW, because a `supersedes` link travels with the file that carries it.

`pinned_uri` is a `memhtml://at/{commit}/{path}` URI for `path` at `indexed_commit`, composed by the server because the URI's spelling belongs to the resource that routes it. It is null when there is no commit to pin to and when `stop_reason` is `unindexed`, the one ending whose path that commit does not hold — a citation the same server would refuse is not a citation.

`hops: 0` with `stop_reason: live` does NOT mean the bytes are unchanged: a correction whose title did not change lands at the same path. `pinned_uri` is the grain that answers that.

`apps/mcp/src/tools.ts:767-824`

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
    arms: Schema.Array(Schema.String),
    /** The `entity` this search was scoped to, or `null` when it was not scoped by entity. */
    entity_scope: Schema.NullOr(Schema.String),
    // …
    scope_empty: Schema.Boolean
  })
})
```

Runs ranked search over the corpus. It fuses the lexical, vector, recency, and salience arms with RRF and then diversifies the result.

**Input:** `query` required; the rest optional. `limit` defaults to 10 (`packages/index/src/retrieval.ts:29`). `memory_types` draws from the nine writable types. `entity` takes one reference in `type:name` form. That is the same spelling `memory_list` accepts and the same spelling a hit's `entities` publishes, so an agent chains by copying a value rather than reconstructing one (`apps/mcp/src/tools.ts:447-451`). `facets` takes `name=value` specs over the article's authored `<dl>` pairs. The composition is a semantic contract rather than a convenience: values under the SAME name broaden (OR) and different names narrow (AND), so `["doc-type=runbook", "doc-type=guide"]` is either and `["doc-type=runbook", "tier=1"]` is both — and a caller who read it the other way round acts on a superset or on an empty set, neither of which the rows report. Matched as TEXT with no case fold, unlike `entity`: a facet is the consumer's own machine-written vocabulary. A spec with an empty half is dropped rather than refused, so a malformed one widens the answer instead of narrowing it, and the rows cannot report that either. `as_of` takes an ISO instant and returns what was believed valid at that moment, over the window `coalesce(valid_from, event_at, created_at) <= as_of < valid_until` (`apps/mcp/src/tools.ts:452-458`).

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

**Input:** `Schema.Struct(writeFields())`, thirteen fields shared with each `memory_write_batch` op (`apps/mcp/src/tools.ts:226-247`). Required: `title` and `memory_type`, the latter one of the nine writable types, since the sleep cycle writes `arc` itself (`apps/mcp/src/tools.ts:44-45`, `packages/contracts/src/types.ts:34-40`). Optional: `body`, `article_html`, `path`, `strict_path`, `workspace`, `tags`, `entities`, `importance`, `confidence`, `session_id`, `prompt_id`, `turn_uuid`. `strict_path` opts out of the lenient default: an explicit `path` that is not a usable memory path is re-derived through the placement rule and reported as a success at some other path, and `strict_path: true` makes it `ERR_INVALID_MEMORY` with nothing written, staged, or committed. It is published on every `memory_write_batch` op too, through the same `writeFields()`. Exactly one of `body` or `article_html` must be supplied. The handler enforces that rule rather than the schema, and a blank string counts as absent on both sides (`apps/mcp/src/handlers.ts:107-136`). On the prose path the first sentence becomes the `<mark>` claim and each blank-line paragraph becomes one `<p>`. On the markup path the caller owns the format, which includes the single `<mark>` rule, the closed element vocabulary, and the first `<time datetime>` becoming the memory's event time that the recency arm ranks by (`apps/mcp/src/tools.ts:133-144`).

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
    near_duplicates_degraded: Schema.Boolean
  })
})
```

Writes many memories in one commit. It validates every op first, stages every surviving file, then commits and reindexes exactly once.

**Input:** `ops`, an array of `BatchOp`, which is `Schema.Struct(writeFields())` and therefore carries the same thirteen fields as `memory_write`, including the same one-of-`body`-or-`article_html` rule (`apps/mcp/src/tools.ts:277`). Both tools read the same field record, so adding a field cannot leave the two published schemas disagreeing (`apps/mcp/src/tools.ts:213-225`). `continue_on_error` switches from the atomic default to best-effort. `detect_conflicts` adds a per-op `conflict` field and changes nothing about what is written. `detect_near_duplicates` adds a per-op `near_duplicates` list — the vector sibling of the frame-key assist, catching rewordings the grammatical rule refuses to key — and likewise changes nothing about what is written; it costs one document-space embedding call per batch. `consolidate` accepts the single literal `"last-wins"`. A one-value `Literals` was used rather than a boolean so the vocabulary can widen without a shipped `true` changing meaning (`apps/mcp/src/tools.ts:377-382`). `session_id`, `prompt_id`, and `turn_uuid` are batch-level provenance that an op's own value overrides.

**Output:** `results`, `summary`, and `commit_sha`. `results` holds one `BatchOpResult` per op in input order, each with `index`, `ok`, `path`, `deduped`, `existing_path`, `code`, `error`, `skipped`, `conflict`, `near_duplicates`, `consolidated_into`, and `superseded_path`. Every nullable field is present rather than optional, so an absent key never has to be read as a negative answer (`apps/mcp/src/tools.ts:280-341`). `conflict` names what an op's claim contradicts, by `path` for a stored active memory or by `batch_index` for an earlier op in the same call, plus that other claim's `claim` text. `near_duplicates` lists what an op's text embedding-matches at or above cosine 0.92, each entry carrying `path` or `batch_index`, the measured `similarity`, and the other `claim`; it is null when the flag was off, when nothing matched, on an `article_html` op, and whenever the top-level `near_duplicates_degraded` is true — that flag means the assist could not run (no embedder bound, or the call failed), so null then reads as unchecked rather than unique. The handler translates `batch_index` (on `conflict` and on every `near_duplicates` entry) and `consolidated_into` from the survivor-array space `batchWrite` saw back into the caller's own op indices, so a refused op earlier in the batch cannot make a pointer name the wrong op (`apps/mcp/src/handlers.ts:486-526`). `summary` is derived from `results` in one pass so the counts cannot disagree with the array (`apps/mcp/src/handlers.ts:285-297`). `commit_sha` is null when nothing was written, which covers an all-deduped batch and an aborted one. An atomic abort does not arrive here at all. It reaches the caller through the error channel as `batchAbortFailure`, whose message names the offending op as `ops[N]` and states that nothing was written (`apps/mcp/src/failure.ts:206-219`, `apps/mcp/src/handlers.ts:431-444`).

`apps/mcp/src/tools.ts:468-548`

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

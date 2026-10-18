# memhtml-public · Sequences

Describes the source at 0.15.1 (main bdd9be4, 2026-09-30). Citations are `path:line` into that tree.

These two diagrams show the call order of `memhtml write` and `memhtml search`. Each participant is a file, a package, or an Effect service tag defined in this repository, apart from the human or agent at the terminal. Each arrow is a call that the source makes, and the section under each diagram cites it.

All three flows act on the memhtml root, the separate memory tree that `--repo` or `MEMHTML_ROOT` names (`apps/cli/src/api-layer.ts:104-116`). `DatabaseService` is one connection to that root's `.memhtml/index.db` with `state.db` attached (`apps/cli/src/api-layer.ts:126-136`). `Git` runs `git` subprocesses in that root (`packages/store/src/git.ts:216-222`).

Every CLI command runs its dispatch arm over `layerApp`, the one production composition (`apps/cli/src/run.ts:1797-1807`, `apps/cli/src/api-layer.ts:608-632`). A handler in the MCP server reaches the same operations through the same layer. For example, `memory_write` calls `writeMemory` at `apps/mcp/src/handlers.ts:333` and `memory_search` calls `searchMemories` at `apps/mcp/src/handlers.ts:566`. The MCP door itself is drawn in `architecture/data-flow.md`.

## memhtml write

```mermaid
sequenceDiagram
    actor Agent
    participant Bin as bin.ts (apps/cli)
    participant Run as run.ts (apps/cli)
    participant Ops as operations.ts (apps/cli)
    participant Store as Store (@memhtml/store)
    participant Html as @memhtml/html
    participant Recorder as IndexRecorder (@memhtml/index)
    participant Git as Git (@memhtml/store)
    participant Indexer as Indexer (@memhtml/index)
    participant IndexGit as IndexGit (@memhtml/index)
    participant Db as DatabaseService (index.db)
    participant Emb as Embeddings (@memhtml/llm)

    Agent->>Bin: memhtml write --title --claim --type
    Bin->>Run: run(argv)
    Run->>Run: parseArgv, validate, envRootRefusal
    Run->>Ops: writeMemory(params)
    Ops->>Store: writeMemory(toWriteInput(params))
    Note over Store: one write permit, then strictPathRefusal
    Store->>Html: renderTemplate, checkMemory
    Store->>Recorder: dedupeLookup(contentHash)
    Recorder->>Db: SELECT path FROM files
    Recorder-->>Store: existing path or null
    opt no active duplicate
        Store->>Store: freePathFor, writeFileAt
        Store->>Git: add, commit with trailers
        Git-->>Store: commit sha
    end
    Store-->>Ops: WriteResult
    opt a file was created
        Ops->>Indexer: update(embed true)
        Indexer->>IndexGit: revParseHead, diffNameStatus, statusPorcelainV2
        Indexer->>IndexGit: lsTreeR, catFileBatch
        Indexer->>Db: writeAll projection, then the index_state watermark
        Indexer->>Emb: embed(chunk texts)
        Emb-->>Indexer: vectors
        Indexer->>Db: writeAll embeddings
        Indexer-->>Ops: update report
    end
    opt the call carries a session id
        Ops->>Recorder: recordLink(wrote)
    end
    Ops-->>Run: WriteResult
    Run-->>Bin: memory.written envelope
    Bin-->>Agent: stdout, exit code
```

### Write call sites

`Agent->>Bin` and `Bin->>Run`: the binary calls `run(process.argv.slice(2))`, and the envelope it returns is the only thing written to stdout (`apps/cli/src/bin.ts:5`).

`Run->>Run`: `run` parses argv with `parseArgv` at `apps/cli/src/run.ts:1430`. Help and the bare manifest answer first (`apps/cli/src/run.ts:1440-1444`). `validate` then refuses a bad call at exit 2 before any service is built (`apps/cli/src/run.ts:1446-1447`). `envRootRefusal` refuses a root taken from the environment when `MEMHTML_REFUSE_ENV_ROOT` is set (`apps/cli/src/run.ts:1665-1666`).

`Run->>Ops`: the `write` dispatch arm calls `ops.writeMemory` and names the response type `memory.written` (`apps/cli/src/run.ts:348-368`).

`Ops->>Store`: `writeMemory` decodes the parameters with `toWriteInput` and calls `store.writeMemory` (`apps/cli/src/operations.ts:335-339`). The decode checks the type against the operator vocabulary and checks a task's status and due date before any file is rendered (`apps/cli/src/operations.ts:293-327`).

The note on `Store`: the store's `writeMemory` runs under one in-process permit, so two writers take turns (`oneWriterAtATime`, `packages/store/src/store.ts:1400`, `packages/store/src/store.ts:1405`). Its first gate is `strictPathRefusal` (`packages/store/src/store.ts:709`, `packages/store/src/store.ts:692-705`).

`Store->>Html`: `renderFor` calls `renderTemplate` (`packages/store/src/store.ts:642`), and `renderChecked` fails with `InvalidMemory` on any `checkMemory` violation before the file is written (`packages/store/src/store.ts:661-668`). Both functions are imported from `@memhtml/html` (`packages/store/src/store.ts:22-31`).

`Store->>Recorder` and `Recorder->>Db`: the store hashes the rendered bytes and calls its injected `dedupeLookup` (`packages/store/src/store.ts:713-719`). The composition injects the recorder's `activePathForHash` (`apps/cli/src/api-layer.ts:203`), which is one query for a live, non-archived, non-task row with that hash (`packages/index/src/traces-persist.ts:196-203`). A match returns `deduped: true` with no file and no commit (`packages/store/src/store.ts:720-729`).

`Store->>Store`: `freePathFor` picks a free path (`packages/store/src/store.ts:731-739`), and `writeFileAt` writes the file with `node:fs` (`packages/store/src/store.ts:752`, `packages/store/src/store.ts:460-465`).

`Store->>Git` and `Git-->>Store`: the store calls `git.add` and `git.commit` with provenance trailers (`packages/store/src/store.ts:753-756`). The `add` member of `Git` runs `git add` (`packages/store/src/git.ts:390-393`), and its `commit` member runs `git commit` and then `git rev-parse HEAD` for the sha (`packages/store/src/git.ts:397-412`). The write, the stage, and the commit run under a journal that compensates a failure (`makeJournal`, `packages/store/src/store.ts:747-758`).

`Store-->>Ops`: the result carries the path, `created`, `deduped`, the commit sha, and the content hash (`packages/store/src/store.ts:760-766`).

`Ops->>Indexer`: only a created file triggers `reindex` (`apps/cli/src/operations.ts:341`), which calls `indexer.update({ embed: true })` (`apps/cli/src/operations.ts:267-271`).

`Indexer->>IndexGit`: `update` reads HEAD at `packages/index/src/indexer.ts:811`, diffs the watermark against it with `diffNameStatus` at `packages/index/src/indexer.ts:857`, and reads uncommitted changes with `statusPorcelainV2` at `packages/index/src/indexer.ts:858`. It reads the changed blobs with `lsTreeR` and `catFileBatch` (`packages/index/src/indexer.ts:873`, `packages/index/src/indexer.ts:880`). `IndexGit` is the store's `Git` wrapped by `makeGitPort` (`apps/cli/src/api-layer.ts:162-163`).

`Indexer->>Db`, first arrow: `applyProjectionWrites` sends the projection through `db.writeAll` in batches (`packages/index/src/indexer.ts:994`, `packages/index/src/indexer.ts:284`). `writeState` then records the new watermark in `index_state` (`packages/index/src/indexer.ts:995`, `packages/index/src/indexer.ts:439-441`).

`Indexer->>Emb` and `Emb-->>Indexer`: `embedMissing` runs over the chunks this pass projected (`packages/index/src/indexer.ts:1002`) and calls `embeddings.embed` one slice at a time (`packages/index/src/indexer.ts:577`). The port is the embedder's document half (`apps/cli/src/api-layer.ts:272`). The `embed` member of `Embeddings` sends each chunk of texts to Bedrock through `embedChunk` with `invokeJson` (`packages/llm/src/embeddings.ts:136-141`, `packages/llm/src/embeddings.ts:116`).

`Indexer->>Db`, second arrow: each slice's vectors are written through `applyWrites`, the same batched `writeAll` (`packages/index/src/indexer.ts:606`). When a slice comes back as a `Failure`, the pass ends and keeps every vector already written, so an embedder outage does not fail the write (`packages/index/src/indexer.ts:585`).

`Ops->>Recorder`: `recordLink` writes a `wrote` session link when the call carries a session id, and logs a failure instead of raising it (`apps/cli/src/operations.ts:342`, `apps/cli/src/operations.ts:201-217`).

`Run-->>Bin` and `Bin-->>Agent`: a success becomes an envelope at exit 0, and a typed failure goes through `failureFor` at exit 1 (`apps/cli/src/run.ts:1798-1799`, `apps/cli/src/errors.ts:212`). The codes are `EXIT_OK`, `EXIT_USAGE`, and `EXIT_RUNTIME` (`apps/cli/src/envelope.ts:120-122`). The binary calls `process.exit` from the write callback, so a slow pipe reader still gets the whole envelope (`apps/cli/src/bin.ts:22`).

The diagram leaves out the indexer's two early exits. With no watermark row from `readState`, `update` reprojects the whole tree (`packages/index/src/indexer.ts:812`, `packages/index/src/indexer.ts:821-822`). With a watermark a rebuild left empty, it fails with `IndexStale` (`packages/index/src/indexer.ts:842-845`). The batch door, `memhtml apply`, calls `ops.batchWrite` instead (`apps/cli/src/run.ts:377-379`), and `architecture/data-flow.md` covers the rest of the write steps.

## memhtml search

```mermaid
sequenceDiagram
    actor Agent
    participant Bin as bin.ts (apps/cli)
    participant Run as run.ts (apps/cli)
    participant Ops as operations.ts (apps/cli)
    participant Retrieval as Retrieval (retrieval.ts)
    participant Fts as fts-query.ts
    participant Sql as retrieval-sql.ts
    participant Emb as Embeddings (@memhtml/llm)
    participant Db as DatabaseService (index.db)
    participant Polarity as polarity.ts
    participant Mmr as mmr.ts (@memhtml/domain)

    Agent->>Bin: memhtml search "prose"
    Bin->>Run: run(argv)
    Run->>Ops: searchMemories(query, limit, scope)
    Ops->>Retrieval: search(params)
    Retrieval->>Db: readVectorCoverage
    opt coverage at the floor or above, and an embedder bound
        Retrieval->>Emb: embedQuery(query)
        Emb-->>Retrieval: vector, or undefined on failure
    end
    Retrieval->>Fts: ftsQueryForms(query)
    opt the all-terms and any-of forms differ
        Retrieval->>Db: all-terms probe, LIMIT 1
    end
    Retrieval->>Sql: buildRrfSql(active arms)
    Retrieval->>Db: fused RRF statement
    Db-->>Retrieval: fused paths, three times the limit
    Retrieval->>Db: hydrate rows
    Retrieval->>Polarity: polarityScored
    Retrieval->>Mmr: applyMmr(limit, 0.5)
    Retrieval->>Db: snippets for the final paths
    opt a named scope matched nothing
        Retrieval->>Db: archivedInScope
    end
    Retrieval-->>Ops: hits, degraded, vectorCoverage, arms, scope flags
    Ops-->>Run: search result
    Run-->>Bin: memory.hits envelope
    Bin-->>Agent: stdout, exit code
```

### Search call sites

`Agent->>Bin` through `Run->>Ops`: the binary and `run` behave as in the write flow. The `search` arm calls `ops.searchMemories` with the query, the limit, and the shared scope, and names the response type `memory.hits` (`apps/cli/src/run.ts:415-423`). The scope comes from one helper that `search` and `recall` share (`apps/cli/src/run.ts:264-274`).

`Ops->>Retrieval`: `searchMemories` takes `Retrieval` and delegates (`apps/cli/src/operations.ts:1188-1192`). It records no access bump, so a ranked hit does not feed back into salience (`apps/cli/src/operations.ts:1180-1186`).

`Retrieval->>Db`, coverage: `search` first calls `gatedQueryVector` (`packages/index/src/retrieval.ts:505`), which calls `readVectorCoverage` (`packages/index/src/retrieval.ts:306`, `packages/index/src/vector-coverage.ts:100-111`). Below the floor, `VECTOR_COVERAGE_FLOOR` or 0.95 by default, the query is never embedded (`packages/index/src/retrieval.ts:307-313`, `packages/index/src/vector-coverage.ts:44`). The floor comes from `RetrievalPolicy` (`apps/cli/src/api-layer.ts:341`).

`Retrieval->>Emb` and `Emb-->>Retrieval`: `queryVector` returns `undefined` when no embedder is bound. Otherwise it calls `embedQuery`, logs a failure, and turns it into `undefined` (`packages/index/src/retrieval.ts:315`, `packages/index/src/retrieval.ts:262-276`). `embedQuery` embeds one text with the `search_query` input type (`packages/llm/src/embeddings.ts:142-144`).

`Retrieval->>Fts`: `fuse` never matches the caller's prose. It asks `ftsQueryForms` for an all-terms form and an any-of form (`packages/index/src/retrieval.ts:350`, `packages/index/src/fts-query.ts:99`).

`Retrieval->>Db`, probe: when the two forms differ, `holdsEveryTerm` runs one `LIMIT 1` statement from `buildFtsProbeSql` to decide which form to bind (`packages/index/src/retrieval.ts:351-354`, `packages/index/src/retrieval.ts:279-292`, `packages/index/src/retrieval-sql.ts:149`).

`Retrieval->>Sql`: `buildRrfSql` folds the arms that can fire into one statement (`packages/index/src/retrieval.ts:355-360`, `packages/index/src/retrieval-sql.ts:307-311`). The registry holds four arms: lexical, vector, recency, and salience (`packages/index/src/retrieval-sql.ts:268`). In `activeArms`, an arm leaves the fold when it lacks a query vector, the state plane, or query terms (`packages/index/src/retrieval-sql.ts:288-295`). With no arm left, the `sql` is `undefined` and `fuse` returns no paths (`packages/index/src/retrieval.ts:361`).

`Retrieval->>Db`, fused statement: one `db.all` returns the fused paths (`packages/index/src/retrieval.ts:370`). The pool is `MMR_POOL_FACTOR` times the limit, and `DEFAULT_SEARCH_LIMIT` is 10 (`packages/index/src/retrieval.ts:510`, `packages/index/src/retrieval.ts:43`, `packages/index/src/retrieval.ts:49`).

`Retrieval->>Db`, hydrate: one statement reads each fused path's row, entities, superseding edge, and first chunk vector (`packages/index/src/retrieval.ts:513`, `packages/index/src/retrieval.ts:400-419`).

`Retrieval->>Polarity`: `polarityScored` gives each candidate a score from its fused rank and demotes a negation-flipped twin (`packages/index/src/retrieval.ts:526-529`, `packages/index/src/polarity.ts:78`).

`Retrieval->>Mmr`: `applyMmr` reorders the pool down to the limit with `MMR_LAMBDA` of 0.5 (`packages/index/src/retrieval.ts:535`, `packages/domain/src/mmr.ts:36`, `packages/domain/src/ranking.ts:11`).

`Retrieval->>Db`, snippets: `snippets` runs over the final paths only and keeps each file's best chunk from one `buildSnippetSql` statement (`packages/index/src/retrieval.ts:541-544`, `packages/index/src/retrieval.ts:437-447`, `packages/index/src/retrieval-sql.ts:343`).

`Retrieval->>Db`, archived: when a named scope left nothing, `archivedInScope` counts the archived rows in the same scope (`packages/index/src/retrieval.ts:545-554`, `packages/index/src/retrieval.ts:470-489`).

`Retrieval-->>Ops` through `Bin-->>Agent`: the result carries the hits and the response flags (`packages/index/src/retrieval.ts:556-593`). `degraded` is true whenever the search ran without a query vector, for any of the three reasons above (`packages/index/src/retrieval.ts:581`). The envelope and exit follow the write flow.

The diagram folds the SQL each arm contributes into the one `fused RRF statement` message. The arm bodies live in `packages/index/src/retrieval-sql.ts`, and `recall` follows the same path up to fusion (`packages/index/src/retrieval.ts:596-600`).

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at bdd9be4.

- [memhtml-public · Processes](../../behavior/processes.md): 25 shared source citations
- [memhtml-public · Module map](../../architecture/module-map.md): 20 shared source citations
- [memhtml-public · Data flow](../../architecture/data-flow.md): 18 shared source citations
- [memhtml-public · CLI](../../reference/cli.md): 17 shared source citations
- [memhtml-public · Contract map](../../insights/contract-map.md): 17 shared source citations
- [memhtml-public · Business logic](../../insights/business-logic.md): 16 shared source citations
- [memhtml-public · Impact analysis](../../insights/impact-analysis.md): 16 shared source citations
- [memhtml-public · Debugging guide](../../insights/debugging-guide.md): 15 shared source citations
- [memhtml-public · Components](../architecture/components.md): 13 shared source citations
- [memhtml-public · State machines](../../behavior/state-machines.md): 12 shared source citations
- [memhtml-public · RPC tools](../../reference/rpc-tools.md): 10 shared source citations
- [memhtml-public · Public API](../../reference/public-api.md): 9 shared source citations
- [memhtml-public · System overview](../../architecture/system-overview.md): 9 shared source citations
- [memhtml-public · Dependency graph](../structural/dependency-graph.md): 6 shared source citations

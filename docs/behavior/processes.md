# memhtml-public · Processes

Describes the source at 0.15.1 (main e027765, 2026-10-01). Citations are `path:line` into that tree.

This file lists what runs when in `memhtml-public`. Each process is a flow that starts at one initiator and ends at one answer.

This repository is the software that manages a separate directory called the memhtml root. `$MEMHTML_ROOT` locates it, and `~/memhtml` is the default (`MemhtmlRoot`, `apps/cli/src/config.ts:183-191`).

The repository stores no memory of its own. The root's git tree is the system of record, and `.memhtml/index.db` inside the root is a projection that can be rebuilt from that tree, because `rebuild` and `update` both call `projectFile` (`packages/index/src/indexer.ts:18-25`). A process that writes acts on the root rather than on this repo, so one binary serves many roots.

The primary consumer of every process is a coding agent. Processes start from one of two initiators: the CLI and the MCP server.

The CLI publishes its 47 commands as one machine-readable table (`COMMANDS`, `apps/cli/src/commands.ts:179`), and `memhtml manifest` prints the current set (`buildManifest`, `apps/cli/src/commands.ts:1551`). Each command writes its logs to stderr and returns one JSON envelope on stdout (`program`, `apps/cli/src/run.ts:1797-1823`).

Two commands are exceptions to the one-envelope rule. `help` prints Markdown when stdout is a terminal and `--json` is absent (`asMarkdown`, `apps/cli/src/run.ts:1325-1336`). `memhtml hook` prints the host's own hook protocol, because a host and not this CLI reads its stdout (`renderHookOutput`, `apps/cli/src/run.ts:1521-1530`).

The MCP server publishes 15 tools (`MemhtmlToolkit`, `apps/mcp/src/tools.ts:1082-1098`) and 2 resource templates (`RESOURCE_TEMPLATES`, `apps/mcp/src/resources.ts:372-376`) over stdio.

The CLI and the MCP server are both thin adapters over one shared use-case module (`apps/cli/src/operations.ts:52-59`, `apps/mcp/src/handlers.ts:36-46`). So `memhtml search` and `memory_search` run the same query.

## CLI invocation

Entry point: `apps/cli/src/run.ts:1424` (`run`)

1. `bin.ts` calls `run` with the argv tail and writes the returned stdout. It calls `process.exit` from the write's callback rather than straight after the write, so a slow pipe still receives the whole envelope (issue #117) (`apps/cli/src/bin.ts:5-22`).
2. `parseArgv` splits argv into positionals and a flag map whose values are always arrays. Only a flag typed `string` or `int` consumes the next token, and a boolean flag followed by a value-shaped token is recorded as a stray for `validate` to refuse (`apps/cli/src/run.ts:148-225`). Compound names are matched longest-first, so `index status` beats `index` (`COMPOUND_NAMES`, `apps/cli/src/run.ts:126-133`).
3. `help` comes first. `memhtml help`, `--help`, and `-h` are answered before `validate` and before any layer is built, so help works on a machine with no repo (`apps/cli/src/run.ts:1438-1442`). A bare invocation then answers with the manifest (`buildManifest`, `apps/cli/src/run.ts:1444`).
4. `validate` rejects usage errors before any service exists, in a fixed order. Every refusal of a known command ends with a pointer to that command's help (`helpFor`, `apps/cli/src/run.ts:1152-1173`).
5. The first check is the flag set. Flags are checked against THIS command's spec plus the true globals, not against the union of every command's flags. So `memhtml list --status todo` is `ERR_INVALID_FLAG` naming the commands that take `--status`, instead of an unfiltered answer that looks filtered (`validateAgainst`, `apps/cli/src/run.ts:1177-1202`).
6. The value and presence checks follow, in this order. A boolean flag handed a space-separated value (`--embed false`) is refused first (`strayBooleanFlags`, `apps/cli/src/run.ts:995-1004`). Then a positional past what the command declares is `ERR_UNEXPECTED_ARGUMENT`, unless the last argument is `repeatable` (`surplusArgs`, `apps/cli/src/run.ts:1028-1043`). Then come a missing required argument or flag, the claim-or-article rule, the `exec` flag rules, and the `apply` flag rules (`claimOrArticle`, `execFlags`, `applyFlags`, `apps/cli/src/run.ts:1212-1243`). Then `--as-of` must pass the format's own `isValidDatetime` (`asOfFlag`, `apps/cli/src/run.ts:970-982`). Last, every value of a closed-vocabulary flag is checked, every occurrence of a `repeatable` flag included (`apps/cli/src/run.ts:1250-1268`).
7. Inside `validate`, after those checks, the two positional vocabularies are checked: `hook`'s event and the host an `integrations` verb names. A miss is exit 2 with the whole vocabulary listed, and nothing touches a store (`vocabularyPositionals`, `apps/cli/src/run.ts:1102-1143`).
8. Eleven commands answer before `dispatch` without building the app layer, each for a stated reason. `help` is the first (step 3). `manifest` must answer on a machine with no repo, and `agents-doc` must not scaffold a root as a side effect (`apps/cli/src/run.ts:1449-1474`). `eval discriminate` runs `runDiscrimination` against its own generated fixture (`apps/cli/src/run.ts:1476-1519`). The five `integrations` verbs must work before any store exists (`apps/cli/src/run.ts:1606-1658`). `serve mcp` must not open the database its child will serve (`serveMcp`, `apps/cli/src/run.ts:1668-1700`), and `exec` reads a git tree only (`execCommand`, `apps/cli/src/run.ts:1702-1770`).
9. `hook` also answers before `dispatch`, but it builds the app layer itself, and only after probing that a store exists. It has its own section below (`apps/cli/src/run.ts:1550-1604`).
10. Under `MEMHTML_REFUSE_ENV_ROOT`, every command answered after this point needs its root named. A call with no `--repo` is `ERR_REPO_REQUIRED` at exit 2, before any service is built, unless an injected layer names the root, which `serve mcp` and `exec` do not accept (`envRootRefusal`, `apps/cli/src/run.ts:1660-1666`, `ROOT_WITHOUT_LAYER`, `apps/cli/src/run.ts:1045-1090`).
11. `memhtml apply` reads and shape-validates its whole JSONL op stream here, before any service exists, so a malformed line is exit 2 with nothing written (`decodeApply`, `apps/cli/src/run.ts:1772-1795`). The stream arrives from `--file <path>`, or from stdin on `--file -`, a bare positional `-`, or no argument at all. Stdin beside a real `--file` is refused (`applyFlags`, `apps/cli/src/run.ts:891-910`).
12. `dispatch` switches on the command name. Each arm decodes flags, calls one shared use case, and names a response type (`apps/cli/src/run.ts:321-337`). It holds 36 arms: every command in the table except `help`, `hook`, `agents-doc`, `eval discriminate`, `serve mcp`, `exec`, and the five `integrations` verbs. `manifest` keeps an arm although `run` answers it first.
13. The envelope is built once, around the whole program. Success becomes exit 0. A typed failure becomes exit 1 through `failureFor`. An unexpected defect becomes `ERR_UNKNOWN` rather than a stack trace on stdout (`apps/cli/src/run.ts:1797-1823`).

### Related

- `apps/cli/src/envelope.ts:80` (`ERROR_CODES`)
- `apps/cli/src/envelope.ts:157` (`nearest`)
- `apps/cli/src/envelope.ts:188` (`render`)
- `apps/cli/src/errors.ts:41` (`codeFor`)
- `apps/cli/src/errors.ts:148` (`SUGGESTIONS`)
- `apps/cli/src/commands.ts:62` (`GLOBAL_FLAGS`)
- `apps/cli/src/api-layer.ts:608` (`layerApp`)

## Single memory write

Entry point: `apps/cli/src/operations.ts:335` (`writeMemory`)

1. The `write` dispatch arm reads the flags into `WriteParams` (`apps/cli/src/run.ts:348-369`). `task add` reaches the same function with `memoryType` fixed to `task` and the title as the default claim (`apps/cli/src/run.ts:523-555`). The MCP twin is `memory_write` (`apps/mcp/src/handlers.ts:329-357`).
2. `toWriteInput` decodes the memory type through the OPERATOR vocabulary, so `memhtml write` may author an `arc` (issue #88) (`decodeOperatorType`, `apps/cli/src/operations.ts:287-295`). The agent doors stay narrow: `memory_write` refuses `arc` at schema decode through `WritableType` (`apps/mcp/src/tools.ts:59`).
3. `toWriteInput` also decodes the two task metas, before any file is rendered (`apps/cli/src/operations.ts:296-303`).
4. `store.writeMemory` runs the strict-path gate first. Under `--strict-path`, an unusable explicit path is refused before anything else is judged (`strictPathRefusal`, `packages/store/src/store.ts:670-705`, `packages/store/src/store.ts:709`).
5. It then takes one clock reading and renders the file through the template. `renderChecked` runs the format check over the rendered bytes and fails with the list of violations before anything is written, staged, or committed (`packages/store/src/store.ts:644-668`, `packages/store/src/store.ts:710-712`).
6. The content hash is looked up against the dedupe oracle next. A duplicate returns the existing path and leaves the tree byte-identical (`dedupeLookup`, `packages/store/src/store.ts:715-729`).
7. `freePathFor` resolves the placement rule's path, suffixing `-2`, then `-3`, until one is absent from disk (`packages/store/src/store.ts:397-457`).
8. A caller that named a valid explicit path gets that path or nothing. An occupied one is `WriteConflict`, which the envelope reports as `ERR_WRITE_CONFLICT`, with nothing written and no `-2` suffix. A quiet fallback would hand back a path with no file behind it, and a quiet overwrite would delete a memory in a corpus where eviction is a `git mv` (`packages/store/src/store.ts:409-441`).
9. The one exemption is `correctMemory`'s own target, whose path the same commit vacates into the archive (`packages/store/src/store.ts:413-415`). The recovery the envelope suggests for a `WriteConflict` is `memhtml correct <path>` (`apps/cli/src/errors.ts:169-173`).
10. The write, the stage, and the commit run under a journal. A failure or an interruption is compensated instead of leaving a written or staged file for the next clean-tree check to refuse. The commit carries the provenance trailers (`makeJournal`, `compensated`, `packages/store/src/store.ts:741-758`).
11. Every store write runs under one in-process permit, `oneWriterAtATime`. So two concurrent MCP tool calls take turns instead of racing for a path or for `.git/index` (`packages/store/src/store.ts:1382-1405`).
12. `reindex` brings the index up to the whole COMMIT the write just made, through the indexer's `update`, and never a caller-supplied path list (`apps/cli/src/operations.ts:248-271`). `writeMemory` calls it only when a file was created (`apps/cli/src/operations.ts:341`).
13. Two index properties rest on that. A rename is only expressible as a diff: every correction and every archive is a `git mv`, and `update` reads `diff --name-status -M`, sees the `R`, and re-points the row, keeping the embedding. Indexing the destination alone would leave the source row live, so the archived memory would stay in `memhtml list` and its chunk rows would be duplicated under two paths (`apps/cli/src/operations.ts:254-258`).
14. And only `update` records `index_state.head_sha`, without which `memhtml status` reports `index_fresh: false` forever (`apps/cli/src/operations.ts:259-261`).
15. `recordLink` then notes the session link, and it swallows its own failure (`apps/cli/src/operations.ts:195-218`, `apps/cli/src/operations.ts:342`).

### Related

- `packages/store/src/store.ts:488` (`makeJournal`)
- `packages/store/src/store.ts:550` (`compensated`)
- `packages/store/src/store.ts:642` (`renderFor`)
- `apps/cli/src/operations.ts:83` (`decodeWritableType`)
- `apps/mcp/src/handlers.ts:146` (`authored`)
- `apps/mcp/src/tools.ts:349` (`MemoryWrite`)

## Batch apply

Entry point: `apps/cli/src/operations.ts:882` (`batchWrite`)

1. `decodeApply` checks every JSONL line before any op runs. It fails on the first bad line and reports that line's number, and it skips blank lines while still counting them (`apps/cli/src/apply.ts:285-309`). Input with no op at all is refused as `ERR_MISSING_ARGUMENT` (`apps/cli/src/apply.ts:311-323`).
2. When `detectConflicts` is on, `detectFrameConflicts` computes each op's frame key and asks the index for live occupants in ONE query, folding earlier ops in as it walks. A lookup failure degrades to no conflicts (`apps/cli/src/operations.ts:539-599`, `apps/cli/src/operations.ts:899-902`).
3. When `detectNearDuplicates` is on, the ops' text is embedded in one call and compared with stored memories and with earlier ops at or above `NEAR_DUPLICATE_THRESHOLD`. Every failure degrades to "not checked" and says so as `nearDuplicatesDegraded` (`apps/cli/src/operations.ts:623-743`, `apps/cli/src/operations.ts:904-913`).
4. When `detectConflicts` is on, `detectFrameConflicts` computes each op's frame key and asks the index for live occupants in ONE query, folding earlier ops in as it walks. A lookup failure degrades to no conflicts `apps/cli/src/operations.ts:448-502`.
5. Fold one decodes each planned op through the singular write's own `toWriteInput`. An atomic decode abort returns at once, reports every op, and writes nothing (`apps/cli/src/operations.ts:925-962`).
6. The optional extraction assist, `ExtractorPort`, makes one model call over the decoded ops and unions the extracted entities into each op's own list. A failure produces a logged warning and an unextracted batch (`apps/cli/src/operations.ts:964-998`).
7. Fold two is `store.writeMemories`, which runs in two phases (`packages/store/src/store.ts:893-1020`). Phase 1 validates every op against the batch's folded dedupe and path-claim state and writes nothing (`validateOp`, `packages/store/src/store.ts:922-945`). Phase 2 writes every file, stages once, and makes ONE commit under `makeJournal`, rolling back on any failure (`packages/store/src/store.ts:967-999`).
8. One `reindex` runs after the commit, gated on a file having actually been written, so a dedupe-only batch does not move the watermark for a commit that never happened (`apps/cli/src/operations.ts:1021-1023`).
9. The store-supersede pass archives every live memory a surviving slot displaced, in one `supersedeMemories` call, then reindexes again because archive paths moved. A failure here only annotates the result (`apps/cli/src/operations.ts:1025-1068`).
10. The MCP twin is `memory_write_batch`. It resolves each op's body-or-article rule up front, and an atomic abort reaches the agent on the error channel as `batchAbortFailure` (`apps/mcp/src/handlers.ts:359-395`).

### Related

- `packages/store/src/store.ts:780` (`validateOp`)
- `packages/store/src/store.ts:359` (`dedupable`)
- `packages/store/src/store.ts:1159` (`supersedeMemories`)
- `apps/cli/src/operations.ts:845` (`withConsolidation`)
- `apps/cli/src/apply.ts:434` (`applyPayload`)
- `apps/mcp/src/failure.ts:264` (`batchAbortFailure`)

## Ranked retrieval

Entry point: `packages/index/src/retrieval.ts:502` (`search`)

1. The `search` and `recall` dispatch arms build one shared scope object from the same flag set, so the two commands cannot narrow differently (`scopeOf`, `apps/cli/src/run.ts:263-274`, `SCOPE_FLAGS`, `apps/cli/src/commands.ts:120-167`). The MCP twins are `memory_search` and `memory_recall` (`apps/mcp/src/handlers.ts:563-648`).
2. `gatedQueryVector` reads the vector coverage first, in one count statement. Below the floor, `VECTOR_COVERAGE_FLOOR` (0.95) unless configured otherwise, the vector arm is dropped and the query is never embedded, because a sparse plane ranks the embedded few above every lexical match (issue #141) (`packages/index/src/retrieval.ts:294-316`, `packages/index/src/vector-coverage.ts:44`).
3. Above the floor, `queryVector` embeds the query text. A model failure is caught and returns undefined, so the search degrades rather than erroring (`packages/index/src/retrieval.ts:255-276`).
4. `ftsQueryForms` reduces the caller's prose to indexable terms in two MATCH forms, all-terms and any-of, keeping a double-quoted span as one phrase. An apostrophe or a leading hyphen would otherwise be a hard driver error rather than an empty result (`packages/index/src/fts-query.ts:99-123`, `packages/index/src/retrieval.ts:334-350`).
5. A one-row probe through the caller's scope decides which form the lexical arm binds: all-terms when some file in scope holds every term, any-of otherwise (`holdsEveryTerm`, `packages/index/src/retrieval.ts:278-292`, `packages/index/src/retrieval.ts:351-354`, `buildFtsProbeSql`, `packages/index/src/retrieval-sql.ts:140-149`).
6. `activeArms` drops any arm whose precondition is absent, and that dropping is the entire degradation mechanism. The vector arm needs the query vector, the salience arm needs the attached state plane, and the lexical arm needs surviving query terms (`packages/index/src/retrieval-sql.ts:287-295`).
7. `buildRrfSql` assembles the surviving arms as CTEs, unions their weighted reciprocal ranks, and sums per path with `path ASC` breaking ties. It returns undefined when no arm fires (`packages/index/src/retrieval-sql.ts:297-319`).
8. `hydrate` fetches the full rows for the fused pool in fused order, in one statement, including both entity projections, the supersedes edge, and the first chunk's vector (`packages/index/src/retrieval.ts:374-425`). The pool is `MMR_POOL_FACTOR` (3) times the limit (`packages/index/src/retrieval.ts:507-512`).
9. The polarity step gives each candidate its reciprocal fused rank, then demotes a negation-flipped twin of a better-agreeing candidate (`polarityScored`, `packages/index/src/retrieval.ts:515-529`, `packages/index/src/polarity.ts:78`).
10. `applyMmr` reorders the pool down to the limit, using that score as the relevance term (`packages/index/src/retrieval.ts:530-535`, `packages/domain/src/mmr.ts:36`).
11. `search` fetches snippets for the final paths only. It returns hits plus `degraded`, `vectorCoverage`, `arms`, `entityScope`, and `scopeEmpty` (`packages/index/src/retrieval.ts:537-594`).
12. When the scope came back empty and no `asOf` is set, the result also carries `archivedMatches` and the archived paths, so a caller learns that the address resolves only in the archive (`archivedInScope`, `packages/index/src/retrieval.ts:545-554`, `packages/index/src/retrieval.ts:470-494`).
13. `recall` runs the same gate, fusion, and polarity step, then folds arcs and ordinary memories under separate character budgets (`foldDisclosure`, `packages/index/src/retrieval.ts:596-648`).

### Related

- `packages/index/src/retrieval-sql.ts:268` (`RANK_ARMS`)
- `packages/index/src/retrieval-sql.ts:343` (`buildSnippetSql`)
- `packages/index/src/scope.ts:236` (`assembleScope`)
- `packages/index/src/vector-coverage.ts:100` (`readVectorCoverage`)
- `packages/index/src/disclosure.ts:93` (`foldDisclosure`)
- `apps/cli/src/operations.ts:1188` (`searchMemories`)

## Index projection

Entry point: `packages/index/src/indexer.ts:808` (`update`)

1. `guardEmbedModel` fails when the stored vector space disagrees with the configured one. It runs before any write, so an index can never hold rows under two models (`packages/index/src/indexer.ts:322-338`, `packages/index/src/indexer.ts:810`).
2. The recorded watermark is read. An absent watermark row means there is no index at all, so `update` falls through to `reproject`, the whole-tree pass a rebuild runs, without the `--no-embed` interlock (`packages/index/src/indexer.ts:812-834`).
3. A watermark row with no commit on it is a rebuild that died between its truncate and its watermark write. `update` refuses it with `IndexStale` rather than report a half-index as current (`packages/index/src/indexer.ts:836-846`).
4. `git diff --name-status -M` between the watermark and HEAD gives the committed changes, and `git status --porcelain=v2` gives the uncommitted working tree. Both keep an entry when its source or its destination passes `isIndexablePath` (`packages/index/src/indexer.ts:849-858`).
5. Every committed diff target's blob is read through `catFileBatch` in two subprocesses total rather than two per file, because a per-file tree walk was the term that made bulk ingest quadratic (`packages/index/src/indexer.ts:860-887`).
6. Committed changes are applied first. A deletion cascades its rows, a rename becomes a `movePath` that keeps the chunk row and its vector, a rename out of the corpus retires its source through `deletePath`, and every surviving path is re-projected (`packages/index/src/indexer.ts:909-954`).
7. The dirty working tree is applied second, so a path that both moved in a commit and was then edited ends at the working tree's content. A staged rename retires its source in the same pass through `movePath` (`packages/index/src/indexer.ts:956-992`).
8. Writes are applied in bounded batches, each atomic on its own, and `writeState` records the watermark. Recording the watermark is what makes "does the index describe the current commit" answerable (`applyWrites`, `packages/index/src/indexer.ts:280-286`, `packages/index/src/indexer.ts:994-995`).
9. `embedMissing` fills vectors. It is scoped to this pass's own chunk ids on the incremental path, and unscoped on a rebuild so a model migration can find every stale vector (`packages/index/src/indexer.ts:996-1002`, `packages/index/src/indexer.ts:527-560`, `packages/index/src/indexer.ts:657`).

### Related

- `packages/index/src/indexer.ts:674` (`rebuild`)
- `packages/index/src/indexer.ts:708` (`backfill`)
- `packages/index/src/indexer.ts:398` (`truncateForRebuild`)
- `packages/index/src/project.ts:141` (`projectFile`)
- `packages/index/src/git-adapter.ts:148` (`makeGitPort`)
- `packages/index/src/index-state.ts:67` (`readIndexState`)

## MCP tool invocation

Entry point: `apps/mcp/src/bin.ts:15` (`Layer.launch`)

1. `Layer.launch` runs the server for the process's lifetime, because the stdio transport is the program and a built-then-released layer would close stdin under a live client (`apps/mcp/src/bin.ts:7-15`).
2. `layerServer` merges the toolkit and the two resources over the CLI's own app layer, so both entry points resolve to one database file, one git root, and one vector space (`apps/mcp/src/server.ts:40-53`).
3. `Logger.LogToStderr` is set here because stdout on this transport carries the NDJSON-RPC stream, and one log line would corrupt the frame a client is mid-parse on (`apps/mcp/src/server.ts:62`).
4. The toolkit declares 15 tools with the batch second, directly after `memory_write`, because `tools/list` publishes this order and an agent reads it top-down (`MemhtmlToolkit`, `apps/mcp/src/tools.ts:1069-1098`).
5. `MemhtmlToolkit.toLayer` binds each handler and typechecks it against the toolkit's own parameter and success schemas, so a wrong shape is a compile error rather than a live decode failure (`ToolHandlers`, `apps/mcp/src/handlers.ts:318-328`).
6. Each handler renames snake_case wire parameters to the operations layer's camelCase and maps an explicit `null` to absent. It then calls the same shared use case the CLI command calls, such as `writeMemory` (`apps/mcp/src/handlers.ts:95-108`, `apps/mcp/src/handlers.ts:329-357`).
7. `authored` resolves the body-or-article-html exclusive rule at the wire boundary. It rejects a call that supplies both and a call that supplies neither, instead of picking one (`apps/mcp/src/handlers.ts:110-170`).
8. `handled` maps every typed error through `toToolFailure` into the `ToolFailure` shape each tool declares. That branch passes the message through verbatim, so the client sees it instead of the framework's generic internal-error sentence (`apps/mcp/src/handlers.ts:51-74`, `apps/mcp/src/failure.ts:173`).

### Related

- `apps/mcp/src/tools.ts:208` (`BATCH_GUIDANCE`)
- `apps/mcp/src/tools.ts:150` (`ARTICLE_HTML_CONTRACT`)
- `apps/mcp/src/resources.ts:50` (`routerPathFor`)
- `apps/mcp/src/failure.ts:34` (`ToolFailure`)
- `apps/cli/src/api-layer.ts:608` (`layerApp`)
- `apps/cli/src/operations.ts:1162` (`readMemory`)

## Hook invocation

Entry point: `apps/cli/src/run.ts:1550` (`hook`)

1. A host runs `memhtml hook <event> --host <host> --repo <root>` from the config `integrations install` wrote. Every host's entries run this one engine through `hookCommand`, so there is no shell script on disk to drift (`packages/integrations/src/render/hooks.ts:1-20`).
2. The engine knows four host-neutral events: `session-start`, `user-prompt-submit`, `pre-compact`, and `session-end` (`HOOK_EVENTS`, `packages/integrations/src/types.ts:20-30`). Cursor never gets a per-prompt hook, because its `beforeSubmitPrompt` cannot inject context (`packages/integrations/src/render/hooks.ts:13-15`).
3. `validate` refuses an unknown event or host at exit 2, with the whole vocabulary as suggestions. That is the one case where a hook answers with an envelope, because a malformed hook config is something an operator has to be told (`vocabularyPositionals`, `apps/cli/src/run.ts:1123-1143`, `apps/cli/src/run.ts:1537-1542`).
4. Every later path exits 0, and every failure prints nothing. On `UserPromptSubmit` a non-zero exit is how a hook blocks the prompt, so the turn proceeds without memory rather than not proceeding (`apps/cli/src/run.ts:1532-1535`, `isHookEvent`, `apps/cli/src/run.ts:1553-1556`).
5. Under `MEMHTML_REFUSE_ENV_ROOT` with no `--repo`, the hook logs a warning on stderr and stays silent on stdout. It checks this above `envRootRefusal`, whose exit-2 envelope would land in a context window and block the prompt (`apps/cli/src/run.ts:1544-1548`, `apps/cli/src/run.ts:1565-1569`).
6. A hook never scaffolds a store. `hookStoreReady` probes the root's `.git` without creating anything, and a root with no store prints nothing (`apps/cli/src/hook.ts:335-356`, `apps/cli/src/run.ts:1581-1589`).
7. `readHookPayload` drains the host's stdin payload under `HOOK_STDIN_DEADLINE_MS` (500 ms). A read that throws, a host that writes nothing, and a host that never closes the pipe all mean no payload (`apps/cli/src/hook.ts:385-414`).
8. The deadline depends on the event: `HOOK_INDEX_DEADLINE_MS` (10 s) for `pre-compact` and `session-end`, and `HOOK_RECALL_DEADLINE_MS` (1.5 s) otherwise (`INDEXING_EVENTS`, `apps/cli/src/run.ts:1591-1592`, `apps/cli/src/hook.ts:70-87`).
9. `hookText` builds `layerApp` from `--repo` and runs the engine. It also catches a failure raised while the layer is built, such as a failed migration, and answers it with the empty string (`apps/cli/src/run.ts:1379-1410`, `apps/cli/src/run.ts:1593-1602`).
10. `engine` returns the empty string at once for an event the host cannot read, before the store is touched (`injects`, `apps/cli/src/hook.ts:212-223`, `apps/cli/src/hook.ts:297-302`).
11. On `user-prompt-submit` the engine searches on the prompt and injects the hits (`promptRecall`, `apps/cli/src/hook.ts:225-232`). On `session-start` it recalls on the working directory's last two path segments, then appends up to `OPEN_TASK_LIMIT` (5) open tasks from a separate task scan (`sessionPack`, `apps/cli/src/hook.ts:234-261`, `queryForCwd`, `apps/cli/src/hook.ts:205-210`).
12. On `pre-compact` and `session-end` the engine indexes the host's transcripts and injects nothing. When `--trace-root` did not reach the layer, it declines rather than advance a watermark over the wrong tree (`indexTranscripts`, `apps/cli/src/hook.ts:263-287`).
13. `runHook` bounds the engine with `Effect.timeout` and catches every cause, so a blown deadline, a storage failure, and a defect all answer with the empty string (`apps/cli/src/hook.ts:314-333`).
14. Stdout carries what `renderHookOutput` renders and nothing else. Claude Code and OpenCode get plain text, Codex gets its `hookSpecificOutput` JSON, and Cursor gets `additional_context` on `session-start` only (`apps/cli/src/run.ts:1603`, `packages/integrations/src/dialect.ts:17-37`).

### Related

- `apps/cli/src/hook.ts:42` (`HookInput`)
- `apps/cli/src/hook.ts:373` (`hookConfigProvider`)
- `apps/cli/src/hook.ts:424` (`parseHookPayload`)
- `packages/integrations/src/dialect.ts:52` (`promptOf`)
- `apps/cli/src/commands.ts:1258` (`hook`)
- `apps/cli/src/envelope.ts:49-52` (`hook.output`)

## Minor flows

- Initialize a root: entry at `apps/cli/src/run.ts:341` (`init`). `initRepo` is convergent: it runs `git init -b main` only when the root is not a repo yet, sets the merge driver every clone needs, writes the missing scaffold files, and commits only when the index differs from HEAD (`packages/store/src/layout.ts:170-211`).
- Read a memory: entry at `apps/cli/src/operations.ts:1162` (`readMemory`). Reads the file, records a session link, and bumps salience, because an explicit open is a choice and a search hit is only the ranker's guess (`apps/cli/src/operations.ts:1150-1169`). The MCP twin is `memory_read`, and the `memhtml://file/{path}` resource funnels through the same `readMemory` (`apps/mcp/src/handlers.ts:545-561`, `apps/mcp/src/resources.ts:191-211`).
- Correct a memory: entry at `apps/cli/src/operations.ts:1256` (`correctMemory`). Reads the target first, renders and gates the superseding file, stamps the validity window on both sides, and lands the new file plus the archived target in one commit. The archive move runs before the new bytes are written, so a correction in place archives the original fact (`packages/store/src/store.ts:1030-1129`). The MCP twin is `memory_correct`.
- Archive a memory: entry at `apps/cli/src/operations.ts:1306` (`archiveMemory`). This is a soft eviction. It runs `git mv` into `archive/<YYYY>/`, applies the archive stamps at the destination with `setMeta`, and then runs one diff-driven reindex (`stageArchive`, `packages/store/src/store.ts:564-598`, `packages/store/src/store.ts:1131-1157`). The MCP twin is `memory_archive`.
- Link two memories: entry at `apps/cli/src/operations.ts:1293` (`linkMemories`). Decodes the rel against the authorable set, refuses a self-link and an edge whose class disagrees with its endpoints' types, and is idempotent on the pair, so a re-link commits nothing (`requireEndpointClasses`, `packages/store/src/store.ts:1264-1343`). The MCP twin is `memory_link`.
- Resolve a moved path: entry at `apps/cli/src/operations.ts:1733` (`resolveMemory`). Walks `supersedes` forward and follows the archive mapping, naming every node by the path that holds it now (`apps/cli/src/operations.ts:1695-1732`). It stops for one of five reasons, the last after `RESOLVE_MAX_HOPS` (16) steps (`RESOLVE_STOP_REASONS`, `apps/cli/src/operations.ts:1580-1613`). The MCP twin `memory_resolve` adds a pinned citation URI built by `pinnedUri` (`apps/mcp/src/handlers.ts:719-753`, `apps/mcp/src/resources.ts:353-366`).
- Open a task: entry at `apps/cli/src/run.ts:523` (`task add`). This is the single write with `memoryType` fixed to `task`. A task is never a dedupe match, because two open tasks with identical bodies are two real work items (`activePathForHash`, `packages/index/src/traces-persist.ts:196-203`, `DEDUPE_EXEMPT_TYPE`, `packages/store/src/store.ts:335-348`).
- Move a task's status: entry at `apps/cli/src/operations.ts:2171` (`setTaskStatus`). Splices the status meta in place with `setMeta` so the article's bytes and content hash cannot move, and routes `done` through `archiveMemory` so the stamp and the move land in one commit (`apps/cli/src/operations.ts:2153-2170`).
- List memories or tasks: entry at `apps/cli/src/operations.ts:1825` (`listMemories`) and `apps/cli/src/operations.ts:2335` (`listTasks`). These are direct indexed scans with keyset pagination on `path`, chosen over ranked retrieval (`apps/cli/src/operations.ts:1821-1823`). The task scan carries each row's `blockedBy` from one correlated subquery over `edges` (`apps/cli/src/operations.ts:2394-2419`). The MCP twin of the memory scan is `memory_list`.
- Report entity activity: entry at `apps/cli/src/operations.ts:2091` (`entityActivity`). Aggregates the memories carrying each stored entity reference, with three timestamps per row, up to `ENTITY_ACTIVITY_MAX` (500) rows (`apps/cli/src/operations.ts:1937`). It does not fold spellings, because `entityActivity` leaves that to the `entity-resolution` phase (`apps/cli/src/operations.ts:2080-2091`).
- Walk a memory's neighborhood: entry at `apps/cli/src/operations.ts:1484` (`neighborsOf`). Uses fixed-depth joins in a `UNION ALL` rather than a recursive CTE. It follows both edge directions, stops at two hops, and filters to `edge_class = 'memory'` (`neighborsQuery`, `apps/cli/src/operations.ts:1404-1446`). The MCP twin is `memory_neighbors`.
- Reinforce paths: entry at `apps/cli/src/operations.ts:1317` (`reinforceMemories`). Bumps access bookkeeping with a caller-chosen signal through the one SQL writer for `state.access`, gated by a per-path cooldown (`reinforce`, `packages/index/src/reinforce.ts:49-72`). The MCP twin is `memory_reinforce`.
- Index Claude Code transcripts: entry at `apps/cli/src/operations.ts:2462` (`indexTraces`). Scans `$MEMHTML_TRACE_ROOT`, reading only what the per-file watermarks say changed, then persists each scanned file as a `traces` row plus its prompts (`scanTraceRoot`, `packages/traces/src/scan.ts:88`, `persistScanned`, `packages/index/src/traces-persist.ts:467`). Four counters partition the files the scan planned to read: `skipped`, `tailed`, `rescanned`, and `filesFailed`. `filesFailed` is a file the scan planned to read and could not, and it keeps that census honest rather than letting a read failure vanish into a smaller total (`ScanReport`, `packages/traces/src/scan.ts:54-65`, `apps/cli/src/operations.ts:2497-2499`). `sessionsWritten` is not a fifth partition: it counts the files for which a `traces` ROW was written, so a file read with no session id is tailed and unwritten (`apps/cli/src/operations.ts:2475-2486`).
- Search transcripts: entry at `apps/cli/src/operations.ts:2531` (`searchTraces`). Runs FTS over session first-prompts and AI titles through the same sanitizer the memory arms use, all-terms first and any-of when that finds nothing. An empty query lists the most recent sessions. The query names no memory table, which is the trace firewall in that direction (`apps/cli/src/operations.ts:2514-2531`). The MCP twin is `trace_search`.
- Read memory-session links: entry at `apps/cli/src/operations.ts:2607` (`traceLinks`). Answers from either side, and refuses a call that names neither side as `InvalidMemory` rather than scanning every link ever recorded (`apps/cli/src/operations.ts:2614-2618`). The MCP twin is `trace_links`.
- Report corpus status: entry at `apps/cli/src/operations.ts:2676` (`statusReport`). Compares the recorded watermark to `HEAD` for freshness, and reads `embedderUp` off the stored watermark rather than probing Bedrock (`apps/cli/src/operations.ts:2744`). A stale index, where `indexFresh` is false, is also said on stderr once per call (issue #145) (`apps/cli/src/operations.ts:2706-2724`). The MCP twin is `memory_status`.
- Report index status: entry at `apps/cli/src/views.ts:29` (`indexReport`). Reads the watermark, the vector space, and the row counts from the database without spawning git, because an operator asking about a stale index is often asking because the repo is broken (`apps/cli/src/views.ts:22-29`).
- Rebuild the index: entry at `packages/index/src/indexer.ts:674` (`rebuild`). Reads the whole tree at HEAD before it truncates, carries the vectors of unchanged chunks across through a stash, and records the watermark only once the vectors are back (`reproject`, `packages/index/src/indexer.ts:612-672`, `truncateForRebuild`, `packages/index/src/indexer.ts:375-398`). A rebuild that cannot embed refuses a store that carries vectors unless `--force` is given (`refuseNoEmbedOverVectors`, `packages/index/src/indexer.ts:346-366`, `packages/index/src/indexer.ts:689-695`).
- Backfill embeddings: entry at `packages/index/src/indexer.ts:708` (`backfill`). Runs the full-scan `embedMissing` and reports how much of the gap is left. It touches only `embeddings`, so the index keeps serving on every arm throughout (`packages/index/src/indexer.ts:699-726`). Each slice of `EMBED_PERSIST_SLICE` (960) chunks is persisted as it finishes, so a throttled pass keeps most of what it paid for (`packages/index/src/indexer.ts:267-275`).
- Check corpus health: entry at `apps/cli/src/doctor.ts:428`. Gathers dangling hrefs, orphan state rows, inbox depth, format warnings, overdue tasks, and stale blockers before any repair, so a `--fix` run reports what was wrong and what was done in one envelope. `repaired` carries `rewritten`, `dropped`, `failedWrites`, `prunedAccessRows`, and `commitSha` `apps/cli/src/doctor.ts:156`. A repair counts only when its bytes reached disk: a file whose write failed lands in `failedWrites`, is counted under neither `rewritten` nor `dropped`, and is never staged `apps/cli/src/doctor.ts:389-405`, because staging the unchanged file would put the pre-repair bytes into a commit whose subject claims they were repaired, and counting it would report a finding as settled while it is still open.
- Repair corpus health: under `--fix`, `repaired` carries `rewritten`, `dropped`, `failedWrites`, `prunedAccessRows`, and `commitSha` (`RepairReport`, `apps/cli/src/doctor.ts:248-263`). A repair counts only when its bytes reached disk. A file whose write failed lands in `failedWrites`, is counted under neither `rewritten` nor `dropped`, and is never staged, because staging the unchanged file would put the pre-repair bytes into a commit whose subject claims they were repaired, and counting it would report a finding as settled while it is still open (`apps/cli/src/doctor.ts:578-594`).
- Publish generated listings: entry at `apps/cli/src/publish.ts:59`. Regenerates every per-directory `index.html` and the root `sitemap.xml` from one deterministic generator (`apps/cli/src/artifacts.ts`), writing only files whose bytes differ.
- Export the state plane: entry at `apps/cli/src/state.ts:54` (`stateExport`). Writes `.memhtml/state/access.jsonl`, the only durable copy of the plane git cannot rebuild, and commits nothing when the bytes already match (`apps/cli/src/state.ts:46-71`).
- Import the state plane: entry at `apps/cli/src/state.ts:103` (`stateImport`). Replays the committed sidecar with a per-row upsert that takes the maximum of the two counters, so an import onto a live plane cannot lose a bump (`apps/cli/src/state.ts:91-103`, `access_count`, `apps/cli/src/state.ts:138-139`).
- Regenerate AGENTS.md: entry at `apps/cli/src/agents-doc.ts:242` (`runAgentsDoc`). Renders the doc from the command table and writes it. Under `--check` it writes nothing and fails when the rendered doc has drifted from the file on disk (`apps/cli/src/agents-doc.ts:236-269`).
- Supervise the MCP server: entry at `apps/cli/src/serve.ts:82` (`serveMcp`). Spawns `memhtml-mcp` with inherited descriptors and `MEMHTML_ROOT` set to the resolved root, so the client talks to the child directly. It kills the child on interruption, so no orphan holds the root's database open (`apps/cli/src/serve.ts:86-110`).
- Run a code-mode script: entry at `apps/cli/src/exec.ts:481` (`execCommand`). Pins a commit as a detached worktree and releases it through `acquireRelease` (`apps/cli/src/exec.ts:503-525`). `runExec` mounts the tree read-only in a QuickJS sandbox with no network and no index handle, under a wall-clock bound capped at `MAX_TIMEOUT_MS` (`apps/cli/src/exec.ts:290-307`, `apps/cli/src/exec.ts:49-57`). A bridge fault runs the script again, for at most `BRIDGE_ATTEMPTS` (3) attempts in total, before it counts as the runtime's failure (`apps/cli/src/exec.ts:200-207`).
- Run the discrimination eval: entry at `packages/eval/src/run.ts:86` (`runDiscrimination`). Generates a fixture corpus, runs the probes, and reports three distinct outcomes, so a live run skipped for missing credentials reads differently from a pass (`EvalOutcome`, `packages/eval/src/run.ts:36-55`). A failed gate is the `ERR_DISCRIMINATION_FAILED` failure envelope at exit 1 (`apps/cli/src/run.ts:1483-1489`).
- Read an MCP resource: entry at `apps/mcp/src/resources.ts`, registered through the one `templateLayer`. `memhtml://file/{path}` returns one memory's title, claim, and body for citation-grade drill-down, and it bumps salience through the same `readMemory` the tool calls; the captured path is traversal-gated by `isValidMemoryPath` before the store sees it. `memhtml://at/{commit}/{path}` reads the same path out of a named commit's tree. Each route matches on `memhtml:://<section>/*`, whose rest parameter is what lets a multi-segment PARA path resolve.
- Read a memory at a commit: entry at `apps/mcp/src/resources.ts:312` (`PinnedResource`). `memhtml://at/{commit}/{path}` reads one memory's text as of a commit sha, out of git rather than off disk. It refuses a branch name or `HEAD` through `COMMIT_SHA`, and it does not bump salience, because auditing a receipt is not choosing a memory (`apps/mcp/src/resources.ts:255-351`).
- Install a host integration: entry at `apps/cli/src/integrations.ts:264` (`integrationsInstall`). Wires one host, or every detected host, at user scope, or at project scope with `--project` (`install`, `packages/integrations/src/install.ts:673`). A drifted receipt claim or an unowned artifact refuses with `IntegrationModified`, reported as `ERR_INTEGRATION_MODIFIED`, and writes nothing, and `--force` keeps the prior bytes as a timestamped backup (`packages/integrations/src/install.ts:683-732`). The writes land all or nothing, with the receipt written last (`packages/integrations/src/install.ts:14-22`). With several hosts every host is planned as a dry run first, so a refusal on one leaves none wired (`apps/cli/src/integrations.ts:297-306`).
- Uninstall a host integration: entry at `apps/cli/src/integrations.ts:340` (`integrationsUninstall`). Removes exactly what the receipt claims. One entry that no longer matches refuses the whole uninstall, and there is no `--force`, because deleting a file somebody has made their own cannot be undone (`uninstall`, `packages/integrations/src/uninstall.ts:1-12`, `packages/integrations/src/uninstall.ts:97`).
- List host integrations: entry at `apps/cli/src/integrations.ts:389` (`integrationsList`). Returns one row per host at user scope, plus one per host at project scope when `--project` names a root, in `HOSTS` order (`listIntegrations`, `packages/integrations/src/list.ts:65-81`).
- Diagnose a host integration: entry at `apps/cli/src/integrations.ts:419` (`integrationsDoctor`). Without a host it checks every host that has a receipt (`apps/cli/src/integrations.ts:412-436`). Each check is one row: the receipt, the three binaries, the CLI version, the store root, each claimed entry, the hooks, the instruction block, the skill, the trace root, an MCP handshake, and for Codex a hook-trust note (`doctor`, `packages/integrations/src/doctor.ts:313-581`).
- Print the shell setup: entry at `apps/cli/src/integrations.ts:471` (`integrationsShell`). Prints a snippet that exports `MEMHTML_ROOT` and puts the binary's directory on `PATH`, and with `--write` places it inside a fence in the rc file. No host integration depends on it, because every installed entry carries its own absolute command and root (`renderShellSnippet`, `apps/cli/src/integrations.ts:460-499`).

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at e027765.

- [memhtml-public · Contract map](../insights/contract-map.md): 39 shared source citations
- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 39 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 35 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 32 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 28 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 25 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 24 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 22 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 21 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 19 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 18 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 18 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 18 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 12 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 12 shared source citations

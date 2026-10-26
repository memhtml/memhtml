# memhtml-public · Processes

Describes the source at 0.16.0 (2026-10-18). Citations are `path:line` into that tree.

This file lists what runs when in `memhtml-public`. Each process is a flow that starts at one initiator and ends at one answer.

This repository is the software that manages a separate directory called the memhtml root. `$MEMHTML_ROOT` locates it, and `~/memhtml` is the default (`MemhtmlRoot`, `apps/cli/src/config.ts:277-286`).

The repository stores no memory of its own. The root's git tree is the system of record, and `.memhtml/index.db` inside the root is a projection that can be rebuilt from that tree, because `rebuild` and `update` both call `projectFile` (`packages/index/src/indexer.ts:18-25`). A process that writes acts on the root rather than on this repo, so one binary serves many roots.

The primary consumer of every process is a coding agent. Processes start from one of two initiators, the CLI or the MCP server.

The CLI publishes its 57 commands as one machine-readable table (`COMMANDS`, `apps/cli/src/commands.ts:185`), and `memhtml manifest` prints the current set (`buildManifest`, `apps/cli/src/commands.ts:1995`). Each command writes its logs to stderr and returns one JSON envelope on stdout (`program`, `apps/cli/src/run.ts:2414-2446`).

Two commands are exceptions to the one-envelope rule. `help` prints Markdown when stdout is a terminal and `--json` is absent (`asMarkdown`, `apps/cli/src/run.ts:1579-1583`). `memhtml hook` prints the host's own hook protocol, because a host reads its stdout (`renderHookOutput`, `apps/cli/src/run.ts:1800-1809`).

The MCP server publishes 15 tools (`MemhtmlToolkit`, `apps/mcp/src/tools.ts:1041-1057`) and 2 resource templates (`RESOURCE_TEMPLATES`, `apps/mcp/src/resources.ts:326`) over stdio.

The CLI and the MCP server are both thin adapters over one shared use-case module (`apps/cli/src/operations.ts:52-59`, `apps/mcp/src/handlers.ts:40-50`). So `memhtml search` and `memory_search` run the same index query. `memory_search` and `memory_recall` ask the head server first and run that query only when the head can't answer, as Ranked retrieval describes.

The head server, `memhtml head serve`, is a long-running process an operator starts once per store. Six CLI commands, `head status`, `head search`, `session put`, `session exec`, `session commit`, and `session rebase`, ask it first over the store's socket and take a local path when it doesn't answer (`apps/cli/src/v2.ts:130-141`). The MCP server's `memory_search` and `memory_recall` do the same (`apps/mcp/src/handlers.ts:573-581`, `apps/mcp/src/handlers.ts:617-619`). Between requests its own work is a poll of the ref it follows, a background vector fill, and an optional embed warmup. Head server lifecycle describes it.

## CLI invocation

Entry point: `apps/cli/src/run.ts:1684` (`run`)

1. `bin.ts` calls `run` with the argv tail and writes the returned stdout. It calls `process.exit` from the write's callback rather than straight after the write, so a slow pipe still receives the whole envelope (issue #117) (`apps/cli/src/bin.ts:5-22`).
2. `parseArgv` splits argv into positionals and a flag map whose values are always arrays. Only a flag typed `string` or `int` consumes the next token, and a boolean flag followed by a value-shaped token is recorded as a stray for `validate` to refuse (`apps/cli/src/run.ts:187-264`). Compound names are matched longest-first, so `index status` beats `index` (`COMPOUND_NAMES`, `apps/cli/src/run.ts:162-172`).
3. `help` comes first. `memhtml help`, `--help`, and `-h` are answered before `validate` and before any layer is built, so help works on a machine with no repo (`apps/cli/src/run.ts:1699-1703`). A bare invocation then answers with the manifest (`buildManifest`, `apps/cli/src/run.ts:1705`).
4. `validate` rejects usage errors before any service exists, in a fixed order. Every refusal of a known command ends with a pointer to that command's help (`helpFor`, `apps/cli/src/run.ts:1370-1391`). For the four record-creating commands, `write`, `apply`, `correct`, and `task add`, `run` first reads the store's `v1Doors` mode from `memhtml.config.json`, so a closed door answers before anything opens. It reads the file only when it knows the root without a layer, and otherwise it leaves the door to the arm's own guard. A file that can't be read or decoded is `ERR_STORE_CONFIG` at exit 1 (`apps/cli/src/run.ts:1707-1723`).
5. The first check is the flag set. Flags are checked against this command's spec plus the true globals, so a flag that only another command takes is refused here. `memhtml list --status todo` is `ERR_INVALID_FLAG` naming the commands that take `--status`, instead of an unfiltered answer that looks filtered (`validateAgainst`, `apps/cli/src/run.ts:1402-1434`).
6. The value and presence checks follow, in this order. A boolean flag handed a space-separated value (`--embed false`) is refused first (`strayBooleanFlags`, `apps/cli/src/run.ts:1161-1170`). Then a positional past what the command declares is `ERR_UNEXPECTED_ARGUMENT`, unless the last argument is `repeatable` (`surplusArgs`, `apps/cli/src/run.ts:1199-1214`). Then a closed record door is refused, and a `session` command that names no session says so (`sessionBoundRefusal`, `apps/cli/src/run.ts:1443-1449`). Then come a missing required argument or flag, the claim-or-article rule, the `exec` flag rules, the `apply` flag rules, and the v2 commands' own flag rules (`claimOrArticle`, `execFlags`, `applyFlags`, `apps/cli/src/run.ts:1451-1497`). Then `--as-of` must pass the format's own `isValidDatetime` (`asOfFlag`, `apps/cli/src/run.ts:1136-1148`). Last, every value of a closed-vocabulary flag is checked, every occurrence of a `repeatable` flag included (`apps/cli/src/run.ts:1504-1522`).
7. Inside `validate`, after those checks, the two positional vocabularies are checked. These are `hook`'s event and the host an `integrations` verb names. A miss is exit 2 with the whole vocabulary listed, and nothing touches a store (`vocabularyPositionals`, `apps/cli/src/run.ts:1320-1361`).
8. Twenty-seven commands answer before `dispatch` without building the app layer, each for a stated reason. Twelve of them are v1 commands. `help` is the first (step 3). `manifest` must answer on a machine with no repo, and `agents-doc` must not scaffold a root as a side effect (`apps/cli/src/run.ts:1728-1753`). `eval discriminate` runs `runDiscrimination` against its own generated fixture (`apps/cli/src/run.ts:1755-1798`). The five `integrations` verbs must work before any store exists (`apps/cli/src/run.ts:1885-1937`). `serve mcp` must not open the database its child will serve (`serveMcp`, `apps/cli/src/run.ts:1947-1979`). `config` reads the store's policy file and the environment, so a store whose index was never built still has a policy to show (`configReport`, `apps/cli/src/run.ts:1999-2017`). `exec` reads a git tree only (`execCommand`, `apps/cli/src/run.ts:2019-2069`). The other fifteen are the v2 `session`, `head`, and `curate` commands, and none of them opens `index.db` (`isV2Command`, `apps/cli/src/run.ts:1223-1229`). `run` reads their script and op-stream inputs and their environment settings first, so a bad input is exit 2. It then answers `head serve`, `curate run`, `curate collapse`, and `session prune` itself and hands the other eleven to `runV2` in `apps/cli/src/v2.ts` (`apps/cli/src/run.ts:2071-2387`, `runV2`, `apps/cli/src/v2.ts:1906-1953`). `docs/design.md` §15 describes those command families.
9. `hook` also answers before `dispatch`, but it builds the app layer itself, and only after probing that a store exists. It has its own section below (`apps/cli/src/run.ts:1800-1883`).
10. Under `MEMHTML_REFUSE_ENV_ROOT`, every command past the `integrations` verbs needs its root named. A call with no `--repo` is `ERR_REPO_REQUIRED` at exit 2, before any service is built (`apps/cli/src/run.ts:1939-1945`). An injected layer can name the root for a dispatch arm. It can't for `serve mcp`, `exec`, `config`, or a v2 command, because those resolve the root themselves (`envRootRefusal`, `apps/cli/src/run.ts:1295-1308`, `ROOT_WITHOUT_LAYER`, `apps/cli/src/run.ts:1216-1244`).
11. `memhtml apply` reads and shape-validates its whole JSONL op stream here, before any service exists, so a malformed line is exit 2 with nothing written (`decodeApply`, `apps/cli/src/run.ts:2389-2412`). The stream arrives from `--file <path>`, or from stdin on `--file -`, a bare positional `-`, or no argument at all. Stdin beside a real `--file` is refused (`applyFlags`, `apps/cli/src/run.ts:813-832`).
12. `dispatch` switches on the command name. Each arm decodes flags, calls one shared use case, and names a response type (`apps/cli/src/run.ts:337-353`). It holds 30 arms, one for every command in the table except `help`, `hook`, `agents-doc`, `eval discriminate`, `serve mcp`, `config`, `exec`, the five `integrations` verbs, and the fifteen v2 commands. `manifest` keeps an arm although `run` answers it first. The four record arms run the door guard before their use case (`guardV1Door`, `apps/cli/src/run.ts:364-366`).
13. The envelope is built once, around the whole program. Success becomes exit 0. A typed failure becomes exit 1 through `failureFor`, except a closed record door that the arm's guard raised, which stays exit 2. An unexpected defect becomes `ERR_UNKNOWN` rather than a stack trace on stdout (`apps/cli/src/run.ts:2414-2446`).

### Related

- `apps/cli/src/envelope.ts:110` (`ERROR_CODES`)
- `apps/cli/src/envelope.ts:203` (`nearest`)
- `apps/cli/src/envelope.ts:234` (`render`)
- `apps/cli/src/errors.ts:42` (`codeFor`)
- `apps/cli/src/errors.ts:188` (`SUGGESTIONS`)
- `apps/cli/src/commands.ts:68` (`GLOBAL_FLAGS`)
- `apps/cli/src/api-layer.ts:409` (`layerApp`)

## Single memory write

Entry point: `apps/cli/src/operations.ts:344` (`writeMemory`)

1. The `write` dispatch arm reads the flags into the `WriteParams` that `writeMemory` takes (`apps/cli/src/run.ts:364-386`). `task add` reaches the same function with `memoryType` fixed to `task` and the title as the default claim (`apps/cli/src/run.ts:537-570`). The MCP twin is `memory_write` (`apps/mcp/src/handlers.ts:335-364`).
2. The record door has to be open first. `write`, `apply`, `correct`, and `task add` commit straight to the store and run no write bar, so the store's policy file `memhtml.config.json` can close them through its `v1Doors` key (`apps/cli/src/doors.ts:5-17`). The MCP tools `memory_write`, `memory_write_batch`, and `memory_correct` obey the same key (`packages/contracts/src/store-config.ts:23-36`). The file is read from the working tree at each decision and never cached, and with no file the library default applies (`apps/cli/src/store-config.ts:23-44`). `docs/design.md` §19 covers the policy file.
3. `v1Doors` has three modes (`v1DoorState`, `apps/cli/src/store-config.ts:101-118`). `open` never refuses. `closed-in-session`, the default, refuses in a process whose environment carries `MEMHTML_SESSION`, with `ERR_SESSION_BOUND`. `closed` refuses in every process, with `ERR_V1_DOOR_CLOSED` when no session is set and `ERR_SESSION_BOUND` when one is (`apps/cli/src/errors.ts:95-98`). Both refusals are exit 2, and their suggestions name the `session` command that does the same job (`apps/cli/src/doors.ts:39-106`). `link`, `archive`, `task status`, and `reinforce` edit existing records, and no mode closes them.
4. `run` applies the door inside `validate` when it could read the mode (CLI invocation, step 4). Otherwise the arm's own `guardV1Door` reads the policy at the layer's root and refuses inside the layer (`apps/cli/src/store-config.ts:120-133`, `apps/cli/src/run.ts:2414-2421`). A malformed or unreadable policy file is `ERR_STORE_CONFIG` at exit 1 on either path.
5. `toWriteInput` decodes the memory type through the OPERATOR vocabulary, so `memhtml write` may author an `arc` (issue #88) (`decodeOperatorType`, `apps/cli/src/operations.ts:287-304`). The agent doors stay narrow. `memory_write` refuses `arc` at schema decode through `WritableType` (`apps/mcp/src/tools.ts:59`).
6. `toWriteInput` also decodes the two task metas, before any file is rendered (`apps/cli/src/operations.ts:305-312`).
7. `store.writeMemory` runs the strict-path gate first. Under `--strict-path`, an unusable explicit path is refused before anything else is judged (`strictPathRefusal`, `packages/store/src/store.ts:685-720`, `packages/store/src/store.ts:724`).
8. It then takes one clock reading and renders the file through the template. `renderChecked` runs the format check over the rendered bytes and fails with the list of violations before anything is written, staged, or committed (`packages/store/src/store.ts:659-683`, `packages/store/src/store.ts:725-727`).
9. The content hash is looked up against the dedupe oracle next. A duplicate returns the existing path and leaves the tree byte-identical (`dedupeLookup`, `packages/store/src/store.ts:730-744`).
10. `freePathFor` resolves the placement rule's path, suffixing `-2`, then `-3`, until one is absent from disk (`packages/store/src/store.ts:412-472`).
11. A caller that named a valid explicit path gets that path or nothing. An occupied one is `WriteConflict`, which the envelope reports as `ERR_WRITE_CONFLICT`, with nothing written and no `-2` suffix. A quiet fallback would hand back a path with no file behind it, and a quiet overwrite would delete a memory in a corpus where eviction is a `git mv` (`packages/store/src/store.ts:424-456`).
12. The one exemption is `correctMemory`'s own target, whose path the same commit vacates into the archive (`packages/store/src/store.ts:428-430`). The recovery the envelope suggests for a `WriteConflict` is `memhtml correct <path>` (`apps/cli/src/errors.ts:200-213`).
13. The write, the stage, and the commit run under a journal. A failure or an interruption is compensated instead of leaving a written or staged file for the next clean-tree check to refuse. The commit carries the provenance trailers (`makeJournal`, `compensated`, `packages/store/src/store.ts:756-773`).
14. Every store write runs through `StoreShape.exclusive`, which takes two locks in order. The first is one in-process permit, `oneWriterAtATime`, so two concurrent MCP tool calls take turns instead of racing for a path or for `.git/index`. The second is the repository's checkout lock, `withCheckoutLock`, whose lock directory is `.memhtml/checkout.lock` (`packages/store/src/store.ts:1397-1424`, `packages/store/src/checkout-lock.ts:14-44`).
15. The checkout lock is cross-process. A CLI write beside a running MCP server and a session commit in any process take the same lock, so neither can sweep the other's staged file into its own commit (`packages/contracts/src/checkout-lock.ts:5-28`). A waiter retries for up to 15 s and then fails with `ERR_STORAGE` `checkout.locked`, having written nothing (`CHECKOUT_LOCK_WAIT_MS`, `packages/contracts/src/checkout-lock.ts:47-63`). `Git.commit` takes the lock too, reentrantly, so a caller that stages and commits outside the store is still excluded at the commit (`packages/store/src/git.ts:98-104`). `docs/design.md` §17 covers the session side of the lock.
16. `reindex` brings the index up to the whole commit the write just made, through the indexer's `update`. It never takes a caller-supplied path list (`apps/cli/src/operations.ts:248-271`). `writeMemory` calls it only when a file was created (`apps/cli/src/operations.ts:350`).
17. Two index properties rest on that. The first is that a rename is only expressible as a diff. Every correction and every archive is a `git mv`, and `update` reads `diff --name-status -M`, sees the `R`, and re-points the row, keeping the embedding. Indexing the destination alone would leave the source row live, so the archived memory would stay in `memhtml list` and its chunk rows would be duplicated under two paths (`apps/cli/src/operations.ts:254-258`).
18. The second is that only `update` records `index_state.head_sha`, without which `memhtml status` reports `index_fresh: false` forever (`apps/cli/src/operations.ts:259-261`).
19. `recordLink` then notes the session link, and it swallows its own failure (`apps/cli/src/operations.ts:193-218`, `apps/cli/src/operations.ts:351`).

### Related

- `packages/store/src/store.ts:503` (`makeJournal`)
- `packages/store/src/store.ts:565` (`compensated`)
- `packages/store/src/store.ts:657` (`renderFor`)
- `packages/store/src/checkout-lock.ts:39` (`withCheckoutLock`)
- `apps/cli/src/store-config.ts:125` (`guardV1Door`)
- `apps/cli/src/operations.ts:83` (`decodeWritableType`)
- `apps/mcp/src/handlers.ts:150` (`authored`)
- `apps/mcp/src/tools.ts:340` (`MemoryWrite`)

## Batch apply

Entry point: `apps/cli/src/operations.ts:746` (`batchWrite`)

1. `decodeApply` checks every JSONL line before any op runs. It fails on the first bad line and reports that line's number, and it skips blank lines while still counting them (`apps/cli/src/apply.ts:290-314`). Input with no op at all is refused as `ERR_MISSING_ARGUMENT` (`apps/cli/src/apply.ts:316-328`).
2. The `apply` arm passes the same record door `write` does before it calls `batchWrite` (`guardV1Door`, `apps/cli/src/run.ts:394-405`). Single memory write describes the `v1Doors` modes.
3. When `detectConflicts` is on, `detectFrameConflicts` computes each op's frame key and asks the index for live occupants in one query, folding earlier ops in as it walks. A lookup failure degrades to no conflicts (`apps/cli/src/operations.ts:491-579`, `apps/cli/src/operations.ts:763-766`).
4. When `detectNearDuplicates` is on, the ops' text is embedded in one call and compared with stored memories and with earlier ops at or above `NEAR_DUPLICATE_THRESHOLD`. Every failure degrades to "not checked", and the result says so in `nearDuplicatesDegraded` (`detectNearDuplicates`, `apps/cli/src/operations.ts:602-744`, `apps/cli/src/operations.ts:774-777`).
5. Fold one decodes each planned op through the singular write's own `toWriteInput`. An atomic decode abort returns at once, reports every op, and writes nothing (`apps/cli/src/operations.ts:779-818`).
6. The optional extraction assist, `ExtractorPort`, makes one model call over the decoded ops and unions the extracted entities into each op's own list. A failure produces a logged warning and an unextracted batch (`apps/cli/src/operations.ts:820-854`).
7. Fold two is `store.writeMemories`, which runs in two phases under the same permit and checkout lock a single write takes (`packages/store/src/store.ts:908-1035`, `packages/store/src/store.ts:1430`). Phase 1 validates every op against the batch's folded dedupe and path-claim state and writes nothing (`validateOp`, `packages/store/src/store.ts:937-960`). Phase 2 writes every file, stages once, and makes one commit under `makeJournal`, rolling back on any failure (`packages/store/src/store.ts:982-1014`).
8. One `reindex` runs after the commit, gated on a file having actually been written, so a dedupe-only batch doesn't move the watermark for a commit that never happened (`apps/cli/src/operations.ts:877-879`).
9. The MCP twin is `memory_write_batch`. It passes the record door before it looks at any op, resolves each op's body-or-article rule up front, and sends an atomic abort to the agent on the error channel as `batchAbortFailure` (`apps/mcp/src/handlers.ts:366-537`).

### Related

- `packages/store/src/store.ts:795` (`validateOp`)
- `packages/store/src/store.ts:374` (`dedupable`)
- `apps/cli/src/apply.ts:540` (`applyPayload`)
- `apps/mcp/src/failure.ts:298` (`batchAbortFailure`)

## Ranked retrieval

Entry point: `packages/index/src/retrieval.ts:506` (`search`)

1. The `search` and `recall` dispatch arms build one shared scope object from the same flag set, so the two commands can't narrow differently (`scopeOf`, `apps/cli/src/run.ts:302-314`, `SCOPE_FLAGS`, `apps/cli/src/commands.ts:125-173`). The MCP twins are `memory_search` and `memory_recall` (`apps/mcp/src/handlers.ts:557-653`).
2. `memory_search` and `memory_recall` ask the head server first and fall back to this flow when the socket gives no answer or the call needs the index, such as one with `include_archived`, `as_of`, or a quoted phrase (`routeFor`, `apps/cli/src/head-retrieval.ts:64-80`, `apps/mcp/src/handlers.ts:573-581`). The head-routed flow has its own section, [MCP memory_search through the head](#mcp-memory_search-through-the-head).
3. `gatedQueryVector` reads the vector coverage first, in one count statement. Below the floor, `VECTOR_COVERAGE_FLOOR` (0.95) unless configured otherwise, the vector arm is dropped and the query is never embedded, because a sparse plane ranks the embedded few above every lexical match (issue #141) (`packages/index/src/retrieval.ts:298-320`, `packages/index/src/vector-coverage.ts:43`).
4. Above the floor, `queryVector` embeds the query text. A model failure is caught and returns undefined, so the search degrades rather than erroring (`packages/index/src/retrieval.ts:259-280`).
5. `ftsQueryForms` reduces the caller's prose to indexable terms in two MATCH forms, all-terms and any-of, keeping a double-quoted span as one phrase. An apostrophe or a leading hyphen would otherwise be a hard driver error rather than an empty result (`packages/index/src/fts-query.ts:99-123`, `packages/index/src/retrieval.ts:338-354`).
6. A one-row probe through the caller's scope decides which form the lexical arm binds. It binds all-terms when some file in scope holds every term, and any-of otherwise (`holdsEveryTerm`, `packages/index/src/retrieval.ts:282-296`, `packages/index/src/retrieval.ts:355-358`, `buildFtsProbeSql`, `packages/index/src/retrieval-sql.ts:140-149`).
7. `activeArms` drops any arm whose precondition is absent, and that dropping is the entire degradation mechanism. The vector arm needs the query vector, the salience arm needs the attached state plane, and the lexical arm needs surviving query terms (`packages/index/src/retrieval-sql.ts:287-295`).
8. `buildRrfSql` assembles the surviving arms as CTEs, unions their weighted reciprocal ranks, and sums per path with `path ASC` breaking ties. It returns undefined when no arm fires (`packages/index/src/retrieval-sql.ts:297-319`).
9. `hydrate` fetches the full rows for the fused pool in fused order, in one statement, including both entity projections, the supersedes edge, and the first chunk's vector (`packages/index/src/retrieval.ts:378-429`). The pool is `MMR_POOL_FACTOR` (3) times the limit (`packages/index/src/retrieval.ts:511-516`).
10. The polarity step gives each candidate its reciprocal fused rank, then demotes a negation-flipped twin of a better-agreeing candidate (`polarityScored`, `packages/index/src/retrieval.ts:519-533`, `packages/index/src/polarity.ts:78`).
11. `applyMmr` reorders the pool down to the limit, using that score as the relevance term (`packages/index/src/retrieval.ts:534-539`, `packages/domain/src/mmr.ts:36`).
12. `search` fetches snippets for the final paths only. It returns hits plus `degraded`, `vectorCoverage`, `arms`, `entityScope`, and `scopeEmpty` (`packages/index/src/retrieval.ts:541-598`).
13. When the scope came back empty and no `asOf` is set, the result also carries `archivedMatches` and the archived paths, so a caller learns that the address resolves only in the archive (`archivedInScope`, `packages/index/src/retrieval.ts:549-558`, `packages/index/src/retrieval.ts:474-498`).
14. `recall` runs the same gate, fusion, and polarity step, then folds arcs and ordinary memories under separate character budgets (`foldDisclosure`, `packages/index/src/retrieval.ts:600-652`).

### Related

- `packages/index/src/retrieval-sql.ts:268` (`RANK_ARMS`)
- `packages/index/src/retrieval-sql.ts:343` (`buildSnippetSql`)
- `packages/index/src/scope.ts:236` (`assembleScope`)
- `packages/index/src/vector-coverage.ts:99` (`readVectorCoverage`)
- `packages/index/src/disclosure.ts:93` (`foldDisclosure`)
- `apps/cli/src/operations.ts:994` (`searchMemories`)

## Index projection

Entry point: `packages/index/src/indexer.ts:808` (`update`)

1. `guardEmbedModel` fails when the stored vector space disagrees with the configured one. It runs before any write, so an index can never hold rows under two models (`packages/index/src/indexer.ts:322-338`, `packages/index/src/indexer.ts:810`).
2. The recorded watermark is read. An absent watermark row means there's no index at all, so `update` falls through to `reproject`, the whole-tree pass a rebuild runs, without the `--no-embed` interlock (`packages/index/src/indexer.ts:812-834`).
3. A watermark row with no commit on it is a rebuild that died between its truncate and its watermark write. `update` refuses it with `IndexStale` rather than report a half-index as current (`packages/index/src/indexer.ts:836-846`).
4. `git diff --name-status -M` between the watermark and HEAD gives the committed changes, and `git status --porcelain=v2` gives the uncommitted working tree. Both keep an entry when its source or its destination passes `isIndexablePath` (`packages/index/src/indexer.ts:849-858`).
5. Every committed diff target's blob is read through `catFileBatch` in two subprocesses total rather than two per file, because a per-file tree walk was the term that made bulk ingest quadratic (`packages/index/src/indexer.ts:860-887`).
6. Committed changes are applied first. A deletion cascades its rows, a rename becomes a `movePath` that keeps the chunk row and its vector, a rename out of the corpus retires its source through `deletePath`, and every surviving path is re-projected (`packages/index/src/indexer.ts:909-954`).
7. The dirty working tree is applied second, so a path that both moved in a commit and was then edited ends at the working tree's content. A staged rename retires its source in the same pass through `movePath` (`packages/index/src/indexer.ts:956-992`).
8. Writes are applied in bounded batches, each atomic on its own, and `writeState` records the watermark. Recording the watermark is what makes "does the index describe the current commit" answerable (`applyWrites`, `packages/index/src/indexer.ts:280-286`, `packages/index/src/indexer.ts:994-995`).
9. `embedMissing` fills vectors. It's scoped to this pass's own chunk ids on the incremental path, and unscoped on a rebuild so a model migration can find every stale vector (`packages/index/src/indexer.ts:996-1002`, `packages/index/src/indexer.ts:527-560`, `packages/index/src/indexer.ts:657`).

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
4. The toolkit declares 15 tools with the batch second, directly after `memory_write`, because `tools/list` publishes this order and an agent reads it top-down (`MemhtmlToolkit`, `apps/mcp/src/tools.ts:1028-1057`).
5. `MemhtmlToolkit.toLayer` binds each handler and typechecks it against the toolkit's own parameter and success schemas, so a wrong shape is a compile error rather than a live decode failure (`ToolHandlers`, `apps/mcp/src/handlers.ts:316-334`).
6. Each handler renames snake_case wire parameters to the operations layer's camelCase and maps an explicit `null` to absent. It then calls the same shared use case the CLI command calls, such as `writeMemory` (`apps/mcp/src/handlers.ts:335-364`, `apps/mcp/src/handlers.ts:100-112`).
7. The three record-creating tools, `memory_write`, `memory_write_batch`, and `memory_correct`, run `guardV1Door` before anything else, the way the CLI's record arms do. MCP has no per-call session, so the server reads `MEMHTML_SESSION` from its own environment. Under `closed-in-session`, a server an agent runtime starts inside a run refuses, and a shared server started outside any run stays open (`apps/mcp/src/handlers.ts:316-329`, `apps/cli/src/store-config.ts:101-118`). `memory_link`, `memory_archive`, and `memory_reinforce` stay open in every mode. The refusal's reason is worded for a tool caller, because the CLI's wording names shell commands an MCP agent can't run (`mcpReasonFor`, `apps/mcp/src/failure.ts:151-165`).
8. `authored` resolves the body-or-article-html exclusive rule at the wire boundary. It rejects a call that supplies both and a call that supplies neither, instead of picking one (`apps/mcp/src/handlers.ts:114-174`).
9. `handled` maps every typed error through `toToolFailure` into the `ToolFailure` shape each tool declares. That branch passes the message through verbatim, so the client sees it instead of the framework's generic internal-error sentence (`apps/mcp/src/handlers.ts:55-78`, `apps/mcp/src/failure.ts:207`).

### Related

- `apps/mcp/src/tools.ts:212` (`BATCH_GUIDANCE`)
- `apps/mcp/src/tools.ts:154` (`ARTICLE_HTML_CONTRACT`)
- `apps/mcp/src/resources.ts:47` (`routerPathFor`)
- `apps/mcp/src/failure.ts:34` (`ToolFailure`)
- `apps/cli/src/api-layer.ts:409` (`layerApp`)
- `apps/cli/src/operations.ts:968` (`readMemory`)

## Hook invocation

Entry point: `apps/cli/src/run.ts:1829` (`hook`)

1. A host runs `memhtml hook <event> --host <host> --repo <root>` from the config `integrations install` wrote. Every host's entries run this one engine through `hookCommand`, so there's no shell script on disk to drift (`packages/integrations/src/render/hooks.ts:1-20`).
2. The engine knows four host-neutral events, `session-start`, `user-prompt-submit`, `pre-compact`, and `session-end` (`HOOK_EVENTS`, `packages/integrations/src/types.ts:20-30`). Cursor never gets a per-prompt hook, because its `beforeSubmitPrompt` can't inject context (`packages/integrations/src/render/hooks.ts:13-15`).
3. `validate` refuses an unknown event or host at exit 2, with the whole vocabulary as suggestions. That's the one case where a hook answers with an envelope, because a malformed hook config is something an operator has to be told (`vocabularyPositionals`, `apps/cli/src/run.ts:1341-1351`, `apps/cli/src/run.ts:1816-1821`).
4. Every later path exits 0, and every failure prints nothing. On `UserPromptSubmit` a non-zero exit is how a hook blocks the prompt, so the turn proceeds without memory rather than not proceeding (`apps/cli/src/run.ts:1811-1814`, `isHookEvent`, `apps/cli/src/run.ts:1833-1835`).
5. Under `MEMHTML_REFUSE_ENV_ROOT` with no `--repo`, the hook logs a warning on stderr and stays silent on stdout. It checks this above `envRootRefusal`, whose exit-2 envelope would land in a context window and block the prompt (`apps/cli/src/run.ts:1823-1827`, `apps/cli/src/run.ts:1844-1848`).
6. A hook never scaffolds a store. `hookStoreReady` probes the root's `.git` without creating anything, and a root with no store prints nothing (`apps/cli/src/hook.ts:335-356`, `apps/cli/src/run.ts:1860-1868`).
7. `readHookPayload` drains the host's stdin payload under `HOOK_STDIN_DEADLINE_MS` (500 ms). A read that throws, a host that writes nothing, and a host that never closes the pipe all mean no payload (`apps/cli/src/hook.ts:385-414`).
8. The deadline depends on the event. `pre-compact` and `session-end` get `HOOK_INDEX_DEADLINE_MS` (10 s), and every other event gets `HOOK_RECALL_DEADLINE_MS` (1.5 s) (`INDEXING_EVENTS`, `apps/cli/src/run.ts:1871`, `apps/cli/src/hook.ts:70-87`).
9. `hookText` builds `layerApp` from `--repo` and runs the engine. It also catches a failure raised while the layer is built, such as a failed migration, and answers it with the empty string (`apps/cli/src/run.ts:1633-1664`, `apps/cli/src/run.ts:1872-1881`).
10. `engine` returns the empty string at once for an event the host can't read, before the store is touched (`injects`, `apps/cli/src/hook.ts:212-223`, `apps/cli/src/hook.ts:297-302`).
11. On `user-prompt-submit` the engine searches on the prompt and injects the hits (`promptRecall`, `apps/cli/src/hook.ts:225-232`). On `session-start` it recalls on the working directory's last two path segments, then appends up to `OPEN_TASK_LIMIT` (5) open tasks from a separate task scan (`sessionPack`, `apps/cli/src/hook.ts:234-261`, `queryForCwd`, `apps/cli/src/hook.ts:205-210`).
12. On `pre-compact` and `session-end` the engine indexes the host's transcripts and injects nothing. When `--trace-root` didn't reach the layer, it declines rather than advance a watermark over the wrong tree (`indexTranscripts`, `apps/cli/src/hook.ts:263-287`).
13. `runHook` bounds the engine with `Effect.timeout` and catches every cause, so a blown deadline, a storage failure, and a defect all answer with the empty string (`apps/cli/src/hook.ts:314-333`).
14. Stdout carries what `renderHookOutput` renders and nothing else. Claude Code and OpenCode get plain text, Codex gets its `hookSpecificOutput` JSON, and Cursor gets `additional_context` on `session-start` only (`apps/cli/src/run.ts:1882`, `packages/integrations/src/dialect.ts:17-37`).

### Related

- `apps/cli/src/hook.ts:42` (`HookInput`)
- `apps/cli/src/hook.ts:373` (`hookConfigProvider`)
- `apps/cli/src/hook.ts:424` (`parseHookPayload`)
- `packages/integrations/src/dialect.ts:52` (`promptOf`)
- `apps/cli/src/commands.ts:1166` (`hook`)
- `apps/cli/src/envelope.ts:51-59` (`hook.output`)

## Session put

Entry point: `apps/cli/src/v2.ts:611` (`sessionPut`)

A session is a base commit plus a log of overlay ops at `.memhtml/sessions/<id>.json` (see `docs/design.md` §17). `session put` appends writes and entity edits to that log. It never touches the ref.

1. `validate` names the session before any other missing flag. With no `--id` and no `MEMHTML_SESSION`, the call is `ERR_MISSING_ARGUMENT`. An id that isn't one path segment of at most 128 characters is `ERR_INVALID_FLAG`, from the line or from the variable, at exit 2 (`sessionIdFlag`, `apps/cli/src/run.ts:936-971`, `SESSION_ID`, `packages/session/src/session.ts:62`).
2. `run` sends every `session`, `head`, and `curate` command down a branch that never builds the app layer, because none of them opens `index.db` (`isV2Command`, `apps/cli/src/run.ts:1223-1229`, `apps/cli/src/run.ts:2070-2081`).
3. The op stream is read from `--file`, or from stdin on `--file -`, a bare `-`, or no argument, and `decodeSessionPut` decodes the whole file before any repo opens. A `write` line goes through the same `opAt` that `apply` uses. A `label` or `unlabel` line carries exactly `op`, `path`, and `entity`. The first bad line is refused at exit 2 naming its number, and input with no op is `ERR_MISSING_ARGUMENT` at exit 2 too (`decodeSessionPut`, `apps/cli/src/apply.ts:385-439`, `apps/cli/src/run.ts:2126-2135`).
4. `sessionIdOf` takes `--id`, else `MEMHTML_SESSION`. The id is implicit when the variable supplied it, and run-bound whenever it equals the variable's value (`apps/cli/src/run.ts:973-988`). See `docs/design.md` §18.
5. An implicit id starts the session on first use. `ensureSession` returns at once when the log exists. Otherwise it calls `startSession` on `refs/heads/main`'s tip, or on `HEAD` when there's no `main`, which costs one `rev-parse` and no head load. A concurrent first use that loses the race with `session.exists` or `session.locked` waits up to `IMPLICIT_START_WAIT_MS` (5 s) for the log to appear (`apps/cli/src/v2.ts:413-469`, `startSession`, `packages/session/src/session.ts:230-264`).
6. `resumeSession` reads the log, and `sessionScopeOf` picks the scope from its ref. A ref under `refs/heads/curate/` is judged under `curate`, and every other ref under `session` (`apps/cli/src/v2.ts:627-629`, `apps/cli/src/v2.ts:503-504`).
7. Unless `--no-server` is set or the scope is `curate`, the CLI asks the head server's `/v1/neighbors` route. The body carries the session's base sha, its ops, the new lines, and the write instant (`apps/cli/src/v2.ts:630-647`). `askHead` answers `null` for every way of not getting an answer, so any failure takes the local path (`askHead`, `apps/cli/src/head-client.ts:221-229`). A curate-scope session judges locally because the server's route judges under `session`.
8. On the server, the route reads the store policy per request and runs `preparePuts` over the version at that base sha. `versionAt` builds that version from the held one by a tree diff and keeps the last four (`apps/cli/src/head-server.ts:1423-1440`, `versionAt`, `apps/cli/src/head-server.ts:995-999`). On the local path, the CLI reads the store policy, loads the head at the session's base with `loadHeadAt`, and runs the same `preparePuts` over the vector cache file (`apps/cli/src/v2.ts:653-668`).
9. `preparePuts` places each write over the session's view, which is the base plus the log through `withOverlay`. `toWriteInput` decodes it the way `memhtml write` does, and `putPathFor` picks the path the store would choose. An explicit valid path is kept as given, and a derived path that's taken gets `-2`, `-3`, and so on up to 1000. `renderTemplate` renders the file (`apps/cli/src/v2.ts:532-554`, `putPathFor`, `apps/cli/src/v2.ts:305-328`).
10. It judges the whole log plus the new ops against the base with `validateOps`, the call `commitSession` makes. A violation blocks the call when its kind blocks and it sits at a path this call's ops touch, or when it's the batch cap. `format`, `reserved-path`, `batch-cap`, and `write-bar` always block. In a run-bound session `duplicate` and `claim-edit` block too, and outside one they're reported and left to the caller (`apps/cli/src/v2.ts:555-564`, `BLOCKING_VIOLATIONS`, `apps/cli/src/v2.ts:333-357`).
11. A blocked call embeds and ranks nothing. Otherwise each put's nearest `PUT_NEIGHBORS` (3) records come from `searchHead`, with the vector arm when a cache and an embedder exist (`apps/cli/src/v2.ts:565-593`).
12. A blocked call fails with `InvalidMemory` naming every blocking violation, and nothing is appended (`apps/cli/src/v2.ts:669-676`).
13. `appendOps` appends in this process on both paths. It takes the session lock `<id>.lock` without waiting, so a held lock is `session.locked`. Under the lock it re-reads the log and refuses with `session.moved` when the ops changed since the call read them. Then it replaces the whole file atomically (`apps/cli/src/v2.ts:677`, `appendOps`, `packages/session/src/session.ts:325-335`, `withSessionLock`, `packages/session/src/session.ts:161-188`, `requireLogUnmoved`, `packages/session/src/session.ts:311-319`).
14. The payload reports whether this call started the session, what it appended, the paths, the label edits, the neighbors, the vector report, every violation, and `head`, whose `source` is `server` when the server answered (`apps/cli/src/v2.ts:678-698`).

### Related

- `packages/session/src/validate.ts:181` (`validateOps`)
- `packages/head/src/overlay.ts:147` (`withOverlay`)
- `apps/cli/src/head-protocol.ts:273` (`NeighborsRequest`)
- `apps/cli/src/head-cache.ts:177` (`loadVersion`)
- `packages/session/src/session.ts:194` (`writeState`)
- `apps/cli/src/v2.ts:442` (`ensureSession`)

## Session exec

Entry point: `apps/cli/src/v2.ts:853` (`sessionExec`)

`session exec` runs a script over the session's view in the just-bash sandbox and harvests what it wrote into ops (see `docs/design.md` §21).

1. `run` reads the script before any repo opens, from `--script`, else `--file`, else stdin. A blank script is `ERR_MISSING_ARGUMENT`. A request body past `EXEC_BODY_MAX_BYTES` (1 MiB) is `ERR_INVALID_FLAG`, measured on the body a server would get, so a script's fate doesn't depend on a server running. Both are exit 2 (`apps/cli/src/run.ts:2082-2125`, `EXEC_BODY_MAX_BYTES`, `apps/cli/src/head-protocol.ts:292`). `--lang` is `bash` unless it says `js`.
2. An implicit id starts the session first through `ensureSession`, before the server is asked, because the server reads the log and starts nothing (`apps/cli/src/v2.ts:870-873`).
3. Unless `--no-server` is set, `askHeadFor` sends the exec to `/v1/exec`. It waits for the answer for two queue waits, the run's own deadline, and `ANSWER_TIMEOUT_MS` (`execAnswerTimeoutMs`, `apps/cli/src/v2.ts:835-836`, `apps/cli/src/v2.ts:875-882`).
4. A served answer is the payload, with `server.used` true. A decline (`base-unservable` or `busy`), `no-server`, or another status runs the exec locally. A `lost` answer, where the server took the script and gave nothing usable back, fails with `ERR_STORAGE` naming `session status`, because the server may have appended the harvest (`apps/cli/src/v2.ts:883-914`).
5. On the server, `serveExec` runs one exec per session id at a time and declines `busy` after waiting `EXEC_QUEUE_WAIT_MS` (30 s). It reads the policy per request and reads the log. Its base is the held tip, or an ancestor of the tip built by tree diff, and any other base is `base-unservable` (`apps/cli/src/head-server.ts:1084-1134`, `execBase`, `apps/cli/src/head-server.ts:1008-1034`, `oneAtATime`, `apps/cli/src/head-server.ts:1058-1079`). The script runs on a worker from the exec pool, seeded from the base's cached image (`apps/cli/src/head-server.ts:1108`).
6. On the local path, the CLI reads the policy and the log and loads the head at the session's base (`apps/cli/src/v2.ts:916-928`).
7. Both paths run `execOverHead`. It overlays the session's ops on the base and calls `runSessionExec` under the session's scope (`apps/cli/src/v2.ts:740-751`).
8. `runSessionExec` seeds the guest from the view's bytes, archived records included, at `CORPUS_MOUNT` (`/mnt/memhtml`), and the mount is writable. A `bash` script goes to the interpreter as its own source text, and a `js` script runs through `js-exec`. The bound is `--timeout-ms`, else `DEFAULT_TIMEOUT_MS` (30 s), never past `MAX_TIMEOUT_MS` (600 s). A `bash` script's command and loop counts are unbounded, so the wall clock is the bound (`apps/cli/src/session-exec.ts:724-760`, `executionLimitsFor`, `apps/cli/src/session-exec.ts:671-680`, `apps/cli/src/exec.ts:33`, `apps/cli/src/exec.ts:51-61`).
9. The runner is `inProcessRunner` in the CLI and a pool worker on the server. `withBridgeRetry` runs the script again on a bridge fault, and every attempt starts from a fresh copy of the seed, so a faulted attempt's writes can't leak into the harvest (`apps/cli/src/session-exec.ts:762-780`).
10. `harvestOps` turns the files that differ from the seed into ops. A new file, or a seeded file whose article changed, is a `put`. A seeded file whose head gained or lost `memhtml-` links or `memhtml-entity` values is `link`, `unlink`, `label`, or `unlabel` ops. A vanished file paired with an `archive/<YYYY>/` twin holding the same article is an `archive`. A vanished file whose article reappears at exactly one new live path is a `move`. Everything else is `rejected` with a reason (`apps/cli/src/session-exec.ts:781-797`, `harvestOps`, `apps/cli/src/session-exec.ts:328`, `apps/cli/src/session-exec.ts:384-430`).
11. `execOverHead` judges the log plus the harvest against the base with `validateOps`, by the blocking rules `session put` uses (`apps/cli/src/v2.ts:752-762`).
12. The harvest is appended only when the script exited 0, no blocking violation was found, and there's at least one op. `appendOps` takes the session lock. A `session.moved` or `session.locked` refusal is reported in `blocking`, and the call still answers (`apps/cli/src/v2.ts:763-783`, `appendRefusal`, `apps/cli/src/v2.ts:702-707`).
13. The payload carries the exit code, stdout, stderr, the timing, the harvested and rejected paths, the count appended, every violation, and why the harvest stayed out when it did (`apps/cli/src/v2.ts:784-812`).

### Related

- `apps/cli/src/session-exec.ts:550` (`seedFor`)
- `apps/cli/src/session-exec.ts:645` (`inProcessRunner`)
- `apps/cli/src/exec-pool.ts:137` (`makeExecPool`)
- `apps/cli/src/exec.ts:249` (`withBridgeRetry`)
- `apps/cli/src/head-protocol.ts:315` (`EXEC_QUEUE_WAIT_MS`)

## Session commit

Entry point: `apps/cli/src/v2.ts:1099` (`sessionCommit`)

`session commit` lands the session's log on its ref as one commit (see `docs/design.md` §17 and §22).

1. `run` reads `MEMHTML_COMMIT_DEADLINE_MS` for `session commit` and `session rebase` before any repo opens. The value is whole milliseconds, `0` is no bound, and a malformed value is exit 2 naming the variable (`apps/cli/src/run.ts:2204-2209`, `msFromEnv`, `apps/cli/src/run.ts:2144-2160`). `--message` is required.
2. `sessionCommit` reads the store policy first. A malformed `memhtml.config.json` refuses with `ERR_STORE_CONFIG` before the server is asked, so it fails the same way on either path (`apps/cli/src/v2.ts:1114-1116`, `loadStorePolicy`, `apps/cli/src/store-config.ts:64-93`).
3. Unless `--no-server` is set, `askHeadFor` posts `{ id, message, dropRefused? }` to `/v1/commit` and waits `MEMHTML_COMMIT_DEADLINE_MS` for the answer, `COMMIT_DEADLINE_DEFAULT_MS` (60 s) when it's unset (`apps/cli/src/v2.ts:1117-1126`, `commitAnswerTimeoutMs`, `apps/cli/src/v2.ts:1021-1024`, `apps/cli/src/head-protocol.ts:373`).
4. A served answer returns with `via: "server"`. A decline (`other-ref`, `session-unreadable`, `base-unservable`, or `busy`), `no-server`, and a 4xx all commit locally. `no-server` covers every failure before the connection completed, because no byte of the request reached a server (`apps/cli/src/v2.ts:1127-1140`, `askHeadFor`, `apps/cli/src/head-client.ts:148-219`).
5. A 5xx after the server took the request, or no usable answer within the deadline, fails with `ERR_STORAGE` naming `session status`. The CLI doesn't retry locally because the ref may already have moved, and zero ops in `session status` means the commit landed (`unanswered`, `apps/cli/src/v2.ts:1047-1077`).
6. On the server, `serveCommit` runs one commit or rebase at a time. `holdingPermit` waits at most `COMMIT_QUEUE_WAIT_MS` (20 s) for the permit and declines `busy` past it, and a commit that started runs to its end whatever interrupts its request (`apps/cli/src/head-server.ts:1264-1290`, `holdingPermit`, `apps/cli/src/head-server.ts:385-396`, `apps/cli/src/head-protocol.ts:384`).
7. The server reads the policy per request. `sessionToWrite` declines a log that doesn't read as `session-unreadable` and a session on another ref as `other-ref` (`apps/cli/src/head-server.ts:1244-1261`). `commitBase` judges against the held tip, an ancestor built from it, or for a base off the ref's history a loaded version, and a failure to build one is `base-unservable` (`apps/cli/src/head-server.ts:1145-1171`).
8. On the local path, the CLI reads the log and loads the head at the session's base (`apps/cli/src/v2.ts:1141-1150`).
9. Both paths run `commitOverHead`. It appends the repoints the log's archives and moves lack against the version (`missingRepoints`), or refuses naming the archive or move whose repoints would take a log within the cap over it, and calls `commitSession` under the scope `sessionScopeOf` picks and with the store's write bar (`apps/cli/src/v2.ts:970-1009`).
10. Under `--drop-refused`, each `refused` round takes out every op that touches a path a violation names. A dropped archive or move takes its own repoint pairs with it, and the ops kept at a dropped move's destination and the edges kept ops aim at a dropped op's destination are moved back to its source, where the record still is (`afterDroppedVacates`, `packages/session/src/moves.ts:181-266`). The kept ops are completed again, and a pair that comes back is not reported. The round records what it took in `.memhtml/sessions/<id>.dropped.jsonl`, saves the log through `replaceOps`, and commits again. The loop ends at a clean log, an empty one, or a refusal no op carries, such as the batch cap (`apps/cli/src/v2.ts:1021-1059`, `opsToDrop`, `apps/cli/src/v2.ts:1248-1276`, `recordDropped`, `apps/cli/src/v2.ts:1312-1319`).

`commitSession` then runs this order (`packages/session/src/commit.ts:399-426`).

11. It holds the session lock for the whole call. First it refuses with `session.moved` when the log's ops changed since the caller read them, because step 7 writes an empty log and would drop them (`packages/session/src/commit.ts:451-458`).
12. Step 0 settles a `pending` commit under the checkout lock. When `pending` is reachable from the ref, it landed. The log moves its base there with zero ops, and the call answers `committed` with `recovered: true` and no contradictions. When it isn't reachable and `HEAD` is the ref, `read-tree -m -u pending <tip>` undoes a checkout update that ran without its swap, `pending` is cleared, and the call goes on. A `pending` that names no object never landed (`packages/session/src/commit.ts:465-491`, `settlePending`, `packages/session/src/commit.ts:348-383`).
13. Step 1 runs `validateOps` under the scope and the write bar. Any violation is `refused`, and nothing is written (`packages/session/src/commit.ts:493-500`).
14. Step 2 reads the ref. When it resolves and isn't at the validated base, the answer is `rebase-needed` with the overlapping paths and the ref's sha, whether or not any path overlaps (`packages/session/src/commit.ts:502-508`).
15. Step 3 folds the ops into writes and removes through `stage`. An archive stamps `memhtml-status` and `memhtml-archived` onto the source as the batch left it. `markContradictions` then gives each put a `memhtml-contradicts` link to every active record that shares its frame key (`packages/session/src/commit.ts:510-512`, `stage`, `packages/session/src/commit.ts:112-174`, `markContradictions`, `packages/session/src/commit.ts:180-211`).
16. Step 4 writes the blobs, the index, and the tree through `withTemporaryIndex`, a fresh directory under the OS temp dir that's removed on every exit. `commitTree` makes the commit with the subject `memhtml(<scope>): <summary>` and a `Memhtml-Session: <id>` trailer (`packages/session/src/commit.ts:514-534`, `withTemporaryIndex`, `packages/session/src/commit.ts:230-247`, `commitMessage`, `packages/session/src/commit.ts:76-80`).
17. Step 5 saves `pending: <commit>` to the log before anything shared moves (`packages/session/src/commit.ts:536-537`).
18. Step 6 is `landOnRef`, run under the checkout lock and uninterruptible once the lock is held. It re-reads the ref and answers `raced` when it moved. When `HEAD` is the ref, uncommitted state at a session path is `worktree-dirty`, and otherwise `read-tree -m -u` moves the shared index and working tree. Then `update-ref` moves the ref as a compare-and-swap, and a lost swap rolls the checkout back (`packages/session/src/commit.ts:539-556`, `landOnRef`, `packages/session/src/commit.ts:284-333`).
19. The checkout lock is `.memhtml/checkout.lock`, which every v1 store write also takes. A waiter tries for up to 15 s, pausing 10 ms and doubling to 250 ms. A lock with no refresh for 10 s is stale, and a holder refreshes it every 2 s. A wait that runs out fails with `ERR_STORAGE` `checkout.locked` (`packages/contracts/src/checkout-lock.ts:35-63`, `withCheckoutLockUsing`, `packages/contracts/src/checkout-lock.ts:128-195`).
20. A lock that was never taken clears `pending` and fails. `worktree-dirty` clears `pending` and answers `worktree-dirty`. `raced` clears `pending` and answers `rebase-needed` (`packages/session/src/commit.ts:549-567`).
21. Step 7 saves the log with its base at the new commit, zero ops, and no `pending`, and answers `committed` with `recovered: false` (`packages/session/src/commit.ts:569-580`).
22. On `committed`, `commitOverHead` writes the new commit's snapshot. The CLI builds it from the base by delta through `snapshotAfterCommit`. The server's `landed` moves its held version to the commit, writes the snapshot before it answers, and starts the vector fill. A failed snapshot is `snapshot: null` and never fails the call (`apps/cli/src/v2.ts:983-986`, `snapshotAfterCommit`, `apps/cli/src/head-cache.ts:270-288`, `landed`, `apps/cli/src/head-server.ts:1205-1230`).

### Related

- `apps/cli/src/head-protocol.ts:344` (`CommitRequest`)
- `apps/cli/src/head-protocol.ts:782` (`CommitDeclined`)
- `packages/session/src/session.ts:365` (`replaceOps`)
- `packages/session/src/session.ts:378` (`saveSessionLocked`)
- `packages/session/src/checkout-lock.ts:36` (`withCheckoutLock`)
- `apps/cli/src/v2.ts:1272` (`sessionStatus`)

## Session rebase

Entry point: `apps/cli/src/v2.ts:1229` (`sessionRebase`)

1. Unless `--no-server` is set, `askHeadFor` posts `{ id }` to `/v1/rebase` with the same deadline `session commit` uses. The fallback rules are the commit's. A decline, `no-server`, or a 4xx rebases locally, and a 5xx or a lost answer fails with `ERR_STORAGE` as a commit does (`apps/cli/src/v2.ts:1237-1263`).
2. On the server, `serveRebase` takes the same permit `serveCommit` takes and runs `sessionToWrite`. It reads the tip through `fresh`, and a ref that doesn't resolve is `base-unservable` (`apps/cli/src/head-server.ts:1293-1309`).
3. On the local path, the CLI reads the log, resolves the ref's tip, or `HEAD` when the ref doesn't resolve yet, and loads the head there (`apps/cli/src/v2.ts:1264-1268`, `baseShaFor`, `apps/cli/src/v2.ts:260-271`).
4. Both paths run `rebaseOver`. `rebaseSession` moves the base and keeps every op, and `saveSession` writes it under the session lock with the `session.moved` check (`apps/cli/src/v2.ts:1205-1220`, `packages/session/src/session.ts:341-356`).
5. Nothing is validated here. The kept ops are judged at the next commit against the new base (`packages/session/src/session.ts:337-344`).

## Head server lifecycle

Entry point: `apps/cli/src/head-server.ts:1626` (`serveHead`)

`memhtml head serve` is a long-running process that holds the corpus version loaded and answers JSON over HTTP on the store's socket (see `docs/design.md` §22).

1. `validate` refuses a negative or non-integer `--poll-ms` and a blank `--ref` at exit 2 (`headServeFlags`, `apps/cli/src/run.ts:1057-1076`). `run` reads `MEMHTML_EMBED_DEADLINE_MS`, `MEMHTML_EMBED_WARM_IDLE_MS`, `MEMHTML_EXEC_POOL_SIZE`, and `MEMHTML_EXEC_WORKER_HEAP_MB`, and a malformed value is exit 2 naming the variable (`apps/cli/src/run.ts:2161-2203`).
2. `run` resolves the embedder for the four v2 commands that embed and calls `serveHead` (`V2_EMBEDDING_COMMANDS`, `apps/cli/src/run.ts:1236-1241`, `apps/cli/src/run.ts:2284-2297`).
3. `startHeadServer` derives the endpoint, `.memhtml/head.sock` or on win32 the named pipe `\\.\pipe\memhtml-<16 hex>`. It refuses a socket path past the platform's byte limit (107 on Linux and Android, 103 elsewhere) with `HeadSocketPathTooLong`, which is `ERR_STORAGE`, before it loads anything (`apps/cli/src/head-server.ts:543-546`, `refuseLongSocket`, `apps/cli/src/head-server.ts:474-491`, `headEndpoint`, `apps/cli/src/head-protocol.ts:60-66`, `socketPathMax`, `apps/cli/src/head-protocol.ts:84-87`).
4. It resolves the ref to follow (`--ref`, else the branch `HEAD` points at, else `main`) and that ref's tip. A ref that doesn't resolve fails with `head.serve.ref`. It loads the tip through `loadHeadAt` and holds that one version with its parent pointer cut (`apps/cli/src/head-server.ts:587-603`, `followedRef`, `apps/cli/src/head-server.ts:522-525`).
5. It builds the exec pool in its scope, plus four gates of one permit each, for advances, snapshots, the vector cache, and commits (`apps/cli/src/head-server.ts:705-715`). The pool's default size is the available parallelism minus one, at least 1 and at most 4 (`defaultExecPoolSize`, `apps/cli/src/exec-pool.ts:60-61`).
6. `claimSocket` probes the endpoint after the load. No file is `absent`. A file that isn't a socket fails. A connect that completes, or that neither completes nor refuses within `CONNECT_TIMEOUT_MS` (100 ms), is `live`, and the server refuses with `HeadServerRunning`, which is `ERR_HEAD_SERVER_RUNNING`, naming the running server's pid, ref, and sha. `ECONNREFUSED` is `stale`, and the file is removed with a warning (`apps/cli/src/head-server.ts:1479`, `claimSocket`, `apps/cli/src/head-server.ts:497-519`, `probeSocket`, `apps/cli/src/head-server.ts:430-468`).
7. It reads the vector cache once, adds `.memhtml/head.sock` to the clone's exclude file, and registers the socket file's removal before the listener, so the file goes last on close (`apps/cli/src/head-server.ts:1480-1489`).
8. It binds with the umask narrowed to `0o177` around the bind, so the socket is never reachable by another user, then sets mode 0600 and serves (`apps/cli/src/head-server.ts:1491-1527`).
9. It starts a background vector fill for records the cache lacks, the poll, and the warmup. The poll runs every `--poll-ms` (`DEFAULT_POLL_MS`, 1000), and 0 turns it off. The warmup runs only when `MEMHTML_EMBED_WARM_IDLE_MS` is above 0, and it's 0 by default (`apps/cli/src/head-server.ts:1528-1586`, `apps/cli/src/head-server.ts:199`, `EMBED_WARM_IDLE_DEFAULT_MS`, `apps/cli/src/head-protocol.ts:140`).
10. `serveHead` logs the listening line to stderr and waits for SIGTERM or SIGINT (`apps/cli/src/head-server.ts:1634-1639`, `untilSignal`, `apps/cli/src/head-server.ts:1608-1620`).
11. Every answer that reads the version goes through `fresh`. It reads the ref with one `rev-parse` and answers from the held version when the ref is where it was. When the ref moved, `advance` runs under the advance permit. It reads the ref again, advances the held version over the changed paths with `advanceHead`, writes the new version's snapshot in the background, and starts the vector fill. A ref that stops resolving is answered at the held version with a warning (`apps/cli/src/head-server.ts:938-969`).
12. An unknown route is a 404 with `ERR_UNKNOWN_COMMAND`. A body the route's schema refuses is a 400 with `ERR_INVALID_FLAG`, and any other failure is a 500 carrying the failure envelope (`apps/cli/src/head-server.ts:1462-1477`).
13. On the signal, the scope closes. The poll, the warmup, and the pool's workers stop, the listener closes with a 2 s grace for requests in flight, and the socket file is removed. The `head.served` envelope reports the ref, the final sha, the records, the signal, the load source, the advances, the requests, and the uptime (`apps/cli/src/head-server.ts:1640-1653`, `SHUTDOWN_GRACE`, `apps/cli/src/head-server.ts:262`).

### Related

- `apps/cli/src/head-protocol.ts:21` (`HEAD_ROUTES`)
- `apps/cli/src/head-server.ts:535` (`startHeadServer`)
- `apps/cli/src/head-server.ts:385` (`holdingPermit`)
- `packages/head/src/version.ts:165` (`advanceHead`)
- `apps/cli/src/head-cache.ts:242` (`writeHeadSnapshot`)
- `apps/cli/src/head-client.ts:44` (`CONNECT_TIMEOUT_MS`)

## Search through the head server

Entry point: `apps/cli/src/v2.ts:1399` (`headSearch`)

1. `run` reads `MEMHTML_EMBED_DEADLINE_MS` and resolves the embedder (`apps/cli/src/run.ts:2161-2165`, `apps/cli/src/run.ts:2271-2278`).
2. Unless `--no-server` is set, `askHead` posts the query, the limit, and a deadline the caller set to `/v1/search` (`apps/cli/src/v2.ts:1408-1421`). The client waits `CONNECT_TIMEOUT_MS` (100 ms) for the socket to accept and `ANSWER_TIMEOUT_MS` (10 s) for the answer (`apps/cli/src/head-client.ts:44-51`).
3. The server decodes the body strictly and takes the version through `fresh`, so the answer is never older than the ref at the moment of the request (`apps/cli/src/head-server.ts:1363-1368`).
4. `vectorsForQuery` embeds the query over the held vector cache, waiting the request's `embedDeadlineMs`, else the server's deadline, else `EMBED_DEADLINE_DEFAULT_MS` (450 ms). Past the deadline the search runs on the lexical arm and `vector` says `embed-timeout` (`apps/cli/src/head-server.ts:1369-1377`, `apps/cli/src/head-protocol.ts:123`). The late embed is left to finish when fewer than `LATE_EMBEDS_MAX` (1) are finishing, and interrupted otherwise (`late`, `apps/cli/src/head-server.ts:760-791`).
5. `searchHead` ranks with the decoded body passed whole, plus the arm's inputs and, for a scoped search, the scope as a predicate. A `detail` request adds each hit's record detail (`apps/cli/src/head-server.ts:1378-1414`).
6. `searchHead` fuses a BM25 lexical arm capped at `LEXICAL_ARM_LIMIT` (40) and, when a query vector exists, a cosine vector arm capped at `VECTOR_ARM_LIMIT` (40). It uses reciprocal rank fusion at `k = 60` with both weights at 1.0, over active records only, and recency only breaks exact ties in the fused score (`packages/head/src/search.ts:211-265`, `packages/head/src/search.ts:57-79`, `packages/domain/src/ranking.ts:8-15`). See `docs/design.md` §16.
7. A served answer returns its hits, its vector report, and `head` with `source: "server"` (`apps/cli/src/v2.ts:1422-1432`). With no answer, the CLI loads the head at `HEAD`, embeds the query over the cache file under the same deadline, and runs `searchHead` itself (`apps/cli/src/v2.ts:1434-1447`).

### Related

- `apps/cli/src/head-protocol.ts:183` (`SearchRequest`)
- `apps/cli/src/head-vectors.ts:206` (`vectorsForQuery`)
- `apps/cli/src/head-vectors.ts:147` (`loadForSearch`)
- `packages/head/src/lexical.ts:98` (`tokenize`)

## MCP memory_search through the head

Entry point: `apps/mcp/src/handlers.ts:557` (`memory_search`)

1. The handler builds the same search parameters `memhtml search` builds (`apps/mcp/src/handlers.ts:557-571`).
2. `searchOnHead` asks `routeFor` where the call goes. The index answers when `MEMHTML_MCP_HEAD` is `off`, when the call sets `include_archived` or `as_of`, when the query holds a double-quoted phrase, and when it has no term the head's BM25 indexes. Every other call goes to the head (`apps/cli/src/head-retrieval.ts:68-80`, `apps/cli/src/head-retrieval.ts:128-137`).
3. `ask` posts the query, the limit, the scope axes the call named, and `detail: true` to `/v1/search`, and waits `HEAD_RETRIEVAL_TIMEOUT_MS` (2 s) for the answer. An answer with no scope report, or with a hit that lacks detail, counts as no answer (`apps/cli/src/head-retrieval.ts:93-118`, `apps/cli/src/head-retrieval.ts:42`).
4. The server applies the scope with `admitFor` and reports it with `scopeReportOf` (`apps/cli/src/head-server.ts:1381-1405`).
5. `searchOnHead` maps the answer onto v1's `SearchResult`. `degraded` is true when the vector arm didn't run, and `arms` names `fts`, `vector` when it ran, and `recency`. Through the head there's no salience arm and no MMR diversification (`apps/cli/src/head-retrieval.ts:138-165`, `armsOf`, `apps/cli/src/head-retrieval.ts:124-125`).
6. A `null` from `searchOnHead` sends the call to `searchMemories`, the index flow under Ranked retrieval (`apps/mcp/src/handlers.ts:580-581`).
7. `memory_recall` takes the same route. It asks for `DEFAULT_SEARCH_LIMIT * MMR_POOL_FACTOR` candidates and folds them with v1's `foldDisclosure`, arcs under their own budget (`recallOnHead`, `apps/cli/src/head-retrieval.ts:172-214`, `apps/mcp/src/handlers.ts:617-619`).

### Related

- `apps/cli/src/head-protocol.ts:150` (`MCP_HEAD_VAR`)
- `apps/cli/src/head-scope.ts:106` (`admitFor`)
- `apps/cli/src/head-protocol.ts:592` (`SearchAnswer`)

## Curate run

Entry point: `apps/cli/src/curate-run.ts:529` (`curateRun`)

`curate run` is the curator. It's a bounded model loop that works as a session on its own `curate/<date>` branch (see `docs/design.md` §23).

1. `validate` refuses a `--ref` outside `refs/heads/curate/`, a malformed `--model`, and a non-positive `--max-steps` or `--wall-clock-ms` at exit 2 (`curateRunFlags`, `apps/cli/src/run.ts:879-920`).
2. `run` resolves the model from `--model`, else `MEMHTML_CURATOR_MODEL`, else the default model through `proxy:` when a proxy is configured. With none of the three, the call is `ERR_MISSING_ARGUMENT` at exit 2 (`apps/cli/src/run.ts:2211-2264`).
3. `curateRun` defaults the ref to `curate/<UTC date>`, and the session id is the ref with slashes as dashes. It refuses a ref outside `refs/heads/curate/` again, and a ref `HEAD` names, because a commit there would move the working tree (`apps/cli/src/curate-run.ts:541-561`).
4. It reads the store policy once, renders the charter, the shipped `charter.md` or `--charter <file>`, with the policy's quota and refused types, and builds the model (`apps/cli/src/curate-run.ts:564-572`, `charterFor`, `apps/cli/src/curate-run.ts:165-178`).
5. `--resume` reads the session's log and loads its base. Otherwise the base is `main`'s tip, or `HEAD`, and `startSession` opens the curate session, which `session.exists` refuses when the id has a log. A dry run works over an in-memory overlay and writes no log, ref, or commit (`apps/cli/src/curate-run.ts:574-601`).
6. Code computes the briefing over the starting view, with each recent record's neighbors from `searchHead` and the policy's writer buckets and placement quota (`apps/cli/src/curate-run.ts:603-614`).
7. `bindTools` binds `search`, `read`, `exec`, `propose`, and `status`. `exec` runs a JS module through `runSessionExec`, and `propose` takes ops. Both complete the edge repoints of a move or an archive with `withRepoints`, judge under the `curate` scope with the write bar, and refuse any op that carries a violation, handing the violations back to the model (`apps/cli/src/curate-run.ts:357-457`).
8. `runCurator` calls `generateText` with the charter as the system prompt and the briefing as the prompt. It stops on a `finish` call, the wall clock, `maxOps`, or `maxSteps`, and a text-only step ends the run with the text as its report (`packages/curator/src/loop.ts:212-247`). The default budget is 40 steps, 32,000 output tokens per call, 20 minutes, and 200 ops (`DEFAULT_BUDGET`, `packages/curator/src/budget.ts:24-29`).
9. A run stopped by `modelError` fails with `ERR_MODEL_UNAVAILABLE`, and its ops stay in the session for `--resume` (`apps/cli/src/curate-run.ts:627-634`).
10. A dry run answers `dry-run`, and a run with zero ops answers `no-ops` (`apps/cli/src/curate-run.ts:655-661`).
11. Otherwise `land` commits the session under the `curate` scope. Before the first attempt, and after each rebase, it appends the repoints the log's archives and moves lack against the version it commits over (`missingRepoints`). `rebase-needed` reloads the head at the new tip, rebases, saves, and tries again, up to `COMMIT_ATTEMPTS` (8). `refused` fails naming the violations with the log kept for `--resume`, and `worktree-dirty` is `ERR_DIRTY_TREE` (`land`, `apps/cli/src/curate-run.ts:470-521`, `apps/cli/src/curate-run.ts:663-669`).
12. The curate tip's snapshot is written so `curate merge` loads both tips from the cache, and the report names `memhtml curate merge <ref>` as the next step (`apps/cli/src/curate-run.ts:670-678`, `apps/cli/src/curate-run.ts:652`).

### Related

- `packages/curator/src/loop.ts:102` (`runCurator`)
- `packages/curator/src/charter.ts:40` (`CURATOR_CHARTER`)
- `apps/cli/src/curate-run.ts:121` (`curateRefProblem`)
- `apps/cli/src/curate-run.ts:137` (`curateSessionId`)
- `packages/curator/src/tools.ts:83` (`CuratorTools`)

## Curate merge

Entry point: `apps/cli/src/v2.ts:1624` (`curateMerge`)

`curate merge` is the one door from a curate branch to its target. It refuses first, gates second, and moves last, so a call that fails leaves the repository as it found it (`apps/cli/src/v2.ts:1587-1623`).

1. `validate` refuses a blank `--into` and a ref that would land on itself at exit 2 (`curateMergeFlags`, `apps/cli/src/run.ts:843-860`).
2. `curateMerge` reads the store policy and qualifies both names, with `--into` defaulting to `main` (`apps/cli/src/v2.ts:1635-1638`).
3. Both refs must resolve (`apps/cli/src/v2.ts:1640-1655`). When the target's tip is an ancestor of the curate ref's tip, the landing is a fast-forward. Otherwise it's a replay (`apps/cli/src/v2.ts:1656`).
4. A replay is planned before the gate. `replayPlan` finds the merge base, refusing two refs that share no history, and rebuilds the curator's log from the trees at the merge base and at the ref's tip with `reconstructOps` under the `curate` scope. A change that isn't a session op refuses the merge naming its path (`replayPlan`, `apps/cli/src/v2.ts:1551-1585`).
5. The replay then loads the target's tip, starts the session `merge-<short sha>` on the target with `force`, and appends the rebuilt ops completed with `withRepoints`. `validateOps` judges them under the `curate` scope with no batch cap and the write bar, and any violation refuses with nothing moved (`apps/cli/src/v2.ts:1663-1688`).
6. The gate runs next unless `--skip-gate` is set, which logs a warning and reports `ran: false`. `headGate` loads the target's tip and the curate ref's tip and runs `gateHeads` over them, and a failing report fails with `HeadGateFailed`, which is `ERR_DISCRIMINATION_FAILED`, with nothing moved (`apps/cli/src/v2.ts:1690-1699`, `headGate`, `apps/cli/src/head-gate.ts:93-109`).
7. A replay lands through `landReplay`. It calls `commitSession` with the subject `<the ref's tip subject> (replayed onto <short sha>)` under the `curate` scope with no batch cap, up to `MERGE_ATTEMPTS` (8). `rebase-needed` reloads the head at the new tip and tries again, `refused` fails with the violations, and `worktree-dirty` is `ERR_DIRTY_TREE` (`landReplay`, `apps/cli/src/v2.ts:1771-1852`).
8. After a replay commits, the curate ref is moved to the landed commit by a compare-and-swap against its old tip. A lost swap logs a warning and the landing stands. The new tip's snapshot is written, and the report carries `moved: true` and the replay's account (`apps/cli/src/v2.ts:1800-1830`).
9. A fast-forward whose two tips are equal answers `moved: false` (`apps/cli/src/v2.ts:1716-1728`).
10. Any other fast-forward runs `landOnRef` on the target, the section a session commit lands with, under the checkout lock. `worktree-dirty` is `ERR_DIRTY_TREE`, and `raced` refuses because the target moved while the gate ran. A landing writes the new tip's snapshot and answers `moved: true` (`apps/cli/src/v2.ts:1730-1764`).

### Related

- `apps/cli/src/replay.ts:135` (`reconstructOps`)
- `packages/head/src/gate.ts:198` (`gateHeads`)
- `apps/cli/src/head-gate.ts:58` (`gateReportOf`)
- `apps/cli/src/v2.ts:1535` (`MERGE_ATTEMPTS`)
- `packages/session/src/moves.ts:20` (`withRepoints`)

## Curate collapse

Entry point: `apps/cli/src/curate-collapse.ts:857` (`curateCollapse`)

`curate collapse` cuts the head into archive, fold, and keep clusters with no model call, runs the first two kinds on one curate branch, and reports the third (see `docs/design.md` §23).

1. `validate` applies the `curate run` rules and also refuses a non-positive `--concurrency` or `--limit` at exit 2 (`apps/cli/src/run.ts:900-916`). `run` reads `--plan` and `--rulings` files and splits `--only` on commas (`apps/cli/src/run.ts:2311-2336`).
2. `curateCollapse` defaults the ref to `curate/<UTC date>-collapse` and refuses a ref outside `refs/heads/curate/` or a ref `HEAD` names (`apps/cli/src/curate-collapse.ts:870-884`).
3. It reads the store policy once, builds the model, and renders the collapse charter, the shipped `collapse.md` or `--charter <file>` (`apps/cli/src/curate-collapse.ts:893-895`).
4. `makeHeadCache` loads the version at the ref's tip, else `main`'s, else `HEAD`'s, once through the snapshot cache, and then advances that one held version by delta to each new tip (`apps/cli/src/curate-collapse.ts:897-899`, `tipOf`, `apps/cli/src/curate-collapse.ts:349-361`).
5. The plan is a saved `--plan` or `planCollapse` over the loaded view, with the rulings, the writer buckets, and the refused types (`apps/cli/src/curate-collapse.ts:900-911`). `--only` and `--limit` narrow the archive and fold clusters to execute, and every other cluster is reported under `untouched` (`apps/cli/src/curate-collapse.ts:913-935`).
6. A dry run reports each selected cluster as `dry-run` and executes nothing (`apps/cli/src/curate-collapse.ts:939-940`).
7. Archive clusters run first, one at a time, with no model. Each is cut into chunks of `ARCHIVE_CHUNK` (180), and each chunk is validated against the tip it starts from. A member already archived, or whose destination exists, is skipped and named. A refused chunk is skipped with a warning, and a clean chunk lands as its own session through `land` (`apps/cli/src/curate-collapse.ts:947-953`, `archiveCluster`, `apps/cli/src/curate-collapse.ts:435-502`, `landOps`, `apps/cli/src/curate-collapse.ts:401-433`).
8. Fold clusters run next through a pool of `--concurrency` (4 by default). Each opens a curator session under the collapse charter and `FOLD_BUDGET` (14 steps, 15 minutes, 200 ops), and the model writes the canonical `put` (`foldCluster`, `apps/cli/src/curate-collapse.ts:596-679`, `apps/cli/src/curate-collapse.ts:954-959`, `FOLD_BUDGET`, `apps/cli/src/curate-collapse.ts:98-100`).
9. The driver then adds an `archive` for each member the model left active and a `supersedes` link the canonical lacks, in the same session while `BATCH_CAP` allows. The session lands through `land`, and follow-up sessions settle what's left (`apps/cli/src/curate-collapse.ts:693-781`, `followUp`, `apps/cli/src/curate-collapse.ts:522-593`).
10. When the ref moved, its tip's snapshot is written from the held version. The report carries the plan totals, each cluster's outcome, a summary, and `memhtml curate merge <ref>` as the next step (`apps/cli/src/curate-collapse.ts:966-1000`).

### Related

- `packages/curator/src/planner/plan.ts:234` (`planCollapse`)
- `packages/curator/src/charter.ts:119` (`COLLAPSE_CHARTER`)
- `packages/curator/src/planner/types.ts:112` (`ARCHIVE_CHUNK`)
- `apps/cli/src/curate-collapse.ts:276` (`makeHeadCache`)
- `apps/cli/src/curate-run.ts:470` (`land`)

## Session prune

Entry point: `apps/cli/src/v2.ts:1328` (`sessionPrune`)

1. `--older-than` is required. `parseOlderThan` reads it through `ms`, and `validate` refuses a bare number or a negative duration at exit 2, because `--older-than 7` read as seven milliseconds would prune every idle log (`sessionPruneFlags`, `apps/cli/src/run.ts:1019-1030`, `parseOlderThan`, `apps/cli/src/v2.ts:1300-1322`). `session prune` names no session, so the `--id` rules skip it (`apps/cli/src/run.ts:938`).
2. `run` calls `sessionPrune`, which hands the cutoff to `pruneSessions` (`apps/cli/src/v2.ts:1333-1340`, `apps/cli/src/run.ts:2337-2344`).
3. `pruneSessions` computes the cutoff, and a lock cutoff that's never younger than `SESSION_LOCK_STALE_MS` (30 s). It lists every id with a `.json`, `.idx`, or `.lock` entry under `.memhtml/sessions/` (`packages/session/src/prune.ts:174-188`, `idsUnder`, `packages/session/src/prune.ts:147-169`).
4. It handles up to 16 ids at once. An id whose lock directory was refreshed since the lock cutoff is `busy` and left alone. A dry run reads without a lock. A real run takes the session lock, which also reclaims a stale lock directory, and a lock another writer took meanwhile is `busy` (`packages/session/src/prune.ts:227-249`).
5. For each id it removes an `<id>.idx` file older than the cutoff. It reads the log's mtime and text from one file handle. A log younger than the cutoff is kept. A log that doesn't decode is kept under `unreadable`. A log that holds ops is kept under `unlanded` with its id, op count, `pending`, and age. A log with zero ops is removed (`packages/session/src/prune.ts:191-225`).
6. It deletes every ref under `refs/memhtml/sessions/` whose commit's committer time is older than the cutoff (`packages/session/src/prune.ts:251-255`).
7. The report gives each category's count, `unlanded` oldest first, `busy`, and `unreadable`. The CLI adds `olderThan` and each unlanded log's age in `ms`'s short form (`packages/session/src/prune.ts:257-275`, `apps/cli/src/v2.ts:1341-1345`).

### Related

- `packages/session/src/prune.ts:65` (`PruneReport`)
- `packages/session/src/session.ts:80` (`SESSION_REFS_PREFIX`)
- `packages/session/src/session.ts:67` (`SESSION_LOCK_STALE_MS`)

## Minor flows

- Initialize a root: entry at `apps/cli/src/run.ts:357` (`init`). `initRepo` is convergent. It runs `git init -b main` only when the root isn't a repo yet, sets the merge driver every clone needs, writes the missing scaffold files, and commits only when the index differs from HEAD. The stage and the commit run under the checkout lock (`packages/store/src/layout.ts:198-246`).
- Read a memory: entry at `apps/cli/src/operations.ts:968` (`readMemory`). Reads the file, records a session link, and bumps salience, because an explicit open is a choice and a search hit is only the ranker's guess (`apps/cli/src/operations.ts:955-975`). The MCP twin is `memory_read`, and the `memhtml://file/{path}` resource funnels through the same `readMemory` (`apps/mcp/src/handlers.ts:539-555`, `apps/mcp/src/resources.ts:166-208`).
- Correct a memory: entry at `apps/cli/src/operations.ts:1062` (`correctMemory`). It's a record door. The store's `v1Doors` mode applies to `correct` and to its MCP twin `memory_correct` alike (`apps/cli/src/run.ts:448-462`, `apps/mcp/src/handlers.ts:655-680`). It reads the target first, renders and gates the superseding file, stamps the validity window on both sides, and lands the new file plus the archived target in one commit. The archive move runs before the new bytes are written, so a correction in place archives the original fact (`packages/store/src/store.ts:1045-1144`).
- Archive a memory: entry at `apps/cli/src/operations.ts:1112` (`archiveMemory`). This is a soft eviction. It runs `git mv` into `archive/<YYYY>/`, applies the archive stamps at the destination with `setMeta`, and then runs one diff-driven reindex (`stageArchive`, `packages/store/src/store.ts:579-613`, `packages/store/src/store.ts:1146-1172`). The MCP twin is `memory_archive`.
- Link two memories: entry at `apps/cli/src/operations.ts:1099` (`linkMemories`). Decodes the rel against the authorable set, refuses a self-link and an edge whose class disagrees with its endpoints' types, and is idempotent on the pair, so a re-link commits nothing (`requireEndpointClasses`, `packages/store/src/store.ts:1279-1358`). The MCP twin is `memory_link`.
- Resolve a moved path: entry at `apps/cli/src/operations.ts:1539` (`resolveMemory`). Walks `supersedes` forward and follows the archive mapping, naming every node by the path that holds it now (`apps/cli/src/operations.ts:1501-1538`). It stops for one of five reasons, the last after `RESOLVE_MAX_HOPS` (16) steps (`RESOLVE_STOP_REASONS`, `apps/cli/src/operations.ts:1386-1419`). The MCP twin `memory_resolve` adds a pinned citation URI built by `pinnedUri` (`apps/mcp/src/handlers.ts:726-759`, `apps/mcp/src/resources.ts:308-320`).
- Open a task: entry at `apps/cli/src/run.ts:537` (`task add`). This is the single write with `memoryType` fixed to `task`, so the same record door applies. A task is never a dedupe match, because two open tasks with identical bodies are two real work items (`activePathForHash`, `packages/index/src/traces-persist.ts:196-203`, `DEDUPE_EXEMPT_TYPE`, `packages/store/src/store.ts:350-363`).
- Move a task's status: entry at `apps/cli/src/operations.ts:1976` (`setTaskStatus`). Splices the status meta in place with `setMeta` so the article's bytes and content hash can't move, and routes `done` through `archiveMemory` so the stamp and the move land in one commit (`apps/cli/src/operations.ts:1958-1975`). Any other status is written, staged, and committed through `store.exclusive`, so it holds the checkout lock a session commit takes (`apps/cli/src/operations.ts:2020-2029`).
- List memories or tasks: entry at `apps/cli/src/operations.ts:1631` (`listMemories`) and `apps/cli/src/operations.ts:2148` (`listTasks`). These are direct indexed scans with keyset pagination on `path`, chosen over ranked retrieval (`apps/cli/src/operations.ts:1624-1630`). The task scan carries each row's `blockedBy` from one correlated subquery over `edges` (`apps/cli/src/operations.ts:2199-2218`). The MCP twin of the memory scan is `memory_list`.
- Report entity activity: entry at `apps/cli/src/operations.ts:1896` (`entityActivity`). Aggregates the memories carrying each stored entity reference, with three timestamps per row, up to `ENTITY_ACTIVITY_MAX` (500) rows (`apps/cli/src/operations.ts:1742-1743`). A row is one stored reference, so `Service:Checkout-API` and `service:checkout-api` are two rows, while `--entity` at either retrieval door folds them into one. The report leaves spellings unfolded because folding them first would hide the alias work the corpus still needs (`apps/cli/src/operations.ts:1888-1895`). `curate run`'s charter asks the curator to fold aliases onto one canonical value (`packages/curator/prompts/charter.md:31`).
- Walk a memory's neighborhood: entry at `apps/cli/src/operations.ts:1290` (`neighborsOf`). Uses fixed-depth joins in a `UNION ALL` rather than a recursive CTE. It follows both edge directions, stops at two hops, and filters to `edge_class = 'memory'` (`neighborsQuery`, `apps/cli/src/operations.ts:1191-1259`). The MCP twin is `memory_neighbors`.
- Reinforce paths: entry at `apps/cli/src/operations.ts:1123` (`reinforceMemories`). Bumps access bookkeeping with a caller-chosen signal through the one SQL writer for `state.access`, gated by a per-path cooldown (`reinforce`, `packages/index/src/reinforce.ts:49-72`). The MCP twin is `memory_reinforce`.
- Index Claude Code transcripts: entry at `apps/cli/src/operations.ts:2275` (`indexTraces`). Scans `$MEMHTML_TRACE_ROOT`, reading only what the per-file watermarks say changed, then persists each scanned file as a `traces` row plus its prompts (`scanTraceRoot`, `packages/traces/src/scan.ts:88`, `persistScanned`, `packages/index/src/traces-persist.ts:467`). Four counters, `skipped`, `tailed`, `rescanned`, and `filesFailed`, add up to `filesSeen`. `filesFailed` counts the files the scan planned to read and couldn't, so a read failure shows up in the census instead of vanishing into a smaller total (`ScanReport`, `packages/traces/src/scan.ts:54-65`, `apps/cli/src/operations.ts:2310-2312`). `sessionsWritten` isn't a fifth term of that sum. It counts the files for which a `traces` ROW was written, so a file read with no session id is tailed and unwritten (`apps/cli/src/operations.ts:2288-2299`).
- Search transcripts: entry at `apps/cli/src/operations.ts:2344` (`searchTraces`). Runs FTS over session first-prompts and AI titles through the same sanitizer the memory arms use, all-terms first and any-of when that finds nothing. An empty query lists the most recent sessions. The query names no memory table, which is the trace firewall in that direction (`apps/cli/src/operations.ts:2327-2343`). The MCP twin is `trace_search`.
- Read memory-session links: entry at `apps/cli/src/operations.ts:2420` (`traceLinks`). Answers from either side, and refuses a call that names neither side as `InvalidMemory` rather than scanning every link ever recorded (`apps/cli/src/operations.ts:2425-2431`). The MCP twin is `trace_links`.
- Report corpus status: entry at `apps/cli/src/operations.ts:2489` (`statusReport`). Reports the root, HEAD, the dirty paths, live counts by type, the archived count, the edge, chunk, embedding, and trace counts, the index watermark and its embed model, `embedderUp`, vector coverage beside its floor, and whether the state plane is attached (`apps/cli/src/operations.ts:2533-2555`). Freshness compares the recorded watermark to `HEAD` (`apps/cli/src/operations.ts:2476-2478`, `apps/cli/src/operations.ts:2512`), and `embedderUp` is read off the stored watermark rather than by probing Bedrock (`apps/cli/src/operations.ts:2480-2482`, `apps/cli/src/operations.ts:2551`). A stale index, where `indexFresh` is false, is also said on stderr once per call (issue #145) (`apps/cli/src/operations.ts:2513-2531`). The MCP twin is `memory_status`, which returns a subset of those fields (`apps/mcp/src/handlers.ts:851-867`).
- Report index status: entry at `apps/cli/src/views.ts:26` (`indexReport`). Reads the watermark, the vector space, and the row counts from the database without spawning git, because an operator asking about a stale index is often asking because the repo is broken (`apps/cli/src/views.ts:19-25`).
- Rebuild the index: entry at `packages/index/src/indexer.ts:674` (`rebuild`). Reads the whole tree at HEAD before it truncates, carries the vectors of unchanged chunks across through a stash, and records the watermark only once the vectors are back (`reproject`, `packages/index/src/indexer.ts:612-672`, `truncateForRebuild`, `packages/index/src/indexer.ts:375-398`). A rebuild that can't embed refuses a store that carries vectors unless `--force` is given (`refuseNoEmbedOverVectors`, `packages/index/src/indexer.ts:346-366`, `packages/index/src/indexer.ts:689-695`).
- Backfill embeddings: entry at `packages/index/src/indexer.ts:708` (`backfill`). Runs the full-scan `embedMissing` and reports how much of the gap is left. It touches only `embeddings`, so the index keeps serving on every arm throughout (`packages/index/src/indexer.ts:699-726`). Each slice of `EMBED_PERSIST_SLICE` (960) chunks is persisted as it finishes, so a throttled pass keeps most of what it paid for (`packages/index/src/indexer.ts:267-275`).
- Check corpus health: entry at `apps/cli/src/doctor.ts:567` (`doctor`). Gathers every finding before any repair. The findings are dangling hrefs, orphan state rows, the memory and task inbox depths, overdue tasks, stale blockers, untyped entities, format warnings, unparseable files, index freshness, the embed model, and vector coverage (`apps/cli/src/doctor.ts:575-614`). `healthy` is computed from the findings and never from the repair, and overdue tasks, stale blockers, and untyped entities don't count against it (`apps/cli/src/doctor.ts:633-664`). The report carries the pre-repair lists beside `repaired`, so a `--fix` run reports what was wrong and what was done in one envelope (`apps/cli/src/doctor.ts:560-566`).
- Repair corpus health: under `--fix`, `repaired` carries `rewritten`, `dropped`, `failedWrites`, `prunedAccessRows`, and `commitSha` (`RepairReport`, `apps/cli/src/doctor.ts:215-231`). A repair counts only when its bytes reached disk. A file whose write failed lands in `failedWrites`, is counted under neither `rewritten` nor `dropped`, and is never staged. Staging the unchanged file would put the pre-repair bytes into a commit whose subject claims they were repaired, and counting it would report a finding as settled while it's still open (`apps/cli/src/doctor.ts:500-519`). The repaired files are staged and committed under the checkout lock (`apps/cli/src/doctor.ts:539-555`).
- Publish generated listings: entry at `apps/cli/src/publish.ts:91` (`publish`). Regenerates every per-directory `index.html` and the root `sitemap.xml` from one deterministic generator (`apps/cli/src/artifacts.ts`), writing only files whose bytes differ, and stages and commits them under the checkout lock (`apps/cli/src/publish.ts:99-113`). It refuses an index with no memory rows while HEAD carries memory files, so it never regenerates every listing empty (`apps/cli/src/publish.ts:57-82`).
- Export the state plane: entry at `apps/cli/src/state.ts:64` (`stateExport`). Writes `.memhtml/state/access.jsonl`, the only durable copy of the plane git can't rebuild, and commits nothing when the bytes already match. A changed sidecar is written, staged, and committed under the checkout lock (`apps/cli/src/state.ts:56-106`).
- Import the state plane: entry at `apps/cli/src/state.ts:120` (`stateImport`). Replays the committed sidecar with a per-row upsert that takes the maximum of the two counters, so an import onto a live plane can't lose a bump (`apps/cli/src/state.ts:108-120`, `access_count`, `apps/cli/src/state.ts:155`).
- Regenerate AGENTS.md: entry at `apps/cli/src/agents-doc.ts:242` (`runAgentsDoc`). Renders the doc from the command table and writes it. Under `--check` it writes nothing and fails when the rendered doc has drifted from the file on disk (`apps/cli/src/agents-doc.ts:236-278`).
- Supervise the MCP server: entry at `apps/cli/src/serve.ts:82` (`serveMcp`). Spawns `memhtml-mcp` with inherited descriptors and `MEMHTML_ROOT` set to the resolved root, so the client talks to the child directly. It kills the child on interruption, so no orphan holds the root's database open (`apps/cli/src/serve.ts:86-110`).
- Run a code-mode script: entry at `apps/cli/src/exec.ts:532` (`execCommand`). Pins a commit as a detached worktree and releases it through `acquireRelease` (`apps/cli/src/exec.ts:554-576`). `runExec` mounts the tree read-only in a QuickJS sandbox with no network and no index handle, under a wall-clock bound capped at `MAX_TIMEOUT_MS` (`apps/cli/src/exec.ts:53-61`, `apps/cli/src/exec.ts:317-332`). A bridge fault runs the script again, for at most `BRIDGE_ATTEMPTS` (3) attempts in total, before it counts as the runtime's failure (`apps/cli/src/exec.ts:226-234`).
- Run the discrimination eval: entry at `packages/eval/src/run.ts:86` (`runDiscrimination`). Generates a fixture corpus, runs the probes, and reports three distinct outcomes, so a live run skipped for missing credentials reads differently from a pass (`EvalOutcome`, `packages/eval/src/run.ts:36-55`). A failed gate is the `ERR_DISCRIMINATION_FAILED` failure envelope at exit 1 (`apps/cli/src/run.ts:1781-1786`).
- Read an MCP resource: entry at `apps/mcp/src/resources.ts`, registered through the one `templateLayer` (`apps/mcp/src/resources.ts:105-123`). `memhtml://file/{path}` returns one memory's title, claim, and body for citation-grade drill-down, and it bumps salience through the same `readMemory` the tool calls. The captured path is traversal-gated by `isValidMemoryPath` before the store sees it (`apps/mcp/src/resources.ts:182-199`). `memhtml://at/{commit}/{path}` reads the same path out of a named commit's tree. Each route matches on `memhtml:://<section>/*`, whose rest parameter is what lets a multi-segment PARA path resolve (`routerPathFor`, `apps/mcp/src/resources.ts:27-47`).
- Read a memory at a commit: entry at `apps/mcp/src/resources.ts:267` (`PinnedResource`). `memhtml://at/{commit}/{path}` reads one memory's text as of a commit sha, out of git rather than off disk. It refuses a branch name or `HEAD` through `COMMIT_SHA`, and it doesn't bump salience, because auditing a receipt isn't choosing a memory (`apps/mcp/src/resources.ts:210-306`).
- Install a host integration: entry at `apps/cli/src/integrations.ts:264` (`integrationsInstall`). Wires one host, or every detected host, at user scope, or at project scope with `--project` (`install`, `packages/integrations/src/install.ts:673`). A drifted receipt claim or an unowned artifact refuses with `IntegrationModified`, reported as `ERR_INTEGRATION_MODIFIED`, and writes nothing, and `--force` keeps the prior bytes as a timestamped backup (`packages/integrations/src/install.ts:683-732`). The writes land all or nothing, with the receipt written last (`packages/integrations/src/install.ts:14-22`). With several hosts every host is planned as a dry run first, so a refusal on one leaves none wired (`apps/cli/src/integrations.ts:297-306`).
- Uninstall a host integration: entry at `apps/cli/src/integrations.ts:340` (`integrationsUninstall`). Removes exactly what the receipt claims. One entry that doesn't match its receipt refuses the whole uninstall, and there's no `--force`, because deleting a file somebody has made their own can't be undone (`uninstall`, `packages/integrations/src/uninstall.ts:1-12`, `packages/integrations/src/uninstall.ts:97`).
- List host integrations: entry at `apps/cli/src/integrations.ts:389` (`integrationsList`). Returns one row per host at user scope, plus one per host at project scope when `--project` names a root, in `HOSTS` order (`listIntegrations`, `packages/integrations/src/list.ts:65-81`).
- Diagnose a host integration: entry at `apps/cli/src/integrations.ts:419` (`integrationsDoctor`). Without a host it checks every host that has a receipt (`apps/cli/src/integrations.ts:412-436`). Each check is one row. The rows cover the receipt, the three binaries, the CLI version, the store root, each claimed entry, the hooks, the instruction block, the skill, the trace root, an MCP handshake, and for Codex a hook-trust note (`doctor`, `packages/integrations/src/doctor.ts:313-581`).
- Print the shell setup: entry at `apps/cli/src/integrations.ts:471` (`integrationsShell`). Prints a snippet that exports `MEMHTML_ROOT` and puts the binary's directory on `PATH`, and with `--write` places it inside a fence in the rc file. No host integration depends on it, because every installed entry carries its own absolute command and root (`renderShellSnippet`, `apps/cli/src/integrations.ts:460-499`).

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at cf76951.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 69 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 67 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 62 shared source citations
- [memhtml-public · Module map](../architecture/module-map.md): 57 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 52 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 39 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 36 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 36 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 34 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 31 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 31 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 31 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 21 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 19 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 14 shared source citations

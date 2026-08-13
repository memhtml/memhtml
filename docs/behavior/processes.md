# memhtml-public · Processes

This file lists what runs when in `memhtml-public`. Each process is a flow that starts at one initiator and ends at one answer.

This repository is the software that manages a separate directory called the memhtml root, which `$MEMHTML_ROOT` locates (`apps/cli/src/config.ts:26-31`). It stores no memory of its own. The root's git tree is the system of record, and `.memhtml/index.db` inside the root is a projection that can be rebuilt from that tree (`packages/index/src/indexer.ts:17-24`). A process that writes acts on the root rather than on this repo, so one binary serves many roots.

The primary consumer of every process is a coding agent. Processes start from one of three initiators. The CLI publishes 34 commands as one machine-readable table (`apps/cli/src/commands.ts:111-806`), and each command returns exactly one JSON envelope on stdout and writes its logs to stderr (`apps/cli/src/run.ts:1029-1031`). The MCP server publishes 14 tools (`apps/mcp/src/tools.ts:774-789`) and 2 resource templates (`apps/mcp/src/resources.ts:90`) over stdio. The nightly sleep cycle runs 15 phases as an internal scheduled flow (`packages/sleep/src/contract.ts:17-33`).

The CLI and the MCP server are both thin adapters over one shared use-case module (`apps/cli/src/operations.ts:42-48`, `apps/mcp/src/handlers.ts:33-43`), so a search issued by the CLI and a search issued through MCP run the same query.

## CLI invocation

Entry point: `apps/cli/src/run.ts:809`

1. `bin.ts` calls `run` with the argv tail, writes the returned stdout, and exits with the returned code `apps/cli/src/bin.ts:1-7`.
2. `parseArgv` splits argv into positionals and a flag map whose values are always arrays, then greedily matches the two-word compound command names longest-first so `index status` beats `index` `apps/cli/src/run.ts:61-111`.
3. A bare invocation or `help` answers with the manifest immediately, without building any service `apps/cli/src/run.ts:822-824`.
4. `validate` rejects the usage errors: an unknown flag, an unknown command with nearest-match suggestions, a missing required argument or flag, a violation of the claim-or-article-html exclusive rule, a violation of the exec flag rules, and any value outside a closed vocabulary `apps/cli/src/run.ts:734-795`.
5. Five commands answer without building the app layer, each for a stated reason: `manifest` must answer on a machine with no repo, `agents-doc` must not scaffold a root as a side effect, `serve mcp` must not open the database its child will serve, `eval discriminate` runs against its own generated fixture, and `exec` reads a git tree only `apps/cli/src/run.ts:842-992`.
6. `memhtml apply` reads and shape-validates its whole JSONL op stream here, before any service exists, so a malformed line is exit 2 with nothing written `apps/cli/src/run.ts:1006-1015`.
7. `dispatch` switches on the command name into one arm per remaining command. Each arm decodes flags, calls one shared use case, and names a response type `apps/cli/src/run.ts:186-578`.
8. The single envelope is built once around the whole program: success becomes exit 0, a typed failure becomes exit 1 through `failureFor`, and an unexpected defect becomes `ERR_UNKNOWN` rather than a stack trace on stdout `apps/cli/src/run.ts:1017-1035`.

### Related

- `apps/cli/src/envelope.ts:88-90`
- `apps/cli/src/envelope.ts:156`
- `apps/cli/src/errors.ts:41`
- `apps/cli/src/errors.ts:154`
- `apps/cli/src/commands.ts:1024`
- `apps/cli/src/api-layer.ts:521`

## Single memory write

Entry point: `apps/cli/src/operations.ts:288`

1. The `write` dispatch arm reads the flags into `WriteParams`, and `task add` reaches the same function with `memoryType: "task"` and the title as the default claim `apps/cli/src/run.ts:201-221`, `apps/cli/src/run.ts:356-372`.
2. `toWriteInput` decodes the untrusted memory type and rejects `arc`, because sleep synthesizes arcs. It also decodes the two task metas, all before any file is rendered `apps/cli/src/operations.ts:247-280`.
3. `store.writeMemory` takes one clock reading and renders the file through the template `packages/store/src/store.ts:530-534`.
4. `renderChecked` runs the format check over the rendered bytes and fails with the list of violations before anything is written, staged, or committed `packages/store/src/store.ts:521-528`.
5. The content hash is looked up against the dedupe oracle first, so a duplicate returns the existing path and leaves the tree byte-identical `packages/store/src/store.ts:537-551`.
6. `freePathFor` resolves the placement rule's path, suffixing `-2`, then `-3`, until one is absent from disk. A caller that named a valid explicit path keeps that path instead `packages/store/src/store.ts:384-406`.
7. The file is written, staged, and committed in one commit carrying the provenance trailers `packages/store/src/store.ts:563-567`.
8. `reindex` calls `indexer.update()` rather than `indexPaths`, because only the diff-driven path can express a rename and only it records the watermark. `recordLink` then notes the session link, and it swallows its own failure `apps/cli/src/operations.ts:227-231`, `apps/cli/src/operations.ts:294-296`.

### Related

- `packages/store/src/store.ts:502`
- `packages/store/src/store.ts:367`
- `apps/cli/src/operations.ts:166`
- `apps/cli/src/operations.ts:70`
- `apps/mcp/src/handlers.ts:310`
- `apps/mcp/src/handlers.ts:143`

## Batch apply

Entry point: `apps/cli/src/operations.ts:641`

1. `decodeApply` checks every JSONL line before any op runs. It fails on the first bad line and reports that line's number, and it skips blank lines while still counting them `apps/cli/src/apply.ts:274-303`.
2. When `detectConflicts` is on, `detectFrameConflicts` computes each op's frame key and asks the index for live occupants in ONE query, folding earlier ops in as it walks. A lookup failure degrades to no conflicts `apps/cli/src/operations.ts:448-502`.
3. When `consolidate: "last-wins"` is set, `planLastWins` folds the ops so a later restatement replaces the content of the earliest slot holding its frame key. It also records which stored memories the surviving slots will supersede `apps/cli/src/operations.ts:535-594`.
4. Fold one decodes each planned op through the singular write's own `toWriteInput`. An atomic decode abort returns immediately, reports every op, and writes nothing `apps/cli/src/operations.ts:683-705`.
5. The optional extraction assist makes one model call over the decoded ops and unions extracted entities into each op's own list. A failure produces a logged warning and an unextracted batch `apps/cli/src/operations.ts:718-741`.
6. Fold two is `store.writeMemories`, which runs in two phases. Phase 1 validates every op against the batch's folded dedupe and path-claim state, writing nothing. Phase 2 writes every file, stages once, and makes ONE commit, rolling back on any failure `packages/store/src/store.ts:699-820`.
7. One reindex runs after the commit, gated on a file having actually been written, so a dedupe-only batch does not move the watermark for a commit that never happened `apps/cli/src/operations.ts:764-766`.
8. The store-supersede pass archives every live memory a surviving slot displaced, in one `supersedeMemories` call, then reindexes again because archive paths moved. A failure here only annotates the result `apps/cli/src/operations.ts:782-811`.

### Related

- `packages/store/src/store.ts:610`
- `packages/store/src/store.ts:590`
- `packages/store/src/store.ts:902`
- `apps/cli/src/operations.ts:604`
- `apps/cli/src/operations.ts:867`
- `apps/mcp/src/handlers.ts:375`

## Ranked retrieval

Entry point: `packages/index/src/retrieval.ts:331`

1. The `search` and `recall` dispatch arms build one shared scope object from the same flag set, so the two commands cannot narrow differently `apps/cli/src/run.ts:150-157`, `apps/cli/src/commands.ts:58-99`.
2. `queryVector` embeds the query text, catching a model failure and returning undefined so the search degrades rather than erroring `packages/index/src/retrieval.ts:193-207`.
3. `sanitizeFtsQuery` reduces the caller's prose to indexable terms, because an apostrophe or a leading hyphen causes a hard driver error rather than an empty result `packages/index/src/retrieval.ts:231`.
4. `activeArms` drops any arm whose precondition is absent, and that dropping is the entire degradation mechanism. The vector arm needs the query vector, the salience arm needs the attached state plane, and the lexical arm needs surviving query terms `packages/index/src/retrieval-sql.ts:263-270`.
5. `buildRrfSql` assembles the surviving arms as CTEs, unions their weighted reciprocal ranks, and sums per path with `path ASC` breaking ties. It returns undefined when no arm fires `packages/index/src/retrieval-sql.ts:282-294`.
6. `hydrate` fetches the full rows for the fused paths in fused order, including both entity projections, the supersedes edge, and the first chunk's vector, in one statement `packages/index/src/retrieval.ts:266-290`.
7. `applyMmr` reorders the 3x candidate pool down to the limit, using reciprocal fused position as the relevance term `packages/index/src/retrieval.ts:349-354`.
8. `search` fetches snippets for the final paths only and returns hits plus `degraded`, `arms`, `entityScope`, and `scopeEmpty`. `recall` instead folds arcs and ordinary memories under separate character budgets `packages/index/src/retrieval.ts:360-399`, `packages/index/src/retrieval.ts:402-447`.

### Related

- `packages/index/src/retrieval-sql.ts:243`
- `packages/index/src/retrieval-sql.ts:318`
- `packages/index/src/scope.ts:1`
- `packages/index/src/fts-query.ts:1`
- `packages/index/src/disclosure.ts:1`
- `apps/cli/src/operations.ts:924`

## Index projection

Entry point: `packages/index/src/indexer.ts:531`

1. `guardEmbedModel` fails when the stored vector space disagrees with the configured one, and it runs before any write, so an index can never accumulate rows under two models `packages/index/src/indexer.ts:212-218`.
2. The recorded watermark is read. An absent watermark means there is no index at all, so `update` falls through to a full `rebuild` rather than diffing against nothing `packages/index/src/indexer.ts:534-552`.
3. `git diff --name-status -M` between the watermark and HEAD gives the committed changes, filtered to indexable paths, and `git status --porcelain=v2` gives the uncommitted working tree `packages/index/src/indexer.ts:554-560`.
4. Every committed diff target's blob is read in two subprocesses total rather than two per file, because a per-file tree walk was the term that made bulk ingest quadratic `packages/index/src/indexer.ts:572-589`.
5. Committed changes are applied first. A deletion cascades its rows, a rename becomes an `UPDATE files.path` that keeps the chunk row and its vector, and every surviving path is re-projected `packages/index/src/indexer.ts:616-646`.
6. The dirty working tree is applied second, so a path that both moved in a commit and was then edited ends at the working tree's content `packages/index/src/indexer.ts:648-666`.
7. Writes are applied in bounded batches and the watermark is recorded. Recording the watermark is what makes the question "does the index describe the current commit" answerable `packages/index/src/indexer.ts:668-669`.
8. `embedMissing` fills vectors, scoped to this pass's own chunk ids on the incremental path and unscoped on a rebuild so a model migration can find every stale vector `packages/index/src/indexer.ts:676`, `packages/index/src/indexer.ts:310-358`.

### Related

- `packages/index/src/indexer.ts:360`
- `packages/index/src/indexer.ts:446`
- `packages/index/src/indexer.ts:422`
- `packages/index/src/project.ts:1`
- `packages/index/src/git-adapter.ts:1`
- `packages/index/src/index-state.ts:1`

## Nightly sleep run

Entry point: `packages/sleep/src/run.ts:69`

1. The `sleep run` dispatch arm resolves the date through the Effect clock, narrows any `--phases` subset, and calls the service `apps/cli/src/run.ts:459-469`.
2. `runIdFor` picks `sleep/<date>`, suffixing `-2` upward when that branch already exists, so a same-day rerun never collides `packages/sleep/src/run.ts:45-53`.
3. The branch is created BEFORE any phase runs and every commit lands on it, so a run leaves `main` unchanged. A dry run creates no branch `packages/sleep/src/run.ts:95-97`.
4. `recordRun` writes the run row as `running`, through a wrapper that keeps a reporting failure from failing the run `packages/sleep/src/run.ts:98-108`.
5. `executePhases` walks the selected phases in canonical order, running each body under `Effect.result` so a failure becomes a value the loop reads and the phases after it still run `packages/sleep/src/run.ts:231-297`.
6. A failed phase is recorded, its declared dependents are blocked, and the git index is reset so the next phase's commit cannot carry half-finished work `packages/sleep/src/run.ts:279-291`.
7. `preflight` runs first. It fails on a dirty tree, refreshes the index so every later phase reads current rows, and commits nothing `packages/sleep/src/phases/preflight.ts:20-41`.
8. The run row is rewritten as `review`, `failed`, or `abandoned` for a dry run, and the report carries every phase result plus the total model calls `packages/sleep/src/run.ts:115-135`.

### Related

- `packages/sleep/src/contract.ts:17`
- `packages/sleep/src/contract.ts:57`
- `packages/sleep/src/phases/index.ts:27`
- `packages/sleep/src/commit.ts:1`
- `packages/sleep/src/sql.ts:1`
- `packages/sleep/src/env.ts:1`

## Sleep merge

Entry point: `packages/sleep/src/review.ts:224`

1. The `sleep merge` dispatch arm composes the discrimination gate here, in the CLI, because `@memhtml/sleep` cannot import the eval, and composing it in the CLI keeps the gate from being defaulted silently `apps/cli/src/run.ts:494-524`.
2. `--skip-gate` logs a warning and passes no gate. It is a visible override the caller asks for, and it is not the default `apps/cli/src/run.ts:498-502`.
3. `resolveRun` reads the named run row, or the newest recorded one. A missing row fails with `no-run` `packages/sleep/src/review.ts:29-35`, `packages/sleep/src/review.ts:231-240`.
4. The target branch is checked out and its head is read, before anything moves `packages/sleep/src/review.ts:242-246`.
5. The first refusal case is `main` having advanced past the run's `base_sha`, which means the run curated a corpus that no longer exists. The merge stops with `main-advanced` `packages/sleep/src/review.ts:248-259`.
6. The second refusal case comes from the pre-merge gate, which runs under `Effect.result`. A gate failure becomes `gate-failed`, and `main` does not move `packages/sleep/src/review.ts:261-273`.
7. `discriminationGate` runs the probes in `fake` mode and fails when the report does not pass. Because the gate runs before the merge, a retrieval regression blocks the merge `packages/eval/src/run.ts:174-181`.
8. The merge is always a fast-forward, and it never creates a merge commit. On success the run row is rewritten as `merged` `packages/sleep/src/review.ts:275-301`.

### Related

- `packages/sleep/src/review.ts:47`
- `packages/sleep/src/review.ts:128`
- `packages/sleep/src/review.ts:196`
- `packages/eval/src/run.ts:77`
- `packages/eval/src/discriminate.ts:224`
- `packages/sleep/src/contract.ts:161`

## MCP tool invocation

Entry point: `apps/mcp/src/bin.ts:15`

1. `Layer.launch` runs the server for the process's lifetime, because the stdio transport is the program and a built-then-released layer would close stdin under a live client `apps/mcp/src/bin.ts:9-15`.
2. `layerServer` merges the toolkit and the two resources over the CLI's own app layer, so both entry points resolve to one database file, one git root, and one vector space `apps/mcp/src/server.ts:39-54`.
3. `Logger.LogToStderr` is set here because stdout on this transport carries the NDJSON-RPC stream, and one log line would corrupt the frame a client is mid-parse on `apps/mcp/src/server.ts:53`.
4. The toolkit declares 14 tools with the batch second, directly after `memory_write`, because `tools/list` publishes this order and an agent reads it top-down `apps/mcp/src/tools.ts:774-789`.
5. `MemhtmlToolkit.toLayer` binds each handler and typechecks it against the toolkit's own parameter and success schemas, so a wrong shape is a compile error rather than a live decode failure `apps/mcp/src/handlers.ts:305-309`.
6. Each handler renames snake_case wire parameters to the operations layer's camelCase and maps an explicit `null` to absent. It then calls the same shared use case the CLI command calls `apps/mcp/src/handlers.ts:102`, `apps/mcp/src/handlers.ts:524-556`.
7. `authored` resolves the body-or-article-html exclusive rule at the wire boundary. It rejects a call that supplies both and a call that supplies neither, instead of picking one `apps/mcp/src/handlers.ts:143-167`.
8. `handled` maps every typed error through `toToolFailure` into the `ToolFailure` shape each tool declares. That branch passes the message through verbatim, so the client sees it instead of the framework's generic internal-error sentence `apps/mcp/src/handlers.ts:70-71`, `apps/mcp/src/failure.ts:1`.

### Related

- `apps/mcp/src/tools.ts:249`
- `apps/mcp/src/resources.ts:42`
- `apps/mcp/src/resources.ts:67`
- `apps/mcp/src/failure.ts:1`
- `apps/cli/src/api-layer.ts:521`
- `apps/cli/src/operations.ts:42`

## Minor flows

- Correct a memory: entry at `apps/cli/src/operations.ts:985`. Reads the target, renders and gates the superseding file, stamps the validity window on both sides, and lands the new file plus the archived target in one commit `packages/store/src/store.ts:830`.
- Archive a memory: entry at `apps/cli/src/operations.ts:1035`. This is a soft eviction. It runs `git mv` into `archive/<YYYY>/`, applies the archive stamps at the destination, and then runs one diff-driven reindex `packages/store/src/store.ts:888`.
- Link two memories: entry at `apps/cli/src/operations.ts:1022`. Decodes the rel against the authorable set, rejects an edge whose class disagrees with its endpoints' types, and is idempotent on the pair, so a re-link commits nothing `packages/store/src/store.ts:1037`.
- Move a task's status: entry at `apps/cli/src/operations.ts:1319`. Splices the status meta in place with `setMeta` so the article's bytes and content hash cannot move, and routes `done` through `archiveMemory` so the stamp and the move land in one commit.
- List memories or tasks: entry at `apps/cli/src/operations.ts:1193` and `apps/cli/src/operations.ts:1444`. These are direct indexed scans with keyset pagination on `path`, chosen over ranked retrieval. The task scan carries each row's `blockedBy` from one correlated subquery over `edges`.
- Walk a memory's neighbourhood: entry at `apps/cli/src/operations.ts:1093`. Uses two fixed-depth joins in a `UNION ALL` rather than a recursive CTE. It follows both edge directions, stops at two hops, and filters to `edge_class = 'memory'`.
- Reinforce paths: entry at `apps/cli/src/operations.ts:1046`. Bumps access bookkeeping with a caller-chosen signal through the one SQL writer for `state.access`, gated by a per-path cooldown `packages/index/src/reinforce.ts:45`.
- Index Claude Code transcripts: entry at `apps/cli/src/operations.ts:1557`. Scans `$MEMHTML_TRACE_ROOT` reading only what the per-file watermarks say changed, then persists each scanned file as a `traces` row plus its prompts `packages/traces/src/scan.ts:58`, `packages/index/src/traces-persist.ts:376`.
- Search transcripts: entry at `apps/cli/src/operations.ts:1606`. Runs FTS over session first-prompts and AI titles through the same sanitizer the memory arms use. The query names no memory table, which is the trace firewall in that direction.
- Read memory-session links: entry at `apps/cli/src/operations.ts:1674`. Answers from either side, and rejects a call that names neither side rather than scanning every link ever recorded.
- Report corpus status: entry at `apps/cli/src/operations.ts:1737`. Compares the recorded watermark to `HEAD` for freshness and reads the embedder's usability off the stored watermark rather than probing Bedrock.
- Run a code-mode script: entry at `apps/cli/src/exec.ts:382`. Pins a commit as a detached worktree, mounts it read-only in a QuickJS sandbox with no network and no index handle, runs the script under a capped wall-clock bound, and releases the worktree through `acquireRelease` `apps/cli/src/exec.ts:224`.
- Check corpus health: entry at `apps/cli/src/doctor.ts:428`. Gathers dangling hrefs, orphan state rows, inbox depth, format warnings, overdue tasks, and stale blockers before any repair, so a `--fix` run reports what was wrong and what was done in one envelope.
- Publish generated listings: entry at `apps/cli/src/publish.ts:59`. Regenerates every per-directory `index.html` and the root `sitemap.xml` from the same generator the sleep integrity phase uses, writing only files whose bytes differ.
- Export the state plane: entry at `apps/cli/src/state.ts:54`. Writes `.memhtml/state/access.jsonl`, the only durable copy of the plane git cannot rebuild, and commits nothing when the bytes already match.
- Import the state plane: entry at `apps/cli/src/state.ts:103`. Replays the committed sidecar with a per-row upsert that takes the maximum of the two counters, so an import onto a live plane cannot lose a bump.
- Regenerate AGENTS.md: entry at `apps/cli/src/agents-doc.ts:215`. Renders the doc from the command table and writes it. Under `--check` it writes nothing and fails when the rendered doc has drifted from the file on disk.
- Supervise the MCP server: entry at `apps/cli/src/serve.ts:72`. Spawns `memhtml-mcp` with inherited descriptors so the client talks to the child directly, and kills it on interruption so no orphan holds the root's database open.
- Run the discrimination eval: entry at `packages/eval/src/run.ts:77`. Generates a fixture corpus, runs the probes, and reports three distinct outcomes, so a live run skipped for missing credentials reads differently from a pass.
- Resume a sleep run: entry at `packages/sleep/src/run.ts:146`. Reads the completed phases out of the branch's own `Memhtml-Phase` commit trailers, not from the journal table, and executes only the rest.
- Review a sleep run: entry at `packages/sleep/src/review.ts:47`. Reports per-phase counts, the commit list with trailers, `git diff --stat`, and a per-file classification where `meta-only` is decided by comparing article content hashes.
- Consolidate transcripts into memories: entry at `packages/sleep/src/phases/trace-consolidation.ts:1`. Hands a manifest of transcript metadata to the sandboxed consolidator agent, gates each returned candidate deterministically, and lands each cleared one as its own reviewable commit `apps/consolidator/src/client.ts:988`.
- Read an MCP resource: entry at `apps/mcp/src/resources.ts:42` and `apps/mcp/src/resources.ts:67`. `memhtml://file/{path}` returns one memory's title, claim, and body for citation-grade drill-down, and it bumps salience through the same `readMemory` the tool calls. `memhtml://sleep/{run-id}` reads the run's committed HTML report from the tree.

## See also

- [memhtml-public · CLI](../reference/cli.md): 13 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 11 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 9 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 7 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 6 shared source citations

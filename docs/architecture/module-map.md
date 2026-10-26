# memhtml-public · Module map

Describes the source at 0.16.0 (2026-10-18). Citations are `path:line` into that tree. LOC is the `wc -l` line count of the file, measured in that tree.

This repository is the software that manages a memory root, a separate git repository located by `MEMHTML_ROOT` (`apps/cli/src/config.ts:108-117`). No memory lives here. The modules below are a pnpm workspace of fourteen libraries under `packages/` and three apps under `apps/`, declared in `pnpm-workspace.yaml:1-4` together with the `tests-integration` harness. Every workspace package but `apps/docs`, the documentation site, has a section of its own. The integration tests and the repository scripts close the page under Supporting code. The sections aren't ordered by size. They open with `apps/cli`, the composition root, and close with `@memhtml/contracts`, which depends on no other workspace package.

## apps/cli

`apps/cli` builds the `memhtml` binary declared at `apps/cli/package.json:21-23`. It's also the composition root, and the MCP server imports it instead of building its own (`apps/cli/src/index.ts:1-8`). Every command an agent calls writes exactly one JSON envelope to stdout. The envelope's `apiVersion` field lets the shape evolve, and its `type` and `code` fields are discriminators an agent branches on, drawn from two append-only lists (`apps/cli/src/envelope.ts:6`, `apps/cli/src/envelope.ts:8-12`, `apps/cli/src/envelope.ts:105-110`). Two outputs aren't envelopes. `memhtml help` on a terminal writes Markdown, and a successful `memhtml hook` writes the host's hook protocol (`apps/cli/src/envelope.ts:51-54`). Exit code 0 is success, 2 is a usage error the agent fixes by changing the call, and 1 is a runtime failure it fixes by changing the root or the environment (`apps/cli/src/envelope.ts:165-168`). The command table in `commands.ts` is the one machine-readable description of that surface. `memhtml manifest` serves it, and `memhtml agents-doc` regenerates `AGENTS.md` from it (`apps/cli/src/commands.ts:175-185`, `apps/cli/src/agents-doc.ts:11-16`).

The v1 commands run their dispatch arm over `layerApp`, which opens `index.db` and wires the store, the indexer, and retrieval (`apps/cli/src/api-layer.ts:61-84`, `apps/cli/src/run.ts:2414-2446`). The v2 commands live in `v2.ts`. They're the `session`, `head`, and `curate` families, and they read git and the session files without building that layer (`apps/cli/src/v2.ts:118-128`). `head-server.ts` is `memhtml head serve`, one process that holds the head and answers seven routes over `.memhtml/head.sock` (`apps/cli/src/head-server.ts:96-117`, `apps/cli/src/head-protocol.ts:21-29`). `head-client.ts` is the client every head-first command asks, and a failure before the connection completes reads as no server (`apps/cli/src/head-client.ts:10-25`). `session-exec.ts` runs a script in the just-bash sandbox over head plus overlay and harvests the files it changed into ops (`apps/cli/src/session-exec.ts:28-38`). `curate-run.ts` binds the curator's tools to the real head, session, and sandbox (`apps/cli/src/curate-run.ts:59-67`). `store-config.ts` reads `memhtml.config.json` at each decision and fails closed (`apps/cli/src/store-config.ts:23-44`).

- `apps/cli/src/operations.ts` (2572 LOC)
- `apps/cli/src/run.ts` (2437 LOC)
- `apps/cli/src/commands.ts` (2023 LOC)
- `apps/cli/src/v2.ts` (1953 LOC)
- `apps/cli/src/head-server.ts` (1655 LOC)
- `apps/cli/src/curate-collapse.ts` (1002 LOC)
- `apps/cli/src/head-protocol.ts` (860 LOC)
- `apps/cli/src/session-exec.ts` (798 LOC)
- `apps/cli/src/curate-run.ts` (679 LOC)
- `apps/cli/src/api-layer.ts` (449 LOC)
- `apps/cli/src/head-client.ts` (229 LOC)
- `apps/cli/src/head-retrieval.ts` (214 LOC)
- `apps/cli/src/store-config.ts` (189 LOC)
- `apps/cli/guest/sandbox-runner.mjs` (138 LOC)

## apps/mcp

`apps/mcp` builds the `memhtml-mcp` stdio server declared at `apps/mcp/package.json:20-22`, exposing fifteen tools and two resources over the same root the CLI reads (`apps/mcp/src/index.ts:2`, `apps/mcp/src/tools.ts:1049-1065`, `apps/mcp/src/resources.ts:323`). It imports `layerApp` from `apps/cli` rather than composing its own service graph, so both agent surfaces resolve to exactly one database file, one git root, and one vector space (`apps/mcp/src/server.ts:1`, `apps/mcp/src/server.ts:53`, `apps/cli/src/index.ts:4-7`). Curation is left off the tool surface on purpose, because it's an operator action that produces a reviewable branch (`apps/mcp/src/index.ts:4-5`). `memory_search` and `memory_recall` ask the head server first and take the index path when it gives no answer or when the call names something the head can't answer the way the index would (`apps/mcp/src/handlers.ts:604-612`, `routeFor` at `apps/cli/src/head-retrieval.ts:68-80`). The three record-creating tools run `guardV1Door` first, so they follow the store's `v1Doors` mode (`apps/mcp/src/handlers.ts:353-359`). `failure.ts` declares one wire error class whose message survives the MCP framework's rewrite of generic tool failures, so the agent reads the message the tool wrote (`apps/mcp/src/failure.ts:5-16`).

- `apps/mcp/src/tools.ts` (1069 LOC)
- `apps/mcp/src/handlers.ts` (871 LOC)
- `apps/mcp/src/resources.ts` (326 LOC)
- `apps/mcp/src/failure.ts` (311 LOC)
- `apps/mcp/src/server.ts` (63 LOC)
- `apps/mcp/src/bin.ts` (15 LOC)

## packages/head

`@memhtml/head` holds the corpus as a value, one immutable version per commit in persistent `effect` structures (`packages/head/src/index.ts:1-6`). `loadHead` builds the first version from one `ls-tree` and one `cat-file --batch`, and `advanceHead` builds every later one from its parent plus the paths the two trees differ on (`packages/head/src/version.ts:105-111`, `packages/head/src/version.ts:157-165`). Every index is a HashMap or HashSet, so a change to one record shares every untouched node with the parent. The indexes are `byContentHash`, `byFrameKey`, `inbound`, `byEntity`, and the BM25 lexical index (`packages/head/src/indexes.ts:6-25`, `packages/head/src/lexical.ts:4-12`). `withOverlay` builds a session's view from its base and its overlay log with the same two writers (`packages/head/src/overlay.ts:11-17`). `searchHead` fuses a BM25 lexical arm capped at 40 and, given vectors, a cosine vector arm capped at 40 by RRF at `k = 60`, and recency decides only between exactly equal fused scores (`packages/head/src/search.ts:9-25`, `packages/head/src/search.ts:66-79`). `gateHeads` is the relative head gate `curate merge` runs. It scores the same seeded title probes at the base and at the landed version (`packages/head/src/gate.ts:8-29`). See `docs/design.md` §16 for the ranking.

- `packages/head/src/gate.ts` (270 LOC)
- `packages/head/src/search.ts` (265 LOC)
- `packages/head/src/version.ts` (201 LOC)
- `packages/head/src/lexical.ts` (160 LOC)
- `packages/head/src/indexes.ts` (157 LOC)
- `packages/head/src/vectors.ts` (153 LOC)
- `packages/head/src/overlay.ts` (153 LOC)

## packages/session

`@memhtml/session` holds a session's overlay log and the mechanical commit path that lands it on a ref (`packages/session/src/index.ts:1-4`). A session is a base sha, a ref, and a log of ops, kept in one file, `.memhtml/sessions/<id>.json`, and every write to it runs under a per-id lock (`packages/session/src/session.ts:13-25`, `packages/session/src/session.ts:69-70`). `validateOps` judges a log against the base with no I/O. Its violation kinds are `format`, `duplicate`, `claim-edit`, `reserved-path`, `batch-cap` (200 ops), and `write-bar` (`packages/session/src/validate.ts:19-45`). `commitSession` settles a `pending` commit, validates, checks the ref, builds the tree in a temporary index under the OS temp directory, records `pending`, and lands through `landOnRef` (`packages/session/src/commit.ts:399-426`). `landOnRef` moves the checkout and compare-and-swaps the ref as one section under the checkout lock `.memhtml/checkout.lock`, which every v1 store write takes too (`packages/session/src/commit.ts:267-283`, `packages/session/src/checkout-lock.ts:14-19`). The plumbing runs git with its own index file per call, so a session never touches the shared staging area while it builds a commit (`packages/session/src/plumbing.ts:7-14`). `withRepoints` completes a batch of moves with the edge repoints it needs, and `pruneSessions` removes idle session state but never a log that holds ops (`packages/session/src/moves.ts:3-21`, `packages/session/src/prune.ts:29-39`). See `docs/design.md` §17.

- `packages/session/src/commit.ts` (582 LOC)
- `packages/session/src/validate.ts` (500 LOC)
- `packages/session/src/plumbing.ts` (433 LOC)
- `packages/session/src/session.ts` (379 LOC)
- `packages/session/src/prune.ts` (276 LOC)
- `packages/session/src/exclude.ts` (93 LOC)
- `packages/session/src/moves.ts` (60 LOC)
- `packages/session/src/checkout-lock.ts` (41 LOC)

## packages/snapshot

`@memhtml/snapshot` is the columnar cold-start cache (`packages/snapshot/src/index.ts:1`). A snapshot is one Arrow IPC file per commit at `.memhtml/snapshots/<sha>.arrow`, one row per record, with the commit sha and a `format` key in its schema metadata (`packages/snapshot/src/snapshot.ts:1-16`, `packages/snapshot/src/snapshot.ts:176-181`). A file with no `format` key reads as format `"1"`, and a reader treats a file of another format as a miss (`packages/snapshot/src/snapshot.ts:51-68`). The vector cache is one Arrow file per vector space at `.memhtml/vectors/<model>@<dim>.arrow`, keyed by content hash (`packages/snapshot/src/vectors.ts:1-10`, `packages/snapshot/src/vectors.ts:82-92`). Both writers stage through write-file-atomic and sweep staging files abandoned for more than an hour (`packages/snapshot/src/staging.ts:6-25`). `pruneSnapshots` keeps the newest four snapshots (`packages/snapshot/src/prune.ts:10-20`). See `docs/design.md` §20.

- `packages/snapshot/src/snapshot.ts` (528 LOC)
- `packages/snapshot/src/vectors.ts` (249 LOC)
- `packages/snapshot/src/prune.ts` (100 LOC)
- `packages/snapshot/src/staging.ts` (72 LOC)

## packages/curator

`@memhtml/curator` is the curator memhtml owns. It's a bounded `generateText` tool loop over an injected tool set, its charter, its budget, and its model factory (`packages/curator/src/index.ts:1-6`). The loop ends on a `finish` tool call, cuts every tool result at a cap, and hands a rejected proposal back to the model as a tool result (`packages/curator/src/loop.ts:12-37`). The default budget is 40 steps, 32,000 output tokens per call, 20 minutes of wall clock, and the session batch cap of ops (`packages/curator/src/budget.ts:24-29`). The two charters, `prompts/charter.md` for `curate run` and `prompts/collapse.md` for `curate collapse`, are templates filled from the store's policy, and `--charter <file>` swaps in an operator's own (`packages/curator/src/charter.ts:7-21`). The collapse planner is pure over one head view and makes no model call (`packages/curator/src/planner/plan.ts:22-30`). The binders that give the curator a real head, session, and sandbox live in `apps/cli` (`apps/cli/src/curate-run.ts:59-67`). See `docs/design.md` §23.

- `packages/curator/src/planner/plan.ts` (466 LOC)
- `packages/curator/src/briefing.ts` (441 LOC)
- `packages/curator/src/inbox.ts` (399 LOC)
- `packages/curator/src/fake-model.ts` (390 LOC)
- `packages/curator/src/loop.ts` (302 LOC)
- `packages/curator/src/tools.ts` (201 LOC)
- `packages/curator/src/model.ts` (152 LOC)
- `packages/curator/src/charter.ts` (122 LOC)
- `packages/curator/prompts/charter.md` (39 LOC)
- `packages/curator/prompts/collapse.md` (25 LOC)

## packages/index

`@memhtml/index` owns the rebuildable SQLite plane over the root: schema, migrations, the git-driven indexer, and four-arm retrieval (`packages/index/package.json:5`). The root's `.memhtml/index.db` is a projection of the root's git tree and can be deleted and rebuilt without loss, while `state.db` is ATTACHed over the same connection and holds the one set of facts git can't reproduce (`packages/index/src/index.ts:5-6`). The indexer reads the tree through a read-only port that it declares itself rather than importing the store. The indexer therefore can't commit, which keeps "rebuildable from git" non-circular (`packages/index/src/git-port.ts:7-13`). Retrieval fuses four ranked arms named `fts`, `vector`, `recency`, and `salience` with reciprocal rank fusion (`packages/index/src/retrieval-sql.ts:125`, `packages/index/src/retrieval-sql.ts:165`, `packages/index/src/retrieval-sql.ts:189`, `packages/index/src/retrieval-sql.ts:247`, `packages/index/src/retrieval-sql.ts:5-10`). It drops the `vector` arm to a lexical floor when no embedder is bound, when the embedder fails, or when vector coverage is below its floor (`packages/index/src/retrieval.ts:109-116`).

- `packages/index/src/indexer.ts` (1032 LOC)
- `packages/index/src/retrieval.ts` (689 LOC)
- `packages/index/src/traces-persist.ts` (569 LOC)
- `packages/index/src/database.ts` (399 LOC)
- `packages/index/src/project.ts` (397 LOC)
- `packages/index/src/retrieval-sql.ts` (365 LOC)
- `packages/index/src/scope.ts` (328 LOC)
- `packages/index/src/vector-coverage.ts` (150 LOC)

## packages/store

`@memhtml/store` is the git-backed file store behind the v1 write doors. Every operation that changes the corpus is one commit, and every git failure is a typed value (`packages/store/src/index.ts:2-3`). The tree is the system of record and the index is derived from it, so an operation that changed a file without committing would leave the index describing a state git doesn't have (`packages/store/src/index.ts:5-7`). Every write takes the in-process write permit and then the cross-process checkout lock, so a v1 write and a session commit on one checkout exclude each other (`packages/store/src/store.ts:1397-1423`, `packages/store/src/checkout-lock.ts:14-19`). Git's `-z` plumbing formats are parsed by pure total functions in `plumbing.ts`, pinned against captured bytes so that a truncated stream from a killed subprocess is a tested case (`packages/store/src/plumbing.ts:2-8`). `layout.ts` holds the scaffold `memhtml init` writes, including the PARA directories and the `merge=ours` driver registration. Creating a root is always an explicit step, so a typo in `MEMHTML_ROOT` is an error and doesn't produce a second empty root (`packages/store/src/layout.ts:36-48`, `packages/store/src/layout.ts:100-106`, `packages/store/src/layout.ts:15-18`).

- `packages/store/src/store.ts` (1436 LOC)
- `packages/store/src/git.ts` (493 LOC)
- `packages/store/src/plumbing.ts` (425 LOC)
- `packages/store/src/layout.ts` (246 LOC)
- `packages/store/src/testing.ts` (209 LOC)
- `packages/store/src/checkout-lock.ts` (44 LOC)

## packages/html

`@memhtml/html` is the only implementation of the memory file format. It parses, serializes, and hashes a file, and it holds the head editors that change one field at a time (`packages/html/src/index.ts:2-5`). The format is semantic HTML5 over a closed vocabulary, and `vocabulary.ts` states that vocabulary as data, so the policy is a list of element and metadata names (`packages/html/src/vocabulary.ts:2-5`, `packages/html/src/vocabulary.ts:41`, `packages/html/src/vocabulary.ts:107`). `constraints.ts` is the format check the store runs before it writes anything, so a rejected write leaves the tree byte-identical (`packages/html/src/constraints.ts:422-426`). The `sha256` content hash over the normalized text of `<article>` is the dedup key. It doesn't change when a head edit changes metadata, so editing metadata doesn't register as new content (`packages/html/src/hash.ts:7-15`, `packages/html/src/hash.ts:19`).

- `packages/html/src/parse.ts` (427 LOC)
- `packages/html/src/constraints.ts` (377 LOC)
- `packages/html/src/editors.ts` (298 LOC)
- `packages/html/src/vocabulary.ts` (266 LOC)
- `packages/html/src/document.ts` (220 LOC)
- `packages/html/src/template.ts` (210 LOC)
- `packages/html/src/hash.ts` (185 LOC)
- `packages/html/src/tree.ts` (118 LOC)

## packages/domain

`@memhtml/domain` holds the pure ranking and curation arithmetic, and its barrel is type-only where it names a contracts type so its build output imports nothing but `effect` (`packages/domain/src/index.ts:1-3`). `retention.ts` is the eight-signal retention scorer and its triage bands, with the SQL phase gathering raw inputs and calling into it (`packages/domain/src/retention.ts:4-5`). Most of the package ports rules rather than designing them. `retention.ts`, `decay.ts`, and `merge.ts` port the predecessor memory system's rules (`packages/domain/src/retention.ts:4-5`, `packages/domain/src/decay.ts:15-16`, `packages/domain/src/merge.ts:2-3`). `frame.ts` carries the claim-slot grammar ported verbatim from the eval harness, where the rule was measured before it was adopted (`packages/domain/src/frame.ts:2`, `packages/domain/src/frame.ts:9-12`). The fence-language detector `detect.ts` in `@memhtml/html` follows the same measured-port pattern (`packages/html/src/detect.ts:2-6`). `graph.ts` must return the same result for the same input, because PageRank and community scores feed retention signals, and a run-to-run reordering would change which memories get evicted from an unchanged corpus (`packages/domain/src/graph.ts:5-7`). The RRF fold `searchHead` uses is this package's too (`packages/head/src/search.ts:2`).

- `packages/domain/src/merge.ts` (398 LOC)
- `packages/domain/src/retention.ts` (353 LOC)
- `packages/domain/src/graph.ts` (257 LOC)
- `packages/domain/src/neighbors.ts` (195 LOC)
- `packages/domain/src/decay.ts` (150 LOC)
- `packages/domain/src/frame.ts` (111 LOC)
- `packages/domain/src/mmr.ts` (89 LOC)
- `packages/domain/src/rrf.ts` (87 LOC)
- `packages/domain/src/cosine.ts` (73 LOC)

## packages/llm

`@memhtml/llm` holds Bedrock embeddings and structured output (`packages/llm/package.json:5`). The embedder is Cohere Embed v4 on `bedrock-runtime` InvokeModel at 1024 dimensions, with separate document and query entry points because Cohere embeds the two into different regions of one space (`packages/llm/src/embeddings.ts:8-16`, `packages/llm/src/constants.ts:7-8`). The proxy client satisfies the same `InvokeClient` interface over an OpenAI- and Anthropic-compatible LLM proxy, so neither the model client nor the embedder learns that a second transport exists (`packages/llm/src/proxy.ts:14-22`).

- `packages/llm/src/wire.ts` (370 LOC)
- `packages/llm/src/proxy.ts` (283 LOC)
- `packages/llm/src/model-client.ts` (262 LOC)
- `packages/llm/src/client.ts` (199 LOC)
- `packages/llm/src/embeddings.ts` (177 LOC)

## packages/traces

`@memhtml/traces` is the streaming JSONL parser and trace indexer (`packages/traces/package.json:5`). The scan composes discovery, the watermark decision, and extraction, and it hands persistence to `@memhtml/index`'s trace persister, so it stays free of SQL (`packages/traces/src/scan.ts:14-19`).

- `packages/traces/src/extract.ts` (437 LOC)
- `packages/traces/src/scan.ts` (248 LOC)
- `packages/traces/src/discover.ts` (212 LOC)
- `packages/traces/src/parse.ts` (159 LOC)
- `packages/traces/src/watermark.ts` (97 LOC)

## packages/eval

`@memhtml/eval` holds the fixture corpus generator and the refusable discrimination gate (`packages/eval/src/index.ts:1-2`). It builds a real git repository and renders real memory files, so it depends on the store and the html package at runtime (`packages/eval/src/index.ts:4-9`). The corpus is a pure function of `(seed, now)` and is never committed (`packages/eval/src/index.ts:11-13`).

- `packages/eval/src/corpus.ts` (1106 LOC)
- `packages/eval/src/discriminate.ts` (295 LOC)
- `packages/eval/src/harness.ts` (257 LOC)
- `packages/eval/src/controls.ts` (198 LOC)
- `packages/eval/src/run.ts` (193 LOC)

## packages/integrations

`@memhtml/integrations` wires a coding agent to a memhtml store with an MCP entry, hooks, an instruction block, a skill, and a receipt (`packages/integrations/package.json:5`). It's pure rendering and file transactions, and the `memhtml hook` engine that opens a store lives in `apps/cli` (`packages/integrations/src/index.ts:1-12`).

- `packages/integrations/src/install.ts` (909 LOC)
- `packages/integrations/src/doctor.ts` (601 LOC)
- `packages/integrations/src/adapters/json.ts` (393 LOC)
- `packages/integrations/src/hosts.ts` (277 LOC)

## packages/telemetry

`@memhtml/telemetry` is the opt-in OTLP trace exporter, gated on `OTEL_EXPORTER_OTLP_ENDPOINT` (`packages/telemetry/src/index.ts:4-5`). It uses Effect's own `OtlpTracer`, so export adds no dependency beyond `effect` (`packages/telemetry/src/index.ts:14-18`, `packages/telemetry/package.json:25-27`). With the endpoint unset, `layerTelemetry` is `Layer.empty` and the exporter module is never loaded (`packages/telemetry/src/index.ts:103-106`). The CLI and the MCP server each provide it with their own service name (`apps/cli/src/run.ts:2439`, `apps/mcp/src/server.ts:61`).

- `packages/telemetry/src/index.ts` (129 LOC)

## packages/contracts

`@memhtml/contracts` sits at the root of the dependency graph. It declares no `@memhtml/*` dependency of its own (`packages/contracts/package.json:60-62`). Fourteen of the fifteen other workspace packages this map covers depend on it, all but `@memhtml/telemetry`, and the `tests-integration` harness depends on it too (`packages/telemetry/package.json:25-27`, `tests-integration/package.json:14`). It owns the closed vocabularies every other module restates in SQL rather than in a second TypeScript copy: ten memory types, four PARA buckets, four non-mixing edge classes, and the memory and task relation sets (`packages/contracts/src/types.ts:18`, `packages/contracts/src/types.ts:63`, `packages/contracts/src/edges.ts:9`, `packages/contracts/src/edges.ts:19`, `packages/contracts/src/edges.ts:54`). `paths.ts` holds the path algebra, and every path it produces is the root-relative git-tree form with no leading slash (`packages/contracts/src/paths.ts:4-6`). A path is the memory's identity, and there's no uuid anywhere in the system, so the slug rules in `slug.ts` have to keep a slug stable, readable, and safe on a filesystem (`packages/contracts/src/slug.ts:2-4`). `record.ts` declares the `HeadView` and `OverlayOp` shapes the head and the session share (`packages/contracts/src/record.ts:52`, `packages/contracts/src/record.ts:81`). `store-config.ts` declares `memhtml.config.json` and decodes it strictly (`packages/contracts/src/store-config.ts:5-21`). `checkout-lock.ts` fixes the checkout lock's path and timing for the store and the session alike (`packages/contracts/src/checkout-lock.ts:31-54`).

- `packages/contracts/src/paths.ts` (238 LOC)
- `packages/contracts/src/store-config.ts` (230 LOC)
- `packages/contracts/src/types.ts` (196 LOC)
- `packages/contracts/src/checkout-lock.ts` (195 LOC)
- `packages/contracts/src/edges.ts` (149 LOC)
- `packages/contracts/src/slug.ts` (108 LOC)
- `packages/contracts/src/errors.ts` (106 LOC)
- `packages/contracts/src/record.ts` (92 LOC)

## Supporting code

These are the integration tests and the repository scripts. The harness declares fourteen of the sixteen packages this map covers, all but `@memhtml/integrations` and `@memhtml/telemetry` (`tests-integration/package.json:12-28`).

- `tests-integration/tests/batch.test.ts` (905 LOC)
- `tests-integration/tests/v2-curate.test.ts` (884 LOC)
- `tests-integration/tests/v2-sessions.test.ts` (859 LOC)
- `tests-integration/tests/contracts.test.ts` (824 LOC)
- `tests-integration/tests/mcp-stdio.test.ts` (731 LOC)
- `tests-integration/tests/tasks.test.ts` (692 LOC)
- `tests-integration/tests/harness.ts` (241 LOC)
- `scripts/smoke-package.mjs` (1302 LOC)
- `scripts/package-manifest.mjs` (138 LOC)
- `scripts/readme-figures.mjs` (107 LOC)
- `scripts/probe-sqlite-concurrency.mjs` (86 LOC)

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at cf76951.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 90 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 81 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 68 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 66 shared source citations
- [memhtml-public · Processes](../behavior/processes.md): 57 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 55 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 45 shared source citations
- [memhtml-public · Public API](../reference/public-api.md): 43 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 38 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 36 shared source citations
- [memhtml-public · RPC tools](../reference/rpc-tools.md): 33 shared source citations
- [memhtml-public · Data flow](../architecture/data-flow.md): 29 shared source citations
- [memhtml-public · State machines](../behavior/state-machines.md): 27 shared source citations
- [memhtml-public · Sequences](../diagrams/behavioral/sequences.md): 25 shared source citations
- [memhtml-public · Components](../diagrams/architecture/components.md): 18 shared source citations

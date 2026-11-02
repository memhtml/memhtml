---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Module map

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

memhtml splits into fourteen named modules: a schema leaf (`packages/contracts`) that every other module imports, one `apps` module holding the two binaries and the docs site, and twelve single-purpose libraries between them. The page is built from the module import graph (modules, edges, afferent and efferent coupling), each directory's git history (commits that changed a file now under the directory, followed through renames, leaving out bot commits and bulk commits of more than 30 code files), the file import counts (which order each module's file list by how many files import it) and `wc -l` for every LOC figure. The graph resolves file dependencies and misses some package imports, so each "Depends on" line lists the `@memhtml/` packages the module's source imports at this commit, while the Ca and Ce figures are the graph's.

Sections follow the module import graph's order, which sorts modules by neighbor count. Each bullet list holds a module's most-imported source files, highest first.

## packages/contracts

The contracts package holds schemas, enums, typed errors and path algebra with no I/O (`packages/contracts/package.json:5`). Its most-imported file is `errors.ts`, which declares tagged errors such as `StorageFailure`, whose payload omits SQL text so it can reach an agent without leaking corpus content (`packages/contracts/src/errors.ts:3-11`). `record.ts` defines `MemoryRecord` and the read-only `HeadView` that every v2 package codes against (`packages/contracts/src/record.ts:1-13`). It depends on no other module; its history counts 24 commits.

Coupling: Ca 78, Ce 0.

- `packages/contracts/src/errors.ts` (106 LOC)
- `packages/contracts/src/record.ts` (92 LOC)
- `packages/contracts/src/store-config.ts` (230 LOC)
- `packages/contracts/src/checkout-lock.ts` (195 LOC)
- `packages/contracts/src/types.ts` (196 LOC)
- `packages/contracts/src/paths.ts` (367 LOC)
- `packages/contracts/src/slug.ts` (151 LOC)
- `packages/contracts/src/edges.ts` (149 LOC)

## apps

The `apps` module holds the `memhtml` binary (`apps/cli/package.json:5`), the `memhtml-mcp` stdio server (`apps/mcp/package.json:5`) and the docs site, whose `gates.ts` declares what the built site may contain and which pages the browser gates audit (`apps/docs/src/gates.ts:1-6`). Its most-imported file is the CLI's `envelope.ts`, the machine contract with an `apiVersion` and an append-only list of response discriminators (`apps/cli/src/envelope.ts:1-12`); `api-layer.ts` is the composition root `AppLive` (`apps/cli/src/api-layer.ts:62`), and `commands.ts` holds the `COMMANDS` table (`apps/cli/src/commands.ts:186`). The MCP server reuses the CLI's layer and serves over `McpServer.layerStdio` (`apps/mcp/src/server.ts:1-8`, `apps/mcp/src/server.ts:44-50`). It is the busiest module, with 164 commits in its history and a peak of 30 in the week of 2026-08-31.

Depends on: contracts, curator, domain, eval, head, html, index, integrations, llm, session, snapshot, store, telemetry and traces.

Coupling: Ca 0, Ce 33.

- `apps/cli/src/envelope.ts` (237 LOC)
- `apps/cli/src/run.ts` (2580 LOC)
- `apps/cli/src/api-layer.ts` (449 LOC)
- `apps/cli/src/head-protocol.ts` (901 LOC)
- `apps/cli/src/v2.ts` (2218 LOC)
- `apps/cli/src/config.ts` (309 LOC)
- `apps/cli/src/commands.ts` (2116 LOC)
- `apps/cli/src/operations.ts` (2634 LOC)

## packages/store

The store is the git-backed file store for read, write, move, commit and status (`packages/store/package.json:5`). Its largest file, `store.ts`, states the contract that every corpus-changing operation is one git commit (`packages/store/src/store.ts:40-45`), and its most-imported file, `git.ts`, wraps the git subprocess behind an Effect service (`packages/store/src/git.ts:1-5`). Its history counts 30 commits.

Depends on: contracts, html.

Coupling: Ca 5, Ce 4.

- `packages/store/src/git.ts` (625 LOC)
- `packages/store/src/plumbing.ts` (425 LOC)
- `packages/store/src/store.ts` (1485 LOC)
- `packages/store/src/testing.ts` (209 LOC)
- `packages/store/src/layout.ts` (281 LOC)
- `packages/store/src/checkout-lock.ts` (44 LOC)
- `packages/store/src/index.ts` (93 LOC)

## packages/index

The index package owns the SQLite schema, migrations, the git-driven indexer and four-arm retrieval (`packages/index/package.json:5`). Its most-imported file, `database.ts`, wraps Node's built-in `DatabaseSync` so there is no third-party database dependency (`packages/index/src/database.ts:4-11`), and `indexer.ts` projects memory files parsed by `@memhtml/html` into it (`packages/index/src/indexer.ts:1-14`). Its history counts 43 commits, peaking at 10 in the week of 2026-08-24.

Depends on: contracts, domain, html.

Coupling: Ca 11, Ce 3.

- `packages/index/src/database.ts` (399 LOC)
- `packages/index/src/schema-const.ts` (89 LOC)
- `packages/index/src/indexer.ts` (1032 LOC)
- `packages/index/src/retrieval.ts` (689 LOC)
- `packages/index/src/scope.ts` (328 LOC)
- `packages/index/src/git-port.ts` (82 LOC)
- `packages/index/src/retrieval-sql.ts` (365 LOC)
- `packages/index/src/traces-persist.ts` (569 LOC)

## packages/head

The head package holds the corpus as a value: one immutable version per commit in persistent `effect` structures, advanced by delta and searched by RRF over a lexical and a vector arm (`packages/head/src/index.ts:1-6`). Its most-imported file, `version.ts`, builds a version from git tree entries read through `@memhtml/store` (`packages/head/src/version.ts:1-5`). Its history counts 15 commits.

Depends on: contracts, domain, html, store.

Coupling: Ca 6, Ce 4.

- `packages/head/src/version.ts` (201 LOC)
- `packages/head/src/index.ts` (51 LOC)
- `packages/head/src/indexes.ts` (157 LOC)
- `packages/head/src/lexical.ts` (160 LOC)
- `packages/head/src/record.ts` (63 LOC)
- `packages/head/src/search.ts` (265 LOC)
- `packages/head/src/gate.ts` (270 LOC)
- `packages/head/src/vectors.ts` (153 LOC)

## packages/eval

The eval package generates the fixture corpus and runs the retrieval discrimination gate (`packages/eval/package.json:5`). Its largest file, `corpus.ts`, is the fixture corpus as a pure specification (`packages/eval/src/corpus.ts:12-13`), and `discriminate.ts` asks whether retrieval ranks a memory above its own high-similarity wrong twin (`packages/eval/src/discriminate.ts:8-11`). Its history counts 23 commits.

Depends on: contracts, domain, html, index, llm, store.

Coupling: Ca 2, Ce 5.

- `packages/eval/src/corpus.ts` (1106 LOC)
- `packages/eval/src/controls.ts` (198 LOC)
- `packages/eval/src/discriminate.ts` (295 LOC)
- `packages/eval/src/fixture.ts` (179 LOC)
- `packages/eval/src/harness.ts` (257 LOC)
- `packages/eval/src/run.ts` (193 LOC)
- `packages/eval/src/gen-fixture.ts` (136 LOC)
- `packages/eval/src/index.ts` (70 LOC)

## packages/domain

The domain package is pure math: retention, decay, RRF, MMR and merge guards (`packages/domain/package.json:5`). Its most-imported file, `ranking.ts`, fixes the RRF rank offset `RRF_K` that the retrieval SQL also inlines (`packages/domain/src/ranking.ts:3-8`), and its largest, `retention.ts`, is the eight-signal retention scorer (`packages/domain/src/retention.ts:3-6`). Its history counts 23 commits.

Depends on: contracts.

Coupling: Ca 5, Ce 1.

- `packages/domain/src/ranking.ts` (37 LOC)
- `packages/domain/src/cosine.ts` (73 LOC)
- `packages/domain/src/mmr.ts` (89 LOC)
- `packages/domain/src/reinforce.ts` (69 LOC)
- `packages/domain/src/frame.ts` (111 LOC)
- `packages/domain/src/retention.ts` (353 LOC)
- `packages/domain/src/rrf.ts` (87 LOC)
- `packages/domain/src/agreement.ts` (42 LOC)

## packages/session

The session package holds a session's overlay log and the mechanical commit path that lands it on a ref through a temporary git index (`packages/session/src/index.ts:1-4`). Its most-imported file, `session.ts`, persists the overlay with `proper-lockfile` and `write-file-atomic` (`packages/session/src/session.ts:1-12`). Its history counts 33 commits, 6 of them in the week of 2026-10-26.

Depends on: contracts.

Coupling: Ca 7, Ce 4.

- `packages/session/src/session.ts` (506 LOC)
- `packages/session/src/validate.ts` (575 LOC)
- `packages/session/src/plumbing.ts` (460 LOC)
- `packages/session/src/commit.ts` (664 LOC)
- `packages/session/src/errors.ts` (9 LOC)
- `packages/session/src/checkout-lock.ts` (41 LOC)
- `packages/session/src/exclude.ts` (93 LOC)
- `packages/session/src/moves.ts` (366 LOC)

## packages/curator

The curator is a bounded model-driven tool loop over a curator session, with its charter, budget and model factory (`packages/curator/package.json:5`). `loop.ts` runs `generateText` with tools and stop conditions and ends on a `finish` tool call (`packages/curator/src/loop.ts:12-14`), fed by the briefing that `briefing.ts` builds from a `HeadView` (`packages/curator/src/briefing.ts:1-9`). It is the newest module: its history starts on 2026-10-19 with 8 commits.

Depends on: contracts, domain, head, html, llm, session.

Coupling: Ca 2, Ce 3.

- `packages/curator/src/briefing.ts` (523 LOC)
- `packages/curator/src/index.ts` (127 LOC)
- `packages/curator/src/planner/types.ts` (124 LOC)
- `packages/curator/src/inbox.ts` (426 LOC)
- `packages/curator/src/loop.ts` (311 LOC)
- `packages/curator/src/tools.ts` (225 LOC)
- `packages/curator/src/budget.ts` (37 LOC)
- `packages/curator/src/charter.ts` (122 LOC)

## packages/llm

The llm package provides Bedrock embeddings and structured output (`packages/llm/package.json:5`). Its most-imported file, `client.ts`, calls `InvokeModelCommand` on the Bedrock runtime client and reads proxy settings through `effect/Config` (`packages/llm/src/client.ts:1-10`), and `embeddings.ts` targets Cohere Embed v4 (`packages/llm/src/embeddings.ts:9`). Its history counts 39 commits.

Depends on: contracts.

Coupling: Ca 2, Ce 1.

- `packages/llm/src/client.ts` (199 LOC)
- `packages/llm/src/constants.ts` (64 LOC)
- `packages/llm/src/model-client.ts` (262 LOC)
- `packages/llm/src/wire.ts` (370 LOC)
- `packages/llm/src/embeddings.ts` (177 LOC)
- `packages/llm/src/models.ts` (117 LOC)
- `packages/llm/src/proxy-config.ts` (163 LOC)
- `packages/llm/src/proxy.ts` (283 LOC)

## packages/traces

The traces package is a streaming JSONL parser and trace indexer (`packages/traces/package.json:5`). Its most-imported and largest file, `extract.ts`, is a pure fold over session lines that never throws, because another process may truncate the file mid-line (`packages/traces/src/extract.ts:1-8`). Its history counts 16 commits.

Depends on: contracts.

Coupling: Ca 1, Ce 1.

- `packages/traces/src/extract.ts` (437 LOC)
- `packages/traces/src/discover.ts` (212 LOC)
- `packages/traces/src/watermark.ts` (97 LOC)
- `packages/traces/src/parse.ts` (159 LOC)
- `packages/traces/src/scan.ts` (248 LOC)
- `packages/traces/src/index.ts` (5 LOC)

## packages/html

The html package parses and serializes the memory file format (`packages/html/package.json:5`). Its most-imported file, `vocabulary.ts`, declares the closed vocabulary of elements and metadata names as data, with no sanitizer library (`packages/html/src/vocabulary.ts:1-6`). Its history counts 25 commits.

Depends on: contracts.

Coupling: Ca 1, Ce 1.

- `packages/html/src/vocabulary.ts` (301 LOC)
- `packages/html/src/template.ts` (265 LOC)
- `packages/html/src/hash.ts` (185 LOC)
- `packages/html/src/tree.ts` (118 LOC)
- `packages/html/src/serialize.ts` (117 LOC)
- `packages/html/src/document.ts` (232 LOC)
- `packages/html/src/fences.ts` (72 LOC)
- `packages/html/src/parse.ts` (427 LOC)

## packages/snapshot

The snapshot package is the columnar cold-start cache (`packages/snapshot/src/index.ts:1`). Its largest file is `snapshot.ts`, which `index.ts` re-exports with the pruning API from `prune.ts` (`packages/snapshot/src/index.ts:2-10`). It is the quietest named module, with 2 commits in its history.

Depends on: contracts.

Coupling: Ca 0, Ce 2.

- `packages/snapshot/src/staging.ts` (72 LOC)
- `packages/snapshot/src/snapshot.ts` (528 LOC)
- `packages/snapshot/src/index.ts` (32 LOC)
- `packages/snapshot/src/prune.ts` (100 LOC)
- `packages/snapshot/src/vectors.ts` (249 LOC)

## packages/integrations

The integrations package wires a coding agent (Claude Code, Codex, Cursor, OpenCode) to a memhtml store through an MCP entry, hooks, an instruction block, a skill and a receipt (`packages/integrations/package.json:5`). Its most-imported file, `types.ts`, holds the closed vocabularies every other module in the package and the CLI's `integrations` and `hook` commands import (`packages/integrations/src/types.ts:2-5`), and its largest, `install.ts`, plans every write and lands the whole set or none of it (`packages/integrations/src/install.ts:1-3`). Its history counts 10 commits.

Depends on: contracts.

Coupling: Ca 2, Ce 0.

- `packages/integrations/src/types.ts` (137 LOC)
- `packages/integrations/src/command-line.ts` (72 LOC)
- `packages/integrations/src/fs.ts` (189 LOC)
- `packages/integrations/src/receipt.ts` (176 LOC)
- `packages/integrations/src/install.ts` (909 LOC)
- `packages/integrations/src/hosts.ts` (277 LOC)
- `packages/integrations/src/render/hooks.ts` (178 LOC)
- `packages/integrations/src/render/skill.ts` (70 LOC)

## Supporting code

Test, tooling and small modules, from the module import graph. Each has Ca 0 there; only `tests-integration` has an outgoing edge (to contracts, Ce 1).

- `tests-integration`: cross-package integration contracts (`tests-integration/package.json:6`), 51 commits in its history. Key files: `tests-integration/tests/packaging.test.ts` (315 LOC), `tests-integration/tests/vex.test.ts` (209 LOC), `tests-integration/vitest.config.ts` (28 LOC).
- `scripts`: packaging, release and supply-chain tooling, 34 commits in its history. `scripts/smoke-package.mjs` (1321 LOC) installs the assembled `memhtml` and drives every subsystem through it (`scripts/smoke-package.mjs:3`); `scripts/package-manifest.mjs` (138 LOC) writes the published `package.json` into `dist-package/` (`scripts/package-manifest.mjs:3`). Others: `scripts/scorecard-gate.mjs` (332 LOC), `scripts/release-assets.mjs` (300 LOC), `scripts/vex-to-osv-config.mjs` (112 LOC), `scripts/readme-figures.mjs` (107 LOC), `scripts/probe-sqlite-concurrency.mjs` (86 LOC), `scripts/verify-sarif.mjs` (84 LOC), `scripts/verify-pnpm-pin.mjs` (73 LOC).
- `packages/telemetry`: the opt-in OTLP trace exporter, active only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`packages/telemetry/package.json:5`). One source file, `packages/telemetry/src/index.ts` (133 LOC), exporting `layerTelemetry` (`packages/telemetry/src/index.ts:107`).
- `.`: the root module's one code file, `tsdown.config.ts` (132 LOC).
- `.claude`: the `resolve-dependabot-prs` agent skill (`.claude/skills/resolve-dependabot-prs/SKILL.md:2`), with `.claude/skills/resolve-dependabot-prs/scripts/cooldown-check.mjs` (132 LOC).

## See also

- [system overview](system-overview.md): 21 shared source citations
- [impact analysis](../insights/impact-analysis.md): 10 shared source citations
- [REPORT](../REPORT.md): 8 shared source citations
- [components](../diagrams/architecture/components.md): 8 shared source citations
- [dependency graph](../diagrams/structural/dependency-graph.md): 7 shared source citations

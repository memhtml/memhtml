# memhtml-public · Module map

Describes the source at 0.15.1 (main 3b2a068, 2026-09-24). Citations are `path:line` into that tree. LOC is the `wc -l` line count of the file, measured at that commit.

This repository is the software that manages a memory root, a separate git repository located by `$MEMHTML_ROOT` (`apps/cli/src/config.ts:64-66`). No memory lives here. The modules below are a pnpm workspace of eleven libraries under `packages/` and four apps under `apps/`, declared in `pnpm-workspace.yaml:1-4` together with the `tests-integration` harness. Eight modules have a section of their own, and the other workspace packages are listed under Supporting code with the integration tests and the repository scripts. The sections are not ordered by size. They open with `apps/cli`, the composition root, and close with `@memhtml/contracts`, which depends on no other workspace package. The `apps/docs` package is out of scope for this map.

## apps/cli

`apps/cli` builds the `memhtml` binary declared at `apps/cli/package.json:21-22`. It is also the composition root, and the MCP server imports it instead of building its own (`apps/cli/src/index.ts:2-7`). Every command an agent calls writes exactly one JSON envelope to stdout. The envelope's `apiVersion` field lets the shape evolve, and its `type` and `code` fields are discriminators an agent branches on, drawn from two append-only lists (`apps/cli/src/envelope.ts:2`, `apps/cli/src/envelope.ts:9-12`, `apps/cli/src/envelope.ts:76-80`). Two outputs are not envelopes: `memhtml help` on a terminal writes Markdown, and a successful `memhtml hook` writes the host's hook protocol (`apps/cli/src/envelope.ts:49-52`). Exit code 0 is success, 2 is a usage error the agent fixes by changing the call, and 1 is a runtime failure it fixes by changing the root or the environment (`apps/cli/src/envelope.ts:119-122`). The command table in `commands.ts` is the one machine-readable description of that surface. `memhtml manifest` serves it, and `memhtml agents-doc` regenerates `AGENTS.md` from it (`apps/cli/src/commands.ts:169-179`, `AGENTS.md:1`).

- `apps/cli/src/operations.ts` (2769 LOC)
- `apps/cli/src/run.ts` (1827 LOC)
- `apps/cli/src/commands.ts` (1579 LOC)
- `apps/cli/src/doctor.ts` (770 LOC)
- `apps/cli/src/api-layer.ts` (671 LOC)
- `apps/cli/src/exec.ts` (533 LOC)
- `apps/cli/src/apply.ts` (439 LOC)
- `apps/cli/src/envelope.ts` (189 LOC)

## packages/index

`@memhtml/index` owns the rebuildable SQLite plane over the root: schema, migrations, the git-driven indexer, and four-arm retrieval (`packages/index/package.json:5`). The root's `.memhtml/index.db` is a projection of the root's git tree and can be deleted and rebuilt without loss, while `state.db` is ATTACHed over the same connection and holds the one set of facts git cannot reproduce (`packages/index/src/index.ts:5-6`). The indexer reads the tree through a read-only port that it declares itself rather than importing the store. The indexer therefore cannot commit, which keeps "rebuildable from git" non-circular (`packages/index/src/git-port.ts:7-13`). Retrieval fuses four ranked arms named `fts`, `vector`, `recency`, and `salience` with reciprocal rank fusion (`packages/index/src/retrieval-sql.ts:125`, `packages/index/src/retrieval-sql.ts:165`, `packages/index/src/retrieval-sql.ts:189`, `packages/index/src/retrieval-sql.ts:247`, `packages/index/src/retrieval-sql.ts:5-10`). It drops the `vector` arm to a lexical floor when no embedder is bound, when the embedder fails, or when vector coverage is below its floor (`packages/index/src/retrieval.ts:106-108`).

- `packages/index/src/indexer.ts` (1032 LOC)
- `packages/index/src/retrieval.ts` (685 LOC)
- `packages/index/src/traces-persist.ts` (569 LOC)
- `packages/index/src/database.ts` (399 LOC)
- `packages/index/src/project.ts` (397 LOC)
- `packages/index/src/retrieval-sql.ts` (365 LOC)
- `packages/index/src/scope.ts` (328 LOC)
- `packages/index/src/schema-const.ts` (87 LOC)

## packages/sleep

`@memhtml/sleep` runs the curation cycle over the root as a series of git commits on a `sleep/<date>` branch (`packages/sleep/src/run.ts:95`). The phase names, their execution order, and their prerequisite graph live in one contract module, and the commit trailer, the `sleep_phases` row, and the `--phases` flag all read a phase name from there (`packages/sleep/src/contract.ts:9-11`). `SLEEP_PHASES` lists seventeen phases at 0.15.1 (`packages/sleep/src/contract.ts:43`), and `HARD_PREREQUISITES` spells out the edges between them one literal pair at a time (`packages/sleep/src/contract.ts:101-108`). Count the phases from the enum rather than from this sentence, since a new phase moves the number. Two of the seventeen commit nothing by construction, `preflight` and `relationship-mining` (`NON_COMMITTING_PHASES`, `packages/sleep/src/contract.ts:241`). A committing phase is not limited to one commit. `arc-synthesis` commits once per arc, `compress` once per folded group, and `trace-consolidation` once per distilled memory plus once for the commitments it detects, so the number of commits in a full run depends on the corpus (`packages/sleep/src/phases/arc-synthesis.ts:299`, `packages/sleep/src/phases/compress.ts:497`, `packages/sleep/src/phases/trace-consolidation.ts:1208`, `packages/sleep/src/phases/trace-consolidation.ts:1257`). Each commit carries a `Memhtml-Run` / `Memhtml-Phase` / `Memhtml-Counts` trailer block written in exactly one place (`packages/sleep/src/commit.ts:10`, `packages/sleep/src/commit.ts:22-31`). `memhtml sleep resume` reads those trailers out of the branch's git log to decide what a run already did, so the git log rather than a journal table is the record of progress (`packages/sleep/src/commit.ts:12-13`). The package constructs none of its own services. Every dependency arrives as a caller-supplied shape, so a test can point a run at a temp-dir git repo (`packages/sleep/src/env.ts:24-27`).

- `packages/sleep/src/phases/trace-consolidation.ts` (1569 LOC)
- `packages/sleep/src/sql.ts` (1447 LOC)
- `packages/sleep/src/phases/entity-resolution.ts` (1249 LOC)
- `packages/sleep/src/run.ts` (969 LOC)
- `packages/sleep/src/phases/dedup-merge.ts` (869 LOC)
- `packages/sleep/src/contract.ts` (688 LOC)
- `packages/sleep/src/review.ts` (573 LOC)
- `packages/sleep/src/edits.ts` (323 LOC)
- `packages/sleep/src/env.ts` (233 LOC)
- `packages/sleep/src/publish.ts` (171 LOC)

## packages/store

`@memhtml/store` is the git-backed file store and the only writer to the root. Every operation that changes the corpus is one commit, and every git failure is a typed value (`packages/store/src/index.ts:2-3`). The tree is the system of record and the index is derived from it, so an operation that changed a file without committing would leave the index describing a state git does not have (`packages/store/src/index.ts:5-7`). Git's `-z` plumbing formats are parsed by pure total functions in `plumbing.ts`, pinned against captured bytes so that a truncated stream from a killed subprocess is a tested case (`packages/store/src/plumbing.ts:2-8`). `layout.ts` holds the scaffold `memhtml init` writes, including the PARA directories and the `merge=ours` driver registration. Creating a root is always an explicit step, so a typo in `MEMHTML_ROOT` is an error and does not produce a second empty root (`packages/store/src/layout.ts:41-48`, `packages/store/src/layout.ts:76`, `packages/store/src/layout.ts:15-18`).

- `packages/store/src/store.ts` (1417 LOC)
- `packages/store/src/git.ts` (484 LOC)
- `packages/store/src/plumbing.ts` (425 LOC)
- `packages/store/src/layout.ts` (211 LOC)
- `packages/store/src/testing.ts` (204 LOC)
- `packages/store/src/index.ts` (84 LOC)

## packages/html

`@memhtml/html` is the only implementation of the memory file format. It parses, serializes, and hashes a file, and it holds the head editors that change one field at a time (`packages/html/src/index.ts:2-5`). The format is semantic HTML5 over a closed vocabulary, and `vocabulary.ts` states that vocabulary as data, so the policy is a list of element and metadata names (`packages/html/src/vocabulary.ts:2-5`, `packages/html/src/vocabulary.ts:41`, `packages/html/src/vocabulary.ts:107`). `constraints.ts` is the format check the store runs before it writes anything, so a rejected write leaves the tree byte-identical (`packages/html/src/constraints.ts:354-358`, `AGENTS.md:65`). The `sha256` content hash over the normalized text of `<article>` is the dedup key. It does not change when a head edit changes metadata, so editing metadata does not register as new content (`packages/html/src/hash.ts:7-15`, `packages/html/src/hash.ts:19`).

- `packages/html/src/parse.ts` (427 LOC)
- `packages/html/src/constraints.ts` (377 LOC)
- `packages/html/src/editors.ts` (289 LOC)
- `packages/html/src/vocabulary.ts` (266 LOC)
- `packages/html/src/document.ts` (220 LOC)
- `packages/html/src/template.ts` (210 LOC)
- `packages/html/src/hash.ts` (185 LOC)
- `packages/html/src/tree.ts` (118 LOC)

## apps/mcp

`apps/mcp` builds the `memhtml-mcp` stdio server declared at `apps/mcp/package.json:20-21`, exposing fifteen tools and three resources over the same root the CLI reads (`apps/mcp/src/index.ts:2`, `apps/mcp/src/tools.ts:1082-1098`, `apps/mcp/src/resources.ts:369`). It imports `layerApp` from `apps/cli` rather than composing its own service graph, so both agent surfaces resolve to exactly one database file, one git root, and one vector space (`apps/mcp/src/server.ts:1`, `apps/mcp/src/server.ts:53`, `apps/cli/src/index.ts:4-7`). Sleep is left off the tool surface on purpose, because a run rewrites confidence across the corpus and creates a branch a human is expected to read. `memhtml sleep run` is its only entry point, and no tool fires it (`apps/mcp/src/index.ts:4-6`). `failure.ts` declares one wire error class whose message survives the MCP framework's rewrite of generic tool failures, so the agent reads the message the tool wrote (`apps/mcp/src/failure.ts:5-16`).

- `apps/mcp/src/tools.ts` (1110 LOC)
- `apps/mcp/src/handlers.ts` (872 LOC)
- `apps/mcp/src/resources.ts` (376 LOC)
- `apps/mcp/src/failure.ts` (277 LOC)
- `apps/mcp/src/server.ts` (63 LOC)
- `apps/mcp/src/bin.ts` (15 LOC)

## packages/domain

`@memhtml/domain` holds the pure ranking and curation arithmetic, and its barrel is type-only where it names a contracts type so its build output imports nothing but `effect` (`packages/domain/src/index.ts:1-3`). `retention.ts` is the eight-signal retention scorer and its triage bands, with the SQL phase gathering raw inputs and calling into it (`packages/domain/src/retention.ts:4-5`). Most of the package ports rules rather than designing them. `retention.ts`, `decay.ts`, and `merge.ts` port the predecessor memory system's rules (`packages/domain/src/retention.ts:4-5`, `packages/domain/src/decay.ts:15-16`, `packages/domain/src/merge.ts:2-3`). `frame.ts` carries the claim-slot grammar ported verbatim from the eval harness, where the rule was measured before it was adopted (`packages/domain/src/frame.ts:2`, `packages/domain/src/frame.ts:9-12`). The fence-language detector `detect.ts` in `@memhtml/html` follows the same measured-port pattern (`packages/html/src/detect.ts:2-6`). `graph.ts` must return the same result for the same input, because PageRank and community scores feed retention signals, and a run-to-run reordering would change which memories get evicted from an unchanged corpus (`packages/domain/src/graph.ts:5-7`).

- `packages/domain/src/merge.ts` (398 LOC)
- `packages/domain/src/retention.ts` (353 LOC)
- `packages/domain/src/graph.ts` (257 LOC)
- `packages/domain/src/neighbors.ts` (195 LOC)
- `packages/domain/src/decay.ts` (150 LOC)
- `packages/domain/src/rrf.ts` (87 LOC)
- `packages/domain/src/frame.ts` (78 LOC)
- `packages/domain/src/cosine.ts` (73 LOC)
- `packages/domain/src/ranking.ts` (30 LOC)

## packages/contracts

`@memhtml/contracts` sits at the root of the dependency graph. It declares no `@memhtml/*` dependency of its own (`packages/contracts/package.json:56-58`). Twelve of the thirteen other workspace packages this map covers depend on it, all but `@memhtml/telemetry`, and the `tests-integration` harness depends on it too (`packages/telemetry/package.json:25-27`, `tests-integration/package.json:14`). It owns the closed vocabularies every other module restates in SQL rather than in a second TypeScript copy: ten memory types, four PARA buckets, four non-mixing edge classes, and the memory and task relation sets (`packages/contracts/src/types.ts:18`, `packages/contracts/src/types.ts:63`, `packages/contracts/src/edges.ts:9`, `packages/contracts/src/edges.ts:19`, `packages/contracts/src/edges.ts:54`). `paths.ts` holds the path algebra, and every path it produces is the root-relative git-tree form with no leading slash (`packages/contracts/src/paths.ts:4-6`). A path is the memory's identity, and there is no uuid anywhere in the system, so the slug rules in `slug.ts` have to keep a slug stable, readable, and safe on a filesystem (`packages/contracts/src/slug.ts:2-4`).

- `packages/contracts/src/paths.ts` (234 LOC)
- `packages/contracts/src/types.ts` (184 LOC)
- `packages/contracts/src/edges.ts` (149 LOC)
- `packages/contracts/src/slug.ts` (108 LOC)
- `packages/contracts/src/errors.ts` (64 LOC)

## Supporting code

These are the workspace packages without a section of their own (`@memhtml/llm`, `@memhtml/traces`, `@memhtml/eval`, `@memhtml/integrations`, `@memhtml/telemetry`, and `apps/consolidator`), followed by the integration tests and the repository scripts.

- `packages/llm/src/wire.ts` (370 LOC)
- `packages/llm/src/proxy.ts` (283 LOC)
- `packages/llm/src/model-client.ts` (262 LOC)
- `packages/llm/src/embeddings.ts` (177 LOC)
- `packages/traces/src/extract.ts` (437 LOC)
- `packages/traces/src/scan.ts` (248 LOC)
- `packages/traces/src/discover.ts` (212 LOC)
- `packages/traces/src/watermark.ts` (97 LOC)
- `packages/eval/src/corpus.ts` (1106 LOC)
- `packages/eval/src/write-path-corpus.ts` (743 LOC)
- `packages/eval/src/write-path-acceptance-corpus.ts` (484 LOC)
- `packages/eval/src/discriminate.ts` (295 LOC)
- `packages/eval/src/harness.ts` (258 LOC)
- `packages/eval/src/controls.ts` (198 LOC)
- `packages/integrations/src/install.ts` (909 LOC)
- `packages/integrations/src/doctor.ts` (601 LOC)
- `packages/integrations/src/adapters/json.ts` (393 LOC)
- `packages/telemetry/src/index.ts` (129 LOC)
- `apps/consolidator/src/contract.ts` (931 LOC)
- `apps/consolidator/src/client.ts` (690 LOC)
- `apps/consolidator/src/mount.ts` (363 LOC)
- `tests-integration/tests/batch.test.ts` (912 LOC)
- `tests-integration/tests/tasks.test.ts` (778 LOC)
- `tests-integration/tests/sleep.test.ts` (401 LOC)
- `tests-integration/tests/harness.ts` (200 LOC)
- `scripts/smoke-package.mjs` (1293 LOC)
- `scripts/probe-sandbox-egress.mjs` (165 LOC)
- `scripts/readme-figures.mjs` (107 LOC)
- `scripts/probe-sqlite-concurrency.mjs` (86 LOC)

## See also

Counts are the distinct existing non-docs source paths cited in inline backticks on both pages, measured against the tree at 3b2a068.

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 59 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 52 shared source citations
- [memhtml-public · Business logic](../insights/business-logic.md): 45 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 32 shared source citations
- [memhtml-public · Tech debt](../insights/tech-debt.md): 26 shared source citations
- [memhtml-public · Debugging guide](../insights/debugging-guide.md): 26 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 22 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 16 shared source citations

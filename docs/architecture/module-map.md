# memhtml-public · Module map

This repository is the software that manages a memory root, a separate git repository located by `$MEMHTML_ROOT` (`AGENTS.md:435`). No memory lives here. The modules below are a pnpm workspace of nine libraries under `packages/` and four executables under `apps/`, declared in `pnpm-workspace.yaml:1`. Modules are ordered by size and by position in the dependency graph, with the two agent-facing surfaces first. The `apps/docs` package is out of scope for this map.

## apps/cli

`apps/cli` builds the `memhtml` binary declared at `apps/cli/package.json:8`. It is also the composition root, and the MCP server imports it instead of building its own (`apps/cli/src/index.ts:2`). Every command an agent calls writes exactly one JSON envelope to stdout, whose `apiVersion`, `type`, and `code` fields are append-only discriminators an agent branches on (`apps/cli/src/envelope.ts:2`, `apps/cli/src/envelope.ts:12`, `apps/cli/src/envelope.ts:67`). Exit code 0 is success, 2 is a usage error the agent fixes by changing the call, and 1 is a runtime failure it fixes by changing the root or the environment (`apps/cli/src/envelope.ts:88`). The command table in `commands.ts` is the one machine-readable description of that surface. `memhtml manifest` serves it, and `memhtml agents-doc` regenerates `AGENTS.md` from it (`apps/cli/src/commands.ts:111`, `AGENTS.md:1`).

- `apps/cli/src/operations.ts` (1805 LOC)
- `apps/cli/src/commands.ts` (1048 LOC)
- `apps/cli/src/run.ts` (1039 LOC)
- `apps/cli/src/api-layer.ts` (569 LOC)
- `apps/cli/src/exec.ts` (534 LOC)
- `apps/cli/src/doctor.ts` (520 LOC)
- `apps/cli/src/apply.ts` (399 LOC)
- `apps/cli/src/envelope.ts` (157 LOC)

## packages/index

`@memhtml/index` owns the rebuildable SQLite plane over the root: schema, migrations, the git-driven indexer, and four-arm retrieval (`packages/index/package.json:6`). The root's `.memhtml/index.db` is a projection of the root's git tree and can be deleted and rebuilt without loss, while `state.db` is ATTACHed over the same connection and holds the one set of facts git cannot reproduce (`packages/index/src/index.ts:2`). The indexer reads the tree through a read-only port that it declares itself rather than importing the store. The indexer therefore cannot commit, which keeps "rebuildable from git" non-circular (`packages/index/src/git-port.ts:5`). Retrieval fuses four ranked arms named `fts`, `vector`, `recency`, and `salience` with reciprocal rank fusion, and drops the vector arm to a lexical floor when no embedding is available (`packages/index/src/retrieval-sql.ts:115`, `packages/index/src/retrieval-sql.ts:140`, `packages/index/src/retrieval-sql.ts:164`, `packages/index/src/retrieval-sql.ts:222`, `packages/index/src/retrieval-sql.ts:6`).

- `packages/index/src/indexer.ts` (699 LOC)
- `packages/index/src/retrieval.ts` (484 LOC)
- `packages/index/src/traces-persist.ts` (478 LOC)
- `packages/index/src/database.ts` (407 LOC)
- `packages/index/src/project.ts` (391 LOC)
- `packages/index/src/retrieval-sql.ts` (340 LOC)
- `packages/index/src/scope.ts` (186 LOC)
- `packages/index/src/schema-const.ts` (85 LOC)

## packages/sleep

`@memhtml/sleep` runs the curation cycle over the root as one git commit per committing phase on a `sleep/<date>` branch (`packages/sleep/src/index.ts:2`). The phase names, their execution order, and their prerequisite graph live in one contract module, and the commit trailer, the `sleep_phases` row, and the `--phases` flag all read a phase name from there (`SLEEP_PHASES` at `packages/sleep/src/contract.ts:43` — seventeen phases as of v0.6.0; `HARD_PREREQUISITES` at `packages/sleep/src/contract.ts:107`). Two of the seventeen commit nothing by construction, `preflight` and `relationship-mining` (`NON_COMMITTING_PHASES`, `packages/sleep/src/contract.ts:197`), so a full run lands fifteen commits at most — count from the enum rather than from this sentence, since a new phase moves both numbers. Each commit carries a `Memhtml-Run` / `Memhtml-Phase` / `Memhtml-Counts` trailer block written in exactly one place. `memhtml sleep resume` reads those trailers out of the branch's git log to decide what a run already did, so the git log rather than a journal table is the record of progress (`packages/sleep/src/commit.ts:10`). The package constructs none of its own services. Every dependency arrives as a caller-supplied shape, so a test can point a run at a temp-dir git repo (`packages/sleep/src/env.ts:10`).

- `packages/sleep/src/sql.ts` (835 LOC)
- `packages/sleep/src/phases/trace-consolidation.ts` (682 LOC)
- `packages/sleep/src/run.ts` (445 LOC)
- `packages/sleep/src/review.ts` (302 LOC)
- `packages/sleep/src/edits.ts` (228 LOC)
- `packages/sleep/src/publish.ts` (171 LOC)
- `packages/sleep/src/contract.ts` (170 LOC)
- `packages/sleep/src/env.ts` (113 LOC)

## packages/store

`@memhtml/store` is the git-backed file store and the only writer to the root. Every operation that changes the corpus is one commit, and every git failure is a typed value (`packages/store/src/index.ts:2`). The tree is the system of record and the index is derived from it, so an operation that changed a file without committing would leave the index describing a state git does not have (`packages/store/src/index.ts:2`). Git's `-z` plumbing formats are parsed by pure total functions in `plumbing.ts`, pinned against captured bytes so that a truncated stream from a killed subprocess is a tested case (`packages/store/src/plumbing.ts:2`). `layout.ts` holds the scaffold `memhtml init` writes, including the PARA directories and the `merge=ours` driver registration. Creating a root is always an explicit step, so a typo in `MEMHTML_ROOT` is an error and does not produce a second empty root (`packages/store/src/layout.ts:41`, `packages/store/src/layout.ts:76`, `packages/store/src/layout.ts:15`).

- `packages/store/src/store.ts` (1138 LOC)
- `packages/store/src/plumbing.ts` (398 LOC)
- `packages/store/src/git.ts` (385 LOC)
- `packages/store/src/layout.ts` (211 LOC)
- `packages/store/src/testing.ts` (113 LOC)
- `packages/store/src/index.ts` (91 LOC)

## packages/html

`@memhtml/html` is the only implementation of the memory file format. It parses, serializes, and hashes a file, and it holds the head editors that change one field at a time (`packages/html/src/index.ts:2`). The format is semantic HTML5 over a closed vocabulary, and `vocabulary.ts` states that vocabulary as data, so the policy is a list of element and metadata names (`packages/html/src/vocabulary.ts:2`, `packages/html/src/vocabulary.ts:150`, `packages/html/src/vocabulary.ts:252`). `constraints.ts` is the format check the store runs before it writes anything, so a rejected write leaves the tree byte-identical (`packages/html/src/constraints.ts:351`, `AGENTS.md:62`). The `sha256` content hash over the normalized text of `<article>` is the dedup key. It does not change when a head edit changes metadata, so editing metadata does not register as new content (`packages/html/src/hash.ts:8`, `packages/html/src/hash.ts:19`).

- `packages/html/src/constraints.ts` (370 LOC)
- `packages/html/src/parse.ts` (363 LOC)
- `packages/html/src/editors.ts` (269 LOC)
- `packages/html/src/vocabulary.ts` (255 LOC)
- `packages/html/src/document.ts` (209 LOC)
- `packages/html/src/template.ts` (204 LOC)
- `packages/html/src/hash.ts` (185 LOC)
- `packages/html/src/tree.ts` (118 LOC)

## apps/mcp

`apps/mcp` builds the `memhtml-mcp` stdio server declared at `apps/mcp/package.json:8`, exposing fifteen tools and three resources over the same root the CLI reads (`apps/mcp/src/index.ts:2`). It imports `layerApp` from `apps/cli` rather than composing its own service graph, so both agent surfaces resolve to exactly one database file, one git root, and one vector space (`apps/mcp/src/server.ts:1`, `apps/cli/src/index.ts:2`). Sleep is left off the tool surface on purpose, because a run rewrites confidence across the corpus and creates a branch a human is expected to read. `memhtml sleep run` is its only entry point, and no tool fires it (`apps/mcp/src/index.ts:2`). `failure.ts` declares one wire error class whose message survives the MCP framework's rewrite of generic tool failures, so the agent reads the message the tool wrote (`apps/mcp/src/failure.ts:5`).

- `apps/mcp/src/tools.ts` (801 LOC)
- `apps/mcp/src/handlers.ts` (769 LOC)
- `apps/mcp/src/failure.ts` (219 LOC)
- `apps/mcp/src/resources.ts` (90 LOC)
- `apps/mcp/src/server.ts` (54 LOC)
- `apps/mcp/src/bin.ts` (15 LOC)

## packages/domain

`@memhtml/domain` holds the pure ranking and curation arithmetic, and its barrel is type-only where it names a contracts type so its build output imports nothing but `effect` (`packages/domain/src/index.ts:2`). `retention.ts` is the eight-signal retention scorer and its triage bands, with the SQL phase gathering raw inputs and calling into it (`packages/domain/src/retention.ts:4`). Several modules port rules that were measured in the eval harness before being adopted here. `frame.ts` carries the claim-slot grammar ported verbatim from that harness, and `detect`'s sibling decisions follow the same pattern (`packages/domain/src/frame.ts:2`, `packages/domain/src/frame.ts:11`). `graph.ts` must return the same result for the same input, because PageRank and community scores feed retention signals, and a run-to-run reordering would change which memories get evicted from an unchanged corpus (`packages/domain/src/graph.ts:5`).

- `packages/domain/src/retention.ts` (348 LOC)
- `packages/domain/src/graph.ts` (257 LOC)
- `packages/domain/src/merge.ts` (241 LOC)
- `packages/domain/src/decay.ts` (139 LOC)
- `packages/domain/src/rrf.ts` (85 LOC)
- `packages/domain/src/frame.ts` (77 LOC)
- `packages/domain/src/cosine.ts` (64 LOC)
- `packages/domain/src/ranking.ts` (30 LOC)

## packages/contracts

`@memhtml/contracts` sits at the root of the dependency graph. It declares no `@memhtml/*` dependency of its own, and twelve other workspace packages depend on it (`packages/contracts/package.json:6`). It owns the closed vocabularies every other module restates in SQL rather than in a second TypeScript copy: ten memory types, four PARA buckets, four non-mixing edge classes, and the memory and task relation sets (`packages/contracts/src/types.ts:18`, `packages/contracts/src/types.ts:63`, `packages/contracts/src/edges.ts:9`, `packages/contracts/src/edges.ts:19`). `paths.ts` holds the path algebra, and every path it produces is the root-relative git-tree form with no leading slash (`packages/contracts/src/paths.ts:5`). A path is the memory's identity, and there is no uuid anywhere in the system, so the slug rules in `slug.ts` have to keep a slug stable, readable, and safe on a filesystem (`packages/contracts/src/slug.ts:2`).

- `packages/contracts/src/paths.ts` (186 LOC)
- `packages/contracts/src/edges.ts` (149 LOC)
- `packages/contracts/src/types.ts` (130 LOC)
- `packages/contracts/src/slug.ts` (90 LOC)
- `packages/contracts/src/errors.ts` (64 LOC)

## Supporting code

- `packages/llm/src/embeddings.ts` (176 LOC)
- `packages/llm/src/model-client.ts` (165 LOC)
- `packages/llm/src/wire.ts` (140 LOC)
- `packages/traces/src/extract.ts` (437 LOC)
- `packages/traces/src/discover.ts` (212 LOC)
- `packages/traces/src/scan.ts` (192 LOC)
- `packages/traces/src/watermark.ts` (97 LOC)
- `packages/eval/src/corpus.ts` (1035 LOC)
- `packages/eval/src/discriminate.ts` (294 LOC)
- `packages/eval/src/harness.ts` (239 LOC)
- `packages/eval/src/controls.ts` (198 LOC)
- `apps/consolidator/src/client.ts` (1123 LOC)
- `apps/consolidator/src/contract.ts` (443 LOC)
- `apps/consolidator/src/mount.ts` (279 LOC)
- `apps/consolidator/src/run-auth.ts` (231 LOC)
- `tests-integration/tests/harness.ts` (198 LOC)
- `tests-integration/tests/sleep.test.ts` (324 LOC)
- `scripts/probe-sqlite-concurrency.mjs` (86 LOC)
- `scripts/readme-figures.mjs` (104 LOC)

## See also

- [memhtml-public · Impact analysis](../insights/impact-analysis.md): 6 shared source citations
- [memhtml-public · Dependency graph](../diagrams/structural/dependency-graph.md): 5 shared source citations
- [memhtml-public · Contract map](../insights/contract-map.md): 5 shared source citations
- [memhtml-public · System overview](../architecture/system-overview.md): 4 shared source citations
- [memhtml-public · CLI](../reference/cli.md): 4 shared source citations

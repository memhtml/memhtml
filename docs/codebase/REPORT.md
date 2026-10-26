---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Report

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

memhtml is a git-backed long-term memory store for coding agents, and one human author built it between 2026-08-11 and 2026-10-26. Its risk sits in the CLI's command layer, in the CLI and MCP doors that restate each other by hand, and in a release packager that keeps two copies of one list.

## What it is

memhtml stores each fact as one semantic HTML5 file in a git repository, keeps a rebuildable SQLite index over that tree, and fuses four ranking arms for retrieval (`README.md:5`). Agents and people reach it through two binaries. The `memhtml` CLI runs one command per process and writes a single JSON envelope to stdout before it exits (`apps/cli/src/bin.ts:5`, `apps/cli/src/bin.ts:22`). The `memhtml-mcp` server launches a stdio MCP layer that lives as long as the process (`apps/mcp/src/bin.ts:15`). The CLI's surface is the `COMMANDS` table (`apps/cli/src/commands.ts:186`), and the MCP surface is the `Tool.make` toolkit in `apps/mcp/src/tools.ts`.

Both doors share one service graph. `layerApp` composes it (`apps/cli/src/api-layer.ts:409`), and the MCP server provides that same layer under its toolkit (`apps/mcp/src/server.ts:53`). Underneath, `packages/contracts` holds the schemas, errors and path rules every other package imports (`packages/contracts/src/index.ts:1-9`). `packages/store` writes files through git, and `packages/index` projects the tree into SQLite through `node:sqlite` (`packages/index/src/database.ts:4`). `head`, `session` and `curator` hold the corpus as an immutable value per commit, log a session's edits and run the curation loop (`packages/head/src/index.ts:1-5`, `packages/session/src/index.ts:1-4`). The whole stack runs on Effect, pinned at `4.0.5` as one set (`pnpm-workspace.yaml:64-68`). More in the [system overview](architecture/system-overview.md), the [module map](architecture/module-map.md), [data flow](architecture/data-flow.md), [processes](behavior/processes.md), [components](diagrams/architecture/components.md) and the [dependency graph](diagrams/structural/dependency-graph.md).

## How it got here

The history holds 302 commits from 2026-08-11 to 2026-10-26 once 48 bot commits and 8 bulk sweeps are set aside, and git itself counts 401 non-merge commits over the same range. The first era opened with `1bc2a6d` and moved the index onto `node:sqlite` in `2ab82f4`. A quieter stretch of dependency moves and documentation fixes followed. `946eed5` closed the middle era on 2026-10-18: it moved the corpus onto an immutable head, routed writes through sessions, put curation on a branch and folded the removed consolidator app into `apps/cli`. The last era is the two weeks after it. In that era, `329067a` landed the Effect catalog on its 4.0.5 release.

One human author last touched every surviving line apart from release and dependency-pin stamps, so the truck factor is 1 for the repository and for every top-level directory (blame at this commit). The median surviving line is 61 days old. More in [how the code got here](history/evolution.md) and [ownership](analysis/ownership.md).

## Where the risk is

The defect magnets cluster in the CLI's command layer. In `apps/cli/src/run.ts`, `dispatch` is one `switch` over every parsed command (`apps/cli/src/run.ts:363-366`). It has ccn 83, and 4 fix commits have reworked flag parsing and per-command validation around it. `apps/cli/src/operations.ts` collects fixes for unrelated bugs, 6 fix commits in 3 episodes. One reason it's fragile: `batchWrite` has to keep each op's result at its original index through both the decode fold and the store fold (`apps/cli/src/operations.ts:751`). The MCP batch handler maps surviving ops back to their original indices through `originOf` (`apps/mcp/src/handlers.ts:449`), and its anonymous handler body has ccn 26. In the indexer, one failed rename can fail every later pass until a rebuild (`packages/index/src/indexer.ts:764-766`), and the file's evidence shows 2 fix commits there. The store's git wrapper fails at subprocess edges, and the package smoke script breaks when its environment shifts. CI does run that script, as a separate job outside `check` (`.github/workflows/check.yml:79`, `package.json:25-27`).

Two pairs of files change together with nothing in the code tying them. The packager's `WORKSPACE_PACKAGES` list in `scripts/package-manifest.mjs:23-40` and the bundler's list in `tsdown.config.ts:36-53` must name the same packages. The CLI help text and the MCP tool contract restate the same write rules by hand (`apps/cli/src/commands.ts:2009-2015`, `apps/mcp/src/tools.ts:158-163`). One function is outside every test tier that `check` runs: `spawnVersion`, the real version probe behind `memhtml integrations doctor` (`packages/integrations/src/doctor.ts:105`).

More in [risk hotspots](analysis/risk-hotspots.md), [hidden coupling](insights/hidden-coupling.md), [test blind spots](analysis/test-blind-spots.md), [architecture drift](analysis/architecture-drift.md), [security surface](analysis/security-surface.md), [implicit knowledge](insights/implicit-knowledge.md), [impact analysis](insights/impact-analysis.md) and the [debugging guide](insights/debugging-guide.md).

## Five things to fix first

1. **Check the packager's package list against the bundler's.** `tests-integration/tests/packaging.test.ts:209-217` compares the `tsdown.config.ts` list with its own `BUNDLED_PACKAGES` copy. Nothing compares the list in `scripts/package-manifest.mjs`, and that list decides which dependencies the published manifest declares. This drift is silent. A wrong external set once took `memhtml-mcp.mjs` from 192 kB to 1.45 MB with no warning (`tsdown.config.ts:55-66`). Cost: one assertion in `tests-integration/tests/packaging.test.ts` that parses the manifest list the way `:211` parses the tsdown list, or one shared module that both files import. The integration tier and `package:smoke` have to pass.
2. **Test the real `spawnVersion` probe.** Every doctor test injects fake probes (`packages/integrations/tests/doctor.test.ts:88`), but `DEFAULT_PROBES` wires the real one (`packages/integrations/src/doctor.ts:245`). As a result, only the package smoke, which `check` doesn't run, reaches its success path (`scripts/smoke-package.mjs:548`), and nothing reaches its timeout or JSON-parse failure paths. Cost: one test file in `packages/integrations/tests` that runs the probe against a stub executable. The package's vitest suite has to pass.
3. **Give each cross-door write rule one owner.** The block-tag refusal is written once in `apps/cli/src/commands.ts:2009-2015` and again in `ARTICLE_HTML_CONTRACT` (`apps/mcp/src/tools.ts:158-163`), and changes to one have been copied into the other by hand. The existing description test checks wording only inside the MCP toolkit (`apps/mcp/tests/tools.test.ts:162-185`). Cost: shared wording constants in `packages/contracts` that both `COMMANDS` and the `Tool.make` descriptions interpolate, then regenerating `AGENTS.md`. The CLI, MCP and `mcp-stdio` integration tests have to pass.
4. **Remove the stale Effect version notes.** The catalog pins `4.0.5` (`pnpm-workspace.yaml:64-68`), but `CLAUDE.md:90` still says "Effect 4.0.0-rc.109 differs from recall". The MCP server comment says it was verified against `4.0.0-rc.109` (`apps/mcp/src/server.ts:28`), and the backlog names beta.107 and rc.109 (`docs/backlog.md:73`). Each file's last commit, `946eed5`, `64840f8` and `3406f70`, left those lines in place. Cost: re-verify the `instructions` claim against the installed effect and edit three files. `lint:md` (`dprint check`, `package.json:18`) and `lint:repo` (`biome check .`, `package.json:15`) have to pass.
5. **Split `dispatch` before the next new command.** Every command goes through one `switch` in `apps/cli/src/run.ts:363-366`, which has ccn 83 and the file's history of flag-parsing fixes. Cost: move each arm into a per-command handler next to its `COMMANDS` entry. This touches `apps/cli/src/run.ts` and `apps/cli/src/commands.ts`, and `apps/cli/tests/cli.test.ts` and the full integration tier have to pass.

## See also

- [system overview](architecture/system-overview.md): 12 shared source citations
- [processes](behavior/processes.md): 9 shared source citations
- [data flow](architecture/data-flow.md): 8 shared source citations
- [module map](architecture/module-map.md): 8 shared source citations
- [components](diagrams/architecture/components.md): 8 shared source citations

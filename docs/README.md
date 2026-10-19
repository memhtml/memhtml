# memhtml-public · Documentation tree

The primary consumer of memhtml is a coding agent. The CLI answers with typed JSON envelopes and fixed exit codes, `memhtml manifest` describes the whole surface on a machine with no repo or database, and the MCP server exposes the same operations as tools.

This repository stores no memory. It is the software that manages an external `memhtml root` directory, located by `$MEMHTML_ROOT`. memhtml manages that root with git, so the root's git tree is the system of record, and `.memhtml/index.db` inside it is a projection that can be deleted and rebuilt without loss.

The `apps/docs` Astro package is excluded from this tree by request. Most pages end with a `See also` list of the other pages that cite the same source lines.

## Architecture

These pages describe what the system is and how its parts connect.

- [System overview](architecture/system-overview.md): narrative, stack table, and the top-level component diagram.
- [Module map](architecture/module-map.md): one section per workspace package with its key files.
- [Data flow](architecture/data-flow.md): five paths step by step: a v1 write, ranked retrieval, an MCP tool call, a write through a session, and a search on the head.
- [Design](design.md): every architectural decision with its evidence, from the file format to the head, sessions, the head server, curation, and the decision records in §24.

## Reference

These pages list the calls an agent can make and the shape each one returns.

- [CLI](reference/cli.md): every subcommand of the `memhtml` binary, with flags, error codes, and environment variables. The set is the `COMMANDS` array, which also generates `AGENTS.md`, so read it from `apps/cli/src/commands.ts` rather than counting it here.
- [RPC tools](reference/rpc-tools.md): the 15 MCP tools and 2 resources of `memhtml-mcp`.
- [Public API](reference/public-api.md): the 32 most-imported library symbols, the top 30 plus every symbol tied at the cutoff, with verbatim declarations.

## Behavior

These pages trace what runs when a given event arrives.

- [Processes](behavior/processes.md): nineteen main flows, from a CLI invocation through the session, head server, and curation flows, plus a minor-flow index.
- [State machines](behavior/state-machines.md): memory status, task status, host-integration install state, the session log and its pending commit, the head server's lifecycle, and a `curate merge` landing.

## Diagrams

- [Components](diagrams/architecture/components.md): the MCP toolkit and the nine Effect services at the center of the app layer, with the edge each takes on another, as a class diagram. `MemhtmlToolkit` is a `Toolkit.make`; each service is a `Context.Service` tag.
- [Dependency graph](diagrams/structural/dependency-graph.md): internal packages and external dependencies on one page.
- [Sequences](diagrams/behavioral/sequences.md): call order for a v1 write, a search, a session commit, a search on the head, and a curation run landed by `curate merge`.

## Insights

These pages cover the assumptions the codebase makes, the ways it fails, and the parts that are expensive to change.

- [Impact analysis](insights/impact-analysis.md): the sixteen surfaces whose change reaches multiple packages, and what each change touches.
- [Debugging guide](insights/debugging-guide.md): failure-mode index, error surfaces, and a cheapest-first checks ladder.
- [Contract map](insights/contract-map.md): what each module assumes about its neighbors, including the contracts SQL restates.
- [Business logic](insights/business-logic.md): the validations, invariants, calculations, and policies memhtml enforces on a root.
- [Tech debt](insights/tech-debt.md): a ranked register built from the repo's own ledgers, with cost of removal.

## Omissions

`analysis/risk-hotspots.md`, `analysis/ownership.md`, and `analysis/dead-code.md` are intentionally not generated. The git history carries one human author beside Dependabot, release-please, and the agent that writes under `memhtml-agent`, so per-file activity and ownership signals distinguish nothing an ordinary `git log` does not, and no dead-code analysis tool is configured in the repo. Re-derive the numbers from `git log` rather than reading them here; a count committed to prose is stale by the next commit.

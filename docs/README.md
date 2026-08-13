# memhtml-public · Documentation tree

The primary consumer of memhtml is a coding agent. The CLI answers with typed JSON envelopes and fixed exit codes, `memhtml manifest` describes the whole surface on a machine with no repo or database, and the MCP server exposes the same operations as tools.

This repository stores no memory. It is the software that manages an external `memhtml root` directory, located by `$MEMHTML_ROOT`. memhtml manages that root with git, so the root's git tree is the system of record, and `.memhtml/index.db` inside it is a projection that can be deleted and rebuilt without loss.

The `apps/docs` Astro package is excluded from this tree by request. Most pages end with a `See also` list of the other pages that cite the same source lines.

## Architecture

These pages describe what the system is and how its parts connect.

- [System overview](architecture/system-overview.md): narrative, stack table, and the top-level component diagram.
- [Module map](architecture/module-map.md): one section per workspace package with its key files.
- [Data flow](architecture/data-flow.md): the write, search, and MCP tool-call paths, step by step.

## Reference

These pages list the calls an agent can make and the shape each one returns.

- [CLI](reference/cli.md): all 36 subcommands of the `memhtml` binary, with flags, error codes, and environment variables.
- [RPC tools](reference/rpc-tools.md): the 14 MCP tools and 2 resources of `memhtml-mcp`.
- [Public API](reference/public-api.md): the 30 most-imported library symbols with verbatim signatures.

## Behavior

These pages trace what runs when a given event arrives.

- [Processes](behavior/processes.md): the eight main flows plus a minor-flow index.
- [State machines](behavior/state-machines.md): memory status, sleep-run status, and task status.

## Diagrams

- [Components](diagrams/architecture/components.md): the eight Effect service tags and their edges, as a class diagram.
- [Dependency graph](diagrams/structural/dependency-graph.md): internal packages and external dependencies on one page.
- [Sequences](diagrams/behavioral/sequences.md): call order for write, search, and a sleep run.

## Insights

These pages cover the assumptions the codebase makes, the ways it fails, and the parts that are expensive to change.

- [Impact analysis](insights/impact-analysis.md): the eight surfaces whose change reaches multiple packages, and what each change touches.
- [Debugging guide](insights/debugging-guide.md): failure-mode index, error surfaces, and a cheapest-first checks ladder.
- [Contract map](insights/contract-map.md): what each module assumes about its neighbors, including the contracts SQL restates.
- [Business logic](insights/business-logic.md): the validations, invariants, calculations, and policies memhtml enforces on a root.
- [Tech debt](insights/tech-debt.md): a ranked register built from the repo's own ledgers, with cost of removal.

## Omissions

`analysis/risk-hotspots.md`, `analysis/ownership.md`, and `analysis/dead-code.md` were intentionally not generated. The git history spans four days with one author, so activity and ownership signals carry no information, and no dead-code analysis tool is configured in the repo.

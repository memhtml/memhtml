# Documentation

The pages under `docs/` come in three kinds, and each kind has one owner: a person writes the first, the code generates the second, and a tool regenerates the third at a commit it names.

## Written by hand

These pages explain what the code does and why. They cite code by symbol, as `path::Symbol` or `path::Outer::inner`, never by line, and `mise run docs:citations` fails when a cited file no longer declares the symbol.

- [Design](design.md): every architectural decision, with the symbol that implements it.
- [Format](format.md): the memory file format, its closed vocabulary, and what the index reads from each element.
- [Tasks](tasks.md): the task memory type, its status and deadline metas, and the task graph.
- [Code mode](code-mode.md): reading the store with an HTML parser instead of a chain of tool calls.
- [Backlog](backlog.md): the ranked ledger of open work, each item with its evidence.
- [Bugs](bugs/): dated bug reports, kept as written.
- [RFCs](rfcs/): proposals, frozen once decided.

## Generated from the code

Reference material is generated from the source of truth, so it cannot drift from it.

- The CLI: [`AGENTS.md`](../AGENTS.md), which `mise run agents-doc` generates from the `COMMANDS` table in `apps/cli/src/commands.ts`, and `memhtml manifest`, which prints the same contract from the binary.
- The MCP server: [`docs/reference/mcp-tools.md`](reference/mcp-tools.md), the tools and resource templates of `memhtml-mcp`.
- The library: the [API pages](https://memhtml.github.io/api/) of the docs site, which TypeDoc generates from each package's TSDoc at build time.

## Analysis

[`docs/codebase/`](codebase/README.md) is the analysis tree: architecture, behavior, diagrams, insights, analysis and history. A tool generates it against one commit and stamps each page with that commit, so its line citations are true for the commit they describe. Regenerate it rather than editing it by hand.

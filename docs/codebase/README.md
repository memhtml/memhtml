---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Codebase analysis

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

These pages describe the code at one commit: what the system is, how it got its shape, where it's fragile, and what it assumes. An automated analysis collected the inputs (git history and blame, the module import graph, test coverage and scanner output). Model reviewers then confirmed or rejected each candidate finding against the code, and model writers wrote each page from the code and the confirmed findings. Pages present only confirmed findings.

A line citation such as `apps/cli/src/run.ts:363` is true for the commit above and goes stale as the code moves, so the tree is regenerated as a whole rather than edited by hand. The hand-written docs elsewhere in `docs/` cite code by symbol, and `mise run docs:citations` checks those citations on every change.

Start with the [report](REPORT.md): what the system is, how it got here, where the risk is, and five things to fix first.

## Architecture

- [System overview](architecture/system-overview.md): What is this system, and how do its parts fit?
- [Module map](architecture/module-map.md): What are the modules, and what's inside each?
- [Data flow](architecture/data-flow.md): How does data move through the system?

## Behavior

- [Processes](behavior/processes.md): When the system runs something, what happens?
- [State machines](behavior/state-machines.md): What states does each entity move through?

## Diagrams

- [Components](diagrams/architecture/components.md): What are the components, and how do they relate?
- [Dependency graph](diagrams/structural/dependency-graph.md): Which modules depend on which, inside and outside the repository?
- [Sequences](diagrams/behavioral/sequences.md): In what order do the main processes call each other?

## Analysis

- [Risk hotspots](analysis/risk-hotspots.md): Where do bugs cluster, and where is a change risky?
- [Ownership](analysis/ownership.md): Who knows which code?
- [Test blind spots](analysis/test-blind-spots.md): Which important code does no test reach?
- [Architecture drift](analysis/architecture-drift.md): Does the code follow the structure the repository declares?
- [Security surface](analysis/security-surface.md): What flagged code can an outside caller reach?

## History

- [How the code got here](history/evolution.md): How did the code get to its current shape?

## Insights

- [Hidden coupling](insights/hidden-coupling.md): Which files have to change together, though nothing ties them?
- [Implicit knowledge](insights/implicit-knowledge.md): What does the code assume without saying?
- [Contract map](insights/contract-map.md): What does each module assume about the others?
- [Business logic](insights/business-logic.md): What rules does this codebase enforce?
- [Tech debt](insights/tech-debt.md): Where is the debt, and what does it cost?
- [Impact analysis](insights/impact-analysis.md): If I change something, what breaks?
- [Debugging guide](insights/debugging-guide.md): When something breaks, where do I look?

## Terms

- ccn: the cyclomatic complexity of a function, the number of independent paths through it.
- nloc: lines of code, not counting comments and blank lines.
- Ca and Ce: a module's afferent coupling (how many modules depend on it) and efferent coupling (how many it depends on).
- Bulk commits: commits that changed more than 30 code files at once, such as a move or a formatting sweep. Commit counts on these pages leave them and bot commits out.
- `codegraph`: the open-source [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph) CLI, which some pages suggest for tracing callers before a change.

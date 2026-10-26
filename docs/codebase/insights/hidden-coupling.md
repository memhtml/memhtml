---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Hidden coupling

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

Two pairs of files have to change together with nothing in the code tying them: the release packager's two copies of the shipped-package list, and the CLI and MCP descriptions of the same write rules. The analysis measured pairs of files that keep landing in the same commits and classed each pair as linked (one imports the other), explained (one file that both import, or that wires both, took part in at least half of their shared commits) or hidden (neither). Reviewers confirmed two hidden-coupling candidates and no logical-module or shotgun-surgery candidate.

## Lockstep pairs

| Files                                               | Shared commits | The rule                                                                                                  |
| --------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| `scripts/package-manifest.mjs`, `tsdown.config.ts`  | 5              | A package added to or removed from the bundle goes into both `WORKSPACE_PACKAGES` lists.                  |
| `apps/cli/src/commands.ts`, `apps/mcp/src/tools.ts` | 12             | A write rule stated in a CLI command or flag description is restated by hand in the MCP tool description. |

### `scripts/package-manifest.mjs` and `tsdown.config.ts`

**The rule:** the list at `scripts/package-manifest.mjs:23-40` and the list at `tsdown.config.ts:36-53` have to name the same packages, because the first decides which dependencies the published `package.json` declares (`scripts/package-manifest.mjs:62-75`) and the second decides which dependencies the bundle leaves external (`tsdown.config.ts:67-76`).

**Evidence:** the two files changed together in 5 commits over 3 weeks, and neither imports the other. The first of those commits, `e0e516f`, created both lists, so it shows nothing about the rule. Commit `38767253f4` shows it: adding `@memhtml/telemetry` put one identical `"packages/telemetry"` line into each list, and its message names the "tsdown workspace list" among the places every new package has to reach (`git show 38767253f4`). The drift is silent: the comment above `externalDependencies` records that a wrong external set took `memhtml-mcp.mjs` from 192 kB to 1.45 MB with no warning (`tsdown.config.ts:55-66`).

**Other partners:** the co-change histories of `scripts/package-manifest.mjs` and `tsdown.config.ts` both include `tests-integration/tests/packaging.test.ts`, which holds a third copy, `BUNDLED_PACKAGES` (`tests-integration/tests/packaging.test.ts:117`). Its test "names every package tsdown bundles, and no other" parses the `tsdown.config.ts` list and compares it to that copy (`tests-integration/tests/packaging.test.ts:209-217`), so two of the three lists are checked against each other. Nothing compares `scripts/package-manifest.mjs` to either.

**What would enforce it:** one owner of the value, a single module that exports the list and that both `tsdown.config.ts` and `scripts/package-manifest.mjs` import, or an extra assertion in `tests-integration/tests/packaging.test.ts` that parses the `scripts/package-manifest.mjs` list the same way it parses the tsdown one.

### `apps/cli/src/commands.ts` and `apps/mcp/src/tools.ts`

**The rule:** a write rule an agent has to know, such as the HTML block-tag refusal on a prose `body`, is stated once in the CLI help text (`apps/cli/src/commands.ts:2009-2015`) and again in the MCP tool contract (`apps/mcp/src/tools.ts:158-163` `ARTICLE_HTML_CONTRACT`), so a change to one has to be copied into the other.

**Evidence:** the two files changed together in 12 commits over 6 weeks, with no import, shared dependency or pinning test between them. Commit `8a5aa09865` (#339) added the block-tag refusal and wrote the same rule into both descriptions (`git show 8a5aa09865 -- apps/cli/src/commands.ts apps/mcp/src/tools.ts`). Commit `5bc07ae117` (#103) added the `--detect-near-duplicates` flag (`apps/cli/src/commands.ts:335`) and its MCP twin `detect_near_duplicates` (`apps/mcp/src/tools.ts:494`), each with its own prose for the same assist. Commit `110a3b63b3` then reworded the scheduled dedup-merge wording to the sleep run in both files in one edit (`git show 110a3b63b3 -- apps/cli/src/commands.ts apps/mcp/src/tools.ts`). The MCP side relies on its description to carry such rules: a test comment says a client "learns the rule from the description, which is why the description carries it" (`tests-integration/tests/mcp-stdio.test.ts:231-235`).

**Other partners:** in the co-change history of `apps/cli/src/commands.ts`, `apps/cli/src/run.ts` and `apps/cli/src/operations.ts` are linked partners, and `tests-integration/tests/mcp-stdio.test.ts` and `packages/store/tests/store.test.ts` are hidden ones. In the co-change history of `apps/mcp/src/tools.ts`, `apps/mcp/src/handlers.ts` is the strongest linked partner, `apps/cli/src/operations.ts` is explained, and `tests-integration/tests/mcp-stdio.test.ts`, `tests-integration/tests/batch.test.ts` and `apps/cli/src/run.ts` are among the hidden ones.

**What would enforce it:** one owner of the value, a shared constant in `packages/contracts` for each rule's wording that both `COMMANDS` and the `Tool.make` descriptions interpolate, or a test that checks a rule's key phrase appears in both the CLI help and the matching MCP tool description.

## See also

- [REPORT](../REPORT.md): 5 shared source citations
- [module map](../architecture/module-map.md): 2 shared source citations
- [system overview](../architecture/system-overview.md): 2 shared source citations
- [components](../diagrams/architecture/components.md): 2 shared source citations
- [contract map](contract-map.md): 2 shared source citations

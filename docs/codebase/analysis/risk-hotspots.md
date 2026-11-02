---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Risk hotspots

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

Bugs cluster in the CLI's command layer (`apps/cli/src/run.ts`, `apps/cli/src/operations.ts`), the package smoke script, the store's git subprocess wrapper and the indexer's update pass. A change is riskiest where those files hold long branching functions whose order or index bookkeeping isn't visible from the call site. No hotspot weighted by test coverage was confirmed, so the coverage measure ranks nothing here.

## Ranked hotspots

| File                              | Why it's risky                                                                                                                                                                    | Evidence                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/run.ts`             | Fixes keep reworking flag parsing and per-command validation around `dispatch` at `:363-701`, so a new flag or command touches the branch every other command runs through.       | 4 fix commits in 4 episodes over 19 revisions, `dispatch` ccn 83 over 291 nloc                             |
| `apps/cli/src/operations.ts`      | `batchWrite` at `:751` must keep per-op results in the caller's op-index space across the decode fold and the store fold, and fixes for unrelated bugs keep landing in this file. | 6 fix commits in 3 episodes over 20 revisions; 8 fix commits, 1517 lines changed, max ccn 33 at `:714-898` |
| `scripts/smoke-package.mjs`       | The script breaks when its environment shifts (git identity, npm's `pack --json` shape, orphaned process groups), and no unit test runs it.                                       | 4 fix commits in 3 episodes over 24 revisions, max ccn 19                                                  |
| `packages/store/src/git.ts`       | Its subprocess edge cases, the repo-selecting `GIT_*` scrub at `:221-236` and the interrupt wait at `:331-340`, each came from a separate bug.                                    | 4 fix commits in 4 episodes over 6 revisions, max ccn 6                                                    |
| `packages/index/src/indexer.ts`   | Index state, rename propagation and embedding resume are interleaved in `update` at `:808`, and a failed pass blocks every later pass until a rebuild (`:764-766`).               | 2 fix commits in 2 episodes over 7 revisions; 741 lines changed, max ccn 28                                |
| `apps/mcp/src/handlers.ts`        | The `memory_write_batch` handler at `:442-574` remaps survivor indexes to original ops through `originOf`, and a slip there makes errors and conflicts name the wrong op.         | 3 fix commits in 2 episodes over 11 revisions; max ccn 26                                                  |
| `apps/cli/src/apply.ts`           | The order of the early-return checks in `opAt` at `:200-303` decides which error code a bad JSONL line gets.                                                                      | 5 revisions, 2 fix commits, `opAt` ccn 33                                                                  |
| `packages/index/src/retrieval.ts` | `scopeNarrows` at `:245-255` must name every axis `assembleScope` can emit, or an empty facet-scoped result reports `scopeEmpty: false` (`:249-251`).                             | 8 revisions, 3 fix commits, `scopeNarrows` ccn 13                                                          |

## Drill-down

### `apps/cli/src/run.ts`

**What's there:** the CLI's argument parser and command dispatcher. `parseArgv` at `apps/cli/src/run.ts:196` reads argv against the flag table, and `dispatch` at `apps/cli/src/run.ts:363-366` is a `switch` over the parsed command that wraps one shared use case per arm.

**Recent activity:** 19 commits from 2026-08-11 to 2026-10-26, leaving out 6 bulk commits (git counts 25 with `git rev-list --count --no-merges HEAD -- apps/cli/src/run.ts`), with the latest on 2026-10-26.

**Fix history:** its evidence counts 4 fix commits in 4 episodes. `043d0ebe48` moved parsing onto the flag table with per-command validation, `f2ef54f34a` added `MEMHTML_REFUSE_ENV_ROOT`, and `f938d8013d` refuses an integer flag whose value isn't an integer as written.

**Tests:** `apps/cli/tests/cli.test.ts:471` covers integer flags given non-integer values, and `apps/cli/tests/refuse-env-root.test.ts` covers the env-root refusal.

**Before you change it:** run `codegraph callers dispatch` and `codegraph callers parseArgv`, then run the CLI test suite and the integration tier (`tests-integration/tests`), since every command passes through this file.

### `apps/cli/src/operations.ts`

**What's there:** the CLI's shared use cases. `batchWrite` at `apps/cli/src/operations.ts:751` runs an optional conflict assist, an optional near-duplicate assist (whose ordering logic sits at `apps/cli/src/operations.ts:700-712`), a decode fold with `continueOnError`, then extraction and the store fold.

**Recent activity:** 20 commits from 2026-08-11 to 2026-10-26, leaving out 5 bulk commits (git counts 25 with `git rev-list --count --no-merges HEAD -- apps/cli/src/operations.ts`).

**Fix history:** its evidence counts 6 fix commits in 3 episodes. They fix different bugs: flag parsing (`043d0ebe48`), entity-name case folding (`6e5b4fa2ad`), activity-report scoping (`afa026aedc`), search any-of semantics (`0a90fcd8bd`), sleep-merge indexing (`2e8d2dae0c`) and a double-archive guard (`3a332cac60`).

**Tests:** `apps/cli/tests/batch.test.ts:303` exercises `continueOnError` batches; `apps/cli/tests/apply.test.ts` and `apps/cli/tests/extraction.test.ts` also reach the batch path.

**Before you change it:** run `codegraph callers batchWrite`, check that every per-op result still lands at its original op index after both folds, and run `apps/cli/tests/batch.test.ts` plus the integration tier.

### `scripts/smoke-package.mjs`

**What's there:** the package smoke test, which installs the built tarball and drives both bins (`tests-integration/tests/packaging.test.ts:25`). The complexity scanner's span for `record` runs to line 282, but `record` itself is a four-line logger at `scripts/smoke-package.mjs:63-68`; the branching sits in the checks that follow it.

**Recent activity:** 24 commits from 2026-08-17 to 2026-10-26, leaving out 3 bulk commits (git counts 27 with `git rev-list --count --no-merges HEAD -- scripts/smoke-package.mjs`).

**Fix history:** its evidence counts 4 fix commits in 3 episodes. `47553d5294` supplied a git identity, `85740ef0ca` accepted npm 12's object-shaped `pack --json` report, and `c907ddfa48` kills the server's process group so it doesn't outlive the run.

**Tests:** no unit test runs the script. CI runs it as `mise run package:smoke` (`.github/workflows/check.yml:79`), and `package.json:27` defines that task outside `check`.

**Before you change it:** run `pnpm package:smoke` locally; `--live` (`package.json:29`) spends Bedrock tokens, so leave it to the credentialed pre-push path.

### `packages/store/src/git.ts`

**What's there:** the store's git subprocess wrapper. `gitChildEnv` at `packages/store/src/git.ts:233-236` removes every name in `GIT_REPO_SELECTION_ENV` (`packages/store/src/git.ts:221-230`), and `awaitChildExit` at `packages/store/src/git.ts:331-340` makes an interrupted call wait for the child so no finalizer races its lock.

**Recent activity:** 6 commits from 2026-08-12 to 2026-10-26, leaving out 4 bulk commits (git counts 10 with `git rev-list --count --no-merges HEAD -- packages/store/src/git.ts`).

**Fix history:** its evidence counts 4 fix commits in 4 episodes. `b04157e306` scrubs hook-exported `GIT_DIR` and its siblings, and `ed1b82601d` waits for the child on interrupt; `5f78ddeb40` and `273581067d` mostly widened the interface for callers elsewhere.

**Tests:** `packages/store/tests/git.test.ts:869` covers interruption waiting for the git child, and `packages/store/tests/git.test.ts:699` pins the scrubbed variable set.

**Before you change it:** run `codegraph callers spawnGit`, then `packages/store/tests/git.test.ts` and the integration tier, which runs against a real `git` repository.

### `packages/index/src/indexer.ts`

**What's there:** the index projection. `deletePath` is a four-line helper at `packages/index/src/indexer.ts:740-743`; the branching the complexity scanner attributes to it lives in `update` at `packages/index/src/indexer.ts:808`, and the comment at `packages/index/src/indexer.ts:764-766` explains why a primary-key violation on a rename would fail every later pass until a rebuild.

**Recent activity:** 7 commits from 2026-08-12 to 2026-10-20, leaving out 3 bulk commits (git counts 10 with `git rev-list --count --no-merges HEAD -- packages/index/src/indexer.ts`).

**Fix history:** its evidence counts 2 fix commits in 2 episodes. `c2391e195a` persists `embedMissing` progress per slice so a throttled pass can resume, and `077ba71002` propagates renames and makes an interrupted rebuild detectable.

**Tests:** `packages/index/tests/indexer.test.ts:635` checks that the archive move is handled as a rename that keeps the embedding.

**Before you change it:** run `codegraph impact update -d 3 --json` and read the rename comment block, then run `packages/index/tests/indexer.test.ts` and the integration tier, which uses a real `node:sqlite` database.

## See also

- [REPORT](../REPORT.md): 7 shared source citations
- [data flow](../architecture/data-flow.md): 5 shared source citations
- [processes](../behavior/processes.md): 5 shared source citations
- [components](../diagrams/architecture/components.md): 5 shared source citations
- [dependency graph](../diagrams/structural/dependency-graph.md): 4 shared source citations

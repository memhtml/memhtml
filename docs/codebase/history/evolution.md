---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · How the code got here

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

The code got to its current shape in three bursts over eleven weeks: a four-week build-out that produced nearly every package and the docs site, a six-week stretch of dependency bumps and documentation corrections, and a closing rework that moved the corpus onto an immutable head with sessions and a curator package. The history holds 302 commits between 2026-08-11 and 2026-10-26 once 48 bot commits and 8 bulk sweeps are set aside, and this page reads from it the weekly activity, the quarter each author started, the blame age of surviving lines and the commits that renamed or moved files. Reviewers confirmed none of the fossil candidates, so the page has no fossils section.

## Eras

The eras below follow the weekly commit and line counts in the git history, with module counts from the history of each top module.

### 2026-08-10 to 2026-09-06: the build-out

One author built the system at 41 to 60 commits a week, 186 commits in four weeks, with the busiest week (from 2026-08-24) changing 15,625 lines. The docs site took 72 commits, `apps/cli` 58, `packages/index` 31, `apps/mcp` 24 and `packages/llm` 16 in these weeks (git history of `apps/docs`, `apps/cli`, `packages/index`, `apps/mcp`, `packages/llm`). The subjects show the index moving to `node:sqlite` (`2ab82f4` feat(index): replace Turso with node:sqlite, FTS5 and real bm25 ranking), the docs site taking shape (`345072e` feat(docs): the agent surface), and a since-removed consolidator app carrying the sleep agent (`6547d9c` fix(consolidator): verify cited quotes against the transcript). `1bc2a6d` (memhtml: durable agent memory as a git-native HTML corpus) opens the era, and `2e8d2da` (fix(sleep): project the merged commit into the index when sleep merge lands) closes it.

### 2026-09-07 to 2026-10-18: upkeep and corrections

Activity fell to 10 to 16 commits a week, 77 in six weeks, and changed lines dropped from 921 in the first week to 0 in two weeks. The docs site took 31 commits, `packages/llm` 19, `packages/session` 16, `apps/cli` 13, and `packages/integrations` appeared with 9 (git history of `apps/docs`, `packages/llm`, `packages/session`, `apps/cli`, `packages/integrations`). The subjects are mostly dependency moves and doc-page corrections: `aca6b32` (deps: move the Effect catalog to 4.0.0-rc.115 as one set), `9533d07` (feat(integrations): wire Claude Code, Codex, Cursor, and OpenCode to a store in one command) and `cd5bc4b` (docs(site): add @memhtml/traces to the API tier). `193fed0` (docs(site): generate an API tier for @memhtml/contracts from its TSDoc) opens the era, and `946eed5` (feat!: hold the corpus as an immutable head, write through sessions, and curate on a branch) closes it.

### 2026-10-19 to 2026-10-26: the head, session and curator rework

The two weeks after `946eed5` carried 39 commits and 12,210 changed lines, 10,046 of them in the last week. `packages/curator` exists only in this era, with 8 commits, and the docs site took 22, `apps/cli` 12, `packages/session` 7 and `packages/store` 7 (git history of `packages/curator`, `apps/docs`, `apps/cli`, `packages/session`, `packages/store`). The subjects are fixes to the new model and the Effect catalog landing on its release: `329067a` (deps: move the effect catalog to 4.0.5), `09089ac` (fix(curator): brief the moot detected tasks and archive them) and `f196d59` (fix(session): repoint inbound edges when an archive vacates a path). `bb6017b` (deps: bump ai to 7.0.142) opens the era, and `3406f70` (fix(archive): take the year's next generation slot, never a held one) closes it.

## Authors

The history holds one author cohort, 2026-Q3, whose only human author is Laith Al-Saadoon; its one other identity is automation, and the counts set the release-please and dependabot commits aside as bots.

## Line age

From blame at this commit: the median surviving line is 61 days old, the oldest dates from 2026-08-11 and the newest from 2026-10-26, with blame covering 200 of the 491 code files.

| Age           | Lines  | Share |
| ------------- | ------ | ----- |
| under 30 days | 28,710 | 30%   |
| 30 to 90 days | 68,210 | 70%   |

## Largest moves

In the git history, two commits renamed files:

| Commit       | Date       | Files | From                                                                         | To                                            |
| ------------ | ---------- | ----- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| `946eed5f43` | 2026-10-18 | 11    | several directories, such as `apps/consolidator/src/`, `packages/sleep/src/` | `apps/cli/src/`, `apps/cli/tests/` and others |
| `40511b7174` | 2026-09-03 | 1     | `apps/consolidator/agent/`                                                   | `apps/consolidator/prompts/`                  |

---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Ownership

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

The history has one human author, who owns every surviving line in every module apart from a few automation stamps. Shares come from who last changed each surviving line at HEAD, leaving bot commits out (blame over the code files at this commit gives one author, 96,918 lines).

## By module

Modules are ranked by surviving lines, from blame at this commit grouped by module; the git history of `apps/cli` and of `packages/index` each has one author.

| Module                    | Top author | Share of surviving lines | Authors |
| ------------------------- | ---------- | ------------------------ | ------- |
| `apps/cli`                | the author | 100%                     | 1       |
| `packages/index`          | the author | 100%                     | 1       |
| `apps/docs`               | the author | 100%                     | 1       |
| `apps/mcp`                | the author | 100%                     | 1       |
| `packages/store`          | the author | 100%                     | 1       |
| `packages/session`        | the author | 100%                     | 1       |
| `tests-integration/tests` | the author | 100%                     | 1       |
| `packages/llm`            | the author | 100%                     | 1       |
| `packages/html`           | the author | 100%                     | 1       |
| `packages/contracts`      | the author | 100%                     | 1       |
| `scripts`                 | the author | 100%                     | 1       |
| `packages/domain`         | the author | 100%                     | 1       |
| `packages/eval`           | the author | 100%                     | 1       |
| `tests-integration`       | the author | 100%                     | 1       |
| `packages/curator`        | the author | 100%                     | 1       |

Automation owns a few lines: the release workflow's version stamps (for example `apps/mcp/src/server.ts:11`, last changed by the release commit for 0.17.0) and some of dependabot's version pins. Every other surviving line is the human author's.

## Single points of failure

The whole repository is one: blame at this commit gives a truck factor of 1 for the repository and for `apps/`, `packages/`, `scripts/`, `tests-integration/` and `.claude/`, so a second reviewer on changes, and the design record in `docs/design.md`, are the only mitigations available.

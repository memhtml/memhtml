---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Ownership

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

The history has one human author, Laith Al-Saadoon, who owns every surviving line in every module. Shares come from who last changed each surviving line at HEAD (blame over the code files at this commit gives one author, 96,918 lines).

## By module

Modules are ranked by surviving lines, from blame at this commit grouped by module; the git history of `apps/cli` and of `packages/index` each has one author.

| Module                    | Top author       | Share of surviving lines | Authors |
| ------------------------- | ---------------- | ------------------------ | ------- |
| `apps/cli`                | Laith Al-Saadoon | 100%                     | 1       |
| `packages/index`          | Laith Al-Saadoon | 100%                     | 1       |
| `apps/docs`               | Laith Al-Saadoon | 100%                     | 1       |
| `apps/mcp`                | Laith Al-Saadoon | 100%                     | 1       |
| `packages/store`          | Laith Al-Saadoon | 100%                     | 1       |
| `packages/session`        | Laith Al-Saadoon | 100%                     | 1       |
| `tests-integration/tests` | Laith Al-Saadoon | 100%                     | 1       |
| `packages/llm`            | Laith Al-Saadoon | 100%                     | 1       |
| `packages/html`           | Laith Al-Saadoon | 100%                     | 1       |
| `packages/contracts`      | Laith Al-Saadoon | 100%                     | 1       |
| `scripts`                 | Laith Al-Saadoon | 100%                     | 1       |
| `packages/domain`         | Laith Al-Saadoon | 100%                     | 1       |
| `packages/eval`           | Laith Al-Saadoon | 100%                     | 1       |
| `tests-integration`       | Laith Al-Saadoon | 100%                     | 1       |
| `packages/curator`        | Laith Al-Saadoon | 100%                     | 1       |

No bot or automation identity (release-please, dependabot) owns a surviving line: blame at this commit gives one author.

## Single points of failure

The whole repository is one: blame at this commit gives a truck factor of 1 for the repository and for `apps/`, `packages/`, `scripts/`, `tests-integration/` and `.claude/`, so a second reviewer on changes, and the design record in `docs/design.md`, are the only mitigations available.

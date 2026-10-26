---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Test blind spots

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

The real child-process version probe `spawnVersion` in the integrations package sits in no test's reach. Merged lcov coverage from the package test suites shows no line of it reached, and it has no caller outside tests or in tests. The package smoke (`scripts/smoke-package.mjs`) is outside `check`: the `check` script lists turbo tasks only (`package.json:25`), and the smoke runs through a separate `package:smoke` script (`package.json:27`).

Reviewers confirmed this candidate as the only one on the page. Candidates they rejected are not listed here.

## Untested functions

| Function                                            | Callers                                                 | What would cover it                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/integrations/src/doctor.ts::spawnVersion` | 0 outside tests, 0 in tests; 0 of 27 body lines covered | A test in `packages/integrations/tests/doctor.test.ts` that runs the real probe. Every test there injects fake probes (`packages/integrations/tests/doctor.test.ts:88`), and `spawnVersion` is wired into `DEFAULT_PROBES` (`packages/integrations/src/doctor.ts:245`). No tier exercises the spawn, timeout or JSON-parse paths. |

## See also

- [REPORT](../REPORT.md): 3 shared source citations

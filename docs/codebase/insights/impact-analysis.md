---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Impact analysis

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

Changing an error class, a record shape or the database port in `packages/contracts`, `packages/index` or `packages/store` reaches the most files: `StorageFailure` alone is named by 45 files (symbol references in the code index). A "high-impact surface" here is one of the eight non-test symbols with the most distinct files referencing them in the code index's symbol edges. Tests come from `codegraph affected <path> --json` and co-change partners from each file's git history.

| Rank | Surface          | Files referencing it (incl. tests) | Defined at                            |
| ---- | ---------------- | ---------------------------------- | ------------------------------------- |
| 1    | `StorageFailure` | 45                                 | `packages/contracts/src/errors.ts:9`  |
| 2    | `MemoryRecord`   | 27                                 | `packages/contracts/src/record.ts:25` |
| 3    | `DatabaseShape`  | 26                                 | `packages/index/src/database.ts:61`   |
| 4    | `HeadView`       | 26                                 | `packages/contracts/src/record.ts:52` |
| 5    | `makeGit`        | 22                                 | `packages/store/src/git.ts:378`       |
| 6    | `GitFailure`     | 19                                 | `packages/contracts/src/errors.ts:24` |
| 7    | `parseMemory`    | 15                                 | `packages/html/src/parse.ts:385`      |
| 8    | `normalizePath`  | 13                                 | `packages/contracts/src/paths.ts:57`  |

`renderTemplate` (`packages/html/src/template.ts:264`) has 45 referencing files too (symbol references in the code index), but most are tests, so it sits under Other notable surfaces.

## StorageFailure

Defined at: `packages/contracts/src/errors.ts::StorageFailure`

A `Schema.TaggedError` with one field, `operation` (`packages/contracts/src/errors.ts:9-11`). `codegraph affected packages/contracts/src/errors.ts --json` names 146 affected test files.

| Downstream                                     | Type             | Touch on change | Citation                                      |
| ---------------------------------------------- | ---------------- | --------------- | --------------------------------------------- |
| `apps/cli/src/errors.ts` codeFor / messageFor  | runtime dispatch | yes             | `apps/cli/src/errors.ts:48`                   |
| `apps/mcp/src/failure.ts`                      | runtime dispatch | yes             | `apps/mcp/src/failure.ts:131`                 |
| `packages/index/src/database.ts` DatabaseShape | direct import    | yes             | `packages/index/src/database.ts:65`           |
| `packages/session/src/session.ts`              | direct import    | likely          | `packages/session/src/session.ts:149`         |
| `packages/store/src/store.ts`                  | direct import    | likely          | `packages/store/src/store.ts:200`             |
| `packages/snapshot/src/snapshot.ts`            | direct import    | likely          | `packages/snapshot/src/snapshot.ts:303`       |
| `packages/index/src/indexer.ts`                | direct import    | likely          | `packages/index/src/indexer.ts:110`           |
| `packages/contracts/src/checkout-lock.ts`      | direct import    | yes             | `packages/contracts/src/checkout-lock.ts:170` |
| `apps/mcp/tests/failure.test.ts`               | test             | yes             | `apps/mcp/tests/failure.test.ts:53`           |

**Blast-radius notes:**

- The payload deliberately carries no SQL text, parameters or row contents, so it can go back to an agent; a new field that holds driver text would leak corpus content (`packages/contracts/src/errors.ts:3-8`).
- The `_tag` string `"StorageFailure"` is matched by name in the CLI's `ERR_STORAGE` mapping and its message (`apps/cli/src/errors.ts:48-49`, `apps/cli/src/errors.ts:123-124`) and in the MCP recovery hints (`apps/mcp/src/failure.ts:129-134`); renaming the tag silently drops those to the default branch.
- Migration cost if removed: L. The index database port names it in the error channel of its operations (`packages/index/src/database.ts:65`, `packages/index/src/database.ts:69`, `packages/index/src/database.ts:73`).

## MemoryRecord

Defined at: `packages/contracts/src/record.ts:25`

The parsed form of one memory file: path, blob sha, content hash, claim, timestamps, tags, links, facets, body text, html and an `archived` flag (`packages/contracts/src/record.ts:25-49`). `codegraph affected packages/contracts/src/record.ts --json` names 145 affected test files.

| Downstream                                            | Type          | Touch on change | Citation                                      |
| ----------------------------------------------------- | ------------- | --------------- | --------------------------------------------- |
| `packages/head/src/record.ts` (builds records)        | direct import | yes             | `packages/head/src/record.ts:37`              |
| `packages/snapshot/src/snapshot.ts` columnsOf         | direct import | yes             | `packages/snapshot/src/snapshot.ts:186`       |
| `packages/curator/src/planner/plan.ts`                | direct import | likely          | `packages/curator/src/planner/plan.ts:69`     |
| `packages/head/src/lexical.ts` indexedText            | direct import | likely          | `packages/head/src/lexical.ts:105`            |
| `packages/head/src/version.ts`                        | direct import | likely          | `packages/head/src/version.ts:78`             |
| `apps/cli/src/head-scope.ts`                          | direct import | likely          | `apps/cli/src/head-scope.ts:54`               |
| `packages/curator/tests/inbox.test.ts` record factory | test          | yes             | `packages/curator/tests/inbox.test.ts:34`     |
| `packages/snapshot/tests/snapshot.test.ts`            | test          | yes             | `packages/snapshot/tests/snapshot.test.ts:87` |
| `packages/head/tests/helpers.ts` mapView              | test          | yes             | `packages/head/tests/helpers.ts:131`          |

**Blast-radius notes:**

- `blobSha` is a locally computed git blob sha and `contentHash` is the `sha256:` hash from `@memhtml/html` (`packages/contracts/src/record.ts:27-30`); a consumer that compares either against git or the index assumes those exact recipes.
- Test factories build records field by field (`packages/curator/tests/inbox.test.ts:34`, `apps/cli/tests/session-exec.test.ts:69`), so a new required field breaks typecheck across several test suites.
- Migration cost if a field is renamed: L. The snapshot columns (`packages/snapshot/src/snapshot.ts:186`) also persist the shape.

## DatabaseShape

Defined at: `packages/index/src/database.ts:61`

The SQLite port: `run`, `get`, `all`, `writeAll`, `script`, two migration counters and `hasState` (`packages/index/src/database.ts:61-92`), served as `DatabaseService` (`packages/index/src/database.ts:95`). `codegraph affected packages/index/src/database.ts --json` names 74 affected test files.

| Downstream                                | Type          | Touch on change | Citation                                     |
| ----------------------------------------- | ------------- | --------------- | -------------------------------------------- |
| `apps/cli/src/api-layer.ts` layerDatabase | direct import | yes             | `apps/cli/src/api-layer.ts:119`              |
| `apps/cli/src/doctor.ts`                  | direct import | likely          | `apps/cli/src/doctor.ts:248`                 |
| `apps/cli/src/repair.ts`                  | direct import | likely          | `apps/cli/src/repair.ts:118`                 |
| `packages/index/src/indexer.ts`           | direct import | yes             | `packages/index/src/indexer.ts:217`          |
| `packages/index/src/traces-persist.ts`    | direct import | likely          | `packages/index/src/traces-persist.ts:164`   |
| `packages/eval/src/harness.ts`            | direct import | likely          | `packages/eval/src/harness.ts:119`           |
| `packages/index/tests/harness.ts` withDb  | test          | yes             | `packages/index/tests/harness.ts:26`         |
| `packages/index/tests/database.test.ts`   | test          | yes             | `packages/index/tests/database.test.ts:20`   |
| `tests-integration/tests/rebuild.test.ts` | test          | yes             | `tests-integration/tests/rebuild.test.ts:25` |

**Blast-radius notes:**

- `writeAll` promises all-or-nothing, and `script` runs a whole migration file in one transaction because migration callers must use the runner's primitive (`packages/index/src/database.ts:74-83`).
- `migrationsApplied` and `stateMigrationsApplied` are separate because `index.db` is rebuilt and `state.db` is not (`packages/index/src/database.ts:84-90`); a caller that reads one counter for both planes misreports state.
- Migration cost if the port changes: M. The single production layer is `layerDatabase` (`apps/cli/src/api-layer.ts:119`), but test harnesses in index and integration hand-build connections.

## HeadView

Defined at: `packages/contracts/src/record.ts:52`

One read-only version of the corpus with lookups by path, content hash, frame key, inbound href and entity (`packages/contracts/src/record.ts:52-66`). It shares the affected-test set of `record.ts` above.

| Downstream                                     | Type          | Touch on change | Citation                                 |
| ---------------------------------------------- | ------------- | --------------- | ---------------------------------------- |
| `packages/head/src/gate.ts`                    | direct import | yes             | `packages/head/src/gate.ts:110`          |
| `packages/session/src/commit.ts` stage         | direct import | yes             | `packages/session/src/commit.ts:171`     |
| `packages/session/src/validate.ts`             | direct import | yes             | `packages/session/src/validate.ts:198`   |
| `packages/session/src/moves.ts`                | direct import | likely          | `packages/session/src/moves.ts:40`       |
| `packages/curator/src/inbox.ts`                | direct import | likely          | `packages/curator/src/inbox.ts:222`      |
| `apps/cli/src/head-vectors.ts` coverageOf      | direct import | likely          | `apps/cli/src/head-vectors.ts:126`       |
| `apps/cli/src/v2.ts`                           | direct import | likely          | `apps/cli/src/v2.ts:317`                 |
| `packages/head/tests/helpers.ts` mapView       | test          | yes             | `packages/head/tests/helpers.ts:131`     |
| `apps/cli/tests/session-exec.test.ts` viewOver | test          | yes             | `apps/cli/tests/session-exec.test.ts:69` |

**Blast-radius notes:**

- `byContentHash` and `byFrameKey` return active records only (`packages/contracts/src/record.ts:59-62`); duplicate and supersede checks in session and curator depend on archived records being excluded.
- `sha` is null for a view with no git ancestry, which tests and overlays use (`packages/contracts/src/record.ts:53-54`).
- Hand-written test views (`packages/head/tests/helpers.ts:131`, `apps/cli/tests/session-exec.test.ts:69`) implement the whole interface, so a new method breaks them. Migration cost: M.

## makeGit

Defined at: `packages/store/src/git.ts::makeGit`

The factory for the store's `GitShape` service (`packages/store/src/git.ts:53`, `packages/store/src/git.ts:378`). `codegraph affected packages/store/src/git.ts --json` names 83 affected test files. Its strongest co-change partner is `packages/store/tests/git.test.ts`, linked by 5 shared commits (co-change history of `packages/store/src/git.ts`).

| Downstream                                     | Type          | Touch on change | Citation                                 |
| ---------------------------------------------- | ------------- | --------------- | ---------------------------------------- |
| `apps/cli/src/api-layer.ts` (composition root) | direct import | yes             | `apps/cli/src/api-layer.ts:135`          |
| `apps/cli/src/head-cache.ts`                   | direct import | likely          | `apps/cli/src/head-cache.ts:62`          |
| `apps/cli/src/v2.ts`                           | direct import | likely          | `apps/cli/src/v2.ts:249`                 |
| `apps/cli/src/exec.ts`                         | direct import | likely          | `apps/cli/src/exec.ts:536`               |
| `apps/cli/src/replay.ts`                       | direct import | likely          | `apps/cli/src/replay.ts:210`             |
| `apps/cli/src/curate-run.ts`                   | direct import | likely          | `apps/cli/src/curate-run.ts:258`         |
| `apps/cli/src/store-config.ts`                 | direct import | likely          | `apps/cli/src/store-config.ts:190`       |
| `packages/eval/src/fixture.ts`                 | direct import | likely          | `packages/eval/src/fixture.ts:157`       |
| `packages/store/src/testing.ts` fixture        | test          | yes             | `packages/store/src/testing.ts:68`       |
| `tests-integration/tests/harness.ts`           | test          | yes             | `tests-integration/tests/harness.ts:121` |
| `packages/store/tests/git.test.ts`             | test          | yes             | `packages/store/tests/git.test.ts:395`   |

**Blast-radius notes:**

- Several CLI modules call `makeGit(root)` directly instead of taking the service from `AppLive` (`apps/cli/src/head-cache.ts:62`, `apps/cli/src/v2.ts:249`), so a behavior change in the factory is not swappable at the layer.
- `packages/store/src/git.ts:38` re-exports `GitFailure` so `import { GitFailure } from "@memhtml/store"` keeps resolving (`packages/store/src/git.ts:35`); `packages/store/tests/git.test.ts:9` imports it that way.
- Migration cost if replaced: M.

## GitFailure

Defined at: `packages/contracts/src/errors.ts::GitFailure`

Carries `command` (subcommand name only) and `exitCode`, null when the process never started (`packages/contracts/src/errors.ts:24-28`). It shares the affected-test set of `errors.ts` above.

| Downstream                                  | Type             | Touch on change | Citation                                         |
| ------------------------------------------- | ---------------- | --------------- | ------------------------------------------------ |
| `apps/cli/src/errors.ts` ERR_GIT mapping    | runtime dispatch | yes             | `apps/cli/src/errors.ts:46`                      |
| `apps/mcp/src/failure.ts`                   | runtime dispatch | yes             | `apps/mcp/src/failure.ts:130`                    |
| `apps/mcp/src/resources.ts` pinned refusal  | runtime dispatch | yes             | `apps/mcp/src/resources.ts:289`                  |
| `packages/store/src/git.ts` re-export       | direct import    | yes             | `packages/store/src/git.ts:2`                    |
| `packages/session/src/errors.ts` re-export  | direct import    | yes             | `packages/session/src/errors.ts:9`               |
| `packages/session/src/session.ts`           | indirect         | likely          | `packages/session/src/session.ts:283`            |
| `apps/cli/tests/head-server-commit.test.ts` | test             | yes             | `apps/cli/tests/head-server-commit.test.ts:1845` |

**Blast-radius notes:**

- One class is shared by two git spawners, the store's `Git` service and session's own `execFile`, so one `_tag` keeps the CLI's `ERR_GIT` mapping and `instanceof` checks valid for both (`packages/contracts/src/errors.ts:18-22`).
- `command` must never hold full argv, because arguments carry memory paths and the error reaches agents (`packages/contracts/src/errors.ts:13-17`).
- `apps/mcp/src/resources.ts:289` catches it by tag and turns it into the resource's own refusal, so a tag rename makes those reads surface raw errors. Migration cost: M.

## parseMemory

Defined at: `packages/html/src/parse.ts::parseMemory`

Parses memory HTML into a `MemoryDoc` or fails with `InvalidMemory` (`packages/html/src/parse.ts:385`). `codegraph affected packages/html/src/parse.ts --json` names 143 affected test files.

| Downstream                                           | Type          | Touch on change | Citation                                  |
| ---------------------------------------------------- | ------------- | --------------- | ----------------------------------------- |
| `packages/store/src/store.ts` write path             | direct import | yes             | `packages/store/src/store.ts:672`         |
| `packages/head/src/record.ts` record build           | direct import | yes             | `packages/head/src/record.ts:38`          |
| `packages/index/src/indexer.ts`                      | direct import | yes             | `packages/index/src/indexer.ts:306`       |
| `packages/session/src/validate.ts`                   | direct import | yes             | `packages/session/src/validate.ts:165`    |
| `packages/session/src/commit.ts`                     | direct import | yes             | `packages/session/src/commit.ts:291`      |
| `apps/mcp/src/resources.ts`                          | direct import | likely          | `apps/mcp/src/resources.ts:303`           |
| `apps/cli/src/session-exec.ts`                       | direct import | likely          | `apps/cli/src/session-exec.ts:196`        |
| `apps/cli/src/head-scope.ts`                         | direct import | likely          | `apps/cli/src/head-scope.ts:60`           |
| `packages/html/tests/fixtures.ts` parseOk / parseErr | test          | yes             | `packages/html/tests/fixtures.ts:160-168` |
| `packages/index/tests/project.test.ts`               | test          | yes             | `packages/index/tests/project.test.ts:25` |

**Blast-radius notes:**

- `packages/session/src/commit.ts:291` pipes the parse into `Effect.orDie`, so it assumes validation already accepted the html; a parser that rejects more input turns a commit into a defect instead of a typed error.
- `packages/session/src/validate.ts:165` and `apps/cli/src/head-scope.ts:60` run it synchronously with `Effect.runSyncExit`, so the parser must stay free of async effects.
- Migration cost if the result shape changes: L. The html parse tests go through `parseOk` and `parseErr` (`packages/html/tests/parse.test.ts:3-11`).

## normalizePath

Defined at: `packages/contracts/src/paths.ts::normalizePath`

Strips leading slashes, collapses repeated slashes and drops a trailing slash (`packages/contracts/src/paths.ts:57-60`). `codegraph affected packages/contracts/src/paths.ts --json` names 143 affected test files. Its co-change partner is `packages/contracts/tests/paths.test.ts`, linked by 6 shared commits (co-change history of `packages/contracts/src/paths.ts`).

| Downstream                               | Type          | Touch on change | Citation                                    |
| ---------------------------------------- | ------------- | --------------- | ------------------------------------------- |
| `packages/session/src/validate.ts`       | direct import | yes             | `packages/session/src/validate.ts:98`       |
| `packages/session/src/moves.ts`          | direct import | yes             | `packages/session/src/moves.ts:75`          |
| `packages/store/src/store.ts`            | direct import | yes             | `packages/store/src/store.ts:486`           |
| `packages/index/src/indexer.ts`          | direct import | likely          | `packages/index/src/indexer.ts:244`         |
| `packages/index/src/project.ts`          | direct import | likely          | `packages/index/src/project.ts:26`          |
| `apps/cli/src/operations.ts`             | direct import | likely          | `apps/cli/src/operations.ts:1108`           |
| `apps/cli/src/repair.ts` hrefFor         | direct import | likely          | `apps/cli/src/repair.ts:23`                 |
| `apps/mcp/src/resources.ts`              | direct import | likely          | `apps/mcp/src/resources.ts:199`             |
| `packages/contracts/tests/paths.test.ts` | test          | yes             | `packages/contracts/tests/paths.test.ts:44` |

**Blast-radius notes:**

- The function sits on the write path for agent-supplied paths, and the doc comment warns that reordering its regex calls reintroduced a multi-second stall on adversarial input; `packages/contracts/tests/paths.test.ts` asserts the cost curve (`packages/contracts/src/paths.ts:50-56`).
- Session validation, moves and the store all key on the normalized form (`packages/session/src/validate.ts:98`, `packages/store/src/store.ts:486`), so any change in output re-keys existing lookups. Migration cost: L.

## Other notable surfaces

- `renderTemplate` (`packages/html/src/template.ts:264`): mostly test consumers; changing it shifts many fixture outputs.
- `OverlayOp` (`packages/contracts/src/record.ts:81`): the session overlay union of seven op kinds; staged by `packages/session/src/commit.ts:171`.
- `HostId` (`packages/integrations/src/types.ts:11`) and `BinaryLocation` (`packages/integrations/src/types.ts:45`): the integrations host vocabulary.
- `EmbedderShape` (`apps/cli/src/api-layer.ts:218`): the embedder port that the fake embedder implements.
- `contentHash` (`packages/html/src/hash.ts:156`): the `sha256:` hash stored in every `MemoryRecord`.
- `CuratorTools::exec` (`packages/curator/src/tools.ts:86`) ranks high in the index only because unrelated `.exec(` calls resolve to it by name; its listed callers such as `packages/contracts/src/paths.ts:268` aren't real consumers.

## See also

- [contract map](contract-map.md): 23 shared source citations
- [dependency graph](../diagrams/structural/dependency-graph.md): 15 shared source citations
- [business logic](business-logic.md): 12 shared source citations
- [module map](../architecture/module-map.md): 10 shared source citations
- [debugging guide](debugging-guide.md): 8 shared source citations

---
commit: 3406f7089918528856905902284309cc11fc065d
generated: 2026-10-26
---

# memhtml · Debugging guide

> Generated from commit [`3406f7089918`](https://github.com/memhtml/memhtml/tree/3406f7089918528856905902284309cc11fc065d). Line citations refer to that commit.

When memhtml breaks, the first place to look is the one JSON envelope on stdout and its `code` field, then the WARN and ERROR lines on stderr, then `memhtml status` and `memhtml doctor`. Every typed failure maps to one stable `ERR_*` code (`apps/cli/src/errors.ts:44-105`), and the retry and deadline sites below decide which failures surface at all. This page was built from the error classes in `packages/contracts/src/errors.ts`, the CLI error mapping, the retry schedules and deadline constants, `RUNBOOK.md` and `docs/bugs/`.

## Failure-mode index

| Symptom                                                             | Likely surface                                                                         | First check                                                                                                     | Citation                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| First `memhtml init` on a fresh box fails with `ERR_GIT`            | `git commit` refuses with no identity; `GitFailure` maps to `ERR_GIT`                  | Set `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` or `git config --global user.name`, then rerun `init`              | `apps/cli/src/errors.ts:46-47`               |
| Command fails with `ERR_STORAGE` under concurrent writers           | `SQLITE_BUSY` outlived the jittered backoff (`15 millis` doubling, `upTo` 20 seconds)  | Look for a long-running writer on the same `index.db`; the driver message is on stderr                          | `packages/index/src/database.ts:147-149`     |
| `ERR_EMBED_MODEL_MISMATCH` on `index update` or `rebuild`           | `guardEmbedModel` refuses a write into a different vector space                        | `memhtml status` and read `embedModel`; delete `index.db` and rebuild                                           | `packages/index/src/indexer.ts:332`          |
| `ERR_INDEX_STALE`                                                   | A rebuild emptied the index and didn't finish                                          | `memhtml index rebuild` is the one recovery                                                                     | `packages/index/src/indexer.ts:842-845`      |
| `ERR_REBUILD_NO_EMBED_REFUSED`                                      | `index rebuild --no-embed` over a store that holds vectors                             | Rerun with `--embed`, or `--force` if the gap is intended                                                       | `packages/index/src/indexer.ts:199`          |
| Search returns `degraded: true` or `vector.reason: "embed-timeout"` | Query embed missed its deadline (default 450 ms) or vector coverage is under the floor | Read `vectorCoverage` on the response; low means `memhtml index embed`, high means check the Bedrock credential | `apps/cli/src/head-protocol.ts:123`          |
| `session commit` fails with `ERR_STORAGE` after a minute            | The head server didn't answer within `COMMIT_DEADLINE_DEFAULT_MS` (60,000 ms)          | `memhtml session status`: zero ops means the commit landed                                                      | `apps/cli/src/head-protocol.ts:354-357`      |
| `session exec` reports a terminated sandbox                         | The exec pool killed a worker past its deadline                                        | grep stderr for `did not stop at its deadline`                                                                  | `apps/cli/src/exec-pool.ts:101-102`          |
| A write waits, then fails on a `.lock`                              | The checkout lock is held by another writer past `CHECKOUT_LOCK_WAIT_MS` (15,000 ms)   | grep stderr for `is held by another writer of this checkout`                                                    | `packages/contracts/src/checkout-lock.ts:54` |
| Model or embed calls through a proxy fail after about two minutes   | `PROXY_BACKOFF` retries 408, 429 and 5xx, then gives up                                | Check `MEMHTML_LLM_BASE_URL` reachability and the proxy's status codes                                          | `packages/llm/src/proxy.ts:172-189`          |
| `head serve` exits 1 with `ERR_HEAD_SERVER_RUNNING`                 | A second server for the same store                                                     | `memhtml head status`; stop the other server                                                                    | `apps/cli/src/head-server.ts:515`            |
| `eval discriminate --mode live` reports `skipped: true`             | `AWS_BEARER_TOKEN_BEDROCK` absent, so nothing was measured                             | grep stderr for `did NOT run`; rerun with credentials or `--mode fake`                                          | `packages/eval/src/run.ts:95-104`            |
| Every command needing policy fails with `ERR_STORE_CONFIG`          | Malformed `memhtml.config.json`                                                        | `memhtml config`; read the `reason`                                                                             | `packages/contracts/src/errors.ts:89-93`     |

## Log and error surfaces

stdout carries only the envelope, and every log line goes to stderr (`apps/cli/src/bin.ts:4`). The MCP server has the same split, because stdout is its RPC stream (`apps/mcp/src/server.ts:62`).

| Surface                         | Where it emits                                                             | What to grep for                                                       | Citation                                |
| ------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| CLI failure envelope            | stdout, one JSON object                                                    | `.code`, `.suggestions` (`jq .code`)                                   | `apps/cli/src/envelope.ts:100-105`      |
| CLI exit status                 | process exit                                                               | `0` ok, `2` usage, `1` runtime                                         | `apps/cli/src/envelope.ts:167-170`      |
| CLI typed-error to code mapping | in-process                                                                 | `_tag` values such as `StorageFailure`, `GitFailure`                   | `apps/cli/src/errors.ts:44-105`         |
| MCP tool failure                | `ToolFailure` in the RPC response                                          | `code` and `message` fields, same `ERROR_CODES` vocabulary             | `apps/mcp/src/failure.ts:34-42`         |
| Effect logger, CLI              | stderr                                                                     | `WARN`, `ERROR` levels                                                 | `apps/cli/src/run.ts:1740`              |
| Effect logger, MCP              | stderr of `memhtml-mcp`                                                    | `WARN`, `ERROR` levels                                                 | `apps/mcp/src/server.ts:62`             |
| Stale-index warning             | stderr on every `status` / `memory_status` while stale                     | `index describes`                                                      | `apps/cli/src/operations.ts:2588-2593`  |
| Storage driver message          | stderr via `Effect.logError`; the envelope carries only the operation name | the `operation` string from the envelope                               | `packages/contracts/src/errors.ts:3-10` |
| Write-assist skips              | stderr warnings, the write still succeeds                                  | `conflict assist skipped`, `near-duplicate assist skipped`             | `apps/cli/src/operations.ts:555`        |
| Exec pool kills                 | stderr warning                                                             | `passed its` ... `deadline; its worker was terminated`                 | `apps/cli/src/exec-pool.ts:271-276`     |
| OTLP traces                     | opt-in exporter, spans such as `db.<operation>`                            | set `OTEL_EXPORTER_OTLP_ENDPOINT`                                      | `packages/telemetry/src/index.ts:109`   |
| Doctor report                   | stdout envelope of `memhtml doctor`                                        | `healthy`, `unparseable`, `vectorCoverageLow`, `repaired.failedWrites` | `apps/cli/src/doctor.ts:104`            |

## First-checks ladder

1. Read `.code` from the envelope and the exit status; branch on the code, never the prose. `apps/cli/src/envelope.ts:167-170`
2. Run the `suggestions` the failure carries; they're commands. `apps/cli/src/errors.ts:130-140`
3. Read stderr for `WARN` and `ERROR` lines from the same call. `apps/mcp/src/server.ts:62`
4. Run `memhtml status` and check `indexFresh`; false means `memhtml index update --embed`. `apps/cli/src/operations.ts:2574`
5. Run `memhtml index status` for the watermark and the vector space, which `guardEmbedModel` compares. `packages/index/src/indexer.ts:332`
6. Run `memhtml doctor` and read every finding, including `repaired.failedWrites` after `--fix`. `apps/cli/src/doctor.ts:104`
7. Check whether another writer or head server holds the store: the checkout lock waits up to `CHECKOUT_LOCK_WAIT_MS`, and SQLite busy retries stop at 20 seconds. `packages/contracts/src/checkout-lock.ts:54`
8. When quality is wrong with no error, run `memhtml eval discriminate`, and treat `skipped: true` as unmeasured. `packages/eval/src/run.ts:95-104`
9. Open `.memhtml/index.db` with `sqlite3` directly; it's plain `node:sqlite` storage and a disposable projection of the git tree. `packages/index/src/database.ts:147`
10. As the last and most invasive step, delete `index.db` and run `memhtml index rebuild --embed`; `state.db` isn't rebuildable from git, so leave it alone. `packages/index/src/indexer.ts:181-183`

## Known incident patterns

- **SQLite writer contention:** cron `index update` and a serving process write the same database; the busy retry is safe because `SQLITE_BUSY` means the lock was never taken, and a retry that exhausts its 20-second bound surfaces as `ERR_STORAGE` (`packages/index/src/database.ts:134-149`, `packages/index/src/database.ts:179-185`).
- **Sparse vector plane after `rebuild --no-embed`:** later updates embed only their own batch, so the few embedded files outrank exact matches; the signal is `vectorCoverageLow` in doctor, the mitigation is `memhtml index embed`, and the interlock is `RebuildNoEmbedRefused` (`packages/index/src/indexer.ts:199`). `RUNBOOK.md` section 5 records the incident (issue #141).
- **Truncated envelope on a pipe:** exiting straight after `process.stdout.write` cut a 69 KB manifest mid-string (issue #117); `bin.ts` now exits from the write callback, and `tests-integration/tests/pipe-flush.test.ts` locks it (`apps/cli/src/bin.ts:7-20`).
- **Event time lost on agent writes:** both write doors escaped `<time>` markup, so `files.event_at` stayed NULL and recency ranked by write time; resolved 2026-08-03 by the `articleHtml` passthrough and a render gate that raises `InvalidMemory` before anything is committed (`docs/bugs/2026-08-03-event-at-unreachable-through-write-paths.md:3-5`, `packages/contracts/src/errors.ts:48-49`).
- **Proxy failover:** an LLM proxy briefly failing over gets about two minutes of jittered retries on 408, 429 and 5xx, and the direct Bedrock client uses `maxAttempts: 10` instead (`packages/llm/src/proxy.ts:172-189`, `packages/llm/src/client.ts:139`).
- **Hung sandbox command:** a guest command that ignores its own deadline gets its worker terminated and replaced, and the run reports `killedStderr` (`apps/cli/src/exec-pool.ts:101-102`, `apps/cli/src/exec-pool.ts:271-276`).

## See also

- [impact analysis](impact-analysis.md): 8 shared source citations
- [module map](../architecture/module-map.md): 7 shared source citations
- [REPORT](../REPORT.md): 6 shared source citations
- [processes](../behavior/processes.md): 6 shared source citations
- [sequences](../diagrams/behavioral/sequences.md): 6 shared source citations

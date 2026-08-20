---
title: Configure the environment
description: The eight environment variables memhtml reads, what each one degrades when it is absent, and the SQLite settings every connection applies.
---

All eight variables below are declared in `apps/cli/src/config.ts:26` and reported by `memhtml manifest`, so the authoritative list is one command away on whatever machine you are on:

```bash
memhtml manifest | jq '.data.config'
```

| Variable                   | Default     | Meaning                                                                                                                                                                |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMHTML_ROOT`             | `~/memhtml` | The memory repo. A leading `~` is expanded, because this value arrives from a shell profile, an MCP client config, and a cron line, and only the shell expands tildes. |
| `MEMHTML_TRACE_ROOT`       | `~/.claude` | Where `memhtml trace index` reads transcripts. Read-only; never written.                                                                                               |
| `MEMHTML_AWS_REGION`       | `us-east-1` | Bedrock region for embeddings and the LLM sleep phases.                                                                                                                |
| `AWS_BEARER_TOKEN_BEDROCK` | none        | Read by the AWS SDK itself. Absent means the default credential chain, and retrieval falls back to full-text search rather than failing.                               |
| `MEMHTML_EMBED`            | `on`        | `off` disables the embedder entirely.                                                                                                                                  |
| `MEMHTML_LLM`              | `on`        | `off` makes the three model-driven sleep phases report `no model bound` and `trace-consolidation` report `no consolidator bound`, all staying `ok`.                    |
| `MEMHTML_EXTRACT_ENTITIES` | `off`       | `on` adds one model call per write batch that extracts `memhtml-entity` metas the ops did not declare.                                                                 |
| `MEMHTML_MCP_BIN`          | none        | An explicit path to the `memhtml-mcp` entry point, read only by the serve supervisor (`apps/cli/src/serve.ts:58`).                                                     |

`--repo <path>` overrides `MEMHTML_ROOT` for one call, which is how you operate two stores from one shell.

## Off and absent are different states

`MEMHTML_EMBED` and `MEMHTML_LLM` compare case-insensitively against `off` (`apps/cli/src/api-layer.ts:250`, `apps/cli/src/api-layer.ts:313`). Any other value, including an empty string, leaves the feature on.

A missing credential degrades one search at the moment that search runs, while `MEMHTML_EMBED=off` degrades every search. An operator reading a manifest needs to tell those two apart, so the manifest reports them as different states.

`MEMHTML_LLM=off` is what lets a sleep run finish clean with no credentials at all. Every phase still reports `ok`, and the four that have nothing to do without a model say why:

```
edge-typing           | ok | no model bound
arc-synthesis         | ok | no model bound
compress              | ok | no model bound
trace-consolidation   | ok | no consolidator bound
```

Six phases call a model, and the other two degrade rather than reporting a reason. `dedup-merge` mines at the 0.92 cosine floor, applies the divergence veto, and commits the folds it can prove; `entity-resolution` runs its normalization and character-overlap passes. A credential-free night still curates.

## MEMHTML_EXTRACT_ENTITIES changes what a write stores

This one is opt-in where `MEMHTML_EMBED` ships on, because it changes the files rather than the ranking. Extracted entities land in the files as if an author had written them. The write itself never waits on the model and never fails with it, so a failed extraction leaves a logged warning and a batch with nothing extracted. Run a store with this on for a month and then off, though, and the tree holds two populations of files, only one of which carries entities its author did not write.

## MEMHTML_MCP_BIN locates the server and nothing else

Absent, the supervisor uses the sibling-path default, since the two apps ship as one build. Set it for a split deployment that keeps them apart.

It appears on the manifest despite configuring nothing, because an operator debugging a split deployment reads the manifest, and a variable the binary reads without declaring is one they cannot discover. Its name reaches `CONFIG_VARS` as the imported `MCP_BIN_VAR` constant from `apps/cli/src/serve.ts` rather than as a copied string, so the variable and the supervisor that reads it cannot drift apart.

## The databases

`index.db` and `state.db` are plain SQLite files, opened through node's built-in `node:sqlite`. There is no third-party database dependency and no driver flags to keep in step, so you can inspect a stuck index without this binary: `sqlite3`, a graphical browser, or any other SQLite tool opens both files directly.

Each connection sets four pragmas and registers one SQL function (`packages/index/src/database.ts`):

| Setting               | Value      | Why it matters to you                                                                                                                                                                                          |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journal_mode`        | `WAL`      | One writer at a time, and any number of concurrent readers. Write-ahead logging is a persistent property of the file rather than of the connection, so a store created by any caller ends up in the same mode. |
| `busy_timeout`        | `5000`     | A contended writer waits five seconds before the driver gives up, and the retry layer takes it from there.                                                                                                     |
| `foreign_keys`        | `ON`       | A projection row cannot outlive the file row it hangs off.                                                                                                                                                     |
| `synchronous`         | `NORMAL`   | Can cost the last commits on power loss, which is a fair price for a database the git tree can rebuild.                                                                                                        |
| `vector_distance_cos` | registered | Cosine distance as a SQL function, which is how the vector arm runs inside the single statement that ranks all four arms at once.                                                                              |

That last trade is safe because `index.db` is disposable. `state.db` is the file the git tree cannot rebuild, and its durability comes from the committed sidecar rather than from a pragma. See [preserve the state plane](/learn/operations/preserve-the-state-plane/).

## Cron does not carry your shell profile

Every command is safe to run from cron, because stdout carries one envelope and logs go to stderr. Cron runs without your shell profile, so set the variables on the line itself:

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed >> /var/log/memhtml/index.log 2>&1
```

A `~` in a cron-set value works because the binary expands it, and `$HOME` is the clearer spelling that cron itself expands.

---
title: Configure the environment
description: The eight environment variables memhtml reads, which seven the binary declares, what each one degrades when it is absent, and the SQLite settings every connection applies.
---

memhtml reads eight environment variables and **declares seven** of them. The seven are in
`apps/cli/src/config.ts:26` and are exactly what `memhtml manifest` reports, so the authoritative list
is always one command away on the machine you are on:

```bash
memhtml manifest | jq '.data.config'
```

| Variable | Default | Meaning |
|---|---|---|
| `MEMHTML_ROOT` | `~/memhtml` | The memory repo. A leading `~` is expanded — this value arrives from a shell profile, an MCP client config, and a cron line, and only the shell expands tildes. |
| `MEMHTML_TRACE_ROOT` | `~/.claude` | Where `memhtml trace index` reads transcripts. Read-only; never written. |
| `MEMHTML_AWS_REGION` | `us-east-1` | Bedrock region for embeddings and the LLM sleep phases. |
| `AWS_BEARER_TOKEN_BEDROCK` | — | Read by the AWS SDK itself. Absent means the default credential chain; retrieval degrades to the lexical floor rather than failing. |
| `MEMHTML_EMBED` | `on` | `off` disables the embedder entirely. |
| `MEMHTML_LLM` | `on` | `off` makes the three model-driven sleep phases report `no model bound` and `trace-consolidation` report `no consolidator bound`, all staying `ok`. |
| `MEMHTML_EXTRACT_ENTITIES` | `off` | `on` adds one model call per write batch that extracts `memhtml-entity` metas the ops did not declare. |
| `MEMHTML_MCP_BIN` | — | An explicit path to the `memhtml-mcp` entry point, read only by the serve supervisor (`apps/cli/src/serve.ts:50`). |

`--repo <path>` overrides `MEMHTML_ROOT` for one call, which is how you operate two stores from one
shell.

## Off is not the same as absent

`MEMHTML_EMBED` and `MEMHTML_LLM` compare case-insensitively against `off` (`apps/cli/src/api-layer.ts:242`,
`apps/cli/src/api-layer.ts:305`). Any other value, including an empty string, leaves the feature on.

The distinction the manifest insists on is between a **missing credential** and an **explicit opt-out**:
a missing credential degrades one search at call time, while `MEMHTML_EMBED=off` degrades every search.
An operator reading a manifest needs those to be different states, so they are.

`MEMHTML_LLM=off` is what makes a credential-free sleep run honest rather than red. Every phase still
reports `ok`; the four model-driven ones say why they did nothing:

```
conflict-detection    | ok | no model bound
arc-synthesis         | ok | no model bound
compress              | ok | no model bound
trace-consolidation   | ok | no consolidator bound
```

## MEMHTML_EXTRACT_ENTITIES changes what a write stores

It is opt-in, unlike `MEMHTML_EMBED`, and the reason is that it is not a ranking switch: extracted
entities land **in the files** as if they had been authored. The write itself never waits on or fails
with the model — a failed extraction is a logged warning and an unextracted batch — but a store run with
this on for a month and then off has two populations of files, and only one of them carries entities its
author did not write.

## MEMHTML_MCP_BIN configures no store behaviour, and is disclosed anyway

It locates the server; it changes nothing about retrieval. Absent means the sibling-path default, since
the two apps ship as one build. Set it for a split deployment that does not keep them side by side.

It is the one variable **not** in `CONFIG_VARS`, so `memhtml manifest` does not report it — which is
exactly why it is documented here. An operator debugging a split deployment reaches for the manifest
first, and a variable the binary reads but does not declare is one they would otherwise have no way to
discover.

## The databases

`index.db` and `state.db` are plain SQLite, opened through node's built-in `node:sqlite`. There is no
third-party database dependency and no driver flags to keep in step, which is what makes a stuck index
inspectable without this binary — `sqlite3`, a GUI browser, or any other tool opens both files directly.

Each connection sets four pragmas and registers one SQL function (`packages/index/src/database.ts`):

| Setting | Value | Why it matters to you |
|---|---|---|
| `journal_mode` | `WAL` | One writer at a time, unlimited concurrent readers. A **persistent property of the file**, not of the connection, so a store created by any caller ends up in the same mode. |
| `busy_timeout` | `5000` | A contended writer waits five seconds before the driver gives up; the retry layer takes it from there. |
| `foreign_keys` | `ON` | A projection row cannot outlive the file row it hangs off. |
| `synchronous` | `NORMAL` | Can cost the last commits on power loss. For a projection rebuildable from the git tree, that is not a durability question. |
| `vector_distance_cos` | registered | Cosine distance as a SQL function, which is how the vector arm runs inside the one fused statement. |

`synchronous = NORMAL` deserves the second look it gets here: it is a deliberate trade, and it is
correct **because** `index.db` is disposable. `state.db` is the file that is not rebuildable from git,
and its durability comes from the committed sidecar rather than from a pragma — see [preserve the state
plane](/learn/operations/preserve-the-state-plane/).

## A cron environment is not your shell

Every command is safe to run from cron because stdout carries one envelope and logs go to stderr. What
cron does not carry is your shell profile, so set the variables on the line:

```cron
*/10 * * * *  cd $HOME && MEMHTML_ROOT=$HOME/memhtml memhtml index update --embed >> /var/log/memhtml/index.log 2>&1
```

`~` in a cron-set value works because the binary expands it, but `$HOME` is the clearer spelling and
cron does expand that.

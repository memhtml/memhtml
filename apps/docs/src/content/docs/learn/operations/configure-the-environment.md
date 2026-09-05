---
title: Configure the environment
description: The environment variables memhtml reads, what each one degrades when it is absent, how to route model calls through an LLM proxy, and the SQLite settings every connection applies.
---

Every variable below is declared in `apps/cli/src/config.ts` and reported by `memhtml manifest`, so the authoritative list is one command away on whatever machine you are on:

```bash
memhtml manifest | jq '.data.config'
```

| Variable                               | Default               | Meaning                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMHTML_ROOT`                         | `~/memhtml`           | The memory repo. A leading `~` is expanded, because this value arrives from a shell profile, an MCP client config, and a cron line, and only the shell expands tildes.                                                                                                                                                                                                             |
| `MEMHTML_REFUSE_ENV_ROOT`              | none                  | Set to any value but `0`, `false`, `no`, or `off` (absent or blank is off; case-insensitive) makes `memhtml` take its repo from `--repo` alone. See [close the environment door](#memhtml_refuse_env_root-closes-the-environment-door).                                                                                                                                            |
| `MEMHTML_TRACE_ROOT`                   | `~/.claude`           | Where `memhtml trace index` reads transcripts. Read-only; never written.                                                                                                                                                                                                                                                                                                           |
| `MEMHTML_AWS_REGION`                   | `us-east-1`           | Bedrock region for embeddings and the LLM sleep phases.                                                                                                                                                                                                                                                                                                                            |
| `AWS_BEARER_TOKEN_BEDROCK`             | none                  | Read by the AWS SDK itself. Absent means the default credential chain, and retrieval falls back to full-text search rather than failing.                                                                                                                                                                                                                                           |
| `MEMHTML_LLM_BASE_URL`                 | none                  | An OpenAI- and Anthropic-compatible LLM proxy's origin, such as `http://127.0.0.1:4000` for an agentgateway listener. Set, every model call leaves through it instead of going to Bedrock directly. See [route model calls through an LLM proxy](#route-model-calls-through-an-llm-proxy).                                                                                         |
| `MEMHTML_LLM_API_KEY`                  | none                  | A bearer token for that proxy, sent as `Authorization: Bearer <key>`. Read only when `MEMHTML_LLM_BASE_URL` is set.                                                                                                                                                                                                                                                                |
| `MEMHTML_LLM_MODEL_PREFIX`             | `bedrock/`            | The prefix in front of every Bedrock model id a proxied request carries, so `global.anthropic.claude-opus-5` is asked for as `bedrock/global.anthropic.claude-opus-5`, the LiteLLM convention. Set it to `none` for a proxy that takes bare Bedrock ids. Read only when `MEMHTML_LLM_BASE_URL` is set.                                                                             |
| `MEMHTML_LLM_MODEL_MAP`                | none                  | `from=to` pairs, comma-separated, naming single models to the proxy by exact id when the prefix rule does not fit. A mapped id is sent verbatim, without the prefix. Read only when `MEMHTML_LLM_BASE_URL` is set.                                                                                                                                                                 |
| `MEMHTML_EMBED`                        | `on`                  | `off` disables the embedder entirely.                                                                                                                                                                                                                                                                                                                                              |
| `MEMHTML_VECTOR_COVERAGE_FLOOR`        | `0.95`                | The share of indexed chunks that must carry a vector in the configured space before the vector arm is trusted. Below it search drops the vector arm and reports `degraded: true` with `vectorCoverage`, `doctor` reports `vectorCoverageLow`, and a sleep run warns. Sleep refuses below a fixed `0.5`. See [diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/). |
| `MEMHTML_LLM`                          | `on`                  | `off` makes the model-driven sleep phases of `LLM_PHASES` — eight as of v0.6.0 — report `no model bound` and `trace-consolidation` report `no consolidator bound`, all staying `ok`. `dedup-merge` and `entity-resolution` report counts instead, having deterministic work either way.                                                                                            |
| `MEMHTML_CONSOLIDATOR_TURN_TIMEOUT_MS` | scales with the batch | The whole consolidation turn's budget, in milliseconds. Absent, ten minutes plus three per transcript; set, exactly that. When it expires the client tears down the agent server and its whole process group and the phase reports `ConsolidatorRunFailed`.                                                                                                                        |
| `MEMHTML_EXTRACT_ENTITIES`             | `on`                  | `off` removes the one model call per write batch that extracts `memhtml-entity` metas the ops did not declare; `MEMHTML_LLM=off` removes it too.                                                                                                                                                                                                                                   |
| `MEMHTML_MCP_BIN`                      | none                  | An explicit path to the `memhtml-mcp` entry point, read only by the serve supervisor (`apps/cli/src/serve.ts:58`).                                                                                                                                                                                                                                                                 |

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

## Route model calls through an LLM proxy

By default memhtml calls Bedrock directly: the AWS SDK for embeddings, the sleep phases, and write-time entity extraction, and the AI SDK's Bedrock provider inside the consolidator agent. Set `MEMHTML_LLM_BASE_URL` and every edge goes to one proxy instead, on the routes an OpenAI- and Anthropic-compatible gateway such as agentgateway serves:

| Edge                                               | Route                  | Wire format                                   |
| -------------------------------------------------- | ---------------------- | --------------------------------------------- |
| the Anthropic sleep models, the consolidator agent | `/v1/messages`         | Anthropic Messages                            |
| the OpenAI sleep model, entity extraction          | `/v1/chat/completions` | OpenAI chat completions                       |
| embeddings                                         | `/v1/embeddings`       | OpenAI embeddings, plus Cohere's `input_type` |

The request bodies do not change shape: Bedrock's InvokeModel body for a Claude model already is the Messages body, and its body for an OpenAI model already is the chat-completions body. Only the embedding request is translated, and `input_type` rides through because Cohere embeds documents and queries into different regions of the same space and retrieval depends on that asymmetry. A proxy that drops the `dimensions` field returns 1536-wide vectors, which the width gate refuses as a typed failure, so a misconfigured proxy degrades search and never writes a vector of the wrong shape.

A proxy names models on its own terms, and memhtml asks for Bedrock inference-profile ids. The bridge is the LiteLLM convention: the provider, a slash, and the provider's exact id, so a request for `global.anthropic.claude-opus-5` carries `model: "bedrock/global.anthropic.claude-opus-5"`. The id after the slash is exactly what Bedrock wants, so nothing is stripped and nothing can be stripped wrong, and a LiteLLM proxy routes every such name with one `bedrock/*` entry. For a LiteLLM-style proxy the whole configuration is the origin:

```bash
export MEMHTML_LLM_BASE_URL=http://127.0.0.1:4000
```

Two knobs cover proxies that name models differently. `MEMHTML_LLM_MODEL_PREFIX` replaces the `bedrock/` prefix, and set to `none` it sends bare Bedrock ids. `MEMHTML_LLM_MODEL_MAP` names single models by exact id and wins over the prefix, so one odd model can be named by hand while the rest follow the rule:

```bash
export MEMHTML_LLM_MODEL_PREFIX=none
export MEMHTML_LLM_MODEL_MAP='cohere.embed-v4:0=cohere-embed-v4'
```

An agentgateway listener matches `bedrock/*` as a model pattern but does not rewrite the upstream model, so it needs either one route per name with a per-model override or a body transform that drops the prefix. A proxy that does not know a name answers `model_not_found`, which the failure reason carries verbatim so the missing entry is named. The AWS credential is not consulted on this path: `MEMHTML_LLM_BASE_URL` alone counts as a way to reach a model, so the consolidator runs with no Bedrock credential in the environment, and `MEMHTML_LLM_API_KEY` is the only credential the proxy path reads. A set-but-malformed origin or map entry fails at startup with the variable named rather than falling back to Bedrock directly, so a typo cannot quietly route a night's traffic somewhere you did not point it.

## MEMHTML_EXTRACT_ENTITIES changes what a write stores

This one ships on, like `MEMHTML_EMBED`, and unlike the embedder it changes the files rather than the ranking. Extracted entities land in the files as if an author had written them. The write itself never waits on the model and never fails with it, so a failed extraction leaves a logged warning and a batch with nothing extracted. Run a store with this on for a month and then off, though, and the tree holds two populations of files, only one of which carries entities its author did not write. `MEMHTML_LLM=off` turns it off along with every other model call, which is how a credential-free run stays free of model calls without naming each one.

## MEMHTML_REFUSE_ENV_ROOT closes the environment door

Every command that opens a repo finds it through `--repo`, or failing that through `MEMHTML_ROOT`, or failing that at `~/memhtml`. That second and third door are what a shell profile, an MCP client config, and a cron line rely on, and they are also how an in-process caller reaches a store nobody meant it to: a test suite that calls the CLI without `--repo`, or an agent runtime that exports `MEMHTML_ROOT` to every subprocess it starts, opens whatever the environment names the moment a refusal stops firing.

Set `MEMHTML_REFUSE_ENV_ROOT=1` and those two doors close. The switch fails closed: any value other than `0`, `false`, `no`, or `off` turns it on, and only absent or blank leaves it off, so a spelling it does not know cannot quietly reopen the door. A call that opens a repo without `--repo` is refused with `ERR_REPO_REQUIRED` at exit 2 before anything is opened, and the suggestion is the flag spelling. `manifest`, `help`, `agents-doc`, and `eval discriminate` never open a repo and answer as before. The variable is read by `memhtml` only: `memhtml-mcp` takes its root from `MEMHTML_ROOT`, which `memhtml serve mcp --repo <path>` sets for the child explicitly, so a supervised server still starts. It governs the roots `memhtml` resolves from its own environment; a program that hands the in-process `run()` a layer it built states that layer's root itself.

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

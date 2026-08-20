---
title: The envelope contract
description: One JSON envelope per command, append-only response types and error codes, and a tool surface whose two hard constraints come from the transport rather than from taste.
---

## 1. One envelope, three exit codes

Every command writes one JSON envelope to stdout and nothing else. Logs go to stderr. The exit code is 0 for success, 2 for a usage error, and 1 for a runtime error (`apps/cli/src/envelope.ts:87-89`).

`AGENTS.md` is generated from the same `COMMANDS` array that drives argument parsing (`apps/cli/src/agents-doc.ts:24`), so it is the reference for the command list and cannot drift from the live answer. Adding a command means editing that one array.

:::agent

**For an agent.** Branch on `code` and on the exit code, and never on the `error` string. The codes are append-only and a shipped one never changes meaning, while the prose is rewritten whenever the wording improves, so a matcher against it passes until someone edits a sentence. Exit 2 means change the call and exit 1 means change the store or the environment. The two need different recovery, and conflating them retries a call that cannot succeed.

:::

## 2. `apiVersion` and `type`

`apiVersion` lets the envelope evolve without silently breaking parsers. `type` is a discriminator an agent reads to learn the shape of `data` before parsing it (`apps/cli/src/envelope.ts:1-6`).

`RESPONSE_TYPES` (`apps/cli/src/envelope.ts:12`) and `ERROR_CODES` (`apps/cli/src/envelope.ts:66`) are both append-only. Once shipped, a value's meaning never changes and the value is never removed, because agents branch on `code` and never on the human-readable `error` string, which changes freely as the wording improves.

`--dense` strips nulls and indentation (`apps/cli/src/envelope.ts:143`), and an unknown argument comes back with the Levenshtein-nearest candidates (`apps/cli/src/envelope.ts:124`) rather than with a dead end.

## 3. One translation from a typed failure to a code

`failureFor` (`apps/cli/src/errors.ts:154`) is the only translation, and it is total: an unrecognized `_tag` becomes `ERR_UNKNOWN` rather than an empty response (`apps/cli/src/errors.ts:41`).

The human message is narrow (`apps/cli/src/errors.ts:69-77`). Every payload field it names is one a caller can act on: a path to re-read, two shas to reconcile, a model to check. Each typed error class drops the driver message, the SQL, the git argv, and the memory body at its adapter edge, so a tool response cannot carry corpus content (`packages/contracts/src/errors.ts:3-8`, `packages/index/src/database.ts:87-91`).

Suggestions are part of the contract (`apps/cli/src/errors.ts:111-127`), so an agent receiving `ERR_INDEX_STALE` can recover in one step without a round trip to a human. An absent list is `[]` rather than null.

Per-operation batch codes are mapped once, in the operations layer (`apps/cli/src/operations.ts:367-381`), so `memhtml apply` and `memory_write_batch` cannot report different codes for one refused operation.

## 4. The tool surface

The MCP tools are built with `Tool.make` and collected by `Toolkit.make` (`apps/mcp/src/tools.ts:712`). The [MCP tools reference](/reference/mcp-tools/) lists them, generated from that registry, so it states how many there are and this page does not. Two resources come with them: `memhtml://file/{path}` for citation-grade drill-down and `memhtml://sleep/{run-id}` for a run report (`apps/mcp/src/resources.ts:90`).

Sleep stays off the tool surface, because it is an operator action that produces a branch for a human to review.

Two things about the server come from the transport and the SDK rather than from a preference:

- `Logger.LogToStderr` is mandatory (`apps/mcp/src/server.ts:20-22`). The default logger writes to stdout, and stdout here is the newline-delimited JSON-RPC stream, so one log line corrupts the frame a client is mid-parse on.
- Tool descriptions are the only server-level channel for guidance (`apps/mcp/src/server.ts:24-38`). MCP defines an `instructions` field on the initialize response and the SDK's handler does not emit it, so `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` are shared constants appended to every description they apply to (`apps/mcp/src/tools.ts:124`, `apps/mcp/src/tools.ts:155`). That is why they read as prose addressed to an agent rather than as notes to a maintainer.

## 5. A declared failure schema is what lets prose through

Tool failures are a declared `Schema.ErrorClass` (`apps/mcp/src/failure.ts:31`). Of the SDK's three catch branches for a failed `tools/call`, only the branch reached by a value the tool's own `failureSchema` accepts passes prose through verbatim. A generic error is rewritten to an internal-server-error sentence, which leaves an agent holding a message with nothing in it to act on.

Code, message, and suggestions fold into `.message` at construction, because MCP's tool-error channel is one text block. The `ERR_*` code goes first so a consumer can read it back off the prefix.

## 6. Guidance and the sugar commands

The CLI's own guidance lives in the manifest's `guide` blocks (`apps/cli/src/commands.ts:839`) and is rendered into `AGENTS.md` by the same generator (`apps/cli/src/agents-doc.ts:52`), so the document and the live answer cannot disagree.

The `memhtml task` family is sugar over the same use cases. `task add` is `write --type task`. `task status` edits one head meta and routes `done` through the archive machinery. `task list` is a direct indexed scan that never enters retrieval, backed by a partial index over live tasks (`packages/index/migrations/0008_tasks.sql:136-137`).

`memhtml link` accepts the task rels, and `memory_link` refuses one while decoding its arguments. That is the class rule from [edge encoding](/internals/edge-encoding/) expressed at the tool boundary.

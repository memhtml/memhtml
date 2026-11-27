---
title: The envelope contract
description: One JSON envelope per command, response types and error codes that are append-only by the project's rule, and a tool surface where stdout is the JSON-RPC stream and tool descriptions carry the guidance.
---

## 1. One envelope, three exit codes

Every command writes one JSON envelope to stdout and nothing else, with three exceptions. `memhtml help`, or `--help` on any command, writes Markdown on a terminal, and piped or with `--json` it is an envelope like every other command. `memhtml serve mcp` gives stdout to the MCP server it supervises (`apps/cli/src/serve.ts::serveMcp`). When the server exits, the command writes a `serve.exit` envelope carrying the server's exit code, and exits 0 whatever that code is. `memhtml hook` writes the host's own hook protocol and exits 0 on a runtime failure (`packages/integrations/src/dialect.ts::renderHookOutput`, `apps/cli/src/run.ts::run`); a usage error still gets an envelope, at exit 2. Otherwise the exit code is 0 for success, 2 for a usage error, and 1 for a runtime failure (`apps/cli/src/envelope.ts::EXIT_OK`, `apps/cli/src/envelope.ts::EXIT_USAGE`, `apps/cli/src/envelope.ts::EXIT_RUNTIME`). Logs go to stderr.

`AGENTS.md` is generated from the same `COMMANDS` array that drives argument parsing (`apps/cli/src/agents-doc.ts::renderAgentsDoc`), so it is the reference for the command list, and a test fails whenever the committed file differs from what the generator renders (`apps/cli/tests/agents-doc.test.ts`). Adding a command starts with an entry in that array for its name, flags, and help.

:::agent

**For an agent.** Branch on `code` and on the exit code, and never on the `error` string. The project's rule is that codes are append-only and a shipped one never changes meaning, while the prose is rewritten whenever the wording improves, so a matcher against it passes until someone edits a sentence. Exit 2 means the call was refused as written. Exit 1 means a refusal or a failure the command met while it ran. Which one a refusal gets depends on where it is found (`apps/cli/src/run.ts::run`), so one code can come at either exit. A path that holds no memory, or a rel the command does not know, exits 1 and is fixed by changing the call. Read `code` before retrying, because retrying a call that cannot succeed only repeats the refusal.

:::

## 2. `apiVersion` and `type`

`apiVersion` lets the envelope evolve without silently breaking parsers (`apps/cli/src/envelope.ts::API_VERSION`). `type` is a discriminator an agent reads to learn the shape of `data` before parsing it, and only a success carries it: a success is `apiVersion`, `type`, and `data`, and a failure is `apiVersion`, `error`, `code`, and `suggestions` (`apps/cli/src/envelope.ts::Success`, `apps/cli/src/envelope.ts::Failure`).

`RESPONSE_TYPES` (`apps/cli/src/envelope.ts::RESPONSE_TYPES`) and `ERROR_CODES` (`apps/cli/src/envelope.ts::ERROR_CODES`) are both append-only by the project's rule, which review keeps rather than a test. Once shipped, a value's meaning never changes and the value is never removed, because agents branch on `code` and never on the human-readable `error` string, which changes freely as the wording improves.

`--dense` drops every object field whose value is null, at any depth, and the indentation, while empty arrays such as `suggestions: []` stay (`apps/cli/src/envelope.ts::stripNulls`). An unknown command, an unknown flag, or a value outside a flag's closed list comes back with the Levenshtein-nearest candidates in `suggestions` when any are close (`apps/cli/src/envelope.ts::nearest`), so a typo is not a dead end.

## 3. One translation from a typed failure to a code

`codeFor` (`apps/cli/src/errors.ts::codeFor`) is the only translation, and it is total: an unrecognized `_tag` becomes `ERR_UNKNOWN` rather than an empty response. `failureFor` builds a failure envelope from it (`apps/cli/src/errors.ts::failureFor`), and the batch reports and the MCP tool failure call it directly (`apps/mcp/src/failure.ts::toToolFailure`).

The human message is narrow (`apps/cli/src/errors.ts::messageFor`). Every payload field it names is one a caller can act on: a path to re-read, two shas to reconcile, a model to check. A storage or git failure drops the driver message, the SQL, the git argv, and the memory body at its adapter edge, so its message names an operation or a command rather than corpus content (`packages/contracts/src/errors.ts::StorageFailure`, `packages/contracts/src/errors.ts::GitFailure`, `packages/index/src/database.ts::asStorageFailure`).

Suggestions are part of the contract (`apps/cli/src/errors.ts::SUGGESTIONS`), so an agent receiving `ERR_INDEX_STALE` can recover in one step without a round trip to a human. An absent list is `[]` rather than null.

Per-operation batch codes come from one pair of functions, `codeFor` and `messageFor`, called by the operations layer (`apps/cli/src/operations.ts::reportFailure`) and by the MCP handler for the refusals it finds before that layer runs (`apps/mcp/src/handlers.ts::xorReport`), so `memhtml apply` and `memory_write_batch` report the same code for one refused operation. The wrapper differs: an atomic `apply` answers a success envelope whose results carry the code, and an atomic `memory_write_batch` answers a tool error whose text starts with the code and names the failing operation.

## 4. The tool surface

The MCP tools are built with `Tool.make` and collected by `Toolkit.make` (`apps/mcp/src/tools.ts::MemhtmlToolkit`). The [MCP tools reference](/reference/mcp-tools/) lists them, generated from that registry, so it states how many there are and this page does not. Two resource templates come with them, listed by `resources/templates/list` rather than by `resources/list`: `memhtml://file/{path}` for citation-grade drill-down and `memhtml://at/{commit}/{path}` for the same drill-down at a commit, whose bytes cannot move (`apps/mcp/src/resources.ts`).

Curation stays off the tool surface, because it is an operator action that produces a branch for a human to review.

Two things about the server explain how it is written:

- `Logger.LogToStderr` is mandatory (`apps/mcp/src/server.ts::layerServer`). The default logger writes to stdout, and stdout here is the newline-delimited JSON-RPC stream, so one log line corrupts the frame a client is mid-parse on.
- Tool descriptions are the only server-level channel for guidance today (`apps/mcp/src/server.ts::layerServer`). MCP defines an `instructions` field on the initialize response, and the SDK's `McpServer.layerStdio` takes an `instructions` option and returns it from initialize, but the server passes none. So `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` are shared constants appended to every description they apply to (`apps/mcp/src/tools.ts::BATCH_GUIDANCE`, `apps/mcp/src/tools.ts::ARTICLE_HTML_CONTRACT`). That is why they read as prose addressed to an agent rather than as notes to a maintainer.

## 5. A declared failure schema is what lets prose through

Tool failures are a declared `Schema.TaggedError` (`apps/mcp/src/failure.ts::ToolFailure`). The SDK's `tools/call` handler sorts a failure by where it came from, and only a value the tool's own `failureSchema` accepts comes back as a tool result whose text is its `.message`, verbatim. Arguments that do not decode come back as a JSON-RPC error instead of a tool result, and anything else, a defect included, is rewritten to an internal-server-error sentence, which leaves an agent holding a message with nothing in it to act on.

Code, message, and suggestions fold into `.message` at construction, because MCP's tool-error channel is one text block. The `ERR_*` code goes first so a consumer can read it back off the prefix.

## 6. Guidance and the sugar commands

The CLI's own guidance lives in the manifest's `guide` blocks (`apps/cli/src/commands.ts::GUIDE`) and is rendered into `AGENTS.md` by the same generator (`apps/cli/src/agents-doc.ts::guideLines`), so the document and the live answer agree whenever the committed `AGENTS.md` passes its drift test (`apps/cli/tests/agents-doc.test.ts`).

The `memhtml task` family is sugar over the same use cases. `task add` writes through the use case `write --type task` uses, to the same place, and adds `--status` and `--due` (`apps/cli/src/operations.ts::writeMemory`). `task status` edits one head meta and routes `done` through the archive machinery (`apps/cli/src/operations.ts::setTaskStatus`), and a task already under `archive/` keeps its status. `task list` is a direct indexed scan that never enters retrieval, over the partial indexes on live rows that `packages/index/migrations/0008_tasks.sql` creates, and `--include-archived` reads past them (`apps/cli/src/operations.ts::listTasks`).

`memhtml link` accepts the task rels, and `memory_link` refuses one while decoding its arguments. That is the class rule from [edge encoding](/internals/edge-encoding/) expressed at the tool boundary.

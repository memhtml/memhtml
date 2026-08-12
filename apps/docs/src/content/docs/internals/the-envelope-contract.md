---
title: The envelope contract
description: One JSON envelope per command, append-only response types and error codes, and a tool surface whose two hard constraints come from the transport rather than from taste.
---

## 1. One envelope, three exit codes

Every command writes one JSON envelope to stdout and nothing else; logs go to stderr. Exit codes are
0 / 2 / 1 for success / usage / runtime (`apps/cli/src/envelope.ts:87-89`).

`AGENTS.md` is generated from the same `COMMANDS` array that drives parsing
(`apps/cli/src/agents-doc.ts:24`), so it is the reference for the command list and cannot drift from the
live answer. Adding a command means editing that one array.

:::agent
**For an agent.** Branch on `code` and on the exit code, never on the `error` string. The codes are
append-only and a shipped one never changes meaning; the prose is rewritten whenever the wording
improves, so a matcher against it passes until someone edits a sentence. Exit 2 means change the call,
exit 1 means change the store or the environment — the two need different recovery and conflating them
retries a call that cannot succeed.
:::

## 2. `apiVersion` and `type`

`apiVersion` lets the envelope evolve without silently breaking parsers, and `type` is a discriminator an
agent reads to know the shape of `data` before parsing it (`apps/cli/src/envelope.ts:1-6`).

Both `RESPONSE_TYPES` (`apps/cli/src/envelope.ts:12`) and `ERROR_CODES`
(`apps/cli/src/envelope.ts:66`) are **append-only**: once shipped, a code's meaning never changes and a
code is never removed, because agents branch on `code` and never on the human `error` string, which
changes freely as wording improves.

`--dense` strips nulls and indentation (`apps/cli/src/envelope.ts:143`), and an unknown argument comes
back with Levenshtein-nearest candidates (`apps/cli/src/envelope.ts:124`) rather than a dead end.

## 3. One translation from a typed failure to a code

`failureFor` (`apps/cli/src/errors.ts:154`) is the only translation, total by construction: an
unrecognized `_tag` becomes `ERR_UNKNOWN` rather than an empty response
(`apps/cli/src/errors.ts:41`).

The human message is deliberately narrow (`apps/cli/src/errors.ts:69-77`) — every payload field it names
is one a caller can act on: a path to re-read, two shas to reconcile, a model to check. It never carries
the driver's message, the SQL, the git argv, or any memory body, because each typed error class already
dropped those at its adapter edge precisely so a tool response could not carry corpus content
(`packages/contracts/src/errors.ts:3-8`, `packages/index/src/database.ts:87-91`).

Suggestions are part of the contract (`apps/cli/src/errors.ts:111-127`), so an agent receiving
`ERR_INDEX_STALE` can recover in one step without a round trip to a human; an absent list is `[]`, never
null.

Per-op batch codes are mapped **once**, in the operations layer
(`apps/cli/src/operations.ts:367-381`), so `memhtml apply` and `memory_write_batch` cannot report
different codes for one refused op.

## 4. The tool surface

Fourteen MCP tools are built with `Tool.make` and collected by `Toolkit.make`
(`apps/mcp/src/tools.ts:712`), plus two resources — `memhtml://file/{path}` for citation-grade drill-down
and `memhtml://sleep/{run-id}` for a run report (`apps/mcp/src/resources.ts:90`).

Sleep is not an agent tool: it is an operator action producing a reviewable branch.

Two things about the server are forced by the transport and the SDK rather than chosen:

- **`Logger.LogToStderr` is mandatory** (`apps/mcp/src/server.ts:20-22`). The default logger writes to
  stdout, and stdout here is the NDJSON-RPC stream — one log line corrupts the frame a client is
  mid-parse on.
- **Tool descriptions are the only server-level guidance channel**
  (`apps/mcp/src/server.ts:24-38`). MCP defines an `instructions` field on the initialize response and
  the SDK's handler does not emit it, so `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` are shared
  constants appended to every description they apply to (`apps/mcp/src/tools.ts:124`,
  `apps/mcp/src/tools.ts:155`) — which is why they read as prose to an agent rather than as notes to a
  maintainer.

## 5. A declared failure schema is what lets prose through

Tool failures are a declared `Schema.ErrorClass` (`apps/mcp/src/failure.ts:31`), and that is
load-bearing: of the SDK's three catch branches for a failed `tools/call`, only the one reached by a value
the tool's own `failureSchema` accepts passes prose through verbatim — a generic error is rewritten to an
internal-server-error sentence, which is the difference between an agent that can recover and an agent
that reads a sentence with no content in it.

Code, message, and suggestions fold into `.message` at construction because MCP's tool-error channel is
one text block, with the `ERR_*` code first so a consumer can read it back off the prefix.

## 6. Guidance and the sugar commands

The CLI's own guidance lives in the manifest's `guide` blocks (`apps/cli/src/commands.ts:762`), rendered
into `AGENTS.md` by the same generator (`apps/cli/src/agents-doc.ts:52`), so the doc and the live answer
cannot disagree.

The `memhtml task` family is sugar over the same use cases: `task add` is `write --type task`,
`task status` edits one head meta and routes `done` through the archive machinery, and `task list` is a
direct indexed scan that never enters retrieval, backed by a partial index over live tasks
(`packages/index/migrations/0008_tasks.sql:136-137`).

`memhtml link` accepts the task rels; `memory_link` does not, refusing one at decode — the class rule
from [edge encoding](/internals/edge-encoding/) expressed at the tool boundary.

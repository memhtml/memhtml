---
title: Packages and dependency direction
description: The layering, the test that enforces the pure packages' purity, and the single place every service is wired together.
---

## 1. The packages

| Package | Role |
|---|---|
| `contracts` | Schemas, enums, errors, path algebra. Zero I/O. |
| `domain` | Pure math: retention, decay, rank fusion, diversification, graph analysis, merge guards. |
| `html` | Parse, serialize, hash, and byte-splice the memory file format. |
| `store` | Git-backed file store: write, read, correct, archive, link, commit. |
| `index` | SQLite service, migrations, indexer, projection, retrieval. |
| `traces` | Streaming session-JSONL parser and scanner. |
| `sleep` | The fifteen curation phases, each a git commit. |
| `llm` | Bedrock embeddings and forced-tool structured output. |
| `eval` | The retrieval quality gate and its generated fixture corpus. |
| `apps/cli`, `apps/mcp` | The `memhtml` binary and the `memhtml-mcp` stdio server. |

## 2. Direction

Dependencies point inward. `contracts` imports only `effect`. `domain` and `html` import `contracts`.
`store` adds `html`. `index` adds `domain` and `llm`. `traces`, `sleep`, and `eval` sit above `index`.

```
contracts ← domain, html ← store ← index (+domain, +llm) ← traces, sleep, eval ← apps/cli ← apps/mcp
```

TypeScript project references enforce the direction rather than convention doing it, and a second,
test-inclusive typecheck configuration applies the same check to the test files.

`apps/mcp` depends on `@memhtml/cli` instead of composing the service graph again, so there is one answer
to which database, which git root, and which vector space (`apps/mcp/src/server.ts:13-18`).

## 3. Purity is a test rather than a convention

`packages/domain/tests/layering.test.ts` greps the emitted `dist/*.js` for a runtime import of
`node:sqlite`, `@aws-sdk`, or `node:fs`. Math that needed infrastructure in order to be tested would let
a caller's I/O failure surface as a scoring bug.

The same grep pins the storage engine. Both database planes are plain SQLite reached through node's
built-in `node:sqlite`, and a package that is meant to be pure cannot name a driver at all.

## 4. One composition root, and the one cycle it breaks

`AppLive` (`apps/cli/src/api-layer.ts:67-90`) wires every service. The design's one dependency cycle is
broken there. The store needs a SQL lookup to answer whether some content already exists, and
`@memhtml/store` contains no SQL, so the lookup arrives as a function passed in.

Two other functions arrive the same way and for the same reason. One is the `onMove` hook the store calls
at the single place a path can change, which keeps the state plane's keys in step
(`packages/store/src/store.ts:160-168`, `apps/cli/src/api-layer.ts:203`). The other is the session-link
recorder. Each keeps a layer's dependency direction intact while letting the composition root state the
wiring in one visible place.

## 5. The consolidator sits outside the graph

`apps/consolidator` is the agent that distils candidate memories from raw transcripts, and it is the one
package outside the service graph above. It composes a sandboxed agent rather than a layer of the store.
Its behaviour is a prompt, reproduced in [The consolidator](/internals/the-consolidator/), and its output
contract is a schema (`apps/consolidator/src/contract.ts:93`,
`apps/consolidator/src/contract.ts:133`) that the sleep pipeline's trace-consolidation phase consumes.

---
title: Packages and dependency direction
description: The layering, the enforced purity of the pure packages, and the single composition root.
---

## 1. The packages { #the-packages }

| Package | Role |
|---|---|
| `contracts` | Schemas, enums, errors, path algebra. Zero I/O. |
| `domain` | Pure math: retention, decay, RRF, MMR, graph, merge guards. |
| `html` | Parse, serialize, hash, and byte-splice the memory file format. |
| `store` | Git-backed file store: write, read, correct, archive, link, commit. |
| `index` | SQLite service, migrations, indexer, projection, retrieval. |
| `traces` | Streaming session-JSONL parser and scanner. |
| `sleep` | The fifteen curation phases, each a git commit. |
| `llm` | Bedrock embeddings and forced-tool structured output. |
| `eval` | The discrimination gate and its generated fixture corpus. |
| `apps/cli`, `apps/mcp` | The `memhtml` binary and the `memhtml-mcp` stdio server. |

## 2. Direction { #direction }

Arrows point inward. `contracts` imports only `effect`; `domain` and `html` import `contracts`;
`store` adds `html`; `index` adds `domain` and `llm`; `traces`, `sleep`, and `eval` sit above
`index`.

```
contracts ← domain, html ← store ← index (+domain, +llm) ← traces, sleep, eval ← apps/cli ← apps/mcp
```

The direction is enforced by TypeScript project references rather than by convention, and it is
checked with tests included through a second, test-inclusive typecheck configuration.

`apps/mcp` depends on `@memhtml/cli` rather than re-composing the service graph, so there is one
answer to which database, which git root, which vector space
(`apps/mcp/src/server.ts:13-18`).

## 3. Purity is a test, not a convention { #purity-is-a-test-not-a-convention }

`@memhtml/domain`'s purity is enforced: `packages/domain/tests/layering.test.ts` greps the emitted
`dist/*.js` for a runtime import of `node:sqlite`, `@aws-sdk`, or `node:fs`. Math that needed
infrastructure to test would let a caller's I/O failure surface as a scoring bug.

The same grep is what pins the storage engine: both planes are plain SQLite reached through node's
built-in `node:sqlite`, and a package that is supposed to be pure cannot name a driver at all.

## 4. One composition root, and the one cycle it breaks { #one-composition-root-and-the-one-cycle-it-breaks }

`AppLive` (`apps/cli/src/api-layer.ts:67-90`) wires every service. The design's one dependency cycle
is broken there: the store needs a SQL lookup to answer "does this content already exist" and
`@memhtml/store` is SQL-free, so the lookup arrives as an injected function.

Two other injected functions arrive by the same route and for the same reason — the access-plane
`onMove` hook the store calls at the one place a path can change
(`packages/store/src/store.ts:160-168`, `apps/cli/src/api-layer.ts:203`), and the session-link
recorder. Each keeps a layer's dependency direction intact while letting the composition root state
the wiring in one visible place.

## 5. The consolidator sits outside the graph { #the-consolidator-sits-outside-the-graph }

`apps/consolidator` is the agent that distils candidate memories from raw transcripts, and it is the
one package outside the service graph described above: it composes a sandboxed agent rather than a
layer of the store. Its behaviour is a prompt, reproduced in
[The consolidator](/internals/the-consolidator/), and its output contract is a schema
(`apps/consolidator/src/contract.ts:93`, `apps/consolidator/src/contract.ts:133`) that the sleep
pipeline's trace-consolidation phase consumes.

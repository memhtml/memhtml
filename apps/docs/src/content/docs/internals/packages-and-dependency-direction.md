---
title: Packages and dependency direction
description: The layering, the test that enforces the pure packages' purity, the single place every service is wired together, and why twelve packages ship as one.
---

## 1. The packages

| Package                | Role                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `contracts`            | Schemas, enums, errors, path algebra. Zero I/O.                                          |
| `domain`               | Pure math: retention, decay, rank fusion, diversification, graph analysis, merge guards. |
| `html`                 | Parse, serialize, hash, and byte-splice the memory file format.                          |
| `store`                | Git-backed file store: write, read, correct, archive, link, commit.                      |
| `index`                | SQLite service, migrations, indexer, projection, retrieval.                              |
| `traces`               | Streaming session-JSONL parser and scanner.                                              |
| `sleep`                | The seventeen curation phases, each a git commit.                                        |
| `llm`                  | Bedrock embeddings and forced-tool structured output.                                    |
| `eval`                 | The retrieval quality gate and its generated fixture corpus.                             |
| `apps/cli`, `apps/mcp` | The `memhtml` binary and the `memhtml-mcp` stdio server.                                 |

## 2. Direction

Dependencies point inward. `contracts` imports only `effect`. `domain` and `html` import `contracts`. `store` adds `html`. `index` adds `domain` and `llm`. `traces`, `sleep`, and `eval` sit above `index`.

```
contracts ← domain, html ← store ← index (+domain, +llm) ← traces, sleep, eval ← apps/cli ← apps/mcp
```

TypeScript project references enforce the direction, and a second, test-inclusive typecheck configuration applies the same check to the test files.

`apps/mcp` depends on `@memhtml/cli` instead of composing the service graph again, so there is one answer to which database, which git root, and which vector space (`apps/mcp/src/server.ts:13-18`).

## 3. A test enforces purity

`packages/domain/tests/layering.test.ts` greps the emitted `dist/*.js` for a runtime import of `node:sqlite`, `@aws-sdk`, or `node:fs`. Math that needed infrastructure in order to be tested would let a caller's I/O failure surface as a scoring bug.

The same grep pins the storage engine. Both database planes are plain SQLite reached through node's built-in `node:sqlite`, and a package that is meant to be pure cannot name a driver at all.

## 4. One composition root, and the one cycle it breaks

`AppLive` (`apps/cli/src/api-layer.ts:67-90`) wires every service. The design's one dependency cycle is broken there. The store needs a SQL lookup to answer whether some content already exists, and `@memhtml/store` contains no SQL, so the lookup arrives as a function passed in.

Two other functions arrive the same way and for the same reason. One is the `onMove` hook the store calls at the single place a path can change, which keeps the state plane's keys in step (`packages/store/src/store.ts:174-181`, `apps/cli/src/api-layer.ts:209`). The other is the session-link recorder. Each keeps a layer's dependency direction intact while letting the composition root state the wiring in one visible place.

## 5. The consolidator sits outside the graph

`apps/consolidator` is the agent that distills candidate memories from raw transcripts, and it is the one package outside the service graph above. It composes a sandboxed agent rather than a layer of the store. Its behavior is a prompt, reproduced in [The consolidator](/internals/the-consolidator/), and its output contract is a schema (`apps/consolidator/src/contract.ts:93`, `apps/consolidator/src/contract.ts:133`) that the sleep pipeline's trace-consolidation phase consumes.

## 6. Twelve packages, one published package

Every package above is `private`. `npm publish` refuses a private package, so none of them can reach a registry, and one assembled `memhtml` is published instead — carrying two binaries, `memhtml` and `memhtml-mcp`. The layering on this page is the shape of the SOURCE. It is not a distribution surface, and the nine libraries had no consumer outside this repository to be a surface for.

The published contract is the two binaries and the JSON envelope they write. The package declares no `exports` map, deliberately: an entry point is a promise, adding one later is a minor version bump, and removing one is a major, so the reversible direction is the one left open.

Assembly bundles the twelve with [tsdown](https://tsdown.dev) and copies out the files that cannot be bundled. Three things resolve a path from their own module location at run time — the index's two migration directories, the CLI's `guest/corpus.mjs`, and the consolidator's `prompts/instructions.md` read by `src/instructions.ts`, with the rest of that sentence: `../../src/*.js` — and after bundling that location is `dist/`, so each is copied to the package root one level above it. Two dependencies additionally stay outside the bundle because their FILES are read rather than imported: `node-html-parser`, read as bytes into the QuickJS guest that [code-mode](/internals/the-envelope-contract/) runs, and `highlight.js`, loaded through `createRequire` on the first language detection. A third, `eve`, is spawned rather than imported.

The artifact has a gate of its own, because no other tier can see it. Every suite described in [Testing posture](/internals/testing-posture/) resolves `@memhtml/*` through the workspace, where each asset is present whether or not anything declares it. `mise run package:smoke` installs the tarball into a throwaway directory and drives every command, every MCP tool, and every published MCP resource template through the installed binary — 66 checks as of v0.6.0. All three surfaces are ENUMERATED from the artifact itself, out of `memhtml manifest`, `tools/list`, and `resources/templates/list`, so a new command, tool, or template fails a census rather than going untested. The script names no count of its own; it reports `checks: results.length`.

The resource surface needs its own coverage because `resources/read` is a second RPC family with a router of its own, and no tool check reaches it. A route's named parameter stops at the next `/` while every memory path is multi-segment, so the whole resource surface can be unreachable from an install with every other check green — which is why the read census also refuses a single-segment test value before it believes a read.

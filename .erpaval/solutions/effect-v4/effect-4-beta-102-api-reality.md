# Effect 4.0.0-beta.102 — API facts that differ from recall and from the packet sketches

**Tags**: effect, effect-v4, schema, structured-output, mcp
**Modules**: all packages

## The rules (each cost a task real debugging time)

1. **`Effect.either` does not exist.** Use `Effect.result` → `Result` with `_tag:
   "Success"|"Failure"`, fields `.success`/`.failure`, guards `Result.isSuccess`/`isFailure`.
2. **`Schema.decodeUnknownEffect` accepts and strips excess properties by default.** For any
   LLM/tool-payload decode pass `{onExcessProperty: "error"}` explicitly, or a model answering a
   neighbouring schema decodes "successfully" (`packages/llm/src/structured.ts`).
3. **`Schema.Finite`, not `Schema.Number`, in JSON-Schema-derived surfaces** — `Number` derives an
   `anyOf` with a string branch for `"Infinity"`/`"NaN"`.
4. **`Schema.toJsonSchemaDocument`** exists on `Schema` and hoists nested structs to `$defs`;
   Bedrock resolves a root-level `$defs` inside `input_schema` (probed live), so inline the defs
   into the tool schema root.
5. **`Layer.provideMerge(that)` feeds `that` into `self`** — chaining "bottom-up" typechecks and is
   wrong (leaves the lowest service unsatisfied at runtime). Compose top-down; see
   `apps/cli/src/api-layer.ts:325`.
6. **`Schema.optional` publishes a `null` branch its own decoder rejects** on the MCP wire — use
   `NullOr` where clients send null for absent optionals, and test decode-acceptance of the
   *published* schema, never byte-compare fixtures.
7. **`effect/Config` snapshots `process.env`** — setting an env var after module init is ignored;
   in tests, set env before importing/building the layer.
8. `effect/unstable/ai` (`McpServer.layerStdio`, `Tool.make`, `Toolkit.make`) and
   `effect/unstable/cli` are real and sufficient — no `@modelcontextprotocol/sdk`, no `@effect/cli`.
   Effect's default logger writes to stdout, which IS the MCP RPC stream — `Logger.LogToStderr` in
   any stdio server.

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
9. **A typed error is `Schema.TaggedError<Self>()("Tag", fields)`** — note the empty `()` before the
   tag, and note that it supplies `_tag` itself, so a `_tag: Schema.tag("Tag")` entry in `fields` is
   wrong. `Schema.ErrorClass` does not exist. Instances are `instanceof Error` and `Schema.is` accepts
   them while REJECTING a plain `Error`, which is what lets `apps/mcp/src/failure.ts` tell a typed
   failure from a defect.
10. **`McpServer.layerStdio` requires `protocols`** — a non-empty array of `McpProtocol.ProtocolAdapter`,
    and `McpProtocol.v2025_06_18` is the only one shipped. The MCP `instructions` initialize field is
    still declared in `McpSchema` with no argument to supply it, so tool descriptions remain the only
    guidance channel.
11. **`toJsonSchemaDocument`'s generated `$defs` keys are not a contract** — the encoding-name
    convention changes between releases (`CandidateMemoryJsonEncoding` → `CandidateMemoryEncoded`).
    Assert that a `$ref` RESOLVES to a definition of the expected shape, never the derived name.

Versions this was verified against: 1-8 on 4.0.0-beta.102, 9-11 on 4.0.0-beta.107. Rules 1-8 still
hold on beta.107. The three Effect packages move as ONE catalog set; `minimumReleaseAge: 1440` blocks
a release for its first 24 hours, so the newest version is often not today's option.

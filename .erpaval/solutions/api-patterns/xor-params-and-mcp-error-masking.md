# XOR tool parameters: where the guard lives, the test that discriminates, and what the wire hides

**Tags**: mcp, xor, optional-params, mutation-testing, error-codes, cli, declared-failure-schema
**Modules**: apps/mcp, apps/cli

## The rules

1. **An XOR over two optional params cannot make either schema-required.** `memory_write.required`
   drops to `["title","memory_type"]`; the XOR is a handler-level runtime refusal, never a schema
   union ("exactly one of" derives confusing JSON Schema).
2. **"Blank counts as absent" needs an asymmetric test to be real.** Refusal tests (both supplied /
   neither supplied) pass under a presence-only `!== undefined` check too — a mutant dropping the
   `.trim() !== ""` SURVIVED them. The discriminating case is a client that supplies one field and
   BLANKS the other (`article_html: ""` alongside real `body`), asserted as a SUCCESS taking the
   supplied path (`apps/mcp/tests/roundtrip.test.ts` "blanks the authoring field it did not use").
   Both directions, because a client template can blank either side.
3. **Effect's McpServer masks tool failures as "internal server error" UNLESS the tool declares a
   `failure:` schema.** The behavior (effect 4.0.0-beta.102, `McpServer.ts:831-847`) is three catch
   branches in order: `AiError` → generic internal message unless its reason is
   `ToolParameterValidationError`; `Schema.is(tool.failureSchema)` → `error.message` passed through
   VERBATIM when the value is `instanceof Error`; everything else → internal message.
   `Effect.tapCause(Effect.logError)` runs first, so stderr logging is unaffected either way.
   - **CLOSED for memhtml** (2026-08-03, T-AC-5-1): every `Tool.make` declares `failure: ToolFailure`
     — a `Schema.ErrorClass` with `code`/`message`/`suggestions` — and `handled` is
     `Effect.mapError(toToolFailure)` (`apps/mcp/src/failure.ts`). Producing an `AiError` was the bug:
     it takes branch 1 and is masked. The general effect fact stands for any new toolkit.
   - **Only `.message` crosses the wire.** `code` and `suggestions` are invisible to MCP's one text
     block, so compose them INTO the message at construction:
     `ERR_PATH_NOT_FOUND: no memory at areas/x.html. Try: call memory_search …`.
   - **The two halves fail independently and one is not compile-checked.** Dropping the `failure:`
     declaration IS caught by tsc (the handler's error type reverts to `AiError`, TS2375). Rewrapping
     the mapping back into an `AiError` compiles fine and silently re-masks everything — so the lock
     has to be an over-real-stdio assertion on the error TEXT
     (`tests-integration/tests/mcp-stdio.test.ts`), mutation-proven by that second mutation. No
     in-process test can see this: `kit.handle` returns the message the handler produced, not the one
     `McpServer` sends.
   - **Suggestions must be re-phrased, not reused.** The CLI's `suggestionsFor` answers in `memhtml …` and
     `git …`, all unreachable from a tool call; the MCP reader is an LLM with 13 tools and no shell.
     `mcpSuggestionsFor` is a deliberate parallel mapping, grep-locked on `"memhtml "` never appearing, and
     action-first (the list is joined behind `"Try: "`, where a leading fact reads as a non-answer).
4. **CLI usage errors (exit 2) must be raised in `validate()`, not in a dispatch arm** — dispatch
   failures route through `failureFor` to exit 1 (`apps/cli/src/run.ts:772`). Conditional
   requiredness ("exactly one of --claim / --article-html") therefore lives in validate, with
   `ERR_MISSING_ARGUMENT` for neither (same code an absent required flag returned before, so no
   client breaks) and `ERR_INVALID_FLAG` for both.

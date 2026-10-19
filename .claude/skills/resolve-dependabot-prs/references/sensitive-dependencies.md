# Dependencies whose bumps need verification the gate cannot give

A green `mise run check` proves the suites pass. It cannot prove that a comment asserting measured behaviour is still true, and it cannot see the edges that need credentials. For the packages below, a bump has a specific claim to re-verify and a specific place to look.

Run `scripts/probe-citations.sh <pkg> <old-version>` first — it surfaces the dated probes and version citations for any package, including ones not yet listed here. Add an entry here whenever a bump turns out to have a claim behind it.

## `@aws-sdk/client-bedrock-runtime` — the resolved request handler

The Bedrock client sets `requestTimeout` and deliberately **not** `sessionTimeout`, because on the `NodeHttp2Handler` this SDK resolves, `sessionTimeout` aborts a live request rather than bounding an idle session — measured, a 500 ms value rejects a 1500 ms answer at 508 ms with a bare `Error` no retry predicate matches. A change in which handler the SDK resolves silently undoes that reasoning.

What proves it: `packages/llm/tests/request-handler.test.ts` drives a real `InvokeModel` through the real handler over loopback h2, scaling the shipped bound and the allowed answer by the same factor. It is offline and needs no credentials, so a green `test` task is real evidence here.

If the handler moves, read `node_modules/@aws-sdk/client-bedrock-runtime/dist-es/runtimeConfig.js` for the import, then that handler's own type declaration for the option set. Do not reason from an option's name — the option originally suggested for this fix, `connectionTimeout`, does not exist on this handler and would have been ignored in silence.

## `@biomejs/biome` — a version cited in four places

A bump can surface new diagnostics, and four files name the pinned version:

- `biome.json`'s `$schema` URL
- `lefthook.yml`'s header comment
- `mise.toml`'s comment on reaching the pinned binary
- every `package.json` (the bump itself)

Move the citations with the bump. This repo corrected them from 2.5.6 to 2.5.8 in one release and a bare bump to 2.5.10 would have re-staled them immediately.

Warnings and infos do not fail the gate — `biome check` exits 0 on them. Confirm the exit code rather than reading the diagnostic count: 14 warnings and 17 infos are the current standing state and are not a regression.

## `just-bash` — the sandbox whose egress is set by its constructor

Egress belongs to whoever calls `new Bash()`: curl and wget are registered ONLY when a network option is passed, and `typeof fetch` is a function either way, so a capability check enforces nothing. Its CJS build has a broken `js-exec`, and `js-exec` is not re-entrant.

A bump wants the `apps/cli` exec, session-exec, and head-server exec suites green, plus attention to whether the constructor's option surface moved.

## `highlight.js` — grammar relevance measured elsewhere

Minors and majors are ignored by standing rule. A grammar change moves relevance scores measured against a 332-snippet corpus that lives outside this repo; 11.12.0 dropped `toml` from 0.5406 to 0.1993. Patches flow.

## `effect` and the `@effect/*` set — see the catalog rule

Covered in `repo-invariants.md`. The behavioural claims live in `apps/mcp/src/*.ts` comments as "probed on effect <version>" and in `.lessons/solutions/effect-v4/`. A bump does not require rewriting those citations — they record when a fact was measured — but a claim the new version CONTRADICTS is a defect.

Observed 2026-08-25 moving rc.109 → rc.111: `Schema.toJsonSchemaDocument` stopped hoisting a struct merely reused twice and now inlines it, while still hoisting a recursive schema, which cannot be inlined. That failed a test whose fixture was the reused-struct case. The fold logic was still required for recursion, so the fixture was what had gone stale — check which before deleting anything.

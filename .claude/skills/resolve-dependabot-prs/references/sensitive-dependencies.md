# Dependencies whose bumps need verification the gate cannot give

A green `mise run check` proves the suites pass. It cannot prove that a comment asserting measured behaviour is still true, and it cannot see the three edges that need credentials. For the packages below, a bump has a specific claim to re-verify and a specific place to look.

Run `scripts/probe-citations.sh <pkg> <old-version>` first — it surfaces the dated probes and version citations for any package, including ones not yet listed here. Add an entry here whenever a bump turns out to have a claim behind it.

## `eve` — the agent runtime whose output is not relocatable

Moves fast: six releases in the week of 2026-08-14 through 08-22. Two surfaces to check against the shipped tarball **before** installing, because a break here is invisible offline (every consolidator test drives a fake eve binary that is never started):

```bash
cd /tmp && npm pack eve@<new> --silent >/dev/null && tar xzf eve-<new>.tgz
# 1. the health body the strict healthy() check validates
cat package/dist/src/internal/nitro/routes/health.js
# 2. the guard that makes .output/ location-bound
grep -c "Failed to resolve the authored package root" \
  package/dist/src/internal/authored-module-loader.js
```

The claim to protect: `eve build` bakes the absolute `appRoot`/`agentRoot` of its build directory into `.output/server/index.mjs`, and `eve start` re-bundles the authored TypeScript from that path on first load. Three constraints follow — the build directory is the only directory that can serve, the agent source must sit beside `.output/`, and that tree must stay writable because the bundle cache is written there. `apps/consolidator/src/agent-build.ts` builds in place because of this.

Check both directions. If the guard were **removed**, the build-in-place fix would be obsolete rather than correct, and the comment explaining it would become false. If the health body changed shape, `healthy()`'s strict validation would reject a healthy server.

Verify end to end with `mise run package:smoke:live`, which is the only tier that runs a real `eve build` followed by a real `eve start`.

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

A bump wants the consolidator and `apps/cli` exec suites green, plus attention to whether the constructor's option surface moved.

## `highlight.js` — grammar relevance measured elsewhere

Minors and majors are ignored by standing rule. A grammar change moves relevance scores measured against a 332-snippet corpus that lives outside this repo; 11.12.0 dropped `toml` from 0.5406 to 0.1993. Patches flow.

## `effect` and the `@effect/*` set — see the catalog rule

Covered in `repo-invariants.md`. The behavioural claims live in `apps/mcp/src/*.ts` comments as "probed on effect <version>" and in `.erpaval/solutions/effect-v4/`. A bump does not require rewriting those citations — they record when a fact was measured — but a claim the new version CONTRADICTS is a defect.

Observed 2026-08-25 moving rc.109 → rc.111: `Schema.toJsonSchemaDocument` stopped hoisting a struct merely reused twice and now inlines it, while still hoisting a recursive schema, which cannot be inlined. That failed a test whose fixture was the reused-struct case. The fold logic was still required for recursion, so the fixture was what had gone stale — check which before deleting anything.

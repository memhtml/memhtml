# Dist-only exports: what a test run actually observes, and the rebuild discipline

**Tags**: pnpm-workspace, turbo, dist, mutation-testing, integration-tests, turso
**Modules**: all packages, tests-integration, apps/cli/tests

## The rules

1. **Every `@memhtml/*` package's exports resolve only to `./dist`.** A change under `packages/*/src`
   is INVISIBLE to any downstream package's tests until `pnpm --filter <pkg> build` runs. Proven
   the hard way: a mutation applied to `packages/html/src/template.ts` changed nothing downstream
   (122 store tests still passed); the same mutation applied after a build fired 4 failures.
   Consequence for mutation testing: **rebuild between mutate and run, and rebuild again after
   restore**, or every downstream mutant "survives" vacuously.
2. **The CLI e2e harness and tests-integration both import dist** (`tests-integration/tests/harness.ts:4`
   imports `run` from `@memhtml/cli`). Root `pnpm build` before any integration/e2e run that follows a
   source edit, or you silently test stale dist.
3. **AGENTS.md regenerates from the BUILT CLI** — `pnpm --filter @memhtml/cli build` first, then
   `node apps/cli/dist/bin.js agents-doc`. The drift gate is NOT a pipeline step: it is the vitest
   case `apps/cli/tests/agents-doc.test.ts:45-53`, caught by `pnpm --filter @memhtml/cli test`.
4. **Turso holds an exclusive file lock while a child `memhtml serve mcp` is alive** — opening
   `.memhtml/index.db` from the test process fails with "File is locked by another process" until the
   child exits. An integration test that asserts index rows MUST shut the server down first; the
   ordering is a hard constraint, not a preference (probed live 2026-08-03,
   `tests-integration/tests/mcp-stdio.test.ts`).

   **The lock is a WRITER lock, and the qualifier is load-bearing** (re-probed 2026-08-09 against
   `@tursodatabase/database` 0.7.2 with the repo's exact `experimental: ["index_method","attach"]`
   flags — `scripts/probe-turso-locking.mjs`). A default `connect()` from a second PROCESS fails with
   `Locking error: Failed locking file`, which is what rule 4 describes and why it stands. A
   `connect(path, { readonly: true })` from a second process **opens and reads fine** while the first
   process holds the file and keeps writing. So the rule for a test is unchanged: shut the server
   down before asserting rows, because the assertions need a writable handle. What changes is that a
   read-only consumer is not blocked, and `readonly: true` is the only mechanism that delivers it.

# Dist-only exports: what a test run actually observes, and the rebuild discipline

**Tags**: pnpm-workspace, turbo, dist, mutation-testing, integration-tests, sqlite
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
4. **An integration test asserts index rows AFTER the server exits**
   (`tests-integration/tests/mcp-stdio.test.ts`). A read taken while the child is alive is a read
   racing a writer, so the ordering is what makes the assertion describe a settled corpus rather than
   whatever was committed by the time the statement ran. What a second process can do to a live store
   belongs to a probe and not to a memory of one: `scripts/probe-sqlite-concurrency.mjs` crosses the
   process boundary and varies the open mode, which is the pair of properties two earlier probes of
   this question each got wrong.

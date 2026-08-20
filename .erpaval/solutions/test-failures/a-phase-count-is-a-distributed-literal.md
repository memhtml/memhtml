# Adding a sleep phase changes a number that lives in five repos' worth of places — the pre-push LIVE smoke is the one no offline gate covers

**Tags**: sleep-phases, hardcoded-counts, smoke-tests, pre-push **Modules**: packages/sleep/src/contract.ts, scripts/smoke-package.mjs, apps/cli, tests-integration

## Symptom

PR #48 added the 16th sleep phase. `mise run check` (58 tasks), the integration tier (125 tests), and the scoped package gates were all green — and `git push` failed, because the pre-push hook runs `package:smoke:live`, and `scripts/smoke-package.mjs:184` asserted `phases === 15` as a literal.

## Mechanism

The phase count is a distributed literal. The Act agent found and fixed the ones inside the turbo graph (CLI strings derived from `SLEEP_PHASES.length`, test pins, prose in seven docs pages), but the smoke script is OUTSIDE the graph — it runs only in the pre-push hook and CI's package job, so no offline gate ever executed the stale literal. The lesson generalizes: when a closed vocabulary gains a member, grep for the OLD CARDINALITY as a bare number (`15`, `fifteen`) across scripts/, tests-integration/, and hooks — not just for the vocabulary's name — and check which asserting files sit outside the `turbo run` graph, because those are exactly the ones the definition-of-done command cannot certify.

## How to apply

- `grep -rn "=== <n>\|toBe(<n>)\|phases: <n>\|<n-in-words>" scripts/ tests-integration/ ops/` after any SLEEP_PHASES / MEMORY_TYPES / RESPONSE_TYPES change.
- Prefer deriving from the constant (`SLEEP_PHASES.length`) wherever the file can import it; the smoke script now pins 16 and will bite again at 17 — it cannot import workspace code by design (it tests the packed tarball), so the grep is the durable defense.

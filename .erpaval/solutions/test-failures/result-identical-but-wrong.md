# Result-identical but wrong: when only the SHAPE of a query or test can carry the assertion

**Tags**: vacuous-tests, explain-query-plan, sql-precedence, flag-off, mutation-testing, mmr, rrf **Modules**: packages/index, apps/cli, apps/mcp

Four independent instances in one session (session-729e89), one theme: the defect lived at a level result assertions cannot see. When correctness and cost/behavior diverge, assert the SHAPE — the SQL text, the query plan, the key set, the input that would light up.

## The rules

1. **`AND` binds tighter than `OR` in an appended predicate.** `WHERE e.chunk_id IS
   NULL OR e.model <> ? AND c.chunk_id IN (…)` scopes only the second disjunct — the "scoped" query is still a full scan returning plausible rows. On small fixtures both forms return identical rows, so the guard asserts the STATEMENT contains the parenthesized form, not the result (indexer.test.ts scope assertions).
2. **The planner does not infer NOT NULL from `IN (…)`,** so a partial index with a `frame_key IS NOT NULL` condition is silently skipped for a full table SCAN that returns the right rows. A semantically redundant `AND frame_key IS NOT NULL` changes the plan, not the results. Probe `EXPLAIN QUERY PLAN` after `pnpm check` is green, and lock it by EXPLAINing production's own CAPTURED SQL — a pasted copy of the query drifts (traces-persist.test.ts plan lock).
3. **A flag-off test must run over input that WOULD light up.** Hardcoding `detectConflicts: true` in the handler left all 40 roundtrip tests green because the flag-off assertion ran over ops sharing no frame slot — null either way. A default-on door would have shipped through a full green suite (roundtrip.test.ts:1121).
4. **`hit.score` is MMR's position proxy (`1/(offset+1)`), NOT the RRF sum.** A salience-invariance assertion over hit.score passes under rule reversal because MMR absorbs order changes. Rank/contribution assertions must read the assembled statement's `SUM(s)` (e2e salience guard, second cut).

## How to apply

- Any test guarding a COST property (index used, scan avoided, one-query-per-batch) asserts SQL text or EXPLAIN output, never row results.
- Any flag-off/default-off lock first constructs input where ON visibly differs, proves the ON case fires, then asserts OFF is silent on the same input.
- Mutation-verify every new guard the day it lands (guards-must-fire); two of this session's own first-cut tests passed under mutation and were rewritten.

# A degraded check is not an empty finding: a read that failed must be visible in the answer it would have poisoned

**Tags**: degradation-honesty, error-swallowing, doctor, orElseSucceed, health-gates, apiface **Modules**: apps/cli/src/doctor.ts, apps/cli/src/views.ts, apps/cli/src/run.ts

## The failure

`memhtml doctor` runs nine checks over the index database. Every one caught its read failure with `Effect.orElseSucceed(() => typedEmpty)` — `[]`, `0`, `undefined` — so a doctor whose SQL could not run at all (`SQLITE_BUSY` past `busy_timeout`, a corrupted page) answered `healthy: true` computed from checks that NEVER RAN. The same shape sat in `index status` (a failed count read as `files: 0`, where zero is also the healthy answer for an empty corpus) and `sleep review --diff` (a failed git diff folded to `diff: ""`, which is also the honest answer for "branch equals base" — so a reviewer could approve a night whose diff never fetched).

This is the production-side twin of [[a-wrong-count-reads-as-a-finding]]: there a probe's wrong count read as a fact about the corpus; here a COMMAND's degraded read read as a clean bill of health — on the one command an operator runs precisely when something is wrong.

## The fix shape, which the codebase already owned

The near-duplicates assist set the precedent: when the embedder cannot run it reports `near_duplicates_degraded: true` and nulls, meaning UNCHECKED rather than unique. Generalized:

- Each read returns `{ value, degraded }` — the value stays the TYPED EMPTY the helper always fell back to, so consumers that ignore degradation parse the same shapes they always did.
- The report gains `degraded: ReadonlyArray<string>` naming the failed checks BY REPORT FIELD NAME, and non-empty `degraded` forces `healthy: false` — "every check ran clean" is false when a check did not run, full stop.
- Where empty and failure must stay distinguishable (`sleep review --diff`), the failure value is `null` plus an explicit flag, never the empty string: the empty string is a REAL answer for a different question.
- `index status` counts degrade to `null` rather than `0`: zero asserts a fact about the corpus; null asserts nothing.

## The rule

**`orElseSucceed(empty)` is only honest where empty cannot be mistaken for a successful answer.** Before degrading a read to a default, ask what the default will be READ as by the consumer who trusts the flag (`healthy`, `files`, `diff`) — and make the degradation a field in the same envelope, because a stderr warning never reaches the agent branching on the payload.

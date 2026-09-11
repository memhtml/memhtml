# A count that lives as a hand-written list carries no number to grep — and on a known-red platform the one failure that is yours hides in the pile

**Tags**: mcp-toolkit, hardcoded-counts, census-tests, known-red-platforms **Modules**: apps/mcp/tests/tools.test.ts, apps/mcp/tests/failure.test.ts, tests-integration/tests/mcp-stdio.test.ts

## Symptom

The task family grew the MCP toolkit from fifteen tools to eighteen. The review named the integration census and the docs; the fix bumped those, plus `failure.test.ts`'s own count and six doc pages neither list had named. `apps/mcp/tests/tools.test.ts` — the toolkit's own unit census, squarely inside the turbo graph — still asserted `toHaveLength(15)` against a hand-written `EXPECTED` of fifteen names, and nothing found it until the suite was actually re-run after a rebase onto a moved main. The assertion fails on Linux too; on the Windows box it was made on, it sat inside 54 inherited `URL.pathname` failures and only separated when the pile was read test by test.

## Mechanism

Two blind spots stacked. First, the cardinality grep — the defense a-phase-count-is-a-distributed-literal prescribes — cannot see this literal, because there is none: the count lives as the LENGTH of the `EXPECTED` name list, and `toHaveLength(15)` matches neither `fifteen` nor `15 tools`. A hand-written list of names is a count in the one form a grep for numbers and number-words never finds. Second, the definition-of-done command could not certify the fix on the machine that made it: `apps/mcp#test` was already red there for the inherited doubled-drive-path failures, so the new, real failure was one more line in a 54-line pile. A known-red suite cannot distinguish the red you brought from the red that was already here; only a failure-set diff against a baseline can.

## How to apply

- After any closed-vocabulary change, grep the MEMBER NAMES (`task_add`), not just the old cardinality: every asserting file that enumerates the vocabulary shows up, whatever form its count takes.
- A hand-written expectation list cannot be derived from the source of truth — that would make it vacuous, since the list IS the pin — so the tier has to actually run before the change is called done. On a platform with inherited red, run the same package on a baseline worktree of the base branch and diff the failure sets by name, rather than eyeballing one long pile.
- The review's list and the author's sweep each caught counts the other missed, and both were incomplete; the executed suite was the only complete witness. Treat "the count is asserted beside the names" as N files until the name-grep says otherwise.

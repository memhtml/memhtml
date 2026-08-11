# A terse lesson decays into a wrong one, so the qualifier goes in the claim

**Tags**: lesson-hygiene, compound, documentation, probe-discipline
**Modules**: .erpaval/solutions, RUNBOOK.md, AGENTS.md

## What happened

A real incident produced a real lesson: `memhtml serve mcp` deadlocked its own child process on the
index database, and the finding was recorded as **"Turso's lock is exclusive."**

Every subsequent reader kept the mechanism and lost the scope. The claim became "a second handle onto
a live index fails," which is false — and it is false in the direction that blocks work, because it
rules out the read-only second opener that `memhtml exec` and every sandboxed consumer actually needs.
Two sessions later the question was re-derived from scratch, wrongly, twice, in opposite directions.
The true claim is narrower and one word longer: the lock excludes a second **WRITABLE** opener.

## The mechanism of the decay

The qualifier was never absent from the original session — it was in the surrounding prose, in the
incident's own details, in the reasoning that produced the lesson. It was just not in the SENTENCE.
Prose around a claim is read once, by the person who wrote it. The claim itself is what gets quoted,
pasted into a comment, restated in a runbook, and recalled three sessions later with no access to its
context. Anything load-bearing that lives outside the claim has a half-life.

This is why `memhtml`'s own generated agent guide asserts the qualifier rather than describing it:
removing the word `WRITABLE` from that sentence fails a named vitest case
(`apps/cli/tests/apply.test.ts:705`). The drift was made mechanically impossible rather than
discouraged.

## The rule

Write the claim so that it is still true when it is the only sentence that survives. If a scope,
a boundary, or a precondition changes whether the claim holds, it belongs inside the claim:

- not "Turso's lock is exclusive" but "the lock excludes a second **writable** opener"
- not "the sandbox has no network isolation" but "egress is set by whoever calls the constructor; eve
  hardcodes full access, a caller that omits the option gets none"
- not "`readonly: true` is ignored" but "`readonly: true` is ignored **in the writer's own process**
  and enforced **cross-process**"

Then, where the claim is load-bearing, gate it: a test that fails when the qualifier is deleted, or a
probe script that re-measures it on demand. A claim nobody can check decays back to its terse form
the first time someone paraphrases it.

## Related

[[turso-second-opener-and-the-readonly-flag]] is the lesson this one is about.
[[sandbox-egress-is-set-by-the-constructor]] was written to this standard deliberately: its title
carries the qualifier, because "the sandbox has egress" would have decayed the same way.

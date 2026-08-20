---
title: Testing posture
description: A real driver and a real git binary, fakes at the two network edges only, property tests over the pure packages, and a quality gate that refuses on one inversion.
---

## 1. Real driver, real git

Integration tests drive the real SQLite driver against `":memory:"` with the real migrations (`packages/index/src/database.ts:262-266`), and the real git binary against a repository in a temp directory (`packages/store/src/store.ts:331-334`).

A fake driver would verify the shape of the calls and miss every constraint the database enforces. A fake git would verify that the right strings were assembled and miss every state transition they cause.

Fakes are limited to the two edges that reach the network, and each is a `Layer.succeed` value: a deterministic hash-seeded embedder whose cosine relations are a pure function of the text (`packages/eval/src/harness.ts:52`), a failing embedder for exercising the degraded path (`packages/eval/src/harness.ts:99`), and a scripted model.

## 2. Property tests over the pure packages

`fast-check` covers `@memhtml/domain` and `@memhtml/html`. The properties that carry the most weight:

- the content hash is invariant under any metadata-only mutation;
- `originalPathFor(archivePathFor(p, y)) === p`;
- every weight profile sums to exactly 1.0 under compensated summation;
- each retention band boundary is owned by the lower band;
- decay is non-increasing everywhere and respects its floor;
- rank fusion is strictly decreasing in rank and insensitive to the order of the arms;
- the diversification pass returns a duplicate-free subsequence of its input;
- each divergence predicate is symmetric;
- label propagation yields the same partition for the same edge list;
- the pure cooldown function agrees with the SQL at the boundary.

## 3. The discrimination gate

The discrimination gate asks one question: does the retrieval stack rank a memory above a nearly identical, deliberately wrong version of itself (`packages/eval/src/discriminate.ts:224`)? The wrong versions are called controls.

Controls are derived mechanically from the target by the three divergence families, meaning a negation flip, a numeric flip, and a qualifier flip. Each control is then validated against its own family's predicate, so a control that failed to diverge is discarded rather than scored (`packages/eval/src/controls.ts:25`, `packages/eval/src/controls.ts:163`). Mechanical derivation is what makes them high-cosine wrong-fact adversaries by construction rather than by an author's imagination.

### 3.1. Two numbers, and the strict one is the gate

`packages/eval/src/discriminate.ts:18-21` defines both.

`mrr` is the mean reciprocal rank measured in the space of `{target} ∪ controls` alone, against a floor of 0.85 (`packages/eval/src/discriminate.ts:103`). The refusal, though, is per-probe and absolute: a single target ranked at or below any of its own controls is an inversion, and one inversion fails the run whatever MRR says. An aggregate on its own can be bought by thirty easy probes covering one broken one. A control the search never returned counts as outranked, since being absent is worse than being last.

`corpusMrr` is measured against the whole corpus, and it is reported rather than gated. It is low by construction on a fixture holding many near-identical memories, and reading it as a retrieval defect would confuse the two coordinate spaces the two field names exist to keep apart (`packages/eval/src/discriminate.ts:76-88`).

### 3.2. A skipped gate never looks like a passing one

`packages/eval/src/run.ts:15-23`. Fake mode runs everywhere and is what CI measures. Live mode without credentials reports `skipped: true` and `passed: false` with a loud stderr line, and never a green report. A caller who asked for live and got a silent fake would be told the real vector space discriminates when nothing had measured it.

### 3.3. Where the gate is wired

Three places. `memhtml eval discriminate` exits non-zero on any inversion. The repository-wide check runs it as a `test:eval` task. `memhtml sleep merge` re-runs it and refuses the merge on failure, so a nightly run that degrades retrieval quality does not land.

## 4. Standing hazards this suite is written against

Four failure modes have each cost real debugging time here, and each is now a rule for writing a test.

- A clean-database test can pass against a real bug. Where a table is shared across entities, seed a neighbor's rows and not only the subject's. Window bounds derived from a table-global sequence agree exactly with the correct projection in an empty database.
- Mutation-verify every lock you call a lock. Roughly a quarter of candidate regression tests written in this repository were vacuous until someone reverted the fix and watched them fail.
- A wrong count reads as a finding. `0/410 edges resolved` and `withClaim: 0` were both bugs in the probe: path normalization in the first case, and in the second a selector of `article > mark`, which matches nothing because the markup is `<article><p><mark>`. A census probe asserts an independently derived total and never merely reports one.
- Assert shape where correctness and cost diverge. Capture `EXPLAIN` output to prove the planner uses a partial index, since the rows come back either way.

## 5. What integration tests are for

`tests-integration` runs with file parallelism off and a long timeout, because each suite initializes a git repository and opens a database on disk. That cost buys state semantics across successive calls, which a fake cannot give.

Every defect this system has had in that class was green under a stateless fake and red against the real adapter. The list so far is a bare `SET` in a pool configure callback, a resolve-then-read join that came back empty against a real database, and a queue contaminated by a neighbor's rows. Each fix is regression-locked by a test proven to fail on the bug.

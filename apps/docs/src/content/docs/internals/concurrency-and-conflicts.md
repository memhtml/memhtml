---
title: Concurrency and conflicts
description: Git supplies the concurrency control, an occupied path is refused with a typed error naming it, and a curation run is stricter than an agent write.
---

## 1. Git is the concurrency mechanism

Two agents writing different files never produce a merge conflict. The tree is the shared state, and git decides who won. Across processes, memhtml takes no lock, lease, or coordination service of its own, and git refuses a collision when a change is applied, which is the pattern usually called optimistic concurrency control.

Inside one process, writes take turns behind one permit (`oneWriterAtATime`, `packages/store/src/store.ts:1400-1415`). Two processes that write at the same moment share git's one index, so the one that loses can fail with `ERR_GIT` (`apps/cli/src/errors.ts:44-45`).

A CLI command and a running MCP server share one `index.db`. Write-ahead logging admits one writer and any number of readers (`packages/index/src/database.ts:342`), every connection sets a 5000 ms busy timeout (`BUSY_TIMEOUT_MS`, `packages/index/src/database.ts:22`, `packages/index/src/database.ts:329`), and a statement still refused after that retries with backoff (`BUSY_BACKOFF`, `packages/index/src/database.ts:147-150`).

Three actors share the tree, and Figure 1 shows the cycle they form through `main`. When edge typing promotes a contradiction, it links both files with `contradicts` and archives neither (`packages/sleep/src/phases/edge-typing.ts:510-517`).

```d2 pad=20 src="_figures/three-actors.d2" title="A cycle of five boxes. The agent writes to main. Sleep reads main and commits its work to a sleep/date branch. The human reviews that branch and merges it back into main, closing the cycle. The branch reaches main through that merge."
```

**Figure 1: the three actors form a cycle through `main`.** Before its first phase, a run that is not a dry run checks out `sleep/<date>` and reads `HEAD` back to prove it landed there (`enterRunBranch`, `packages/sleep/src/run.ts:420-444`). The agent commits to the branch `HEAD` names. That is `main` except while a run has its branch checked out, and a run that ends in `review` keeps it checked out until `sleep merge` (`packages/sleep/src/run.ts:244-249`), so an agent write in that window lands on the branch. The merge closes the cycle. The two heavy-bordered boxes are the actors outside the system, and `main` and the branch are double-bordered because they hold the facts.

## 2. A same-file conflict is a typed error naming the path

`mergeBranch` (`packages/store/src/store.ts:1360-1380`) reads both competing blob shas out of the unmerged index, where stage 2 is ours and stage 3 is theirs, and it reads them before aborting, because `merge --abort` discards the unmerged index.

It then fails with a typed `WriteConflict` carrying the path and both shas (`packages/contracts/src/errors.ts:18-22`). In this version only the store's own test calls `mergeBranch`, on two clones that edited one memory (`packages/store/tests/store.test.ts:1257-1300`); no CLI command or MCP tool does. Any `WriteConflict` reaches an agent as `ERR_WRITE_CONFLICT` (`apps/cli/src/errors.ts:52-53`), with `memhtml read <path>` first in the suggestions because it is the step both recoveries start with (`apps/cli/src/errors.ts:169-173`).

Recovery belongs to the caller. Two agents that wrote different facts into one file cannot be reconciled by any rule the store knows, and two shas plus a path are what an agent needs in order to read both sides and decide.

The same error answers a second, plainer collision, and it is the one an agent can reach today: an explicit `--path` that a file already occupies. A write never replaces a file, so an occupied explicit path is refused with nothing written and nothing committed, and it gets no `-2` collision suffix either, because the caller named one path and a quiet write to a neighboring one would leave that caller holding a path with no file behind it (`freePathFor`, `packages/store/src/store.ts:417-441`). That refusal carries the occupant's sha as `theirSha` and an empty `ourSha`, since the write read no base. The recovery there is `memhtml correct <path>`, which writes the superseding memory and archives what it replaces in one commit; `correct`'s own target is the one path exempt from the check, since the same commit moves it into the archive before the correction's bytes are written.

## 3. A sleep run refuses a dirty tree

`preflight` fails on a dirty tree with `DirtyTree` (`packages/sleep/src/phases/preflight.ts:54`, `packages/store/src/store.ts:1354-1358`, `packages/contracts/src/errors.ts:50-52`), and `merge` tries to check out `main`, then refuses if `HEAD` has moved past the run's base on a path the run also changed (`packages/sleep/src/review.ts:274-312`).

An agent write can be reconciled after the fact. A curation run rewrites metadata across the whole corpus, so starting it against uncommitted work would mix an operator's in-progress edit into the run's own commits, with no way to tell them apart in the diff.

`preflight` is a hard prerequisite of every one of the sixteen phases after it (`HARD_PREREQUISITES`, `packages/sleep/src/contract.ts:108-124`), so a refused dirty tree costs the whole run rather than staging the operator's bytes under sleep's own trailers halfway through it.

## 4. A rerun is cheap because a discarded branch never reached `main`

A run that `merge` refused, or that the operator threw away, never moved `main` while its commits stayed on its branch, so a rerun from `main` repeats that run's work instead of compounding it. After an abort, the rerun of the same date even takes the same run id, because ids come from the branches that exist (`runIdFor`, `packages/sleep/src/run.ts:94-102`, `existingSleepBranches`, `packages/sleep/src/run.ts:876-893`). On a fixture that rerun rebuilt the same tree except the run report, which records commit shas.

That is also why, for a branch that holds only the run's own commits, the abort is `git checkout main` and then `git branch -D sleep/<date>`, with no compensating writes. The checkout comes first because a run that ends in `review` leaves `HEAD` on its branch, and git will not delete a checked-out branch. Git enforces that for the tree while `HEAD` stays on the run's branch, since each phase commits to the branch `HEAD` names. Outside the tree, the run's reporting rows stay in `index.db`, and a model-bound run's detection counters stay in `state.db` by design (`bumpCorroboration`, `packages/sleep/src/sql.ts:688-705`, `bumpEntityCorroboration`, `packages/sleep/src/sql.ts:855-874`).

The abort reaches three database writes too, and it takes a committed ledger to get there. A database row written during a phase would outlive the branch that earned it. For a `trace-consolidation` watermark that is data loss rather than bookkeeping, because the watermark is an anti-join and a session it covers is never selected again. So those three writes, the session watermark and the edge and entity promotion flags, are recorded as marks in `.memhtml/sleep/sleep-<date>.pending.jsonl` (the run id with `/` replaced by `-`, `pendingMarksPath`, `packages/sleep/src/contract.ts:496-497`), a committed artifact on the run's own branch. `merge` applies them only after the branch lands (`applyMarks`, `packages/sleep/src/review.ts:351`) and reports `marksPending` beside `marksApplied` (`packages/sleep/src/review.ts:385-386`). `git branch -D` therefore discards the marks with the branch, and every session in them stays eligible for a later cycle. [The sleep pipeline](/internals/the-sleep-pipeline/) develops the ledger.

A rerun after a merge is not a no-op. Most phases run out of work. A file a run archived, including a duplicate that `dedup-merge` folded (`archiveFile`, `packages/sleep/src/phases/dedup-merge.ts:822`), is not a candidate for decay, retention, or another merge, because those phases pick candidates from the index's active rows (`activeCorpus`, `packages/sleep/src/sql.ts:121-128`). `confidence-decay` does not run out. It takes one step each time it runs, with no elapsed-time input (`decayConfidence`, `packages/sleep/src/phases/confidence-decay.ts:72-77`), so on a fixture a second run of the same date, after the first merged, took a file from 0.848 to 0.783. An unreinforced file stops only when a step would move it by less than 0.005 (`isCommittableConfidenceChange`, `packages/domain/src/decay.ts:146-150`), and that one stopped at 0.246 after 26 merged runs, above the 0.2 floor. Each of those runs also committed its own report.

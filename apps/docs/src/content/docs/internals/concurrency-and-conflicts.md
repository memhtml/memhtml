---
title: Concurrency and conflicts
description: Git supplies the concurrency control, a same-file collision comes back as a typed error carrying both shas, and the nightly run is stricter than an agent write.
---

## 1. Git is the concurrency mechanism

Two agents editing different files never interact. The tree is the shared state, and git's index
decides who won. Writers proceed without taking a lock, a lease, or a coordination service, and git
detects a collision when a change is applied, which is the pattern usually called optimistic
concurrency control.

A CLI command and a running MCP server share one `index.db`. Write-ahead logging admits one writer and
any number of readers, `busy_timeout = 5000` is set on every connection
(`packages/index/src/database.ts:342-354`), and a contended write retries.

Three actors share the tree, and Figure 1 shows the cycle they form through `main`. Only one of them
may settle a contradiction.

```d2 pad=20 src="_figures/three-actors.d2" title="A cycle of five boxes. The agent writes to main. Sleep reads main and puts fifteen commits on a sleep/date branch. The human reviews that branch and merges it back into main, closing the cycle. Sleep never writes to main directly and the branch never reaches main without passing through the human."
```

**Figure 1: the three actors form a cycle through `main`, and the nightly run is never on it.** The agent
commits to `main` at any hour. Sleep reads `main` and writes only to `sleep/<date>`, so a curation run
cannot move `main` even by accident. The human closes the cycle. The two heavy-bordered boxes are the
actors outside the system, and `main` and the branch are double-bordered because they hold the facts.

## 2. A same-file collision is a typed error carrying both shas

`mergeBranch` (`packages/store/src/store.ts:1079`) reads both competing blob shas out of the unmerged
index, where stage 2 is ours and stage 3 is theirs, and it reads them before aborting, because
`merge --abort` discards the unmerged index.

It then fails with a typed `WriteConflict` carrying the path and both shas
(`packages/contracts/src/errors.ts:19`). That reaches an agent as `ERR_WRITE_CONFLICT` plus the suggestion
to re-read and reapply (`apps/cli/src/errors.ts:130-133`).

Recovery belongs to the caller. Two agents that wrote different facts into one file cannot be reconciled
by any rule the store knows, and two shas plus a path are what an agent needs in order to read both sides
and decide.

## 3. The nightly run refuses a dirty tree

`preflight` refuses to start on a dirty tree (`packages/store/src/store.ts:1073`,
`packages/contracts/src/errors.ts:50`), and `merge` refuses if `main` has moved.

An agent write is one commit against one file and can be reconciled after the fact. A curation run
rewrites metadata across the whole corpus, so starting it against uncommitted work would mix a
human's in-progress edit into a machine's fifteen commits, with no way to tell them apart in the
diff.

## 4. Rerunning is cheap because the phases are idempotent

An already-merged duplicate no longer surfaces as a candidate, an already-decayed confidence value is a
fixed point (`packages/domain/src/decay.ts:116`), and an already-archived file is not a candidate.

That is what lets the abort path be `git branch -D` with no compensating writes. A re-run converges to the
same tree instead of compounding the previous attempt.

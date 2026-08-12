---
title: Concurrency and conflicts
description: Git is the optimistic-concurrency mechanism, a same-file collision surfaces as a typed error carrying both shas, and sleep is stricter than an agent write.
---

## 1. Git is the concurrency mechanism { #git-is-the-concurrency-mechanism }

Two agents editing different files never interact. There is no lock, no lease, and no coordination
service: the tree is the shared state and git's index is the arbiter.

A CLI command and a running MCP server share one `index.db`. WAL admits one writer and any number of
readers, `busy_timeout = 5000` is set on every connection
(`packages/index/src/database.ts:342-354`), and a contended write retries.

## 2. A same-file collision is a typed error carrying both shas { #a-same-file-collision-is-a-typed-error-carrying-both-shas }

`mergeBranch` (`packages/store/src/store.ts:924`) reads both competing blob shas out of the unmerged
index — stage 2 is ours, stage 3 is theirs — **before** aborting, because `merge --abort` discards the
unmerged index.

It then fails with a typed `WriteConflict` carrying the path and both shas
(`packages/contracts/src/errors.ts:19`), which reaches an agent as `ERR_WRITE_CONFLICT` plus the
suggestion to re-read and reapply (`apps/cli/src/errors.ts:130-133`).

The recovery belongs to the caller. Two agents that wrote different facts into one file cannot be
reconciled by a rule the store knows; two shas and a path are what an agent needs to read both sides and
decide.

## 3. Sleep is stricter { #sleep-is-stricter }

`preflight` refuses on a dirty tree (`packages/store/src/store.ts:918`,
`packages/contracts/src/errors.ts:56`), and `merge` refuses if `main` moved.

The asymmetry is deliberate. An agent write is one commit against one file and can be reconciled after
the fact; a curation run rewrites metadata across the whole corpus, so starting it against uncommitted
work would mix a human's in-progress edit into a machine's fifteen commits with no way to tell them
apart in the diff.

## 4. Rerunning is cheap because the phases are idempotent { #rerunning-is-cheap-because-the-phases-are-idempotent }

An already-merged duplicate no longer surfaces as a candidate, an already-decayed confidence is a fixed
point (`packages/domain/src/decay.ts:116`), and an already-archived file is not a candidate.

That is why the abort path can be `git branch -D` with no compensating writes: a re-run converges to the
same tree rather than compounding the previous attempt.

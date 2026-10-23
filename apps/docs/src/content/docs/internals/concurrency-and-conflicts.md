---
title: Concurrency and conflicts
description: Git supplies the concurrency control, the checkout lock keeps two writers out of each other's staged files, a session that loses a race answers rebase-needed, and a curation run never moves main until a merge lands it.
---

## 1. Git is the concurrency mechanism

Two agents editing different files never interact. The tree is the shared state, and git decides who won. Writers don't take a lease or ask a coordination service. A change is checked for a collision when it's applied, which is the pattern usually called optimistic concurrency control.

Two kinds of writer share one tree. The v1 doors (`memhtml write`, `apply`, `correct`, and the MCP write tools) stage files in the shared git index and commit them. A session builds its commit in a temporary index of its own and moves the ref with a compare-and-swap. Both kinds hold the checkout lock while they change the shared index (§2), and a session that finds the ref moved since its base answers `rebase-needed` (§3).

A CLI command and a running MCP server share one `index.db`. Write-ahead logging admits one writer and any number of readers, `busy_timeout = 5000` is set on every connection (`packages/index/src/database.ts:342-354`), and a contended write retries. Session commits never open the index, so they never wait on it.

Three actors share the tree, and Figure 1 shows the cycle they form through `main`. Only one of them may settle a contradiction.

```d2 pad=20 src="_figures/three-actors.d2" title="A cycle of five boxes. The agent writes to main. A curator reads main and commits to a curate/date branch. The human reviews that branch and merges it back into main, closing the cycle. The curator never writes to main directly and the branch never reaches main without passing through the human."
```

**Figure 1: the three actors form a cycle through `main`, and a curation run is never on it.** The agent commits to `main` at any hour. A curator reads `main` and writes only to `curate/<date>`, so a curation run can't move `main` even by accident. The human closes the cycle by running `memhtml curate merge`. The two heavy-bordered boxes are the actors outside the system, and `main` and the branch are double-bordered because they hold the facts.

## 2. The checkout lock keeps writers out of each other's files

One checkout has one git index, and before 0.16 nothing stopped two processes from staging into it at once. A `memhtml write` that ran while another process had staged a file could sweep that file into its own commit. The checkout lock, `.memhtml/checkout.lock`, closes that gap. Every v1 write holds it from its first stage to its commit (`StoreShape.exclusive`, `packages/store/src/store.ts:236`), and so do `init`, `task status`, `publish`, `state export`, `doctor --fix`, every session commit, and the `curate merge` fast-forward.

A writer waits up to 15 seconds for the lock and then fails with `ERR_STORAGE` (`checkout.locked`). Every writer but `doctor --fix` and `task status <path> done` has then written nothing, and running it again is safe. [Sessions and the commit path](/internals/sessions-and-the-commit-path/#5-the-checkout-lock) lists the timings and the one crash window that remains.

## 3. A session that loses a race answers rebase-needed

A session commit validates its log against its base and then moves the ref with `update-ref <ref> <new> <base>`, which fails if the ref no longer names the base. A commit that finds the ref moved, before or during that swap, answers `rebase-needed` with the new tip and the session's paths that changed meanwhile. Without `--drop-refused` it never retries on its own. The caller runs `session rebase`, which moves the base and keeps every operation, and commits again.

The commit after a rebase judges the log against the new tip. It can still answer `refused` with `duplicate`, when the ref gained the same article meanwhile, or with `claim-edit`, when the ref gained a new version of a file this session also wrote. The store has no rule that could reconcile two writers' facts, so it names the paths and leaves the choice to the caller. An agent runtime that commits at the end of a run passes `--drop-refused`, which takes the refused operations out of the log, records them in `.memhtml/sessions/<id>.dropped.jsonl`, and commits the rest.

A frame-key rival isn't a refusal. When a new record's claim has the same frame key as an active record at another path, the commit links the new file to the old one with `memhtml-contradicts` and both stay live. Deciding which claim is right is a one-way door that stays with a writer or a person.

A head server commits one session at a time, so commits that go through it never race each other. A commit that waits more than 20 seconds behind another is declined as `busy`, and the client commits locally under the same compare-and-swap.

## 4. An occupied path is a typed error

An explicit `--path` that a file already occupies is refused with nothing written and nothing committed. Nothing in this corpus is overwritten, and the store doesn't add a `-2` suffix either, because the caller named one path and a quiet write to a neighboring one would leave that caller holding a path with no file behind it (`freePathFor`, `packages/store/src/store.ts`).

The refusal is a typed `WriteConflict` carrying the path and the blob sha now at it (`packages/contracts/src/errors.ts:35`). It reaches an agent as `ERR_WRITE_CONFLICT`, with `memhtml read <path>` first in the suggestions, because reading the current content is the step every recovery starts with (`apps/cli/src/errors.ts:209`). The usual recovery is `memhtml correct <path>`, which writes the superseding memory and archives what it replaces in one commit. `correct`'s own target is the one path exempt from the check, since the same commit moves it into the archive before the correction's bytes are written.

## 5. Re-running curation is cheap because the run never moved main

A curator run commits only to its `curate/<date>` branch and never checks that branch out, so the run never touches `main`, the checkout, or the index. Throwing a run away is `git branch -D` with no compensating writes. The next run on a new ref reads the corpus fresh and briefs the model on what's there now: an archived duplicate is no longer a duplicate, a repaired link is no longer dangling, and a filed record is no longer in the inbox.

`curate merge` is memhtml's door back, and it moves `main` with the same compare-and-swap a session commit uses. When `main` moved past the branch's base, the merge replays the branch's operations as one new commit on `main`'s tip. A replay that collides with what `main` gained meanwhile refuses with nothing moved, so a curation landing never overwrites an agent's write.

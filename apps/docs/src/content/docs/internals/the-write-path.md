---
title: The write path
description: How ordering does the duplicate detection, why a batch is one commit and one index pass, and why the conflict assist only reports.
---

## 1. Singular write

`writeMemory` (`packages/store/src/store.ts:464`) does six things in order. It renders the memory and
checks the result, hashes the article text, asks whether that content already exists, claims a free
path, writes the file, then stages and commits it.

The order does the work. Asking the duplicate question before writing means a duplicate leaves the tree
byte-identical, with nothing for the next `git status` to report. Writing first and checking afterwards
would need a rollback, and rolling back a git operation introduces a second way to fail.

## 2. Content-hash dedup is enforced twice

The write path calls an injected `dedupeLookup` (`packages/store/src/store.ts:156`, wired to
`activePathForHash` at `packages/index/src/traces-persist.ts:162`). On a hit it returns the existing
path with `deduped: true`, and it creates no file and no commit.

A partial unique index in the database refuses the duplicate independently:

```sql
… ON files (content_hash) WHERE archived = 0 AND memory_type <> 'task'
```

(`packages/index/migrations/0008_tasks.sql:123-124`). The lookup carries the same `task` exclusion the
index does, so the question and the answer agree because they share one predicate and not because two
authors remembered to keep them aligned.

Tasks are excluded from duplicate detection in both directions
(`packages/store/src/store.ts:292-303`). Two open tasks with identical bodies are two real work items.
A memory whose article matches a task's must not be folded onto that task either, or the caller gets a
task's path handed back as the home of its fact. One predicate covers both directions, which keeps a
`memoryType !== "task"` test out of the three places the batch path touches its hash map.

## 3. Batch write is one commit and one index pass

`writeBatch` (`packages/store/src/store.ts:633`, `apps/cli/src/operations.ts:494`) exists as a
primitive rather than as a loop in the caller for one reason: N singular writes are N commits, and
because the indexer diffs one commit at a time, they are also N index passes.

The reindex goes through `update()` rather than `indexPaths()`
(`apps/cli/src/operations.ts:209-224`), because `indexPaths` cannot express a rename and never records
the watermark. The watermark is the commit sha the index has caught up to, stored in the database, and
the reindex is gated on a file having actually been written. Moving the watermark for a commit that
never happened is the bug that guard prevents.

## 4. Atomicity is a two-phase fold

Figure 1 draws the fold and its four exits. Every exit produces the same envelope: one result per
operation, in the order the caller supplied them.

```d2 pad=20 src="_figures/batch-two-phase.d2" title="N ops in input order enter phase one, which validates every op and writes nothing. An invalid op routes to an abort that marks every op skipped. All-valid routes to phase two, which stages and makes one commit. Phase two has two exits: a failed commit routes to git reset of the staged paths, and a successful commit routes to one index pass. All three of those exits converge on a single per-op result list, still in input order."
```

**Figure 1: two phases, four exits, one envelope.** Phase 1 writes nothing, so an atomic abort has no
file to undo. The `git reset -- <paths>` exit exists because
`git rm --cached` exits 128 as soon as one listed path was never staged, and that is exactly the state a
partly-failed `git.add` leaves behind. The single index pass on the success exit is why the batch
primitive exists at all.

Phase 1 validates every operation and writes nothing
(`packages/store/src/store.ts:662-685`), so an atomic abort has nothing to roll back. The failing
operation is reported with its own code, and every other operation reports `skipped: true`, including
the ones that already validated (`packages/store/src/store.ts:687-705`). Reporting a
validated-but-unwritten operation as `ok` with a path would hand the caller a path with no file behind
it.

Phase 2 writes, stages, and commits once. A failure there triggers `rollbackBatch`
(`packages/store/src/store.ts:524`), which clears the staged paths with `git reset -- <paths>`, because
`git rm --cached` exits 128 on a path that was never staged.

Three more properties of the fold matter:

- The batch's duplicate oracle consults itself first and the store second
  (`packages/store/src/store.ts:565-599`), because the store's lookup reads the index and the index
  does not yet know about anything this batch wrote.
- A `claimed` set does the same job for path collisions (`packages/store/src/store.ts:352-374`).
  Without it, two operations sharing a title would both be handed the unsuffixed path, and the second
  write would silently overwrite the first.
- One instant is read for the whole batch (`packages/store/src/store.ts:642-646`). Otherwise two
  episodic operations written either side of midnight would get different date prefixes, and the
  timestamps inside one indivisible operation would disagree about when it happened.

## 5. The conflict assist only reports

With `detect_conflicts` on, each operation's claim is reduced to a frame key by `frameKeyOf`
(`packages/domain/src/frame.ts`). A frame key is a normalized form of the claim that ignores wording,
so two memories making the same assertion about the same subject land on the same key. Each key is
matched against active non-task memories plus the batch's own earlier operations, and a match surfaces
as a per-operation `conflict` naming the other claim and where it lives
(`apps/cli/src/operations.ts:394`).

The write itself is unaffected. There is no auto-archive, no last-writer-wins, and no refusal, because
the contradiction is sometimes the answer: a memory recording that a runbook step changed necessarily
contradicts the memory stating the old step, and a resolver would destroy the pair a later reader needs
in order to see the change at all. The caller keeps both, calls `memory_correct` on the match, or skips.
That is a settled decision rather than a first-version limitation.

Three properties follow from it:

- The assist cannot block a write. `detectFrameConflicts` returns `Effect<…, never>` and turns a lookup
  failure into an empty map with a logged warning, matching how `bumpAccess` and `recordLink` behave, so
  a broken index degrades the report and never the commit.
- The degradation is partial rather than total. Only the store half of the comparison needs the
  database, so the batch keeps checking its own operations against each other when the query fails.
- There is one query per batch rather than one per operation. `activeFramesFor` takes an array so that a
  caller cannot loop over it (`packages/index/src/traces-persist.ts:197`), which puts the
  cost-per-write lesson into the function signature.

### 5.1. Two deliberate asymmetries

A match against the store outranks a match against an earlier operation in the same batch. A stored
memory is a fact already in the corpus, the earlier operation is one this call is about to create, and
`memory_correct` needs a path that already exists.

Only the later operation reports the conflict. Telling the caller that operation 3 matches operation 1
is actionable with operation 3 in hand. Reporting it on operation 1 as well would name a conflict with
something that did not exist when operation 1 was written, and would turn one finding into two. The map
records the first claimant of a slot, so a chain of restatements all point at the claim that has to be
reconciled rather than each pointing one step back.

### 5.2. Where the assist stops

The `article_html` path reports nothing, and both the tool description and the guide say so. On that
path `claim` is `""`, because the `<mark>` inside the caller's markup is the claim and the parser
extracts it on the first index pass, so `frameKeyOf` has nothing to work with. Deriving a claim at the
operations layer would mean parsing every operation's article before the store renders it: a second
parse of the same bytes, and a second place the gist rule could drift away from the parser.

`summary` counts no conflicts. Its five numbers partition the operations exactly, and a conflict is not
an outcome, since the operation wrote. Adding a field later stays possible; adding a sixth number a
client cannot reconcile with the other five does not.

## 6. Correction and archive

Correction (`packages/store/src/store.ts:764`) reads the target first, or the tree gains a superseding
file with nothing to supersede. Its `memhtml-supersedes` points at the target's archive path, where the
file lives only after this commit lands. Pointing at the pre-archive path would create a dangling href
in the same commit that made it dangle. Both files land in one commit.

Archive (`packages/store/src/store.ts:808`) is a `git mv` plus the metadata stamps. `stageArchive`
(`packages/store/src/store.ts:397`) creates the destination's parent directory first, because `git mv`
refuses a destination whose parent does not exist and the year partition is new every January.

## 7. Provenance is recorded in both planes

The writer stamps `memhtml-session`, `memhtml-prompt`, and `memhtml-turn` into the head, and attaches
`Memhtml-Session` and `Memhtml-Prompt` commit trailers
(`packages/store/src/plumbing.ts:367-389`). The operations layer records a `memory_session_links` row
carrying its `link_kind`, one of `wrote`, `read`, `corrected`, or `reinforced`
(`apps/cli/src/operations.ts:293`, `apps/cli/src/operations.ts:659`,
`apps/cli/src/operations.ts:768`).

The file-borne copy survives an index rebuild. The row makes the same link queryable in both
directions.

---
title: The write path
description: Ordering is the dedup mechanism, a batch is one commit and one reindex, and the conflict assist proposes without ever blocking a write.
---

## 1. Singular write

`writeMemory` (`packages/store/src/store.ts:464`) renders through the gate, hashes, asks the dedupe
question, claims a free path, writes, stages, and commits.

The order *is* the mechanism. A duplicate leaves the tree byte-identical with nothing for the next
`git status` to report, whereas a write-then-check order would need a rollback — and rolling back a git
operation is a second failure mode.

## 2. Content-hash dedup is enforced twice

The write path asks an injected `dedupeLookup` (`packages/store/src/store.ts:156`, wired to
`activePathForHash` at `packages/index/src/traces-persist.ts:162`) and returns the existing path with
`deduped: true`, creating no file and no commit.

Structurally, a partial unique index refuses it anyway:

```sql
… ON files (content_hash) WHERE archived = 0 AND memory_type <> 'task'
```

(`packages/index/migrations/0008_tasks.sql:123-124`). The lookup carries the same `task` exclusion as
the index, so the question and the answer agree by construction rather than by discipline.

**Tasks are carved out of dedup in both directions** (`packages/store/src/store.ts:292-303`). Two open
tasks with identical bodies are two real work items; and a memory whose article matches a task's must
not be deduped onto that task, or the caller is handed a task's path as the home of its fact. One
predicate, not a `memoryType !== "task"` test at each of the three places the batch touches its hash
map.

## 3. Batch write is one commit and one reindex

`writeBatch` (`packages/store/src/store.ts:633`, `apps/cli/src/operations.ts:494`) is the whole reason
the primitive exists rather than being a loop at the caller: N singular writes are N commits and,
because the indexer diffs per commit, N index passes.

The reindex goes through `update()` rather than `indexPaths()` (`apps/cli/src/operations.ts:209-224`)
because `indexPaths` cannot express a rename and never records the watermark. It is gated on a file
having been written — moving the watermark for a commit that never happened is the bug that guard
avoids.

## 4. Atomicity is a two-phase fold

Phase 1 validates every op and writes nothing (`packages/store/src/store.ts:662-685`), so an atomic
abort has nothing to roll back. The failed op is reported with its own code and every other op reports
`skipped: true`, **including ones that already validated**
(`packages/store/src/store.ts:687-705`) — reporting a validated-but-unwritten op as `ok` with a path
would hand the caller a path with no file behind it.

Phase 2 writes, stages, and commits once. A failure there triggers `rollbackBatch`
(`packages/store/src/store.ts:524`), which uses `git reset -- <paths>` rather than `git rm --cached`,
because `rm --cached` exits 128 as soon as one listed path was never staged — precisely the state a
partly-failed `git.add` leaves.

Three more properties of the fold:

- The batch's dedupe oracle consults **itself first, then the store**
  (`packages/store/src/store.ts:565-599`), because the store's lookup reads the index, which does not
  yet know about anything this batch wrote.
- A `claimed` set does the same job for path collisions (`packages/store/src/store.ts:352-374`).
  Without it, two ops sharing a title would both be handed the unsuffixed path and the second write
  would silently overwrite the first.
- One instant is read for the whole batch (`packages/store/src/store.ts:642-646`), or two episodic ops
  written either side of midnight would get different date prefixes and one indivisible operation's
  stamps would disagree about when it happened.

## 5. The conflict assist is propose-only

With `detect_conflicts` on, each op's claim is keyed by `frameKeyOf` (`packages/domain/src/frame.ts`)
and matched against ACTIVE non-task memories plus the batch's own earlier ops; a match surfaces as a
per-op `conflict` naming the other claim and where it lives (`apps/cli/src/operations.ts:394`).

**Nothing about the write changes.** No auto-archive, no last-wins, no refusal — because sometimes the
contradiction *is* the answer: a memory recording that a runbook step changed necessarily contradicts
the memory stating the old step, and a resolver would destroy the pair a later reader needs in order to
see the change at all. The caller decides: keep both, `memory_correct` the match, or skip. This is a
decision rather than a first-version limitation.

Three properties fall out of that, each load-bearing.

- **The assist is structurally unable to block a write.** `detectFrameConflicts` returns
  `Effect<…, never>` and swallows a lookup failure into an empty map with a logged warning, mirroring
  `bumpAccess` and `recordLink`, so a broken index degrades the report and never the commit.
- **The degradation is partial rather than total.** Only the store half needs the database, so the
  intra-batch fold keeps answering when the query cannot.
- **One query per batch, never one per op.** `activeFramesFor` takes an array precisely so a caller
  cannot loop (`packages/index/src/traces-persist.ts:197`) — the quadratic-write-cost lesson expressed
  as a signature.

### 5.1. Two deliberate asymmetries

A store match **outranks** an earlier op in the same batch, because a stored memory is a fact already
in the corpus while the earlier op is one this call is about to create — and `memory_correct`, the
usual action, needs a path that exists.

Only the LATER op reports. Op 3 matching op 1 tells a caller it is about to restate itself, which is
actionable with op 3 in hand, while reporting it on op 1 too would name a conflict with something that
did not exist when op 1 was written and would double one finding into two. The map records the FIRST
claimant of a slot, so a chain of restatements all point at the claim that has to be reconciled rather
than each one step back.

### 5.2. Where the assist stops

The `article_html` path reports nothing, and the boundary is stated in the tool description and the
guide rather than hidden. On that path `claim` is `""` by construction — the `<mark>` inside the
caller's markup is the claim and the parser extracts it on the first index pass — so `frameKeyOf` has
nothing to key. Deriving one at the ops layer would mean parsing every op's article before the store
renders it, a second parse of the same bytes and a second place the gist rule could drift from the
parser.

`summary` deliberately does not count conflicts. Its five numbers partition the ops exactly, and a
conflict is not an outcome — the op wrote. A later field is possible; a sixth number a client cannot
reconcile with the other five is not.

## 6. Correction and archive

**Correction** (`packages/store/src/store.ts:764`) reads the target first, or the tree gains an orphan
superseding file with nothing to supersede. Its `memhtml-supersedes` points at the target's *archive*
path, where the file lives only after this commit lands; pointing at the pre-archive path would create
a dangling href in the same commit that made it dangle. Both files land in one commit.

**Archive** (`packages/store/src/store.ts:808`) is `git mv` plus stamps. `stageArchive`
(`packages/store/src/store.ts:397`) creates the destination's parent first, because `git mv` refuses a
destination whose parent does not exist and the year partition is new every January.

## 7. Provenance is recorded in both planes

The writer stamps `memhtml-session`/`memhtml-prompt`/`memhtml-turn` into the head and attaches
`Memhtml-Session`/`Memhtml-Prompt` commit trailers (`packages/store/src/plumbing.ts:367-389`); the
operations layer records a `memory_session_links` row with its `link_kind` — `wrote`, `read`,
`corrected`, `reinforced` (`apps/cli/src/operations.ts:293`, `apps/cli/src/operations.ts:659`,
`apps/cli/src/operations.ts:768`).

File-borne provenance survives a rebuild; the row makes the same link queryable in both directions.

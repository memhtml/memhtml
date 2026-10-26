---
title: Sessions and the commit path
description: How the corpus is held as a value, why a session is a pointer to one version plus a log of its own operations, and the mechanical steps a session commit takes to validate, build a tree, and move a ref under the checkout lock.
---

## 1. The corpus is a value

The session commands never open `.memhtml/index.db`. They work on the head, which is the parsed corpus at one commit held in memory: an `effect` `HashMap` from path to record, plus persistent indexes by content hash, by frame key, by inbound link, by entity, and a lexical index for search (`packages/head/src/version.ts`). Every version is immutable. `advanceHead` (`packages/head/src/version.ts:165`) builds the next version from the one before it by parsing only the paths `git diff-tree` names, and every record it didn't touch is the same object in both versions. A test checks that sharing by reference, and a property test checks it over random edit sets.

Loading a version from git costs seconds on a large store, so each session commit and each `curate merge` also writes a snapshot of the version it lands, `.memhtml/snapshots/<sha>.arrow`. A v1 write and a hand `git commit` write none. A snapshot is one Apache Arrow file with one row per record (`packages/snapshot/src/snapshot.ts:330`), and the directory keeps the newest four (`SNAPSHOTS_KEPT`, `packages/snapshot/src/prune.ts:20`). `loadVersion` (`apps/cli/src/head-cache.ts:177`) takes the cheapest path that exists. It reads the commit's own snapshot when there is one. Otherwise it reads the snapshot of the ancestor with the fewest changed paths and advances it, and only when neither works does it read git. A snapshot that fails to read for any reason, including a decode error, a `format` key naming another format, or a sha that doesn't match its filename, is treated as a cache miss: the loader logs a warning, removes the file, and tries the next source. Only git can fail a load.

A snapshot carries a `format` metadata key (`FORMAT_METADATA_KEY`, currently `"1"`), and so does the vector cache. A file with no key reads as format 1, which is what every file written before the key existed is.

## 2. A session is a pointer and a log

A session holds its id, the ref it will land on, the commit it sees (`baseSha`), and an ordered log of operations. It holds nothing else (`packages/session/src/session.ts:38`). Its whole state is one file, `.memhtml/sessions/<id>.json`, written atomically as a whole every time. A session's view of the corpus is its base version with the log applied on top (`withOverlay`, `packages/head/src/overlay.ts:147`), and building that view copies nothing the log didn't change.

The log has seven operation kinds:

| Operation | What it does                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `put`     | Write a new record at a path.                                                                                   |
| `archive` | Move a record to `archive/<YYYY>[.<n>]/<path>`, its year's free slot, with the archive stamps.                  |
| `move`    | Move a live record to a new live path with its bytes unchanged, so its content hash and history travel with it. |
| `link`    | Add one `<link rel="memhtml-...">` edge to a record's head.                                                     |
| `unlink`  | Remove one edge from a record's head.                                                                           |
| `label`   | Add one `memhtml-entity` value to a record's head.                                                              |
| `unlabel` | Remove one `memhtml-entity` value from a record's head.                                                         |

The last four never touch the article, so a record keeps its content hash through all of them. A `move` doesn't rewrite the records that link to the old path. Those edges are explicit `unlink` and `link` pairs in the same log, so every file a commit changes is named by an operation, and `withRepoints` (`packages/session/src/moves.ts`) adds the pairs for a caller that only names the move.

Every writer of a log reads it, works for a while, and then writes. A `session exec` can run a script for seconds between its read and its append, so a plain lock would still lose an update when two calls read the same log. Each write therefore takes the session's lock (`withSessionLock`, `packages/session/src/session.ts:161`), re-reads the log under it, and writes only when the log still holds the operations the caller read. Otherwise it refuses with `StorageFailure` `session.moved` and writes nothing (`requireLogUnmoved`, `packages/session/src/session.ts:311`). A lock a killed process left goes stale after 30 seconds (`SESSION_LOCK_STALE_MS`).

## 3. Validation is one pure function

`validateOps` (`packages/session/src/validate.ts:183`) judges a log against a version and returns violations. It has no side effects, so `session put`, `session exec`, the curator's tools, the head server, and the commit all call the same function and agree.

| Violation       | Raised when                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`        | The file doesn't parse as a memory, or a `move` leaves a live record linking to the old path.                                                                          |
| `duplicate`     | A put's article is already held by an active record at another path.                                                                                                   |
| `claim-edit`    | A put lands on an active path with a different article.                                                                                                                |
| `reserved-path` | The path is under `.memhtml/`, is `memhtml.config.json`, or is an `index.html` or `sitemap.xml`. Under the `session` scope, `areas/arcs/` and `resources/people/` too. |
| `batch-cap`     | The log holds more than 200 operations (`BATCH_CAP`, `packages/session/src/validate.ts:47`).                                                                           |
| `write-bar`     | The store's policy refuses the record's type, or requires an anchor the record lacks (`writeBarReasons`, `packages/session/src/validate.ts:133`).                      |

The scope is `curate` for a session whose ref sits under `refs/heads/curate/` and `session` for every other ref, `main` included. The write bar's policy arrives as an argument, read from the store's `memhtml.config.json` at the moment of the call, and its library default refuses nothing (`packages/contracts/src/store-config.ts`).

## 4. The commit, step by step

`commitSession` (`packages/session/src/commit.ts:427`) is mechanical and calls no model. The whole call holds the session's lock, and its first act is to check that the log hasn't moved since the caller read it.

0. **Settle a killed commit.** A log carrying `pending` names a commit an earlier call built and may have landed before it was killed. Under the checkout lock, if that commit is on the ref, the answer is `committed` with `recovered: true`. If it isn't, `read-tree -m -u` puts the checkout back, `pending` is cleared, and the commit goes on.
1. **Validate.** `validateOps` judges the log against the base. Any violation answers `refused` with the list, and nothing is written.
2. **Check the base.** If the ref no longer names the base, the answer is `rebase-needed` with the new tip and the session's paths that changed. There's no shortcut for disjoint paths, because a duplicate or a frame-key rival is a collision between different paths, and only a version at the tip can judge it.
3. **Mark contradictions.** A put whose claim has the same frame key as an active record at another path gets a `memhtml-contradicts` link to it. Both stay live, and the pair is reported under `contradictions`.
4. **Build the commit.** Blobs, tree, and commit are written through a temporary git index under the operating system's temp directory, which is removed on every exit. The shared index isn't touched yet. The subject is `memhtml(<scope>): <message>` with a `Memhtml-Session: <id>` trailer.
5. **Save `pending`.** The new commit's sha is written to the log before anything shared moves.
6. **Land it.** `landOnRef` (`packages/session/src/commit.ts:284`) runs under the checkout lock and can't be interrupted once the lock is held. It reads the ref again, and if the ref moved it touches nothing and the commit answers `rebase-needed`. When `HEAD` is the ref, it checks the session's paths for uncommitted changes and answers `worktree-dirty` if there are any. Then `read-tree -m -u` moves the shared index and working tree to the new tree, a two-tree merge that keeps uncommitted edits at other paths. Last, `update-ref` moves the ref with a compare-and-swap, and a lost swap rolls the checkout back and also answers `rebase-needed`. A moved ref, `worktree-dirty`, and a lock that never came free all clear `pending`.
7. **Empty the log.** The log is saved with the new commit as its base and no operations.

The checkout moves before the ref on purpose. With the ref first, any failure in between would leave `HEAD` ahead of the index, and git would report the session's own files as staged deletions that the next `git commit -a` or v1 write would commit. With the checkout first, a failure leaves staged additions, which step 0 reverts and no commit can turn into a loss.

After a `committed` answer, the caller writes the new version's snapshot, best effort. A failed snapshot write is a log line and `snapshot: null`, never a failed commit, because the ref has already moved.

## 5. The checkout lock

One checkout is shared by every writer: the v1 store commands in any process, every session commit, and the `curate merge` fast-forward. The checkout lock keeps them from committing each other's staged files. It's `proper-lockfile` on `.memhtml/checkout`, so the lock itself is the directory `.memhtml/checkout.lock` (`withCheckoutLock`, `packages/session/src/checkout-lock.ts:36`). The timings live in one place (`packages/contracts/src/checkout-lock.ts:42-60`):

| Setting              | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| Goes stale after     | 10 s with no refresh                                    |
| Refreshed every      | 2 s while held                                          |
| A waiter retries for | 15 s, pausing 10 ms at first and doubling up to 250 ms  |
| Then                 | `ERR_STORAGE` (`checkout.locked`), with nothing written |

The lock is reentrant within one fiber. A v1 write takes it through `StoreShape.exclusive` (`packages/store/src/store.ts:236`) from its first stage to its commit, and `init`, `task status`, `publish`, `state export`, and `doctor --fix` take it as well.

One crash window remains. A process killed with SIGKILL in the few milliseconds a commit holds the lock leaves the lock behind, and it goes stale after 10 seconds. After that, a v1 write can sweep the dead commit's staged file into its own commit. The file lands on `main` and isn't lost: recovery keeps it, and the session answers `rebase-needed`. A test covers that sequence.

## 6. Commits through the head server

`session commit` and `session rebase` ask a running head server first (`sessionCommit` and `sessionRebase`, `apps/cli/src/v2.ts:1121` and `:1252`). `POST /v1/commit` reads the session's log itself and runs the same `commitSession` over the version at the session's base, one commit at a time. That version is the tip the server already holds, an ancestor built from it by the same tree diff an advance uses, or, for a base off the ref's history, a load. When the commit lands, the server writes its snapshot and, if the ref still points at it, holds the new commit as its head, so the calling command loads no head. The server reads the store policy on every request and passes its write bar to the commit, and the CLI reads the policy before it asks, so a malformed policy file fails with `ERR_STORE_CONFIG` on either path.

The client falls back to committing locally whenever the server never took the request or declined it (`other-ref`, `session-unreadable`, `base-unservable`, or `busy` after 20 seconds in the queue). Once the server has taken the request, a 5xx or no answer within `MEMHTML_COMMIT_DEADLINE_MS` fails with `ERR_STORAGE` instead. The ref may already have moved, and a second commit would race the first. Read `session status` before trying again: a log with zero operations has nothing left to commit.

Measured on a 10,286-record fixture on a shared host, a commit at the tip took 1.2 s through the server, against 3.2 s from a local snapshot and 7.0 s with no snapshot. A commit behind the tip (commit, rebase, commit) took 3.0 s through the server and 9.2 s locally.

## 7. Why the index doesn't move

A session commit writes git objects and moves a ref, and it never opens `index.db`. That keeps the commit path free of the single SQLite writer, which one slow search could hold for minutes. The cost is that the index trails the ref until `memhtml index update` runs. The head doesn't trail: `head search`, the head server, and the MCP `memory_search` and `memory_recall` tools when a head server answers them all read the tip of the branch the checkout has open, unless the server was started with `--ref`. [Write through a session](/learn/operations/write-through-a-session/) is the operational side of this page, and [concurrency and conflicts](/internals/concurrency-and-conflicts/) covers how sessions and the v1 doors share one tree.

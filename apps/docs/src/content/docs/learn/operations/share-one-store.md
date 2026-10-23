---
title: Share one store between a CLI and a server
description: Why a memhtml command and a running MCP server can touch one database at once, what the retry layer guarantees, and the one operation that still needs exclusivity.
---

```bash
memhtml serve mcp
MEMHTML_MCP_BIN=/path/to/bin.js memhtml serve mcp   # explicit path, for a split deployment
```

The server publishes fifteen tools and two resources over this same repo (`apps/mcp/src/tools.ts`). Curation stays off that tool surface deliberately: it is an operator action that produces a reviewable branch, and an agent should not start one mid-conversation.

## Yes, they can share it

A `memhtml` command and a running server can share one repo. SQLite's write-ahead logging admits one writer at a time and any number of concurrent readers:

- Readers never block the writer.
- A second writer waits instead of failing.
- A wait that outlives `busy_timeout` is retried with exponential backoff plus jitter for up to 20 seconds (`packages/index/src/database.ts`).

So running `memhtml write` while `memhtml serve mcp` serves the same store is a supported thing to do, and so is the every-ten-minutes `index update` cron running underneath a live agent session.

Measure it on your own hardware rather than taking the claim on trust:

```bash
node scripts/probe-sqlite-concurrency.mjs
```

## Why retrying is safe

The error being retried is `SQLITE_BUSY` specifically. The lock was never taken, so the statement had no effect to half-apply and there is no partial write to reconcile. A write inside a transaction rolls back before the retry, so the transaction re-runs whole rather than resuming from the middle.

The retry layer therefore matches `SQLITE_BUSY` alone, where a blanket retry on any SQLite error would repeat a statement that had already taken effect.

## Git writers wait for each other

The git side has its own rule. Every write that commits holds the checkout lock, `.memhtml/checkout.lock`, from its first stage to its commit. That covers `memhtml write`, `apply`, `correct`, `link`, `archive`, `task status`, `publish`, `state export`, `doctor --fix`, every session commit, and the `curate merge` fast-forward, in any process. So a CLI write and an MCP server write never commit each other's staged files. A writer waits up to 15 seconds for the lock and then fails with `ERR_STORAGE` (`checkout.locked`). Every writer but `doctor --fix` and `task status <path> done` has then written nothing, and running it again is safe.

A running [head server](/learn/operations/run-a-head-server/) shares the store the same way. It holds the head in memory and opens no database, and when it commits a session it takes the same lock.

## Don't check out a curate branch

`memhtml curate run` commits to its `curate/<date>` branch without checking it out, and it refuses to run on the branch your checkout has open, so a curation pass never needs other writes to stop. The one hazard left is a person checking out a `curate/<date>` branch to look at it. While it's checked out, a write from any process commits onto that branch, where it either gets landed on `main` as if it were curation or disappears with `git branch -D`.

Review a curator branch with `git log` and `git diff` against `main` instead, as [curate the corpus](/learn/operations/curate-the-corpus/#review-the-branch) shows.

## The supervisor holds nothing

`memhtml serve mcp` has no database of its own. It spawns `memhtml-mcp` with inherited stdio and waits (`apps/cli/src/serve.ts:72`), so the supervisor holds no handle that could conflict with the child. Interrupting it kills the child, so Ctrl-C never leaves an orphaned server holding the database open (`apps/cli/src/serve.ts:97`).

`MEMHTML_MCP_BIN` names the server explicitly. Absent, the supervisor uses the sibling-path default: `apps/cli/dist/serve.js` finds `apps/mcp/dist/bin.js` two directories over, because the two apps ship as one build. Set it for a split deployment that keeps them apart.

## The exception that never touches your store

`memhtml eval discriminate` never builds the application layer at all (`apps/cli/src/run.ts:848`). It is the discrimination gate, which checks that every probe query ranks its target fact above deliberately wrong versions of that fact. It measures the ranking stack against its own generated fixture corpus, in a temp directory, with an in-memory database, and it never opens your `index.db`.

Checking the gate is exactly what an operator wants to do while the server is up, and a gate that needed the store quiet would be a gate nobody ran at the moment it mattered.

```bash
memhtml eval discriminate        # safe with a server running, and with no credentials
```

See [check the discrimination gate](/learn/operations/check-the-discrimination-gate/).

## Two machines is a different question

Sharing one store between processes on one machine is solved. Sharing it between machines is solved for the git tree and open for the state plane. Git merges `.memhtml/state/access.jsonl` line by line, with no merge driver. Two machines' counts for one memory therefore never add up: changes to lines that are not adjacent merge cleanly, and changes to the same or adjacent lines conflict. A clone that exports before it imports also overwrites the committed rows. [Preserve the state plane](/learn/operations/preserve-the-state-plane/) covers the mitigation and how to detect a loss.

[Concurrency and conflict surfacing](/internals/concurrency-and-conflicts/) covers the mechanism.

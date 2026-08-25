---
title: Share one store between a CLI and a server
description: Why a memhtml command and a running MCP server can touch one database at once, what the retry layer guarantees, and the one operation that still needs exclusivity.
---

```bash
memhtml serve mcp
MEMHTML_MCP_BIN=/path/to/bin.js memhtml serve mcp   # explicit path, for a split deployment
```

The server publishes fourteen tools and two resources over this same repo (`apps/mcp/src/tools.ts:881`). Sleep stays off that tool surface deliberately: a curation run is a cron and operator action that produces a reviewable branch, and an agent should not start one mid-conversation.

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

## The one operation that needs exclusivity

`memhtml sleep run` needs it, for a git reason rather than a database one.

A run holds a checked-out `sleep/<date>` branch. A concurrent write therefore commits onto that branch, where it either gets merged into `main` as if it were curation or disappears with `git branch -D`. Neither outcome is one you want to discover later.

`git branch -D` discards more than the commits. A run records the state-plane writes it earns — a `trace-consolidation` watermark, an edge promotion, an entity promotion — as lines in `.memhtml/sleep/<run-id>.pending.jsonl`, a committed file on the run's own branch, and `memhtml sleep merge` applies them only after the fast-forward succeeds (`packages/sleep/src/contract.ts:306`). Dropping the branch drops that ledger with it, so those writes are never made and the sessions in it are simply re-read on the next cycle. That is the design working: `.memhtml/state.db` is not rebuildable from the tree, so a watermark written during a phase would outlive the branch that earned it, and because the watermark is an anti-join the transcript would go unread behind a row asserting it was handled. A write of your own that landed on the branch has no such ledger, which is the asymmetry this section exists to warn about.

Stop other writes for the length of a run. In practice that means the nightly `sleep run` sits at an hour when nothing else writes, and you start an interactive run with the agent idle.

## The supervisor holds nothing

`memhtml serve mcp` has no database of its own. It spawns `memhtml-mcp` with inherited stdio and waits (`apps/cli/src/serve.ts:72`), so the supervisor holds no handle that could conflict with the child. Interrupting it kills the child, so Ctrl-C never leaves an orphaned server holding the database open (`apps/cli/src/serve.ts:97`).

`MEMHTML_MCP_BIN` names the server explicitly. Absent, the supervisor uses the sibling-path default: `apps/cli/dist/serve.js` finds `apps/mcp/dist/bin.js` two directories over, because the two apps ship as one build. Set it for a split deployment that keeps them apart.

## The exception that never touches your store

`memhtml eval discriminate` never builds the application layer at all (`apps/cli/src/run.ts:834`). It is the discrimination gate, which checks that every probe query ranks its target fact above deliberately wrong versions of that fact. It measures the ranking stack against its own generated fixture corpus, in a temp directory, with an in-memory database, and it never opens your `index.db`.

Checking the gate is exactly what an operator wants to do while the server is up, and a gate that needed the store quiet would be a gate nobody ran at the moment it mattered.

```bash
memhtml eval discriminate        # safe with a server running, and with no credentials
```

See [check the discrimination gate](/learn/operations/check-the-discrimination-gate/).

## Two machines is a different question

Sharing one store between processes on one machine is solved. Sharing it between machines is solved for the git tree and open for the state plane: `.memhtml/state/access.jsonl` merges as a whole file, which makes it last-writer-wins. [Preserve the state plane](/learn/operations/preserve-the-state-plane/) covers the mitigation and how to detect a loss.

[Concurrency and conflict surfacing](/internals/concurrency-and-conflicts/) covers the mechanism.

---
title: Share one store between a CLI and a server
description: Why a memhtml command and a running MCP server can touch one database at once, what the retry layer guarantees, and the one operation that still needs exclusivity.
---

```bash
memhtml serve mcp
MEMHTML_MCP_BIN=/path/to/bin.js memhtml serve mcp   # explicit path, for a split deployment
```

Fourteen tools and two resources over this same repo (`apps/mcp/src/tools.ts:735`). Sleep is
deliberately absent from the tool surface: it is a cron and operator action producing a reviewable
branch, not something an agent triggers mid-conversation.

## Yes, they can share it

**A CLI command and a running server can share one repo.** WAL admits one writer at a time and any number
of concurrent readers:

- Readers never block the writer.
- A second writer waits rather than failing.
- A wait that outlives `busy_timeout` is retried with jittered exponential backoff for up to 20 seconds
  (`packages/index/src/database.ts`).

So `memhtml write` while `memhtml serve mcp` is serving the same store is a supported thing to do, and so
is the every-ten-minutes `index update` cron running underneath a live agent session.

Measure it on your own hardware rather than taking the claim:

```bash
node scripts/probe-sqlite-concurrency.mjs
```

## Why retrying is safe

The error being retried is `SQLITE_BUSY` **specifically**. The lock was never taken, so the statement had
no effect to half-apply — there is no partial write to reconcile. A write inside a transaction rolls back
before the retry, so the transaction re-runs whole rather than resuming from the middle.

That is what makes the backoff a correctness-preserving retry rather than a hopeful one. A blanket retry
on any SQLite error would not have this property.

## The one operation that needs exclusivity

`memhtml sleep run`, and the reason is git rather than the database.

A run holds a checked-out `sleep/<date>` branch. A concurrent write therefore commits **onto that
branch**, where it is either merged into `main` as if it were curation or lost with `git branch -D`.
Neither outcome is one you want to discover later.

Quiesce writes for the duration of a run. In practice that means the nightly `sleep run` sits at an hour
when nothing else writes, and an interactive run is something you do with the agent idle.

## The supervisor holds nothing

`memhtml serve mcp` has no database of its own. It spawns `memhtml-mcp` with inherited stdio and waits
(`apps/cli/src/serve.ts:72`), so the supervisor has no handle that could conflict with the child.
Interrupting it kills the child, so Ctrl-C never leaves an orphaned server holding the database open
(`apps/cli/src/serve.ts:97`).

`MEMHTML_MCP_BIN` names the server explicitly. Absent, the supervisor uses the sibling-path default —
`apps/cli/dist/serve.js` finds `apps/mcp/dist/bin.js` two directories over, because the two apps ship as
one build. Set it for a split deployment that does not keep them side by side.

## The exception that never touches your store

`memhtml eval discriminate` never builds the application layer at all (`apps/cli/src/run.ts:834`). It
measures the ranking stack against its own generated fixture corpus, in a temp directory, with an
in-memory database, and never reads your `index.db`.

That is deliberate: checking the gate is exactly what an operator wants to do while the server is up, and
a gate that needed the store quiesced would be a gate nobody ran at the moment it mattered.

```bash
memhtml eval discriminate        # safe with a server running, and with no credentials
```

See [check the discrimination gate](/learn/operations/check-the-discrimination-gate/).

## Two machines is a different question

Sharing one store between processes on one machine is solved. Sharing it between machines is not fully
solved — the git tree merges, but `.memhtml/state/access.jsonl` is a whole-file merge and is
last-writer-wins. [Preserve the state plane](/learn/operations/preserve-the-state-plane/) covers the
mitigation and how to detect a loss.

[Concurrency and conflict surfacing](/internals/concurrency-and-conflicts/) develops the
mechanism.

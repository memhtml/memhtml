---
title: Share one store between a CLI and a server
description: Why a memhtml command and a running MCP server can share one store and its two databases, what the retry layer guarantees, and the one hazard left, a checked-out curate branch.
---

```bash
memhtml serve mcp
MEMHTML_MCP_BIN=/path/to/bin.js memhtml serve mcp   # explicit path, for a split deployment
```

The server publishes fifteen tools (`apps/mcp/src/tools.ts`) and two resource templates (`apps/mcp/src/resources.ts`) over this same repo. Curation stays off that tool surface deliberately: it is an operator action that produces a reviewable branch, and an agent should not start one mid-conversation.

## Yes, they can share it

A `memhtml` command and a running server can share one repo. `index.db` uses SQLite's write-ahead logging, which admits one writer at a time and any number of concurrent readers:

- Readers never block the writer of `index.db`. `state.db` keeps a rollback journal, so a write there waits for any read in progress to finish (`packages/index/src/database.ts::makeDatabase`).
- A second writer waits instead of failing at once. If the wait runs out, a `memhtml write` fails with `ERR_STORAGE` after its git commit has landed, and the next `index update` indexes the record.
- A wait that outlives `busy_timeout` (5 seconds) is retried with exponential backoff plus jitter for up to 20 seconds more, so a blocked write gives up after about 25 seconds (`packages/index/src/database.ts`).

So running `memhtml write` while `memhtml serve mcp` serves the same store is a supported thing to do, and so is a periodic `index update` job you run yourself underneath a live agent session.

In a checkout of the memhtml repository (the npm package does not ship `scripts/`), check the SQLite behavior this rests on from a second process rather than taking the claim on trust:

```bash
node scripts/probe-sqlite-concurrency.mjs
```

## Why retrying is safe

The error being retried is `SQLITE_BUSY` specifically. It means a lock the statement needed was not granted, so that statement, or the transaction it ran in, took no effect, and running it again cannot apply anything twice. A write inside a transaction rolls back before the retry, so the transaction re-runs whole rather than resuming from the middle.

The retry layer matches the primary `SQLITE_BUSY` code (5) alone, not extended codes such as `SQLITE_BUSY_SNAPSHOT`. A blanket retry on any SQLite error could repeat a statement that had already taken effect.

## Git writers wait for each other

The git side has its own rule. Every write that commits holds the checkout lock, `.memhtml/checkout.lock`, from its first stage to its commit. That covers `memhtml init`, `write`, `apply`, `correct`, `link`, `archive`, `task add`, `task status`, `publish`, `state export`, `doctor --fix`, every session commit (`curate run` and `curate collapse` commit through one), and the `curate merge` fast-forward, in any process. So a CLI write and an MCP server write never commit each other's staged files. A writer waits up to 15 seconds for the lock and then gives up with `checkout.locked`. A `write`, `apply`, `correct`, `link`, `archive` or `task add` has then written nothing, and running it again is safe.

A running [head server](/learn/operations/run-a-head-server/) shares the store the same way. It holds the head in memory and opens no database, and when it commits a session it takes the same lock.

## Don't check out a curate branch

`memhtml curate run` commits to its `curate/<date>` branch without checking it out, and it refuses to run on the branch your checkout has open, so a curation pass never needs other writes to stop. The one hazard left is a person checking out a `curate/<date>` branch to look at it. While it's checked out, a CLI or MCP write, `task add`, `task status`, `publish`, `state export` and `doctor --fix` all commit onto that branch, where the commit either gets landed on `main` as if it were curation or disappears with `git branch -D`. A session commit still goes to the ref its session started on, `main` by default.

Review a curator branch with `git log` and `git diff` against `main` instead, as [curate the corpus](/learn/operations/curate-the-corpus/#review-the-branch) shows.

## The supervisor holds nothing

`memhtml serve mcp` has no database of its own. It spawns `memhtml-mcp` with inherited stdio and waits (`apps/cli/src/serve.ts::serveMcp`), so the supervisor holds no handle that could conflict with the child. Ctrl-C on a terminal signals both processes, so it stops the server along with the supervisor and leaves no orphaned server. A SIGINT or SIGTERM sent to the supervisor's process alone stops only the supervisor: the server keeps running, with the database open, until its stdin closes.

`MEMHTML_MCP_BIN` names the server explicitly. Absent, the supervisor uses a sibling path, because the two apps ship as one build (`apps/cli/src/serve.ts::mcpEntryPoint`): `memhtml-mcp.mjs` beside it in the npm package's `dist/`, else `apps/mcp/dist/bin.js` two directories up and across from `apps/cli/dist/serve.js` in a workspace build. Set it for a split deployment that keeps them apart.

## The exception that never touches your store

`memhtml eval discriminate` never builds the application layer at all (`apps/cli/src/run.ts::run`). It is the discrimination gate, which checks that every probe query ranks its target fact above deliberately wrong versions of that fact. It measures the ranking stack against its own generated fixture corpus, in a temp directory, with an in-memory database, and it never opens your `index.db`.

Operators check the gate while the server is up. A gate that needed the store quiet would be a gate nobody ran at the moment it mattered.

```bash
memhtml eval discriminate        # safe with a server running, and with no credentials
```

See [check the discrimination gate](/learn/operations/check-the-discrimination-gate/).

## Two machines is a different question

Sharing one store between processes on one machine is solved. Between machines, the git tree is solved and the state plane is not. Git merges `.memhtml/state/access.jsonl` line by line, with no merge driver. Two machines' counts for one memory therefore never add up: changes to lines that are not adjacent merge cleanly, and changes to the same or adjacent lines conflict. A clone that exports before it imports also overwrites the committed rows. [Preserve the state plane](/learn/operations/preserve-the-state-plane/) covers the mitigation and how to detect a loss.

[Concurrency and conflict surfacing](/internals/concurrency-and-conflicts/) covers the mechanism.

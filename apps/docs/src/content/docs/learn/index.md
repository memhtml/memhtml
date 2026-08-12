---
title: Learn
description: Tutorials that take you from a clone to a working memory store, and twelve how-to pages for operating one.
---

This topic gets a memory store running and then keeps it running. It has two halves.

The **tutorials** are a single path, in order. Each one ends with a store that does more than the one
before it, and each command shown is a command you can run.

1. [Install memhtml and initialize a store](/learn/tutorial/install/) — clone, build, `memhtml init`.
   Nothing is published to a registry, so this is the honest path.
2. [Write your first memory](/learn/tutorial/first-memory/) — `memhtml write`, the file it lands in the
   git tree, and why one fact goes in one file.
3. [Retrieve it](/learn/tutorial/first-retrieval/) — `memhtml search` and `memhtml recall`, and what
   actually separates them.
4. [Wire up the MCP server](/learn/tutorial/mcp-server/) — `memhtml serve mcp`, and the fourteen tools
   and two resources a client sees.

The **operations** pages are twelve task-shaped how-tos, one per section of the runbook. They assume a
store already exists and answer a question you arrived with.

| Page | Answers |
|---|---|
| [Configure the environment](/learn/operations/configure-the-environment/) | Which variables the binary reads, and what each one degrades when it is absent |
| [Initialize a store](/learn/operations/initialize-a-store/) | Why a fresh clone must run `memhtml init` before its first merge |
| [Run the store day to day](/learn/operations/run-the-store-day-to-day/) | The daily verbs, the cron lines, and what moves the access plane |
| [Share one store between a CLI and a server](/learn/operations/share-one-store/) | Whether a command and a running server can touch one database at once |
| [Rebuild the index](/learn/operations/rebuild-the-index/) | When `update` is not enough, and how to clear a vector-space mismatch |
| [Preserve the state plane](/learn/operations/preserve-the-state-plane/) | The one set of facts the git tree cannot reproduce |
| [Run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/) | Fifteen phases on a branch, how to read them, when the merge refuses |
| [Check the discrimination gate](/learn/operations/check-the-discrimination-gate/) | The one number that says whether retrieval works at all |
| [Audit and publish the corpus](/learn/operations/audit-and-publish-the-corpus/) | Every `memhtml doctor` finding and its fix |
| [Index session transcripts](/learn/operations/index-session-transcripts/) | The trace plane, and the firewall between it and memory retrieval |
| [Diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/) | Where to look when nothing errors and the answers are wrong |
| [Recover from a lost index](/learn/operations/recover-from-a-lost-index/) | What a clone plus a rebuild restores, and what it cannot |

## Two things to know before you start

**Every command writes exactly one JSON envelope to stdout, and nothing else.** Logs go to stderr.
Exit 0 is success, 2 is a usage error you fix by changing the call, 1 is a runtime failure you fix by
changing the repo or the environment (`apps/cli/src/envelope.ts:87`). So every command on this site is
safe to pipe into `jq` and safe to run from cron, and the examples below show the envelope rather than
describing it.

**The git tree is the system of record.** `.memhtml/index.db` is a projection of it: delete it and you
lose time, not memories. That single property is why the operations pages read the way they do — most
recovery is a rebuild, and most of what looks like corruption is a stale watermark.
[Store layout and path algebra](/internals/store-layout-and-path-algebra/) develops it.

If you are an AI agent rather than a person reading a page: `memhtml manifest` answers with every
command, flag, response type, error code, and environment variable this binary accepts, and it answers
on a machine with no repo, no database, and no credentials. Start there, then come back here for the
worked paths.

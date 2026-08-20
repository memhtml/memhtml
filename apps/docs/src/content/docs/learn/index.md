---
title: Learn
description: Tutorials that take you from a clone to a working memory store, and how-to pages for operating one.
---

This topic gets a memory store running and then keeps it running.

The tutorials are one path, in order. Each ends with a store that does more than the one before it, and every command shown is a command you can run.

1. [Install memhtml and initialize a store](/learn/tutorial/install/): `npm i -g memhtml`, then `memhtml init`. One package carries the whole system and installs two binaries; the page also covers building from a clone, which is what contributors do.
2. [Write your first memory](/learn/tutorial/first-memory/): `memhtml write`, the file it commits into the git tree, and why one fact goes in one file.
3. [Retrieve it](/learn/tutorial/first-retrieval/): `memhtml search` and `memhtml recall`, and what separates them.
4. [Wire up the MCP server](/learn/tutorial/mcp-server/): `memhtml serve mcp`, and the tools and resources a client sees.

The operations pages are task-shaped how-tos, one per section of the runbook. They assume a store already exists, and each answers a question you arrived with.

| Page                                                                              | Answers                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Configure the environment](/learn/operations/configure-the-environment/)         | Which variables the binary reads, and what each one degrades when it is absent        |
| [Initialize a store](/learn/operations/initialize-a-store/)                       | Why a fresh clone runs `memhtml init` before its first merge                          |
| [Run the store day to day](/learn/operations/run-the-store-day-to-day/)           | The daily verbs, the cron lines, and what moves the access plane                      |
| [Share one store between a CLI and a server](/learn/operations/share-one-store/)  | Whether a command and a running server can touch one database at once                 |
| [Rebuild the index](/learn/operations/rebuild-the-index/)                         | When `update` is not enough, and how to clear a vector-space mismatch                 |
| [Preserve the state plane](/learn/operations/preserve-the-state-plane/)           | The one set of facts the git tree cannot reproduce                                    |
| [Run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/)   | Fifteen phases on a branch, how to read them, when the merge refuses                  |
| [Check the discrimination gate](/learn/operations/check-the-discrimination-gate/) | The gated number that says whether retrieval still tells a fact from its own negation |
| [Audit and publish the corpus](/learn/operations/audit-and-publish-the-corpus/)   | Every `memhtml doctor` finding and its fix                                            |
| [Index session transcripts](/learn/operations/index-session-transcripts/)         | The trace plane, and the firewall between it and memory retrieval                     |
| [Diagnose poor retrieval](/learn/operations/diagnose-poor-retrieval/)             | Where to look when nothing errors and the answers are wrong                           |
| [Recover from a lost index](/learn/operations/recover-from-a-lost-index/)         | What a clone plus a rebuild restores, and what it cannot                              |

## Before you start

Every command writes exactly one JSON envelope to stdout and nothing else, and sends its logs to stderr. Exit 0 is success, 2 is a usage error you fix by changing the call, and 1 is a runtime failure you fix by changing the repository or the environment (`apps/cli/src/envelope.ts:87`). So every command on this site is safe to pipe into `jq` and safe to run from cron, and the examples show the envelope rather than describing it.

The git tree is the system of record, and `.memhtml/index.db` is a projection of it: delete the index and you lose time rather than memories. That property is why the operations pages read the way they do. Most recovery is a rebuild, and most of what looks like corruption is a stale watermark. [Store layout and path algebra](/internals/store-layout-and-path-algebra/) develops it.

If you are an AI agent rather than a person reading a page, start with `memhtml manifest`. It answers with every command, flag, response type, error code, and environment variable this binary accepts, and it answers on a machine with no repository, no database, and no credentials. Come back here for the worked paths.

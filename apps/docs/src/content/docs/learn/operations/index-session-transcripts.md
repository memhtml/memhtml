---
title: Index session transcripts
description: Scan Claude Code transcripts into the trace plane, search them, join them to memories, and understand the firewall between traces and memory retrieval.
---

```bash
memhtml trace index                       # scan $MEMHTML_TRACE_ROOT for Claude Code transcripts
memhtml trace search "some prompt text"
memhtml trace links --session-id 0d8f…
memhtml trace links --path areas/inbox/some-memory.html
```

The trace plane answers provenance questions: which session produced this memory, and which memories came out of that session. It uses its own tables, which no ranking arm reads.

## Scanning

```json
{
  "apiVersion": "1",
  "type": "trace.report",
  "data": {
    "traceRoot": "/home/you/.claude",
    "filesSeen": 0,
    "skipped": 0,
    "tailed": 0,
    "rescanned": 0,
    "filesFailed": 0,
    "bytesRead": 0,
    "sessionsWritten": 0,
    "promptsWritten": 0,
    "tailsMerged": 0
  }
}
```

The scan reads only what changed. It compares each transcript against a watermark holding that file's size, its modification time, and the byte offset the last scan stopped at (`packages/traces/src/watermark.ts::watermarkPlan`), so an unchanged corpus reads zero bytes instead of re-walking the tree. That is what `bytesRead: 0` on a converged run means, and it is why the hourly cron line costs nothing.

Both the size and the modification time have to match before the scan skips a file, because size alone would miss an in-place rewrite of the same length. `tailed` counts files read from their recorded offset forward, and `rescanned` counts files read from the start, because they had no watermark yet or the watermark no longer described them.

`filesFailed` counts the files the scan planned to read and could not: a file removed after the scan listed it, a permission rejection, a transient IO error (`packages/traces/src/scan.ts::ScanReport::failed`). The four together account for the whole plan, since `skipped + tailed + rescanned + filesFailed` equals `filesSeen`, which is what lets you tell an unreadable transcript from an unchanged one instead of reading both as a quiet skip. A failed read changes no watermark: the file keeps the one it had, or none after a failed first read, so the next run that lists the file tries it again.

`sessionsWritten` counts the files a `traces` ROW was written for, which is narrower than the files that were read. Three outcomes read as no session written: a skip, a failed read, and a read in which no record the parser reads carries a session id, such as a transcript holding only `file-history-*` entries. Neither `tailed` nor `rescanned` answers this, because a file read without error can still hold no session, so the count comes from the rows written (`apps/cli/src/operations.ts::indexTraces`). `promptsWritten` counts the prompt rows written for those sessions, a tailed session's earlier prompts included, and `tailsMerged` counts the tailed files merged into a stored row.

`$MEMHTML_TRACE_ROOT` is read-only. Nothing in this system modifies a transcript, and the watermarks live in `index.db`. The scan reads `projects/<slug>/` under the root, and a root that holds no `projects` directory, or does not exist, is not an error: the report reads `filesSeen: 0`.

## Searching

```bash
memhtml trace search "pool ceiling" --since 2026-08-01 --limit 20
memhtml trace search "pool ceiling" --cwd /home/you/work/checkout-api
```

```json
{
  "apiVersion": "1",
  "type": "trace.sessions",
  "data": {
    "sessions": [],
    "degraded": false
  }
}
```

`memhtml trace search` runs full-text search over session first-prompts and AI-written titles, and it never enters memory retrieval. Use it to find the session rather than the fact. `--cwd` keeps the sessions whose first recorded working directory equals the value exactly, so a trailing slash or a parent directory matches nothing. `--since` is an inclusive lower bound compared as text against `started_at`, which is stored in UTC with milliseconds, so pass a date such as `2026-08-01` or a full UTC instant with milliseconds. No other form is refused or converted. `--limit` caps how many sessions come back. `degraded` is `true` when the query holds no searchable word, and the answer then lists sessions newest first.

## Joining traces to memories

```bash
memhtml trace links --session-id 0d8f…      # every memory this session touched
memhtml trace links --path resources/infra/one-writer.html   # every session that touched this memory
```

Both directions come from one command. Each link in the answer carries a `linkKind`, which is `wrote`, `read` or `corrected`, so you can tell a memory a session wrote from one it only read. Provenance reads both ways because `memhtml write --session-id` stamps the session into the file's head and also indexes it as a link, and `memhtml read --session-id` records a `read` link.

Calling `trace links` with neither `--session-id` nor `--path` is a refusal rather than a scan of the whole table (`apps/cli/src/operations.ts::traceLinks`):

```json
{
  "apiVersion": "1",
  "error": "invalid memory: trace links needs a session_id or a path",
  "code": "ERR_INVALID_MEMORY",
  "suggestions": ["memhtml manifest"]
}
```

## The firewall

Two properties keep the trace plane out of memory retrieval.

Traces stay out of the ranked path. `memhtml search` and `memhtml recall` rank memories, `memhtml trace
search` ranks sessions, no query returns both, and none of retrieval's four ranking arms, which are full-text search, vector similarity, recency, and salience, reads a trace row.

A memory rebuild leaves the trace tables alone, because it empties only the tables in `packages/index/src/schema-const.ts::MEMORY_TABLES` (`packages/index/src/indexer.ts::makeIndexer::truncateForRebuild`). So `memhtml
index rebuild`, which empties every memory table and, through a delete trigger, the full-text search index, costs no re-walk of `$MEMHTML_TRACE_ROOT`. The trace tables and the memory index are rebuilt by different commands because they are recovered from different sources: the transcripts for one, the tree for the other.

Recovering the trace tables therefore means running `memhtml trace index` after `index.db` is lost: the command creates a new `index.db`, which holds no watermark, so the scan reads every transcript under `$MEMHTML_TRACE_ROOT` from the start. No flag forces that on an index that still holds its watermarks. The full read is slow, it brings back only the transcripts still under the root, and the memory-session links are lost with the old `index.db`, because nothing rebuilds them.

## How transcripts become memories

The scan indexes transcripts and leaves them as transcripts, and no command turns one into a memory. An agent that wants a session's lessons kept reads `memhtml trace search` over what the scan indexed, and `memhtml trace links` for the memories that a `write`, `apply`, `correct`, `task add` or `read` given that session's id touched. It writes the records through a [session](/learn/operations/write-through-a-session/), where the write bar judges them, and `memhtml session commit` records no link.

`memhtml trace search` reads only what the last `memhtml trace index` wrote, so run the scan with the other [upkeep commands](/learn/operations/run-the-store-day-to-day/). `memhtml trace links` needs no scan, because a link is recorded when the memory is written or read.

[The trace indexer and its firewall](/internals/the-trace-indexer/) covers the streaming parser and the watermark.

---
title: Index session transcripts
description: Scan Claude Code transcripts into the trace plane, search them, join them to memories, and understand the firewall between traces and memory retrieval.
---

```bash
memhtml trace index                       # scan $MEMHTML_TRACE_ROOT for Claude Code transcripts
memhtml trace search "some prompt text"
memhtml trace links --session-id <id>
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
    "bytesRead": 0,
    "sessionsWritten": 0,
    "promptsWritten": 0,
    "tailsMerged": 0
  }
}
```

The scan reads only what changed. It compares each transcript against a watermark holding that file's size, its modification time, and the byte offset the last scan stopped at (`packages/traces/src/watermark.ts:66`), so an unchanged corpus reads zero bytes instead of re-walking the tree. That is what `bytesRead: 0` on a converged run means, and it is why the hourly cron line costs nothing.

Both the size and the modification time have to match before the scan skips a file, because size alone would miss an in-place rewrite of the same length. `tailed` counts files read from their recorded offset forward, and `rescanned` counts files read from the start because the watermark no longer described them.

`$MEMHTML_TRACE_ROOT` is read-only. Nothing in this system modifies a transcript.

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

`memhtml trace search` runs full-text search over session first-prompts and AI-written titles, and it never enters memory retrieval. Use it to find the session rather than the fact. `--cwd` restricts the results to sessions started from one directory, and `--since` is an ISO-8601 lower bound on `started_at`.

## Joining traces to memories

```bash
memhtml trace links --session-id 0d8f…      # every memory this session touched
memhtml trace links --path resources/infra/one-writer.html   # every session that touched this memory
```

Both directions come from one command. A link carries its `link_kind`, so you can tell a memory a session wrote from one it only read. Provenance reads both ways because `memhtml write --session-id` stamps the session into the file's head and also indexes it as a link, and `memhtml read --session-id` records a `read` link.

Calling `trace links` with neither `--session-id` nor `--path` is a refusal rather than a scan of the whole table (`apps/cli/src/operations.ts:1415`):

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

A memory rebuild leaves the trace tables alone (`packages/index/src/schema-const.ts:59`). So `memhtml
index rebuild`, which drops the full-text search index and deletes every memory table, costs no re-walk of `$MEMHTML_TRACE_ROOT`. The trace plane and the memory index are rebuilt by different commands because they are recovered from different sources: the tree for one, the transcripts for the other.

Recovering the trace tables therefore means re-running `memhtml trace index` from a zero watermark, which re-walks `$MEMHTML_TRACE_ROOT` in full. That is slow and loses nothing.

## How transcripts become memories

The scan indexes transcripts and leaves them as transcripts. Turning a session into a memory is the `trace-consolidation` phase of the nightly cycle, which hands unread transcripts to an agent and commits one memory per candidate that clears the bar. Its batch is at most ten sessions a night, so the two commands pair naturally: index hourly, consolidate nightly.

`memhtml trace index` on the cron is therefore the prerequisite for that phase having anything to read. See [run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/) for what the phase reports when it distills nothing.

[The trace indexer and its firewall](/internals/the-trace-indexer/) covers the streaming parser and the watermark.

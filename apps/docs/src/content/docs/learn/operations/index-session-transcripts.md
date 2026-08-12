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

The trace plane answers provenance questions: which session produced this memory, and which memories came
out of that session. It is a separate plane from memory retrieval, deliberately.

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

The scan reads only what changed, against a **size + mtime + byte-offset watermark**
(`packages/traces/src/watermark.ts:66`), so an unchanged corpus reads zero bytes rather than re-walking the
tree. That is what `bytesRead: 0` on a converged run means, and it is why the hourly cron line costs
nothing.

Both size **and** mtime must match to skip. Size alone would miss an in-place rewrite of the same length.
`tailed` counts files read from their recorded offset forward; `rescanned` counts files read from the start
because the watermark no longer described them.

`$MEMHTML_TRACE_ROOT` is **read-only and never written**. Nothing in this system modifies a transcript.

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

`memhtml trace search` is FTS over **session first-prompts and AI titles**, and it never enters memory
retrieval. It is for finding the session, not the fact. `--cwd` restricts to sessions started from one
directory, and `--since` is an ISO-8601 lower bound on `started_at`.

## Joining traces to memories

```bash
memhtml trace links --session-id 0d8f…      # every memory this session touched
memhtml trace links --path resources/infra/one-writer.html   # every session that touched this memory
```

Both directions, one command. A link carries its `link_kind`, so you can tell a memory a session *wrote*
from one it merely *read* — provenance is queryable both ways because `memhtml write --session-id` stamps
the session into the head **and** indexes it as a link, and `memhtml read --session-id` records a `read`
link.

Calling it with neither `--session-id` nor `--path` is a refusal, not a scan of the whole table
(`apps/cli/src/operations.ts:1415`):

```json
{
  "apiVersion": "1",
  "error": "invalid memory: trace links needs a session_id or a path",
  "code": "ERR_INVALID_MEMORY",
  "suggestions": ["memhtml manifest"]
}
```

## The firewall

Two properties keep the trace plane from leaking into memory:

**Traces never enter memory retrieval.** `memhtml search` and `memhtml recall` rank memories. `memhtml
trace search` ranks sessions. There is no query that returns both, and no arm of the four-arm fold reads a
trace row.

**A memory rebuild never touches the trace tables** (`packages/index/src/schema-const.ts:59`). So
`memhtml index rebuild` — which drops the FTS index and deletes every memory table — costs no re-walk of
`$MEMHTML_TRACE_ROOT`. The trace plane and the memory projection are rebuilt by different commands because
they are recovered from different sources: the tree for one, the transcripts for the other.

The recovery for the trace tables is therefore to re-run `memhtml trace index` from a zero watermark, which
re-walks `$MEMHTML_TRACE_ROOT` in full: slow, not lossy.

## How transcripts become memories

The scan indexes transcripts; it does not distil them. Turning a session into a memory is the
`trace-consolidation` phase of the nightly cycle, which hands unread transcripts to an agent and commits
one memory per candidate that clears the bar. Its batch is at most ten sessions a night, so the two
commands pair naturally: index hourly, consolidate nightly.

`memhtml trace index` on the cron is therefore the prerequisite for that phase having anything to read. See
[run and review a sleep cycle](/learn/operations/run-and-review-a-sleep-cycle/) for what the phase reports
when it distils nothing.

[The trace indexer and its firewall](/internals/the-trace-indexer/) develops the streaming
parser and the watermark.

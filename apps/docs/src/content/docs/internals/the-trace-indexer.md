---
title: The trace indexer
description: A read-only index over session transcripts that stores pointers rather than content, with a table-name firewall keeping it out of retrieval.
---

## 1. The store never holds session content

`.memhtml` never holds session content. The trace tables are a read-only index over the agent runtime's
transcript directory, and the root is a parameter rather than a constant so the scan is drivable against a
fixture tree (`packages/traces/src/scan.ts:48-57`).

## 2. The watermark is size, mtime, and a byte offset

`packages/traces/src/watermark.ts:66`. Matching size and mtime skips the file unopened; growth *tails*
from the stored offset; a shrink, a backward mtime, or an offset past the current size rescans from 0,
because a rewrite invalidates the offset's meaning.

## 3. Streaming parse

`packages/traces/src/parse.ts:117` splits lines on the raw buffer rather than handing the stream to
`readline`, and the reason is the byte count: `readline` strips the terminator without saying whether the
final line had one, so a scan racing a live append would count the partial tail as consumed, the watermark
would advance past it, and the completed record would be read next time with its head missing.

Here an unterminated trailing line is neither folded nor counted, so the next tail re-reads it whole. Peak
memory is one chunk plus one line whatever the file's size.

The parse cannot fail: a missing file, a permission rejection, a truncated line, and binary garbage all
degrade to counters (`packages/traces/src/parse.ts:56-67`).

## 4. A type allowlist applied before any field access

`packages/traces/src/extract.ts:11-38`. Seven types are read; six are counted and skipped, and two of
those carry **no envelope and no `sessionId` at all** — so reaching for `record.cwd` on one would be
reading a field that does not exist on a record that is not about a session. A record with no session key
is dropped, not treated as malformed input.

A type in neither list increments `unknownTypeLines`, the counter to watch when a new runtime release
lands. Every line falls into exactly one counter.

Timestamps are canonicalized to ISO-8601 UTC (`packages/traces/src/extract.ts:144-150`) because
`traces.started_at` is `TEXT` under an index, so ordering is lexicographic and an offset timestamp would
sort as later than a `Z` instant hours after it.

## 5. Merging a tail is producer-owned reading semantics

A tail's extract describes the appended slice, not the session, so merging it lives in `@memhtml/traces`
(`packages/traces/src/scan.ts:109-152`): identity fields take the older side, current-state fields the
newer, `startedAt`/`endedAt` are min/max, `turnCount` sums, and `promptCount` is **derived from the merged
set rather than summed**, because a prompt straddling the boundary appears in both extracts.

Tail ordinals are renumbered from the end of the stored list (`packages/traces/src/scan.ts:163`), or every
tail would collide with ordinal 0 and the ordinal would stop being an order. A rescan replaces the row
outright.

`text_head` caps at 200 characters and `first_prompt` at 500
(`packages/traces/src/extract.ts:48-51`): this is an index, not a copy.

## 6. The firewall is a table-name firewall, and its enforcement is a test

Nothing in the retrieval SQL assembler names `traces` or `trace_prompts` — asserted by grepping every
statement the module can assemble, in both the default and the scoped form, because a firewall that holds
for one and leaks for the other is not a firewall
(`packages/index/tests/retrieval-sql.test.ts:204-211`).

## 7. What the plane is for, and who consumes it

The sections above describe how the plane is built. This one says why it exists, because the three tables
divide a question that reads as one.

**`traces` answers "what session was this."** One row per session, keyed on `session_id`
(`packages/index/migrations/0005_traces.sql:8`): the cwd-derived `slug`, `cwd`, `git_branch`, `entrypoint`,
`model`, `version`, `started_at`/`ended_at`, the prompt/turn/agent counts, `first_prompt`, an `ai_title`,
and — the load-bearing three — `file_path`, `file_size`, `file_mtime` pointing at the transcript on disk.
`search_text` is `first_prompt` and `ai_title` newline-joined under an FTS index, single-column for the
same reason `files.fts_text` is.

**`trace_prompts` answers "what was asked, in what order."** One row per distinct prompt with a `text_head`
the extractor caps at 200 characters, and an `ordinal` that is 0-based **within one session** and
comparable only there.

**`memory_session_links` answers "which memory came from which session, and how."** Its `link_kind` is
CHECK-constrained to `wrote`, `read`, `corrected`, `reinforced`. Three properties are deliberate and easy
to misread:

- It is written **at memory-write time by the store's injected recorder**, not by the trace scanner. The
  provenance is recorded by the act that created it.
- The same link is **also file-borne** as `memhtml-session` / `memhtml-prompt` / `memhtml-turn` metas, so
  it survives a rebuild. This table exists to make the link queryable in **both** directions, not to hold
  it.
- There is **no foreign key to `traces`**, on purpose: a memory can be written in a session whose
  transcript has not been scanned yet, and refusing the link would discard provenance the file already
  carries.

### 7.1. Consumers, and the shape of each

`memhtml trace index` (hourly cron) is the producer. `memhtml trace search` and `memhtml trace links` are
the read surfaces, mirrored over MCP as `trace_search` and `trace_links`
(`apps/mcp/src/tools.ts:616,642`).

The firewall means these are a **separate query surface** rather than another retrieval arm — a trace row
is structurally incapable of entering RRF, so "search my memories" and "search my sessions" cannot be
conflated by accident.

## 8. The consumer that motivates the plane

Trace consolidation, phase 12 of [the sleep pipeline](/internals/the-sleep-pipeline/). Anything an agent
learned mid-session and did not explicitly write is otherwise lost: the transcripts hold it, the corpus
does not.

The phase selects sessions carrying no `trace_consolidations` watermark, hands the agent their `file_path`
values, and the agent reads transcripts **at their source** — distilling claims into ordinary memories
through the store, never copying transcript text into the corpus. That is why `traces` stores a pointer
rather than content.

The distillation has to be checkable, so a candidate must cite at least two verbatim evidence quotes
(`apps/consolidator/src/contract.ts:93`, with `MAX_QUOTE_CHARS = 600` so a "quote" cannot smuggle a
transcript). **Those quotes go into the commit message and nowhere else**
(`packages/sleep/src/phases/trace-consolidation.ts:158-165`). The reason is that a commit message is not
part of the corpus: it is not indexed, not chunked, not embedded, and not retrievable. The memory body
carries the claim; the commit carries the receipt a reviewer needs to decide whether the claim earned its
place.

Every cited `sessionId` is checked for membership in the batch actually seeded, and an invented one fails
the turn rather than landing an unfalsifiable citation (`apps/consolidator/src/contract.ts:133`).

Joining `traces` to `memory_session_links` yields the manifest shape that turns the consolidator's first
move from "read everything" into "read the sessions that touch the memories in question" — paths, date
ranges, session ids, tied to the memory files they relate to. [The consolidator](/internals/the-consolidator/)
is the prompt that reads that manifest.

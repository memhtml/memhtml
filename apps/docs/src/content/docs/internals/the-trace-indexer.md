---
title: The trace indexer
description: A read-only index over session transcripts that stores pointers rather than content, with a table-name firewall keeping it out of retrieval.
---

## 1. The store never holds session content

The trace tables are a read-only index over the agent runtime's transcript directory, and nothing under `.memhtml` copies a transcript into the store. The root of that directory is a parameter rather than a constant, so the scan can be driven against a fixture tree in tests (`packages/traces/src/scan.ts:48-57`).

## 2. The watermark is size, mtime, and a byte offset

A watermark records how far the scanner has already read, and here it is three values per file (`packages/traces/src/watermark.ts:66`). The scanner skips a file whose size and mtime both match, without opening it. When the file has grown, it reads the tail from the stored byte offset. A shrink, a backward mtime, or an offset past the current size all rescan from 0, because a rewrite makes the stored offset meaningless.

## 3. Streaming parse

`packages/traces/src/parse.ts:117` splits lines on the raw buffer instead of handing the stream to `readline`, and the byte count is the reason. `readline` strips the line terminator without saying whether the final line had one. A scan racing a live append would then count the partial tail as consumed, the watermark would advance past it, and the completed record would be read next time with its head missing.

Splitting on the buffer means an unterminated trailing line is neither folded into a record nor counted as consumed, so the next tail re-reads it whole. Peak memory is one chunk plus one line, whatever the file's size.

The parse cannot fail. A missing file, a permission rejection, a truncated line, and binary garbage all degrade to counters (`packages/traces/src/parse.ts:56-67`).

## 4. A type allowlist applied before any field access

`packages/traces/src/extract.ts:11-38` names the record types the extractor reads and the ones it skips. Seven types are read. Six are counted and skipped, and two of those six carry no envelope and no `sessionId` at all, so reaching for `record.cwd` on one would read a field that does not exist on a record that is not about a session. A record with no session key is dropped rather than reported as malformed input.

A type in neither list increments `unknownTypeLines`. That is the counter to watch when a new runtime release lands. Every line falls into exactly one counter.

Timestamps are canonicalized to ISO-8601 UTC (`packages/traces/src/extract.ts:144-150`) because `traces.started_at` is a `TEXT` column under an index, so ordering is lexicographic. An offset timestamp would sort as later than a `Z` instant hours after it.

## 5. Merging a tail belongs to the package that produced it

A tail's extract describes the appended slice rather than the session, so the code that merges it into the stored row lives in `@memhtml/traces` (`packages/traces/src/scan.ts:109-152`). Identity fields take the older side, current-state fields take the newer, `startedAt` and `endedAt` take the minimum and maximum, and `turnCount` sums. `promptCount` is derived from the merged set rather than summed, because a prompt straddling the boundary appears in both extracts.

Tail ordinals are renumbered from the end of the stored list (`packages/traces/src/scan.ts:163`). Otherwise every tail would start again at ordinal 0 and the ordinal would stop describing an order. A rescan replaces the row outright.

`text_head` caps at 200 characters and `first_prompt` at 500 (`packages/traces/src/extract.ts:48-51`), because this is an index and not a copy.

## 6. A test greps every assembled statement for the trace table names

Nothing in the retrieval SQL assembler names `traces` or `trace_prompts`. A test asserts that by grepping every statement the module can assemble, in both the default and the scoped form, since a firewall that holds for one form and leaks in the other is no firewall at all (`packages/index/tests/retrieval-sql.test.ts:204-211`).

## 7. What the plane is for, and who consumes it

The three tables answer three questions that sound like one.

`traces` answers what a session was. One row per session, keyed on `session_id` (`packages/index/migrations/0005_traces.sql:8`), carrying the cwd-derived `slug`, `cwd`, `git_branch`, `entrypoint`, `model`, `version`, `started_at` and `ended_at`, the prompt, turn, and agent counts, `first_prompt`, an `ai_title`, and `file_path`, `file_size`, and `file_mtime`, which point at the transcript on disk and let a rescan skip a file that has not changed. `search_text` is `first_prompt` and `ai_title` joined by a newline under a full-text index, single-column for the same reason `files.fts_text` is.

`trace_prompts` answers what was asked, and in what order. One row per distinct prompt with a `text_head` the extractor caps at 200 characters, and an `ordinal` that counts from 0 within one session and is comparable only there.

`memory_session_links` answers which memory came from which session, and how. Its `link_kind` is CHECK-constrained to `wrote`, `read`, `corrected`, or `reinforced`. Three properties of the table are easy to misread:

- The store's injected recorder writes the row at memory-write time, and the trace scanner never writes it. The provenance is recorded by the act that created it.
- The same link is also carried by the file, as `memhtml-session`, `memhtml-prompt`, and `memhtml-turn` metas, so it survives a rebuild. This table exists to make the link queryable in both directions.
- There is no foreign key to `traces`, on purpose. A memory can be written in a session whose transcript has not been scanned yet, and refusing the link would discard provenance the file already carries.

### 7.1. Consumers, and the shape of each

`memhtml trace index`, run hourly by cron, is the producer. `memhtml trace search` and `memhtml trace links` are the read surfaces, mirrored over MCP as `trace_search` and `trace_links` (`apps/mcp/src/tools.ts:616,642`).

Because of the firewall those are a separate query surface rather than a fifth retrieval arm. A trace row cannot enter rank fusion, so searching memories and searching sessions stay two distinct requests.

## 8. The consumer that motivates the plane

A curator distilling sessions into memories is the consumer. Anything an agent learned mid-session and did not explicitly write down is otherwise lost, because the transcripts hold it and the corpus does not. The v1 pipeline ran that distillation as a phase with a sandboxed agent; on this branch it is a curator's job on a `curate/<date>` branch, and the plane below is what it reads.

Joining `traces` to `memory_session_links` produces the manifest. With it a curator's first move is reading the sessions that touch the memories in question, rather than reading everything. The manifest carries paths, date ranges, and session ids, tied to the memory files they relate to.

`@memhtml/traces`: a streaming JSONL parser and trace indexer over agent session transcripts. Read-only, and it stores no session content.

The package turns a directory of session transcripts into rows the index can hold: pointers, counters, and capped text heads, never the transcript itself. `discover` names the layout of that directory (a `projects/` tree of per-cwd slug directories, each session a `<sessionId>.jsonl`, each subagent an `agent-<agentId>.jsonl` sidecar under `subagents/`). `watermark` decides, from a file's size, modification time and a stored byte offset, whether a scan can skip the file, read only its tail, or must rescan it from byte 0. `parse` streams one file line by line, splitting on the raw buffer so an unterminated trailing line is neither folded nor counted as consumed. `extract` folds those lines into a `SessionExtract` without ever throwing, because another process may be appending to the file mid-line. `scan` composes the four into the unit the indexer persists and owns `mergeTailExtract`, the rule for folding a tail's extract into a stored row.

Persistence is not here. `@memhtml/index`'s trace persister owns the `traces` and `trace_watermarks` tables and binds to these shapes structurally; the CLI's trace operations call `scanTraceRoot` and `mergeTailExtract` from this package and hand the results to that persister.

## Modules

The package publishes one import path, `@memhtml/traces`, which re-exports the five modules below, so the reference on this page is the whole exported surface.

| Module         | What it holds                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `discover.ts`  | The transcript-tree layout: `PROJECTS_DIR`, `SUBAGENTS_DIR`, and the walk that yields each session file with its sidecars.           |
| `watermark.ts` | `Watermark`, `WatermarkAction`, `watermarkPlan` and `advanceWatermark`: the pure skip, tail or rescan arithmetic over a file's stat. |
| `parse.ts`     | The streaming reader that splits a transcript into lines and reports what one scan consumed.                                         |
| `extract.ts`   | `READ_RECORD_TYPES`, the per-line fold (`emptyAccumulator`, `foldLine`, `finalizeExtract`) and the `SessionExtract` it produces.     |
| `scan.ts`      | `scanTraceRoot`, `WatermarkReader`, the per-file outcome, and `mergeTailExtract`.                                                    |

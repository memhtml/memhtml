---
title: Rebuild the index
description: When update is enough, when only a full rebuild will do, and how a rebuild with an embedder configured clears a vector-space mismatch.
---

```bash
memhtml index update --embed     # only what moved since the watermark, plus the dirty tree
memhtml index rebuild --embed    # the whole tree at HEAD
memhtml index embed              # fill every chunk that has no vector, without a rebuild
memhtml index status             # watermark, vector space, per-table row counts
```

`--no-embed` on `update` or `rebuild` skips the embedding calls; the parse and the projection still run. Over a store that already carries vectors, `rebuild --no-embed` is refused unless you add `--force`; the section below says why.

The index is a SQLite database built from the HTML files in the git tree, and a rebuild recomputes every memory row from those files. It records the commit it was last built from, and that recorded commit is what the reports below call the watermark. Losing the database costs more than the time to build it: every vector has to be embedded again, the trace tables come back only for transcripts still under `$MEMHTML_TRACE_ROOT`, and the memory-session links that `memhtml trace links` reads do not come back at all.

## update is the daily command

`memhtml index update` reads only the files that moved since the watermark, plus the uncommitted changes `git status` lists, so a tracked file you edited by hand is searchable before you commit it. A new file in a directory git does not track yet is left out until you commit it.

```json
{
  "apiVersion": "1",
  "type": "index.report",
  "data": {
    "mode": "update",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "unchanged": true,
    "added": 0,
    "modified": 0,
    "removed": 0,
    "renamed": 0,
    "dirty": 0,
    "embeddingsWritten": 0,
    "skipped": []
  }
}
```

`unchanged: true` means the watermark and the tree already agreed, so no memory row changed; only the watermark's `updatedAt` moved. `skipped` lists the files git offered that the parser refused, each with a reason. A skipped file is counted and never fatal, because one bad file does not make a bad tree. `memhtml doctor` re-reads only the files the index holds (`apps/cli/src/doctor.ts::collectWarnings`), so its `unparseable` finding names an indexed file that no longer parses, and never a file that was skipped before it was first indexed.

`update --embed` embeds only the chunks its own pass projected, and it looks for missing vectors only among them, so that lookup's cost does not grow with the store. A chunk outside the pass that lacks a vector stays without one, so a store-wide embedding gap stays open. Closing that gap is `memhtml index embed`'s job: its scan covers the whole store, it writes vectors and nothing else, and the index keeps answering on every arm while it runs.

Vectors are keyed on a hash of the article text alone (`packages/html/src/hash.ts::contentHash`). An archive or an eviction moves the file and changes only head metadata, so the next index update keeps every vector and makes no embedding call. A correction embeds only the new memory it writes.

## Reach for rebuild when

- the database file is gone or unopenable;
- a migration adds a column the index has to recompute from the files;
- a committed file `update` skipped now parses without an edit, for example after an upgrade, because `update` reads only what moved since the watermark and what `git status` lists;
- you have changed the embedding model, which the refusal section below covers.

A store-wide embedding gap is not on that list. `memhtml index embed` closes it without emptying anything.

`memhtml index update` with no `index_state` row, which is what a new, empty database has, falls through to a rebuild on its own (`packages/index/src/indexer.ts::makeIndexer::update`). So whatever runs `index update` keeps working after the database is deleted. That first pass reads HEAD only, so an uncommitted edit waits for the next `update`, and with an embedder configured it embeds every chunk again. A row whose `head_sha` is NULL is different. It marks a rebuild that died partway, and `update` refuses it with `ERR_INDEX_STALE` until `memhtml index rebuild` runs.

A rebuild reads the whole tree at HEAD first, then empties every memory table and reprojects what it read (`packages/index/src/indexer.ts::makeIndexer::reproject`, `packages/index/src/indexer.ts::makeIndexer::truncateForRebuild`), so a git failure leaves the old index whole. It keeps the vectors. The `embeddings` rows in the configured vector space are stashed before the delete and put back for every chunk id the reprojection produced again. Chunk ids are content-addressed, so a rebuild over an unchanged tree re-embeds nothing, and the report's `embeddingsPreserved` says how many it kept. What it destroys is bounded. It touches nothing outside `.memhtml/`, and inside `.memhtml/` it leaves the trace tables, the memory-session links, and the attached state plane alone. So a rebuild costs no re-walk of `$MEMHTML_TRACE_ROOT` and loses no access counts.

## Fill missing vectors without a rebuild

```bash
memhtml index embed              # embed every chunk that has no vector in the configured space
memhtml index embed --dry-run    # report the gap and write nothing
```

```json
{
  "apiVersion": "1",
  "type": "index.report",
  "data": {
    "mode": "embed",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "chunks": 9332,
    "embeddings": 9332,
    "embeddingsWritten": 9149,
    "embeddingsRemaining": 0
  }
}
```

`embeddingsRemaining` counts the chunks still without a vector in the configured space after this pass. With `MEMHTML_EMBED=off` the command writes nothing and reports the gap as it found it. When an embedding call fails partway, the vectors written before it are kept, and running the command again picks up the rest. Nothing here empties a table, so search keeps answering on every arm throughout, and the command is safe to run from a script or by hand at any time.

The numbers above are the incident this command exists for. A `rebuild --no-embed` over a live store, followed by ten hours of `update --embed`, left 183 embeddings under 9,332 chunks, because an update embeds only its own batch and nothing revisited the rest.

## rebuild --no-embed is refused over a store that carries vectors

`--no-embed` is the flag test harnesses and credential-free installs use, and it was run against a live store by accident. A store that carries vectors is a store somebody embedded on purpose. So when the `embeddings` table is non-empty and the stored model matches the configured one, `memhtml index rebuild --no-embed` exits 1 with `ERR_REBUILD_NO_EMBED_REFUSED` and writes nothing. It names the count in `error` and in a WARN on stderr. `--force` runs it anyway. The stored vectors survive either way. What `--no-embed` costs on a live store is that every new or changed chunk stays without a vector until `memhtml index embed` runs.

## A mismatched embedding model is refused unless a rebuild migrates it

`memhtml index update`, `memhtml index embed`, and a rebuild that cannot write vectors (`--no-embed`, or `--embed` with `MEMHTML_EMBED=off`) call `guardEmbedModel()` before they write anything (`packages/index/src/indexer.ts::makeIndexer::guardEmbedModel`). Each answers `ERR_EMBED_MODEL_MISMATCH`, naming the vector space the index was built in and the one this process is configured to use. `memhtml index rebuild --embed` with an embedder configured skips the guard and migrates instead: it records the configured model before it writes a vector and carries no vector from the old one across, so an index never mixes two models.

`memhtml index rebuild --embed` with an embedder configured clears the refusal on its own, and it is the command the error suggests. With `MEMHTML_EMBED=off`, `--embed` is refused the same way `--no-embed` is. Deleting the database first, as below, also works, but it drops the trace tables and the memory-session links too. `memhtml trace index` brings back trace rows only for the transcripts still under `$MEMHTML_TRACE_ROOT`, and nothing brings back the links:

```bash
memhtml status                                     # read embedModel and embedderUp
rm -f "$MEMHTML_ROOT"/.memhtml/index.db "$MEMHTML_ROOT"/.memhtml/index.db-wal "$MEMHTML_ROOT"/.memhtml/index.db-shm
memhtml index rebuild --embed
```

The `-wal` and `-shm` names take the write-ahead log and shared-memory files with it, and `-f` keeps the line working when they are absent, as they are once no process has the database open. Nothing in the tree is at risk, and `state.db` is a separate file this command leaves untouched.

A half-migrated index, holding some vectors from one model and some from another, would return similarity scores computed against two different geometries and would never say so, which is the failure the guard prevents.

## Reading index status

```bash
memhtml index status
```

```json
{
  "apiVersion": "1",
  "type": "index.report",
  "data": {
    "mode": "status",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "embedModel": "cohere.embed-v4:0@1024",
    "embedDim": 1024,
    "embedModelMatches": true,
    "configuredEmbedModel": "cohere.embed-v4:0@1024",
    "rebuiltAt": "2026-08-12T19:21:52.282Z",
    "updatedAt": "2026-08-12T19:21:52.282Z",
    "files": 1,
    "activeFiles": 1,
    "chunks": 1,
    "embeddings": 0,
    "edges": 0,
    "derivedEdges": 0,
    "tags": 1,
    "entities": 0,
    "traces": 0,
    "hasState": true
  }
}
```

- `embedModel` is the model the stored vectors came from, and `configuredEmbedModel` is the model this process would write with. `embedModelMatches` compares the two, and both values are reported so you can see which side to change.
- `embeddings` below `chunks` is an embedding gap: run `memhtml index embed`.
- `derivedEdges` counts the `edges` rows marked `derived = 1`, which live only in the index. The sleep pipeline mined them until 0.16 removed it, nothing writes one now, and a rebuild drops them.
- `hasState` reports whether a state plane is attached. The CLI always attaches `state.db` and creates an empty one when it is missing, so it reads `true` on every CLI connection. Retrieval ranks with four arms: full-text search, vector similarity, recency, and salience, which favors memories you have opened before. With no access rows, the salience arm still runs and ranks memories by `updated_at`, newest first, and it never ranks a task or a file under `resources/people/` (`packages/index/src/retrieval-sql.ts::salienceArm`).
- `headSha` is the watermark. Compare it against `git rev-parse HEAD`, or let `memhtml status` do that for you and report `indexFresh`.

[The index](/internals/the-index/) covers how the index is built and what the watermark records.

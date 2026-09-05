---
title: Rebuild the index
description: When update is enough, when only a full rebuild will do, and how to clear a vector-space mismatch that a rebuild alone cannot.
---

```bash
memhtml index update --embed     # only what moved since the watermark, plus the dirty tree
memhtml index rebuild --embed    # the whole tree at HEAD
memhtml index embed              # fill every chunk that has no vector, without a rebuild
memhtml index status             # watermark, vector space, per-table row counts
```

`--no-embed` turns embedding off on either command and makes the pass finish instantly. Over a store that already carries vectors, `rebuild --no-embed` is refused unless you add `--force`; the section below says why.

The index is a SQLite database built from the HTML files in the git tree, so losing it costs only the time to build it again. It records the commit it was last built from, and that recorded commit is what the reports below call the watermark.

## update is the daily command

`memhtml index update` reads only the files that moved since the watermark, and it reads the working tree as well, so a file you edited by hand is searchable before you commit it.

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

`unchanged: true` means the watermark and the tree already agreed, so nothing was written. `skipped` lists the files git offered that the parser refused, each with a reason. A skipped file is counted and never fatal, because one bad file does not make a bad tree, and a non-empty `skipped` is what `memhtml doctor` reports as its `unparseable` finding.

`update --embed` embeds the chunks in its own batch and looks for missing vectors only inside that batch, which keeps its cost independent of how large the store is. It therefore leaves a store-wide embedding gap in place, and it never revisits a chunk that lost its vector. Closing that gap is `memhtml index embed`'s job: its scan covers the whole store, it writes vectors and nothing else, and the index keeps answering on every arm while it runs.

Vectors are keyed on content hash, so a `git mv`, which is what every archive and every eviction is, issues zero Bedrock calls.

## Reach for rebuild when

- the database file is gone or unopenable;
- a migration adds a column the index has to recompute from the files;
- you have just fixed files that `memhtml doctor` reported as `unparseable`;
- you have changed the embedding model, which the refusal section below covers.

A store-wide embedding gap is not on that list. `memhtml index embed` closes it without emptying anything.

`memhtml index update` with no recorded watermark falls through to a rebuild on its own (`update` in `packages/index/src/indexer.ts`). A deleted database therefore mostly heals itself: the cron line keeps working and the next pass takes longer than usual.

A rebuild deletes every memory table, reads the tree again, and reprojects it (`truncateForRebuild` in `packages/index/src/indexer.ts`). It keeps the vectors: the `embeddings` rows in the configured vector space are stashed before the delete and put back for every chunk id the reprojection produced again, and chunk ids are content-addressed, so a rebuild over an unchanged tree re-embeds nothing. The report's `embeddingsPreserved` says how many it kept. What it destroys is bounded. It touches nothing outside `.memhtml/`, and inside `.memhtml/` it leaves the trace tables and the attached state plane alone. So a rebuild costs no re-walk of `$MEMHTML_TRACE_ROOT` and loses no access counts.

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

`embeddingsRemaining` is the honest half of the report: the chunks still without a vector after this pass. It is non-zero when `MEMHTML_EMBED=off`, in which case the command writes nothing and reports the gap it could not close, and after an embedding call failed partway, in which case every slice that landed is kept and running the command again finishes the rest. Nothing here empties a table, so search keeps answering on every arm throughout, and the command is safe to run from cron or by hand at any time.

The numbers above are the incident this command exists for. A `rebuild --no-embed` over a live store, followed by ten hours of `update --embed`, left 183 embeddings under 9,332 chunks, because an update embeds only its own batch and nothing revisited the rest.

## rebuild --no-embed is refused over a store that carries vectors

`--no-embed` is the flag test harnesses and credential-free installs use, and it was run against a live store by accident. A store that carries vectors is a store somebody embedded on purpose, so when the `embeddings` table is non-empty and the stored model matches the configured one, `memhtml index rebuild --no-embed` exits 1 with `ERR_REBUILD_NO_EMBED_REFUSED`, names the count in `error` and in a WARN on stderr, and writes nothing. `--force` runs it anyway. The stored vectors survive either way; what `--no-embed` costs on a live store is that every new or changed chunk stays without a vector until `memhtml index embed` runs.

## A mismatched embedding model is a hard refusal

Both `rebuild` and `update` call `guardEmbedModel()` before they write anything (`guardEmbedModel` in `packages/index/src/indexer.ts`). An index built under one embedding model can therefore never accumulate rows under another. You get `ERR_EMBED_MODEL_MISMATCH`, naming the model the stored vectors came from and the model this process is configured to use.

A rebuild alone leaves the refusal in place, because the guard fires before the rebuild writes. Delete the database and rebuild into the configured space:

```bash
memhtml status                                     # read embedModel and embedderUp
rm "$MEMHTML_ROOT"/.memhtml/index.db "$MEMHTML_ROOT"/.memhtml/index.db-*
memhtml index rebuild --embed
```

The `index.db-*` glob takes the write-ahead log and shared-memory files with it. Nothing in the tree is at risk, and `state.db` is a separate file this command leaves untouched.

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
- `derivedEdges` counts the links the sleep cycle's relationship-mining phase inferred and wrote into the index rather than into files. The system can derive them again, which is why they live only here.
- `hasState: false` means no state plane is attached, so the salience arm cannot fire. Retrieval ranks with four arms: full-text search, vector similarity, recency, and salience, which favors memories you have opened before. The first three keep working with no state plane; salience drops out.
- `headSha` is the watermark. Compare it against `git rev-parse HEAD`, or let `memhtml status` do that for you and report `indexFresh`.

[The index](/internals/the-index/) covers how the index is built and what the watermark records.

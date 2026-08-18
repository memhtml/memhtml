---
title: Rebuild the index
description: When update is enough, when only a full rebuild will do, and how to clear a vector-space mismatch that a rebuild alone cannot.
---

```bash
memhtml index update --embed     # only what moved since the watermark, plus the dirty tree
memhtml index rebuild --embed    # the whole tree at HEAD
memhtml index status             # watermark, vector space, per-table row counts
```

`--no-embed` turns embedding off on either command and makes the pass finish instantly.

The index is a SQLite database built from the HTML files in the git tree, so losing it costs only the
time to build it again. It records the commit it was last built from, and that recorded commit is
what the reports below call the watermark.

## update is the daily command

`memhtml index update` reads only the files that moved since the watermark, and it reads the working
tree as well, so a file you edited by hand is searchable before you commit it.

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

`unchanged: true` means the watermark and the tree already agreed, so nothing was written. `skipped`
lists the files git offered that the parser refused, each with a reason. A skipped file is counted and
never fatal, because one bad file does not make a bad tree, and a non-empty `skipped` is what
`memhtml doctor` reports as its `unparseable` finding.

`update --embed` embeds the chunks in its own batch and looks for missing vectors only inside that
batch, which keeps its cost independent of how large the store is. It therefore leaves a store-wide
embedding gap in place. Closing that gap is `rebuild --embed`'s job, and its scan covers the whole
store because changing embedding models is a whole-store question.

Vectors are keyed on content hash, so a `git mv`, which is what every archive and every eviction is,
issues zero Bedrock calls.

## Reach for rebuild when

- the database file is gone or unopenable;
- a migration adds a column the index has to recompute from the files;
- you have just fixed files that `memhtml doctor` reported as `unparseable`;
- you need to close a store-wide embedding gap.

`memhtml index update` with no recorded watermark falls through to a rebuild on its own
(`packages/index/src/indexer.ts:565`). A deleted database therefore mostly heals itself: the cron line
keeps working and the next pass takes longer than usual.

A rebuild drops the full-text search index, deletes every memory table, reads the tree again, and
recreates the search index (`packages/index/src/indexer.ts:389`). What it destroys is bounded. It
touches nothing outside `.memhtml/`, and inside `.memhtml/` it leaves the trace tables and the
attached state plane alone. So a rebuild costs no re-walk of `$MEMHTML_TRACE_ROOT` and loses no
access counts.

## A mismatched embedding model is a hard refusal

Both `rebuild` and `update` call `guardEmbedModel()` before they write anything
(`packages/index/src/indexer.ts:241`). An index built under one embedding model can therefore never
accumulate rows under another. You get `ERR_EMBED_MODEL_MISMATCH`, naming the model the stored
vectors came from and the model this process is configured to use.

A rebuild alone leaves the refusal in place, because the guard fires before the rebuild writes.
Delete the database and rebuild into the configured space:

```bash
memhtml status                                     # read embedModel and embedderUp
rm "$MEMHTML_ROOT"/.memhtml/index.db "$MEMHTML_ROOT"/.memhtml/index.db-*
memhtml index rebuild --embed
```

The `index.db-*` glob takes the write-ahead log and shared-memory files with it. Nothing
in the tree is at risk, and `state.db` is a separate file this command leaves untouched.

A half-migrated index, holding some vectors from one model and some from another, would return
similarity scores computed against two different geometries and would never say so, which is the
failure the guard prevents.

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

- `embedModel` is the model the stored vectors came from, and `configuredEmbedModel` is the model
  this process would write with. `embedModelMatches` compares the two, and both values are reported
  so you can see which side to change.
- `embeddings: 0` with `chunks` above zero is an embedding gap: run `memhtml index rebuild --embed`.
- `derivedEdges` counts the links the nightly sleep cycle's relationship-mining phase inferred and
  wrote into the index rather than into files. The system can derive them again, which is why they
  live only here.
- `hasState: false` means no state plane is attached, so the salience arm cannot fire. Retrieval
  ranks with four arms: full-text search, vector similarity, recency, and salience, which favors
  memories you have opened before. The first three keep working with no state plane; salience drops
  out.
- `headSha` is the watermark. Compare it against `git rev-parse HEAD`, or let `memhtml status` do
  that for you and report `indexFresh`.

[The index](/internals/the-index/) covers how the index is built and what the watermark records.

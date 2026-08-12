---
title: Rebuild the index
description: When update is enough, when only a full rebuild will do, and how to clear a vector-space mismatch that a rebuild alone cannot.
---

```bash
memhtml index update --embed     # only what moved since the watermark, plus the dirty tree
memhtml index rebuild --embed    # the whole tree at HEAD
memhtml index status             # watermark, vector space, per-table row counts
```

`--no-embed` turns embedding off on either and makes the pass instant.

## update is the daily verb

`update` reads only what moved since the recorded watermark, and it also projects the **dirty working
tree** — so a hand-edited file is searchable before you commit it.

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

`unchanged: true` means the watermark and the tree already agreed and nothing was written. `skipped` lists
files git offered that failed to parse, each with a reason — counted, never fatal, because one bad file is
not a bad tree. A non-empty `skipped` is the input to `memhtml doctor`'s `unparseable` finding.

`update --embed` embeds only its own batch's chunks: the pending scan is scoped to them, which is what
keeps its cost independent of store size. So it will **not** close a store-wide embedding gap. That is
`rebuild --embed`'s job, whose scan is unscoped precisely because a model migration is a whole-store
question.

Vectors key on content hash either way, so a `git mv` — which is every archive and every eviction —
issues zero Bedrock calls.

## Reach for rebuild when

- the database file is gone or unopenable;
- a migration adds a column the projection must recompute;
- you have just fixed files that `memhtml doctor` reported as `unparseable`;
- you need to close a store-wide embedding gap.

`update` with no recorded watermark falls through to a rebuild on its own
(`packages/index/src/indexer.ts:565`), so a deleted database mostly handles itself — the cron line keeps
working and the next pass is simply slower.

A rebuild drops the FTS index, deletes every memory table, reprojects, and recreates the index
(`packages/index/src/indexer.ts:389`). What it destroys is bounded: nothing outside `.memhtml/`, and
within it neither the trace tables nor the attached state plane. So a rebuild costs no re-walk of
`$MEMHTML_TRACE_ROOT` and loses no access counts.

## A vector-space mismatch is a hard refusal

Both `rebuild` and `update` call `guardEmbedModel()` before any write
(`packages/index/src/indexer.ts:241`). An index built under one embedding model can therefore never
accumulate rows under another: you get `ERR_EMBED_MODEL_MISMATCH` naming the stored space and the
configured one.

**A rebuild alone does not clear it** — the guard fires before the rebuild writes. Delete the database and
rebuild into the configured space:

```bash
memhtml status                                     # read embedModel and embedderUp
rm "$MEMHTML_ROOT"/.memhtml/index.db "$MEMHTML_ROOT"/.memhtml/index.db-*
memhtml index rebuild --embed
```

The `index.db-*` glob matters: it takes the WAL and shared-memory files with it. Nothing in the tree is at
risk, and `state.db` is a separate file this does not touch.

The refusal is the design working. A half-migrated index — some vectors in one space, some in another —
would return cosines computed against two different geometries and never announce it.

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

- `embedModel` is the space the **stored** vectors are in; `configuredEmbedModel` is the space this
  process would write. `embedModelMatches` compares them, and the two values are reported separately so
  you can see which side to change.
- `embeddings: 0` with `chunks` non-zero is an embedding gap: run `memhtml index rebuild --embed`.
- `derivedEdges` counts edges that sleep's relationship-mining phase mined into the index rather than into
  files. They are re-derivable, which is why they live only here.
- `hasState: false` means no state plane is attached, so the salience arm cannot fire.
- `headSha` is the watermark. Compare it to `git rev-parse HEAD`; `memhtml status` does that for you and
  reports `indexFresh`.

[The index](/internals/the-index/) develops the projection and the watermark.

# Quadratic write cost: per-OP store-scaled term, batching cannot save you

**Category**: performance | **Session**: session-93362b (2026-08-05) | **Status**: RESOLVED (session-1d3736, memhtml f95b018)

## Resolution (2026-08-05, session-1d3736)

The dominant term was NONE of the three suspects below. It was `indexer.update()`'s
committed-diffs loop calling `projectFromTree(path, ref, false)` per changed file —
`lsTreeR(ref, [path])` walks the WHOLE tree to answer one path, and `catFileBatch([sha])`
spawns a process for one blob: 2N subprocesses per batch, ~49 ms/walk at 10k files.
Fix: one `lsTreeR(headSha, TREE_PREFIXES)` + one `catFileBatch(allShas)` per batch
(indexer.ts, update()). Probe: 256-op update at 10k files 48.5s → 5.1s, flat in n.
freePathFor measured second-order (0.7→11.5 ms/op with n); git add/commit flat.
RESIDUAL (open): with embeddings on, per-batch still grows linearly — prime suspect is
embedMissing's full `chunks LEFT JOIN embeddings` pending scan per batch, whose
`e.model <> ?` disjunct defeats the embeddings_model index. Scope it to the batch's
own chunk ids. Probe scripts: tests-integration/probe-{write-cost,fts-cost,db-decompose}.mjs.

## Symptom
Bulk ingestion (~19k memories) projected 4.5h. Batch-commit gaps in the store's own
git log grow linearly with store size: 2/18/56/108/175/221s for six 1024-op
`memhtml apply` rounds at 0/1k/2k/3k/4k/5k pre-existing files.

## Mechanism (measured to the boundary, unprofiled past it)
Per-call wall ≈ 40–60 µs × OPS × FILES-ALREADY-IN-STORE. The store-scaled term
multiplies each op, so total ingest is k·n²/2 in fact count and BATCH SIZE IS
IRRELEVANT to the total — it only sets per-call timeout exposure. A "fewer batches
= less scanning" fix is wrong twice: we shipped it (MAX_BATCH_OPS 128→1024) and the
FIRST call blew a 600s timeout at an empty→5k store.

## Suspects (Plan B profiles these three, in memhtml)
1. freePathFor: per-op disk existence probes against one inbox dir holding ALL
   files (packages/store/src/store.ts:352-374); doctor flags inboxCrowded at 6k.
2. git staging/commit tree walks per batch.
3. indexer update() diff per batch.

## How to apply
- Timing a store op? The store IS a git repo: `git log --format='%ct'` is a free
  per-batch timing log, even for killed runs.
- Sizing a constant against a cost model? Probe the model's SHAPE first (is the
  scaled term per-op or per-batch?) — one 30-min probe beats two dead 3h runs.

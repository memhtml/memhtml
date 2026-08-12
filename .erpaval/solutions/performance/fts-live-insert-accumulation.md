# Live-index insert cost can accumulate between rebuilds — a fresh-index probe cannot see it

**Category**: performance | **Session**: 2026-08-06 | **Status**: RESOLVED (memhtml a426ac0, merged fb55904)

## What happened

The 2026-08-05 eval ingest (embeddings on) grew 45s → ~5.5min per 256-op batch
over 72 batches. The handoff's prime suspect was embedMissing's pending scan
(`chunks LEFT JOIN embeddings WHERE … OR e.model <> ?`), with "FTS live-insert
measured ~8-12 ms/row FLAT" cited as reason to look elsewhere.

Both callouts were wrong, in instructive ways:

- The pending scan IS linear in store size (11ms @ 1k chunks → 60ms @ 10k) but
  is two orders of magnitude below the wall. Linear-and-real is not the same as
  dominant.
- The "flat" FTS measurement probed ONE batch against a FRESHLY CREATED index.
  On the driver of the day the cost accumulated with rows inserted since the
  last CREATE INDEX: four consecutive 256-op updates at CONSTANT store size
  cost 2.4s → 5.1s → 7.9s → 10.7s in db.writeAll, and bracketing each update
  in DROP/CREATE flattened the same rounds to ~0.6s. The growth the live run
  saw over 72 batches was this accumulation, not anything scanning the store.

## How to apply

- When a probe reports a per-row cost as "flat", ask flat OVER WHAT: one batch
  on a fresh structure says nothing about the Nth batch on an aging one. Probe
  MULTIPLE consecutive rounds at constant size before ruling a term out — the
  round-over-round trend at fixed n is the accumulation detector.
- Split db.writeAll timing BY LANE (match on the SQL) before attributing it:
  the embeddings upsert lane was flat ~0.15s while the projection lane carried
  all growth. One aggregate writeAll number pointed at the wrong table.
- The accumulation is a property of one lexical-index implementation and not
  of lexical indexing: an external-content FTS5 table takes 6/5/6/5/5/5 ms over
  six consecutive 256-op batches at a constant 10k-file store (probed 2026-08-12
  on node 24.19.0), so the bracket that one driver needs is dead weight — and a
  crash window — on another. Measure the round-over-round trend against the
  driver in hand before importing either conclusion.
- Probe rig: tests-integration/probe-embed-cost.mjs (deterministic embedder,
  lane-split writeAll). It measures the pending-scan term; the lexical index is
  not a variable in it, since FTS5's insert cost is linear in the batch rather
  than in the store, so there is nothing to A/B a bracket against.

# Live-FTS insert cost accumulates between index rebuilds — a fresh-index probe cannot see it

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
  The real cost accumulates with rows inserted since the last CREATE INDEX:
  four consecutive 256-op updates at CONSTANT store size cost 2.4s → 5.1s →
  7.9s → 10.7s in db.writeAll. Bracketing each update in DROP/CREATE flattened
  the same rounds to ~0.6s. The growth the live run saw over 72 batches was
  this accumulation, not anything scanning the store.

## How to apply

- When a probe reports a per-row cost as "flat", ask flat OVER WHAT: one batch
  on a fresh structure says nothing about the Nth batch on an aging one. Probe
  MULTIPLE consecutive rounds at constant size before ruling a term out — the
  round-over-round trend at fixed n is the accumulation detector.
- Split db.writeAll timing BY LANE (match on the SQL) before attributing it:
  the embeddings upsert lane was flat ~0.15s while the projection lane carried
  all growth. One aggregate writeAll number pointed at the wrong table.
- Fix shape for Turso FTS bulk writes: rebuild the index around the batch
  (rebuild ~6.6µs/table-row vs live insert ~8ms/row + accumulation). Constants
  FTS_REBUILD_{MIN_FILES,ROWS_PER_WRITE} in schema-const.ts state the measured
  break-even; interactive single-file writes stay on the live path.
- Probe rig: tests-integration/probe-embed-cost.mjs (deterministic embedder,
  lane-split writeAll, --fts-bracket flag to A/B the hypothesis in place).

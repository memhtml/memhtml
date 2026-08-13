-- The trace-consolidation watermark: which sessions the sleep cycle has already distilled.
--
-- ── Run state, not an index projection ───────────────────────────────────────────────────────────
--
-- The same category as `sleep_runs`/`sleep_phases` (0006), and NOT the category of `files` or
-- `chunks`. A projection row is a pure function of the git tree and is deleted and recomputed by
-- every `memhtml index rebuild`; this row records that a MODEL CALL happened, which no tree can restate.
--
-- It therefore survives a rebuild, and by construction rather than by exemption: `rebuild` empties
-- exactly `MEMORY_TABLES` (`packages/index/src/schema-const.ts:48-57`, applied at
-- `packages/index/src/indexer.ts:408`) and never drops or recreates the database file, so a table
-- absent from that list is untouched. Verified the same way `sleep_runs` is.
--
-- If the file itself is ever deleted, every watermark goes with it and the next cycle reconsolidates
-- the sessions it can still see. That is wasteful (it re-pays Opus for transcripts already read)
-- and it is SAFE, which is the ordering that matters: the phase writes memories through the same
-- reviewable-commit discipline as every other sleep mutation, so a duplicate candidate is a commit a
-- reviewer declines, never a corruption. Nothing here is load-bearing for correctness.
--
-- ── One row per session, and no foreign key ──────────────────────────────────────────────────────
--
-- `session_id` is the primary key because "has this session been consolidated" is a per-session
-- question with one answer; a second consolidation of one session overwrites its row and moves
-- `run_id`, which is what makes a reconsolidation after a lost database file idempotent in shape.
--
-- No `REFERENCES traces (session_id)`, for the reason `memory_session_links` states in 0005: the
-- trace plane is a rebuildable index over `~/.claude/projects`, so a session's `traces` row can be
-- rebuilt away (its transcript rotated, its directory pruned) while the fact that the cycle already
-- read it stays true. A foreign key would delete the watermark and invite a re-read of a file that
-- may no longer exist.

CREATE TABLE trace_consolidations (
  session_id      TEXT PRIMARY KEY,
  -- The sleep run that distilled it, e.g. `sleep/2026-08-08`. Reporting and provenance only:
  -- nothing reads this to decide anything, the same posture 0006's tables carry.
  run_id          TEXT NOT NULL,
  -- The run's own instant, not a clock read at insert time: a phase derives every stamp from the
  -- injected run date (`packages/sleep/src/env.ts:60-67`), so two runs of one date agree here.
  consolidated_at TEXT NOT NULL
);

-- The unconsolidated-session query is an anti-join FROM `traces`, so it seeks this table by its
-- primary key and needs no second index. `consolidated_at` is ordered only in a report, over a table
-- whose row count is bounded by the number of sessions ever consolidated.
CREATE INDEX trace_consolidations_run ON trace_consolidations (run_id);

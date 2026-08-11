-- The state plane, applied to the ATTACHed `state` database.
--
-- These are the only facts git cannot reproduce, and they are high-churn: bumping an access count
-- on every retrieval would produce a commit per query. So `state.db` is gitignored and its
-- durability story is the committed append-only sidecar `.memhtml/state/access.jsonl`, refreshed once
-- per night by the sleep cycle's state-export phase. A fresh clone plus `memhtml state import` plus
-- `memhtml index rebuild` therefore reproduces the whole system, access history included.
--
-- Rejected alternative: keeping these counters in the memory HTML files. It makes every retrieval a
-- git write, makes retrieval order a source of merge conflicts, and breaks the content-hash
-- invariance that lets a correction land on one entry alone.

CREATE TABLE state.access (
  -- No FK to main.files: cross-database foreign keys do not exist. The store's move() issues the
  -- matching `UPDATE state.access SET path = ?` in the same batch as an archive, and `memhtml doctor`
  -- reports orphaned rows.
  path                TEXT PRIMARY KEY,
  -- Times this memory was retrieved, gated by the 900-second cooldown. A count, monotonically
  -- non-decreasing. The cooldown exists because this feeds the salience RRF arm: without it,
  -- replaying one query ten times would inflate that memory's salience tenfold.
  access_count        INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  reinforcement_count INTEGER NOT NULL DEFAULT 0 CHECK (reinforcement_count >= 0),
  -- An EWMA over reinforcement signals, unitless in [-1, 1]. The salience arm clamps the negative
  -- half to 0 — a memory that led somewhere bad is not boosted, and it is not buried either.
  outcome_score       REAL    NOT NULL DEFAULT 0.0 CHECK (outcome_score BETWEEN -1 AND 1),
  last_accessed_at    TEXT,
  last_reinforced_at  TEXT,
  updated_at          TEXT NOT NULL
);
-- The schema name goes on the INDEX, not on the table: `CREATE INDEX x ON state.access (...)` is a
-- syntax error on this driver (probed 2026-08-02), while `CREATE INDEX state.x ON access (...)` is
-- accepted and lands the index in the attached schema. Unqualified `access` resolves within it.
CREATE INDEX state.access_last ON access (last_accessed_at);

-- The corroboration counter on a machine-detected `contradicts`. The one derived fact that gates a
-- retention penalty, so it lives in the durable plane; once `detections >= 2` the sleep conflict
-- phase promotes the edge into both files as <link rel="memhtml-contradicts"> and commits it, after
-- which this row is decoration and the fact is file-borne.
CREATE TABLE state.edge_corroboration (
  src_path   TEXT NOT NULL,
  rel        TEXT NOT NULL,
  dst_path   TEXT NOT NULL,
  detections INTEGER NOT NULL DEFAULT 1 CHECK (detections >= 1),
  confirmed  INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  promoted   INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (src_path, rel, dst_path)
);

-- Sleep-run reporting. Not load-bearing: the commit trailers on the sleep branch are what
-- `memhtml sleep resume` reads (`git log --format=%B base..HEAD | grep '^Memhtml-Phase:'`), so this pair of
-- tables is a reporting convenience the git history can regenerate. That is deliberate. A journal
-- table that a resume depended on would be a second source of truth for what already happened.

CREATE TABLE sleep_runs (
  -- `sleep/<YYYY-MM-DD>`, suffixed `-2` on a same-day rerun. Also the branch name.
  run_id     TEXT PRIMARY KEY,
  branch     TEXT NOT NULL,
  base_sha   TEXT NOT NULL,
  head_sha   TEXT,
  status     TEXT NOT NULL CHECK (status IN ('running','review','merged','abandoned','failed')),
  started_at TEXT NOT NULL,
  ended_at   TEXT
);
CREATE INDEX sleep_runs_started ON sleep_runs (started_at);

CREATE TABLE sleep_phases (
  run_id     TEXT NOT NULL REFERENCES sleep_runs (run_id) ON DELETE CASCADE,
  phase      TEXT NOT NULL,
  -- 1-based ordinal of the phase within the 15-phase sequence. A display label, never arithmetic.
  ordinal    INTEGER NOT NULL,
  -- Per-phase isolation is the design driver: a failed phase keeps every prior phase's commits and
  -- later phases still run, so `failed` here is a normal terminal state, not an aborted run.
  status     TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  commit_sha TEXT,
  counts     TEXT NOT NULL DEFAULT '{}',
  error      TEXT,
  llm_calls  INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  PRIMARY KEY (run_id, phase)
);

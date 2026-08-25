-- The two watermarks. Each answers "what did the last run already consume", and each is what makes
-- the corresponding incremental path cheap enough to run on a cron.

-- Exactly one row, by CHECK. The incremental indexer's watermark.
CREATE TABLE index_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  -- The commit the index describes. NULL before the first rebuild. `git diff <head_sha> HEAD`
  -- is the whole change set the next update has to apply.
  head_sha      TEXT,
  -- The vector space, as `<model-id>@<dim>` (@memhtml/llm's EMBED_WATERMARK). A mismatch against
  -- configuration is a hard refusal, never a silent reindex: a half-migrated vector space degrades
  -- every cosine and is invisible in tests. `rebuild --embed` is the one path past that refusal: it
  -- truncates `embeddings` with the other memory tables and records the configured space before any
  -- vector is written, so it migrates the whole space rather than mixing two. `--no-embed` refuses
  -- before the truncate, so a store that refuses keeps the vectors it has.
  embed_model   TEXT NOT NULL,
  embed_dim     INTEGER NOT NULL CHECK (embed_dim > 0),
  rebuilt_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One row per transcript file. Size AND mtime must both match to skip: size alone misses an
-- in-place rewrite that preserves the length, mtime alone misses a write inside the same clock tick.
CREATE TABLE trace_watermarks (
  file_path  TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  -- ISO-8601 UTC. @memhtml/traces reports mtime in epoch MILLISECONDS, so the adapter converts at this
  -- boundary and the column carries exactly one unit.
  mtime      TEXT NOT NULL,
  -- 0-based byte offset: one past the last byte consumed, and therefore the `start` of the next
  -- read. Equal to `size` after a complete scan.
  byte_off   INTEGER NOT NULL DEFAULT 0 CHECK (byte_off >= 0),
  scanned_at TEXT NOT NULL
);

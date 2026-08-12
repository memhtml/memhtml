-- The trace plane: a read-only index over ~/.claude/projects. `.memhtml` never holds session content,
-- so every column here is a pointer or a capped head, never a copy.
--
-- Firewalled from retrieval. Nothing in the retrieval SQL assembler names `traces` or
-- `trace_prompts`, and a test greps every assembled statement to prove it — the schema separation
-- the predecessor memory system got from a second Postgres schema is a table-name firewall here.

CREATE TABLE traces (
  session_id   TEXT PRIMARY KEY,
  -- The ~/.claude/projects/<slug> directory name: a PATH slug, derived from the cwd. Not the
  -- `slug` field on a subagent record, which is a title slug for the agent's task.
  slug         TEXT NOT NULL,
  cwd          TEXT,
  git_branch   TEXT,
  entrypoint   TEXT,
  model        TEXT,
  version      TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  turn_count   INTEGER NOT NULL DEFAULT 0,
  agent_count  INTEGER NOT NULL DEFAULT 0,
  first_prompt TEXT NOT NULL DEFAULT '',
  ai_title     TEXT,
  -- The main transcript's path. A session's subagent sidecars are separate files upserting into
  -- this one row, so this is always the `kind: "session"` file.
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  file_mtime   TEXT NOT NULL,
  -- first_prompt + ai_title joined by a newline, for the same single-column reason as files.fts_text.
  search_text  TEXT NOT NULL DEFAULT '',
  indexed_at   TEXT NOT NULL
);
CREATE INDEX traces_slug    ON traces (slug);
CREATE INDEX traces_cwd     ON traces (cwd);
CREATE INDEX traces_started ON traces (started_at);
CREATE INDEX traces_mtime   ON traces (file_mtime);

-- Trace search, on the same external-content pattern as `files_fts` (see 0003_fts.sql for why).
CREATE VIRTUAL TABLE traces_fts USING fts5(
  search_text,
  content='traces',
  content_rowid='rowid'
);

CREATE TRIGGER traces_fts_insert AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER traces_fts_delete AFTER DELETE ON traces BEGIN
  INSERT INTO traces_fts(traces_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER traces_fts_update AFTER UPDATE OF search_text ON traces BEGIN
  INSERT INTO traces_fts(traces_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO traces_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TABLE trace_prompts (
  session_id TEXT NOT NULL REFERENCES traces (session_id) ON DELETE CASCADE,
  prompt_id  TEXT NOT NULL,
  turn_uuid  TEXT NOT NULL,
  -- 0-based position among the distinct prompts of THIS session, in first-appearance order.
  -- Per-session scope: comparable only within one session_id.
  ordinal    INTEGER NOT NULL,
  at         TEXT NOT NULL,
  agent_id   TEXT,
  -- Capped at 200 characters by the extractor. This is an index, not a copy.
  text_head  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, prompt_id)
);
CREATE INDEX trace_prompts_uuid ON trace_prompts (session_id, turn_uuid);

-- Written at memory-write time by the store's injected recorder, not by the trace scanner. The
-- same link is also file-borne as memhtml-session/memhtml-prompt/memhtml-turn, so it survives a rebuild;
-- this table is what makes it queryable in both directions.
--
-- No FK to `traces`: a memory can be written in a session whose transcript has not been scanned
-- yet, and refusing the link would lose the provenance the file already carries.
CREATE TABLE memory_session_links (
  path       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id  TEXT,
  turn_uuid  TEXT,
  link_kind  TEXT NOT NULL CHECK (link_kind IN ('wrote','read','corrected','reinforced')),
  at         TEXT NOT NULL,
  PRIMARY KEY (path, session_id, link_kind, at)
);
CREATE INDEX msl_session ON memory_session_links (session_id);
CREATE INDEX msl_path    ON memory_session_links (path);

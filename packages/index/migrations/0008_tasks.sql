-- `task` becomes the tenth `memory_type`, `task` the fourth `edge_class`, and `files` gains the two
-- columns a task carries. Recreate-and-copy, because SQLite cannot ALTER a CHECK constraint and both
-- tables carry one. Every existing row passes the WIDENED CHECKs, so the copies are lossless.
--
-- ── The children are snapshotted, and that is the load-bearing part of this file ──────────────────
--
-- Probed 2026-08-12 on node 24.19.0: `DROP TABLE files` DELETES every row of every child table
-- (`file_tags`, `file_entities`, `file_facets`, `file_citations`, `chunks`, and `embeddings` behind
-- `chunks`) via `ON DELETE CASCADE` — including inside the one `immediate` transaction the migration
-- runner wraps this file in, which does NOT protect them. A migration that merely copied `files` would
-- therefore report success and silently destroy every embedding in the database: thousands of Bedrock
-- calls for text that never changed, plus the whole edge set.
--
-- `PRAGMA foreign_keys = OFF` around the drop is no escape, and the probe above measured that too: the
-- pragma is a NO-OP inside a transaction, exactly as SQLite documents it, so the cascade fires anyway
-- and a file that relied on the pragma would be silent data loss with no error anywhere. (Outside a
-- transaction the pragma does suppress the cascade — which is not where a migration runs.)
-- The snapshot does not depend on foreign-key state at all: each child's rows are copied out, the
-- cascade fires against an empty-of-consequence table, and the rows are copied back under the new
-- parent. Verified after the fact: `PRAGMA foreign_key_check` is empty, `foreign_keys` is still ON,
-- an orphan child insert is still refused, and `ON UPDATE CASCADE` still carries a chunk through an
-- archive rename.
--
-- `files_fts` IS dropped explicitly. It is a separate virtual table, so `DROP TABLE files` does not
-- take it, and an external-content FTS5 table left pointing at a dropped content table is a stale
-- index that answers MATCH from rows the corpus no longer has. Its triggers need no drop — a trigger
-- belongs to the table it is defined ON, so `DROP TABLE files` takes all three. Both are recreated
-- from 0003_fts.sql's definitions at the end of this file, over the finished table.

CREATE TABLE files_next (
  path            TEXT PRIMARY KEY,
  blob_sha        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  -- Widened by exactly one value. `task` is a memory TYPE rather than a second axis: three
  -- overlapping type vocabularies is what made the predecessor memory system's classification unanswerable, so a
  -- task's different treatment is stated by the filters that read this column — default-excluded
  -- from retrieval scope, skipped by every sleep phase — and never by a parallel `kind`.
  memory_type     TEXT NOT NULL CHECK (memory_type IN (
                    'episodic','semantic','procedural','agent_insight',
                    'user_preference','error_pattern','verdict','precedent','arc','task')),
  title           TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  gist            TEXT NOT NULL DEFAULT '',
  fts_text        TEXT NOT NULL DEFAULT '',
  disclosure_text TEXT NOT NULL DEFAULT '',
  para            TEXT NOT NULL CHECK (para IN ('projects','areas','resources','archive')),
  workspace       TEXT,
  confidence      REAL    NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  importance      INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  archived        INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  origin_path     TEXT,
  word_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  event_at        TEXT,
  archived_at     TEXT,
  valid_from      TEXT,
  valid_until     TEXT,
  reprieves       INTEGER NOT NULL DEFAULT 0 CHECK (reprieves >= 0),
  needs_revision  INTEGER NOT NULL DEFAULT 0 CHECK (needs_revision IN (0,1)),
  author          TEXT NOT NULL DEFAULT 'agent',
  session_id      TEXT,
  prompt_id       TEXT,
  turn_uuid       TEXT,
  indexed_at      TEXT NOT NULL,
  -- A task's lifecycle position, from `memhtml-task-status`. NULL on every non-task, which the CHECK
  -- admits: an IN-list CHECK passes NULL (probed), so one column serves both cases without a
  -- type-conditional constraint the ten-value vocabulary would have to restate.
  --
  -- A SEPARATE axis from `archived`. `done` is stamped here AND the file is archived by the same
  -- `git mv` every eviction uses, so every path that switches on active/archived keeps its meaning.
  task_status     TEXT CHECK (task_status IN ('todo','doing','blocked','done')),
  -- When a task is due, from `memhtml-due`. An ISO date or datetime, compared and ordered AS A STRING
  -- exactly as `event_at` is — @memhtml/html refuses a value that does not sort alongside the others,
  -- which is what makes `due_at < ?` an overdue query rather than a per-row parse.
  due_at          TEXT
);

INSERT INTO files_next
  SELECT path, blob_sha, content_hash, memory_type, title, body_text, gist, fts_text,
         disclosure_text, para, workspace, confidence, importance, archived, origin_path,
         word_count, created_at, updated_at, event_at, archived_at, valid_from, valid_until,
         reprieves, needs_revision, author, session_id, prompt_id, turn_uuid, indexed_at,
         NULL, NULL
  FROM files;

CREATE TABLE file_tags_snap      AS SELECT * FROM file_tags;
CREATE TABLE file_entities_snap  AS SELECT * FROM file_entities;
CREATE TABLE file_facets_snap    AS SELECT * FROM file_facets;
CREATE TABLE file_citations_snap AS SELECT * FROM file_citations;
CREATE TABLE chunks_snap         AS SELECT * FROM chunks;
-- `embeddings` hangs off `chunks`, not off `files`, so it is lost one cascade further down. The
-- vector BLOB survives `CREATE TABLE … AS SELECT` at full length (probed: 8 bytes in, 8 out).
CREATE TABLE embeddings_snap     AS SELECT * FROM embeddings;

DROP TABLE files_fts;
DROP TABLE files;
ALTER TABLE files_next RENAME TO files;

-- Parent first, then `chunks`, then `embeddings` behind it: the restore is FK-valid at every step
-- rather than relying on the constraints being off.
INSERT INTO file_tags      SELECT * FROM file_tags_snap;
INSERT INTO file_entities  SELECT * FROM file_entities_snap;
INSERT INTO file_facets    SELECT * FROM file_facets_snap;
INSERT INTO file_citations SELECT * FROM file_citations_snap;
INSERT INTO chunks         SELECT * FROM chunks_snap;
INSERT INTO embeddings     SELECT * FROM embeddings_snap;

DROP TABLE file_tags_snap;
DROP TABLE file_entities_snap;
DROP TABLE file_facets_snap;
DROP TABLE file_citations_snap;
DROP TABLE chunks_snap;
DROP TABLE embeddings_snap;

-- Every index the old `files` carried, recreated. A dropped table takes its indexes with it, so an
-- index missing from this list is an index the database silently no longer has.
--
-- The dedup index gains `AND memory_type <> 'task'`. Two open tasks with identical bodies are
-- legitimately distinct work items — "review the deploy runbook" twice is two things to do — while
-- two identical active MEMORIES are one fact stored twice, which is what this index exists to
-- refuse. `dedupeLookup` (`traces-persist.ts` `activePathForHash`) carries the same exclusion, so
-- the write path's question and the database's answer agree by construction rather than by
-- discipline. Probed: two identical-hash open tasks are admitted, two identical-hash memories are
-- still refused, and a memory may share a hash with an open task without colliding.
CREATE UNIQUE INDEX files_content_hash_active ON files (content_hash)
  WHERE archived = 0 AND memory_type <> 'task';
CREATE INDEX files_type_active   ON files (memory_type) WHERE archived = 0;
CREATE INDEX files_workspace     ON files (workspace)   WHERE archived = 0;
CREATE INDEX files_para          ON files (para);
CREATE INDEX files_updated       ON files (updated_at)  WHERE archived = 0;
CREATE INDEX files_event         ON files (event_at)    WHERE event_at IS NOT NULL;
CREATE INDEX files_session       ON files (session_id)  WHERE session_id IS NOT NULL;
CREATE INDEX files_ttl           ON files (valid_until) WHERE valid_until IS NOT NULL AND archived = 0;
CREATE INDEX files_blob          ON files (blob_sha);

-- The task list's own index. `memhtml task list` reads by status over live tasks and nothing else, and
-- the partial predicate keeps the index the size of the open work rather than of the corpus.
CREATE INDEX files_task_status ON files (task_status)
  WHERE memory_type = 'task' AND archived = 0;

-- The lexical index and its triggers, rebuilt over the finished table. These must stay identical to
-- 0003_fts.sql: two definitions of one index that drifted would make a fresh store and a migrated one
-- rank differently, which no test comparing a store to itself would catch.
CREATE VIRTUAL TABLE files_fts USING fts5(
  fts_text,
  content='files',
  content_rowid='rowid'
);

-- The content table already holds every row, so the index is built in one pass here rather than
-- accumulated through the triggers.
INSERT INTO files_fts(files_fts) VALUES ('rebuild');

CREATE TRIGGER files_fts_insert AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, fts_text) VALUES (new.rowid, new.fts_text);
END;

CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, fts_text) VALUES ('delete', old.rowid, old.fts_text);
END;

CREATE TRIGGER files_fts_update AFTER UPDATE OF fts_text ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, fts_text) VALUES ('delete', old.rowid, old.fts_text);
  INSERT INTO files_fts(rowid, fts_text) VALUES (new.rowid, new.fts_text);
END;

-- ── edges: the fourth class ──────────────────────────────────────────────────────────────────────
--
-- Nothing references `edges`, so a plain recreate-and-copy loses nothing. Its rows all carry one of
-- the three existing classes and pass the widened CHECK unchanged.

CREATE TABLE edges_next (
  src_path     TEXT NOT NULL,
  rel          TEXT NOT NULL,
  dst_path     TEXT NOT NULL,
  -- The four classes do not mix. A person or TASK edge is structurally incapable of entering
  -- PageRank, MMR, or the retention bridge count, because every memory-graph query filters on this
  -- column and the CHECKs below refuse a rel from another class. Task topology is working state: a
  -- `blocks` edge reaching PageRank would let an agent's to-do list reweight the retention of its
  -- knowledge.
  edge_class   TEXT NOT NULL DEFAULT 'memory'
               CHECK (edge_class IN ('memory','person','provenance','task')),
  derived      INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0,1)),
  strength     REAL NOT NULL DEFAULT 1.0 CHECK (strength BETWEEN 0 AND 1),
  provenance   TEXT NOT NULL DEFAULT 'authored'
               CHECK (provenance IN ('authored','sleep','import')),
  sleep_run    TEXT,
  src_hash     TEXT,
  dst_hash     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (src_path, rel, dst_path),
  CHECK (src_path <> dst_path),
  CHECK (edge_class <> 'memory' OR rel IN (
    'supersedes','contradicts','caused_by','leads_to','part_of',
    'relates_to','example_of','supports','laterally_related')),
  CHECK (edge_class <> 'person'  OR rel IN ('about_person','authored_by')),
  CHECK (edge_class <> 'provenance' OR rel IN ('from_session')),
  CHECK (edge_class <> 'task' OR rel IN ('blocks','subtask_of')),
  CHECK (derived = 0 OR provenance = 'sleep')
);

INSERT INTO edges_next
  SELECT src_path, rel, dst_path, edge_class, derived, strength, provenance, sleep_run,
         src_hash, dst_hash, created_at
  FROM edges;

DROP TABLE edges;
ALTER TABLE edges_next RENAME TO edges;

CREATE INDEX edges_src ON edges (src_path, edge_class) WHERE derived = 0;
CREATE INDEX edges_dst ON edges (dst_path, edge_class) WHERE derived = 0;
CREATE INDEX edges_rel ON edges (rel, edge_class);
CREATE INDEX edges_derived ON edges (derived, rel);

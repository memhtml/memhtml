-- The memory corpus, one row per file in the git tree. Rebuildable: every column here is
-- derived from a committed file plus its blob sha, so `rm index.db` costs a rebuild and no data.
--
-- `para`, `workspace`, `word_count`, `gist`, `fts_text`, and `disclosure_text` are computed by the
-- indexer rather than by the database: generated columns are unavailable on this driver.
--
-- Every child table declares `ON UPDATE CASCADE` as well as `ON DELETE CASCADE`. `files.path` is the
-- primary key AND it moves: eviction is a `git mv` into `archive/<YYYY>/`, so a rename is an UPDATE
-- of a parent key. Foreign keys are immediate on this driver, so without `ON UPDATE CASCADE` that
-- UPDATE fails outright (probed 2026-08-02) — and a rename handled as a delete plus an insert would
-- cascade the chunk rows away and take their embeddings with them, re-paying Bedrock for text that
-- did not change.

CREATE TABLE files (
  path            TEXT PRIMARY KEY,
  blob_sha        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  memory_type     TEXT NOT NULL CHECK (memory_type IN (
                    'episodic','semantic','procedural','agent_insight',
                    'user_preference','error_pattern','verdict','precedent','arc')),
  title           TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  gist            TEXT NOT NULL DEFAULT '',
  -- title, gist, and body joined by newlines: the ONE column `files_fts` covers, so that a single
  -- MATCH finds a term wherever it lives. A multi-column FTS5 table would make `bm25()` weight the
  -- columns against each other, which is a ranking decision the RRF fusion already owns.
  fts_text        TEXT NOT NULL DEFAULT '',
  -- What memory_recall may QUOTE, which is narrower than what it may search: the <mark> claim,
  -- the <summary> headlines, the <dl> facets, the citations. <details> bodies are excluded (Tier 3,
  -- memory_read only) and <aside> texts are excluded (a scope caveat quoted as the memory would
  -- present the exception as the rule). Stored rather than re-derived at read time so the exclusion
  -- is decided once, by the indexer, where the parsed structure is still in hand.
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
  -- When the remembered fact HAPPENED, from the article's first <time datetime>. World time,
  -- not write time: the recency arm ranks by coalesce(event_at, updated_at) so a memory about
  -- last month's incident does not outrank one about today merely by being written later.
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
  indexed_at      TEXT NOT NULL
);

-- Structural dedup. A duplicate active body cannot even be indexed, so the write path's
-- content-hash lookup and the database agree by construction rather than by discipline.
CREATE UNIQUE INDEX files_content_hash_active ON files (content_hash) WHERE archived = 0;
CREATE INDEX files_type_active   ON files (memory_type) WHERE archived = 0;
CREATE INDEX files_workspace     ON files (workspace)   WHERE archived = 0;
CREATE INDEX files_para          ON files (para);
CREATE INDEX files_updated       ON files (updated_at)  WHERE archived = 0;
CREATE INDEX files_event         ON files (event_at)    WHERE event_at IS NOT NULL;
CREATE INDEX files_session       ON files (session_id)  WHERE session_id IS NOT NULL;
CREATE INDEX files_ttl           ON files (valid_until) WHERE valid_until IS NOT NULL AND archived = 0;
CREATE INDEX files_blob          ON files (blob_sha);

-- Open vocabulary. Tags broaden a scoped search (ANY-of overlap), so a new tag never has to be
-- registered anywhere before it is usable.
CREATE TABLE file_tags (
  path TEXT NOT NULL REFERENCES files (path) ON DELETE CASCADE ON UPDATE CASCADE,
  tag  TEXT NOT NULL,
  PRIMARY KEY (path, tag)
);
CREATE INDEX file_tags_tag ON file_tags (tag);

-- `type:name` references, split at the first colon. `concept:` rows are promoted by the indexer
-- from the article's <dfn> terms, so a semantic memory that defines a term is findable by the
-- term without the author also writing a memhtml-entity meta.
CREATE TABLE file_entities (
  path        TEXT NOT NULL REFERENCES files (path) ON DELETE CASCADE ON UPDATE CASCADE,
  entity_type TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  PRIMARY KEY (path, entity_type, entity_name)
);
CREATE INDEX file_entities_name ON file_entities (entity_type, entity_name);

-- <dt>/<dd> pairs. `numeric_value` is present only when the <dd> carries a <data value> that
-- parses as a finite number, and it is UNITLESS: the unit lives in the human phrasing
-- (<data value="120">about two minutes</data> is seconds because the prose says so), so a
-- consumer must never infer a unit from the number.
CREATE TABLE file_facets (
  path          TEXT NOT NULL REFERENCES files (path) ON DELETE CASCADE ON UPDATE CASCADE,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  numeric_value REAL,
  PRIMARY KEY (path, name, value)
);
CREATE INDEX file_facets_name ON file_facets (name);

-- <cite> and <q cite>. `href` is the quotation's source URI when the file gave one — an
-- arbitrary URI, not necessarily a memory path, so it is deliberately unconstrained.
CREATE TABLE file_citations (
  path TEXT NOT NULL REFERENCES files (path) ON DELETE CASCADE ON UPDATE CASCADE,
  text TEXT NOT NULL,
  href TEXT,
  PRIMARY KEY (path, text)
);

-- The lexical index: an FTS5 table over `files.fts_text`, plus the triggers that keep it in step.
--
-- EXTERNAL CONTENT (`content='files'`) rather than a standalone FTS5 table, so the indexed text is
-- stored once. `files` already holds `fts_text`; a standalone table would keep a second copy of every
-- memory's searchable text, doubling the largest column in the schema for nothing. `content_rowid`
-- names the join back: `files` has a TEXT primary key and therefore an ordinary implicit rowid, which
-- is what FTS5 addresses rows by.
--
-- ONE column, deliberately, and the reason is unchanged: `fts_text` is title + gist + body_text
-- joined, so a term in any of the three is found by one MATCH. A multi-column FTS5 table would scope
-- an unqualified MATCH across all columns but make `bm25()` weight them, which is a ranking decision
-- the RRF fusion already owns.
--
-- Ranking is `bm25(files_fts)` — a real relevance score, ascending, most relevant first (FTS5 returns
-- bm25 as a negative number). The lexical arm's `ROW_NUMBER()` orders by it.
--
-- The triggers are the whole maintenance contract. External-content FTS5 does NOT observe its content
-- table on its own: without them the index silently stops matching rows the corpus has. A delete is
-- written as the `'delete'` command with the OLD text, because FTS5 needs the previous terms to
-- unindex them — passing the new text, or omitting it, corrupts the index rather than failing.
CREATE VIRTUAL TABLE files_fts USING fts5(
  fts_text,
  content='files',
  content_rowid='rowid'
);

CREATE TRIGGER files_fts_insert AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, fts_text) VALUES (new.rowid, new.fts_text);
END;

CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, fts_text) VALUES ('delete', old.rowid, old.fts_text);
END;

-- `OF fts_text` and not a bare `AFTER UPDATE`: every other column is projection metadata the lexical
-- index does not read, and firing on those would pay an unindex+reindex for an `archived` flip.
CREATE TRIGGER files_fts_update AFTER UPDATE OF fts_text ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, fts_text) VALUES ('delete', old.rowid, old.fts_text);
  INSERT INTO files_fts(rowid, fts_text) VALUES (new.rowid, new.fts_text);
END;

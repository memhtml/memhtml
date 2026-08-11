-- The graph. Authored edges come from the files' <link rel="memhtml-*"> elements; derived edges are
-- sleep-mined and live only here, because they are a re-derivable function of the corpus and the
-- embedder. `derived` is the firewall: the retention penalty counts only `derived = 0`, so an
-- uncorroborated machine suspicion can never evict a memory.
--
-- No FK on src_path/dst_path. A <link> may legitimately point at a file the indexer has not reached
-- yet, or at an archived path; a hard FK would make the indexer order-dependent. Dangling links are
-- found by a LEFT JOIN in the integrity phase and repaired in a commit.

CREATE TABLE edges (
  src_path     TEXT NOT NULL,
  rel          TEXT NOT NULL,
  dst_path     TEXT NOT NULL,
  -- The three classes do not mix. A person edge is structurally incapable of entering PageRank,
  -- MMR, or the retention bridge count, because every memory-graph query filters on this column
  -- and the CHECKs below refuse a rel from another class.
  edge_class   TEXT NOT NULL DEFAULT 'memory'
               CHECK (edge_class IN ('memory','person','provenance')),
  derived      INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0,1)),
  -- Unitless in [0, 1]. An authored edge is 1.0; a mined one carries its cosine.
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
  CHECK (derived = 0 OR provenance = 'sleep')
);
CREATE INDEX edges_src ON edges (src_path, edge_class) WHERE derived = 0;
CREATE INDEX edges_dst ON edges (dst_path, edge_class) WHERE derived = 0;
CREATE INDEX edges_rel ON edges (rel, edge_class);
CREATE INDEX edges_derived ON edges (derived, rel);

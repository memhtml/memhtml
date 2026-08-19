-- The corroboration counter on a machine-proposed ENTITY MERGE, the second one-way door that earns a
-- place in the durable plane.
--
-- Sleep's entity resolution asks a model to partition one entity type's names into identity clusters.
-- A proposal the model makes with no external evidence is a guess, and acting on it renames every
-- `memhtml-entity` meta across the corpus and fuses two subjects' memories permanently — there is no
-- inverse commit that separates them again. So a merge the model alone proposes is COUNTED here on the
-- night it is seen and applied only once `detections >= 2`, meaning two different nights reached the
-- same conclusion over independently re-read corpora.
--
-- The same discipline `state.edge_corroboration` holds for a machine-detected `contradicts`, and for
-- the same reason: the counter is derived, high-churn, and gates a write into the files, so it belongs
-- in the plane that is gitignored and re-exported rather than in the memory files themselves. Once the
-- merge is applied the rewrite is file-borne and this row is decoration.
--
-- A merge backed by a DECLARED alias never reaches this table. A person file stating
-- `<meta name="memhtml-alias" content="laith">` is a human's (or an authoritative directory's)
-- assertion of identity, not a machine's suspicion, so it applies on the first night.

CREATE TABLE state.entity_corroboration (
  -- Keyed on the merge, not on a file. An entity name is a value in a `memhtml-entity` meta and
  -- appears on many files, so the pair being corroborated is `(alias_name -> canonical_name)` within
  -- one `entity_type`. `person:api` and `service:api` are two different subjects whose names collide,
  -- so the type is part of the key rather than a column beside it.
  entity_type    TEXT NOT NULL,
  -- The name that would be REWRITTEN AWAY, normalized (lowercased, whitespace-collapsed) exactly as
  -- the phase normalizes before comparing. Storing the raw authored form would make `Checkout API` and
  -- `checkout api` two counters for one merge, and neither would ever reach two detections.
  alias_name     TEXT NOT NULL,
  -- The name that would SURVIVE, normalized. Which of the two this is follows from the phase's own
  -- weight-then-lexicographic rule and never from the model's choice, so the row records the merge the
  -- code would perform rather than the one the model described.
  canonical_name TEXT NOT NULL,
  detections     INTEGER NOT NULL DEFAULT 1 CHECK (detections >= 1),
  confirmed      INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  promoted       INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0,1)),
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (entity_type, alias_name, canonical_name)
);
-- The schema name goes on the INDEX, not on the table: `CREATE INDEX x ON state.entity_corroboration
-- (...)` is a syntax error on this driver, while `CREATE INDEX state.x ON entity_corroboration (...)`
-- is accepted and lands the index in the attached schema. Unqualified `entity_corroboration` resolves
-- within it. (The same fact S0001 records for `state.access`.)
--
-- The lookup this serves is "every pending merge for one type", which the phase reads to report how
-- many proposals are waiting on a second night.
CREATE INDEX state.entity_corroboration_pending ON entity_corroboration (entity_type, promoted);

-- Chunks and their vectors. Both key on `content_hash`, not on `path`: a `git mv` — which is what
-- eviction and every rename are — reuses the vector with zero Bedrock calls, and two files whose
-- bodies later diverge never share one.

CREATE TABLE chunks (
  -- sha256(content_hash || ':' || ordinal). An identical body anywhere in the tree therefore hits
  -- the same chunk row and the same embedding.
  chunk_id     TEXT PRIMARY KEY,
  path         TEXT NOT NULL REFERENCES files (path) ON DELETE CASCADE ON UPDATE CASCADE,
  content_hash TEXT NOT NULL,
  -- 0-based position within THIS file's chunk sequence.
  ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
  text         TEXT NOT NULL,
  char_count   INTEGER NOT NULL
);
CREATE INDEX chunks_path ON chunks (path);
CREATE INDEX chunks_hash ON chunks (content_hash);
CREATE UNIQUE INDEX chunks_hash_ord ON chunks (content_hash, ordinal);

CREATE TABLE embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES chunks (chunk_id) ON DELETE CASCADE,
  -- The vector space, as `<model-id>@<dim>`. A model id alone does not identify a space: the same
  -- id at another output_dimension produces vectors silently incomparable with the stored ones.
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL CHECK (dim > 0),
  -- float32 little-endian, bound as Buffer.from(Float32Array.buffer). `vector_distance_cos` reads
  -- it directly; the MMR pass decodes it with Float32Array rather than paying vector_extract.
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX embeddings_model ON embeddings (model);

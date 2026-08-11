# Turso 0.7.2 — FTS and vector facts that override the docs

**Tags**: turso, tursodatabase, fts, tantivy, vector, sqlite
**Modules**: packages/index

## The rules (all probed live against the 0.7.2 driver)

1. **Single-column FTS only.** A multi-column `USING fts(a, b, c)` index returns **rowid order**
   for a MATCH — no ranking at all — and MATCH scopes to the *named column only*. Since the driver
   exposes no `bm25()`/`rank`, MATCH's own order is the entire lexical relevance signal. Denormalize
   into one `fts_text` column (`packages/index/migrations/0003_fts.sql`).
2. **Sanitize user text before MATCH.** An apostrophe (`don't`) is a hard Tantivy syntax error;
   `field:value` notation errors on nonexistent fields — and `service:checkout-api` is this
   system's own entity notation. `packages/index/src/fts-query.ts` is the sanitizer; if no term
   survives, drop the lexical arm from the fold rather than erroring.
3. **The `experimental: ["index_method"]` connect flag is viral**: once an FTS index exists, EVERY
   statement touching that table needs it. One exported `TURSO_OPTS` constant, typed via
   `satisfies` against `connect`'s own signature (the option type isn't re-exported), so a future
   flag rename is a compile error, not a bricked DB.
4. **Bulk load drops + recreates the FTS index.** Writing through a live index is 10–25 ms/row and
   superlinear (800 rows: 19.9 s indexed vs 18 ms not).
5. **Vector search**: exact `vector_distance_cos` over F32 blobs works (`Buffer.from(f32.buffer)`
   binds directly); 10k × 1024-dim brute-force top-40 ≈ 21–25 ms. No DiskANN `vector_top_k` in the
   rewrite yet. In a chunked schema the vector arm must `GROUP BY path` or long files outrank
   relevant ones.
6. `ON UPDATE CASCADE` on every child of a moving TEXT primary key (`files.path`) — the real driver
   rejects the update without it; a fake accepts it.
7. No recursive CTEs — graph math (PageRank, label propagation) runs in application code;
   fixed-depth joins for bounded traversal.

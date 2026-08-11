import {
  InvalidMemory,
  type ModelUnavailable,
  type StorageFailure
} from "@memhtml/contracts/errors"
import { MEMORY_EXTENSION, normalizePath } from "@memhtml/contracts/paths"
import { PARA_BUCKETS } from "@memhtml/contracts/types"
import { contentHash, parseMemory } from "@memhtml/html"
import { Context, Effect } from "effect"

import type { DatabaseShape, Write } from "./database.js"
import type { GitPort } from "./git-port.js"
import { type FileProjection, projectFile } from "./project.js"
import {
  FTS_COLUMN,
  FTS_INDEX_NAME,
  FTS_REBUILD_MIN_FILES,
  FTS_REBUILD_ROWS_PER_WRITE,
  INDEX_STATE_ID,
  MEMORY_TABLES,
  WRITE_BATCH_SIZE
} from "./schema-const.js"

/**
 * The indexer: git is the source of truth, `index.db` is a projection of it.
 *
 * Two paths, one projection. `rebuild` reads the whole tree at HEAD; `update` reads only what moved
 * since the recorded watermark plus whatever the working tree has uncommitted. Both call
 * {@link projectFile}, so "a fresh rebuild reproduces the incremental row set" is true by
 * construction rather than by two implementations agreeing.
 */

/** What the embedder must provide. Structurally `@memhtml/llm`'s `EmbeddingsShape`, minus the query half. */
export interface EmbedPort {
  readonly embed: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Float32Array>, ModelUnavailable>
}

/** A full rebuild's outcome. */
export interface RebuildReport {
  readonly headSha: string
  readonly filesIndexed: number
  readonly chunksIndexed: number
  readonly edgesIndexed: number
  readonly embeddingsWritten: number
  /** Files git offered that failed to parse. Counted, never fatal — one bad file is not a bad tree. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

/** An incremental pass's outcome. `unchanged: true` means the watermark and the tree already agreed. */
export interface UpdateReport {
  readonly headSha: string
  readonly unchanged: boolean
  readonly added: number
  readonly modified: number
  readonly removed: number
  readonly renamed: number
  readonly dirty: number
  readonly embeddingsWritten: number
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

/**
 * How wide {@link IndexerShape.embedMissing} looks for work.
 *
 * Omitting `candidateChunkIds` — or omitting the options object entirely — asks for the FULL scan
 * over `chunks`, which is the only form that can find a chunk whose vector belongs to a superseded
 * model. `memhtml index rebuild --embed` must therefore never pass a list: the model migration IS the
 * whole-store `e.model <> ?` disjunct, and scoping it to one batch's ids would leave every other
 * chunk in the old vector space while reporting success.
 *
 * Passing a list asks the opposite question — "which of THESE chunks lack a current vector" — which
 * is what an incremental pass actually needs, and what keeps its cost independent of store size.
 */
export interface EmbedMissingOptions {
  /**
   * Restrict the pending scan to these chunk ids. An empty array is a real answer, not a missing
   * one: it means the caller projected no chunks, so there is no work and no reason to query.
   */
  readonly candidateChunkIds?: ReadonlyArray<string> | undefined
}

export interface IndexerShape {
  readonly rebuild: (opts: {
    readonly embed: boolean
  }) => Effect.Effect<RebuildReport, StorageFailure | EmbedModelMismatch>
  readonly update: (opts: {
    readonly embed: boolean
  }) => Effect.Effect<UpdateReport, StorageFailure | EmbedModelMismatch>
  readonly indexPaths: (
    paths: ReadonlyArray<string>
  ) => Effect.Effect<UpdateReport, StorageFailure | EmbedModelMismatch>
  /**
   * Fill vectors for chunks that have none, or whose vector belongs to another model.
   *
   * Called with no argument this scans the whole `chunks` table — see {@link EmbedMissingOptions}
   * for when that is required and when a candidate list is the cheaper, equivalent question.
   */
  readonly embedMissing: (
    options?: EmbedMissingOptions
  ) => Effect.Effect<number, StorageFailure | EmbedModelMismatch>
}

export const Indexer = Context.Service<IndexerShape>("memhtml/Indexer")

/**
 * The stored vector space disagrees with the configured one.
 *
 * A hard refusal, never a silent reindex: a half-migrated vector space degrades every cosine while
 * every test still passes, because each individual vector is well-formed. `memhtml index rebuild
 * --embed-model=<new>` is the only path that rewrites vectors, and it truncates `embeddings` first.
 */
export class EmbedModelMismatch {
  readonly _tag = "EmbedModelMismatch"
  constructor(
    readonly stored: string,
    readonly configured: string
  ) {}
}

/** How an indexer is built. `embedWatermark` is `@memhtml/llm`'s `EMBED_WATERMARK`, never re-derived. */
export interface IndexerDeps {
  readonly db: DatabaseShape
  readonly git: GitPort
  /** `<model-id>@<dim>`. Passed in so this package never names a model or a dimension. */
  readonly embedWatermark: string
  readonly embedDim: number
  readonly embeddings?: EmbedPort | undefined
  /** Wall-clock, injected. A fixed instant makes `indexed_at` assertable. */
  readonly now: () => string
}

/**
 * Files the indexer refuses to consider, by name.
 *
 * `index.html` and `sitemap.xml` are GENERATED by `memhtml publish` from the corpus. Indexing them would
 * feed every directory listing back into retrieval as a memory whose body is the titles of other
 * memories — the corpus would rank its own table of contents above its content.
 */
export const GENERATED_NAMES: ReadonlyArray<string> = ["index.html", "sitemap.xml"]

/** True when a tree path is a memory file the indexer owns. */
export const isIndexablePath = (path: string): boolean => {
  const normalized = normalizePath(path)
  if (!normalized.endsWith(MEMORY_EXTENSION)) return false
  const segments = normalized.split("/")
  const name = segments.at(-1)
  if (name === undefined || GENERATED_NAMES.includes(name)) return false
  const head = segments[0]
  return head !== undefined && (PARA_BUCKETS as ReadonlyArray<string>).includes(head)
}

/** The buckets a rebuild reads. Passed to `ls-tree` so `.memhtml/` and the repo's own docs stay out. */
export const TREE_PREFIXES: ReadonlyArray<string> = [...PARA_BUCKETS]

/**
 * Chunk ids bound into one `IN (…)` pending scan.
 *
 * SQLite's bound-variable ceiling is a BUILD property, not a language one — 999 in older builds,
 * 32766 since 3.32 — and this package must not assume which one the driver shipped with. So the
 * candidate list is split, and the split size is small enough to be safe under either. Splitting
 * costs one extra statement per 500 ids while the term it replaces was the entire table, so the
 * ceiling here is a correctness guard rather than a tuning knob.
 */
export const PENDING_SCAN_ID_BATCH = 500

export const makeIndexer = (deps: IndexerDeps): IndexerShape => {
  const { db, git } = deps

  /** Apply writes in bounded batches. One `writeAll` per batch, each atomic on its own. */
  const applyWrites = (writes: ReadonlyArray<Write>) =>
    Effect.gen(function* () {
      for (let at = 0; at < writes.length; at += WRITE_BATCH_SIZE) {
        yield* db.writeAll(writes.slice(at, at + WRITE_BATCH_SIZE))
      }
    })

  /**
   * Apply an incremental pass's writes, rebuilding the FTS index around them when the pass is bulk.
   *
   * Inserting through the live FTS index costs ~8 ms/row freshly built and DEGRADES with every row
   * inserted since the index was last created — probed 2026-08-06 on @tursodatabase/database 0.7.2:
   * four consecutive 256-op updates cost 2.4 s → 5.1 s → 7.9 s → 10.7 s in `db.writeAll` at a
   * constant store size, and the same four updates under a drop/create bracket stay flat at ~0.6 s.
   * That accumulation is what made bulk ingest's per-batch wall grow 45 s → 5.5 min over 72 batches
   * (2026-08-05 eval run) after the git-side quadratic was already fixed. Rebuilding the index is
   * linear in TABLE size (~6.6 µs/row: 13 ms at 1k files, 133 ms at 20k), so for a large enough
   * batch the bracket is strictly cheaper — and it also resets the accumulated degradation, which
   * the live path never does.
   *
   * The threshold keeps the interactive path on the live insert: a single-file write pays ~8 ms,
   * and bracketing it would charge the whole table's rebuild for one row. Break-even is roughly
   * one written row per {@link FTS_REBUILD_ROWS_PER_WRITE} table rows, floored at
   * {@link FTS_REBUILD_MIN_FILES} so small stores never bracket a handful of writes.
   *
   * A crash between the DROP and the CREATE leaves `index.db` without its lexical index — the same
   * exposure window `rebuild` has always had, and acceptable for the same reason: the whole file is
   * a projection, and `memhtml index rebuild` reproduces it.
   */
  const applyProjectionWrites = (writes: ReadonlyArray<Write>, filesTouched: number) =>
    Effect.gen(function* () {
      if (filesTouched < FTS_REBUILD_MIN_FILES) return yield* applyWrites(writes)
      const counted = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM files")
      if (filesTouched * FTS_REBUILD_ROWS_PER_WRITE < (counted?.n ?? 0)) {
        return yield* applyWrites(writes)
      }
      yield* db.run(`DROP INDEX IF EXISTS ${FTS_INDEX_NAME}`)
      yield* applyWrites(writes)
      yield* db.run(`CREATE INDEX ${FTS_INDEX_NAME} ON files USING fts(${FTS_COLUMN})`)
    })

  /**
   * Parse and project one file. A parse failure yields the reason instead of failing the pass: a
   * hand-authored file that violates a constraint must be reported by `memhtml doctor`, not stop the
   * indexing of every other file in the tree.
   */
  const projectOne = (path: string, blobSha: string, html: string) =>
    parseMemory(html).pipe(
      Effect.map((doc) =>
        projectFile({
          path,
          blobSha,
          contentHash: contentHash(doc.article.html),
          doc,
          indexedAt: deps.now()
        })
      ),
      Effect.result
    )

  /** Read the recorded watermark row, or `undefined` before the first rebuild. */
  const readState = () =>
    db.get<{ head_sha: string | null; embed_model: string; embed_dim: number }>(
      "SELECT head_sha, embed_model, embed_dim FROM index_state WHERE id = ?",
      [INDEX_STATE_ID]
    )

  /**
   * Refuse when the stored vector space is not the configured one.
   *
   * Checked before any write, and before the *first* write records a watermark — so an index built
   * under one model can never accumulate rows under another.
   */
  const guardEmbedModel = () =>
    Effect.gen(function* () {
      const state = yield* readState()
      if (state !== undefined && state.embed_model !== deps.embedWatermark) {
        return yield* Effect.fail(new EmbedModelMismatch(state.embed_model, deps.embedWatermark))
      }
    })

  const writeState = (headSha: string, rebuilt: boolean) => {
    const at = deps.now()
    return db.run(
      rebuilt
        ? `INSERT INTO index_state (id, head_sha, embed_model, embed_dim, rebuilt_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET head_sha = excluded.head_sha,
             embed_model = excluded.embed_model, embed_dim = excluded.embed_dim,
             rebuilt_at = excluded.rebuilt_at, updated_at = excluded.updated_at`
        : `INSERT INTO index_state (id, head_sha, embed_model, embed_dim, rebuilt_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET head_sha = excluded.head_sha, updated_at = excluded.updated_at`,
      [INDEX_STATE_ID, headSha, deps.embedWatermark, deps.embedDim, at, at]
    )
  }

  /**
   * The chunks with no current vector: the whole table, or only the candidates the caller names.
   *
   * The two branches ask the same predicate of different row sets, which is what makes the scoped
   * form a cost optimization rather than a semantic change. The unscoped form is unavoidably a full
   * table scan — `e.model <> ?` cannot use the `embeddings(model)` index because it must also match
   * the rows where `e.model` is NULL from the LEFT JOIN, and that disjunct is the model migration's
   * whole purpose. Measured linear: 11 ms at 1k chunks, 60 ms at 10k (probe, 2026-08-06). Paying it
   * once per rebuild is right; paying it once per incremental batch is the store-scaled term that
   * made bulk ingest quadratic in fact count.
   *
   * Candidate ids are BOUND, never interpolated. They are internal sha256 hex and could not carry a
   * quote, but a query assembled by concatenation is one refactor away from being handed something
   * that can — and the binding costs nothing.
   */
  const pendingChunks = (candidateChunkIds: ReadonlyArray<string> | undefined) =>
    Effect.gen(function* () {
      const select = `SELECT c.chunk_id AS chunk_id, c.text AS text
         FROM chunks c
         LEFT JOIN embeddings e ON e.chunk_id = c.chunk_id`
      /**
       * Parenthesized, and that is not cosmetic. SQL binds `AND` tighter than `OR`, so appending
       * `AND c.chunk_id IN (…)` to a bare `e.chunk_id IS NULL OR e.model <> ?` parses as
       * `IS NULL OR (model <> ? AND IN (…))` — the vector-less disjunct escapes the scoping and the
       * statement silently reads the whole table again. Caught by the candidate-list test, which
       * embedded three chunks where one was owed.
       */
      const predicate = "WHERE (e.chunk_id IS NULL OR e.model <> ?)"

      if (candidateChunkIds === undefined) {
        return yield* db.all<{ chunk_id: string; text: string }>(
          `${select}
         ${predicate}
         ORDER BY c.chunk_id`,
          [deps.embedWatermark]
        )
      }

      /**
       * Deduped, because one batch can project the same chunk id twice — a file committed and then
       * edited in the working tree appears in both of `update`'s loops, and two identical ids in the
       * `IN` list would return the row twice and embed the same text twice.
       */
      const ids = [...new Set(candidateChunkIds)]
      const rows: Array<{ chunk_id: string; text: string }> = []
      for (let at = 0; at < ids.length; at += PENDING_SCAN_ID_BATCH) {
        const slice = ids.slice(at, at + PENDING_SCAN_ID_BATCH)
        const holes = slice.map(() => "?").join(", ")
        rows.push(
          ...(yield* db.all<{ chunk_id: string; text: string }>(
            `${select}
         ${predicate} AND c.chunk_id IN (${holes})
         ORDER BY c.chunk_id`,
            [deps.embedWatermark, ...slice]
          ))
        )
      }
      return rows as ReadonlyArray<{ chunk_id: string; text: string }>
    })

  /**
   * Embed every chunk that has no vector, or whose vector belongs to another model.
   *
   * Keyed on `chunk_id`, which keys on `content_hash` — so a `git mv` finds the vector already
   * present and issues zero Bedrock calls, and `--no-embed` followed by `embedMissing()` backfills
   * exactly the gap.
   *
   * A model failure is not fatal here. The lexical floor is a working index; refusing to leave the
   * embed lane partially filled would mean a throttled Bedrock turns a complete FTS index into no
   * index at all. Note what that costs under a candidate list: a chunk whose embed call failed is no
   * longer picked up incidentally by the next unrelated `update`, because that update now only asks
   * about its own chunks. `memhtml index rebuild --embed` and a bare `embedMissing()` remain the paths
   * that close a store-wide gap, and both keep the full scan.
   */
  const embedMissing = (
    options?: EmbedMissingOptions
  ): Effect.Effect<number, StorageFailure | EmbedModelMismatch> =>
    Effect.gen(function* () {
      yield* guardEmbedModel()
      const embeddings = deps.embeddings
      if (embeddings === undefined) return 0

      /**
       * An empty candidate list short-circuits before the query, not inside it. `IN ()` is not valid
       * SQLite, and more importantly a pass that projected no chunks has provably no embed work — so
       * the cheapest correct answer is to not ask.
       */
      const candidateChunkIds = options?.candidateChunkIds
      if (candidateChunkIds !== undefined && candidateChunkIds.length === 0) return 0

      const pending = yield* pendingChunks(candidateChunkIds)
      if (pending.length === 0) return 0

      const vectors = yield* embeddings.embed(pending.map((row) => row.text)).pipe(
        Effect.tapError((error) =>
          Effect.logError(`indexer.embed skipped ${pending.length} chunks: ${error.reason}`)
        ),
        Effect.result
      )
      if (vectors._tag === "Failure") return 0

      const at = deps.now()
      const writes = pending.flatMap((row, at_) => {
        const vector = vectors.success[at_]
        if (vector === undefined) return []
        return [
          {
            sql: `INSERT INTO embeddings (chunk_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
                    vec = excluded.vec, created_at = excluded.created_at`,
            params: [
              row.chunk_id,
              deps.embedWatermark,
              deps.embedDim,
              new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
              at
            ] satisfies Write["params"]
          }
        ]
      })
      yield* applyWrites(writes)
      return writes.length
    }).pipe(Effect.withSpan("indexer.embedMissing"))

  const rebuild = (opts: { readonly embed: boolean }) =>
    Effect.gen(function* () {
      yield* guardEmbedModel()
      const headSha = yield* git.revParseHead()
      const entries = (yield* git.lsTreeR(headSha, TREE_PREFIXES)).filter((entry) =>
        isIndexablePath(entry.path)
      )
      const blobs = yield* git.catFileBatch(entries.map((entry) => entry.blobSha))

      /**
       * The FTS index is dropped for the bulk load and rebuilt after.
       *
       * Probed 2026-08-02: inserting 800 rows through a live FTS index took 19.9 s and the cost is
       * superlinear in table size; the same rows with the index absent took 18 ms, and building the
       * index over them afterwards took 13 ms. Keeping the index up during a rebuild would make a
       * 10k-memory corpus unindexable in practice.
       */
      yield* db.run(`DROP INDEX IF EXISTS ${FTS_INDEX_NAME}`)

      /** Children before parents. Correct with foreign keys enforced, not merely via cascade. */
      for (const table of MEMORY_TABLES) yield* db.run(`DELETE FROM ${table}`)

      const projections: Array<FileProjection> = []
      const skipped: Array<{ path: string; reason: string }> = []
      for (const entry of entries) {
        const html = blobs.get(entry.blobSha)
        if (html === undefined) {
          skipped.push({ path: entry.path, reason: "blob missing from cat-file batch" })
          continue
        }
        const projected = yield* projectOne(entry.path, entry.blobSha, html)
        if (projected._tag === "Failure")
          skipped.push({ path: entry.path, reason: projected.failure.reason })
        else projections.push(projected.success)
      }

      yield* applyWrites(projections.flatMap((projection) => projection.writes))
      yield* db.run(`CREATE INDEX ${FTS_INDEX_NAME} ON files USING fts(${FTS_COLUMN})`)
      yield* writeState(headSha, true)

      const embeddingsWritten = opts.embed ? yield* embedMissing() : 0
      const edgesIndexed = yield* countEdges(db)

      yield* Effect.log(
        `indexer.rebuild: ${projections.length} files, ${skipped.length} skipped at ${headSha}`
      )
      return {
        headSha,
        filesIndexed: projections.length,
        chunksIndexed: projections.reduce((total, one) => total + one.chunks.length, 0),
        edgesIndexed,
        embeddingsWritten,
        skipped
      }
    }).pipe(Effect.withSpan("indexer.rebuild"))

  /**
   * Remove one path entirely. `files` cascades to tags, entities, facets, citations, and chunks, and
   * the embeddings hanging off those chunks go with them.
   *
   * This is for a path that LEFT the tree. A rename is not a delete plus an add — the projection's
   * content-keyed chunk upsert handles it — so calling this on a rename's source would destroy the
   * embedding the rename exists to preserve.
   *
   * `edges` is cleared by `src_path` only, for the same reason the projection is: an inbound edge is
   * another file's authored assertion.
   */
  const deletePath = (path: string): ReadonlyArray<Write> => [
    { sql: "DELETE FROM edges WHERE src_path = ?", params: [path] },
    { sql: "DELETE FROM files WHERE path = ?", params: [path] }
  ]

  /**
   * Re-point one path's rows at a new path, keeping the embedding.
   *
   * This is the archive move and every rename — the case `diff -M` reports as `R100`. It is an
   * `UPDATE`, not a delete plus an insert, and the distinction is the whole reason `chunks` keys on
   * `content_hash`: `DELETE FROM files WHERE path = <source>` cascades to the source's chunk rows,
   * and `embeddings.chunk_id` cascades from THOSE — so a delete-and-re-add loses the vector and the
   * next embed pass pays Bedrock again for text that did not change.
   *
   * Every child table declares `ON UPDATE CASCADE`, so one `UPDATE` on `files.path` carries the
   * tags, entities, facets, citations, and chunks with it. The `edges` row is updated explicitly
   * because it holds no foreign key — a `<link>` may name a file the indexer has not reached, so a
   * hard FK there would make indexing order-dependent.
   *
   * The caller re-projects the destination immediately afterwards, in the same batch, which is what
   * picks up the `memhtml-status`/`memhtml-archived` stamps the move added. That re-projection's `files`
   * upsert then hits the row this `UPDATE` just moved, and its chunk upsert hits the same
   * `chunk_id`s — both absorbed by `ON CONFLICT`.
   */
  const movePath = (from: string, to: string): ReadonlyArray<Write> => [
    { sql: "UPDATE files SET path = ? WHERE path = ?", params: [to, from] },
    { sql: "UPDATE edges SET src_path = ? WHERE src_path = ?", params: [to, from] }
  ]

  /** Read one path's current blob and project it, preferring the working tree over the commit. */
  const projectFromTree = (path: string, ref: string, useWorkingTree: boolean) =>
    Effect.gen(function* () {
      if (useWorkingTree) {
        const blobSha = yield* git.hashObject(path)
        const html = yield* git.readWorkingFile(path)
        return yield* projectOne(path, blobSha, html)
      }
      const entries = yield* git.lsTreeR(ref, [path])
      const entry = entries.find(
        (candidate) => normalizePath(candidate.path) === normalizePath(path)
      )
      if (entry === undefined) {
        return yield* Effect.succeed(
          Effect.result(Effect.fail(InvalidMemory.make({ reason: "path absent from tree" })))
        ).pipe(Effect.flatten)
      }
      const blobs = yield* git.catFileBatch([entry.blobSha])
      const html = blobs.get(entry.blobSha)
      return html === undefined
        ? yield* Effect.result(
            Effect.fail(InvalidMemory.make({ reason: "blob missing from cat-file batch" }))
          )
        : yield* projectOne(path, entry.blobSha, html)
    })

  /**
   * Re-index an explicit set of paths from the working tree.
   *
   * The write path calls this right after a commit, so the working tree and HEAD agree and reading
   * from disk is both correct and cheaper than a `cat-file` round trip. A path that no longer exists
   * is treated as a deletion rather than an error — a caller listing a path it just archived is the
   * normal case, not a mistake.
   */
  const indexPaths = (paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* guardEmbedModel()
      const headSha = yield* git.revParseHead()
      const targets = paths.map(normalizePath).filter(isIndexablePath)
      const status = yield* git.statusPorcelainV2()
      const deleted = new Set(status.filter((entry) => entry.deleted).map((entry) => entry.path))

      const writes: Array<Write> = []
      const skipped: Array<{ path: string; reason: string }> = []
      let added = 0
      let removed = 0

      for (const path of targets) {
        if (deleted.has(path)) {
          writes.push(...deletePath(path))
          removed += 1
          continue
        }
        const projected = yield* projectFromTree(path, headSha, true).pipe(
          Effect.catch(() =>
            Effect.result(Effect.fail(InvalidMemory.make({ reason: "path is unreadable" })))
          )
        )
        if (projected._tag === "Failure") skipped.push({ path, reason: projected.failure.reason })
        else {
          writes.push(...projected.success.writes)
          added += 1
        }
      }

      yield* applyProjectionWrites(writes, added)
      const embeddingsWritten = yield* embedMissing()
      return {
        headSha,
        unchanged: targets.length === 0,
        added,
        modified: 0,
        removed,
        renamed: 0,
        dirty: targets.length,
        embeddingsWritten,
        skipped
      }
    }).pipe(Effect.withSpan("indexer.indexPaths"))

  const update = (opts: { readonly embed: boolean }) =>
    Effect.gen(function* () {
      yield* guardEmbedModel()
      const headSha = yield* git.revParseHead()
      const state = yield* readState()
      const watermark = state?.head_sha ?? null

      /** No watermark means no index. Falling through to a diff would index the delta of nothing. */
      if (watermark === null) {
        const report = yield* rebuild(opts)
        return {
          headSha: report.headSha,
          unchanged: false,
          added: report.filesIndexed,
          modified: 0,
          removed: 0,
          renamed: 0,
          dirty: 0,
          embeddingsWritten: report.embeddingsWritten,
          skipped: report.skipped
        }
      }

      const diffs =
        watermark === headSha
          ? []
          : (yield* git.diffNameStatus(watermark, headSha)).filter(
              (entry) => isIndexablePath(entry.path) || isIndexablePath(entry.fromPath ?? "")
            )
      const status = (yield* git.statusPorcelainV2()).filter((entry) => isIndexablePath(entry.path))

      /**
       * Every committed diff target's blob, read in TWO subprocesses rather than two PER FILE.
       *
       * A per-file `lsTreeR(ref, [path])` walks the whole tree to answer one path, and
       * `catFileBatch([sha])` spawns a process to read one blob — so a batch of N writes cost
       * 2N tree walks, which is the store-scaled per-op term that made bulk ingest quadratic
       * (probed 2026-08-05: 49 ms per walk at 10k files, 25 s of a 48 s update at N=256).
       * One full-tree walk costs the same as one single-path walk — git walks the tree either
       * way — so batching is strictly cheaper from the second changed file on.
       */
      const treeTargets = diffs.filter((diff) => diff.status !== "D" && isIndexablePath(diff.path))
      const blobShaByPath = new Map<string, string>()
      if (treeTargets.length > 0) {
        for (const entry of yield* git.lsTreeR(headSha, TREE_PREFIXES)) {
          blobShaByPath.set(normalizePath(entry.path), entry.blobSha)
        }
      }
      const diffBlobs =
        treeTargets.length === 0
          ? new Map<string, string>()
          : yield* git.catFileBatch([
              ...new Set(
                treeTargets.flatMap((diff) => {
                  const sha = blobShaByPath.get(normalizePath(diff.path))
                  return sha === undefined ? [] : [sha]
                })
              )
            ])

      const writes: Array<Write> = []
      const skipped: Array<{ path: string; reason: string }> = []
      /**
       * Every chunk id this pass projected — the exact set the embed lane may need to fill.
       *
       * Complete for this path, and that completeness rests on `chunk_id` being content-derived
       * (`sha256(content_hash + ":" + ordinal)`). A deletion cascades its chunks and their vectors
       * away through `chunks.path REFERENCES files(path) ON DELETE CASCADE` and
       * `embeddings.chunk_id REFERENCES chunks(chunk_id) ON DELETE CASCADE`, so it creates no pending
       * work. A rename is an `UPDATE files.path` carried by `ON UPDATE CASCADE`, which keeps the
       * chunk row AND its vector — and the destination is re-projected in this same loop, so its ids
       * land here regardless. What is left is exactly the added and modified bodies, which are the
       * only chunks that can lack a current vector.
       */
      const candidateChunkIds: Array<string> = []
      let added = 0
      let modified = 0
      let removed = 0
      let renamed = 0

      /**
       * Committed changes first, then the working tree. A path that both moved in a commit and was
       * then edited uncommitted must end at the working tree's content, and the ordering is what
       * guarantees it rather than an explicit precedence rule that could disagree.
       */
      for (const diff of diffs) {
        if (diff.status === "D") {
          writes.push(...deletePath(diff.path))
          removed += 1
          continue
        }
        if (diff.status === "R" && diff.fromPath !== undefined) {
          writes.push(...movePath(diff.fromPath, diff.path))
          renamed += 1
        }
        const blobSha = blobShaByPath.get(normalizePath(diff.path))
        const html = blobSha === undefined ? undefined : diffBlobs.get(blobSha)
        const projected =
          blobSha === undefined
            ? yield* Effect.result(
                Effect.fail(InvalidMemory.make({ reason: "path absent from tree" }))
              )
            : html === undefined
              ? yield* Effect.result(
                  Effect.fail(InvalidMemory.make({ reason: "blob missing from cat-file batch" }))
                )
              : yield* projectOne(diff.path, blobSha, html)
        if (projected._tag === "Failure") {
          skipped.push({ path: diff.path, reason: projected.failure.reason })
          continue
        }
        writes.push(...projected.success.writes)
        for (const chunk of projected.success.chunks) candidateChunkIds.push(chunk.chunkId)
        if (diff.status === "A") added += 1
        else if (diff.status === "M") modified += 1
      }

      const dirtyPaths = new Set(status.map((entry) => entry.path))
      for (const entry of status) {
        if (entry.deleted) {
          writes.push(...deletePath(entry.path))
          removed += 1
          continue
        }
        const projected = yield* projectFromTree(entry.path, headSha, true).pipe(
          Effect.catch(() =>
            Effect.result(Effect.fail(InvalidMemory.make({ reason: "path is unreadable" })))
          )
        )
        if (projected._tag === "Failure")
          skipped.push({ path: entry.path, reason: projected.failure.reason })
        else {
          writes.push(...projected.success.writes)
          for (const chunk of projected.success.chunks) candidateChunkIds.push(chunk.chunkId)
        }
      }

      yield* applyProjectionWrites(writes, added + modified + status.length)
      yield* writeState(headSha, false)
      /**
       * Scoped to this pass's own chunks, which is what keeps an incremental update's cost flat in
       * store size. The unscoped scan is a full `chunks` table read per batch — 11 ms at 1k chunks,
       * 60 ms at 10k — and multiplying that by one call per batch is the residual store-scaled term
       * the 2026-08-05 quadratic-ingest fix left behind.
       */
      const embeddingsWritten = opts.embed ? yield* embedMissing({ candidateChunkIds }) : 0

      const unchanged = diffs.length === 0 && status.length === 0
      yield* Effect.log(
        `indexer.update: ${added} added, ${modified} modified, ${removed} removed, ${renamed} renamed, ${dirtyPaths.size} dirty at ${headSha}`
      )
      return {
        headSha,
        unchanged,
        added,
        modified,
        removed,
        renamed,
        dirty: dirtyPaths.size,
        embeddingsWritten,
        skipped
      }
    }).pipe(Effect.withSpan("indexer.update"))

  return { rebuild, update, indexPaths, embedMissing }
}

const countEdges = (db: DatabaseShape) =>
  db.get<{ n: number }>("SELECT count(*) AS n FROM edges").pipe(Effect.map((row) => row?.n ?? 0))

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
import { readIndexState } from "./index-state.js"
import { type FileProjection, projectFile } from "./project.js"
import { INDEX_STATE_ID, MEMORY_TABLES, WRITE_BATCH_SIZE } from "./schema-const.js"

/**
 * The indexer. Git is the source of truth, and `index.db` is a projection of it.
 *
 * Two paths, one projection. `rebuild` reads the whole tree at HEAD. `update` reads only what moved
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
  /** Files git offered that failed to parse. Counted, never fatal. One bad file is not a bad tree. */
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
 * Omitting `candidateChunkIds`, or omitting the options object entirely, asks for the FULL scan
 * over `chunks`, which is the only form that can find a chunk whose vector belongs to a superseded
 * model. `memhtml index rebuild --embed` must therefore never pass a list. The model migration IS the
 * whole-store `e.model <> ?` disjunct, and scoping it to one batch's ids would leave every other
 * chunk in the old vector space while reporting success.
 *
 * Passing a list asks a narrower question, "which of THESE chunks lack a current vector", which
 * is what an incremental pass actually needs, and what keeps its cost independent of store size.
 */
export interface EmbedMissingOptions {
  /**
   * Restrict the pending scan to these chunk ids. An empty array is a real answer rather than a
   * missing one. It means the caller projected no chunks, so there is no work and no reason to query.
   */
  readonly candidateChunkIds?: ReadonlyArray<string> | undefined
}

export interface IndexerShape {
  readonly rebuild: (opts: {
    readonly embed: boolean
  }) => Effect.Effect<RebuildReport, StorageFailure | EmbedModelMismatch>
  readonly update: (opts: {
    readonly embed: boolean
  }) => Effect.Effect<UpdateReport, StorageFailure | EmbedModelMismatch | IndexStale>
  /**
   * Fill vectors for chunks that have none, or whose vector belongs to another model.
   *
   * Called with no argument this scans the whole `chunks` table. See {@link EmbedMissingOptions}
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
 * A hard failure rather than a silent reindex. A half-migrated vector space degrades every
 * cosine while every test still passes, because each vector is well-formed. `memhtml index rebuild
 * --embed` is the one path allowed past this guard: a rebuild empties `embeddings` with the other
 * memory tables and records the configured model before any vector is written, so it migrates the
 * whole space rather than mixing two.
 */
export class EmbedModelMismatch {
  readonly _tag = "EmbedModelMismatch"
  constructor(
    readonly stored: string,
    readonly configured: string
  ) {}
}

/**
 * The index is a partial state `update` cannot diff from: a rebuild emptied the tables and did not
 * finish repopulating them.
 *
 * A rebuild clears `index_state.head_sha` in the same transaction as its truncate and writes the
 * commit back only after every projection landed, so an EXISTING row whose `head_sha` is NULL is
 * exactly a rebuild that died inside that window. That is a different state from no row at all,
 * which is a store nothing has indexed yet and which `update` answers with a full rebuild. Here the
 * tables are half-empty and there is no watermark to diff from, so a diff would report
 * `unchanged: true` over rows the tree still holds. The CLI maps this tag to `ERR_INDEX_STALE`.
 */
export class IndexStale {
  readonly _tag = "IndexStale"
  constructor(readonly reason: string) {}
}

/** How an indexer is built. `embedWatermark` is `@memhtml/llm`'s `EMBED_WATERMARK`, never re-derived. */
export interface IndexerDeps {
  readonly db: DatabaseShape
  readonly git: GitPort
  /** `<model-id>@<dim>`. Passed in so this package never names a model or a dimension. */
  readonly embedWatermark: string
  readonly embedDim: number
  readonly embeddings?: EmbedPort | undefined
  /**
   * How many pending chunks are embedded and PERSISTED per `embedMissing` slice. Defaults to
   * {@link EMBED_PERSIST_SLICE}. Injectable so a test can force several slices over a small
   * corpus; production callers leave it alone.
   */
  readonly embedPersistEvery?: number | undefined
  /** Wall-clock, injected. A fixed instant makes `indexed_at` assertable. */
  readonly now: () => string
}

/**
 * Files the indexer refuses to consider, by name.
 *
 * `index.html` and `sitemap.xml` are GENERATED by `memhtml publish` from the corpus. Indexing them would
 * feed every directory listing back into retrieval as a memory whose body is the titles of other
 * memories, and the corpus would rank its own table of contents above its content.
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
 * SQLite's bound-variable ceiling is a BUILD property rather than a language one, at 999 in older
 * builds and 32766 since 3.32, and this package must not assume which one the driver shipped with.
 * So the candidate list is split, and the split size is small enough to be safe under either.
 * Splitting costs one extra statement per 500 ids while the term it replaces was the entire table,
 * so the ceiling here is a correctness guard rather than a tuning knob.
 */
export const PENDING_SCAN_ID_BATCH = 500

/**
 * Pending chunks embedded and persisted per `embedMissing` slice.
 *
 * Ten of `@memhtml/llm`'s 96-text Bedrock batches. Large enough that the per-slice SQLite
 * transaction is noise against ten model round trips; small enough that a throttled pass on a
 * multi-thousand-chunk corpus keeps most of what it paid for. The unit of loss on failure is one
 * slice, not the whole pass.
 */
export const EMBED_PERSIST_SLICE = 960

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
   * Apply a projection pass's writes. The FTS index maintains itself through its triggers.
   *
   * There is no drop/rebuild bracket around a bulk pass, because FTS5 writes are linear and do not
   * accumulate. Probed 2026-08-12 on node 24.19.0, six consecutive 256-op update batches against a
   * constant 10k-file store cost 6, 5, 6, 5, 5, 5 ms. Inserting a whole store through the live index
   * costs 20 ms at 800 files, 101 ms at 5k, 234 ms at 10k. Beside the thousands of Bedrock
   * embedding calls a bulk pass makes, that is not a number worth bracketing for, and a bracket
   * would open a window where a crash leaves the store with no lexical index.
   */
  const applyProjectionWrites = (writes: ReadonlyArray<Write>) => applyWrites(writes)

  /**
   * Parse and project one file. A parse failure yields the reason instead of failing the pass. A
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
  const readState = () => readIndexState(db)

  /**
   * Fail when the stored vector space is not the configured one.
   *
   * Checked before any write, so an index built under one model can never accumulate rows under
   * another. `rebuild --embed` is the one caller that does NOT consult this, because it empties
   * `embeddings` and records the configured space before any vector is written — see
   * {@link EmbedModelMismatch} and {@link truncateForRebuild}.
   */
  const guardEmbedModel = () =>
    Effect.gen(function* () {
      const state = yield* readState()
      if (state !== undefined && state.embed_model !== deps.embedWatermark) {
        return yield* Effect.fail(new EmbedModelMismatch(state.embed_model, deps.embedWatermark))
      }
    })

  /**
   * Empty every memory table and clear the watermark, in ONE transaction, before a rebuild
   * repopulates.
   *
   * Atomic with the truncate on purpose: `index_state.head_sha` is NULL for exactly as long as the
   * tables are half-populated, which is what makes {@link IndexStale} detectable. A failure inside
   * this transaction leaves the previous index whole; a failure after it commits and before the
   * projections land leaves the row `update` refuses to diff from.
   *
   * The configured vector space is recorded here too, and that is what makes `--embed` the migration
   * path: `embeddings` is emptied and the new space is on the row before any vector is written, so
   * the store never carries two spaces at once.
   */
  const truncateForRebuild = () => {
    const at = deps.now()
    return db.writeAll([
      {
        sql: `INSERT INTO index_state (id, head_sha, embed_model, embed_dim, rebuilt_at, updated_at)
              VALUES (?, NULL, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET head_sha = NULL, embed_model = excluded.embed_model,
                embed_dim = excluded.embed_dim, updated_at = excluded.updated_at`,
        params: [INDEX_STATE_ID, deps.embedWatermark, deps.embedDim, at, at]
      },
      /** Children before parents. Correct with foreign keys enforced, not merely via cascade. */
      ...MEMORY_TABLES.map((table) => ({ sql: `DELETE FROM ${table}`, params: [] }))
    ])
  }

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
   * The chunks with no current vector, either the whole table or only the candidates named.
   *
   * The two branches ask the same predicate of different row sets, which is what makes the scoped
   * form a cost optimization rather than a semantic change. The unscoped form is unavoidably a full
   * table scan. `e.model <> ?` cannot use the `embeddings(model)` index because it must also match
   * the rows where `e.model` is NULL from the LEFT JOIN, and that disjunct is the model migration's
   * whole purpose. Measured linear at 11 ms for 1k chunks and 60 ms at 10k (probe, 2026-08-06).
   * Paying it once per rebuild is right. Paying it once per incremental batch is the store-scaled
   * term that made bulk ingest quadratic in fact count.
   *
   * Candidate ids are BOUND, never interpolated. They are internal sha256 hex and could not carry a
   * quote, but a query assembled by concatenation is one refactor away from being handed something
   * that can, and the binding costs nothing.
   */
  const pendingChunks = (candidateChunkIds: ReadonlyArray<string> | undefined) =>
    Effect.gen(function* () {
      const select = `SELECT c.chunk_id AS chunk_id, c.text AS text
         FROM chunks c
         LEFT JOIN embeddings e ON e.chunk_id = c.chunk_id`
      /**
       * Parenthesized, and that is not cosmetic. SQL binds `AND` tighter than `OR`, so appending
       * `AND c.chunk_id IN (…)` to a bare `e.chunk_id IS NULL OR e.model <> ?` parses as
       * `IS NULL OR (model <> ? AND IN (…))`. The vector-less disjunct escapes the scoping and the
       * statement silently reads the whole table again. The candidate-list test is what holds it:
       * unparenthesized, a one-chunk batch embeds every vector-less chunk in the store.
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
       * Deduped, because one batch can project the same chunk id twice. A file committed and then
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
   * Keyed on `chunk_id`, which keys on `content_hash`, so a `git mv` finds the vector already
   * present and issues zero Bedrock calls, and `--no-embed` followed by `embedMissing()` backfills
   * exactly the gap.
   *
   * A model failure is not fatal here. The lexical floor is a working index, and declining to leave
   * the embed lane partially filled would mean a throttled Bedrock turns a complete FTS index into no
   * index at all. That costs something under a candidate list. A chunk whose embed call failed is no
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
       * SQLite, and a pass that projected no chunks has provably no embed work, so
       * the cheapest correct answer is to not ask.
       */
      const candidateChunkIds = options?.candidateChunkIds
      if (candidateChunkIds !== undefined && candidateChunkIds.length === 0) return 0

      const pending = yield* pendingChunks(candidateChunkIds)
      if (pending.length === 0) return 0

      /**
       * Embed and persist in SLICES rather than one all-or-nothing pass. Vectors key on chunk_id
       * (that is, on content hash), so every slice that lands is progress the next invocation
       * does not re-pay for. That is what lets a store larger than one Bedrock throttle window
       * finish at all: an all-or-nothing pass re-embeds from zero on every retry, fails partway, and
       * writes nothing. Measured on a 4,219-chunk import (2026-08-16): five consecutive
       * `rebuild --embed` runs failed whole where a sliced backfill finished in one pass.
       *
       * A slice that fails stops the pass (the throttle that killed it will kill the next slice
       * too) and reports what already landed. The caller re-runs; `pendingChunks` finds only the
       * remainder.
       */
      const sliceSize = deps.embedPersistEvery ?? EMBED_PERSIST_SLICE
      let written = 0
      for (let start = 0; start < pending.length; start += sliceSize) {
        const slice = pending.slice(start, start + sliceSize)
        const vectors = yield* embeddings.embed(slice.map((row) => row.text)).pipe(
          Effect.tapError((error) =>
            Effect.logError(
              `indexer.embed stopped after ${written} of ${pending.length} chunks (${error.reason}); the written vectors are kept, re-run to continue`
            )
          ),
          Effect.result
        )
        if (vectors._tag === "Failure") return written

        const at = deps.now()
        const writes = slice.flatMap((row, at_) => {
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
        written += writes.length
      }
      return written
    }).pipe(Effect.withSpan("indexer.embedMissing"))

  const rebuild = (opts: { readonly embed: boolean }) =>
    Effect.gen(function* () {
      /**
       * `--embed` passes where the guard refuses, and that is the vector-space migration: the
       * truncate below empties `embeddings` and records the configured space before any vector is
       * written, so no pass can mix two spaces. `--no-embed` still refuses, because it would leave
       * the recorded space with no vectors under it while the published remedy
       * (`memhtml index rebuild --embed`) went unrun.
       */
      if (!opts.embed) yield* guardEmbedModel()
      const headSha = yield* git.revParseHead()
      const entries = (yield* git.lsTreeR(headSha, TREE_PREFIXES)).filter((entry) =>
        isIndexablePath(entry.path)
      )
      const blobs = yield* git.catFileBatch(entries.map((entry) => entry.blobSha))

      /** Every read above happens first, so a git failure cannot leave the index truncated. */
      yield* truncateForRebuild()

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

      /**
       * The lexical index needs no attention here. The `DELETE FROM files` above unindexed every row
       * through the delete trigger and these writes index every new one through the insert trigger.
       * A rebuild does not drop and recreate it. See {@link applyProjectionWrites} for the numbers
       * that make a bracket not worth the window it opens.
       */
      yield* applyWrites(projections.flatMap((projection) => projection.writes))
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
   * For a path that LEFT the corpus: deleted from the tree, or renamed to a destination
   * `isIndexablePath` refuses, where there is no destination row for the memory to become. A rename
   * that STAYS in the corpus goes through {@link movePath} instead, because this call would destroy
   * the embedding the content-keyed chunk row exists to preserve.
   *
   * `edges` is cleared by `src_path` only, for the same reason the projection is. An inbound edge is
   * another file's authored assertion.
   */
  const deletePath = (path: string): ReadonlyArray<Write> => [
    { sql: "DELETE FROM edges WHERE src_path = ?", params: [path] },
    { sql: "DELETE FROM files WHERE path = ?", params: [path] }
  ]

  /**
   * Re-point one path's rows at a new path, keeping the embedding.
   *
   * This is the archive move and every rename, the case `diff -M` reports as `R100`. It is an
   * `UPDATE`, not a delete plus an insert, and the distinction is the whole reason `chunks` keys on
   * `content_hash`. `DELETE FROM files WHERE path = <source>` cascades to the source's chunk rows,
   * and `embeddings.chunk_id` cascades from THOSE, so a delete-and-re-add loses the vector and the
   * next embed pass pays Bedrock again for text that did not change.
   *
   * Every child table declares `ON UPDATE CASCADE`, so one `UPDATE` on `files.path` carries the
   * tags, entities, facets, citations, and chunks with it. The `edges` row is updated explicitly
   * because it holds no foreign key. A `<link>` may name a file the indexer has not reached, so a
   * hard FK there would make indexing order-dependent.
   *
   * The caller re-projects the destination immediately afterwards, in the same batch, which is what
   * picks up the `memhtml-status`/`memhtml-archived` stamps the move added. That re-projection's `files`
   * upsert then hits the row this `UPDATE` just moved, and its chunk upsert hits the same
   * `chunk_id`s. `ON CONFLICT` absorbs both.
   *
   * The two guarded `DELETE`s make the move total over a destination row that ALREADY exists. A bare
   * `UPDATE files SET path = <to>` against a live `<to>` row is a primary-key violation, and it fails
   * the whole pass and every pass after it until a rebuild, because the watermark never advances past
   * the diff that carries the rename. The SOURCE row retires in that case rather than the
   * destination: `chunks` keys on `content_hash` and its rows carry ONE path, and in a store holding
   * both the chunk row and its vector sit under `<to>` — the path the tree agrees with. Guarded on
   * the DESTINATION's existence, so the ordinary rename is two no-op deletes and the two `UPDATE`s.
   */
  const movePath = (from: string, to: string): ReadonlyArray<Write> => {
    const moving = "EXISTS (SELECT 1 FROM files WHERE path = ?2)"
    return [
      { sql: `DELETE FROM edges WHERE src_path = ?1 AND ${moving}`, params: [from, to] },
      { sql: `DELETE FROM files WHERE path = ?1 AND ${moving}`, params: [from, to] },
      { sql: "UPDATE files SET path = ?1 WHERE path = ?2", params: [to, from] },
      { sql: "UPDATE edges SET src_path = ?1 WHERE src_path = ?2", params: [to, from] }
    ]
  }

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

  const update = (opts: { readonly embed: boolean }) =>
    Effect.gen(function* () {
      yield* guardEmbedModel()
      const headSha = yield* git.revParseHead()
      const state = yield* readState()

      /** No row means no index. Falling through to a diff would index the delta of nothing. */
      if (state === undefined) {
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

      /**
       * A row with no commit on it is a rebuild that died between its truncate and its watermark
       * write. There is nothing to diff from and the tables hold whatever the interrupted pass got
       * to, so refusing is the only answer that does not report a half-index as agreeing with the
       * tree. See {@link IndexStale}.
       */
      if (state.head_sha === null) {
        return yield* Effect.fail(
          new IndexStale("a rebuild emptied the index and did not finish repopulating it")
        )
      }
      const watermark = state.head_sha

      /**
       * Both filters admit an entry whose SOURCE is a memory even when its destination is not.
       * A rename out of the corpus has to reach the loops below, because it retires an indexed row;
       * dropping it here would leave that row active at a path no rebuild would ever project.
       */
      const admits = (entry: { readonly path: string; readonly fromPath?: string | undefined }) =>
        isIndexablePath(entry.path) || isIndexablePath(entry.fromPath ?? "")
      const diffs =
        watermark === headSha ? [] : (yield* git.diffNameStatus(watermark, headSha)).filter(admits)
      const status = (yield* git.statusPorcelainV2()).filter(admits)

      /**
       * Every committed diff target's blob, read in TWO subprocesses rather than two PER FILE.
       *
       * A per-file `lsTreeR(ref, [path])` walks the whole tree to answer one path, and
       * `catFileBatch([sha])` spawns a process to read one blob, so a batch of N writes cost
       * 2N tree walks. That is the store-scaled per-op term that made bulk ingest quadratic
       * (probed 2026-08-05: 49 ms per walk at 10k files, 25 s of a 48 s update at N=256).
       * One full-tree walk costs the same as one single-path walk, because git walks the tree
       * either way, so batching is strictly cheaper from the second changed file on.
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
       * Every chunk id this pass projected, the exact set the embed lane may need to fill.
       *
       * Complete for this path, and that completeness rests on `chunk_id` being content-derived
       * (`sha256(content_hash + ":" + ordinal)`). A deletion cascades its chunks and their vectors
       * away through `chunks.path REFERENCES files(path) ON DELETE CASCADE` and
       * `embeddings.chunk_id REFERENCES chunks(chunk_id) ON DELETE CASCADE`, so it creates no pending
       * work. A rename is an `UPDATE files.path` carried by `ON UPDATE CASCADE`, which keeps the
       * chunk row AND its vector, and the destination is re-projected in this same loop, so its ids
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
          /**
           * A rename OUT of the corpus retires the source instead of moving it. `movePath` would
           * re-point the row at a destination the projection then skips, leaving it active at a path
           * a rebuild would never produce — the state that makes the two paths disagree.
           */
          if (!isIndexablePath(diff.path)) {
            writes.push(...deletePath(diff.fromPath))
            removed += 1
            continue
          }
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
          /** A staged rename whose destination is then gone retires BOTH sides of the move. */
          if (entry.fromPath !== undefined) writes.push(...deletePath(entry.fromPath))
          removed += 1
          continue
        }
        /**
         * A STAGED rename is one porcelain-v2 record carrying both paths, and the source has to
         * retire in the same pass. Leaving it live makes the destination's projection collide with it
         * on `files_content_hash_active` — the two paths hold identical bodies until one is edited —
         * which fails the whole update rather than one file.
         */
        if (entry.fromPath !== undefined && entry.fromPath !== entry.path) {
          if (isIndexablePath(entry.path)) {
            writes.push(...movePath(entry.fromPath, entry.path))
            renamed += 1
          } else {
            writes.push(...deletePath(entry.fromPath))
            removed += 1
            continue
          }
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

      yield* applyProjectionWrites(writes)
      yield* writeState(headSha, false)
      /**
       * Scoped to this pass's own chunks, which is what keeps an incremental update's cost flat in
       * store size. The unscoped scan is a full `chunks` table read, at 11 ms for 1k chunks and
       * 60 ms at 10k (probed 2026-08-05), and one of those per batch is a store-scaled term in a
       * per-write path — the shape that makes bulk ingest quadratic in fact count.
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

  return { rebuild, update, embedMissing }
}

const countEdges = (db: DatabaseShape) =>
  db.get<{ n: number }>("SELECT count(*) AS n FROM edges").pipe(Effect.map((row) => row?.n ?? 0))

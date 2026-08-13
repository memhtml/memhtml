/**
 * The `index_state` watermark row. One schema, one query, one decode.
 *
 * The table holds exactly one row by CHECK, and three call sites across two packages read it: the
 * indexer's model guard, `memhtml index status`, and `memhtml doctor`. Each used to restate the
 * column list as a bare type parameter over a hand-written SELECT, so one table's shape was
 * transcribed three times in three different subsets, with nothing that would fail if they
 * disagreed with each other or with `0007_watermark.sql`.
 *
 * The row is decoded rather than cast, which is what makes the single declaration authoritative.
 * `onExcessProperty: "error"` means a column added to the SELECT without being added here is a
 * decode failure, not a silently ignored field. Probed 2026-08-12 on node 24.19.0: `node:sqlite`
 * hands back null-prototype records and `Schema.decodeUnknownEffect` reads them correctly, so the
 * driver's row objects need no normalisation at this seam.
 */

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect, Schema } from "effect"

import type { DatabaseShape } from "./database.js"
import { INDEX_STATE_ID } from "./schema-const.js"

/**
 * Every column of `index_state`, in the order `0007_watermark.sql` declares them.
 *
 * `head_sha` is the only nullable one. It is NULL until the first rebuild records a commit, which is
 * how "never indexed" is distinguished from "indexed at some commit". `embed_model` carries
 * `<model-id>@<dim>` (`@memhtml/llm`'s `EMBED_WATERMARK`), and `embed_dim` restates the dimension as
 * a number so a mismatch is comparable without parsing the watermark string.
 *
 * `embed_dim` is `Int` rather than `Number` because the two guards divide the work. The column's own
 * `CHECK (embed_dim > 0)` owns the RANGE, and SQLite enforces it, so no row can carry a
 * non-positive dimension. SQLite does not enforce the TYPE. Probed 2026-08-12, INTEGER
 * affinity stores `'12.5'` as the real `12.5` and accepts it, and a fractional vector dimension is
 * meaningless. `Int` is the half the database cannot state.
 */
export const IndexStateRow = Schema.Struct({
  id: Schema.Int,
  head_sha: Schema.NullOr(Schema.String),
  embed_model: Schema.String,
  embed_dim: Schema.Int,
  rebuilt_at: Schema.String,
  updated_at: Schema.String
})

export type IndexStateRow = typeof IndexStateRow.Type

/** The column list, derived from the schema so the SELECT cannot drift from what decodes it. */
const COLUMNS = Object.keys(IndexStateRow.fields).join(", ")

const SELECT_STATE = `SELECT ${COLUMNS} FROM index_state WHERE id = ?`

const decodeRow = Schema.decodeUnknownEffect(IndexStateRow, { onExcessProperty: "error" })

/**
 * Read the watermark row, or `undefined` before the first rebuild.
 *
 * A malformed row becomes a `StorageFailure` rather than a schema error crossing the port. Callers
 * already handle that channel, and a row this table cannot produce is a storage problem from every
 * caller's point of view. Whether an absent row is an error is the CALLER's policy. The indexer
 * declines to write against a missing watermark, while the two report paths render it as "not yet
 * indexed", so this returns `undefined` and decides nothing.
 */
export const readIndexState = (
  db: DatabaseShape
): Effect.Effect<IndexStateRow | undefined, StorageFailure> =>
  db
    .get<unknown>(SELECT_STATE, [INDEX_STATE_ID])
    .pipe(
      Effect.flatMap((row) =>
        row === undefined
          ? Effect.succeed(undefined)
          : decodeRow(row).pipe(
              Effect.mapError(() => StorageFailure.make({ operation: "index_state.decode" }))
            )
      )
    )

import type { StorageFailure } from "@memhtml/contracts/errors"
import type { Effect } from "effect"

import type { DatabaseShape } from "./database.js"
import { STATE_SCHEMA } from "./schema-const.js"

/**
 * The state plane's committed sidecar, `.memhtml/state/access.jsonl`: the rows it holds and the bytes
 * it is written as.
 *
 * This is the only durability the state plane has. `state.db` is gitignored and is NOT rebuildable
 * from git, because access counts, reinforcement counts, and the outcome EWMA are the one set of facts
 * the tree cannot reproduce. A fresh clone plus `memhtml state import` plus `memhtml index rebuild`
 * reproduces the whole system only because this file is committed.
 *
 * **Byte-stable or it commits nothing.** Rows arrive path-ordered from SQL, floats are rounded to four
 * decimals, and the keys are written in a fixed order, so an unchanged plane produces an identical file
 * and `memhtml state export` commits nothing. Without that, the widest-churn table in the system would
 * produce a commit every time the sidecar was refreshed, whether or not anything was read.
 *
 * Four decimals because that is the grid the outcome EWMA lives on. `@memhtml/domain`'s fixed-point scale
 * is 10^4, so a fourth-decimal value is exact on the grid and a fifth-decimal digit would be float
 * noise that changes the file's bytes without changing its meaning.
 */

/** One path's durable access bookkeeping. Absent from the result means it was not accessed. */
export interface AccessRow {
  readonly path: string
  readonly access_count: number
  readonly reinforcement_count: number
  readonly outcome_score: number
  readonly last_accessed_at: string | null
  readonly last_reinforced_at: string | null
  readonly updated_at: string
}

/**
 * The whole `state.access` table, path-ordered.
 *
 * Ordered in SQL instead of sorted afterwards so the sidecar is byte-stable. Two exports over an
 * unchanged plane produce an identical file and therefore no commit.
 */
export const accessRows = (
  db: DatabaseShape
): Effect.Effect<ReadonlyArray<AccessRow>, StorageFailure> =>
  db.hasState
    ? db.all<AccessRow>(
        `SELECT path, access_count, reinforcement_count, outcome_score,
                last_accessed_at, last_reinforced_at, updated_at
         FROM ${STATE_SCHEMA}.access ORDER BY path ASC`
      )
    : db.all<AccessRow>("SELECT NULL AS path WHERE 0")

/** Decimal places every float in the sidecar carries. Matches the domain's fixed-point grid. */
export const SIDECAR_PRECISION = 4

/** One sidecar line's fields, in the order they are written. */
export interface SidecarEntry {
  readonly path: string
  readonly accessCount: number
  readonly reinforcementCount: number
  readonly outcomeScore: number
  readonly lastAccessedAt: string | null
  readonly lastReinforcedAt: string | null
  readonly updatedAt: string
}

/** Round to the sidecar's grid. `-0` is normalized to `0` so two equal planes render identically. */
export const round4 = (value: number): number => {
  const factor = 10 ** SIDECAR_PRECISION
  const rounded = Math.round(value * factor) / factor
  return rounded === 0 ? 0 : rounded
}

/** One `state.access` row as a sidecar entry. */
export const toSidecarEntry = (row: AccessRow): SidecarEntry => ({
  path: row.path,
  accessCount: row.access_count,
  reinforcementCount: row.reinforcement_count,
  outcomeScore: round4(row.outcome_score),
  lastAccessedAt: row.last_accessed_at,
  lastReinforcedAt: row.last_reinforced_at,
  updatedAt: row.updated_at
})

/**
 * The whole sidecar as bytes: one JSON object per line, path-ordered, trailing newline.
 *
 * JSONL, not one JSON array, so the file appends cleanly and a partial write costs one row
 * instead of the whole plane. `git diff` on it also reads as one line per changed memory.
 */
export const renderSidecar = (rows: ReadonlyArray<AccessRow>): string =>
  rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(toSidecarEntry(row))).join("\n")}\n`

/**
 * Parse a sidecar back into entries, for `memhtml state import`.
 *
 * Defensive per line: an unparseable line is skipped and counted instead of failing the import. The
 * sidecar is the only durable copy of this plane, so a file truncated by an interrupted write must
 * restore every row it does hold. Refusing the whole file would turn a partial loss into a total one.
 */
export const parseSidecar = (
  contents: string
): { readonly entries: ReadonlyArray<SidecarEntry>; readonly skipped: number } => {
  const entries: Array<SidecarEntry> = []
  let skipped = 0
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as Partial<SidecarEntry>
      if (typeof parsed.path !== "string" || parsed.path === "") {
        skipped += 1
        continue
      }
      entries.push({
        path: parsed.path,
        accessCount: numberOr(parsed.accessCount, 0),
        reinforcementCount: numberOr(parsed.reinforcementCount, 0),
        outcomeScore: round4(numberOr(parsed.outcomeScore, 0)),
        lastAccessedAt: typeof parsed.lastAccessedAt === "string" ? parsed.lastAccessedAt : null,
        lastReinforcedAt:
          typeof parsed.lastReinforcedAt === "string" ? parsed.lastReinforcedAt : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
      })
    } catch {
      skipped += 1
    }
  }
  return { entries, skipped }
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

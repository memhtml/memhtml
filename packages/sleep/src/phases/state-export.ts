import { STATE_SIDECAR_PATH } from "@memhtml/store"
import { Effect } from "effect"

import { commitPhase } from "../commit.js"
import { readFileBytes, writeFileBytes } from "../edits.js"
import { emptyOutcome, type PhaseBody } from "../env.js"
import { type AccessRow, accessRows } from "../sql.js"

/**
 * Phase 14, state export. Write `.memhtml/state/access.jsonl` and commit it.
 *
 * This is the only durability the state plane has. `state.db` is gitignored and is NOT
 * rebuildable from git, because access counts, reinforcement counts, and the outcome EWMA are the one
 * set of facts the tree cannot reproduce. A fresh clone plus `memhtml state import` plus `memhtml index rebuild`
 * reproduces the whole system only because this file is committed.
 *
 * **Byte-stable or it commits nothing.** Rows arrive path-ordered from SQL, floats are rounded to four
 * decimals, and the keys are written in a fixed order, so an unchanged plane produces an identical file
 * and the phase's commit is empty. Without that, the widest-churn table in the system would produce a
 * commit every single night whether or not anything was read.
 *
 * Four decimals because that is the grid the outcome EWMA lives on. `@memhtml/domain`'s fixed-point scale
 * is 10^4, so a fourth-decimal value is exact on the grid and a fifth-decimal digit would be float
 * noise that changes the file's bytes without changing its meaning.
 */

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

export const stateExport: PhaseBody = (env) =>
  Effect.gen(function* () {
    const rows = yield* accessRows(env.deps.db)
    const contents = renderSidecar(rows)
    const counts = { rows: rows.length, bytes: contents.length, written: 0 }
    if (env.dryRun) return emptyOutcome({ ...counts, written: rows.length === 0 ? 0 : 1 })

    const existing = yield* readFileBytes(env, STATE_SIDECAR_PATH)
    if (existing === contents) return emptyOutcome(counts)

    yield* writeFileBytes(env, STATE_SIDECAR_PATH, contents)
    yield* env.deps.git.add([STATE_SIDECAR_PATH])
    const final = { ...counts, written: 1 }
    const commitSha = yield* commitPhase(
      env,
      "state-export",
      `export ${rows.length} access rows to the committed sidecar`,
      final
    )
    return { counts: final, commitSha, llmCalls: 0 }
  })

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

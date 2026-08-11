import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { DatabaseService, STATE_SCHEMA } from "@memhtml/index"
import { accessRows, parseSidecar, renderSidecar } from "@memhtml/sleep"
import { attemptIo, commitSubject, readFileOrNull, STATE_SIDECAR_PATH } from "@memhtml/store"
import { Effect } from "effect"

import { Git } from "./api-layer.js"

/**
 * `memhtml state export|import`: the state plane's only durability story.
 *
 * `state.db` is gitignored and is NOT rebuildable from git — access counts, reinforcement counts, and
 * the outcome EWMA are the one set of facts the tree cannot reproduce. `.memhtml/state/access.jsonl` is
 * the committed sidecar that survives, so a fresh clone plus `memhtml state import` plus
 * `memhtml index rebuild` reproduces the whole system rather than a system with amnesia.
 *
 * Both halves reuse `@memhtml/sleep`'s own functions — `renderSidecar` for the export, `parseSidecar` for
 * the import — because the sleep cycle's state-export phase writes this file every night and two
 * writers producing two byte sequences for one plane would churn the file on alternating nights. The
 * only difference between this command and that phase is which commit the result lands in.
 */

/** What an export wrote. `written: false` means the sidecar already matched the plane. */
export interface StateExportReport {
  readonly path: string
  readonly rows: number
  readonly bytes: number
  readonly written: boolean
  readonly commitSha: string | null
}

/** What an import restored. */
export interface StateImportReport {
  readonly path: string
  /** Rows the sidecar held. */
  readonly rows: number
  /** Rows actually written into `state.access`. */
  readonly restored: number
  /** Sidecar lines that did not parse. Counted, never fatal — a partial file restores what it holds. */
  readonly skipped: number
  readonly hasState: boolean
}

/**
 * Write the sidecar and commit it.
 *
 * Byte-stable or it commits nothing: rows arrive path-ordered from SQL and floats are rounded to the
 * domain's four-decimal grid, so an unchanged plane produces an identical file and `git commit`
 * no-ops on an index matching HEAD. Without that, the widest-churn table in the system would produce
 * a commit every time an operator ran this.
 */
export const stateExport = () =>
  Effect.gen(function* () {
    const git = yield* Git
    const db = yield* DatabaseService
    const rows = yield* accessRows(db)
    const contents = renderSidecar(rows)
    const absolute = join(git.root, STATE_SIDECAR_PATH)

    const existing = yield* readFileOrNull(absolute).pipe(Effect.orElseSucceed(() => null))
    if (existing === contents) {
      return {
        path: STATE_SIDECAR_PATH,
        rows: rows.length,
        bytes: contents.length,
        written: false,
        commitSha: null
      } satisfies StateExportReport
    }

    yield* attemptIo(`state.write:${STATE_SIDECAR_PATH}`, async () => {
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, contents, "utf8")
    })
    yield* git.add([STATE_SIDECAR_PATH])
    const commit = yield* git.commit(
      commitSubject("state", `export ${rows.length} access rows to the committed sidecar`)
    )

    return {
      path: STATE_SIDECAR_PATH,
      rows: rows.length,
      bytes: contents.length,
      written: true,
      commitSha: commit.sha
    } satisfies StateExportReport
  })

/**
 * Replay the sidecar into `state.access`.
 *
 * An upsert per row rather than a truncate-and-load: an import onto a live plane must not discard
 * counters the sidecar predates — the sidecar is refreshed once per night and a retrieval an hour
 * later is real state. The upsert takes the MAXIMUM of the two counts for the same reason design §9's
 * multi-machine note gives: these columns are monotone, so max-of is the merge that cannot lose a
 * bump, while last-writer-wins can.
 *
 * `parseSidecar` is defensive per line, so a file truncated by an interrupted write restores every row
 * it does hold — refusing the whole file would turn a partial loss into a total one.
 */
export const stateImport = () =>
  Effect.gen(function* () {
    const git = yield* Git
    const db = yield* DatabaseService
    const absolute = join(git.root, STATE_SIDECAR_PATH)
    const contents = yield* readFileOrNull(absolute).pipe(Effect.orElseSucceed(() => null))

    if (contents === null) {
      return {
        path: STATE_SIDECAR_PATH,
        rows: 0,
        restored: 0,
        skipped: 0,
        hasState: db.hasState
      } satisfies StateImportReport
    }

    const { entries, skipped } = parseSidecar(contents)
    if (!db.hasState || entries.length === 0) {
      return {
        path: STATE_SIDECAR_PATH,
        rows: entries.length,
        restored: 0,
        skipped,
        hasState: db.hasState
      } satisfies StateImportReport
    }

    yield* db.writeAll(
      entries.map((entry) => ({
        sql: `INSERT INTO ${STATE_SCHEMA}.access
                (path, access_count, reinforcement_count, outcome_score,
                 last_accessed_at, last_reinforced_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                access_count = max(access_count, excluded.access_count),
                reinforcement_count = max(reinforcement_count, excluded.reinforcement_count),
                outcome_score = excluded.outcome_score,
                last_accessed_at = max(coalesce(last_accessed_at, ''), coalesce(excluded.last_accessed_at, '')),
                last_reinforced_at = max(coalesce(last_reinforced_at, ''), coalesce(excluded.last_reinforced_at, '')),
                updated_at = excluded.updated_at`,
        params: [
          entry.path,
          entry.accessCount,
          entry.reinforcementCount,
          entry.outcomeScore,
          entry.lastAccessedAt,
          entry.lastReinforcedAt,
          entry.updatedAt
        ]
      }))
    )

    return {
      path: STATE_SIDECAR_PATH,
      rows: entries.length,
      restored: entries.length,
      skipped,
      hasState: true
    } satisfies StateImportReport
  })

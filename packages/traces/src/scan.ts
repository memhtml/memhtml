import type { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

import { discoverSessions, type SessionFile, sidecarAgentIds } from "./discover.js"
import { agentCountFor, type PromptRow, type SessionExtract } from "./extract.js"
import { parseSessionFile } from "./parse.js"
import {
  advanceWatermark,
  type Watermark,
  type WatermarkAction,
  watermarkPlan
} from "./watermark.js"

/**
 * The scan composes discovery, the watermark decision, and extraction into the unit the indexer
 * persists. Persistence itself belongs to `@memhtml/index`'s trace persister. This module reads a
 * watermark through a callback and hands back the new one, so it stays free of SQL and testable
 * against an in-memory map.
 */

/** Reads a file's stored watermark. `null` for a file never scanned. */
export type WatermarkReader = (filePath: string) => Effect.Effect<Watermark | null, StorageFailure>

/** One file's outcome, whether or not it was read. */
export interface ScannedFile {
  readonly file: SessionFile
  readonly action: WatermarkAction
  /**
   * Absent for a `skip`, because a skipped file is not opened and yields no extract. Also absent
   * when the read failed, so a persister writes nothing for the file and the next run retries it.
   */
  readonly extract: SessionExtract | null
  /**
   * `agent_count` for the `traces` row: this file's distinct `agentId`s unioned with the sidecar
   * filenames of its session. `0` for a skipped or unreadable file.
   */
  readonly agentCount: number
  /**
   * The watermark to store. Unchanged from the previous one for a `skip` and for a failed read,
   * because a failed read consumed nothing and advancing past the stored offset would make the
   * next run's size+mtime comparison skip a transcript nobody has read.
   */
  readonly watermark: Watermark
}

/**
 * A whole scan: per-file outcomes plus the totals an operator reads.
 *
 * The four action counters PARTITION `files`: `skipped + tailed + rescanned + failed` is exactly
 * `files.length`. That is why a failed read counts here and nowhere else — counting it as `tailed`
 * would report a transcript as read when its rows were never extracted, and a scan whose numbers
 * add up is the only way an operator can tell a quiet night from a broken one.
 */
export interface ScanReport {
  readonly files: ReadonlyArray<ScannedFile>
  readonly skipped: number
  /** Files read from their recorded offset forward, and read successfully. */
  readonly tailed: number
  /** Files read from byte zero, and read successfully. */
  readonly rescanned: number
  /**
   * Files the scan planned to read and could not: an absent file, a permission rejection, a
   * transient IO error. Each holds its stored watermark, so the next run retries it.
   */
  readonly failed: number
  /** Bytes actually read. The number the incremental design exists to keep small. */
  readonly bytesRead: number
}

/**
 * The watermark for a file whose first-ever read failed: there is no stored one to preserve, and
 * this one can never be mistaken for a completed scan. All-zero compares unequal to any real stat
 * (a zero mtime is 1970), so `watermarkPlan` rescans, which is exactly a retry. A persister that
 * writes nothing for a null extract never stores it anyway.
 */
const NEVER_SCANNED: Watermark = { size: 0, mtimeMs: 0, byteOff: 0 }

/**
 * Scan every transcript under `traceRoot`, reading only what the watermarks say changed.
 *
 * `traceRoot` is a parameter. `~/.claude` is the caller's default rather than this module's
 * constant, so the whole scan is drivable against a fixture tree.
 *
 * Files are processed sequentially. Concurrency here would trade a bounded, predictable IO profile
 * for contention with the live process that is *writing* these transcripts, and the incremental
 * watermark has already reduced a daily run to the handful of files that changed.
 */
export const scanTraceRoot = (
  traceRoot: string,
  readWatermark: WatermarkReader
): Effect.Effect<ScanReport, StorageFailure> =>
  Effect.gen(function* () {
    const discovered = yield* discoverSessions(traceRoot)
    const scanned: Array<ScannedFile> = []
    let skipped = 0
    let tailed = 0
    let rescanned = 0
    let failed = 0
    let bytesRead = 0

    for (const file of discovered) {
      const previous = yield* readWatermark(file.filePath)
      const plan = watermarkPlan(previous, file)

      // A runtime guard that narrows, not a proof: `plan.action` still includes `"skip"` and
      // `previous` is still `Watermark | null`. Testing both is what makes the watermark pushed
      // below the STORED one rather than a fabricated stand-in — `watermarkPlan` never skips a file
      // it has no watermark for, so reaching the branch with `previous === null` would mean
      // publishing a skip nothing has read.
      if (previous !== null && plan.action === "skip") {
        skipped += 1
        scanned.push({
          file,
          action: "skip",
          extract: null,
          agentCount: 0,
          // A skip means the stored watermark already describes this exact file.
          watermark: previous
        })
        continue
      }

      const result = yield* parseSessionFile(file.filePath, plan.startByte, { slug: file.slug })
      bytesRead += result.bytesRead

      if (result.readFailed) {
        // A failed read consumed nothing, so the stored watermark must survive untouched. Stamping
        // the file's current size and mtime here would make the next run's comparison see an
        // unchanged file and skip a transcript nobody has read. A null extract is what keeps a
        // persister from writing anything for this file, the same way a skip does.
        //
        // It counts as `failed` and NOT as `tailed`/`rescanned`, which is why the counters are
        // incremented after the read rather than from the plan: `plan.action` names what the scan
        // INTENDED, and the report describes what it achieved.
        failed += 1
        scanned.push({
          file,
          action: plan.action,
          extract: null,
          agentCount: 0,
          watermark: previous ?? NEVER_SCANNED
        })
        continue
      }

      if (plan.action === "tail") tailed += 1
      else rescanned += 1

      scanned.push({
        file,
        action: plan.action,
        extract: result.extract,
        agentCount: agentCountFor(result.extract, sidecarAgentIds(discovered, file.sessionId)),
        watermark: advanceWatermark(file, plan.startByte, result.bytesRead)
      })
    }

    yield* Effect.log(
      `traces.scan: ${discovered.length} files (${skipped} skipped, ${tailed} tailed, ${rescanned} rescanned, ${failed} failed), ${bytesRead} bytes read`
    )

    return { files: scanned, skipped, tailed, rescanned, failed, bytesRead }
  }).pipe(Effect.withSpan("traces.scanTraceRoot"))

/**
 * Merge a tail's extract into the session's stored one. **Tails only**, because a rescan's extract
 * already describes the whole file and replaces the stored row outright.
 *
 * The merge exists because a tail's extract describes the *appended slice* and not the session.
 * Its `first_prompt` is a prompt from the middle of the conversation, its `started_at` is an hour
 * after the session began, its `turn_count` counts only new turns, and its prompt ordinals restart
 * at 0. Every field below states which side owns it and why. The producer owns these reading
 * semantics, so an indexer that merged the fields itself would have to rediscover all of it.
 */
export const mergeTailExtract = (stored: SessionExtract, tail: SessionExtract): SessionExtract => {
  const prompts = mergePrompts(stored.prompts, tail.prompts)
  return {
    filePath: tail.filePath,
    slug: tail.slug === "" ? stored.slug : tail.slug,
    // Identity: the older side wins, since these come from the *first* enveloped record.
    sessionId: stored.sessionId ?? tail.sessionId,
    cwd: stored.cwd ?? tail.cwd,
    entrypoint: stored.entrypoint ?? tail.entrypoint,
    // Current state: the newer side wins. A session can change branch, upgrade the CLI mid-run,
    // and switch model, and the row should describe what it is doing now.
    gitBranch: tail.gitBranch ?? stored.gitBranch,
    version: tail.version ?? stored.version,
    model: tail.model ?? stored.model,
    startedAt: earliest(stored.startedAt, tail.startedAt),
    endedAt: latest(stored.endedAt, tail.endedAt),
    // Derived from the merged set instead of summed. A prompt straddling the tail boundary appears
    // in both extracts, so `stored + tail` would count it twice.
    promptCount: prompts.length,
    // Summed: a tail's `turnCount` counts only the records it read.
    turnCount: stored.turnCount + tail.turnCount,
    agentIds: [...new Set([...stored.agentIds, ...tail.agentIds])],
    firstPrompt: stored.firstPrompt === "" ? tail.firstPrompt : stored.firstPrompt,
    aiTitle: tail.aiTitle ?? stored.aiTitle,
    prompts,
    counters: {
      parsedLines: stored.counters.parsedLines + tail.counters.parsedLines,
      droppedLines: stored.counters.droppedLines + tail.counters.droppedLines,
      droppedNoSession: stored.counters.droppedNoSession + tail.counters.droppedNoSession,
      skippedTypeLines: stored.counters.skippedTypeLines + tail.counters.skippedTypeLines,
      unknownTypeLines: stored.counters.unknownTypeLines + tail.counters.unknownTypeLines
    }
  }
}

/**
 * Concatenate two prompt lists into one per-session first-appearance ordering.
 *
 * A tail's ordinals are 0-based over the appended slice, so they are renumbered from the end of the
 * stored list. Without that, every tail would collide with ordinal 0 and `trace_prompts.ordinal`
 * would stop being an order at all. A `promptId` present in both sides keeps its stored ordinal,
 * uuid, and instant, since it began before the tail. It takes the tail's `textHead` only when the
 * stored one is empty, which is how a prompt whose text arrived after the boundary gets indexed.
 */
export const mergePrompts = (
  stored: ReadonlyArray<PromptRow>,
  tail: ReadonlyArray<PromptRow>
): ReadonlyArray<PromptRow> => {
  const merged = new Map<string, PromptRow>()
  for (const row of [...stored].sort((left, right) => left.ordinal - right.ordinal)) {
    merged.set(row.promptId, { ...row, ordinal: merged.size })
  }
  for (const row of [...tail].sort((left, right) => left.ordinal - right.ordinal)) {
    const existing = merged.get(row.promptId)
    if (existing === undefined) {
      merged.set(row.promptId, { ...row, ordinal: merged.size })
      continue
    }
    if (existing.textHead === "" && row.textHead !== "") {
      merged.set(row.promptId, { ...existing, textHead: row.textHead })
    }
  }
  return [...merged.values()]
}

/**
 * Both arguments are canonical ISO-8601 UTC from {@link SessionExtract}, so lexicographic order is
 * chronological order and no re-parse is needed.
 */
const earliest = (left: string | null, right: string | null): string | null =>
  left === null ? right : right === null ? left : left <= right ? left : right

const latest = (left: string | null, right: string | null): string | null =>
  left === null ? right : right === null ? left : left >= right ? left : right

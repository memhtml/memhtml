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
 * persists. Persistence itself belongs to T7. This module reads a watermark through a callback and
 * hands back the new one, so it stays free of SQL and testable against an in-memory map.
 */

/** Reads a file's stored watermark. `null` for a file never scanned. */
export type WatermarkReader = (filePath: string) => Effect.Effect<Watermark | null, StorageFailure>

/** One file's outcome, whether or not it was read. */
export interface ScannedFile {
  readonly file: SessionFile
  readonly action: WatermarkAction
  /** Absent for a `skip`, because a skipped file is not opened and yields no extract. */
  readonly extract: SessionExtract | null
  /**
   * `agent_count` for the `traces` row: this file's distinct `agentId`s unioned with the sidecar
   * filenames of its session. `0` for a skipped file.
   */
  readonly agentCount: number
  /** The watermark to store. Unchanged from the previous one for a `skip`. */
  readonly watermark: Watermark
}

/** A whole scan: per-file outcomes plus the totals an operator reads. */
export interface ScanReport {
  readonly files: ReadonlyArray<ScannedFile>
  readonly skipped: number
  readonly tailed: number
  readonly rescanned: number
  /** Bytes actually read. The number the incremental design exists to keep small. */
  readonly bytesRead: number
}

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
    let bytesRead = 0

    for (const file of discovered) {
      const previous = yield* readWatermark(file.filePath)
      const plan = watermarkPlan(previous, file)

      if (plan.action === "skip") {
        skipped += 1
        scanned.push({
          file,
          action: "skip",
          extract: null,
          agentCount: 0,
          // A skip means the stored watermark already describes this exact file.
          watermark: previous ?? { size: file.size, mtimeMs: file.mtimeMs, byteOff: file.size }
        })
        continue
      }

      if (plan.action === "tail") tailed += 1
      else rescanned += 1

      const result = yield* parseSessionFile(file.filePath, plan.startByte, { slug: file.slug })
      bytesRead += result.bytesRead

      scanned.push({
        file,
        action: plan.action,
        extract: result.extract,
        agentCount: agentCountFor(result.extract, sidecarAgentIds(discovered, file.sessionId)),
        watermark: advanceWatermark(file, plan.startByte, result.bytesRead)
      })
    }

    yield* Effect.log(
      `traces.scan: ${discovered.length} files (${skipped} skipped, ${tailed} tailed, ${rescanned} rescanned), ${bytesRead} bytes read`
    )

    return { files: scanned, skipped, tailed, rescanned, bytesRead }
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

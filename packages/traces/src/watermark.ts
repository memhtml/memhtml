/**
 * The incremental-scan decision, isolated as pure arithmetic over a file's stat.
 *
 * 3.67 GB of session JSONL sits under the trace root and 8 files change on a given day, so the
 * daily job's cost is decided entirely here: a wrong `"tail"` silently loses records, a wrong
 * `"rescan"` re-reads gigabytes. Keeping the decision pure is what lets it be tested at every
 * boundary without a filesystem.
 */

/**
 * What a previous scan recorded about a file, mirroring the `trace_watermarks` row
 * (design §3.3). T7 owns the table; this module owns the arithmetic.
 *
 * - `size` — file length in bytes at scan time.
 * - `mtimeMs` — modification time in **milliseconds since the Unix epoch**, the unit
 *   `node:fs`'s `Stats.mtimeMs` reports. The SQL column stores an ISO-8601 string, so the
 *   adapter converts at the boundary and this type never carries two possible units.
 * - `byteOff` — a **0-based byte offset** into the file: the position one past the last byte
 *   consumed, and therefore the `start` of the next read. Equal to `size` after a complete scan.
 */
export interface Watermark {
  readonly size: number
  readonly mtimeMs: number
  readonly byteOff: number
}

/** A file's current stat, the half of {@link Watermark} the filesystem supplies. */
export interface FileStat {
  readonly size: number
  readonly mtimeMs: number
}

/**
 * - `skip` — nothing changed; do not open the file.
 * - `tail` — the file grew by append; read from {@link WatermarkPlan.startByte}.
 * - `rescan` — the file was rewritten, compacted, or is unknown; read from byte 0.
 */
export type WatermarkAction = "skip" | "tail" | "rescan"

/** An action plus the byte offset to open the read stream at. */
export interface WatermarkPlan {
  readonly action: WatermarkAction
  /** 0-based byte offset to pass as `createReadStream({ start })`. Always 0 for a rescan. */
  readonly startByte: number
}

/**
 * Decide how to read a file given what the last scan recorded.
 *
 * Both size *and* mtime must match to skip. Size alone would miss an in-place rewrite that
 * happens to preserve the length; mtime alone would miss a write inside the same clock tick.
 *
 * A grown file is tailed only when mtime also advanced or held steady. A file that grew while
 * its mtime moved *backward* is not an append — something restored or rewrote it — so it is
 * rescanned. Shrinking is unambiguous: bytes the watermark counted are gone, so any offset into
 * the file is now meaningless.
 *
 * A `byteOff` past the current size is treated as a rescan even when size grew, because that
 * offset could only come from a larger earlier file: the growth is a rewrite that has not yet
 * reached the old length, not an append.
 */
export const watermarkAction = (prev: Watermark | null, curr: FileStat): WatermarkAction =>
  watermarkPlan(prev, curr).action

/** {@link watermarkAction} with the read offset the caller needs. */
export const watermarkPlan = (prev: Watermark | null, curr: FileStat): WatermarkPlan => {
  if (prev === null) return { action: "rescan", startByte: 0 }

  if (curr.size === prev.size && curr.mtimeMs === prev.mtimeMs) {
    return { action: "skip", startByte: prev.byteOff }
  }

  if (curr.size < prev.size) return { action: "rescan", startByte: 0 }
  if (curr.mtimeMs < prev.mtimeMs) return { action: "rescan", startByte: 0 }
  if (prev.byteOff > curr.size) return { action: "rescan", startByte: 0 }

  // Same size with an advanced mtime: touched, or rewritten to an identical length. The offset
  // cannot be trusted to still describe the same bytes.
  if (curr.size === prev.size) return { action: "rescan", startByte: 0 }

  return { action: "tail", startByte: prev.byteOff }
}

/**
 * The watermark to store after a scan consumed `bytesRead` bytes starting at `startByte`.
 * `size`/`mtimeMs` come from the stat taken *before* the read, so a file appended to during the
 * scan compares unequal next time and gets tailed rather than skipped.
 */
export const advanceWatermark = (
  stat: FileStat,
  startByte: number,
  bytesRead: number
): Watermark => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  byteOff: Math.min(startByte + bytesRead, stat.size)
})

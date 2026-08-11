import { describe, expect, it } from "vitest"

import {
  advanceWatermark,
  type Watermark,
  watermarkAction,
  watermarkPlan
} from "../src/watermark.js"

const previous: Watermark = { size: 1_000, mtimeMs: 1_754_000_000_000, byteOff: 1_000 }

describe("watermarkAction", () => {
  it("skips when size and mtime both match", () => {
    expect(watermarkAction(previous, { size: 1_000, mtimeMs: 1_754_000_000_000 })).toBe("skip")
  })

  it("tails from the stored offset when the file grew and mtime advanced", () => {
    const plan = watermarkPlan(previous, { size: 1_400, mtimeMs: 1_754_000_001_000 })
    expect(plan).toEqual({ action: "tail", startByte: 1_000 })
  })

  it("tails from a partial offset, not from the end of the file", () => {
    const partial: Watermark = { size: 1_000, mtimeMs: 1_754_000_000_000, byteOff: 620 }
    const plan = watermarkPlan(partial, { size: 1_400, mtimeMs: 1_754_000_001_000 })
    expect(plan).toEqual({ action: "tail", startByte: 620 })
  })

  it("rescans when the file shrank", () => {
    const plan = watermarkPlan(previous, { size: 400, mtimeMs: 1_754_000_001_000 })
    expect(plan).toEqual({ action: "rescan", startByte: 0 })
  })

  it("rescans when mtime moved backward even though the file grew", () => {
    const plan = watermarkPlan(previous, { size: 1_400, mtimeMs: 1_753_999_999_000 })
    expect(plan).toEqual({ action: "rescan", startByte: 0 })
  })

  it("rescans a file it has never seen", () => {
    expect(watermarkAction(null, { size: 1_400, mtimeMs: 1_754_000_001_000 })).toBe("rescan")
  })

  it("rescans an in-place rewrite that preserved the length", () => {
    // Size alone would call this a skip, which is why both halves of the key are compared.
    expect(watermarkAction(previous, { size: 1_000, mtimeMs: 1_754_000_005_000 })).toBe("rescan")
  })

  it("rescans when the stored offset is past the current size", () => {
    const stale: Watermark = { size: 900, mtimeMs: 1_754_000_000_000, byteOff: 900 }
    const plan = watermarkPlan(stale, { size: 800, mtimeMs: 1_754_000_001_000 })
    expect(plan).toEqual({ action: "rescan", startByte: 0 })
  })

  it("rescans a rewrite that grew past the offset it recorded for a larger earlier file", () => {
    const stale: Watermark = { size: 5_000, mtimeMs: 1_754_000_000_000, byteOff: 5_000 }
    // A compaction to 500 bytes, then growth to 5,200: size is larger than the *offset*, so the
    // arithmetic must not read this as an append.
    const grownAgain: Watermark = { size: 5_000, mtimeMs: 1_754_000_000_000, byteOff: 5_200 }
    expect(watermarkAction(stale, { size: 5_100, mtimeMs: 1_754_000_002_000 })).toBe("tail")
    expect(watermarkAction(grownAgain, { size: 5_100, mtimeMs: 1_754_000_002_000 })).toBe("rescan")
  })

  it("skips on the exact boundary and tails one byte past it", () => {
    expect(watermarkAction(previous, { size: 1_000, mtimeMs: 1_754_000_000_000 })).toBe("skip")
    expect(watermarkAction(previous, { size: 1_001, mtimeMs: 1_754_000_000_000 })).toBe("tail")
    expect(watermarkAction(previous, { size: 999, mtimeMs: 1_754_000_000_000 })).toBe("rescan")
  })

  it("tails when the file grew within the same mtime tick", () => {
    // A write inside the clock's resolution. Size is the only witness, and it moved.
    expect(watermarkAction(previous, { size: 1_400, mtimeMs: 1_754_000_000_000 })).toBe("tail")
  })
})

describe("advanceWatermark", () => {
  it("records the offset the next tail starts at", () => {
    const next = advanceWatermark({ size: 1_400, mtimeMs: 1_754_000_001_000 }, 1_000, 400)
    expect(next).toEqual({ size: 1_400, mtimeMs: 1_754_000_001_000, byteOff: 1_400 })
  })

  it("round-trips into a skip when nothing changed afterwards", () => {
    const stat = { size: 1_400, mtimeMs: 1_754_000_001_000 }
    expect(watermarkAction(advanceWatermark(stat, 0, 1_400), stat)).toBe("skip")
  })

  it("clamps the offset to the file size when a partial line was not consumed", () => {
    // A live append leaves an unterminated tail the scan does not count; the offset must stay a
    // real position in the file rather than run past its end.
    const next = advanceWatermark({ size: 1_400, mtimeMs: 1_754_000_001_000 }, 1_000, 900)
    expect(next.byteOff).toBe(1_400)
  })

  it("leaves the next scan a tail when the scan stopped short of the end", () => {
    const stat = { size: 1_400, mtimeMs: 1_754_000_001_000 }
    const partial = advanceWatermark(stat, 1_000, 200)
    expect(partial.byteOff).toBe(1_200)
    // Same stat, so this is a skip — the file did not change, and the unread bytes are an
    // in-progress record that the *next* append will make readable.
    expect(watermarkAction(partial, stat)).toBe("skip")
    expect(watermarkPlan(partial, { size: 1_500, mtimeMs: 1_754_000_002_000 })).toEqual({
      action: "tail",
      startByte: 1_200
    })
  })
})

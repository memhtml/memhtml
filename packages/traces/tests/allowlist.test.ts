import { describe, expect, it } from "vitest"

import { extractFromText, READ_RECORD_TYPES, SKIP_RECORD_TYPES } from "../src/extract.js"

/**
 * The type allowlist is a design constant, not an implementation detail: it is the list of record
 * types probed against the real corpus, and a type moving between the two lists changes what the
 * index contains. These assertions pin it.
 */
describe("record type allowlist", () => {
  it("never reads a type it also skips", () => {
    const skipped = new Set<string>(SKIP_RECORD_TYPES)
    for (const type of READ_RECORD_TYPES) {
      expect(skipped.has(type)).toBe(false)
    }
  })

  it("skips the two envelope-less file-history types", () => {
    expect(SKIP_RECORD_TYPES).toContain("file-history-snapshot")
    expect(SKIP_RECORD_TYPES).toContain("file-history-delta")
  })

  it("pins the seven read types", () => {
    expect(READ_RECORD_TYPES).toEqual([
      "user",
      "assistant",
      "system",
      "attachment",
      "agent-name",
      "ai-title",
      "pr-link"
    ])
  })

  it("pins the six skipped types", () => {
    expect(SKIP_RECORD_TYPES).toEqual([
      "last-prompt",
      "mode",
      "permission-mode",
      "queue-operation",
      "file-history-snapshot",
      "file-history-delta"
    ])
  })

  it("covers all thirteen types the corpus carries", () => {
    expect(READ_RECORD_TYPES.length + SKIP_RECORD_TYPES.length).toBe(13)
  })

  it("applies the allowlist before any field access", () => {
    // Proof by the one record that would break a field-first parser: no `sessionId`, no `uuid`,
    // no `timestamp`, and a `snapshot` where the envelope would be.
    const snapshot =
      '{"type":"file-history-snapshot","messageId":"m1","snapshot":{"trackedFileBackups":{}},"isSnapshotUpdate":false}'
    const extract = extractFromText(snapshot, { filePath: "/x/s1.jsonl", slug: "-x" })
    expect(extract.counters.skippedTypeLines).toBe(1)
    expect(extract.counters.droppedLines).toBe(0)
    expect(extract.counters.droppedNoSession).toBe(0)
  })

  it("counts a type from neither list as unknown, not as an error", () => {
    // A future Claude Code release adding a record type must not fail a scan; the counter is how
    // an operator learns the allowlist needs revisiting.
    const extract = extractFromText('{"type":"a-type-from-a-later-release","sessionId":"s1"}', {
      filePath: "/x/s1.jsonl",
      slug: "-x"
    })
    expect(extract.counters.unknownTypeLines).toBe(1)
    expect(extract.counters.droppedLines).toBe(0)
  })
})

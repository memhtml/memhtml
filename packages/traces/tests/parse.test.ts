import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { PROJECTS_DIR, SUBAGENTS_DIR } from "../src/discover.js"
import { parseSessionFile, slugFromPath } from "../src/parse.js"
import { advanceWatermark, watermarkPlan } from "../src/watermark.js"

const FIXTURE_ROOT = new URL("./fixtures", import.meta.url).pathname
const ALPHA = "11111111-1111-4111-8111-111111111111"
const ALPHA_FILE = join(FIXTURE_ROOT, PROJECTS_DIR, "-tmp-fixture-alpha", `${ALPHA}.jsonl`)
const SIDECAR_FILE = join(
  FIXTURE_ROOT,
  PROJECTS_DIR,
  "-tmp-fixture-alpha",
  ALPHA,
  SUBAGENTS_DIR,
  "agent-aaaa1111bbbb2222.jsonl"
)

const run = <A>(effect: Effect.Effect<A, never>) => Effect.runPromise(effect)

/**
 * `chmod(path, 0o000)` is how the permission probe denies a read, and uid 0 IGNORES the mode bits —
 * root opens a mode-000 file. Under root the denial never happens, the read SUCCEEDS, and the
 * assertion would be describing a successful read. Skipped there with the reason on the record.
 */
const RUNNING_AS_ROOT = process.getuid?.() === 0
const CHMOD_INEFFECTIVE = "chmod 000 does not deny a read to uid 0, so the denial cannot be staged"

const tempFile = async (name: string, content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-traces-parse-"))
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe("slugFromPath", () => {
  it("reads a main transcript's slug from its parent directory", () => {
    expect(slugFromPath(`/root/${PROJECTS_DIR}/-tmp-a/sess-1.jsonl`)).toBe("-tmp-a")
  })

  it("reads a sidecar's slug from two levels up", () => {
    expect(slugFromPath(`/root/${PROJECTS_DIR}/-tmp-a/sess-1/${SUBAGENTS_DIR}/agent-x.jsonl`)).toBe(
      "-tmp-a"
    )
  })

  it("yields nothing for a transcript sitting directly in projects/", () => {
    expect(slugFromPath(`/root/${PROJECTS_DIR}/sess-1.jsonl`)).toBe("")
  })
})

describe("parseSessionFile over the checked-in fixture", () => {
  it("parses every record type, including the hazards, with zero throws", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))

    expect(extract.sessionId).toBe(ALPHA)
    expect(extract.slug).toBe("-tmp-fixture-alpha")
    expect(extract.counters).toEqual({
      // 23 lines: 2 malformed (a truncated object, a bare JSON string) leave 21 decoded.
      parsedLines: 21,
      droppedLines: 2,
      // The user record with no sessionId.
      droppedNoSession: 1,
      // mode, file-history-snapshot, file-history-delta.
      skippedTypeLines: 3,
      // The record type from a later release.
      unknownTypeLines: 1
    })
  })

  it("takes identity from the first enveloped record, not the resumed one later in the file", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    expect(extract.cwd).toBe("/tmp/fixture-alpha")
    expect(extract.entrypoint).toBe("cli")
    // gitBranch and version describe current state, so the resumed record's values win.
    expect(extract.gitBranch).toBe("main")
    expect(extract.version).toBe("2.1.219")
  })

  it("takes the dominant non-synthetic model", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    // Three claude-opus-5 assistant turns against one claude-fable-5; one <synthetic> excluded.
    expect(extract.model).toBe("claude-opus-5")
  })

  it("attributes prompts to user records only and counts a repeated promptId once", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    // p1 appears twice and p-ghost only on an assistant record.
    expect(extract.prompts.map((row) => [row.promptId, row.ordinal])).toEqual([
      ["p1", 0],
      ["p2", 1],
      ["p3", 2]
    ])
    expect(extract.promptCount).toBe(3)
  })

  it("recovers a text head for a prompt whose first record was a tool_result", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    const p1 = extract.prompts.find((row) => row.promptId === "p1")
    expect(p1?.textHead).toBe("Recovered head for p1.")
    // Identity stays with the first record for p1, the tool_result one.
    expect(p1?.turnUuid).toBe("u1")
  })

  it("skips the tool_result user record when choosing first_prompt", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    expect(extract.firstPrompt).toBe("Explain the watermark rule.")
  })

  it("takes the refined ai-title, the last one emitted", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    expect(extract.aiTitle).toBe("Refined fixture title")
  })

  it("spans the session's whole instant range", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE))
    // The resumed record at :04 is earlier than the first line's :05.
    expect(extract.startedAt).toBe("2026-08-01T10:00:04.000Z")
    expect(extract.endedAt).toBe("2026-08-01T10:00:16.000Z")
  })

  it("consumes exactly the file's bytes", async () => {
    const [{ bytesRead }, stats] = await Promise.all([
      run(parseSessionFile(ALPHA_FILE)),
      stat(ALPHA_FILE)
    ])
    expect(bytesRead).toBe(stats.size)
  })

  it("reads a sidecar's agentId and the parent session it belongs to", async () => {
    const { extract } = await run(parseSessionFile(SIDECAR_FILE))
    expect(extract.sessionId).toBe(ALPHA)
    expect(extract.agentIds).toEqual(["aaaa1111bbbb2222"])
    expect(extract.prompts[0]?.agentId).toBe("aaaa1111bbbb2222")
    expect(extract.slug).toBe("-tmp-fixture-alpha")
  })

  it("takes the caller's slug over the path-derived one", async () => {
    const { extract } = await run(parseSessionFile(ALPHA_FILE, 0, { slug: "-supplied" }))
    expect(extract.slug).toBe("-supplied")
  })
})

describe("parseSessionFile failure degradation", () => {
  it("returns an empty extract flagged readFailed for a file that does not exist", async () => {
    const { extract, bytesRead, readFailed } = await run(
      parseSessionFile("/nonexistent/sess.jsonl")
    )
    expect(extract.sessionId).toBeNull()
    expect(extract.counters.parsedLines).toBe(0)
    expect(bytesRead).toBe(0)
    expect(readFailed).toBe(true)
  })

  it("returns an empty extract flagged readFailed for a directory handed to it as a file", async () => {
    const { extract, readFailed } = await run(parseSessionFile(FIXTURE_ROOT))
    expect(extract.counters.parsedLines).toBe(0)
    expect(readFailed).toBe(true)
  })

  it("flags a permission rejection as readFailed rather than an empty file", async (ctx) => {
    ctx.skip(RUNNING_AS_ROOT, CHMOD_INEFFECTIVE)
    const path = await tempFile(
      "denied.jsonl",
      `${JSON.stringify({ type: "mode", mode: "default", sessionId: "s1" })}\n`
    )
    await chmod(path, 0o000)
    const { extract, bytesRead, readFailed } = await run(parseSessionFile(path))
    await chmod(path, 0o644)

    expect(readFailed).toBe(true)
    expect(bytesRead).toBe(0)
    expect(extract.counters.parsedLines).toBe(0)
  })

  it("does not flag a successful read of a genuinely empty file", async () => {
    const path = await tempFile("empty.jsonl", "")
    const { bytesRead, readFailed } = await run(parseSessionFile(path))
    // Empty and unreadable are different facts: this watermark MAY advance.
    expect(readFailed).toBe(false)
    expect(bytesRead).toBe(0)
  })

  it("survives a line of binary garbage", async () => {
    const good = JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "ok" }
    })
    // Control bytes and a lone continuation byte: invalid UTF-8 as well as invalid JSON. Written
    // as escapes so this test file stays diffable text rather than becoming a binary blob.
    const garbage = "\u0000\u0001\u0002binary\u00ff"
    const path = await tempFile("garbage.jsonl", `${good}\n${garbage}\n`)

    const { extract } = await run(parseSessionFile(path))
    expect(extract.counters.parsedLines).toBe(1)
    expect(extract.counters.droppedLines).toBe(1)
    expect(extract.prompts).toHaveLength(1)
  })

  it("does not fold an unterminated trailing line, so a tail re-reads it whole", async () => {
    const complete = `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "complete" }
    })}\n`
    const partial = '{"type":"user","sessionId":"s1","uuid":"u2","promptId":"p2","timesta'
    const path = await tempFile("partial.jsonl", complete + partial)

    const first = await run(parseSessionFile(path))
    // The partial line is neither folded nor counted: not a dropped line, not a parsed one.
    expect(first.extract.counters).toMatchObject({ parsedLines: 1, droppedLines: 0 })
    expect(first.bytesRead).toBe(Buffer.byteLength(complete))

    // The writer completes the record. Tailing from the recorded offset yields it intact.
    const rest = `${partial}mp":"2026-08-01T10:00:01.000Z","message":{"role":"user","content":"finished"}}\n`
    await writeFile(path, complete + rest)
    const before = await stat(path)
    const second = await run(parseSessionFile(path, first.bytesRead))
    expect(second.extract.counters).toMatchObject({ parsedLines: 1, droppedLines: 0 })
    expect(second.extract.prompts.map((row) => row.promptId)).toEqual(["p2"])
    expect(advanceWatermark(before, first.bytesRead, second.bytesRead).byteOff).toBe(before.size)
  })
})

describe("parseSessionFile line-boundary arithmetic", () => {
  it("counts bytes, not characters, through a multi-byte prompt", async () => {
    const line = `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "déployé 🚀 多字節" }
    })}\n`
    const path = await tempFile("multibyte.jsonl", line)
    const [{ bytesRead, extract }, stats] = await Promise.all([
      run(parseSessionFile(path)),
      stat(path)
    ])
    expect(bytesRead).toBe(stats.size)
    expect(bytesRead).toBeGreaterThan(line.length)
    expect(extract.prompts[0]?.textHead).toBe("déployé 🚀 多字節")
  })

  it("resumes a multi-byte file's tail on a record boundary", async () => {
    const record = (uuid: string, promptId: string, text: string) =>
      `${JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid,
        promptId,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: text }
      })}\n`

    const head = record("u1", "p1", "café ☕")
    const path = await tempFile("multibyte-tail.jsonl", head)
    const first = await run(parseSessionFile(path))

    await writeFile(path, head + record("u2", "p2", "naïve 🎯"))
    const second = await run(parseSessionFile(path, first.bytesRead))

    expect(second.extract.counters.droppedLines).toBe(0)
    expect(second.extract.prompts.map((row) => row.promptId)).toEqual(["p2"])
    expect(second.extract.prompts[0]?.textHead).toBe("naïve 🎯")
  })

  it("parses a CRLF transcript identically to an LF one", async () => {
    const records = [
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid: "u1",
        promptId: "p1",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: "first" }
      }),
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid: "u2",
        promptId: "p2",
        timestamp: "2026-08-01T10:00:01.000Z",
        message: { role: "user", content: "second" }
      })
    ]
    const lfPath = await tempFile("lf.jsonl", `${records.join("\n")}\n`)
    const crlfPath = await tempFile("crlf.jsonl", `${records.join("\r\n")}\r\n`)

    const lf = await run(parseSessionFile(lfPath))
    const crlf = await run(parseSessionFile(crlfPath))

    expect(crlf.extract.prompts).toEqual(lf.extract.prompts)
    expect(crlf.extract.counters).toEqual(lf.extract.counters)
    // The trailing `\r` stays inside the counted bytes, so the offset is still exact.
    expect(crlf.bytesRead).toBe((await stat(crlfPath)).size)
  })

  it("handles a blank line between records without counting it", async () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "ok" }
    })
    const path = await tempFile("blank.jsonl", `${line}\n\n\n`)
    const { extract, bytesRead } = await run(parseSessionFile(path))
    expect(extract.counters).toMatchObject({ parsedLines: 1, droppedLines: 0 })
    expect(bytesRead).toBe((await stat(path)).size)
  })

  it("parses a file larger than one read chunk", async () => {
    // 64 KiB is node's default highWaterMark, so this crosses several chunk boundaries and proves
    // a record split across chunks is still folded exactly once.
    const lines = Array.from({ length: 900 }, (_unused, index) =>
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid: `u${index}`,
        promptId: `p${index}`,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: `prompt ${index} ${"padding".repeat(20)}` }
      })
    )
    const path = await tempFile("chunky.jsonl", `${lines.join("\n")}\n`)
    const [{ extract, bytesRead }, stats] = await Promise.all([
      run(parseSessionFile(path)),
      stat(path)
    ])

    expect(stats.size).toBeGreaterThan(64 * 1024)
    expect(extract.counters).toMatchObject({ parsedLines: 900, droppedLines: 0 })
    expect(extract.promptCount).toBe(900)
    expect(bytesRead).toBe(stats.size)
  })

  it("counts a mid-line startByte as one malformed line and keeps the rest", async () => {
    const first = `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: "first" }
    })}\n`
    const second = `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u2",
      promptId: "p2",
      timestamp: "2026-08-01T10:00:01.000Z",
      message: { role: "user", content: "second" }
    })}\n`
    const path = await tempFile("midline.jsonl", first + second)

    const { extract } = await run(parseSessionFile(path, 20))
    expect(extract.counters.droppedLines).toBe(1)
    expect(extract.prompts.map((row) => row.promptId)).toEqual(["p2"])
  })

  it("reads nothing when the offset is already the end of the file", async () => {
    const path = await tempFile(
      "atend.jsonl",
      `${JSON.stringify({ type: "mode", mode: "default", sessionId: "s1" })}\n`
    )
    const stats = await stat(path)
    const plan = watermarkPlan(
      { size: stats.size, mtimeMs: stats.mtimeMs, byteOff: stats.size },
      stats
    )
    expect(plan.action).toBe("skip")

    const { bytesRead, extract } = await run(parseSessionFile(path, stats.size))
    expect(bytesRead).toBe(0)
    expect(extract.counters.parsedLines).toBe(0)
  })
})

import { appendFile, chmod, mkdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { PROJECTS_DIR } from "../src/discover.js"
import { extractFromText } from "../src/extract.js"
import { mergePrompts, mergeTailExtract, scanTraceRoot, type WatermarkReader } from "../src/scan.js"
import type { Watermark } from "../src/watermark.js"

const FIXTURE_ROOT = new URL("./fixtures", import.meta.url).pathname
const ALPHA = "11111111-1111-4111-8111-111111111111"

/** Fails the test on an unexpected `StorageFailure`, which is what a rejected promise does. */
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/**
 * The watermark table as a map — `@memhtml/index`'s trace persister owns the SQL; the scan only
 * needs the read callback.
 */
const watermarkStore = (initial: ReadonlyMap<string, Watermark> = new Map()) => {
  const rows = new Map(initial)
  const read: WatermarkReader = (filePath) => Effect.succeed(rows.get(filePath) ?? null)
  return { rows, read }
}

const FILE = { filePath: "/fixtures/projects/-tmp-x/s1.jsonl", slug: "-tmp-x" }

/**
 * `chmod(path, 0o000)` is how these tests deny a read, and uid 0 IGNORES the mode bits — root
 * opens a mode-000 file. Under root the denial never happens, so the read SUCCEEDS and every
 * assertion about a failed read would be describing the wrong thing. Skipped there with the reason
 * on the record, because a green run that measured nothing is worse than a visibly absent one.
 */
const RUNNING_AS_ROOT = process.getuid?.() === 0
const CHMOD_INEFFECTIVE = "chmod 000 does not deny a read to uid 0, so the denial cannot be staged"

const userLine = (uuid: string, promptId: string, at: string, content: unknown) =>
  JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid,
    promptId,
    timestamp: at,
    cwd: "/tmp/x",
    gitBranch: "main",
    entrypoint: "cli",
    version: "2.1.219",
    message: { role: "user", content }
  })

describe("scanTraceRoot", () => {
  it("rescans every file on a first run and reports the totals", async () => {
    const store = watermarkStore()
    const report = await run(scanTraceRoot(FIXTURE_ROOT, store.read))

    expect(report.files).toHaveLength(3)
    expect({
      skipped: report.skipped,
      tailed: report.tailed,
      rescanned: report.rescanned
    }).toEqual({ skipped: 0, tailed: 0, rescanned: 3 })
    expect(report.bytesRead).toBeGreaterThan(0)
    expect(report.files.every((scanned) => scanned.extract !== null)).toBe(true)
  })

  it("skips every file on a second run against the watermarks the first produced", async () => {
    const first = await run(scanTraceRoot(FIXTURE_ROOT, watermarkStore().read))
    const rows = new Map(first.files.map((scanned) => [scanned.file.filePath, scanned.watermark]))

    const second = await run(scanTraceRoot(FIXTURE_ROOT, watermarkStore(rows).read))

    expect({ skipped: second.skipped, tailed: second.tailed, rescanned: second.rescanned }).toEqual(
      {
        skipped: 3,
        tailed: 0,
        rescanned: 0
      }
    )
    // The number the incremental design exists to keep small: a no-change run reads nothing.
    expect(second.bytesRead).toBe(0)
    expect(second.files.every((scanned) => scanned.extract === null)).toBe(true)
  })

  it("preserves a skipped file's stored watermark rather than inventing one", async () => {
    const first = await run(scanTraceRoot(FIXTURE_ROOT, watermarkStore().read))
    const rows = new Map(first.files.map((scanned) => [scanned.file.filePath, scanned.watermark]))
    const second = await run(scanTraceRoot(FIXTURE_ROOT, watermarkStore(rows).read))

    for (const scanned of second.files) {
      expect(scanned.watermark).toEqual(rows.get(scanned.file.filePath))
    }
  })

  it("counts a session's sidecar agents in its agent_count", async () => {
    const report = await run(scanTraceRoot(FIXTURE_ROOT, watermarkStore().read))
    const main = report.files.find(
      (scanned) => scanned.file.kind === "session" && scanned.file.sessionId === ALPHA
    )
    // The main transcript names no agentId of its own; the sidecar filename supplies the one.
    expect(main?.extract?.agentIds).toEqual([])
    expect(main?.agentCount).toBe(1)

    const beta = report.files.find((scanned) => scanned.file.slug === "-tmp-fixture-beta")
    expect(beta?.agentCount).toBe(0)
  })

  it("tails only the appended bytes when a transcript grows", async () => {
    const root = await mkdtempRoot()
    const slugDir = join(root, PROJECTS_DIR, "-tmp-grow")
    await mkdir(slugDir, { recursive: true })
    const path = join(slugDir, "sess-1.jsonl")
    await writeFile(path, `${userLine("u1", "p1", "2026-08-01T10:00:00.000Z", "first")}\n`)

    const first = await run(scanTraceRoot(root, watermarkStore().read))
    const rows = new Map(first.files.map((scanned) => [scanned.file.filePath, scanned.watermark]))

    const appended = `${userLine("u2", "p2", "2026-08-01T10:00:05.000Z", "second")}\n`
    await appendFile(path, appended)
    await bumpMtime(path)

    const second = await run(scanTraceRoot(root, watermarkStore(rows).read))

    expect(second.tailed).toBe(1)
    expect(second.bytesRead).toBe(Buffer.byteLength(appended))
    // A tail's extract describes the appended slice only: one prompt, not two.
    expect(second.files[0]?.extract?.prompts.map((row) => row.promptId)).toEqual(["p2"])
    expect(second.files[0]?.watermark.byteOff).toBe((await stat(path)).size)
  })

  it("rescans a truncated transcript from byte zero", async () => {
    const root = await mkdtempRoot()
    const slugDir = join(root, PROJECTS_DIR, "-tmp-shrink")
    await mkdir(slugDir, { recursive: true })
    const path = join(slugDir, "sess-1.jsonl")
    await writeFile(
      path,
      [
        userLine("u1", "p1", "2026-08-01T10:00:00.000Z", "first"),
        userLine("u2", "p2", "2026-08-01T10:00:01.000Z", "second"),
        ""
      ].join("\n")
    )

    const first = await run(scanTraceRoot(root, watermarkStore().read))
    const rows = new Map(first.files.map((scanned) => [scanned.file.filePath, scanned.watermark]))

    await writeFile(path, `${userLine("u9", "p9", "2026-08-01T11:00:00.000Z", "compacted")}\n`)
    const second = await run(scanTraceRoot(root, watermarkStore(rows).read))

    expect(second.rescanned).toBe(1)
    expect(second.files[0]?.extract?.prompts.map((row) => row.promptId)).toEqual(["p9"])
    expect(second.files[0]?.watermark.byteOff).toBe((await stat(path)).size)
  })

  it("scans an empty tree as a successful run of nothing", async () => {
    const root = await mkdtempRoot()
    const report = await run(scanTraceRoot(root, watermarkStore().read))
    expect(report).toEqual({
      files: [],
      skipped: 0,
      tailed: 0,
      rescanned: 0,
      failed: 0,
      bytesRead: 0
    })
  })

  it("holds the stored watermark through a failed tail so the next run indexes the append", async (ctx) => {
    ctx.skip(RUNNING_AS_ROOT, CHMOD_INEFFECTIVE)
    const root = await mkdtempRoot()
    const slugDir = join(root, PROJECTS_DIR, "-tmp-fail")
    await mkdir(slugDir, { recursive: true })
    const path = join(slugDir, "sess-1.jsonl")
    await writeFile(path, `${userLine("u1", "p1", "2026-08-01T10:00:00.000Z", "first")}\n`)

    const first = await run(scanTraceRoot(root, watermarkStore().read))
    const rows = new Map(first.files.map((scanned) => [scanned.file.filePath, scanned.watermark]))
    const stored = rows.get(path)

    await appendFile(path, `${userLine("u2", "p2", "2026-08-01T10:00:05.000Z", "second")}\n`)
    await bumpMtime(path)

    // The append is visible in the stat, so the plan is a tail — but the read itself fails.
    await chmod(path, 0o000)
    const failed = await run(scanTraceRoot(root, watermarkStore(rows).read))
    await chmod(path, 0o644)

    // The failed read consumed nothing: no extract to persist, watermark exactly as stored.
    // Advancing it would stamp the file's current size+mtime and the next run would skip forever.
    expect(failed.files[0]?.extract).toBeNull()
    expect(failed.files[0]?.watermark).toEqual(stored)

    // It is counted as failed and NOT as tailed. `tailed` names what was read, so a downstream
    // report that adds `tailed` up would otherwise claim a transcript nobody read was indexed.
    expect({ tailed: failed.tailed, rescanned: failed.rescanned, failed: failed.failed }).toEqual({
      tailed: 0,
      rescanned: 0,
      failed: 1
    })
    expect(failed.bytesRead).toBe(0)

    // Retry against what the failed run reported, the store a persister would have written.
    const afterFailure = new Map(
      failed.files.map((scanned) => [scanned.file.filePath, scanned.watermark])
    )
    const retry = await run(scanTraceRoot(root, watermarkStore(afterFailure).read))
    expect(retry.tailed).toBe(1)
    expect(retry.files[0]?.extract?.prompts.map((row) => row.promptId)).toEqual(["p2"])
    expect(retry.files[0]?.watermark.byteOff).toBe((await stat(path)).size)
  })

  it("retries a file whose first-ever read failed instead of skipping it forever", async (ctx) => {
    ctx.skip(RUNNING_AS_ROOT, CHMOD_INEFFECTIVE)
    const root = await mkdtempRoot()
    const slugDir = join(root, PROJECTS_DIR, "-tmp-firstfail")
    await mkdir(slugDir, { recursive: true })
    const path = join(slugDir, "sess-1.jsonl")
    await writeFile(path, `${userLine("u1", "p1", "2026-08-01T10:00:00.000Z", "only")}\n`)

    await chmod(path, 0o000)
    const failed = await run(scanTraceRoot(root, watermarkStore().read))
    await chmod(path, 0o644)

    expect(failed.files[0]?.extract).toBeNull()
    // A first-ever read that fails is a failure, not a rescan: the plan said rescan and the read
    // achieved nothing.
    expect({ rescanned: failed.rescanned, failed: failed.failed }).toEqual({
      rescanned: 0,
      failed: 1
    })
    const rows = new Map(failed.files.map((scanned) => [scanned.file.filePath, scanned.watermark]))

    // The failure watermark must not describe the current file, or this run would skip it.
    const retry = await run(scanTraceRoot(root, watermarkStore(rows).read))
    expect(retry.skipped).toBe(0)
    expect(retry.failed).toBe(0)
    expect(retry.files[0]?.extract?.prompts.map((row) => row.promptId)).toEqual(["p1"])
  })

  /**
   * The census the four counters exist to support. A report whose numbers do not add up cannot tell
   * an operator whether a missing session was skipped, unreadable, or never discovered — and this
   * repo has twice shipped a probe whose number WAS the bug, so the total is derived from `files`
   * rather than copied from the report.
   */
  it("partitions every discovered file across the four action counters", async () => {
    const report = await run(scanTraceRoot(FIXTURE_ROOT, watermarkStore().read))
    expect(report.skipped + report.tailed + report.rescanned + report.failed).toBe(
      report.files.length
    )
    // Independently derived: a file carries an extract exactly when its read succeeded.
    expect(report.files.filter((scanned) => scanned.extract === null)).toHaveLength(
      report.skipped + report.failed
    )
  })
})

describe("mergeTailExtract", () => {
  const stored = extractFromText(
    [
      userLine("u1", "p1", "2026-08-01T10:00:00.000Z", "the opening question"),
      userLine("u2", "p2", "2026-08-01T10:00:05.000Z", "a follow-up")
    ].join("\n"),
    FILE
  )

  const tail = extractFromText(
    [
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid: "u3",
        promptId: "p3",
        timestamp: "2026-08-01T12:00:00.000Z",
        cwd: "/tmp/x",
        gitBranch: "feature/build",
        entrypoint: "cli",
        version: "2.1.220",
        message: { role: "user", content: "a much later question" }
      }),
      '{"type":"ai-title","aiTitle":"Refined later","sessionId":"s1"}'
    ].join("\n"),
    FILE
  )

  const merged = mergeTailExtract(stored, tail)

  it("keeps the session's opening prompt rather than the tail's", () => {
    // The whole reason the merge exists: a tail's first_prompt is a prompt from the middle.
    expect(merged.firstPrompt).toBe("the opening question")
  })

  it("keeps the session's start instant and takes the tail's end instant", () => {
    expect(merged.startedAt).toBe("2026-08-01T10:00:00.000Z")
    expect(merged.endedAt).toBe("2026-08-01T12:00:00.000Z")
  })

  it("sums turn counts, because a tail counts only the records it read", () => {
    expect(merged.turnCount).toBe(stored.turnCount + tail.turnCount)
    expect(merged.turnCount).toBe(3)
  })

  it("derives prompt count from the merged set instead of summing", () => {
    expect(merged.promptCount).toBe(3)
    expect(merged.prompts.map((row) => row.promptId)).toEqual(["p1", "p2", "p3"])
  })

  it("renumbers the tail's ordinals to continue the session's order", () => {
    // A tail's own ordinals restart at 0; leaving them would collide with the session's first
    // prompt and trace_prompts.ordinal would stop being an order.
    expect(tail.prompts[0]?.ordinal).toBe(0)
    expect(merged.prompts.map((row) => row.ordinal)).toEqual([0, 1, 2])
  })

  it("keeps identity fields from the older side and current-state fields from the newer", () => {
    expect(merged.cwd).toBe("/tmp/x")
    expect(merged.entrypoint).toBe("cli")
    expect(merged.gitBranch).toBe("feature/build")
    expect(merged.version).toBe("2.1.220")
    expect(merged.aiTitle).toBe("Refined later")
  })

  it("sums every counter across the two scans", () => {
    expect(merged.counters.parsedLines).toBe(
      stored.counters.parsedLines + tail.counters.parsedLines
    )
  })

  it("does not double-count a prompt straddling the tail boundary", () => {
    // The same promptId in both extracts is one prompt seen twice, not two prompts.
    const straddling = extractFromText(
      userLine("u3", "p2", "2026-08-01T11:00:00.000Z", "same prompt, new record"),
      FILE
    )
    const result = mergeTailExtract(stored, straddling)
    expect(result.promptCount).toBe(2)
    expect(result.prompts.map((row) => [row.promptId, row.ordinal])).toEqual([
      ["p1", 0],
      ["p2", 1]
    ])
    // Identity stays with the record that opened the prompt, before the boundary.
    expect(result.prompts[1]?.turnUuid).toBe("u2")
  })

  it("fills a stored prompt's empty text head from the tail", () => {
    const headless = extractFromText(
      userLine("u1", "p1", "2026-08-01T10:00:00.000Z", [
        { type: "tool_result", tool_use_id: "t1", content: "output" }
      ]),
      FILE
    )
    expect(headless.prompts[0]?.textHead).toBe("")

    const withText = extractFromText(
      userLine("u2", "p1", "2026-08-01T10:00:01.000Z", "the text arrived after the boundary"),
      FILE
    )
    const result = mergeTailExtract(headless, withText)
    expect(result.prompts[0]?.textHead).toBe("the text arrived after the boundary")
    expect(result.prompts[0]?.turnUuid).toBe("u1")
  })

  it("recovers a session id and slug the tail alone could not supply", () => {
    const unslugged = extractFromText(userLine("u3", "p3", "2026-08-01T12:00:00.000Z", "x"), {
      filePath: FILE.filePath,
      slug: ""
    })
    const result = mergeTailExtract(stored, unslugged)
    expect(result.slug).toBe("-tmp-x")
    expect(result.sessionId).toBe("s1")
  })

  it("unions agent ids across both scans", () => {
    const withAgent = extractFromText(
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        uuid: "u4",
        promptId: "p4",
        agentId: "agent-x",
        timestamp: "2026-08-01T12:00:00.000Z",
        message: { role: "user", content: "x" }
      }),
      FILE
    )
    expect(mergeTailExtract(stored, withAgent).agentIds).toEqual(["agent-x"])
  })
})

describe("mergePrompts", () => {
  const row = (promptId: string, ordinal: number, textHead = promptId) => ({
    promptId,
    turnUuid: `u-${promptId}`,
    ordinal,
    at: "2026-08-01T10:00:00.000Z",
    agentId: null,
    textHead
  })

  it("renumbers into one contiguous 0-based order", () => {
    const merged = mergePrompts([row("a", 0), row("b", 1)], [row("c", 0), row("d", 1)])
    expect(merged.map((entry) => [entry.promptId, entry.ordinal])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3]
    ])
  })

  it("normalizes a gapped stored ordering rather than propagating the gaps", () => {
    const merged = mergePrompts([row("a", 3), row("b", 9)], [row("c", 0)])
    expect(merged.map((entry) => entry.ordinal)).toEqual([0, 1, 2])
  })

  it("orders by stored ordinal, not by array position", () => {
    const merged = mergePrompts([row("b", 1), row("a", 0)], [])
    expect(merged.map((entry) => entry.promptId)).toEqual(["a", "b"])
  })

  it("is idempotent when the tail repeats the stored set", () => {
    const stored = [row("a", 0), row("b", 1)]
    expect(mergePrompts(stored, stored)).toEqual(stored)
  })

  it("returns the other side when one is empty", () => {
    const stored = [row("a", 0), row("b", 1)]
    expect(mergePrompts(stored, [])).toEqual(stored)
    expect(mergePrompts([], stored)).toEqual(stored)
  })
})

const mkdtempRoot = async (): Promise<string> => {
  const { mkdtemp } = await import("node:fs/promises")
  return mkdtemp(join(tmpdir(), "memhtml-traces-scan-"))
}

/**
 * Push mtime forward by a second. An append inside one filesystem mtime tick would leave the
 * decision resting on size alone, and these tests are about the two-part key.
 */
const bumpMtime = async (path: string): Promise<void> => {
  const { utimes } = await import("node:fs/promises")
  const stats = await stat(path)
  const next = new Date(stats.mtimeMs + 1_000)
  await utimes(path, next, next)
}

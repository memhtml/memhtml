import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { parseSessionFile } from "../src/parse.js"

/**
 * What a read that breaks HALFWAY reports.
 *
 * This is the one failure shape a real fixture cannot stage. An absent file, a directory, and a
 * permission rejection all fail at OPEN, before a single line is folded, so none of them can say
 * what happens to bytes already accumulated when the stream breaks. Only a mid-stream error puts
 * the accumulator and the byte count in a state a caller could be tempted to report, and the rule
 * is that neither may escape: a partial fold ends on no boundary a watermark could stand on.
 *
 * `node:fs`'s `createReadStream` is replaced for ONE sentinel path and passes through for every
 * other, which is why this lives in its own file — a module mock is file-scoped. The second test
 * below is the census that keeps the mock honest.
 */

const { BROKEN_PATH, PREFIX } = vi.hoisted(() => {
  const line = (uuid: string, promptId: string): string =>
    `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid,
      promptId,
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: `content for ${promptId}` }
    })}\n`
  return {
    // Never touches the filesystem: the mock answers this path instead of opening it.
    BROKEN_PATH: "/memhtml-traces-nonexistent/broken-midstream.jsonl",
    // Two whole newline-terminated records, so both fold and both are counted before the break.
    PREFIX: line("u1", "p1") + line("u2", "p2")
  }
})

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const { Readable } = await import("node:stream")

  /** Delivers `PREFIX` in one chunk, then breaks the way a transient IO error breaks. */
  const brokenStream = (): unknown => {
    let delivered = false
    return new Readable({
      read() {
        if (delivered) {
          this.destroy(new Error("EIO: simulated mid-stream read failure"))
          return
        }
        delivered = true
        this.push(Buffer.from(PREFIX, "utf8"))
      }
    })
  }

  return {
    ...actual,
    createReadStream: ((path: unknown, options?: unknown) =>
      path === BROKEN_PATH
        ? brokenStream()
        : (actual.createReadStream as (p: unknown, o?: unknown) => unknown)(
            path,
            options
          )) as typeof actual.createReadStream
  }
})

const tempFile = async (content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-traces-partial-"))
  const path = join(dir, "sess-1.jsonl")
  await writeFile(path, content)
  return path
}

describe("parseSessionFile over a stream that breaks after folding", () => {
  it("reports zero bytes and an empty extract, never the partial fold", async () => {
    const result = await Effect.runPromise(parseSessionFile(BROKEN_PATH))

    expect(result.readFailed).toBe(true)
    /**
     * Both records were folded and counted at the moment the error arrived, and neither may be
     * reported. A watermark advanced by a partial read lands on no record boundary the next read
     * could resume from, and counters that claim lines whose rows were never persisted describe a
     * scan that did not happen.
     */
    expect(result.bytesRead).toBe(0)
    expect(result.extract.counters.parsedLines).toBe(0)
    expect(result.extract.prompts).toEqual([])
    expect(result.extract.sessionId).toBeNull()
  })

  it("passes an ordinary path through to the real stream, so the mock proves something", async () => {
    // The anti-vacuity census. Without it the assertions above would also pass against a mock that
    // failed every read, and `PREFIX` would never be shown to fold at all.
    const result = await Effect.runPromise(parseSessionFile(await tempFile(PREFIX)))

    expect(result.readFailed).toBe(false)
    expect(result.bytesRead).toBe(Buffer.byteLength(PREFIX))
    expect(result.extract.counters.parsedLines).toBe(2)
    expect(result.extract.prompts.map((row) => row.promptId)).toEqual(["p1", "p2"])
  })
})

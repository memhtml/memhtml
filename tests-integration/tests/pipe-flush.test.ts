import { execFile } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { cliEntryPoint } from "./spawned.js"

const sh = promisify(execFile)

/**
 * The envelope reaches a slow pipe reader whole (issue #117).
 *
 * `bin.ts` used to call `process.exit` straight after `process.stdout.write`. On a pipe that is
 * asynchronous past what the buffer takes at once, and the exit discarded the queued remainder, so a
 * reader that had not drained yet got a prefix cut mid-string. `manifest` is the natural subject: at
 * ~69 KB it is larger than a Linux pipe buffer (64 KiB), so a reader that starts after the writer has
 * exited can only see what was flushed synchronously.
 *
 * The reader here sleeps a second before reading, which is what makes the case deterministic rather
 * than a race: with the bug, the byte count lands at the pipe capacity; with the fix, it equals the
 * file redirect byte for byte. Through a SHELL pipe on purpose — Node's own `spawn` stdio is a socket
 * pair with different flushing, and did not reproduce the truncation the shell did.
 *
 * (Mutation-verified: restoring the bare `process.exit` after the write fails both assertions.)
 */
describe("the envelope survives a slow pipe reader", () => {
  it("delivers the whole manifest through a pipe the reader drains late", async () => {
    const file = join(tmpdir(), `memhtml-pipe-flush-${String(process.pid)}.json`)
    const bin = `${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntryPoint)} manifest`
    try {
      await sh("sh", ["-c", `${bin} > ${JSON.stringify(file)}`], { maxBuffer: 16 * 1024 * 1024 })
      const whole = await readFile(file, "utf8")
      // The subject has to exceed the pipe buffer, or the case proves nothing about queued writes.
      expect(Buffer.byteLength(whole)).toBeGreaterThan(64 * 1024)

      const { stdout } = await sh("sh", ["-c", `${bin} | (sleep 1; cat)`], {
        maxBuffer: 16 * 1024 * 1024
      })
      expect(Buffer.byteLength(stdout)).toBe(Buffer.byteLength(whole))
      expect(stdout).toBe(whole)
      // And it is still one parseable envelope, which is the property every consumer relies on.
      expect((JSON.parse(stdout) as { type: string }).type).toBe("cli.manifest")
    } finally {
      await rm(file, { force: true })
    }
  }, 60_000)
})

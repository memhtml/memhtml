import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  bashWorkerPath,
  COMMAND_TIMEOUT_EXIT_CODE,
  commandTimeoutMsFrom,
  DEFAULT_COMMAND_TIMEOUT_MS,
  parseCommandTimeoutMs,
  runBoundedCommand,
  truncateTail
} from "../src/command-bound.js"
import { encodeSandboxMounts } from "../src/mount.js"

/**
 * The per-command bound (the 2026-09-03 stall), driven against the INSTALLED just-bash on a real worker
 * thread rather than against a description of either.
 *
 * The runaway case is the model's own command shape: a context grep, `.\{200\}needle.\{200\}`, over a
 * line of 800k characters. just-bash runs regular expressions through an engine of its own whose
 * cost grows with line length TIMES repetition width — measured here 2026-09-03: 2.4 s at `.\{20\}`
 * and 20.7 s at `.\{200\}` on this exact line, where a classic backtracking pattern like `(a+)+$`
 * returns in milliseconds. That work is one stretch of synchronous JavaScript no cooperative abort can
 * reach, because just-bash consults its signal only between commands. The assertion is therefore not
 * "the command fails" but "the command is STOPPED within the limit, and the next command runs": the
 * bound has to end the work AND leave the tool usable, or the turn is lost either way.
 *
 * (Mutation: removing the `worker.terminate()` in the deadline path lets the command run its twenty
 * seconds and return exit 0, failing the exit-code assertion or the case's own timeout; raising the
 * deadline past the case timeout does the same.)
 */

let root = ""
let scratch = ""
let corpus = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "memhtml-command-bound-"))
  scratch = join(root, "scratch")
  await mkdir(join(scratch, "workspace"), { recursive: true })
  await mkdir(join(scratch, "tmp"), { recursive: true })
  corpus = join(root, "corpus")
  await mkdir(corpus)
  const half = "x".repeat(400_000)
  await writeFile(join(corpus, "long.txt"), `${half}memhtml${half}\n`)
  await writeFile(
    join(corpus, "t.jsonl"),
    '{"k":"memhtml"}\n{"k":"other"}\n{"k":"memhtml again"}\n'
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const run = (command: string, timeoutMs = 10_000) =>
  runBoundedCommand({
    command,
    timeoutMs,
    workerPath: bashWorkerPath(),
    mountsEncoded: encodeSandboxMounts([{ mountPath: "/mnt/traces", hostPath: corpus }]),
    scratchRoot: scratch
  })

describe("runBoundedCommand", () => {
  it("runs a fixed-string search over the read-only mount and returns its output", async () => {
    const result = await run("grep -c -F memhtml /mnt/traces/t.jsonl")
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("2")
    expect(result.truncated).toBe(false)
  })

  it("stops a command that never terminates at the limit, and the next command still runs", async () => {
    const started = Date.now()
    const killed = await run("grep -o '.\\{200\\}memhtml.\\{200\\}' /mnt/traces/long.txt", 500)
    const elapsed = Date.now() - started
    expect(killed.exitCode).toBe(COMMAND_TIMEOUT_EXIT_CODE)
    expect(killed.stderr).toContain("command exceeded the 1 s per-command limit")
    expect(killed.stderr).toContain("grep -F")
    // Well inside the limit plus worker teardown; the unbounded version never returns.
    expect(elapsed).toBeLessThan(5_000)

    // STOPPED, not merely abandoned: a runner that returned the timeout result and left the worker
    // spinning would pass every assertion above. CPU time is process-wide, so a live worker shows
    // up here as most of the wall time; an idle process shows a few milliseconds.
    const before = process.cpuUsage()
    await new Promise((settle) => setTimeout(settle, 700))
    const spent = process.cpuUsage(before)
    expect((spent.user + spent.system) / 1000).toBeLessThan(300)

    const after = await run("echo alive")
    expect(after.exitCode).toBe(0)
    expect(after.stdout.trim()).toBe("alive")
  }, 20_000)

  it("refuses a write under a mount, and keeps /workspace across commands", async () => {
    const refused = await run("echo x > /mnt/traces/new.txt")
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toLowerCase()).toContain("read-only")

    const wrote = await run("echo kept > /workspace/note.txt")
    expect(wrote.exitCode).toBe(0)
    const read = await run("cat /workspace/note.txt")
    expect(read.stdout.trim()).toBe("kept")
  })

  it("reports a broken worker as a failed command rather than hanging or throwing", async () => {
    const result = await runBoundedCommand({
      command: "echo never",
      timeoutMs: 5_000,
      workerPath: join(root, "no-such-worker.mjs"),
      mountsEncoded: undefined,
      scratchRoot: scratch
    })
    expect(result.exitCode).toBe(126)
    expect(result.stderr).toContain("sandbox worker")
  })
})

describe("truncateTail", () => {
  it("keeps the tail and says how much it dropped, like eve's bash tool", () => {
    const lines = Array.from({ length: 2_500 }, (_, index) => `line ${String(index)}`)
    const result = truncateTail(`${lines.join("\n")}\n`)
    expect(result.truncated).toBe(true)
    expect(result.totalLines).toBe(2_500)
    expect(result.outputLines).toBe(2_000)
    expect(result.output.endsWith("line 2499\n")).toBe(true)
    expect(result.output.startsWith("line 500\n")).toBe(true)
  })

  it("cuts a single megabyte line rather than handing it to the model", () => {
    const result = truncateTail(`${"x".repeat(100_000)}\n`)
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThan(2_100)
  })

  it("leaves a short output alone", () => {
    const result = truncateTail("one\ntwo\n")
    expect(result).toEqual({
      output: "one\ntwo\n",
      truncated: false,
      totalLines: 2,
      outputLines: 2
    })
  })
})

describe("the per-command limit from the environment", () => {
  it("defaults to sixty seconds when the variable is absent or blank", () => {
    expect(commandTimeoutMsFrom({})).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(commandTimeoutMsFrom({ MEMHTML_CONSOLIDATOR_COMMAND_TIMEOUT_MS: "  " })).toBe(60_000)
    expect(parseCommandTimeoutMs(undefined)).toBeUndefined()
  })

  it("takes an explicit positive integer and refuses anything else", () => {
    expect(parseCommandTimeoutMs("90000")).toBe(90_000)
    expect(commandTimeoutMsFrom({ MEMHTML_CONSOLIDATOR_COMMAND_TIMEOUT_MS: "1500" })).toBe(1_500)
    for (const bad of ["soon", "0", "-5", "1.5"]) {
      expect(() => parseCommandTimeoutMs(bad)).toThrow(/MEMHTML_CONSOLIDATOR_COMMAND_TIMEOUT_MS/)
    }
  })
})

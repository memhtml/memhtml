#!/usr/bin/env node
import { run } from "./run.js"

// stdout carries only the envelope so it stays a clean parse target.
const result = await run(process.argv.slice(2))

/**
 * Exit from the write's callback, never straight after the write.
 *
 * `process.stdout.write` to a PIPE is asynchronous past what the pipe buffer takes at once: libuv
 * writes what it can synchronously and queues the rest, and `process.exit` right after the call
 * discards the queue. A consumer that reads the pipe late — `memhtml manifest | jq`, a test runner,
 * anything that does other work before draining — got a prefix cut mid-string (measured 2026-09-02:
 * a 69 KB manifest arrived as 8,192 or 16,374 bytes depending on the reader's timing, and as
 * 65,536 with a reader that starts after one second; issue #117). A redirect to a file was never
 * affected, which is why the documented `memhtml manifest | jq '.data.config'` could ship broken.
 *
 * The callback fires once the bytes are handed to the OS, so the envelope is whole on every exit
 * path, including the `exitCode !== 0` ones. `tests-integration/tests/pipe-flush.test.ts` reads the
 * manifest through a deliberately slow pipe and compares it byte for byte with a file redirect.
 */
process.stdout.write(`${result.stdout}\n`, () => process.exit(result.exitCode))

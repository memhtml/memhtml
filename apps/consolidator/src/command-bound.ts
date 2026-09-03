import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

/**
 * A wall-clock bound on every shell command the consolidator agent runs, enforced by PREEMPTION.
 *
 * ## Why a worker thread, and not a timer
 *
 * The consolidator's time goes into just-bash, a pure-JavaScript bash interpreter running on the eve
 * server's main thread. Measured 2026-09-03 against a 5.7 MB transcript whose longest line is 799k
 * characters: `grep -o '.\{200\}memhtml.\{200\}'` took 156 s, and the 09-03 cron's final command
 * was still at 100% CPU seven and a half hours later. Nothing cooperative reaches it. just-bash's own
 * `Sandbox.create({ timeoutMs })` arms a timer that aborts through an `AbortSignal`, and the
 * interpreter consults that signal only between commands — the same probe with `timeoutMs: 5000`
 * ran the full 156 s and exited 0. A timer in eve's tool layer cannot fire either, because the event
 * loop it would fire on is the one the regex is holding.
 *
 * So each command runs on a `worker_threads` Worker of its own, and the deadline calls
 * `worker.terminate()`, which V8 honors from inside a running regex. The worker hosts its own
 * just-bash over the SAME read-only mounts the server's sandbox composes (`mount.ts`), so the model
 * sees one filesystem whichever tool it reaches for. The cost is a fresh shell per command: `cd`
 * and variables do not carry between calls, and `agent/instructions.md` says so.
 *
 * ## Where the pieces live
 *
 * - `agent/tools/bash.ts` overrides eve's built-in `bash` (eve's documented path: author a tool at
 *   the same slug, spread the default) and calls {@link runBoundedCommand}.
 * - `worker/bash-worker.mjs` is the worker's entry: plain ESM, shipped as a FILE like
 *   `tether/parent-tether.mjs`, because a module bundled into `dist/` is not a path `new Worker`
 *   can load. The CLIENT resolves it ({@link bashWorkerPath}) and hands it to the server on
 *   {@link BASH_WORKER_ENV}, the same way `child-tether.ts` hands over the tether.
 * - The limit itself crosses on {@link COMMAND_TIMEOUT_ENV}: the composition root
 *   (`apps/cli/src/api-layer.ts`) reads the operator's value, the client stamps the resolved number
 *   into the spawn environment, and the tool reads it back. One default, here.
 */

/** The operator's knob: milliseconds each sandbox command may run before it is killed. */
export const COMMAND_TIMEOUT_ENV = "MEMHTML_CONSOLIDATOR_COMMAND_TIMEOUT_MS"

/**
 * Sixty seconds. A fixed-string count over the largest transcript on the measuring box took 0.3 s in
 * just-bash, so a command that needs a minute is doing the wrong kind of work, and a minute is short
 * enough that a turn budget of an hour survives a dozen of them.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

/** Absolute path of `worker/bash-worker.mjs`, stamped by the client into the server's environment. */
export const BASH_WORKER_ENV = "MEMHTML_CONSOLIDATOR_BASH_WORKER"

/** Host directory the worker mounts as its writable base, so `/workspace` persists across commands. */
export const SCRATCH_ROOT_ENV = "MEMHTML_CONSOLIDATOR_SCRATCH"

/** What a killed command exits with: the code `timeout(1)` uses, which models already know. */
export const COMMAND_TIMEOUT_EXIT_CODE = 124

/** The tool's result shape: eve's `bash` output schema, which the override keeps. */
export interface BashResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

/** This package's root, resolved from this module rather than from `process.cwd()`. */
const packageRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The worker entry's location. Resolved in the CLIENT process, where `import.meta.url` is this
 * package's `dist/`; inside the eve-built server the same expression would name the build cache.
 */
export const bashWorkerPath = (): string => join(packageRoot(), "worker", "bash-worker.mjs")

/**
 * Parse the operator's limit. Absent or blank is `undefined` (take the default); anything else must
 * be a positive integer of milliseconds, or this THROWS — a typo'd limit silently becoming the
 * default is the degradation-instead-of-skip outcome the composition root refuses one knob over.
 */
export const parseCommandTimeoutMs = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim() ?? ""
  if (trimmed === "") return undefined
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${COMMAND_TIMEOUT_ENV} must be a positive integer of milliseconds; got ${JSON.stringify(raw)}`
    )
  }
  return value
}

/** The limit in force for a process, from its environment, defaulting rather than failing on absence. */
export const commandTimeoutMsFrom = (env: Record<string, string | undefined>): number =>
  parseCommandTimeoutMs(env[COMMAND_TIMEOUT_ENV]) ?? DEFAULT_COMMAND_TIMEOUT_MS

/**
 * What the model reads when its command is killed. Names the limit, says what to do instead, and
 * says why, because the model has no other way to learn that this shell is slow at exactly the
 * patterns a real grep is fast at.
 */
export const commandTimeoutMessage = (timeoutMs: number): string =>
  `command exceeded the ${String(Math.round(timeoutMs / 1000))} s per-command limit and was killed; ` +
  "nothing it printed was kept. Narrow the pattern or use a fixed-string search: grep -F, grep -c -F, " +
  "or grep -n -F followed by cut -c on the matching line. Transcript lines run to megabytes, so " +
  ".{N} context windows, grep -o over wide patterns, and jq over a whole file do not finish here."

/** eve's `bash` tool keeps the last 2000 lines / 50 KB and cuts lines at 2000 characters; so does this. */
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000

interface TruncatedOutput {
  readonly output: string
  readonly truncated: boolean
  readonly totalLines: number
  readonly outputLines: number
}

/**
 * Keep the TAIL of an output, the way eve's own bash tool does (`truncate-output.js`): the end of a
 * search is where the count or the last hit is. A megabyte of grep hits handed to the model whole would
 * spend the context the transcripts were kept out of.
 */
export const truncateTail = (text: string): TruncatedOutput => {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const totalLines = lines.length
  let truncated = false
  const clipped = lines.map((line) => {
    if (line.length <= MAX_LINE_LENGTH) return line
    truncated = true
    return `${line.slice(0, MAX_LINE_LENGTH)}…`
  })
  let kept = clipped.length > MAX_OUTPUT_LINES ? clipped.slice(-MAX_OUTPUT_LINES) : clipped
  if (kept.length < clipped.length) truncated = true
  let joined = kept.join("\n")
  while (Buffer.byteLength(joined, "utf8") > MAX_OUTPUT_BYTES && kept.length > 1) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10)))
    joined = kept.join("\n")
    truncated = true
  }
  const output = totalLines === 0 ? "" : `${joined}\n`
  return { output, truncated, totalLines, outputLines: kept.length }
}

const presentTruncated = (stream: "stdout" | "stderr", text: string): TruncatedOutput => {
  const result = truncateTail(text)
  if (!result.truncated) return result
  return {
    ...result,
    output:
      `[${stream} truncated: showing last ${String(result.outputLines)} of ` +
      `${String(result.totalLines)} lines]\n${result.output}`
  }
}

/** What the worker posts back: the raw just-bash result, before truncation. */
export interface WorkerReport {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** What the worker is started with. Mirrors the spawn environment, decoded once, on the parent side. */
export interface BoundedCommandInput {
  readonly command: string
  readonly timeoutMs: number
  /** {@link bashWorkerPath} on the client; whatever {@link BASH_WORKER_ENV} carries on the server. */
  readonly workerPath: string
  /** `MEMHTML_SANDBOX_MOUNTS` verbatim; the worker decodes it with the same rules as `mount.ts`. */
  readonly mountsEncoded: string | undefined
  readonly scratchRoot: string
}

const isWorkerReport = (value: unknown): value is WorkerReport =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WorkerReport).exitCode === "number" &&
  typeof (value as WorkerReport).stdout === "string" &&
  typeof (value as WorkerReport).stderr === "string"

/**
 * Run one command on a worker of its own and settle within `timeoutMs` no matter what the command
 * does. Never rejects: every failure is a result the model can read and act on.
 *
 * The three ways a worker ends are all handled, and the first one to happen wins: a report (the
 * normal path), the deadline (terminate, then the timeout result), or an `error`/`exit` without a
 * report (the worker itself broke — a missing `just-bash`, an unreadable scratch root — reported as
 * exit 126 with the cause, so a broken sandbox reads as broken rather than as an empty corpus).
 */
export const runBoundedCommand = (input: BoundedCommandInput): Promise<BashResult> =>
  new Promise<BashResult>((settle) => {
    let settled = false
    let deadlineHit = false
    let timer: NodeJS.Timeout | undefined
    const timeoutResult = (): BashResult => ({
      exitCode: COMMAND_TIMEOUT_EXIT_CODE,
      stdout: "",
      stderr: commandTimeoutMessage(input.timeoutMs),
      truncated: false
    })
    const finish = (result: BashResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      settle(result)
    }

    let worker: Worker
    try {
      worker = new Worker(input.workerPath, {
        /**
         * A worker INHERITS the parent's `execArgv` by default, and this parent is an eve child that
         * was spawned with `--import` in front of it (`child-tether.ts`). Inheriting that would load
         * the parent tether inside every worker — a second pid watch on a thread that has no pid —
         * and any other flag the parent happened to carry travels the same way (`--input-type=module`
         * broke a probe exactly this way). The worker needs no flags at all.
         */
        execArgv: [],
        workerData: {
          command: input.command,
          mountsEncoded: input.mountsEncoded ?? "",
          scratchRoot: input.scratchRoot
        }
      })
    } catch (cause) {
      finish({
        exitCode: 126,
        stdout: "",
        stderr: `the sandbox worker could not start: ${String(cause)}`,
        truncated: false
      })
      return
    }

    /**
     * The flag is set BEFORE terminate is called, because terminate makes the worker emit `exit`
     * before the terminate promise settles, and that `exit` must read as the deadline, not as a
     * worker that died on its own.
     */
    timer = setTimeout(() => {
      deadlineHit = true
      void worker.terminate().finally(() => finish(timeoutResult()))
    }, input.timeoutMs)

    worker.once("message", (report: unknown) => {
      if (!isWorkerReport(report)) {
        finish({
          exitCode: 126,
          stdout: "",
          stderr: "the sandbox worker reported something that is not a command result",
          truncated: false
        })
      } else {
        const stdout = presentTruncated("stdout", report.stdout)
        const stderr = presentTruncated("stderr", report.stderr)
        finish({
          exitCode: report.exitCode,
          stdout: stdout.output,
          stderr: stderr.output,
          truncated: stdout.truncated || stderr.truncated
        })
      }
      void worker.terminate()
    })
    worker.once("error", (cause) => {
      finish({
        exitCode: 126,
        stdout: "",
        stderr: `the sandbox worker failed: ${String(cause)}`,
        truncated: false
      })
    })
    worker.once("exit", (code) => {
      if (deadlineHit) {
        finish(timeoutResult())
        return
      }
      finish({
        exitCode: 126,
        stdout: "",
        stderr: `the sandbox worker exited with code ${String(code)} before reporting a result`,
        truncated: false
      })
    })
  })

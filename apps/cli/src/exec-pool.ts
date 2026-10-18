import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect, Option, Result, type Scope, Semaphore } from "effect"

import { sandboxRunnerPath } from "./exec.js"
import type { GuestJob, GuestRun, SandboxRunner } from "./session-exec.js"

/**
 * The head server's sandbox runner: a small pool of warm `worker_threads` workers, each running
 * `guest/sandbox-runner.mjs` (`docs/v2-poc.md`, "Head server", "Exec").
 *
 * ## Why a worker
 *
 * just-bash interprets a script on the thread that calls it and yields only to microtasks, so a
 * busy script holds that thread's event loop for as long as it runs. Measured on 3.4.2: a
 * `while true; do :; done` under a 2 s bound ran its full 2 s with zero timer ticks on the calling
 * thread. In the server that thread answers every search, so a script run there would stall every
 * lookup for up to its `--timeout-ms` (600 s at the cap). In a worker the script owns a thread of
 * its own, and the server's event loop never waits on it.
 *
 * ## The deadline
 *
 * just-bash ends a busy loop at its own deadline, but a single command it cannot interrupt (one
 * long regex over one long line, say) runs past it. The pool therefore holds a timer per job at the
 * run's deadline (`runDeadlineMs`: the script's bound, plus the shell's grace under `js`, plus
 * {@link RUN_DEADLINE_GRACE_MS} for seeding and the walk); a job that has not answered by then has
 * its worker terminated, and the run is answered as cut off by the runtime with nothing changed, so
 * nothing is harvested. The pool starts a new worker for the next job. A worker that dies (a crash,
 * or its heap limit, {@link WORKER_HEAP_MB} unless configured) fails its job and is replaced the same
 * way, so neither a runaway nor an allocation bomb reaches the server's own thread or heap.
 *
 * ## Warmth
 *
 * A worker costs 107 to 130 ms to start, 81 to 98 of them importing just-bash (measured on the
 * 7,437-record clone), which is most of what a warm run costs, so workers are kept between jobs and
 * one is started with the pool. A worker runs one job at a time; the pool's size bounds how many run
 * at once ({@link defaultExecPoolSize}, or `MEMHTML_EXEC_POOL_SIZE`), and a job that cannot get a
 * worker within the wait it is given fails with {@link EXEC_BUSY} so its caller can answer rather
 * than queue without bound.
 */

/**
 * The most workers the default runs at once, whatever the host's parallelism: each holds one seeded
 * corpus while it runs (about 17 MB on a 7,437-record clone) and may grow to its heap limit, so the
 * default stays bounded on a large host. `MEMHTML_EXEC_POOL_SIZE` sets any size up to
 * {@link EXEC_POOL_SIZE_MAX}.
 */
export const EXEC_POOL_SIZE_DEFAULT_CAP = 4

/** The largest `MEMHTML_EXEC_POOL_SIZE` accepted. */
export const EXEC_POOL_SIZE_MAX = 64

/**
 * The pool size when none is configured: one worker per core the process may use, less one for the
 * server's own thread, at least 1 and at most {@link EXEC_POOL_SIZE_DEFAULT_CAP}. `parallelism` is
 * a parameter so a test can name a host.
 */
export const defaultExecPoolSize = (parallelism: number = availableParallelism()): number =>
  Math.max(1, Math.min(EXEC_POOL_SIZE_DEFAULT_CAP, parallelism - 1))

/**
 * The old-generation heap a worker may grow to before it is stopped, in MB, when
 * `MEMHTML_EXEC_WORKER_HEAP_MB` sets none.
 */
export const WORKER_HEAP_MB = 2048

/** The bounds `MEMHTML_EXEC_WORKER_HEAP_MB` is held to: below 64 MB just-bash cannot start. */
export const WORKER_HEAP_MB_MIN = 64
export const WORKER_HEAP_MB_MAX = 65_536

/** The variable that sets the pool's size, read by `head serve`. */
export const EXEC_POOL_SIZE_VAR = "MEMHTML_EXEC_POOL_SIZE"

/** The variable that sets each worker's heap limit in MB, read by `head serve`. */
export const EXEC_WORKER_HEAP_VAR = "MEMHTML_EXEC_WORKER_HEAP_MB"

/**
 * A pool setting's value, as one of the two variables above spells it: a whole number in
 * `[min, max]`, or the reason it is not one.
 */
export const parsePoolSetting = (
  raw: string,
  min: number,
  max: number
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: string } => {
  const text = raw.trim()
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? { ok: true, value }
    : { ok: false, reason: `expected a whole number from ${String(min)} to ${String(max)}` }
}

/** The `StorageFailure.operation` a job gets when no worker came free within its wait. */
export const EXEC_BUSY = "session-exec.busy"

/** The stderr line a run cut off by the pool carries. Says "deadline", which `cutOffByTheRuntime` reads. */
export const killedStderr = (deadlineMs: number): string =>
  `session exec: the sandbox did not stop at its deadline and was terminated after ${String(deadlineMs)} ms; nothing was harvested\n`

/** What the pool reports about itself, for the server's status. */
export interface ExecPoolStats {
  readonly size: number
  readonly idle: number
  readonly busy: number
  readonly started: number
  readonly killed: number
  readonly jobs: number
}

export interface ExecPool {
  /** Run `job` in a worker, waiting at most `waitMs` for one to come free. */
  readonly runner: (waitMs: number) => SandboxRunner
  readonly stats: () => ExecPoolStats
}

interface Slot {
  readonly worker: Worker
  readonly ready: Promise<void>
}

export interface ExecPoolInput {
  /** Workers that run at once; {@link defaultExecPoolSize} when omitted. */
  readonly size?: number | undefined
  /** Each worker's old-generation heap limit in MB; {@link WORKER_HEAP_MB} when omitted. */
  readonly heapMb?: number | undefined
  /** The worker entry; the sandbox runner unless a test hands in a stand-in. */
  readonly workerPath?: string | undefined
}

/**
 * A pool in the current scope. Closing the scope terminates every worker, a running one included.
 */
export const makeExecPool = (
  input: ExecPoolInput = {}
): Effect.Effect<ExecPool, never, Scope.Scope> =>
  Effect.gen(function* () {
    const size = input.size ?? defaultExecPoolSize()
    const heapMb = input.heapMb ?? WORKER_HEAP_MB
    const workerPath = input.workerPath ?? sandboxRunnerPath()
    const permits = yield* Semaphore.make(size)
    const idle: Array<Slot> = []
    const live = new Set<Slot>()
    const counts = { started: 0, killed: 0, jobs: 0, busy: 0 }
    let nextJob = 0

    const spawn = (): Slot => {
      const worker = new Worker(workerPath, {
        workerData: { role: "memhtml-session-exec" },
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
        // Not forwarded to this process's stdout, which carries exactly one envelope; the runner
        // writes nothing there, and anything a dependency did would be dropped here, not emitted.
        stdout: true
      })
      worker.stdout.resume()
      // An idle worker must not keep a closing server's process alive.
      worker.unref()
      const ready = new Promise<void>((resolve, reject) => {
        const onMessage = (message: { readonly ready?: boolean }) => {
          if (message?.ready !== true) return
          worker.off("message", onMessage)
          resolve()
        }
        worker.on("message", onMessage)
        worker.once("error", reject)
        worker.once("exit", (code) => reject(new Error(`worker exited with ${String(code)}`)))
      })
      // A rejection is read by the job that awaits it; this keeps an idle worker's from going unhandled.
      ready.catch(() => undefined)
      const slot = { worker, ready }
      live.add(slot)
      counts.started += 1
      return slot
    }

    const retire = (slot: Slot): Promise<void> => {
      live.delete(slot)
      return slot.worker.terminate().then(
        () => undefined,
        () => undefined
      )
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all([...live].map(retire))).pipe(Effect.asVoid)
    )
    // One warm worker, so the first job pays no start.
    idle.push(spawn())

    type Outcome =
      | { readonly kind: "answered"; readonly run: GuestRun }
      | { readonly kind: "killed" }
      | { readonly kind: "failed"; readonly reason: string }

    /** One job on one ready worker, answered, cut off at the deadline, or failed with the worker. */
    const post = (slot: Slot, job: GuestJob, deadlineMs: number): Effect.Effect<Outcome> =>
      Effect.callback<Outcome>((resume) => {
        const id = ++nextJob
        let settled = false
        const settle = (outcome: Outcome) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          slot.worker.off("message", onMessage)
          slot.worker.off("error", onError)
          slot.worker.off("exit", onExit)
          resume(Effect.succeed(outcome))
        }
        const onMessage = (message: {
          readonly id?: number
          readonly ok?: boolean
          readonly result?: GuestRun
          readonly error?: string
        }) => {
          if (message?.id !== id) return
          settle(
            message.ok === true && message.result !== undefined
              ? { kind: "answered", run: message.result }
              : { kind: "failed", reason: String(message.error ?? "no result").slice(0, 2000) }
          )
        }
        const onError = (error: Error) => settle({ kind: "failed", reason: String(error.message) })
        const onExit = (code: number) =>
          settle({ kind: "failed", reason: `the worker exited with ${String(code)}` })
        const timer = setTimeout(() => settle({ kind: "killed" }), deadlineMs)
        slot.worker.on("message", onMessage)
        slot.worker.on("error", onError)
        slot.worker.on("exit", onExit)
        slot.worker.postMessage({ id, job })
        // Interrupted (the request that asked was abandoned): the worker is still running the job,
        // so it is stopped rather than handed to the next job mid-run.
        return Effect.sync(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void retire(slot)
        })
      })

    const runOn = (job: GuestJob, deadlineMs: number): Effect.Effect<GuestRun, StorageFailure> =>
      Effect.gen(function* () {
        const slot = idle.pop() ?? spawn()
        const ready = yield* Effect.tryPromise({
          try: () => slot.ready,
          catch: (cause) => cause
        }).pipe(Effect.result)
        if (Result.isFailure(ready)) {
          yield* Effect.promise(() => retire(slot))
          return yield* Effect.fail(
            StorageFailure.make({
              operation: `session-exec.worker: the sandbox worker did not start: ${String(ready.failure)}`
            })
          )
        }
        counts.jobs += 1
        counts.busy += 1
        const outcome = yield* post(slot, job, deadlineMs).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              counts.busy -= 1
            })
          )
        )
        switch (outcome.kind) {
          case "answered":
            idle.push(slot)
            return outcome.run
          case "killed":
            counts.killed += 1
            yield* Effect.promise(() => retire(slot))
            yield* Effect.logWarning(
              `session exec: a sandbox run passed its ${String(deadlineMs)} ms deadline; its worker was terminated`
            )
            return {
              exitCode: 124,
              stdout: "",
              stderr: killedStderr(deadlineMs),
              durationMs: deadlineMs,
              changed: [],
              vanished: [],
              skippedGitDir: false
            }
          case "failed":
            yield* Effect.promise(() => retire(slot))
            return yield* Effect.fail(
              StorageFailure.make({
                operation: `session-exec.worker: the sandbox worker failed: ${outcome.reason}`
              })
            )
        }
      })

    const runner =
      (waitMs: number): SandboxRunner =>
      (job, bounds) =>
        Effect.acquireUseRelease(
          permits.take(1).pipe(Effect.timeoutOption(waitMs)),
          (taken) =>
            Option.isSome(taken)
              ? runOn(job, bounds.deadlineMs)
              : Effect.fail(StorageFailure.make({ operation: EXEC_BUSY })),
          (taken) => (Option.isSome(taken) ? permits.release(1) : Effect.void)
        )

    return {
      runner,
      stats: () => ({
        size,
        idle: idle.length,
        busy: counts.busy,
        started: counts.started,
        killed: counts.killed,
        jobs: counts.jobs
      })
    }
  })

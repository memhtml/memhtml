import { Effect } from "effect"

import {
  defaultExecPoolSize,
  EXEC_POOL_SIZE_MAX,
  EXEC_POOL_SIZE_VAR,
  EXEC_WORKER_HEAP_VAR,
  parsePoolSetting,
  WORKER_HEAP_MB,
  WORKER_HEAP_MB_MAX,
  WORKER_HEAP_MB_MIN
} from "./exec-pool.js"
import { EMBED_WARM_IDLE_DEFAULT_MS, EMBED_WARM_IDLE_VAR } from "./head-protocol.js"
import { parseDeadlineMs } from "./head-vectors.js"
import { storeConfigReport } from "./store-config.js"

/**
 * `memhtml config`: the policy a store runs under and the process tuning this environment sets,
 * each value with where it came from. Read-only, and it builds no app layer: it reads the store's
 * `memhtml.config.json` (`store-config.ts`), asks git whether that file is committed, and reads the
 * environment.
 *
 * The two halves differ in who must agree. Every process on a store reads the store half from one
 * file, so it is the same for all of them; the process half is this environment's, read by `head
 * serve` alone, and a server started elsewhere may run with other values.
 */

/** One process variable as `head serve` would read it in this environment. */
export interface ProcessSetting {
  /** The effective value, or `null` when the variable is set to something `head serve` refuses. */
  readonly value: number | null
  readonly source: "env" | "default"
  /** The one command that reads the variable. */
  readonly readBy: "head serve"
  /** Why `head serve` would refuse to start, when the variable is malformed. */
  readonly problem?: string
}

const setting = (
  raw: string | undefined,
  fallback: number,
  parse: (text: string) => { ok: true; value: number } | { ok: false; reason: string }
): ProcessSetting => {
  if (raw === undefined || raw.trim() === "") {
    return { value: fallback, source: "default", readBy: "head serve" }
  }
  const parsed = parse(raw)
  return parsed.ok
    ? { value: parsed.value, source: "env", readBy: "head serve" }
    : {
        value: null,
        source: "env",
        readBy: "head serve",
        problem: `${JSON.stringify(raw)}: ${parsed.reason}; head serve refuses to start with it`
      }
}

/**
 * The process half: the embed warmup's idle bound, the exec pool's size (this host's default when
 * unset), and each exec worker's heap limit. `env` is a parameter so a test can name one.
 */
export const processTuning = (
  env: NodeJS.ProcessEnv = process.env
): Readonly<Record<string, ProcessSetting>> => ({
  [EMBED_WARM_IDLE_VAR]: setting(env[EMBED_WARM_IDLE_VAR], EMBED_WARM_IDLE_DEFAULT_MS, (text) => {
    const parsed = parseDeadlineMs(text)
    return parsed.ok ? { ok: true, value: parsed.ms } : parsed
  }),
  [EXEC_POOL_SIZE_VAR]: setting(env[EXEC_POOL_SIZE_VAR], defaultExecPoolSize(), (text) =>
    parsePoolSetting(text, 1, EXEC_POOL_SIZE_MAX)
  ),
  [EXEC_WORKER_HEAP_VAR]: setting(env[EXEC_WORKER_HEAP_VAR], WORKER_HEAP_MB, (text) =>
    parsePoolSetting(text, WORKER_HEAP_MB_MIN, WORKER_HEAP_MB_MAX)
  )
})

/**
 * The `config.report` payload: `file` (the policy file's path, whether it exists, and its git
 * state), `store` (each policy key's value and source, `file` or `default`), and `process` (each
 * tuning variable's value and source, `env` or `default`). A policy file that does not decode is
 * `StoreConfigInvalid`, as it is for every command that reads it.
 */
export const configReport = (root: string, env: NodeJS.ProcessEnv = process.env) =>
  storeConfigReport(root).pipe(Effect.map((report) => ({ ...report, process: processTuning(env) })))

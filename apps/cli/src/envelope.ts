/**
 * The machine contract. `apiVersion` lets the envelope evolve without silently
 * breaking parsers, and `type` is a discriminator an agent reads to know the
 * shape of `data` before parsing it.
 */
export const API_VERSION = "1"

/**
 * Append-only, like `ERROR_CODES`. A discriminator's meaning is fixed once shipped;
 * a new payload shape gets a new discriminator rather than reusing one.
 */
export const RESPONSE_TYPES = [
  "cli.manifest",
  "memory.written",
  "memory.detail",
  "memory.hits",
  "recall.pack",
  "index.report",
  "trace.sessions",
  "sleep.report",
  "sleep.review",
  "eval.discrimination",
  "doctor.report",
  "status.health",
  "repo.init",
  "memory.corrected",
  "memory.linked",
  "memory.neighbors",
  "memory.archived",
  "memory.reinforced",
  "memory.list",
  "trace.report",
  "trace.links",
  "sleep.merge",
  "agents.doc",
  "serve.exit",
  "publish.report",
  "state.export",
  "state.import",
  "task.written",
  "task.updated",
  "task.list",
  "batch.applied",
  "exec.report",
  "entity.activity",
  "memory.resolved",
  "sleep.plan",
  "cli.help"
] as const

export type ResponseType = (typeof RESPONSE_TYPES)[number]

export interface Success<A> {
  readonly apiVersion: typeof API_VERSION
  readonly type: ResponseType
  readonly data: A
}

export interface Failure {
  readonly apiVersion: typeof API_VERSION
  readonly error: string
  readonly code: ErrorCode
  readonly suggestions: ReadonlyArray<string>
}

/**
 * Append-only. Once shipped, a code's meaning never changes and a code is never
 * removed; new conditions get new codes. Agents branch on `code`, never on the
 * human `error` string, which changes freely as wording improves.
 */
export const ERROR_CODES = [
  "ERR_UNKNOWN_COMMAND",
  "ERR_MISSING_ARGUMENT",
  "ERR_INVALID_FLAG",
  // A positional past what the command declares. Distinct from `ERR_INVALID_FLAG` because the
  // offending token is not a flag, and distinct from `ERR_MISSING_ARGUMENT` because it is surplus
  // rather than absent: the caller drops a word instead of adding one.
  "ERR_UNEXPECTED_ARGUMENT",
  // The call opens a repo, names none with `--repo`, and `MEMHTML_REFUSE_ENV_ROOT` forbids reading
  // one from the environment. A usage code, since the fix is on the line rather than in the store.
  "ERR_REPO_REQUIRED",
  "ERR_PATH_NOT_FOUND",
  "ERR_INVALID_MEMORY",
  "ERR_DUPLICATE_CONTENT",
  "ERR_WRITE_CONFLICT",
  "ERR_DIRTY_TREE",
  "ERR_INDEX_STALE",
  "ERR_EMBED_MODEL_MISMATCH",
  "ERR_MODEL_UNAVAILABLE",
  "ERR_STORAGE",
  "ERR_GIT",
  "ERR_DISCRIMINATION_FAILED",
  "ERR_UNKNOWN"
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Exit codes stay stable so a shell caller can branch without parsing output. */
export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_RUNTIME = 1

export const succeed = <A>(type: ResponseType, data: A): Success<A> => ({
  apiVersion: API_VERSION,
  type,
  data
})

export const fail = (
  code: ErrorCode,
  error: string,
  suggestions: ReadonlyArray<string> = []
): Failure => ({ apiVersion: API_VERSION, error, code, suggestions })

/** Levenshtein distance, used for "did you mean" suggestions. */
const distance = (a: string, b: string): number => {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, index) => index)

  for (let row = 1; row < rows; row += 1) {
    const current = [row, ...Array.from({ length: cols - 1 }, () => 0)]
    for (let col = 1; col < cols; col += 1) {
      const substitution = (previous[col - 1] as number) + (a[row - 1] === b[col - 1] ? 0 : 1)
      const insertion = (current[col - 1] as number) + 1
      const deletion = (previous[col] as number) + 1
      current[col] = Math.min(substitution, insertion, deletion)
    }
    previous = current
  }

  return previous[cols - 1] as number
}

/** Nearest known names, so an unknown argument returns candidates rather than a dead end. */
export const nearest = (
  input: string,
  known: ReadonlyArray<string>,
  limit = 3
): ReadonlyArray<string> =>
  known
    .map((candidate) => ({
      candidate,
      score: distance(input.toLowerCase(), candidate.toLowerCase())
    }))
    .filter((entry) => entry.score <= Math.max(2, Math.ceil(input.length / 2)))
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((entry) => entry.candidate)

/**
 * `--dense` drops nulls and indentation so an agent pasting output into a prompt
 * spends tokens on content rather than decoration.
 */
const stripNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripNulls)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => [key, stripNulls(entry)])
    )
  }
  return value
}

export const render = (payload: Success<unknown> | Failure, dense: boolean): string =>
  dense ? JSON.stringify(stripNulls(payload)) : JSON.stringify(payload, null, 2)

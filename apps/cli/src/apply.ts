import { readFile } from "node:fs/promises"

import { type ErrorCode, type Failure, fail } from "./envelope.js"
import type { BatchOpReport, BatchWriteResult, WriteParams } from "./operations.js"
import { claimFromProse, proseTail } from "./prose.js"

/**
 * `memhtml apply`'s own layer: JSONL text in, decoded ops or a usage failure out.
 *
 * Separated from `run.ts` because everything here is a decision about one untrusted text format, and
 * because AC-6-4's contract is that the whole file is judged before any op executes. That makes
 * this a pure function from text to either an op list or a refusal, testable without a repo.
 *
 * The refusals are `Failure` values rather than thrown errors for the reason `validate` returns one:
 * the exit code is the contract. A usage error is exit 2 and a runtime error is exit 1, and a
 * malformed line is a usage error, because the caller wrote a bad file and the corpus is fine.
 */

/**
 * The op vocabulary, v1.
 *
 * Writes only, per spec D4. `op` is carried on the wire anyway so v2 can add `correct`/`link`/
 * `archive` without a format break. An unknown value is refused with this list attached rather than
 * ignored, because a file of `{"op":"wrote",…}` lines that applied nothing and exited 0 is the silent
 * failure the whole pre-validation pass exists to prevent.
 */
export const APPLY_OPS: ReadonlyArray<string> = ["write"]

/**
 * Every field a line may carry, mapped to the `WriteParams` field it becomes.
 *
 * A table rather than a hand-written decode, so the snake_case → camelCase rename is stated once and
 * the unknown-field check below is derived from it. The MCP tool's parameters use exactly these
 * snake_case names (`apps/mcp/src/tools.ts`), so an agent that learned the field names from one door
 * can write a JSONL file for the other without translating.
 */
const SCALAR_FIELDS = {
  title: "title",
  type: "memoryType",
  body: "body",
  article_html: "articleHtml",
  path: "path",
  workspace: "workspace",
  importance: "importance",
  confidence: "confidence",
  session_id: "sessionId",
  prompt_id: "promptId",
  turn_uuid: "turnUuid",
  status: "taskStatus",
  due: "dueAt"
} as const

/** Fields that accept a string or an array of strings, and always become an array. */
const LIST_FIELDS = { tag: "tags", tags: "tags", entity: "entities", entities: "entities" } as const

/** `op` is the discriminator rather than a `WriteParams` field, so it is legal and never mapped. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "op",
  ...Object.keys(SCALAR_FIELDS),
  ...Object.keys(LIST_FIELDS)
])

/** A usage failure naming the offending line, 1-based as a text editor counts. */
const lineError = (
  code: ErrorCode,
  line: number,
  reason: string,
  suggestions: ReadonlyArray<string> = []
): Failure => fail(code, `${APPLY_DOC}: line ${line}: ${reason}`, suggestions)

/** The prefix every apply refusal carries, so a caller can tell a file error from a corpus error. */
const APPLY_DOC = "memhtml apply"

/** One line's parsed JSON as a record, or the refusal. */
const objectAt = (text: string, line: number): Record<string, unknown> | Failure => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return lineError(
      "ERR_INVALID_FLAG",
      line,
      `not valid JSON (${error instanceof Error ? error.message : String(error)}). Every line is one complete JSON object; a pretty-printed object spanning several lines is not JSONL`,
      [
        'memhtml apply --file ops.jsonl, one object per line: {"op":"write","title":"…","type":"semantic","body":"…"}'
      ]
    )
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return lineError(
      "ERR_INVALID_FLAG",
      line,
      `parsed as ${Array.isArray(value) ? "an array" : typeof value}, not a JSON object`
    )
  }
  return value as Record<string, unknown>
}

const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && "code" in value && "error" in value

/** A field that must be a non-empty string, or the refusal naming it. */
const requiredString = (
  record: Record<string, unknown>,
  field: string,
  line: number
): string | Failure => {
  const value = record[field]
  if (value === undefined) {
    return lineError("ERR_MISSING_ARGUMENT", line, `missing required field \`${field}\``)
  }
  if (typeof value !== "string" || value.trim() === "") {
    return lineError(
      "ERR_INVALID_FLAG",
      line,
      `\`${field}\` must be a non-empty string, got ${value === null ? "null" : typeof value}`
    )
  }
  return value
}

/** A list field as an array of strings: a bare string is a one-element list, as `--tag` is. */
const strings = (value: unknown, field: string, line: number): Array<string> | Failure => {
  if (typeof value === "string") return value === "" ? [] : [value]
  if (!Array.isArray(value)) {
    return lineError(
      "ERR_INVALID_FLAG",
      line,
      `\`${field}\` must be a string or an array of strings, got ${typeof value}`
    )
  }
  const out: Array<string> = []
  for (const entry of value) {
    if (typeof entry !== "string") {
      return lineError(
        "ERR_INVALID_FLAG",
        line,
        `\`${field}\` holds a ${typeof entry} where every element must be a string`
      )
    }
    if (entry !== "") out.push(entry)
  }
  return out
}

/** A numeric field, accepting the JSON number or a numeric string. */
const numeric = (value: unknown, field: string, line: number): number | Failure => {
  const parsed = typeof value === "number" ? value : Number(value)
  if (typeof value !== "number" && typeof value !== "string") {
    return lineError("ERR_INVALID_FLAG", line, `\`${field}\` must be a number, got ${typeof value}`)
  }
  if (!Number.isFinite(parsed)) {
    return lineError(
      "ERR_INVALID_FLAG",
      line,
      `\`${field}\` is not a finite number: ${String(value)}`
    )
  }
  return parsed
}

/**
 * One line as a `WriteParams`, or the refusal naming the line.
 *
 * The shape rules AC-6-4 puts at this door and nowhere else: the line parses, it declares an op in
 * the vocabulary, and it carries `title` and `type` as non-empty strings. Everything past that is
 * the operations layer's decode (is `type` in the vocabulary) or the store's render gate (is the
 * markup valid). Those are checked per op and reported per op, and they are not duplicated here,
 * because a second copy of the type vocabulary is a second thing to update when it moves.
 */
const opAt = (record: Record<string, unknown>, line: number): WriteParams | Failure => {
  for (const field of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(field)) {
      return lineError(
        "ERR_INVALID_FLAG",
        line,
        `unknown field \`${field}\`. Fields: ${[...KNOWN_FIELDS].sort().join(", ")}`
      )
    }
  }

  const op = record.op
  if (op === undefined) {
    return lineError(
      "ERR_MISSING_ARGUMENT",
      line,
      `missing required field \`op\`. One of: ${APPLY_OPS.join(", ")}`
    )
  }
  if (typeof op !== "string" || !APPLY_OPS.includes(op)) {
    return lineError(
      "ERR_INVALID_FLAG",
      line,
      `\`op\` must be one of: ${APPLY_OPS.join(", ")}, got ${JSON.stringify(op)}`
    )
  }

  const title = requiredString(record, "title", line)
  if (isFailure(title)) return title
  const memoryType = requiredString(record, "type", line)
  if (isFailure(memoryType)) return memoryType

  const params: Record<string, unknown> = { title, memoryType, claim: "" }

  for (const [field, target] of Object.entries(SCALAR_FIELDS)) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (field === "title" || field === "type") continue
    if (target === "importance" || target === "confidence") {
      const parsed = numeric(value, field, line)
      if (isFailure(parsed)) return parsed
      params[target] = parsed
      continue
    }
    if (typeof value !== "string") {
      return lineError(
        "ERR_INVALID_FLAG",
        line,
        `\`${field}\` must be a string, got ${typeof value}`
      )
    }
    params[target] = value
  }

  for (const [field, target] of Object.entries(LIST_FIELDS)) {
    const value = record[field]
    if (value === undefined || value === null) continue
    const parsed = strings(value, field, line)
    if (isFailure(parsed)) return parsed
    params[target] = [...((params[target] as Array<string> | undefined) ?? []), ...parsed]
  }

  /**
   * `body` prose becomes claim + tail; `article_html` is used verbatim and leaves `claim` empty.
   *
   * The XOR itself is not enforced here. The store's render gate owns it per op, so a batch with one
   * bad op reports that op and not the whole file. This branch owns the claim instead: the JSONL wire
   * has no `claim` field, so a prose line's claim is derived rather than restated by its author (see
   * {@link claimFromProse}, the one copy both doors share).
   *
   * Skipping this cannot land a bad file. `@memhtml/html` constraint 1 rejects an empty `<mark>`,
   * so the render gate would stop the op instead of committing a file with an empty `files.gist`.
   * The derivation is what makes a prose line valid in the first place; the render gate is the
   * guard between a missing claim and a silent write.
   */
  const prose = typeof params.body === "string" ? (params.body as string) : undefined
  if (prose !== undefined && prose.trim() !== "") {
    params.claim = claimFromProse(prose)
    params.body = proseTail(prose)
  } else if (prose !== undefined) {
    delete params.body
  }

  return params as unknown as WriteParams
}

/** What a whole-file decode produced: the ops, or the first line that refused. */
export type ApplyDecode =
  | { readonly ok: true; readonly ops: ReadonlyArray<WriteParams> }
  | { readonly ok: false; readonly failure: Failure }

/**
 * Decode a whole JSONL document, refusing on the first bad line.
 *
 * Every line is judged before any op runs (AC-6-4), and that ordering is the contract rather than an
 * implementation detail. An apply that executed lines 1-6 and then refused line 7 would leave a
 * commit behind for a call that reported failure, and the caller's only recovery would be to work out
 * which prefix landed. Refusing first costs nothing, since no service has been touched yet.
 *
 * Blank lines are skipped rather than refused, because a file written by `printf '%s\n'` or a heredoc
 * ends in one. The line numbers still count them, so an error naming line 7 means the seventh
 * line of the file the caller can open in an editor.
 */
export const decodeApply = (text: string): ApplyDecode => {
  const ops: Array<WriteParams> = []
  const lines = text.split("\n")

  for (const [at, raw] of lines.entries()) {
    const line = at + 1
    if (raw.trim() === "") continue
    const record = objectAt(raw, line)
    if (isFailure(record)) return { ok: false, failure: record }
    const op = opAt(record, line)
    if (isFailure(op)) return { ok: false, failure: op }
    ops.push(op)
  }

  if (ops.length === 0) {
    return {
      ok: false,
      failure: fail(
        "ERR_MISSING_ARGUMENT",
        `${APPLY_DOC}: no ops. The input held no non-blank lines, so there is nothing to write`,
        [
          "memhtml apply --file ops.jsonl",
          'printf \'%s\\n\' \'{"op":"write","title":"A fact","type":"semantic","body":"The thing that happened."}\' | memhtml apply -'
        ]
      )
    }
  }

  return { ok: true, ops }
}

/**
 * Read the JSONL text for one invocation: `--file <path>`, or stdin.
 *
 * **The stdin seam.** `run()` takes this reader as an injectable parameter and defaults to
 * {@link readStdin}, so `bin.ts` needs no edit and a test supplies the text directly. Reading stdin
 * in `bin.ts` instead would make the entry point parse argv to discover whether
 * the command it is about to dispatch even wants stdin, and would put an I/O decision in the one file
 * whose whole job is "call run, write the envelope, exit".
 */
export const applyText = async (
  file: string | undefined,
  stdin: () => Promise<string>
): Promise<string | Failure> => {
  if (file !== undefined && file.trim() !== "") {
    try {
      return await readFile(file, "utf8")
    } catch (error) {
      return fail(
        "ERR_PATH_NOT_FOUND",
        `${APPLY_DOC}: cannot read --file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        [`ls ${file}`, "memhtml apply - < ops.jsonl"]
      )
    }
  }
  return await stdin()
}

/**
 * `process.stdin` as text, and nothing when a human is at a terminal.
 *
 * The TTY check is what makes a bare `memhtml apply` with no `--file` and no pipe answer with the
 * empty-input usage error instead of hanging forever waiting on a keyboard. An agent invoking this
 * without a pipe gets an envelope; a hang would get a timeout and no diagnosis.
 */
export const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY === true) return ""
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * The `batch.applied` payload: the operation's result, renamed to the wire's snake_case.
 *
 * snake_case here and camelCase in `memory.written` is a real inconsistency, and it comes from the
 * spec (D6 names `commit_sha`). It was taken on purpose, because it makes this payload byte-comparable
 * with `memory_write_batch`'s over MCP. An agent that has parsed one has parsed the other, and a batch
 * result is the payload most likely to be handled by shared code across the two doors.
 *
 * Absent fields are `null` rather than missing. `deduped` and `skipped` are always booleans. An agent
 * branching on `deduped === true` should not have to also handle the key being absent, and `--dense`
 * strips the nulls for the context-window case anyway.
 */
const opPayload = (report: BatchOpReport) => ({
  index: report.index,
  ok: report.ok,
  path: report.path ?? null,
  deduped: report.deduped === true,
  existing_path: report.existingPath ?? null,
  code: report.code ?? null,
  error: report.error ?? null,
  skipped: report.skipped === true,
  /**
   * What this op's claim contradicts, when `--detect-conflicts` was passed and something matched.
   *
   * The inner field names are snake_case (`batch_index`) for the same reason the outer ones are: this
   * payload is byte-comparable with `memory_write_batch`'s, so shared code across the two doors reads
   * one shape. Null when the flag was off, when nothing matched, or when the claim has no frame
   * shape. An op carrying a conflict was still written, because the field is a report rather than a
   * refusal.
   */
  conflict:
    report.conflict === undefined
      ? null
      : {
          path: report.conflict.path,
          batch_index: report.conflict.batchIndex,
          claim: report.conflict.claim
        },
  /**
   * The two `--consolidate last-wins` outcomes, null everywhere else, including when the flag was
   * off. That is the same "absent is null" rule every field above follows, and the same shape
   * `memory_write_batch` publishes.
   */
  consolidated_into: report.consolidatedInto ?? null,
  superseded_path: report.supersededPath ?? null
})

export const applyPayload = (result: BatchWriteResult) => ({
  results: result.results.map(opPayload),
  summary: result.summary,
  commit_sha: result.commitSha
})

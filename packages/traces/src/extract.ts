/**
 * Session-JSONL extraction as a pure fold over lines.
 *
 * Every field is read defensively and nothing here throws, because another process writes a session
 * file concurrently and may truncate it mid-line at any moment. The fold is separated from the
 * stream (`parse.ts`) so the whole extraction contract is testable from string literals and
 * per-line memory stays flat. A 37 MB session costs the same as a 4 KB one.
 */

/**
 * Record types the parser reads. Applied as an allowlist *before* any field access, because the
 * bare types carry no envelope. Reaching for `record.cwd` on a `file-history-snapshot` would read
 * a field that does not exist, on a record that is not about a session at all.
 */
export const READ_RECORD_TYPES = [
  "user",
  "assistant",
  "system",
  "attachment",
  "agent-name",
  "ai-title",
  "pr-link"
] as const

/**
 * Counted and skipped, never an error. `file-history-snapshot` and `file-history-delta` carry no
 * `sessionId` and no envelope at all (probed on 5,387 real files, 2026-08-01: their keys are
 * `{isSnapshotUpdate, messageId, snapshot, type}` and
 * `{backup, messageId, snapshotMessageId, trackingPath, timestamp, type}`), so a record with no
 * session key is dropped rather than treated as malformed input.
 */
export const SKIP_RECORD_TYPES = [
  "last-prompt",
  "mode",
  "permission-mode",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta"
] as const

export type ReadRecordType = (typeof READ_RECORD_TYPES)[number]
export type SkipRecordType = (typeof SKIP_RECORD_TYPES)[number]

const READ_SET: ReadonlySet<string> = new Set(READ_RECORD_TYPES)
const SKIP_SET: ReadonlySet<string> = new Set(SKIP_RECORD_TYPES)

/** `traces.first_prompt` is an index entry, not a copy of the prompt. */
export const FIRST_PROMPT_LIMIT = 500

/** `trace_prompts.text_head` is an index entry, not a copy of the prompt. */
export const TEXT_HEAD_LIMIT = 200

/** The placeholder model id the runtime emits for a non-model turn; never a session's model. */
export const SYNTHETIC_MODEL = "<synthetic>"

/**
 * How many lines each disposition claimed. Every line lands in exactly one counter, so
 * `parsedLines + droppedLines` is the number of non-empty lines the scan consumed.
 *
 * - `parsedLines`: decoded to a JSON object, whatever happened afterwards.
 * - `droppedLines`: undecodable JSON, or decoded to something that is not an object with a
 *   string `type`. Counted rather than fatal, so one bad line does not abandon the file.
 * - `droppedNoSession`: a read-type record with no string `sessionId`. Subset of `parsedLines`.
 * - `skippedTypeLines`: a {@link SKIP_RECORD_TYPES} type. Subset of `parsedLines`.
 * - `unknownTypeLines`: a type in neither list, meaning a record type the runtime added after
 *   this allowlist was written. Subset of `parsedLines`, and the counter to watch when a new
 *   Claude Code release lands.
 */
export interface ParseCounters {
  readonly parsedLines: number
  readonly droppedLines: number
  readonly droppedNoSession: number
  readonly skippedTypeLines: number
  readonly unknownTypeLines: number
}

/**
 * One `trace_prompts` row (design §3.3), minus the `session_id` the enclosing
 * {@link SessionExtract} carries.
 */
export interface PromptRow {
  readonly promptId: string
  /** The `uuid` of the first user record carrying this `promptId`, the `(sessionId, uuid)` cite. */
  readonly turnUuid: string
  /**
   * 0-based position of this prompt among the distinct prompts of **this session**, in
   * first-appearance order. Per-session scope, so it is comparable only within one `session_id`.
   */
  readonly ordinal: number
  /** ISO-8601 UTC instant of the prompt's first record. */
  readonly at: string
  /** Set only on a subagent sidecar's records. */
  readonly agentId: string | null
  /** First {@link TEXT_HEAD_LIMIT} characters of the prompt's text, whitespace-collapsed. */
  readonly textHead: string
}

/**
 * Everything one session file yields: the `traces` row's content fields, its prompt rows, and the
 * scan's counters. `file_size`/`file_mtime`/`indexed_at` are absent. They belong to the stat the
 * watermark already took, and duplicating them would give the same fact two sources.
 */
export interface SessionExtract {
  /** Absolute path of the file scanned. */
  readonly filePath: string
  /**
   * The `~/.claude/projects/<slug>` directory name, which is a *path* slug. The `slug` field on a
   * subagent record is a title slug for the agent's task, and is a different fact entirely.
   */
  readonly slug: string
  /** From the first record carrying one, bare types included. `null` when the file has none. */
  readonly sessionId: string | null
  readonly cwd: string | null
  readonly gitBranch: string | null
  readonly entrypoint: string | null
  readonly version: string | null
  /** Most frequent `message.model` on assistant records, excluding {@link SYNTHETIC_MODEL}. */
  readonly model: string | null
  /** Earliest record instant, ISO-8601 UTC. */
  readonly startedAt: string | null
  /** Latest record instant, ISO-8601 UTC. */
  readonly endedAt: string | null
  /** Distinct `promptId` count on user records. Equals `prompts.length`. */
  readonly promptCount: number
  /** Enveloped records, meaning those carrying a `uuid`. A `pr-link` has a session but no turn. */
  readonly turnCount: number
  /** Distinct `agentId` seen in this file, first-appearance order. Empty for a main session. */
  readonly agentIds: ReadonlyArray<string>
  readonly firstPrompt: string
  readonly aiTitle: string | null
  readonly prompts: ReadonlyArray<PromptRow>
  readonly counters: ParseCounters
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

/**
 * An instant in canonical ISO-8601 UTC with milliseconds, or `null` when unparseable.
 *
 * `traces.started_at` is `TEXT` under an index (design §3.3), so ordering is lexicographic.
 * A `+09:00`-offset timestamp would sort as *later* than a `Z` instant five hours after it, and
 * every range query over that index would be wrong. Canonicalizing here is the one place that
 * cannot be forgotten later. The sampled corpus is already uniformly `Z`, so this normally only
 * pads `…:01Z` to `…:01.000Z`.
 */
const toIsoUtc = (value: unknown): string | null => {
  const raw = asString(value)
  if (raw === null) return null
  const epochMs = Date.parse(raw)
  return Number.isNaN(epochMs) ? null : new Date(epochMs).toISOString()
}

/** Collapse whitespace runs to single spaces and trim. This is FTS input, not a transcript. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

/**
 * The text of a user record's `message.content`, or `""` when it carries none.
 *
 * Content arrives in two shapes and both hold real prompt text: a bare string, and a block list
 * whose `text` blocks are joined. Probed 2026-08-02: of the distinct prompts in six large
 * sessions, the block-list form was the first appearance for 24 of 30 in one file and 34 of 38 in
 * another, so a string-only rule would leave `first_prompt` empty for most sessions.
 *
 * A `tool_result`-only list yields `""`, because a tool's output is not something the user said.
 */
export const userText = (message: unknown): string => {
  const record = asRecord(message)
  if (record === null) return ""

  const content = record["content"]
  if (typeof content === "string") return collapse(content)
  if (!Array.isArray(content)) return ""

  const parts: Array<string> = []
  for (const block of content) {
    const asBlock = asRecord(block)
    if (asBlock === null || asBlock["type"] !== "text") continue
    const text = asBlock["text"]
    if (typeof text === "string") parts.push(text)
  }
  return collapse(parts.join("\n"))
}

/** Mutable fold state. Private, so callers see {@link SessionExtract} only. */
interface Accumulator {
  sessionId: string | null
  cwd: string | null
  gitBranch: string | null
  entrypoint: string | null
  version: string | null
  aiTitle: string | null
  firstPrompt: string
  minEpochMs: number | null
  maxEpochMs: number | null
  minIso: string | null
  maxIso: string | null
  turnCount: number
  parsedLines: number
  droppedLines: number
  droppedNoSession: number
  skippedTypeLines: number
  unknownTypeLines: number
  readonly modelCounts: Map<string, number>
  readonly agentIds: Set<string>
  readonly prompts: Map<string, { row: PromptRow; hasText: boolean }>
}

/** A fold state with nothing seen yet. */
export const emptyAccumulator = (): Accumulator => ({
  sessionId: null,
  cwd: null,
  gitBranch: null,
  entrypoint: null,
  version: null,
  aiTitle: null,
  firstPrompt: "",
  minEpochMs: null,
  maxEpochMs: null,
  minIso: null,
  maxIso: null,
  turnCount: 0,
  parsedLines: 0,
  droppedLines: 0,
  droppedNoSession: 0,
  skippedTypeLines: 0,
  unknownTypeLines: 0,
  modelCounts: new Map(),
  agentIds: new Set(),
  prompts: new Map()
})

export type { Accumulator }

/**
 * Fold one raw line into the accumulator. Total, so every input either updates state or a counter,
 * and no input throws. A blank line is not a record and is not counted.
 *
 * Mutates and returns `accumulator`. A fresh object per line would allocate once per line of a
 * 3.67 GB corpus.
 */
export const foldLine = (accumulator: Accumulator, line: string): Accumulator => {
  if (line.trim() === "") return accumulator

  let decoded: unknown
  try {
    decoded = JSON.parse(line)
  } catch {
    accumulator.droppedLines += 1
    return accumulator
  }

  const record = asRecord(decoded)
  // The allowlist decision needs `type` and nothing else; a record without one is unusable.
  const type = record === null ? null : asString(record["type"])
  if (record === null || type === null) {
    accumulator.droppedLines += 1
    return accumulator
  }

  accumulator.parsedLines += 1

  if (SKIP_SET.has(type)) {
    accumulator.skippedTypeLines += 1
    return accumulator
  }
  if (!READ_SET.has(type)) {
    accumulator.unknownTypeLines += 1
    return accumulator
  }

  const sessionId = asString(record["sessionId"])
  if (sessionId === null) {
    accumulator.droppedNoSession += 1
    return accumulator
  }
  accumulator.sessionId ??= sessionId

  const at = toIsoUtc(record["timestamp"])
  if (at !== null) {
    const epochMs = Date.parse(at)
    if (accumulator.minEpochMs === null || epochMs < accumulator.minEpochMs) {
      accumulator.minEpochMs = epochMs
      accumulator.minIso = at
    }
    if (accumulator.maxEpochMs === null || epochMs > accumulator.maxEpochMs) {
      accumulator.maxEpochMs = epochMs
      accumulator.maxIso = at
    }
  }

  const agentId = asString(record["agentId"])
  if (agentId !== null) accumulator.agentIds.add(agentId)

  // `ai-title` is re-emitted as the title is refined, up to 343 times in one probed session with
  // 3 distinct values, so the last emission holds the current title and the first does not.
  if (type === "ai-title") {
    accumulator.aiTitle = asString(record["aiTitle"]) ?? accumulator.aiTitle
    return accumulator
  }

  const uuid = asString(record["uuid"])
  if (uuid === null) return accumulator

  // Enveloped from here down. A `uuid` is what makes a record a turn in the parentUuid DAG.
  accumulator.turnCount += 1
  accumulator.cwd ??= asString(record["cwd"])
  accumulator.gitBranch ??= asString(record["gitBranch"])
  accumulator.entrypoint ??= asString(record["entrypoint"])
  accumulator.version ??= asString(record["version"])

  if (type === "assistant") {
    const model = asString(asRecord(record["message"])?.["model"])
    if (model !== null && model !== SYNTHETIC_MODEL) {
      accumulator.modelCounts.set(model, (accumulator.modelCounts.get(model) ?? 0) + 1)
    }
    return accumulator
  }

  if (type !== "user") return accumulator

  const text = userText(record["message"])
  if (accumulator.firstPrompt === "" && text !== "") {
    accumulator.firstPrompt = text.slice(0, FIRST_PROMPT_LIMIT)
  }

  const promptId = asString(record["promptId"])
  if (promptId === null) return accumulator

  const existing = accumulator.prompts.get(promptId)
  if (existing === undefined) {
    accumulator.prompts.set(promptId, {
      row: {
        promptId,
        turnUuid: uuid,
        ordinal: accumulator.prompts.size,
        at: at ?? "",
        agentId,
        textHead: text.slice(0, TEXT_HEAD_LIMIT)
      },
      hasText: text !== ""
    })
    return accumulator
  }

  // Identity and order stay with the first record for this prompt. The text head is filled from
  // the first record that carries text. A prompt whose first record is a `tool_result` would
  // otherwise be indexed with an empty head while its text sits one record away.
  if (!existing.hasText && text !== "") {
    accumulator.prompts.set(promptId, {
      row: { ...existing.row, textHead: text.slice(0, TEXT_HEAD_LIMIT) },
      hasText: true
    })
  }
  return accumulator
}

/**
 * The most frequent model, or `null`. A tie goes to the model seen first, so the value is a
 * function of the file and not of `Map` iteration luck.
 */
const dominantModel = (counts: ReadonlyMap<string, number>): string | null => {
  let best: string | null = null
  let bestCount = 0
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model
      bestCount = count
    }
  }
  return best
}

/** Close the fold into the immutable extract. Pure with respect to the accumulator. */
export const finalizeExtract = (
  accumulator: Accumulator,
  file: { readonly filePath: string; readonly slug: string }
): SessionExtract => {
  const prompts = [...accumulator.prompts.values()]
    .map((entry) => entry.row)
    .sort((left, right) => left.ordinal - right.ordinal)

  return {
    filePath: file.filePath,
    slug: file.slug,
    sessionId: accumulator.sessionId,
    cwd: accumulator.cwd,
    gitBranch: accumulator.gitBranch,
    entrypoint: accumulator.entrypoint,
    version: accumulator.version,
    model: dominantModel(accumulator.modelCounts),
    startedAt: accumulator.minIso,
    endedAt: accumulator.maxIso,
    promptCount: prompts.length,
    turnCount: accumulator.turnCount,
    agentIds: [...accumulator.agentIds],
    firstPrompt: accumulator.firstPrompt,
    aiTitle: accumulator.aiTitle,
    prompts,
    counters: {
      parsedLines: accumulator.parsedLines,
      droppedLines: accumulator.droppedLines,
      droppedNoSession: accumulator.droppedNoSession,
      skippedTypeLines: accumulator.skippedTypeLines,
      unknownTypeLines: accumulator.unknownTypeLines
    }
  }
}

/**
 * Fold a whole JSONL text. The streaming reader in `parse.ts` is the production path; this is the
 * same fold for a string in hand.
 */
export const extractFromText = (
  text: string,
  file: { readonly filePath: string; readonly slug: string }
): SessionExtract => {
  const accumulator = emptyAccumulator()
  for (const line of text.split("\n")) foldLine(accumulator, line)
  return finalizeExtract(accumulator, file)
}

/**
 * The `agent_count` for a `traces` row: distinct agents named by the session's records unioned
 * with those named by its sidecar filenames (design §7). The union covers both sides, because an
 * agent's sidecar exists before its first record lands, and a resumed session's records can name
 * an agent whose sidecar has been pruned.
 */
export const agentCountFor = (
  extract: SessionExtract,
  sidecarAgentIds: ReadonlyArray<string>
): number => new Set([...extract.agentIds, ...sidecarAgentIds]).size

/**
 * The hook entries each host's config file needs, and the predicate that recognizes ours inside a file
 * other tools also write.
 *
 * Every entry runs the same engine — `memhtml hook <event> --host <host> --repo <root>` — so there is
 * one implementation to test and no shell script on disk to drift. Which events exist per host is a
 * vendor fact (docs read 2026-09-13), not a preference:
 *
 * - Claude Code injects stdout into context on `SessionStart` and `UserPromptSubmit`, and can only
 *   OBSERVE on `PreCompact` / `SessionEnd`, which is what the transcript indexer needs.
 * - Codex accepts the same two injecting events. It gets no compaction hook, because indexing a
 *   transcript needs a reader for that host's format and only Claude Code's exists.
 * - Cursor's `beforeSubmitPrompt` cannot inject context at all (it can only cancel a turn), so a
 *   per-prompt hook is NEVER installed for Cursor — installing one would spawn a process per prompt
 *   and throw the result away.
 * - OpenCode has no hooks file; it gets a generated plugin instead (`./plugin.ts`).
 */

import type { HookCommandOptions } from "../command-line.js"
import { hookCommand, shellJoin } from "../command-line.js"
import type { BinaryLocation, HookEvent, HookMode } from "../types.js"

/** One command handler inside a Claude Code or Codex hook group. */
export interface CommandHook {
  readonly type: "command"
  readonly command: string
  /** Seconds. A recall hook shares the turn's latency budget; an indexer does not. */
  readonly timeout: number
}

/**
 * One entry of a Claude Code / Codex event array. `matcher` is deliberately ABSENT: both hosts treat a
 * missing matcher as "every source", and writing `matcher: "*"` would make the entry look like a filter
 * that had been narrowed.
 */
export interface CommandHookGroup {
  readonly hooks: ReadonlyArray<CommandHook>
}

/** One entry of a Cursor event array: a bare command string, no group and no timeout field. */
export interface CursorHookEntry {
  readonly command: string
}

/** `hooks.json` for Cursor is versioned; the installer writes this when it creates the file. */
export const CURSOR_HOOKS_VERSION = 1

/** Seconds a context-injecting hook may take: it sits in front of the user's turn. */
const RECALL_TIMEOUT_SECONDS = 10

/** Seconds a transcript indexer may take: it runs after the turn and injects nothing. */
const INDEX_TIMEOUT_SECONDS = 30

const group = (command: string, timeout: number): CommandHookGroup => ({
  hooks: [{ type: "command", command, timeout }]
})

/**
 * Claude Code's `hooks` object in `~/.claude/settings.json` (or `.claude/settings.json` at project
 * scope). `PreCompact` and `SessionEnd` appear only when a transcript root is known, since the indexer
 * has nothing to read without one.
 */
export const claudeHooks = (
  binary: BinaryLocation,
  bare: boolean,
  mode: HookMode,
  opts: HookCommandOptions
): Record<string, Array<CommandHookGroup>> => {
  if (mode === "none") return {}
  const line = (event: HookEvent) => shellJoin(hookCommand(binary, bare, event, "claude", opts))
  const entries: Record<string, Array<CommandHookGroup>> = {
    SessionStart: [group(line("session-start"), RECALL_TIMEOUT_SECONDS)]
  }
  if (mode === "all") {
    entries.UserPromptSubmit = [group(line("user-prompt-submit"), RECALL_TIMEOUT_SECONDS)]
    if (opts.traceRoot !== undefined) {
      entries.PreCompact = [group(line("pre-compact"), INDEX_TIMEOUT_SECONDS)]
      entries.SessionEnd = [group(line("session-end"), INDEX_TIMEOUT_SECONDS)]
    }
  }
  return entries
}

/**
 * Codex's `hooks` object in `~/.codex/hooks.json`. Same entry shape and event names as Claude Code's,
 * and no compaction hook: there is no Codex transcript reader to index with.
 *
 * The entries stay inert until the operator trusts them in `/hooks` — trust is keyed to the hook's
 * hash, so nothing an installer writes can pre-approve itself. `integrations doctor` says so rather
 * than pretending to verify it.
 */
export const codexHooks = (
  binary: BinaryLocation,
  bare: boolean,
  mode: HookMode,
  opts: HookCommandOptions
): Record<string, Array<CommandHookGroup>> => {
  if (mode === "none") return {}
  const line = (event: HookEvent) => shellJoin(hookCommand(binary, bare, event, "codex", opts))
  const entries: Record<string, Array<CommandHookGroup>> = {
    SessionStart: [group(line("session-start"), RECALL_TIMEOUT_SECONDS)]
  }
  if (mode === "all") {
    entries.UserPromptSubmit = [group(line("user-prompt-submit"), RECALL_TIMEOUT_SECONDS)]
  }
  return entries
}

/**
 * Cursor's `hooks` object in `~/.cursor/hooks.json`, whose file wraps this as
 * `{ version: CURSOR_HOOKS_VERSION, hooks: … }`. One event only: `sessionStart` returns
 * `additional_context`, and it is the sole Cursor event that can put anything in front of the model.
 */
export const cursorHooks = (
  binary: BinaryLocation,
  bare: boolean,
  mode: HookMode,
  opts: HookCommandOptions
): Record<string, Array<CursorHookEntry>> => {
  if (mode === "none") return {}
  return {
    sessionStart: [
      { command: shellJoin(hookCommand(binary, bare, "session-start", "cursor", opts)) }
    ]
  }
}

/** Every `command` string reachable in one hook entry, whichever host's shape it is. */
const commandsOf = (entry: unknown): ReadonlyArray<string> => {
  if (typeof entry !== "object" || entry === null) return []
  const record = entry as { readonly command?: unknown; readonly hooks?: unknown }
  const found: Array<string> = []
  if (typeof record.command === "string") found.push(record.command)
  if (Array.isArray(record.hooks)) {
    for (const handler of record.hooks) {
      if (typeof handler === "object" && handler !== null) {
        const command = (handler as { readonly command?: unknown }).command
        if (typeof command === "string") found.push(command)
      }
    }
  }
  return found
}

/**
 * Is this entry from an existing hooks file one of OURS? Used by install to replace and by uninstall to
 * remove, so a human's own `SessionStart` hook survives both.
 *
 * The signal is the invocation itself: `" hook "` (with both spaces, so a path containing the word
 * `hook` cannot match) and, when a `binary` is given and it was not installed bare, the exact entry
 * script the receipt names. EVERY command in the entry must match — a group someone else has added a
 * second handler to is not ours to rewrite — and an entry carrying no command at all is never ours.
 */
export const claudeOwned = (entry: unknown, binary?: BinaryLocation, bare?: boolean): boolean => {
  const commands = commandsOf(entry)
  if (commands.length === 0) return false
  return commands.every(
    (command) =>
      command.includes(" hook ") &&
      (bare === true || binary === undefined || command.includes(binary.cli))
  )
}

/** Codex writes Claude Code's entry shape, so ownership is decided the same way. */
export const codexOwned = claudeOwned

/** Cursor's entry is a bare `{ command }`, which `commandsOf` already reads. */
export const cursorOwned = claudeOwned

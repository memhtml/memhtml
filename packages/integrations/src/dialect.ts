import type { HookEvent, HostId } from "./types.js"

/**
 * How each host reads a hook's stdout, per event, as of the vendor docs read 2026-09-13.
 *
 * Claude Code: plain stdout enters the model's context on `SessionStart` and `UserPromptSubmit`; the
 * other events ignore stdout (a `PreCompact`/`SessionEnd` hook can only observe). Codex: the same two
 * events accept `hookSpecificOutput.additionalContext` JSON, which is also valid Claude Code output, so
 * Codex gets the JSON form to be safe on both. Cursor: `sessionStart` returns `{additional_context}`;
 * `beforeSubmitPrompt` cannot inject at all, so a Cursor per-prompt hook is never installed and the
 * dialect returns nothing for it. OpenCode: the generated plugin calls this binary itself and pushes the
 * text as a message part, so the plugin wants plain text.
 *
 * An empty `text` renders as an empty string on every host: a hook that has nothing to add says nothing,
 * which every host treats as "no change".
 */
export const renderHookOutput = (host: HostId, event: HookEvent, text: string): string => {
  const body = text.trim()
  if (body.length === 0) return ""
  switch (host) {
    case "claude":
      return event === "session-start" || event === "user-prompt-submit" ? `${body}\n` : ""
    case "codex":
      return event === "session-start" || event === "user-prompt-submit"
        ? `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: CODEX_EVENT_NAMES[event],
              additionalContext: body
            }
          })}\n`
        : ""
    case "cursor":
      return event === "session-start" ? `${JSON.stringify({ additional_context: body })}\n` : ""
    case "opencode":
      return event === "session-start" || event === "user-prompt-submit" ? `${body}\n` : ""
  }
}

/** Codex spells its event names the way Claude Code does. */
export const CODEX_EVENT_NAMES: Readonly<Record<HookEvent, string>> = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "pre-compact": "PreCompact",
  "session-end": "SessionEnd"
}

/**
 * The prompt text inside a host's hook payload, for `user-prompt-submit`. Claude Code and Codex both
 * send `prompt`; the OpenCode plugin sends the same key by construction. Absent or blank means the
 * hook has nothing to search for and prints nothing.
 */
export const promptOf = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const prompt = (payload as { readonly prompt?: unknown }).prompt
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt : undefined
}

/**
 * The working directory a session runs in, when the payload carries one. Claude Code and Codex send
 * `cwd`; Cursor sends `workspace_roots` (the first is used); the OpenCode plugin sends `cwd`.
 */
export const cwdOf = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as { readonly cwd?: unknown; readonly workspace_roots?: unknown }
  if (typeof record.cwd === "string" && record.cwd.length > 0) return record.cwd
  if (Array.isArray(record.workspace_roots)) {
    const first = record.workspace_roots[0]
    if (typeof first === "string" && first.length > 0) return first
  }
  return undefined
}

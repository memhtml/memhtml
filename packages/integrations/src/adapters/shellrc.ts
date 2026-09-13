/**
 * `~/.zshrc` / `~/.bashrc`, edited inside the same comment fence Codex's `config.toml` uses.
 *
 * This one is opt-in (`memhtml integrations shell --write`) and serves a human running the CLI by hand:
 * the MCP entries carry their own `env`, so no host needs it. A shell rc is the file people are most
 * protective of, which is why nothing here reorders, dedupes, or interprets a single line outside the
 * fence — and why the markers are identical to the TOML ones rather than a second spelling to remember.
 */

import { fenced } from "./fenced.js"

export const SHELL_FENCE_START = "# MEMHTML:START"
export const SHELL_FENCE_END = "# MEMHTML:END"

const fence = fenced(SHELL_FENCE_START, SHELL_FENCE_END)

/** Replace the fenced snippet with `body`, or append it after a blank line. Malformed markers throw. */
export const upsertShellFence = (text: string | null, body: string): string =>
  fence.upsert(text, body)

/** Drop the fenced snippet and its separating blank line. `""` when the fence was the whole file. */
export const removeShellFence = (text: string | null): string => fence.remove(text)

/** The snippet we own, or `null` when the rc file carries no fence. Throws on malformed markers. */
export const readShellFence = (text: string | null): string | null => fence.read(text)

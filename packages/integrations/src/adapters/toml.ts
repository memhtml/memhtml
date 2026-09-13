/**
 * Codex's `~/.codex/config.toml`, edited as text inside a comment fence.
 *
 * No TOML library, and that is a decision rather than a shortcut. A parse-and-serialize round trip
 * rewrites the whole file in the library's own style — it reorders tables, drops the operator's comments,
 * and renormalizes strings — so a one-key install would show up as a hundred-line diff in a file people
 * hand-tune. A fenced region touches only our own lines and leaves every byte outside it alone.
 *
 * The cost is that we cannot see structure, which is what `hasUnfencedTable` is for: install refuses when
 * the operator already wrote `[mcp_servers.memhtml]` themselves, because appending a second one produces
 * a file Codex rejects and we would be the ones who broke it.
 */

import { fenced, linesOutsideFence } from "./fenced.js"

export const FENCE_START = "# MEMHTML:START"
export const FENCE_END = "# MEMHTML:END"

const fence = fenced(FENCE_START, FENCE_END)

/**
 * Replace the fenced region with `block`, or append one after a blank line. Malformed markers — a start
 * with no end, a duplicate of either — throw an `Error` naming which marker is wrong and how many were
 * found, since a repair guess can delete the operator's own tables.
 */
export const upsertFencedToml = (text: string | null, block: string): string =>
  fence.upsert(text, block)

/** Drop the fenced region and the blank line before it. A file that was only the fence becomes `""`. */
export const removeFencedToml = (text: string | null): string => fence.remove(text)

/** The TOML we own, or `null` when the file carries no fence. Throws on malformed markers. */
export const readFencedToml = (text: string | null): string | null => fence.read(text)

/**
 * A TOML table header, allowing an array-of-tables (`[[…]]`) and a trailing comment. The name is taken
 * raw and only trimmed: a quoted key (`["mcp servers"]`) compares as written, which is the honest answer
 * when we are deliberately not parsing.
 */
const TABLE_HEADER = /^\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/

/**
 * True when a `[table]` or `[table.child]` header appears outside our fence — the operator's own entry.
 *
 * Called with `mcp_servers.memhtml`, so it also catches `[mcp_servers.memhtml.env]` written by hand
 * without its parent, which is legal TOML and would still collide with the block we render.
 */
export const hasUnfencedTable = (text: string | null, table: string): boolean => {
  for (const line of linesOutsideFence(text, FENCE_START, FENCE_END)) {
    const match = TABLE_HEADER.exec(line.trim())
    if (match === null) continue
    const name = match[1]?.trim()
    if (name === undefined) continue
    if (name === table || name.startsWith(`${table}.`)) return true
  }
  return false
}

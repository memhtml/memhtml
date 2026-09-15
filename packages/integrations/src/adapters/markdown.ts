/**
 * The instruction files — `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/memhtml.mdc` — edited inside an HTML
 * comment block.
 *
 * Markdown gets the same fence treatment as TOML, with markers that render as nothing: an operator
 * reading their own `CLAUDE.md` sees our prose and not our bookkeeping. Everything outside the two marker
 * lines is theirs and is never reflowed.
 */

import { fenced } from "./fenced.js"

export const BLOCK_START = "<!-- MEMHTML:START -->"
export const BLOCK_END = "<!-- MEMHTML:END -->"

const block = fenced(BLOCK_START, BLOCK_END)

/**
 * Replace the managed block with `body`, or append it after a blank line. The markers each occupy their
 * own line so the body is addressable by line number in a diff. Malformed or duplicated markers throw.
 */
export const upsertFencedBlock = (text: string | null, body: string): string =>
  block.upsert(text, body)

/**
 * Drop the managed block. Returns `""` when the block was the entire file, which is the caller's signal
 * that it may delete the file instead of leaving an empty one behind.
 */
export const removeFencedBlock = (text: string | null): string => block.remove(text)

/** The body between the markers, or `null` when the file carries no block. Throws on malformed markers. */
export const readFencedBlock = (text: string | null): string | null => block.read(text)

/**
 * True when the file is nothing but Claude Code's `@AGENTS.md` import.
 *
 * Such a `CLAUDE.md` is a pointer, not a document: the operator has chosen to keep one instruction file
 * and have Claude Code import it. Writing our block into the pointer would duplicate what `AGENTS.md`
 * already carries, so install writes to `AGENTS.md` and leaves this file untouched — openwiki's issue
 * #841, where the installer helpfully appended to the import file and every session then saw the block
 * twice.
 */
export const isClaudeImportOnly = (text: string | null): boolean =>
  text !== null && text.trim() === "@AGENTS.md"

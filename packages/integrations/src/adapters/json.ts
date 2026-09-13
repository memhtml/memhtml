/**
 * The JSON and JSONC configs: `~/.claude.json`, `~/.claude/settings.json`, `.mcp.json`, Cursor's
 * `mcp.json` and `hooks.json`, OpenCode's `opencode.json`.
 *
 * Every edit goes through `jsonc-parser`'s `modify` + `applyEdits`, which computes a minimal text edit
 * against the original document. `JSON.parse` + `JSON.stringify` would be shorter and would silently
 * delete every comment in an OpenCode config and reindent a file the operator formats their own way —
 * a config file is a document, and the only bytes install may change are the ones it owns.
 *
 * A `null` or blank input is treated as `{}`, so "create the file" and "edit the file" are one code path,
 * and output always ends with a newline.
 */

import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  getNodeValue,
  type JSONPath,
  modify,
  type Node,
  type ParseError,
  type ParseOptions,
  parseTree
} from "jsonc-parser"

/** New content is written 2-space indented with LF, matching biome's own JSON formatting. */
const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" }

/** Trailing commas are tolerated on read: every host that ships a JSONC config accepts them. */
const PARSE: ParseOptions = { allowTrailingComma: true }

const normalize = (text: string | null): string =>
  text === null || text.trim().length === 0 ? "{}" : text

const withTrailingNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`)

const path = (segments: ReadonlyArray<string | number>): JSONPath => [...segments]

/**
 * The parsed tree, or `undefined` when the text does not parse even with comments allowed.
 *
 * `parseTree` is fault tolerant and returns a partial tree for broken input, so the error list is what
 * decides: a half-parsed config must read as unparseable rather than as one missing a key, or install
 * would "repair" it by writing a valid file over the operator's typo and losing the rest.
 */
const treeOf = (text: string): Node | undefined => {
  const errors: Array<ParseError> = []
  const root = parseTree(text, errors, PARSE)
  return errors.length === 0 ? root : undefined
}

const nodeAt = (text: string, segments: ReadonlyArray<string | number>): Node | undefined => {
  const root = treeOf(text)
  return root === undefined ? undefined : findNodeAtLocation(root, path(segments))
}

/**
 * The value at `segments`, or `undefined` when the path is absent or the document does not parse. A JSON
 * `null` comes back as `null`, so absent and present-but-null stay distinguishable.
 */
export const readJsonPath = (
  text: string | null,
  segments: ReadonlyArray<string | number>
): unknown => {
  const node = nodeAt(normalize(text), segments)
  if (node === undefined) return undefined
  const value: unknown = getNodeValue(node)
  return value
}

/**
 * Set `segments` to `value`, creating every missing intermediate object on the way. Comments, key order,
 * and the existing indentation of untouched lines all survive.
 */
export const upsertJsonPath = (
  text: string | null,
  segments: ReadonlyArray<string | number>,
  value: unknown
): string => {
  const base = normalize(text)
  const edits = modify(base, path(segments), value, { formattingOptions: FORMATTING })
  return withTrailingNewline(applyEdits(base, edits))
}

/** Remove `segments`. A path that is already absent is a no-op, not an error. */
export const removeJsonPath = (
  text: string | null,
  segments: ReadonlyArray<string | number>
): string => {
  const base = normalize(text)
  if (nodeAt(base, segments) === undefined) return withTrailingNewline(base)
  const edits = modify(base, path(segments), undefined, { formattingOptions: FORMATTING })
  return withTrailingNewline(applyEdits(base, edits))
}

const arrayAt = (
  text: string,
  segments: ReadonlyArray<string | number>
): ReadonlyArray<unknown> => {
  const node = nodeAt(text, segments)
  if (node === undefined || node.type !== "array") return []
  const value: unknown = getNodeValue(node)
  return Array.isArray(value) ? value : []
}

/**
 * Rewrite the array at `segments` as "everything the operator put there, then everything we put there".
 *
 * This is how a hooks array is edited: `owned` recognizes our own entries by their `command` string, they
 * are dropped, and `entries` is appended. Re-running install is therefore idempotent — the second run
 * removes exactly what the first added and appends the same thing — and a hook the operator wrote by hand
 * keeps its position among the survivors.
 *
 * An existing value that is not an array is treated as absent and replaced, since a `hooks.SessionStart`
 * that is an object is not something we can merge into.
 */
export const upsertArrayEntries = (
  text: string | null,
  segments: ReadonlyArray<string | number>,
  entries: ReadonlyArray<unknown>,
  owned: (entry: unknown) => boolean
): string => {
  const base = normalize(text)
  const kept = arrayAt(base, segments).filter((entry) => !owned(entry))
  return upsertJsonPath(base, segments, [...kept, ...entries])
}

/**
 * Drop every entry `owned` matches from the array at `segments`, and drop the key itself once nothing is
 * left — an uninstall that leaves `"SessionStart": []` behind has not restored the file.
 */
export const removeArrayEntries = (
  text: string | null,
  segments: ReadonlyArray<string | number>,
  owned: (entry: unknown) => boolean
): string => {
  const base = normalize(text)
  const node = nodeAt(base, segments)
  if (node === undefined || node.type !== "array") return withTrailingNewline(base)
  const kept = arrayAt(base, segments).filter((entry) => !owned(entry))
  return kept.length === 0 ? removeJsonPath(base, segments) : upsertJsonPath(base, segments, kept)
}

/** The whole document as a value, or `undefined` when it does not parse. Comments are allowed. */
export const parseJsonc = (text: string): unknown => {
  const root = treeOf(text)
  if (root === undefined) return undefined
  const value: unknown = getNodeValue(root)
  return value
}

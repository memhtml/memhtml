/**
 * One fenced-region implementation, three comment syntaxes.
 *
 * A fence is two marker lines with our content between them, inside a file the operator also owns. TOML
 * (`# MEMHTML:START`), Markdown (`<!-- MEMHTML:START -->`), and shell rc files (`# MEMHTML:START`) differ
 * only in what a comment looks like, so `fenced` takes the two markers and the semantics are identical
 * everywhere: replace the region in place, or append it after a blank line; remove exactly it and the
 * blank line it introduced; read back what is inside.
 *
 * Malformed markers throw rather than being repaired. A file with a start and no end, or with two starts,
 * has been edited by hand or by a failed run, and every possible guess about where our region ends can
 * delete somebody else's lines.
 */

/** Where a fence sits, as inclusive line indices into the file's lines. */
interface FenceLocation {
  readonly startLine: number
  readonly endLine: number
}

const splitLines = (text: string): ReadonlyArray<string> => text.split("\n")

const isMarker = (line: string, marker: string): boolean => line.trim() === marker

const locate = (text: string, startMarker: string, endMarker: string): FenceLocation | null => {
  const lines = splitLines(text)
  const starts: Array<number> = []
  const ends: Array<number> = []
  lines.forEach((line, index) => {
    if (isMarker(line, startMarker)) starts.push(index)
    else if (isMarker(line, endMarker)) ends.push(index)
  })
  if (starts.length === 0 && ends.length === 0) return null
  if (starts.length > 1)
    throw new Error(`found ${starts.length} \`${startMarker}\` markers, expected 1`)
  if (ends.length > 1) throw new Error(`found ${ends.length} \`${endMarker}\` markers, expected 1`)
  const startLine = starts[0]
  const endLine = ends[0]
  if (startLine === undefined) throw new Error(`found \`${endMarker}\` with no \`${startMarker}\``)
  if (endLine === undefined) throw new Error(`found \`${startMarker}\` with no \`${endMarker}\``)
  if (endLine < startLine) throw new Error(`\`${endMarker}\` appears before \`${startMarker}\``)
  return { startLine, endLine }
}

/** Trailing blank lines removed; a body is stored without its own trailing newline. */
const trimTrailingBlank = (body: string): string => body.trimEnd()

const withTrailingNewline = (text: string): string =>
  text.length === 0 || text.endsWith("\n") ? text : `${text}\n`

/** The three operations a fenced file supports, bound to one pair of markers. */
export interface FencedText {
  /** Replace the fenced region with `body`, or append a fence when the file has none. */
  readonly upsert: (text: string | null, body: string) => string
  /** Drop the fenced region and the blank line separating it. `""` when the fence was the whole file. */
  readonly remove: (text: string | null) => string
  /** The body between the markers, or `null` when the file carries no fence. */
  readonly read: (text: string | null) => string | null
  /** True when the file carries a well-formed fence. Throws on malformed markers, like the rest. */
  readonly has: (text: string | null) => boolean
  readonly startMarker: string
  readonly endMarker: string
}

/**
 * Build the fence operations for one marker pair. `startMarker` and `endMarker` are matched against a
 * line's trimmed content, so an indented marker still counts — the markers our own renderers write are
 * flush left, but a hand-reindented file must not silently grow a second region.
 */
export const fenced = (startMarker: string, endMarker: string): FencedText => {
  const block = (body: string): string => {
    const inner = trimTrailingBlank(body)
    return inner.length === 0
      ? `${startMarker}\n${endMarker}`
      : `${startMarker}\n${inner}\n${endMarker}`
  }

  const upsert = (text: string | null, body: string): string => {
    const base = text ?? ""
    const found = locate(base, startMarker, endMarker)
    if (found === null) {
      const prefix = base.trim().length === 0 ? "" : `${withTrailingNewline(base)}\n`
      return `${prefix}${block(body)}\n`
    }
    const lines = splitLines(base)
    const next = [
      ...lines.slice(0, found.startLine),
      ...splitLines(block(body)),
      ...lines.slice(found.endLine + 1)
    ]
    return withTrailingNewline(next.join("\n"))
  }

  const remove = (text: string | null): string => {
    const base = text ?? ""
    const found = locate(base, startMarker, endMarker)
    if (found === null) return base
    const lines = splitLines(base)
    const before = lines.slice(0, found.startLine)
    // Drop the blank line `upsert` inserted as a separator, so remove-after-upsert is byte-exact.
    while (before.length > 0 && before[before.length - 1]?.trim() === "") before.pop()
    const after = lines.slice(found.endLine + 1)
    while (after.length > 0 && after[0]?.trim() === "") after.shift()
    if (before.length === 0 && after.length === 0) return ""
    if (before.length === 0) return withTrailingNewline(after.join("\n"))
    if (after.length === 0) return withTrailingNewline(before.join("\n"))
    return withTrailingNewline([...before, "", ...after].join("\n"))
  }

  const read = (text: string | null): string | null => {
    const base = text ?? ""
    const found = locate(base, startMarker, endMarker)
    if (found === null) return null
    return splitLines(base)
      .slice(found.startLine + 1, found.endLine)
      .join("\n")
  }

  return {
    upsert,
    remove,
    read,
    has: (text) => locate(text ?? "", startMarker, endMarker) !== null,
    startMarker,
    endMarker
  }
}

/**
 * The lines of `text` that sit OUTSIDE the fence. Used by the TOML adapter to tell an entry we own from
 * one the operator wrote by hand. Malformed markers are tolerated here — this is a read used to build a
 * refusal message, and it must not throw before the caller can report anything.
 */
export const linesOutsideFence = (
  text: string | null,
  startMarker: string,
  endMarker: string
): ReadonlyArray<string> => {
  const outside: Array<string> = []
  let inside = false
  for (const line of splitLines(text ?? "")) {
    if (isMarker(line, startMarker)) {
      inside = true
      continue
    }
    if (isMarker(line, endMarker)) {
      inside = false
      continue
    }
    if (!inside) outside.push(line)
  }
  return outside
}

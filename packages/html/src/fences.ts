/**
 * Fenced-code grammar: recognizing ``` blocks in prose, one copy for every consumer.
 *
 * This module owns the GRAMMAR only — what is a fence, where does it end, what language does its
 * info string name. What a fence *becomes* is the template's decision (`template.ts` renders it as
 * `<figure><pre><code data-lang>`), and where paragraph boundaries fall in prose is the doors'
 * heuristic (`apps/cli/src/prose.ts`). Both need the same answer to "is this line a fence?", and
 * two copies of that answer would let the splitter keep a block intact that the template then
 * fails to recognize — the same door-drift failure the claim derivation consolidation closed.
 *
 * Backtick fences only, per CommonMark's rules: three or more backticks open, a run of at least
 * as many closes, and the info string may not contain a backtick. Tilde fences are deliberately
 * absent — agents write backticks, and a second grammar is cost with no observed producer.
 */

/**
 * The language token grammar. Covers the identifiers real info strings carry — `ts`, `c++`,
 * `c#`, `objective-c`, `python3` — while refusing whitespace and markup characters, so a
 * `data-lang` value is always safe to read in view-source and to promote to a `lang:` entity.
 */
export const LANG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_+#.-]*$/

/** A fence-opening line: the backtick run, then an info string that contains no backtick. */
const FENCE_OPEN = /^(`{3,})([^`]*)$/

/**
 * The backtick run of a fence-opening line, or `undefined` when the line opens no fence.
 * The run's length is what a closing line must meet or exceed.
 */
export const fenceOpeningOf = (line: string): string | undefined =>
  FENCE_OPEN.exec(line.trim())?.[1]

/** True when a line closes a fence opened by `opening`: same-or-longer backtick run, nothing else. */
export const closesFence = (line: string, opening: string): boolean =>
  new RegExp(`^\`{${opening.length},}$`).test(line.trim())

/** One recognized fenced block: its code verbatim, and the info string's language when it names one. */
export interface FencedBlock {
  /** The first info-string token, lowercased, when it matches {@link LANG_TOKEN}. */
  readonly lang?: string | undefined
  /** The lines between the fences, joined verbatim — indentation and blank lines preserved. */
  readonly code: string
}

/**
 * Parse a paragraph as a fenced block, or `undefined` when it is not one.
 *
 * The whole paragraph must be the fence: an opening line, the code, a closing line. Prose sharing
 * a paragraph with a fence is not a fence — the paragraph splitter keeps a block intact as its own
 * paragraph, so a mixed paragraph means the author did not blank-line-separate their fence, and
 * escaping it as text is the graceful reading of that.
 *
 * An unterminated fence (opener, no closer) is also `undefined`: rendering it as code would commit
 * markup the author may not have finished, and rendering it as escaped text keeps the backticks
 * visible — the file says what the author typed.
 */
export const fencedBlockOf = (paragraph: string): FencedBlock | undefined => {
  const lines = paragraph.split("\n")
  const [first] = lines
  if (first === undefined || lines.length < 2) return undefined
  const open = FENCE_OPEN.exec(first.trim())
  if (open === null) return undefined
  const opening = open[1]
  const last = lines.at(-1)
  if (opening === undefined || last === undefined || !closesFence(last, opening)) return undefined

  const info = (open[2] ?? "").trim()
  const [token] = info.split(/\s+/, 1)
  const lang =
    token !== undefined && token !== "" && LANG_TOKEN.test(token) ? token.toLowerCase() : undefined
  return { ...(lang === undefined ? {} : { lang }), code: lines.slice(1, -1).join("\n") }
}

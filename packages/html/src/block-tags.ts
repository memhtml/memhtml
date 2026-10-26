import type { Element, Node } from "./tree.js"
import {
  childrenOf,
  elementsNamed,
  hasAncestor,
  isElement,
  isTextNode,
  parseDocument
} from "./tree.js"

/**
 * Block-tag-shaped text: an HTML block element written where the format expects text.
 *
 * The prose path escapes every claim and paragraph (`template.ts`), so a writer that sends
 * `<p>One.</p>` as prose, meaning markup, gets a file whose `<mark>` reads `&lt;p&gt;One.`. Every
 * format constraint accepts that file, because escaped text is valid content. So a `<p>` whose
 * text holds a block tag is refused: by the doors before they render a prose body (over the
 * paragraphs `proseParagraphs` says the template will render), and by `validateOps` over a
 * session put's article ({@link blockTagInArticle}). Both read each paragraph's text with
 * {@link blockTagInRun}, so they hold one rule. Supplied `article_html` at the other doors is
 * verbatim markup and is not judged: a caller may escape quoted text into a `<p>` on purpose.
 *
 * Code is exempt, because a record that discusses markup has to be able to name a tag: a closed
 * backtick span on one line, and in an article the text of `<code>`, `<pre>`, `<kbd>`, and
 * `<samp>`. A fenced block is code only as a paragraph of its own, which the template renders as
 * a `<figure>` and so never reaches a `<p>`; a fence sharing a paragraph with prose is escaped
 * into the `<p>` as text, and is read as text here too.
 */

/**
 * The block elements whose tag, written as text, means the writer meant markup. These are the
 * elements an article is built from; inline ones such as `<time>` or `<em>` stay prose that the
 * path escapes. Lowercase only, as markup is written: `<Table>`, `React.FC<P>`, and
 * `List<Article>` are code, not tags.
 */
const BLOCK_NAME = /(?:p|ul|ol|li|dl|dt|dd|figure|table|article|section|h[1-6])/y

/**
 * Text that ends in a letter, a mark, a digit, or `_`, in any script: what may not sit right
 * before an opening tag, so `x<p`, `List<li>`, and `é<p>` are not tags. Read over the two code
 * units before the tag, so a letter outside the Basic Multilingual Plane counts too.
 */
const ENDS_IN_WORD = /[\p{L}\p{M}\p{N}_]$/u

/** Whitespace, which may follow a tag's name and open its attributes. */
const WHITESPACE = /\s/

/** The most of a tag a refusal quotes. A tag with a long attribute list is cut here. */
const TAG_SHOWN = 80

/**
 * Where the tag opened at `at` ends, exclusive, or `undefined` when no block tag opens there.
 * `open` is the opener's length: 1 for `<`, 4 for `&lt;`. Hand-written rather than a regular
 * expression, because a pattern over the escaped spelling keeps one backtrack frame per
 * character and overflows the stack on a line of a few million characters.
 *
 * An opening tag is the name, then the close, `/` and the close (`<p/>`), or whitespace and
 * anything up to the first `>` or `&gt;`; a closing tag is `/`, the name, optional spaces, and the
 * close. So `<dd/mm/yyyy>` is not a tag. The attribute scan stops at the next `<` or `&lt;`,
 * where the next attempt starts, so a line is read once however many unclosed openers it holds.
 */
const tagEnd = (line: string, at: number, open: number): number | undefined => {
  let cursor = at + open
  const closing = line[cursor] === "/"
  if (closing) cursor += 1
  BLOCK_NAME.lastIndex = cursor
  const name = BLOCK_NAME.exec(line)
  if (name === null) return undefined
  cursor += name[0].length
  if (closing) return closeAfterSpaces(line, cursor)
  if (ENDS_IN_WORD.test(line.slice(Math.max(0, at - 2), at))) return undefined
  const next = line[cursor]
  if (next === ">") return cursor + 1
  if (line.startsWith("&gt;", cursor)) return cursor + 4
  if (next === "/") return closeAfterSpaces(line, cursor + 1)
  if (next === undefined || !WHITESPACE.test(next)) return undefined
  for (; cursor < line.length; cursor += 1) {
    const character = line[cursor]
    if (character === ">") return cursor + 1
    if (character === "<") return undefined
    if (character === "&") {
      if (line.startsWith("&gt;", cursor)) return cursor + 4
      if (line.startsWith("&lt;", cursor)) return undefined
    }
  }
  return undefined
}

/** Where a tag's close ends when it follows `at` after optional spaces, or `undefined`. */
const closeAfterSpaces = (line: string, at: number): number | undefined => {
  let cursor = at
  while (line[cursor] === " " || line[cursor] === "\t") cursor += 1
  if (line[cursor] === ">") return cursor + 1
  return line.startsWith("&gt;", cursor) ? cursor + 4 : undefined
}

/** The first block tag in one line, raw or escaped, as its start and end in the line. */
const tagIn = (line: string): { readonly start: number; readonly end: number } | undefined => {
  let raw = line.indexOf("<")
  let escaped = line.indexOf("&lt;")
  while (raw !== -1 || escaped !== -1) {
    const isRaw = escaped === -1 || (raw !== -1 && raw < escaped)
    const at = isRaw ? raw : escaped
    const end = tagEnd(line, at, isRaw ? 1 : 4)
    if (end !== undefined) return { start: at, end }
    if (isRaw) raw = line.indexOf("<", at + 1)
    else escaped = line.indexOf("&lt;", at + 1)
  }
  return undefined
}

/** A run of backticks in one line: where it starts and where it ends, exclusive. */
interface Run {
  readonly start: number
  readonly end: number
}

/**
 * One line with its closed backtick spans blanked, per CommonMark's rule: a run of N backticks
 * opens a span that the next run of exactly N closes, and a run with no such partner is literal
 * text. Each span becomes as many spaces as it had characters, so text split around a span cannot
 * join into a tag and every position still names the same character of the line.
 *
 * Linear: the runs are listed once, grouped by length, and each length keeps a cursor into its
 * group, so finding a partner never rescans the line.
 */
const blankCodeSpans = (line: string): string => {
  const runs: Array<Run> = []
  for (let at = line.indexOf("`"); at !== -1; at = line.indexOf("`", at)) {
    const start = at
    while (line[at] === "`") at += 1
    runs.push({ start, end: at })
  }
  if (runs.length < 2) return line
  const byLength = new Map<number, Array<number>>()
  for (const [index, run] of runs.entries()) {
    const group = byLength.get(run.end - run.start)
    if (group === undefined) byLength.set(run.end - run.start, [index])
    else group.push(index)
  }
  const reached = new Map<number, number>()
  let out = ""
  let from = 0
  let index = 0
  while (index < runs.length) {
    const run = runs[index] as Run
    const length = run.end - run.start
    const group = byLength.get(length) ?? []
    let next = reached.get(length) ?? 0
    while (next < group.length && (group[next] as number) <= index) next += 1
    reached.set(length, next)
    const partner = group[next]
    if (partner === undefined) {
      index += 1
      continue
    }
    const end = (runs[partner] as Run).end
    out += `${line.slice(from, run.start)}${" ".repeat(end - run.start)}`
    from = end
    index = partner + 1
  }
  return out + line.slice(from)
}

/**
 * A text without its NUL characters, with the way back to the text's own positions. The HTML
 * parser drops a NUL from body text, so the text a `<p>` holds once read is the text without
 * them, and `<\0p>` written as prose reads as `<p>`.
 */
const withoutNul = (
  text: string
): { readonly text: string; readonly at: (index: number) => number } => {
  if (!text.includes("\0")) return { text, at: (index) => index }
  const kept: Array<number> = []
  let out = ""
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\0") continue
    kept.push(index)
    out += text[index]
  }
  return { text: out, at: (index) => kept[index] ?? text.length }
}

/** Line breaks as the HTML parser reads them: CR LF, a lone CR, and LF are each one break. */
const LINE_BREAK = /\r\n|\r|\n/g

/** Where a block tag sits in a text: the position it starts at, and the tag as written. */
export interface BlockTagInRun {
  readonly offset: number
  readonly tag: string
}

/**
 * The first block tag in a paragraph's text outside a backtick span, or `undefined` when there is
 * none. The text is read as the HTML parser will hold it in a `<p>`: line breaks in all three
 * spellings, NULs dropped. A backtick span opens and closes on one line, so a tag on a line of its
 * own is prose even when the lines around it carry backticks.
 *
 * `offset` is the tag's position in `text` as given, and `tag` is the tag sliced from the line as
 * the parser reads it (backticks kept, NULs dropped), cut to {@link TAG_SHOWN} characters.
 */
export const blockTagInRun = (text: string): BlockTagInRun | undefined => {
  const read = withoutNul(text)
  const source = read.text
  for (let start = 0; start <= source.length; ) {
    LINE_BREAK.lastIndex = start
    const lineBreak = LINE_BREAK.exec(source)
    const end = lineBreak === null ? source.length : lineBreak.index
    const line = source.slice(start, end)
    const found = tagIn(blankCodeSpans(line))
    if (found !== undefined) {
      const written = line.slice(found.start, found.end)
      return {
        offset: read.at(start + found.start),
        tag: written.length > TAG_SHOWN ? `${written.slice(0, TAG_SHOWN - 3)}...` : written
      }
    }
    if (lineBreak === null) break
    start = end + lineBreak[0].length
  }
  return undefined
}

/** Elements whose text is code, and so may name any tag. */
const CODE_ELEMENTS: ReadonlySet<string> = new Set(["code", "pre", "kbd", "samp"])

/**
 * An element's text with each code subtree read as one space, line breaks kept. The space keeps
 * the text on either side of the code from joining: `&lt;<code>Tab</code>p&gt;` reads as
 * `< p>`, not as `<p>`.
 */
const proseTextOf = (root: Element): string => {
  let out = ""
  const stack: Array<Node> = [...childrenOf(root)].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (isTextNode(node)) {
      out += node.value
    } else if (isElement(node)) {
      if (CODE_ELEMENTS.has(node.tagName)) {
        out += " "
        continue
      }
      const children = childrenOf(node)
      for (let at = children.length - 1; at >= 0; at -= 1) {
        const child = children[at]
        if (child !== undefined) stack.push(child)
      }
    }
  }
  return out
}

/** Which element's text holds a block tag, and the tag as the text reads. */
export interface BlockTagInArticle {
  readonly element: "p" | "mark"
  readonly tag: string
}

/**
 * The first `<p>`, or `<mark>` outside any `<p>`, in a memory file's article whose text holds a
 * block tag outside code, or `undefined` when none does.
 *
 * A `<p>` is read whole, its `<mark>` included, because that is the paragraph the prose path
 * rendered: the claim, a space, and the first body paragraph. A `<mark>` outside a `<p>` (the
 * first `<li>` of authored markup) is read on its own. The text is what a reader sees, so
 * `&lt;p&gt;` in the file reads as `<p>` here.
 */
export const blockTagInArticle = (html: string): BlockTagInArticle | undefined => {
  const [article] = elementsNamed(parseDocument(html), "article")
  if (article === undefined) return undefined
  for (const element of elementsNamed(article, "p", "mark")) {
    if (element.tagName === "mark" && hasAncestor(element, "p")) continue
    const found = blockTagInRun(proseTextOf(element))
    if (found !== undefined) {
      return { element: element.tagName === "mark" ? "mark" : "p", tag: found.tag }
    }
  }
  return undefined
}

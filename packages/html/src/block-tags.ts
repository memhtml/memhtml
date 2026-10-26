import { closesFence, fenceOpeningOf } from "./fences.js"
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
 * `<p>One.</p>` as prose, meaning markup, gets a file whose `<mark>` reads `&lt;p&gt;One.`. The
 * render gate accepts it, because escaped text is valid content. The doors refuse such a body
 * before it is rendered ({@link blockTagInText}), and `validateOps` refuses a put whose `<p>` or
 * `<mark>` text holds one ({@link blockTagInArticle}), which reads that text with the same function,
 * so the two hold one rule about what counts.
 *
 * Code is exempt however it is written, because a record that discusses markup has to be able to
 * name a tag: lines inside a backtick fence (the grammar `fences.ts` owns), a closed backtick span
 * on one line, and, in an article, the text of `<code>`, `<pre>`, `<kbd>`, and `<samp>`.
 */

/**
 * The block elements whose tag, written as text, means the writer meant markup. These are the
 * elements an article is built from; inline ones such as `<time>` or `<em>` stay prose that the
 * path escapes.
 */
const BLOCK_NAMES = "p|ul|ol|li|dl|dt|dd|figure|table|article|section|h[1-6]"

/**
 * A block tag, raw or entity-escaped, case-insensitively. The name must end at whitespace, `/`, or
 * the tag's close, so `<pre>`, `<param>`, and `<details>` are not read as `<p>` or `<dd>`.
 *
 * Each attempt stops at the next `<` (or, escaped, the next `&lt;`) rather than scanning to the end
 * of the text, so a run of unclosed openers costs one pass instead of a quadratic rescan. That is a
 * cost property of unbounded caller input on the write path, locked by the cost-curve test.
 */
const BLOCK_TAG = new RegExp(
  `<\\/?(?:${BLOCK_NAMES})(?=[\\s/>])[^<>]*>` +
    `|&lt;\\/?(?:${BLOCK_NAMES})(?=[\\s/]|&gt;)(?:[^&<>]|&(?!lt;|gt;))*&gt;`,
  "i"
)

/** Where a block tag sits in a text: its 1-based line and the tag as written. */
export interface BlockTagText {
  readonly line: number
  readonly tag: string
}

/** A run of backticks in one line: where it starts and where it ends, exclusive. */
interface Run {
  readonly start: number
  readonly end: number
}

/**
 * One line with its closed backtick spans replaced by a space, per CommonMark's rule: a run of N
 * backticks opens a span that the next run of exactly N closes, and a run with no such partner is
 * literal text. A space rather than nothing, so text split around a span cannot join into a tag.
 *
 * Linear: the runs are listed once, grouped by length, and each length keeps a cursor into its
 * group, so finding a partner never rescans the line.
 */
const withoutCodeSpans = (line: string): string => {
  const runs: Array<Run> = []
  for (let at = line.indexOf("`"); at !== -1; at = line.indexOf("`", at)) {
    const start = at
    while (line[at] === "`") at += 1
    runs.push({ start, end: at })
  }
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
    out += `${line.slice(from, run.start)} `
    from = (runs[partner] as Run).end
    index = partner + 1
  }
  return out + line.slice(from)
}

/**
 * The first block tag in a text outside code, or `undefined` when there is none.
 *
 * Read line by line, so the answer names the line a writer can find. A fence opens on a line that
 * {@link fenceOpeningOf} recognizes and closes on one {@link closesFence} accepts; a fence that
 * never closes runs to the end of the text, as CommonMark reads it.
 */
export const blockTagInText = (text: string): BlockTagText | undefined => {
  let opening: string | undefined
  for (const [index, line] of text.split("\n").entries()) {
    if (opening !== undefined) {
      if (closesFence(line, opening)) opening = undefined
      continue
    }
    opening = fenceOpeningOf(line)
    if (opening !== undefined) continue
    const tag = BLOCK_TAG.exec(withoutCodeSpans(line))?.[0]
    if (tag !== undefined) return { line: index + 1, tag }
  }
  return undefined
}

/** Elements whose text is code, and so may name any tag. */
const CODE_ELEMENTS: ReadonlySet<string> = new Set(["code", "pre", "kbd", "samp"])

/** An element's text with code subtrees left out, line breaks kept so fences still read. */
const proseTextOf = (root: Element): string => {
  let out = ""
  const stack: Array<Node> = [...childrenOf(root)].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (isTextNode(node)) out += node.value
    else if (isElement(node) && !CODE_ELEMENTS.has(node.tagName)) {
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
 * A `<p>` is read whole, its `<mark>` included, because that is the text the prose path rendered
 * from one paragraph of the writer's body, so a backtick span the claim boundary falls inside is
 * still one span here. A `<mark>` outside a `<p>` (the first `<li>` of authored markup) is read on
 * its own. The text is what a reader sees, so `&lt;p&gt;` in the file reads as `<p>` here.
 */
export const blockTagInArticle = (html: string): BlockTagInArticle | undefined => {
  const [article] = elementsNamed(parseDocument(html), "article")
  if (article === undefined) return undefined
  for (const element of elementsNamed(article, "p", "mark")) {
    if (element.tagName === "mark" && hasAncestor(element, "p")) continue
    const found = blockTagInText(proseTextOf(element))
    if (found !== undefined) {
      return { element: element.tagName === "mark" ? "mark" : "p", tag: found.tag }
    }
  }
  return undefined
}

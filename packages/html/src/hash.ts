import { createHash } from "node:crypto"

import type { Element, Node, ParentNode } from "./tree.js"
import { childrenOf, isElement, isTextNode, parseArticleFragment, parseDocument } from "./tree.js"
import { GIST_EXCLUDED_ELEMENTS, INLINE_ELEMENTS } from "./vocabulary.js"

/**
 * The content hash: the dedup key, and the one value in the system that must be invariant
 * under head edits.
 *
 * `sha256` over the whitespace-normalized text content of `<article>`, except inside `<pre>`
 * where whitespace is preserved verbatim. Meta and `<link>` edits are outside the scope by
 * construction, so confidence decay, access bookkeeping, and the sleep phases' own stamping do
 * not look like content changes. Without that invariance every nightly decay pass would
 * present the whole corpus as new content and dedup would collapse.
 */

/** The digest's algorithm prefix. A hash is self-describing so a stored value can be re-verified. */
export const HASH_ALGORITHM = "sha256"

/** ASCII whitespace, per the HTML definition. U+00A0 is excluded because it is content. */
const ASCII_WHITESPACE = /[ \t\n\f\r]+/g

/** One run of extracted text and whether its whitespace is significant. */
interface Segment {
  readonly verbatim: boolean
  readonly text: string
}

/** True when the element's descendant text carries significant whitespace. */
const preservesWhitespace = (element: Element): boolean => element.tagName === "pre"

/** What {@link canonicalText} may skip. */
export interface CanonicalTextOptions {
  /**
   * Omit `<pre>` and `<code>` subtrees, per the gist rule. A command line is body text and it
   * is searchable, and it is not part of the claim.
   */
  readonly excludeCode?: boolean | undefined
}

/**
 * Text segments of a subtree in document order, each tagged with whether its whitespace is
 * significant. A block element contributes a collapsible space at each of its edges, so the
 * text of two adjacent blocks stays separate. Iterative, so depth cannot overflow the stack.
 */
const segmentsOf = (root: Node, options: CanonicalTextOptions): ReadonlyArray<Segment> => {
  const out: Array<Segment> = []
  const boundary: Segment = { verbatim: false, text: " " }
  const stack: Array<{ readonly node: Node; readonly verbatim: boolean } | Segment> = [
    { node: root, verbatim: isElement(root) && preservesWhitespace(root) }
  ]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    if (!("node" in frame)) {
      out.push(frame)
      continue
    }
    const { node, verbatim } = frame
    if (isTextNode(node)) {
      out.push({ verbatim, text: node.value })
      continue
    }
    if (
      options.excludeCode === true &&
      isElement(node) &&
      GIST_EXCLUDED_ELEMENTS.has(node.tagName)
    ) {
      continue
    }
    const block = isElement(node) && !INLINE_ELEMENTS.has(node.tagName)
    if (block) {
      out.push(boundary)
      stack.push(boundary)
    }
    const nested = verbatim || (isElement(node) && preservesWhitespace(node))
    const children = childrenOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) stack.push({ node: child, verbatim: nested })
    }
  }
  return out
}

/** Concatenate adjacent same-mode segments, so no collapse runs across a `<pre>` boundary. */
const coalesce = (segments: ReadonlyArray<Segment>): ReadonlyArray<Segment> => {
  const out: Array<Segment> = []
  for (const segment of segments) {
    const last = out.at(-1)
    if (last !== undefined && last.verbatim === segment.verbatim) {
      out[out.length - 1] = { verbatim: last.verbatim, text: last.text + segment.text }
    } else {
      out.push(segment)
    }
  }
  return out
}

/**
 * The exact string the digest is taken over: article text with runs of ASCII whitespace
 * collapsed to one space, `<pre>` descendants passed through byte for byte.
 *
 * Block-element edges contribute a collapsible space, so the hash is a function of the article's
 * *words* and not of its indentation: `<li>one</li><li>two</li>` and the same list pretty-printed
 * across lines yield one digest. Without that edge space the flat form would canonicalize to
 * `onetwo`, so reformatting a file would move its dedup key while changing nothing a reader can
 * see.
 *
 * The outer trim is applied only to a leading or trailing *collapsible* segment. Trimming the
 * whole result would let `<pre>  a</pre>` and `<pre>a</pre>` hash identically, and the leading
 * whitespace of a code sample is exactly the kind of difference a `<pre>` exists to keep.
 */
export const canonicalText = (root: Node, options: CanonicalTextOptions = {}): string => {
  const segments = coalesce(segmentsOf(root, options))
  const rendered = segments.map((segment, index) => {
    if (segment.verbatim) return segment.text
    let text = segment.text.replace(ASCII_WHITESPACE, " ")
    if (index === 0) text = text.replace(/^ /, "")
    if (index === segments.length - 1) text = text.replace(/ $/, "")
    return text
  })
  return rendered.join("")
}

/** The digest's input. `canonicalText` with `<pre>`/`<code>` kept, so everything is hashed. */
export const canonicalArticleText = (root: Node): string => canonicalText(root)

/** `sha256:<hex>` over a string. */
const digest = (text: string): string =>
  `${HASH_ALGORITHM}:${createHash(HASH_ALGORITHM).update(text, "utf8").digest("hex")}`

/** True when a value is a well-formed `sha256:<64 hex>` digest. */
export const isContentHash = (value: string): boolean => /^sha256:[0-9a-f]{64}$/.test(value)

/**
 * What {@link contentHash} accepts. A caller that already holds a parsed article passes the
 * node; the store and indexer, which hold bytes, pass a string or the article HTML.
 */
export interface HashableArticle {
  readonly article: { readonly html: string }
}

const isHashableArticle = (input: unknown): input is HashableArticle =>
  typeof input === "object" &&
  input !== null &&
  "article" in input &&
  typeof (input as HashableArticle).article?.html === "string"

/**
 * The content hash of an article, from a parsed document, an article node, or the article's
 * inner HTML. Passing whole-file HTML works too: the `<article>` element is located first, so
 * head content does not reach the digest.
 */
export const contentHash = (input: HashableArticle | Node | string): string => {
  if (typeof input === "string") return digest(canonicalArticleText(articleTreeOf(input)))
  if (isHashableArticle(input))
    return digest(canonicalArticleText(parseArticleFragment(input.article.html)))
  return digest(canonicalArticleText(input))
}

/**
 * The subtree to hash for a string input: the first `<article>` when the string is a whole
 * document, and the fragment itself when it is bare article markup. A string with no
 * `<article>` hashes as article-inner-HTML rather than failing, because `contentHash` is total
 * and refusing malformed input is `parseMemory`'s job, not the digest's.
 */
const articleTreeOf = (html: string): ParentNode => {
  if (/<article[\s>]/i.test(html)) {
    const document = parseDocument(html)
    const stack: Array<Node> = [document]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) break
      if (isElement(node) && node.tagName === "article") return node
      const children = childrenOf(node)
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index]
        if (child !== undefined) stack.push(child)
      }
    }
  }
  return parseArticleFragment(html)
}

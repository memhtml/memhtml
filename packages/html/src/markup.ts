import type { DefaultTreeAdapterTypes } from "parse5"

import { NEWLINE_SWALLOWING_ELEMENTS, RAW_TEXT_ELEMENTS, VOID_ELEMENTS } from "./vocabulary.js"

/**
 * The markup writer: a parse5 tree back to bytes, deterministically.
 *
 * parse5 ships a serializer, and it is not usable here for two reasons.
 *
 * The costlier one is `<pre>`. The HTML parser swallows one newline immediately after a
 * `<pre>` start tag, and parse5's serializer does not re-emit it, so `<pre>\n\nx</pre>` becomes
 * `<pre>\nx</pre>` becomes `<pre>x</pre>`, losing one newline on every write. `<pre>` whitespace
 * is inside the content-hash scope verbatim, so that drift would silently change a memory's
 * dedup key on a pass that edited nothing. {@link NEWLINE_SWALLOWING_ELEMENTS} re-emits the
 * newline the parser will eat, which makes serialization a fixed point.
 *
 * The second is attribute order: parse5 preserves source order, so two hand-authored files
 * differing only in attribute order stay different bytes forever. Sorting by name canonicalizes
 * them, and a canonical form is what makes a real diff readable.
 */

type Node = DefaultTreeAdapterTypes.Node
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type ChildNode = DefaultTreeAdapterTypes.ChildNode
type CommentNode = DefaultTreeAdapterTypes.CommentNode
type DocumentType = DefaultTreeAdapterTypes.DocumentType
type Element = DefaultTreeAdapterTypes.Element
type Template = DefaultTreeAdapterTypes.Template
type TextNode = DefaultTreeAdapterTypes.TextNode

/**
 * Escape a text run. U+00A0 becomes `&nbsp;` because a literal no-break space is invisible in
 * an editor and reads as an ordinary space in review. An invisible character in a memory's
 * claim is a trap, so the file names it.
 */
export const escapeText = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(" ", "&nbsp;")

/** Escape an attribute value. Double quotes are the fixed quote style, so `<` and `>` need no escape. */
export const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(" ", "&nbsp;")

const isElement = (node: Node): node is Element =>
  "tagName" in node && typeof node.tagName === "string"

const isTemplate = (node: Node): node is Template =>
  isElement(node) && node.tagName === "template" && "content" in node

/** A start tag with its attributes sorted by name. */
const startTag = (element: Element): string => {
  const attrs = [...element.attrs]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join("")
  return `<${element.tagName}${attrs}>`
}

/** One child node's markup. */
const writeChild = (node: ChildNode, rawText: boolean): string => {
  if (node.nodeName === "#text") {
    const text = node as TextNode
    return rawText ? text.value : escapeText(text.value)
  }
  if (node.nodeName === "#comment") return `<!--${(node as CommentNode).data}-->`
  if (node.nodeName === "#documentType") return `<!doctype ${(node as DocumentType).name}>`
  return writeElement(node as Element)
}

/** An element and its subtree. */
const writeElement = (element: Element): string => {
  const { tagName } = element
  const open = startTag(element)
  if (VOID_ELEMENTS.has(tagName)) return open

  const children = isTemplate(element) ? element.content.childNodes : element.childNodes
  const rawText = RAW_TEXT_ELEMENTS.has(tagName)
  let inner = children.map((child) => writeChild(child, rawText)).join("")

  const first = children[0]
  if (
    NEWLINE_SWALLOWING_ELEMENTS.has(tagName) &&
    first !== undefined &&
    first.nodeName === "#text" &&
    (first as TextNode).value.startsWith("\n")
  ) {
    inner = `\n${inner}`
  }

  return `${open}${inner}</${tagName}>`
}

/** The inner markup of a parent node: its children, the node itself excluded. */
export const writeChildren = (parent: ParentNode): string =>
  parent.childNodes
    .map((child) => writeChild(child, RAW_TEXT_ELEMENTS.has(nameOf(parent))))
    .join("")

const nameOf = (parent: ParentNode): string => (isElement(parent) ? parent.tagName : "")

/** A node and its subtree, the node included. */
export const writeOuter = (node: Node): string =>
  isElement(node) ? writeElement(node) : writeChildren(node as ParentNode)

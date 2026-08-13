import type { DefaultTreeAdapterTypes } from "parse5"
import { parse, parseFragment } from "parse5"

import { writeChildren } from "./markup.js"

/**
 * parse5 tree navigation, narrowed to what the format needs. Every function here is pure and
 * total, and nothing in this module knows the memory vocabulary.
 */

export type Node = DefaultTreeAdapterTypes.Node
export type ParentNode = DefaultTreeAdapterTypes.ParentNode
export type ChildNode = DefaultTreeAdapterTypes.ChildNode
export type Element = DefaultTreeAdapterTypes.Element
export type TextNode = DefaultTreeAdapterTypes.TextNode
export type Document = DefaultTreeAdapterTypes.Document

/**
 * Parse a whole memory file. Source locations are always on, because the surgical head
 * editors splice by byte offset and a second parse to obtain them would let the two views
 * of the same bytes disagree.
 */
export const parseDocument = (html: string): Document =>
  parse(html, { sourceCodeLocationInfo: true })

/**
 * Parse article inner HTML back into a subtree, in `<article>` context.
 *
 * The context element matters here. Fragment parsing without one runs in `<template>`
 * content, where the table-scoped elements (`tbody`, `tr`, `td`) are foster-parented out and
 * their text would vanish from the hash. Parsing in the element the markup actually came from
 * makes `contentHash(doc)` and `contentHash(fullHtml)` agree by construction.
 */
export const parseArticleFragment = (articleHtml: string): ParentNode => {
  const host = firstElement(
    parseDocument("<article></article>"),
    (node) => node.tagName === "article"
  )
  return parseFragment(host ?? null, articleHtml, { sourceCodeLocationInfo: false })
}

/** True for an element node. Narrows away text, comment, and doctype children. */
export const isElement = (node: Node): node is Element =>
  "tagName" in node && typeof node.tagName === "string"

/** True for a text node. */
export const isTextNode = (node: Node): node is TextNode => node.nodeName === "#text"

/** A node's children, or an empty list for a leaf. */
export const childrenOf = (node: Node): ReadonlyArray<ChildNode> =>
  "childNodes" in node ? node.childNodes : []

/** An attribute's value, or `undefined` when the attribute is absent. */
export const attr = (element: Element, name: string): string | undefined =>
  element.attrs.find((candidate) => candidate.name === name)?.value

/**
 * Every node in the subtree in document order, the root first. Iterative rather than
 * recursive so a pathologically deep hand-authored file cannot overflow the stack.
 */
export const walk = (root: Node): ReadonlyArray<Node> => {
  const out: Array<Node> = []
  const stack: Array<Node> = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    out.push(node)
    const children = childrenOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

/** Every element in the subtree in document order, the root included when it is an element. */
export const elementsOf = (root: Node): ReadonlyArray<Element> => walk(root).filter(isElement)

/** The first element in document order satisfying `predicate`, or `undefined`. */
export const firstElement = (
  root: Node,
  predicate: (element: Element) => boolean
): Element | undefined => elementsOf(root).find(predicate)

/** Every element in document order with one of the given tag names. */
export const elementsNamed = (
  root: Node,
  ...tagNames: ReadonlyArray<string>
): ReadonlyArray<Element> =>
  elementsOf(root).filter((element) => tagNames.includes(element.tagName))

/** True when `element` has an ancestor with one of the given tag names, `root` excluded. */
export const hasAncestor = (element: Element, ...tagNames: ReadonlyArray<string>): boolean => {
  let cursor: ParentNode | null = element.parentNode
  while (cursor !== null) {
    if (isElement(cursor) && tagNames.includes(cursor.tagName)) return true
    cursor = "parentNode" in cursor ? cursor.parentNode : null
  }
  return false
}

/** True when `candidate` is `ancestor` or sits beneath it. */
export const isWithin = (candidate: Element, ancestor: Element): boolean => {
  let cursor: Node | null = candidate
  while (cursor !== null) {
    if (cursor === ancestor) return true
    cursor = "parentNode" in cursor ? cursor.parentNode : null
  }
  return false
}

/**
 * The inner HTML of a subtree, trimmed. Trimming is what makes the article a serialization
 * fixed point. The wrapper emits its own newline after `<article>`, so keeping the parser's
 * boundary text node would grow a blank line on every write.
 */
export const innerHtml = (node: ParentNode): string => writeChildren(node).trim()

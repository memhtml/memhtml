import type { EdgeRel } from "@memhtml/contracts/edges"
import { relForToken, relTokenFor } from "@memhtml/contracts/edges"

import type { MemoryLink } from "./document.js"
import { escapeAttribute } from "./markup.js"
import type { Document, Element } from "./tree.js"
import { attr, elementsNamed, elementsOf, parseDocument } from "./tree.js"
import { isMemoryMetaName, META_ORDER, META_PREFIX, type MemoryMetaName } from "./vocabulary.js"

/**
 * Surgical head editors: byte-level splices that change exactly one line and provably do not
 * touch the article.
 *
 * The sleep phases stamp `memhtml-updated`, decay `memhtml-confidence`, bump `memhtml-reprieves`, and set
 * `memhtml-needs-revision` on files they otherwise leave alone. Round-tripping the whole document
 * for that would re-serialize the article and make a bookkeeping pass look like a content
 * change in `git diff`. The article is the hash scope, so that would also risk moving the
 * dedup key. Splicing by source offset keeps `contentHash` invariant by construction: the
 * article's bytes stay outside the edited range.
 */

/** The offsets of a source span, half-open. */
interface Span {
  readonly start: number
  readonly end: number
}

/** An element's source span, or `undefined` when the parse carried no location. */
const spanOf = (element: Element): Span | undefined => {
  const location = element.sourceCodeLocation
  if (location === undefined || location === null) return undefined
  return { start: location.startOffset, end: location.endOffset }
}

/** Replace `[span.start, span.end)` with `text`. */
const splice = (html: string, span: Span, text: string): string =>
  html.slice(0, span.start) + text + html.slice(span.end)

/** Insert `text` at `offset`. */
const insertAt = (html: string, offset: number, text: string): string =>
  html.slice(0, offset) + text + html.slice(offset)

/** The `<head>` element of a parsed document. */
const headOf = (document: Document): Element | undefined =>
  elementsOf(document).find((element) => element.tagName === "head")

/** Every `<meta name="memhtml-…">` in the head, in document order. */
const memhtmlMetas = (head: Element): ReadonlyArray<{ element: Element; name: string }> =>
  elementsNamed(head, "meta").flatMap((element) => {
    const name = attr(element, "name")
    return name === undefined || !name.startsWith(META_PREFIX) ? [] : [{ element, name }]
  })

/** Every `<link rel="memhtml-…">` in the head, in document order. */
const memhtmlLinks = (head: Element): ReadonlyArray<Element> =>
  elementsNamed(head, "link").filter((element) =>
    (attr(element, "rel") ?? "").startsWith(META_PREFIX)
  )

/** Position of a name in {@link META_ORDER}; an unknown name sorts last. */
const orderIndexOf = (name: string): number => {
  const index = (META_ORDER as ReadonlyArray<string>).indexOf(name)
  return index === -1 ? META_ORDER.length : index
}

/** One `<meta>` line. */
const metaLine = (name: string, content: string): string =>
  `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}">`

/** One `<link>` line. */
const linkLine = (rel: string, href: string): string =>
  `<link rel="${escapeAttribute(rel)}" href="${escapeAttribute(href)}">`

/**
 * Where a new meta line goes: immediately before the first existing `memhtml-` meta that sorts
 * after it, else after the last one that sorts before it, else before the first `<link>`, else
 * at `</head>`. Following {@link META_ORDER} is what keeps two agents stamping different keys
 * from reordering each other's lines.
 */
const insertionOffsetForMeta = (
  html: string,
  head: Element,
  name: MemoryMetaName
): number | undefined => {
  const target = orderIndexOf(name)
  const metas = memhtmlMetas(head)

  for (const meta of metas) {
    if (orderIndexOf(meta.name) > target) {
      const span = spanOf(meta.element)
      if (span !== undefined) return lineStartAt(html, span.start)
    }
  }
  const before = [...metas].reverse().find((meta) => orderIndexOf(meta.name) <= target)
  if (before !== undefined) {
    const span = spanOf(before.element)
    if (span !== undefined) return lineEndAt(html, span.end)
  }
  return headTailOffset(html, head)
}

/**
 * Where a new `<link>` line goes: after the last existing `memhtml-` link, else at the end of the
 * head, so links stay one block below the metas.
 */
const insertionOffsetForLink = (html: string, head: Element): number | undefined => {
  const links = memhtmlLinks(head)
  const last = links.at(-1)
  if (last !== undefined) {
    const span = spanOf(last)
    if (span !== undefined) return lineEndAt(html, span.end)
  }
  const metas = memhtmlMetas(head)
  const lastMeta = metas.at(-1)
  if (lastMeta !== undefined) {
    const span = spanOf(lastMeta.element)
    if (span !== undefined) return lineEndAt(html, span.end)
  }
  return headTailOffset(html, head)
}

/** The offset of `</head>`, where a line appended to the head belongs. */
const headTailOffset = (html: string, head: Element): number | undefined => {
  const endTag = head.sourceCodeLocation?.endTag
  if (endTag !== undefined) return lineStartAt(html, endTag.startOffset)
  const span = spanOf(head)
  return span?.end
}

/** The start of the line containing `offset`, so an insert there lands on its own line. */
const lineStartAt = (html: string, offset: number): number => {
  const newline = html.lastIndexOf("\n", Math.max(0, offset - 1))
  return newline === -1 ? 0 : newline + 1
}

/**
 * The offset just past the newline that ends the line containing `offset`. An insert there
 * appends a whole line rather than splitting the one already present.
 */
const lineEndAt = (html: string, offset: number): number => {
  const newline = html.indexOf("\n", offset)
  return newline === -1 ? html.length : newline + 1
}

/**
 * Set a head meta to one value, replacing the first `<meta>` of that name in place or inserting
 * a line in {@link META_ORDER} position. Exactly one line changes, and the article stays outside
 * the edited range, so `contentHash(setMeta(html, name, value)) === contentHash(html)` holds
 * for every name, repeatable ones included.
 *
 * On a repeatable key this sets the FIRST value. {@link addMeta} is the append. An unknown name
 * is refused by returning the input unchanged rather than writing a meta `memhtml doctor` would
 * immediately flag.
 */
export const setMeta = (html: string, name: string, value: string): string => {
  if (!isMemoryMetaName(name)) return html
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html

  const existing = memhtmlMetas(head).find((meta) => meta.name === name)
  if (existing !== undefined) {
    const span = spanOf(existing.element)
    if (span === undefined) return html
    return splice(html, span, metaLine(name, value))
  }

  const offset = insertionOffsetForMeta(html, head, name)
  return offset === undefined ? html : insertAt(html, offset, `${metaLine(name, value)}\n`)
}

/**
 * Append another `<meta>` of a repeatable name, a new `memhtml-entity` or `memhtml-tag`, after the
 * last one already present. Adding a value that is already there is a no-op, so the operation
 * is idempotent and a re-run of a sleep phase cannot grow the head.
 */
export const addMeta = (html: string, name: string, value: string): string => {
  if (!isMemoryMetaName(name)) return html
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html

  const present = memhtmlMetas(head).filter((meta) => meta.name === name)
  if (present.some((meta) => attr(meta.element, "content") === value)) return html

  const last = present.at(-1)
  if (last !== undefined) {
    const span = spanOf(last.element)
    if (span !== undefined)
      return insertAt(html, lineEndAt(html, span.end), `${metaLine(name, value)}\n`)
  }
  const offset = insertionOffsetForMeta(html, head, name)
  return offset === undefined ? html : insertAt(html, offset, `${metaLine(name, value)}\n`)
}

/** Drop every `<meta>` of a name, one whole line each. A name that is absent is a no-op. */
export const removeMeta = (html: string, name: string): string => {
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html
  const spans = memhtmlMetas(head)
    .filter((meta) => meta.name === name)
    .flatMap((meta) => {
      const span = spanOf(meta.element)
      return span === undefined
        ? []
        : [{ start: lineStartAt(html, span.start), end: lineEndAt(html, span.end) }]
    })
  return removeSpans(html, spans)
}

/**
 * Append a `<link rel="memhtml-…">` edge. Idempotent on the `(rel, href)` pair, because the sleep
 * conflict phase promotes the same corroborated edge on every run and a duplicated `<link>`
 * would become a duplicated `edges` row.
 */
export const addLink = (html: string, rel: EdgeRel, href: string): string => {
  const token = relTokenFor(rel)
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html
  if (
    memhtmlLinks(head).some((link) => attr(link, "rel") === token && attr(link, "href") === href)
  ) {
    return html
  }
  const offset = insertionOffsetForLink(html, head)
  return offset === undefined ? html : insertAt(html, offset, `${linkLine(token, href)}\n`)
}

/**
 * Drop a `<link rel="memhtml-…">` edge. Omitting `href` drops every link of that rel; naming one
 * drops just that pair, which is what the integrity phase does when it replaces a dangling
 * href with the target's new path.
 */
export const removeLink = (html: string, rel: EdgeRel, href?: string): string => {
  const token = relTokenFor(rel)
  const document = parseDocument(html)
  const head = headOf(document)
  if (head === undefined) return html
  const spans = memhtmlLinks(head)
    .filter(
      (link) => attr(link, "rel") === token && (href === undefined || attr(link, "href") === href)
    )
    .flatMap((link) => {
      const span = spanOf(link)
      return span === undefined
        ? []
        : [{ start: lineStartAt(html, span.start), end: lineEndAt(html, span.end) }]
    })
  return removeSpans(html, spans)
}

/** Cut spans out of a string, back to front so earlier offsets stay valid. */
const removeSpans = (html: string, spans: ReadonlyArray<Span>): string => {
  let out = html
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    out = out.slice(0, span.start) + out.slice(span.end)
  }
  return out
}

/**
 * Every `<link rel="memhtml-*">` edge in the head, in document order. The read half of
 * {@link addLink}/{@link removeLink}, tolerant the way {@link readMeta} is: no full parse, no
 * constraint check, so a caller holding raw bytes can ask what a file points at without earning a
 * `MemoryDoc`. An unknown rel token is dropped exactly as `parseMemory`'s own reader drops it.
 */
export const readLinks = (html: string): ReadonlyArray<MemoryLink> => {
  const head = headOf(parseDocument(html))
  if (head === undefined) return []
  return memhtmlLinks(head).flatMap((element) => {
    const token = attr(element, "rel")
    const href = attr(element, "href")
    if (token === undefined || href === undefined) return []
    const rel = relForToken(token)
    return rel === undefined ? [] : [{ rel, href }]
  })
}

/** The value of a head meta, or `undefined`. The read half of {@link setMeta}, no parse needed. */
export const readMeta = (html: string, name: string): string | undefined => {
  const head = headOf(parseDocument(html))
  if (head === undefined) return undefined
  return memhtmlMetas(head)
    .find((meta) => meta.name === name)
    ?.element.attrs.find((candidate) => candidate.name === "content")?.value
}

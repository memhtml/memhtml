import { relTokenFor } from "@memhtml/contracts/edges"

import type { MemoryDoc } from "./document.js"
import { escapeAttribute, escapeText } from "./markup.js"
import { innerHtml, parseArticleFragment } from "./tree.js"
import { isRepeatableMeta, META_ORDER, type MemoryMetaName } from "./vocabulary.js"

/**
 * Serialize a `MemoryDoc` back to a memory file.
 *
 * The output is deterministic. One `<meta>` per line in {@link META_ORDER}, attributes in a
 * fixed order, and no indentation of head lines, so stamping `memhtml-updated` produces a one-line
 * git diff and two agents stamping different keys leave each other's work in place. A diff that
 * reads as one line is a diff a human reviews. A reordered head is one nobody reads twice.
 */

/** The document preamble, byte for byte. `lang` is fixed: the corpus is English. */
const PREAMBLE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">'
] as const

/**
 * One `<meta name=… content=…>` line. `name` leads and `content` follows, which is the reading
 * order, and the order is fixed, so a head's lines are comparable across files.
 */
const metaLine = (name: string, content: string): string =>
  `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}">`

/** One `<link rel=… href=…>` line. */
const linkLine = (rel: string, href: string): string =>
  `<link rel="${escapeAttribute(rel)}" href="${escapeAttribute(href)}">`

/** Render a number meta. Confidence keeps two decimals; every other number is an integer. */
const formatNumber = (name: MemoryMetaName, value: number): string =>
  name === "memhtml-confidence" ? value.toFixed(2) : String(Math.trunc(value))

/**
 * The metas of a doc as `[name, content]` pairs in {@link META_ORDER}, repeatable keys expanded
 * to one pair per value. A meta whose value is absent contributes nothing, so the file states
 * what it knows and the `files` defaults cover the rest.
 */
export const metaPairs = (doc: MemoryDoc): ReadonlyArray<readonly [MemoryMetaName, string]> => {
  const { metas } = doc
  const scalars = new Map<MemoryMetaName, string>()
  const put = (name: MemoryMetaName, value: string | number | boolean | undefined): void => {
    if (value === undefined) return
    if (typeof value === "number") {
      scalars.set(name, formatNumber(name, value))
      return
    }
    scalars.set(name, typeof value === "boolean" ? String(value) : value)
  }

  put("memhtml-type", metas.memoryType)
  put("memhtml-status", metas.status)
  put("memhtml-created", metas.createdAt)
  put("memhtml-updated", metas.updatedAt)
  put("memhtml-confidence", metas.confidence)
  put("memhtml-importance", metas.importance)
  put("memhtml-content-hash", metas.contentHash)
  put("memhtml-author", metas.author)
  put("memhtml-session", metas.sessionId)
  put("memhtml-prompt", metas.promptId)
  put("memhtml-turn", metas.turnUuid)
  put("memhtml-valid-from", metas.validFrom)
  put("memhtml-valid-until", metas.validUntil)
  put("memhtml-reprieves", metas.reprieves)
  put("memhtml-archived", metas.archivedAt)
  put("memhtml-superseded-by", metas.supersededBy)
  put("memhtml-needs-revision", metas.needsRevision)
  put("memhtml-task-status", metas.taskStatus)
  put("memhtml-due", metas.dueAt)

  const repeatables = new Map<MemoryMetaName, ReadonlyArray<string>>([
    ["memhtml-entity", doc.entities],
    ["memhtml-tag", doc.tags],
    ["memhtml-alias", doc.aliases]
  ])

  const pairs: Array<readonly [MemoryMetaName, string]> = []
  for (const name of META_ORDER) {
    if (isRepeatableMeta(name)) {
      for (const value of repeatables.get(name) ?? []) pairs.push([name, value])
      continue
    }
    const value = scalars.get(name)
    if (value !== undefined) pairs.push([name, value])
  }
  return pairs
}

/**
 * Serialize a doc to a whole file. Inverse of `parseMemory` on the fields the format carries:
 * `parseMemory(serializeMemory(doc))` yields `doc` again, which is the property that lets sleep
 * read, adjust, and write a file back without touching content it did not mean to touch.
 *
 * `article.html` is re-parsed and re-serialized rather than interpolated, so a caller that
 * hand-assembled a doc still gets the canonical, fixed-point markup the round-trip needs.
 */
export const serializeMemory = (doc: MemoryDoc): string => {
  const lines: Array<string> = [...PREAMBLE, `<title>${escapeText(doc.title)}</title>`]
  for (const [name, content] of metaPairs(doc)) lines.push(metaLine(name, content))
  for (const link of doc.links) lines.push(linkLine(relTokenFor(link.rel), link.href))
  lines.push(
    "</head>",
    "<body>",
    "<article>",
    innerHtml(parseArticleFragment(doc.article.html)),
    "</article>",
    "</body>",
    "</html>"
  )
  return `${lines.join("\n")}\n`
}

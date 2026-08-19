import { relForToken } from "@memhtml/contracts/edges"
import { InvalidMemory } from "@memhtml/contracts/errors"
import {
  FINDING_KEY_PATTERN,
  isTaskStatus,
  MEMORY_TYPES,
  type MemoryType,
  TASK_STATUSES,
  type TaskStatus
} from "@memhtml/contracts/types"
import { Effect } from "effect"

import {
  articleOf,
  checkDocument,
  headMetas,
  isValidDatetime,
  VIOLATION_SEPARATOR
} from "./constraints.js"
import type { Citation, Facet, MemoryDoc, MemoryLink, MemoryMetas } from "./document.js"
import { canonicalText } from "./hash.js"

import type { Document, Element, Node } from "./tree.js"
import {
  attr,
  childrenOf,
  elementsNamed,
  elementsOf,
  innerHtml,
  isElement,
  parseDocument
} from "./tree.js"
import { META_PREFIX } from "./vocabulary.js"

/**
 * Parse a memory file into a `MemoryDoc`.
 *
 * The extraction table in `docs/format.md` is implemented here one element at a time. Every
 * output field is named for what the indexer stores, so nothing downstream renames or
 * reinterprets: `gist` is the mark, `eventAt` is the first `<time>`, `facets` are the `<dl>`
 * pairs. A file that violates a constraint yields `InvalidMemory` and no partial doc. A file
 * that only uses an unknown element yields a doc carrying `warnings`.
 */

/** Collapse runs of ASCII whitespace to one space and trim. U+00A0 stays, being content. */
const collapse = (text: string): string => text.replace(/[ \t\n\f\r]+/g, " ").trim()

/**
 * Whitespace-collapsed text of a subtree, blocks separated. Fully collapsing rather than
 * preserving `<pre>` is the difference between this and the hash's own canonicalization. The FTS
 * index and the embedder both tokenize on whitespace, so a code sample's indentation is noise
 * to them and identity to the digest.
 */
const textContent = (root: Node): string => collapse(canonicalText(root))

/**
 * Text of a subtree with `<pre>` and `<code>` subtrees omitted. The gist rule: a command line
 * is body text and it is searchable, and it is not part of the claim.
 */
const textExcludingCode = (root: Node): string =>
  collapse(canonicalText(root, { excludeCode: true }))

/** Narrow a `memhtml-type` content string to the closed type vocabulary. */
const asMemoryType = (value: string): MemoryType | undefined =>
  (MEMORY_TYPES as ReadonlyArray<string>).includes(value) ? (value as MemoryType) : undefined

/** Parse a `[0, 1]` or `[1, 10]` meta value, rejecting a non-finite or out-of-range one. */
const boundedNumber = (
  value: string | undefined,
  minimum: number,
  maximum: number,
  integral: boolean
): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return undefined
  if (integral && !Number.isInteger(parsed)) return undefined
  return parsed
}

/**
 * Read the typed metas out of the head. A malformed optional value is dropped rather than
 * failing the parse: `memhtml-confidence="high"` means the file did not state a confidence, and
 * the `files` default applies. `memhtml doctor` reports the drop; a write does not die on it.
 */
const readMetas = (
  metas: ReadonlyArray<{ name: string; content: string }>
): {
  readonly metas: MemoryMetas | undefined
  readonly violations: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
} => {
  const single = (name: string): string | undefined =>
    metas.find((meta) => meta.name === name)?.content

  const rawType = single("memhtml-type")
  const memoryType = rawType === undefined ? undefined : asMemoryType(rawType)
  const rawStatus = single("memhtml-status")
  const status = rawStatus === "active" || rawStatus === "archived" ? rawStatus : undefined
  const createdAt = single("memhtml-created")
  const updatedAt = single("memhtml-updated")

  const violations: Array<string> = []
  if (rawType !== undefined && memoryType === undefined) {
    violations.push(
      `<meta name="memhtml-type" content="${rawType}"> is outside the type vocabulary`
    )
  }
  if (rawStatus !== undefined && status === undefined) {
    violations.push(
      `<meta name="memhtml-status" content="${rawStatus}"> is neither active nor archived`
    )
  }
  violations.push(
    ...taskViolations(memoryType, single("memhtml-task-status"), single("memhtml-due"))
  )

  const rawFindingKey = single("memhtml-finding-key")
  const findingKey = asFindingKey(rawFindingKey)
  const warnings = metaWarnings(rawFindingKey, findingKey)

  if (
    memoryType === undefined ||
    status === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return { metas: undefined, violations, warnings }
  }

  const optionals = {
    confidence: boundedNumber(single("memhtml-confidence"), 0, 1, false),
    importance: boundedNumber(single("memhtml-importance"), 1, 10, true),
    contentHash: single("memhtml-content-hash"),
    author: single("memhtml-author"),
    sessionId: single("memhtml-session"),
    promptId: single("memhtml-prompt"),
    turnUuid: single("memhtml-turn"),
    validFrom: single("memhtml-valid-from"),
    validUntil: single("memhtml-valid-until"),
    reprieves: boundedNumber(single("memhtml-reprieves"), 0, Number.MAX_SAFE_INTEGER, true),
    archivedAt: single("memhtml-archived"),
    supersededBy: single("memhtml-superseded-by"),
    needsRevision: readBoolean(single("memhtml-needs-revision")),
    taskStatus: asTaskStatus(single("memhtml-task-status")),
    dueAt: single("memhtml-due"),
    findingKey
  }

  return {
    metas: {
      memoryType,
      status,
      createdAt,
      updatedAt,
      ...definedOnly(optionals)
    },
    violations,
    warnings
  }
}

/** Narrow a `memhtml-task-status` content string to the closed status vocabulary. */
const asTaskStatus = (value: string | undefined): TaskStatus | undefined =>
  value !== undefined && isTaskStatus(value) ? value : undefined

/**
 * Narrow a `memhtml-finding-key` content string to `<detector>:<digest16>`. Anything else is
 * absent, so `metas.findingKey` is either a well-formed anchor or nothing, and the dedup path
 * that reads it never has to re-validate what the parser already accepted.
 */
const asFindingKey = (value: string | undefined): string | undefined =>
  value !== undefined && FINDING_KEY_PATTERN.test(value) ? value : undefined

/**
 * The head's WARNINGS, as distinct from its violations. One entry so far.
 *
 * `memhtml-finding-key` is deliberately NOT on `taskViolations`'s path, and the difference is the
 * whole point of the meta. The two task metas are refusals because the task's own lifecycle
 * position is missing or contradictory, and a file the indexer must skip is better than one it
 * indexes wrongly. A finding key is bookkeeping ABOUT a task — which detector filed it, so a
 * second run recognizes its own work — and the task is a real task whether or not the anchor
 * parses. Refusing the file over a mistyped key would make `memhtml task list` lose a task a human
 * can see in the tree, which is the exact failure the graceful-degradation rule exists to prevent.
 * Dedup treats a malformed key as no key: the worst case is one duplicate task, not a vanished one.
 */
const metaWarnings = (
  rawFindingKey: string | undefined,
  findingKey: string | undefined
): ReadonlyArray<string> =>
  rawFindingKey !== undefined && findingKey === undefined
    ? [
        `<meta name="memhtml-finding-key" content="${rawFindingKey}"> is not <detector>:<16 hex digits>`
      ]
    : []

/**
 * The task metas' agreement with the type, reported as violations, not as dropped optionals.
 *
 * A malformed *optional* meta is dropped and reported by `memhtml doctor`. These two are not
 * ordinary optionals: they are the type's own required field and a field the type does not have.
 * A `task` file with no `memhtml-task-status` has no lifecycle position at all, so `memhtml task list`
 * would omit it from every status filter and the task would be invisible to the surface that
 * exists to show it. A non-task carrying one asserts a lifecycle nothing advances. Both are
 * refusals, so the disagreement does not reach the index.
 *
 * `memhtml-due` reuses the `<time datetime>` validator: `files.due_at` is compared and ordered as a
 * string, so a value that does not sort lexicographically alongside the others would make an
 * overdue query silently wrong rather than empty.
 */
const taskViolations = (
  memoryType: MemoryType | undefined,
  rawTaskStatus: string | undefined,
  rawDue: string | undefined
): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const isTask = memoryType === "task"

  if (rawTaskStatus !== undefined && !isTask) {
    violations.push(
      `<meta name="memhtml-task-status"> on a ${memoryType ?? "typeless"} memory: only a task carries one`
    )
  }
  if (rawTaskStatus !== undefined && !isTaskStatus(rawTaskStatus)) {
    violations.push(
      `<meta name="memhtml-task-status" content="${rawTaskStatus}"> is outside the vocabulary: ${TASK_STATUSES.join(", ")}`
    )
  }
  if (isTask && rawTaskStatus === undefined) {
    violations.push('a task requires <meta name="memhtml-task-status">')
  }
  if (rawDue !== undefined && !isValidDatetime(rawDue)) {
    violations.push(`<meta name="memhtml-due" content="${rawDue}"> is not an ISO date or datetime`)
  }
  return violations
}

/** `true`/`1`/`yes` is true, anything else present is false, absent stays absent. */
const readBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : ["true", "1", "yes"].includes(value.toLowerCase())

/**
 * Drop keys whose value is `undefined`. Under `exactOptionalPropertyTypes` an explicit
 * `confidence: undefined` is a different type from an absent key, and the schema's `optional`
 * fields want the key absent when the file did not state the value.
 */
const definedOnly = <T extends Record<string, unknown>>(input: T): Partial<T> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

/** Repeated meta values in document order, e.g. every `memhtml-entity`. */
const repeated = (
  metas: ReadonlyArray<{ name: string; content: string }>,
  name: string
): ReadonlyArray<string> =>
  metas.filter((meta) => meta.name === name && meta.content !== "").map((meta) => meta.content)

/** The `<link rel="memhtml-*">` edges of a head, unknown rels already refused by constraint 4. */
const readLinks = (document: Document): ReadonlyArray<MemoryLink> => {
  const head = elementsOf(document).find((element) => element.tagName === "head")
  if (head === undefined) return []
  return elementsNamed(head, "link").flatMap((element) => {
    const token = attr(element, "rel")
    const href = attr(element, "href")
    if (token === undefined || !token.startsWith(META_PREFIX) || href === undefined) return []
    const rel = relForToken(token)
    return rel === undefined ? [] : [{ rel, href }]
  })
}

/**
 * `<dt>`/`<dd>` pairs of every `<dl>`, positionally paired in document order.
 *
 * A `<dt>` may govern several `<dd>`s (HTML allows it), so each `<dd>` becomes its own facet
 * row under the most recent `<dt>`. That keeps `file_facets` one row per value rather than
 * one row per definition list, which is what a facet query needs.
 */
const readFacets = (article: Element): ReadonlyArray<Facet> => {
  const facets: Array<Facet> = []
  for (const list of elementsNamed(article, "dl")) {
    let name: string | undefined
    for (const child of childrenOf(list)) {
      if (!isElement(child)) continue
      if (child.tagName === "dt") {
        name = textContent(child)
        continue
      }
      if (child.tagName !== "dd" || name === undefined) continue
      const value = textContent(child)
      const numericValue = readDataValue(child)
      facets.push({ name, value, ...definedOnly({ numericValue }) })
    }
  }
  return facets
}

/** The first `<data value>` inside a `<dd>`, as a finite number. Absent when there is none. */
const readDataValue = (definition: Element): number | undefined => {
  for (const data of elementsNamed(definition, "data")) {
    const raw = attr(data, "value")
    if (raw === undefined) continue
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** `<cite>` and `<q cite>` in document order. A `<q>` records its source URI; a `<cite>` has none. */
const readCitations = (article: Element): ReadonlyArray<Citation> =>
  elementsNamed(article, "cite", "q").flatMap((element) => {
    const text = textContent(element)
    if (text === "") return []
    const href = element.tagName === "q" ? attr(element, "cite") : undefined
    return [{ text, ...definedOnly({ href }) }]
  })

/** Extract everything the indexer reads out of the article. */
const readArticle = (article: Element): MemoryDoc["article"] => {
  const [mark] = elementsNamed(article, "mark")
  const [time] = elementsNamed(article, "time")
  const eventAt = time === undefined ? undefined : attr(time, "datetime")

  return {
    html: innerHtml(article),
    bodyText: textContent(article),
    gist: mark === undefined ? "" : textExcludingCode(mark),
    ...definedOnly({ eventAt }),
    facets: readFacets(article),
    citations: readCitations(article),
    definedTerms: elementsNamed(article, "dfn")
      .map((element) => textContent(element))
      .filter((term) => term !== ""),
    summaryTexts: elementsNamed(article, "summary")
      .map((element) => textContent(element))
      .filter((text) => text !== ""),
    asideTexts: elementsNamed(article, "aside")
      .map((element) => textContent(element))
      .filter((text) => text !== ""),
    captions: elementsNamed(article, "figcaption")
      .map((element) => textContent(element))
      .filter((text) => text !== ""),
    codeLangs: elementsNamed(article, "code").flatMap((element) => {
      const lang = attr(element, "data-lang")
      return lang === undefined || lang.trim() === "" ? [] : [lang.trim().toLowerCase()]
    }),
    abbreviations: elementsNamed(article, "abbr").flatMap((element) => {
      const title = attr(element, "title")
      return title === undefined || title.trim() === "" ? [] : [title.trim()]
    })
  }
}

/**
 * Parse a memory file. Fails with `InvalidMemory` whose `reason` is every violation joined by
 * {@link VIOLATION_SEPARATOR}. The error type carries one string, so the list is joined rather
 * than smuggled through a field the frozen contract does not have. A caller that wants the
 * structured list calls {@link checkMemory}.
 */
export const parseMemory = (html: string): Effect.Effect<MemoryDoc, InvalidMemory> =>
  Effect.suspend(() => {
    const document = parseDocument(html)
    const structural = checkDocument(document)
    const metaResult = readMetas(headMetas(document))
    const article = articleOf(document)
    const violations = [...structural.violations, ...metaResult.violations]

    if (violations.length > 0 || metaResult.metas === undefined || article === undefined) {
      const reason =
        violations.length > 0 ? violations.join(VIOLATION_SEPARATOR) : "head metadata is incomplete"
      return Effect.fail(InvalidMemory.make({ reason }))
    }

    const metas = headMetas(document)
    const [title] = elementsNamed(document, "title")
    return Effect.succeed({
      title: title === undefined ? "" : textContent(title),
      metas: metaResult.metas,
      entities: repeated(metas, "memhtml-entity"),
      tags: repeated(metas, "memhtml-tag"),
      aliases: repeated(metas, "memhtml-alias"),
      links: readLinks(document),
      article: readArticle(article),
      warnings: [...structural.warnings, ...metaResult.warnings]
    })
  })

/**
 * Check a file without building a doc: the structured `{ violations, warnings }` `memhtml doctor`
 * reports. Total, so a completely malformed string yields violations instead of throwing.
 */
export const checkMemory = (
  html: string
): { readonly violations: ReadonlyArray<string>; readonly warnings: ReadonlyArray<string> } => {
  const document = parseDocument(html)
  const structural = checkDocument(document)
  const metaResult = readMetas(headMetas(document))
  return {
    violations: [...structural.violations, ...metaResult.violations],
    warnings: [...structural.warnings, ...metaResult.warnings]
  }
}

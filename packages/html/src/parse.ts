import { relForToken } from "@memhtml/contracts/edges"
import { InvalidMemory } from "@memhtml/contracts/errors"
import {
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

/**
 * Parse a `[0, 1]` or `[1, 10]` meta value, rejecting a non-finite or out-of-range one.
 *
 * A blank value is malformed, not zero: `Number("")` is `0`, and a `<meta>` whose `content` is
 * empty or whitespace stated no number, so it is dropped and the `files` default applies —
 * a blank `memhtml-confidence` must not index as `0.00`.
 */
const boundedNumber = (
  value: string | undefined,
  minimum: number,
  maximum: number,
  integral: boolean
): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined
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
): { readonly metas: MemoryMetas | undefined; readonly violations: ReadonlyArray<string> } => {
  const single = (name: string): string | undefined =>
    metas.find((meta) => meta.name === name)?.content

  const rawType = single("memhtml-type")
  const memoryType = rawType === undefined ? undefined : asMemoryType(rawType)
  const rawStatus = single("memhtml-status")
  const status = rawStatus === "active" || rawStatus === "archived" ? rawStatus : undefined
  const createdAt = asDatetime(single("memhtml-created"))
  const updatedAt = asDatetime(single("memhtml-updated"))

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
  violations.push(...datetimeViolations(metas))

  if (
    memoryType === undefined ||
    status === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return { metas: undefined, violations }
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
    dueAt: single("memhtml-due")
  }

  return {
    metas: {
      memoryType,
      status,
      createdAt,
      updatedAt,
      ...definedOnly(optionals)
    },
    violations
  }
}

/** Narrow a `memhtml-task-status` content string to the closed status vocabulary. */
const asTaskStatus = (value: string | undefined): TaskStatus | undefined =>
  value !== undefined && isTaskStatus(value) ? value : undefined

/**
 * Every meta whose content is an instant, so every meta whose value has to sort.
 *
 * The five are one list because they share one hazard, not because they share a shape: each lands
 * in a `files` column that SQL compares and orders as a raw string. `created_at` and `updated_at`
 * order the recency arm (`packages/index/src/retrieval-sql.ts`), `valid_from` and `valid_until`
 * bound the as-of window (`packages/index/src/scope.ts`), and `archived_at` dates an eviction in
 * the retention reads. `memhtml-due` is the sixth and is checked in {@link taskViolations}, beside
 * the type rule it belongs to.
 */
const DATETIME_METAS = [
  "memhtml-created",
  "memhtml-updated",
  "memhtml-valid-from",
  "memhtml-valid-until",
  "memhtml-archived"
] as const

/** A datetime meta's value when it matches the format's grammar, `undefined` when it does not. */
const asDatetime = (value: string | undefined): string | undefined =>
  value !== undefined && isValidDatetime(value) ? value : undefined

/**
 * Every stated datetime meta outside the `<time datetime>` grammar, as violations.
 *
 * A violation and not a dropped optional, for all five, which is `memhtml-due`'s discipline rather
 * than {@link boundedNumber}'s. A drop is only safe where the `files` table owns a default: a blank
 * `memhtml-confidence` has one, and an instant does not. Dropping an unsortable `memhtml-valid-until`
 * WIDENS the window to always-valid, so the file would answer an as-of query for instants it said
 * the fact was already dead — a wrong point-in-time view where a refusal is a visible one. The two
 * required stamps take the same rule for a plainer reason: a value that sorts by its spelling
 * instead of its instant ranks a newer memory below an older one, because
 * `"2026-08-24 13:00:00Z" < "2026-08-24T12:00:00Z"` is true of the strings and false of the
 * moments.
 *
 * Refusing at the parse boundary is what keeps the column clean. Every consumer downstream compares
 * these values without re-parsing them, so the grammar is the only thing standing between an
 * unsortable string and a silently reordered result set.
 */
const datetimeViolations = (
  metas: ReadonlyArray<{ name: string; content: string }>
): ReadonlyArray<string> =>
  DATETIME_METAS.flatMap((name) => {
    const raw = metas.find((meta) => meta.name === name)?.content
    return raw === undefined || isValidDatetime(raw)
      ? []
      : [`<meta name="${name}" content="${raw}"> is not an ISO date or datetime`]
  })

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

/**
 * The first `<data value>` inside a `<dd>`, as a finite number. Absent when there is none.
 *
 * A blank `value` stated no number, the same trap {@link boundedNumber} guards: `Number("")` and
 * `Number(" ")` are both `0`, and `file_facets.numeric_value` is present only when the `<dd>`
 * carries a `<data value>` that parses as a finite number. A blank one therefore leaves the column
 * NULL rather than storing a measured zero the file never claimed.
 */
const readDataValue = (definition: Element): number | undefined => {
  for (const data of elementsNamed(definition, "data")) {
    const raw = attr(data, "value")
    if (raw === undefined || raw.trim() === "") continue
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
      warnings: structural.warnings
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
    warnings: structural.warnings
  }
}

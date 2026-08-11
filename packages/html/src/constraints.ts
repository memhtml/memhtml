import { relForToken } from "@memhtml/contracts/edges"

import { LANG_TOKEN } from "./fences.js"
import { canonicalText } from "./hash.js"
import type { Document, Element } from "./tree.js"
import {
  attr,
  childrenOf,
  elementsNamed,
  elementsOf,
  hasAncestor,
  isElement,
  isTextNode,
  isWithin
} from "./tree.js"
import {
  EVENT_HANDLER_PREFIX,
  FORBIDDEN_ATTRIBUTES,
  FORBIDDEN_ELEMENTS,
  isFigureScopedElement,
  isMemoryMetaName,
  isRepeatableMeta,
  KNOWN_ELEMENTS,
  META_PREFIX,
  REQUIRED_META
} from "./vocabulary.js"

/**
 * The six format constraints, as pure predicates over a parsed document.
 *
 * Constraints 1-5 are violations: the file is not a memory and `parseMemory` fails. Constraint
 * 6 is a warning: an element outside the vocabulary still indexes, because the format has to
 * degrade gracefully on a file a human hand-wrote in a hurry.
 *
 * Nothing here throws and nothing repairs — a checker that silently fixed a violation would
 * make `memhtml doctor` report a clean corpus that the next hand-edit breaks again.
 */

/** How violations are joined into `InvalidMemory.reason`, which carries a single string. */
export const VIOLATION_SEPARATOR = "; "

/** The outcome of checking a document. Both lists are in constraint order, then document order. */
export interface CheckResult {
  readonly violations: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}

/**
 * ISO date `YYYY-MM-DD`, optionally with a time and a zone. What `<time datetime>` must match.
 *
 * The time components carry their ranges in the character classes rather than being checked
 * afterwards: an hour of `25` is not a time at all, and a value that is not a time cannot be
 * compared with one that is. `60` seconds is admitted — a leap second is a real instant.
 */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::(?:[0-5]\d|60)(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/

/**
 * True when a `datetime` value is one this format accepts: a calendar date, or a date with a
 * time. Narrower than HTML's own `datetime` grammar (which admits durations, weeks, and bare
 * times) because `files.event_at` and `files.due_at` are compared and ordered as strings — a
 * value that does not sort lexicographically alongside the others would corrupt the recency arm
 * and the overdue query alike.
 *
 * Range is checked too, so `2026-13-45` is refused rather than stored as an unsortable date.
 */
export const isValidDatetime = (value: string): boolean => {
  if (!ISO_DATETIME.test(value)) return false
  const [datePart] = value.split(/[T ]/, 1)
  if (datePart === undefined) return false
  const [year, month, day] = datePart.split("-").map(Number)
  if (year === undefined || month === undefined || day === undefined) return false
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

/**
 * True when a `<link>` href is the document-reference form the format requires:
 * repo-root-relative with a leading slash, no scheme, no host, no `..` segment.
 *
 * A relative href would break on the first `git mv` of the *source* file and a protocol-relative
 * `//host/x` would silently leave the repo, so both are refused rather than normalized.
 */
export const isRootRelativeHref = (href: string): boolean => {
  if (!href.startsWith("/") || href.startsWith("//")) return false
  const [path] = href.split(/[?#]/, 1)
  if (path === undefined) return false
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

/** The `<head>` element, or `undefined` on a document with no head. */
const headOf = (document: Document): Element | undefined =>
  elementsOf(document).find((element) => element.tagName === "head")

/** The `<meta name=… content=…>` pairs of a head, in document order. */
export const headMetas = (document: Document): ReadonlyArray<{ name: string; content: string }> => {
  const head = headOf(document)
  if (head === undefined) return []
  return elementsNamed(head, "meta").flatMap((element) => {
    const name = attr(element, "name")
    if (name === undefined) return []
    return [{ name, content: attr(element, "content") ?? "" }]
  })
}

/** Constraint 1: exactly one `<article>`. Everything downstream assumes a single hash scope. */
const checkArticle = (
  document: Document
): { article?: Element; violations: ReadonlyArray<string> } => {
  const articles = elementsNamed(document, "article")
  if (articles.length === 0)
    return { violations: ["no <article>: a memory file needs exactly one"] }
  if (articles.length > 1) {
    return {
      violations: [`${articles.length} <article> elements: a memory file needs exactly one`]
    }
  }
  const [article] = articles
  return article === undefined ? { violations: ["no <article>"] } : { article, violations: [] }
}

/**
 * True when a `<mark>` would yield an empty `files.gist`.
 *
 * The predicate is the GIST rule verbatim — `canonicalText` with `excludeCode`, then trimmed — and
 * that identity is the point rather than a convenience: `parse.ts` derives `gist` from exactly this
 * text, so a constraint computed any other way could refuse a file whose gist is fine or pass one
 * whose gist is empty. Two consequences fall out of using the real rule. A mark whose text arrives
 * through a nested `<strong>` is NOT empty, though the direct-text `textOf` below would call it so.
 * A mark containing only `<code>` IS empty, because a command line is body text and never the
 * claim — so `<mark><code>drain --vip</code></mark>` indexes with no gist and must be refused here.
 *
 * U+00A0 is whitespace for this purpose. It is content to the hash (`hash.ts`'s ASCII-only
 * collapse), because a non-breaking space inside a claim is a typographic decision worth
 * preserving; but a claim consisting of nothing else says nothing, and `String.trim` removes it,
 * which is also what makes `gist` empty for that file.
 */
const isEmptyClaim = (mark: Element): boolean =>
  canonicalText(mark, { excludeCode: true }).trim() === ""

/**
 * Constraint 1 continued and constraint 5: exactly one `<mark>`, carrying non-empty text,
 * positioned in the article's first `<p>` or first `<li>`, and never inside an `<aside>` or
 * `<details>`.
 *
 * The position rule is what makes the claim the *lead* rather than a highlight buried in
 * paragraph nine, and the fold rule is what keeps a recall line from quoting a caveat or
 * something the author chose to hide.
 *
 * The non-empty rule closes the hole those two leave open. An empty `<mark>` satisfies the count
 * and the placement, so `<p><mark></mark> the prose</p>` used to pass the store's render gate and
 * land a committed, indexed file with an empty `files.gist` — absent from every disclosure tier and
 * from the recall pack's quoted body, so invisible rather than merely wrong. Both write doors
 * already derived a claim from prose to route around it (`apps/cli/src/prose.ts`); with the rule
 * here, the gate owns the invariant and the doors are defense in depth.
 */
const checkMark = (article: Element): ReadonlyArray<string> => {
  const marks = elementsNamed(article, "mark")
  if (marks.length === 0) return ["no <mark>: the claim span is required"] as const
  if (marks.length > 1) {
    return [`${marks.length} <mark> elements: exactly one span is the claim`] as const
  }
  const [mark] = marks
  if (mark === undefined) return ["no <mark>"] as const

  const violations: Array<string> = []
  if (isEmptyClaim(mark)) violations.push("empty <mark>: the claim span must say something")

  /**
   * The fold violations suppress the position check, and emptiness deliberately does not.
   *
   * A mark inside an `<aside>` is never in the first `<p>`, so reporting both would name one
   * mistake twice and the position line would be the less useful of the two. Emptiness is an
   * orthogonal defect — an empty mark can be correctly or incorrectly placed, and an author fixing
   * one still has the other — so it is collected alongside, per `checkDocument`'s rule that one
   * parse tells an author everything wrong with the file.
   */
  const folded: Array<string> = []
  if (hasAncestor(mark, "aside")) folded.push("<mark> inside <aside>: the claim is never a caveat")
  if (hasAncestor(mark, "details")) {
    folded.push("<mark> inside <details>: the claim is never behind a fold")
  }
  if (folded.length > 0) return [...violations, ...folded]

  const [firstBlock] = elementsNamed(article, "p", "li")
  if (firstBlock === undefined) {
    violations.push("<mark> outside any <p> or <li>: the claim must lead a paragraph or list item")
  } else if (!isWithin(mark, firstBlock)) {
    violations.push(
      `<mark> not in the first <${firstBlock.tagName}>: the claim must lead the article`
    )
  }
  return violations
}

/** Constraint 2: every `<time>` carries a `datetime` this format can sort. */
const checkTimes = (document: Document): ReadonlyArray<string> =>
  elementsNamed(document, "time").flatMap((element) => {
    const value = attr(element, "datetime")
    if (value === undefined) return [`<time> without datetime: "${textOf(element)}"`]
    return isValidDatetime(value)
      ? []
      : [`<time datetime="${value}"> is not an ISO date or datetime`]
  })

/** Direct text of an element, for a violation message. Kept short so a message stays readable. */
const textOf = (element: Element): string =>
  childrenOf(element)
    .filter(isTextNode)
    .map((node) => node.value)
    .join("")
    .trim()
    .slice(0, 40)

/**
 * Constraint 3: no `class`, no `style`, no `<script>`/`<style>`, no `on*` handler. A memory
 * file is data; presentation belongs to a stylesheet and behavior belongs nowhere.
 */
const checkNoPresentationOrScript = (document: Document): ReadonlyArray<string> => {
  const violations: Array<string> = []
  for (const element of elementsOf(document)) {
    if (FORBIDDEN_ELEMENTS.has(element.tagName)) {
      violations.push(`<${element.tagName}> is forbidden: a memory file does not execute or style`)
    }
    for (const { name } of element.attrs) {
      const lowered = name.toLowerCase()
      if (FORBIDDEN_ATTRIBUTES.has(lowered)) {
        violations.push(`${lowered} attribute on <${element.tagName}>: presentation is not memory`)
      } else if (
        lowered.startsWith(EVENT_HANDLER_PREFIX) &&
        lowered.length > EVENT_HANDLER_PREFIX.length
      ) {
        violations.push(
          `${lowered} handler on <${element.tagName}>: a memory file does not execute`
        )
      }
    }
  }
  return violations
}

/** Constraint 4: every `<link rel="memhtml-*">` names a closed-vocabulary rel and a root-relative href. */
const checkLinks = (document: Document): ReadonlyArray<string> => {
  const head = headOf(document)
  if (head === undefined) return []
  return elementsNamed(head, "link").flatMap((element) => {
    const rel = attr(element, "rel")
    if (rel === undefined || !rel.startsWith(META_PREFIX)) return []
    const href = attr(element, "href")
    const violations: Array<string> = []
    if (relForToken(rel) === undefined) {
      violations.push(`<link rel="${rel}"> is outside the closed edge vocabulary`)
    }
    if (href === undefined || href === "") {
      violations.push(`<link rel="${rel}"> without href`)
    } else if (!isRootRelativeHref(href)) {
      violations.push(`<link rel="${rel}" href="${href}"> is not repo-root-relative`)
    }
    return violations
  })
}

/**
 * The head's own well-formedness: a non-empty `<title>`, the four required metas present once
 * each, no unknown `memhtml-` name, and no non-repeatable key stated twice.
 *
 * A duplicate `memhtml-type` is a violation rather than a last-wins pick, because two writers
 * disagreeing about a memory's type is the sort of thing that should stop a write.
 */
const checkHead = (document: Document): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const titles = elementsNamed(document, "title")
  if (titles.length !== 1) {
    violations.push(`${titles.length} <title> elements: a memory file needs exactly one`)
  } else {
    const [title] = titles
    if (title === undefined || textOf(title) === "") violations.push("empty <title>")
  }

  const metas = headMetas(document)
  const counts = new Map<string, number>()
  for (const { name } of metas) counts.set(name, (counts.get(name) ?? 0) + 1)

  for (const required of REQUIRED_META) {
    if ((counts.get(required) ?? 0) === 0)
      violations.push(`missing required <meta name="${required}">`)
  }
  for (const [name, count] of counts) {
    if (!name.startsWith(META_PREFIX)) continue
    if (!isMemoryMetaName(name)) {
      violations.push(`<meta name="${name}"> is outside the closed metadata vocabulary`)
      continue
    }
    if (count > 1 && !isRepeatableMeta(name)) {
      violations.push(`<meta name="${name}"> appears ${count} times but is not repeatable`)
    }
  }
  return violations
}

/**
 * Constraint 6: an element outside the vocabulary warns. `<div>`/`<span>` warn only outside a
 * `<figure>`, where a pasted code sample legitimately carries its own containers.
 *
 * A `data-lang` value outside the token grammar also warns rather than refusing: the language
 * tag is retrieval convenience (it promotes to a `lang:` entity), and refusing the whole file
 * over a decoration would violate the degrade-gracefully rule hand-authored files rely on.
 *
 * Warnings are deduplicated by element name: a file with forty stray `<div>`s should produce
 * one actionable line, not forty identical ones.
 */
const collectWarnings = (document: Document): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const warnings: Array<string> = []
  const push = (key: string, message: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    warnings.push(message)
  }
  for (const element of elementsOf(document)) {
    const { tagName } = element
    const lang = attr(element, "data-lang")
    if (lang !== undefined && !LANG_TOKEN.test(lang)) {
      push(`lang:${lang}`, `data-lang="${lang}" is not a language token`)
    }
    if (isFigureScopedElement(tagName)) {
      if (!hasAncestor(element, "figure")) {
        push(`scoped:${tagName}`, `<${tagName}> outside a <figure>: use a semantic element instead`)
      }
      continue
    }
    if (!KNOWN_ELEMENTS.has(tagName)) {
      push(`unknown:${tagName}`, `<${tagName}> is outside the closed vocabulary`)
    }
  }
  return warnings
}

/**
 * Check a parsed document against all six constraints. Violations are collected rather than
 * short-circuited, so one parse tells an author everything wrong with the file.
 */
export const checkDocument = (document: Document): CheckResult => {
  const { article, violations: articleViolations } = checkArticle(document)
  const violations = [
    ...checkHead(document),
    ...articleViolations,
    ...(article === undefined ? [] : checkMark(article)),
    ...checkTimes(document),
    ...checkNoPresentationOrScript(document),
    ...checkLinks(document)
  ]
  return { violations, warnings: collectWarnings(document) }
}

/** The article element of a checked document, or `undefined` when constraint 1 failed. */
export const articleOf = (document: Document): Element | undefined => {
  const articles = elementsNamed(document, "article")
  return articles.length === 1 && articles[0] !== undefined && isElement(articles[0])
    ? articles[0]
    : undefined
}

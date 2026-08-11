import { EdgeRel } from "@memhtml/contracts/edges"
import {
  Confidence,
  Importance,
  MemoryStatus,
  MemoryType,
  TaskStatus
} from "@memhtml/contracts/types"
import { Schema } from "effect"

/**
 * `MemoryDoc` — the parsed form of a memory file. It lives here rather than in
 * `@memhtml/contracts` because these are format types: the extraction fields exist only because
 * the HTML has those elements, and a change to the vocabulary changes this shape.
 *
 * Every field's coordinate space is stated on it. The indexer consumes these names directly,
 * and a field whose scope is ambiguous is exactly the seam the fleet has paid for six times.
 */

/**
 * The head's typed metadata. Absent means the file did not state it — never a substituted
 * default, because the `files` table owns the defaults and a parser that invents `confidence:
 * 1.0` would make a hand-authored omission indistinguishable from a deliberate assertion.
 *
 * Timestamps are ISO-8601 UTC instants of *write* time. `createdAt` is when the memory was
 * first written and `updatedAt` when it last changed — neither is when the remembered fact
 * happened, which is `article.eventAt`.
 */
export const MemoryMetas = Schema.Struct({
  memoryType: MemoryType,
  status: MemoryStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Unitless in `[0, 1]`. 1.0 is an unqualified assertion. */
  confidence: Schema.optional(Confidence),
  /** 1-10 inclusive, a display ordinal. The retention scorer divides by 10 before using it. */
  importance: Schema.optional(Importance),
  /**
   * The `sha256:<hex>` the file claims for its own article. Advisory: the parser reports it
   * verbatim and never repairs it, so a stale value is visible to `memhtml doctor` rather than
   * silently corrected into agreement.
   */
  contentHash: Schema.optional(Schema.String),
  /** Who wrote it, as `agent:<model>` or `human:<name>`. */
  author: Schema.optional(Schema.String),
  /** The Claude Code session that produced it. Joins `traces.session_id`. */
  sessionId: Schema.optional(Schema.String),
  /** The prompt within that session. Joins `trace_prompts.prompt_id`. */
  promptId: Schema.optional(Schema.String),
  /** The turn within that session. Joins `trace_prompts.turn_uuid`. */
  turnUuid: Schema.optional(Schema.String),
  /** Bitemporal validity of the *fact*, not of the row. Absent means always-valid. */
  validFrom: Schema.optional(Schema.String),
  validUntil: Schema.optional(Schema.String),
  /**
   * How many times sleep spared this memory from eviction. A count, monotonically
   * non-decreasing, `>= 0`.
   */
  reprieves: Schema.optional(Schema.Number),
  /** When eviction moved it under `archive/<YYYY>/`. Present iff `status` is `archived`. */
  archivedAt: Schema.optional(Schema.String),
  /**
   * The path that replaced it, repo-root-relative with a leading `/` (the document-reference
   * form). The inverse of a `memhtml-supersedes` link on the newer file.
   */
  supersededBy: Schema.optional(Schema.String),
  /** Sleep flagged the claim as stale or contested and wants an agent to revisit it. */
  needsRevision: Schema.optional(Schema.Boolean),
  /**
   * A task's own lifecycle position, present iff `memoryType` is `task` — the parser reports a
   * violation either way round. A separate axis from {@link MemoryMetas.status}, which stays
   * `active`/`archived` for a task as for anything else.
   */
  taskStatus: Schema.optional(TaskStatus),
  /**
   * When a task is due. An ISO date or datetime, ordered as a string exactly as `event_at` is,
   * so `due_at < now` is a lexicographic comparison rather than a parse per row.
   *
   * A wall-clock DEADLINE, not a write time and not a validity bound: `validUntil` says when a
   * remembered fact stops being true, and this says when work is late.
   */
  dueAt: Schema.optional(Schema.String)
})
export type MemoryMetas = typeof MemoryMetas.Type

/**
 * One `<link rel="memhtml-*">`. `rel` is the unprefixed rel from the closed edge vocabulary; the
 * `memhtml-`-prefixed hyphenated token is the wire form and is re-derived on serialize.
 *
 * `href` is the document-reference form — repo-root-relative *with* a leading slash, as it
 * appears in the file. The git-tree form the `edges` table stores drops that slash;
 * `@memhtml/contracts`'s `normalizePath` is the conversion, applied at the store boundary.
 */
export const MemoryLink = Schema.Struct({
  rel: EdgeRel,
  href: Schema.String
})
export type MemoryLink = typeof MemoryLink.Type

/**
 * One `<dt>`/`<dd>` pair. `name` is the `<dt>` text, `value` the `<dd>` text.
 *
 * `numericValue` is present only when the `<dd>` holds a `<data value>` whose attribute parses
 * as a finite number. It is unitless here on purpose: the unit lives in the human phrasing
 * (`<data value="120">about two minutes</data>` is seconds because the prose says so), so a
 * consumer must never assume a unit from the number alone.
 */
export const Facet = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  numericValue: Schema.optional(Schema.Number)
})
export type Facet = typeof Facet.Type

/**
 * One `<cite>` or `<q>`. `href` is the `<q cite>` URI when present — an absolute or
 * root-relative source URI, not necessarily a memory path.
 */
export const Citation = Schema.Struct({
  text: Schema.String,
  href: Schema.optional(Schema.String)
})
export type Citation = typeof Citation.Type

/**
 * What the indexer reads out of `<article>`. Field names are the indexer's own, so T7 consumes
 * this struct without a translation layer.
 */
export const ArticleExtractions = Schema.Struct({
  /**
   * The article's inner HTML, trimmed. A serialization fixed point: re-parsing and
   * re-serializing it yields the same bytes, which is what makes the round-trip property hold.
   */
  html: Schema.String,
  /**
   * All article text, whitespace-collapsed. The FTS body and the embedding input. Includes
   * `<aside>`, `<details>` bodies, `<figcaption>`, and `<pre>` — everything is searchable.
   */
  bodyText: Schema.String,
  /**
   * The ONE `<mark>` span's text — the claim, and only the claim. Not a summary, not the first
   * sentence, and not derived from anything: it is the author's chosen load-bearing span, the
   * Tier-1 disclosure line, and the span a correction targets.
   */
  gist: Schema.String,
  /**
   * The FIRST `<time datetime>` value, as authored (ISO date or ISO datetime, so `2026-07-28`
   * and `2026-07-28T14:03:11Z` both occur). This is when the remembered fact HAPPENED — world
   * time, not write time. The recency arm ranks by `coalesce(event_at, updated_at)`, so an
   * episodic memory backdates correctly. Absent when the article names no time.
   */
  eventAt: Schema.optional(Schema.String),
  /** `<dt>`/`<dd>` pairs in document order, one row each in `file_facets`. */
  facets: Schema.Array(Facet),
  /** `<cite>` and `<q>` in document order, one row each in `file_citations`. */
  citations: Schema.Array(Citation),
  /**
   * `<dfn>` terms, in document order. Each promotes to a `concept:<term>` entity, so a
   * semantic memory that defines a term is findable by the term without the author also
   * writing a `memhtml-entity` meta.
   */
  definedTerms: Schema.Array(Schema.String),
  /**
   * `<summary>` texts in document order. Always disclosed in recall — Tier 2 of the fold.
   * The matching `<details>` body is Tier 3 and reaches an agent only through `memory_read`.
   */
  summaryTexts: Schema.Array(Schema.String),
  /**
   * `<aside>` texts in document order. In `bodyText` and therefore searchable, but never
   * quoted in a recall index line: an aside is a scope caveat, so quoting it as the memory
   * would present the exception as the rule.
   */
  asideTexts: Schema.Array(Schema.String),
  /** `<figcaption>` texts in document order. FTS-visible; the `<pre>` body is not gist-visible. */
  captions: Schema.Array(Schema.String),
  /**
   * `data-lang` values of `<code>` elements, lowercased, in document order. Each promotes to a
   * `lang:<value>` entity the way a `<dfn>` promotes to `concept:` — a memory carrying a
   * TypeScript snippet is findable by `--entity lang:ts` without the author restating the
   * language in a `memhtml-entity` meta the fence's info string already carried.
   */
  codeLangs: Schema.Array(Schema.String),
  /** `<abbr title>` expansions in document order. FTS-visible. */
  abbreviations: Schema.Array(Schema.String)
})
export type ArticleExtractions = typeof ArticleExtractions.Type

/**
 * A parsed memory file. Frozen: a consumer that wants a changed doc builds a new one, so a
 * shared doc cannot be mutated out from under the hash a caller already computed.
 */
export const MemoryDoc = Schema.Struct({
  /** The `<title>` text. The human name of the memory and the slug's source. */
  title: Schema.String,
  metas: MemoryMetas,
  /** `memhtml-entity` values as authored, e.g. `service:checkout-api`, in document order. */
  entities: Schema.Array(Schema.String),
  /** `memhtml-tag` values as authored, in document order. Open vocabulary. */
  tags: Schema.Array(Schema.String),
  links: Schema.Array(MemoryLink),
  article: ArticleExtractions,
  /**
   * Vocabulary warnings — an element outside the closed vocabulary, a `<div>` outside a
   * `<figure>`. Format constraint 6: the file still parses and still indexes, so a
   * hand-authored file degrades gracefully instead of being refused.
   */
  warnings: Schema.Array(Schema.String)
})
export type MemoryDoc = typeof MemoryDoc.Type

/**
 * The closed vocabulary: which elements a memory file may use, which metadata names it
 * carries, and the HTML serialization facts (void elements, raw-text elements) the
 * serializer needs. Everything here is data, because the vocabulary IS the policy, so this
 * module holds no sanitizer library and no allow/deny logic.
 */

/**
 * The memory file format's naming conventions. HTML5 metadata names are a flat token
 * space where colons are reserved-ish, and `rel` tokens cannot hold a colon at all,
 * so both planes use the same hyphenated prefix.
 */
export const META_PREFIX = "memhtml-"
export const LINK_REL_PREFIX = "memhtml-"

/**
 * Meta keys that may appear more than once. Each value is its own `<meta>` element
 * rather than a comma-joined string, so correcting one tag is a one-line diff.
 */
export const REPEATABLE_META = ["memhtml-entity", "memhtml-tag"] as const

export type RepeatableMeta = (typeof REPEATABLE_META)[number]

/** True when a metadata name may legitimately appear more than once in one head. */
export const isRepeatableMeta = (name: string): name is RepeatableMeta =>
  (REPEATABLE_META as ReadonlyArray<string>).includes(name)

/**
 * The metas a file must carry. Each of the five is a fact no pure function can invent: a
 * type cannot be guessed from prose, a status cannot be inferred, and a timestamp cannot be
 * synthesized without a clock. `memhtml-confidence`, `memhtml-importance`, and `memhtml-author` are
 * deliberately absent, because the `files` table documents a default for each (1.0, 5, `agent`),
 * so a hand-authored file missing them is completed rather than refused.
 */
export const REQUIRED_META = [
  "memhtml-type",
  "memhtml-status",
  "memhtml-created",
  "memhtml-updated"
] as const

/**
 * Every metadata name in the closed vocabulary, in the order the serializer emits them.
 * A stable order is what makes a meta-only edit a one-line git diff, so two writers stamping
 * different keys leave each other's lines in place.
 */
export const META_ORDER = [
  "memhtml-type",
  "memhtml-status",
  "memhtml-created",
  "memhtml-updated",
  "memhtml-confidence",
  "memhtml-importance",
  "memhtml-content-hash",
  "memhtml-author",
  "memhtml-session",
  "memhtml-prompt",
  "memhtml-turn",
  "memhtml-valid-from",
  "memhtml-valid-until",
  "memhtml-reprieves",
  "memhtml-archived",
  "memhtml-superseded-by",
  "memhtml-needs-revision",
  /**
   * The two task metas, appended after the last pre-task scalar. Position in this list is a
   * diff-stability contract, so a new scalar goes at the END of the scalar block: inserting one
   * mid-list would move every line below it in every file the next bookkeeping pass touches.
   */
  "memhtml-task-status",
  "memhtml-due",
  "memhtml-entity",
  "memhtml-tag"
] as const

export type MemoryMetaName = (typeof META_ORDER)[number]

/** True when a `memhtml-`-prefixed metadata name is in the closed vocabulary. */
export const isMemoryMetaName = (name: string): name is MemoryMetaName =>
  (META_ORDER as ReadonlyArray<string>).includes(name)

/**
 * The document skeleton. These carry no indexer semantics of their own; they exist so the
 * file is a valid HTML5 document a browser renders with no server.
 */
export const DOCUMENT_ELEMENTS = ["html", "head", "body", "title", "meta", "link"] as const

/**
 * The body vocabulary, one entry per row of the format's element table.
 *
 * `tr` is here although the table lists only `caption/thead/tbody/th/td`: a `<table>` cannot
 * hold a cell without a row, so refusing `tr` would make every real table warn. Nothing else
 * is added by inference. An element the format does not name is a warning, which is the
 * graceful-degradation rule for hand-authored files.
 */
export const ARTICLE_ELEMENTS = [
  "article",
  "mark",
  "time",
  "dl",
  "dt",
  "dd",
  "data",
  "cite",
  "q",
  "dfn",
  "figure",
  "figcaption",
  "details",
  "summary",
  "aside",
  "section",
  "abbr",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "table",
  "caption",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "p",
  "ul",
  "ol",
  "li",
  "a",
  "strong",
  "em"
] as const

/**
 * `<address>` is the contact surface a person file adds. Permitted everywhere rather than
 * only under `resources/people/`, because this module sees HTML and no path, and a warning
 * keyed on a directory would belong to `memhtml doctor`, not to the parser.
 */
export const PERSON_ELEMENTS = ["address"] as const

/**
 * `<div>` and `<span>` are permitted only inside a `<figure>`, where a pasted code sample
 * legitimately carries its own markup. Outside a figure they are the generic-container habit
 * the closed vocabulary exists to refuse.
 */
export const FIGURE_SCOPED_ELEMENTS = ["div", "span"] as const

/** Every element name the vocabulary knows, at any position. */
export const KNOWN_ELEMENTS: ReadonlySet<string> = new Set<string>([
  ...DOCUMENT_ELEMENTS,
  ...ARTICLE_ELEMENTS,
  ...PERSON_ELEMENTS,
  ...FIGURE_SCOPED_ELEMENTS
])

/** True when the element is one of the two permitted only under a `<figure>`. */
export const isFigureScopedElement = (tagName: string): boolean =>
  (FIGURE_SCOPED_ELEMENTS as ReadonlyArray<string>).includes(tagName)

/**
 * Elements with no end tag, per the HTML serialization algorithm. The serializer emits
 * these as a start tag alone; emitting `</meta>` would make the file invalid HTML5.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
])

/**
 * Elements whose text children are emitted verbatim, with no character-reference escaping.
 * `<script>` and `<style>` are constraint-3 violations rather than vocabulary members. The
 * serializer still has to round-trip a file that carries one before the constraint is
 * reported, so both are listed.
 */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "style",
  "script",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext"
])

/**
 * Elements where a newline immediately after the start tag is swallowed on parse, so the
 * serializer emits a second one to keep content that genuinely begins with a newline. Without
 * this, `<pre>` text starting with `\n` loses one newline on every parse/serialize cycle and
 * the content hash drifts.
 */
export const NEWLINE_SWALLOWING_ELEMENTS: ReadonlySet<string> = new Set([
  "pre",
  "textarea",
  "listing"
])

/**
 * Elements whose text the gist must not absorb. A command line is body text and it is
 * searchable. The claim is prose in the `<mark>` span.
 */
export const GIST_EXCLUDED_ELEMENTS: ReadonlySet<string> = new Set(["pre", "code"])

/**
 * Phrasing-level elements: their text runs into the surrounding sentence, so no word boundary
 * is implied at their edges. Everything else in the vocabulary is block-level, and `bodyText`
 * inserts a space at a block edge so `<dt>Applies to</dt><dd>ALB</dd>` yields two searchable
 * words, not the fused `to ALB` the raw text content would give.
 *
 * The content hash deliberately does NOT use this set: its scope is defined as the article's
 * whitespace-normalized text content, so inserting separators there would make the digest a
 * function of this list and every future vocabulary change would silently move every hash.
 */
export const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  "mark",
  "time",
  "data",
  "cite",
  "q",
  "dfn",
  "abbr",
  "code",
  "kbd",
  "samp",
  "var",
  "a",
  "strong",
  "em",
  "span"
])

/** Attributes forbidden anywhere: presentation is the stylesheet's job, not the memory's. */
export const FORBIDDEN_ATTRIBUTES: ReadonlySet<string> = new Set(["class", "style"])

/** Elements forbidden anywhere: a memory file is data, and data does not execute. */
export const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"])

/** The prefix every DOM event-handler attribute carries. */
export const EVENT_HANDLER_PREFIX = "on"

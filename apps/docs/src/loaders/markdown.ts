/**
 * Markdown assembly for generated pages.
 *
 * Two hazards, both of which a hand-written page never hits because a human sees the result. First,
 * the registries quote the memory file format at length — `<mark>`, `<article>`, `<time datetime>` —
 * and Markdown passes raw HTML through, so an unescaped description would MOUNT the element it is
 * describing. Escaping happens outside code spans only: inside them the Markdown renderer escapes
 * for us, and an `&lt;` written into a code span renders as those five characters. Second, a table
 * cell ends at the first unescaped pipe, including one inside a code span.
 *
 * Headings carry their number in the TEXT, because this site serves raw Markdown to agents and a
 * number injected by CSS or by an AST plugin is absent there — a human citing a section and an agent
 * reading the Markdown would name different things.
 */

const CODE_SPAN = /(`+[^`]*`+)/

/**
 * A long flag written in bare prose, promoted to a code span.
 *
 * Not cosmetic: this site's Markdown engine applies smart typography, which turns a bare `--claim`
 * into `–claim` with an en dash — a flag a reader cannot copy. A code span is exempt from that
 * transformation and is what a flag should look like anyway.
 */
const BARE_FLAG = /(?<![`\w-])--[a-z][a-z0-9-]*/g

/** Prose safe to place in a Markdown document, with code spans left intact. */
export const inlineText = (text: string): string =>
  text
    .split(CODE_SPAN)
    .map((part, at) =>
      at % 2 === 1
        ? part
        : part
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replace(BARE_FLAG, (flag) => `\`${flag}\``)
    )
    .join("")

/** Prose safe to place in one table cell. */
export const cell = (text: string): string =>
  inlineText(text.replaceAll("\n", " ")).replaceAll("|", "\\|")

/** A code span, for a value that must render verbatim. */
export const code = (value: string): string => `\`${value}\``

/** A comma-separated list of code spans, or a dash when there are none. */
export const codeList = (values: ReadonlyArray<string>): string =>
  values.length === 0 ? "-" : values.map(code).join(", ")

/** A GFM table. Rows are already-escaped cells. */
export const table = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): string =>
  [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n")

/** A fenced block. The info string is the language, so highlighting is not guessed. */
export const fence = (language: string, body: string): string =>
  [`${FENCE}${language}`, body, FENCE].join("\n")

const FENCE = "```"

/** A bullet list. */
export const bullets = (items: ReadonlyArray<string>): string =>
  items.map((item) => `- ${item}`).join("\n")

/** One numbered section of a page. */
export interface Section {
  readonly title: string
  readonly body: string
  readonly children?: ReadonlyArray<Section>
}

/*
 * Headings carry their number in the text and take the anchor Starlight derives from it. An explicit
 * `{ #anchor }` would be better — it would survive a renumbering without churning inbound links —
 * but it cannot be used here: `starlight-md-txt` parses every page's raw body through `remark-mdx`
 * unconditionally, and a brace expression is a JSX expression to acorn, so the raw Markdown route
 * fails to render. The raw routes are the point of this site's agent surface and outrank a stabler
 * anchor. Renumbering therefore changes anchors, and `starlight-links-validator` is what catches the
 * internal links that breaks.
 */
const renderSection = (section: Section, number: string, depth: number): string => {
  const heading = `${"#".repeat(depth)} ${number} ${section.title}`
  const children = (section.children ?? []).map((child, at) =>
    renderSection(child, `${number.slice(0, -1)}.${at + 1}.`, depth + 1)
  )
  return [heading, section.body, ...children].filter((part) => part !== "").join("\n\n")
}

/** A page body: RFC-numbered sections, `## 1.` at the top level and `### 1.1.` below it. */
export const sections = (list: ReadonlyArray<Section>): string =>
  list.map((section, at) => renderSection(section, `${at + 1}.`, 2)).join("\n\n")

/** A paragraph run, from prose that separates paragraphs with blank lines. */
export const paragraphs = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => inlineText(paragraph.trim()))
    .filter((paragraph) => paragraph !== "")
    // A quoted comment line opening with `#` would become a heading, which would land inside a
    // numbered section and take over the table of contents.
    .map((paragraph) => paragraph.replace(/^#/gm, "\\#"))
    .join("\n\n")

/**
 * Prose → claim derivation: the single implementation both write doors use.
 *
 * The tools take `{title, body}` because that is what a model produces, and the format needs a
 * `<mark>` claim plus one `<p>` per paragraph. Turning the first into the second is a text
 * heuristic, and it must have exactly one copy: `apps/mcp` and `apps/cli` both import this module,
 * because a sentence-splitting rule maintained per door lets `memhtml apply` and
 * `memory_write_batch` derive different claims from the same body, making the gist of a memory
 * depend on which door wrote it.
 *
 * It does not live in `@memhtml/html`, which owns markup and the format's own rules. "Where does a
 * sentence end" is a guess about natural-language prose, and the format states no such constraint. It
 * is not in `operations.ts` either, because that module holds the use cases both doors call, and this
 * is a text helper they apply before calling one.
 *
 * The derivation is defense in depth: `@memhtml/html` constraint 1 rejects an empty `<mark>`
 * outright, so a door that skipped this would be stopped by the store's render gate rather than
 * landing a file with an empty `files.gist`. What this module carries is the authoring convenience
 * the doors exist to provide: a JSONL line and an MCP call carry no `claim` field, so the door
 * derives one instead of asking an author to restate the body's first sentence.
 *
 * The one refusal the doors share about a body's text lives here too, for the same one-copy
 * reason: {@link MarkupInProse}, a body holding an HTML block tag outside code.
 */

import {
  blockTagInRun,
  closesFence,
  fenceOpeningOf,
  proseParagraphs,
  proseParagraphText
} from "@memhtml/html"
import { Schema } from "effect"

/**
 * Split prose into paragraphs on blank lines, dropping the empties. Inside a fenced code block a
 * blank line is content, so the split skips it there. Without that carve-out, a snippet containing a
 * blank line splits into two paragraphs, neither of which is a complete fence, and both land as
 * escaped backtick text instead of the `<figure><pre><code>` an intact fence renders as.
 *
 * The fence grammar comes from `@memhtml/html` (`fenceOpeningOf`/`closesFence`) rather than a second
 * copy here. The splitter deciding "this is one block" and the template deciding "this is a fence"
 * must be the same judgment, or the doors drift the way the claim derivation once did.
 */
const paragraphsOf = (prose: string): ReadonlyArray<string> => {
  const parts: Array<Array<string>> = [[]]
  let opening: string | undefined
  for (const line of prose.split("\n")) {
    const current = parts.at(-1) as Array<string>
    if (opening === undefined && line.trim() === "") {
      if (current.length > 0) parts.push([])
      continue
    }
    current.push(line)
    if (opening === undefined) {
      opening = fenceOpeningOf(line)
    } else if (closesFence(line, opening)) {
      opening = undefined
    }
  }
  return parts.map((lines) => lines.join("\n").trim()).filter((part) => part !== "")
}

/**
 * The claim: the first sentence of the prose.
 *
 * The first sentence is where a model puts the assertion. Taking the title instead would make every
 * gist a restatement of the filename, which is the one thing a Tier-1 disclosure line must not be.
 * Prose with no sentence terminator is its own claim in full. A fragment is still an assertion, and
 * rejecting it would reject the shortest legitimate memory there is.
 */
export const claimFromProse = (prose: string): string => {
  const trimmed = prose.trim()
  const match = /^(.*?[.!?])(\s|$)/s.exec(trimmed)
  return (match?.[1] ?? trimmed).trim()
}

/**
 * The prose after the claim, as paragraphs. Empty when the claim was the whole body.
 *
 * The first element becomes the claim paragraph's own tail rather than a second `<p>`, which is
 * `articleHtmlFor`'s contract in `@memhtml/html`'s template. A one-paragraph body therefore yields
 * exactly one `<p>` with the `<mark>` inside it, which is what constraint 1 requires.
 */
export const proseTail = (prose: string): ReadonlyArray<string> => {
  const remainder = prose.trim().slice(claimFromProse(prose).length).trim()
  return remainder === "" ? [] : paragraphsOf(remainder)
}

/**
 * A prose body that holds an HTML block tag outside code: the refusal both doors give before a
 * body is rendered. `line` is the body's own 1-based line and `tag` the tag as written, raw or
 * entity-escaped, cut to 80 characters.
 *
 * Prose is escaped as text, so `<p>One.</p>` in a body would land as the characters `&lt;p&gt;One.`
 * inside the claim's `<mark>`, and the format accepts that because escaped text is valid content.
 * A block tag outside code in prose is almost never meant as text, and the door is the last place
 * that still knows the writer sent it, so the door refuses and names `article_html`, the field that
 * takes markup. A tag the record discusses goes in backticks that open and close on its line, or in
 * a fenced block that is a paragraph of its own once the first sentence has ended. `unended` marks a
 * tag the claim took in because the body's first sentence never ended before it: the claim runs to
 * the first `.`, `!`, or `?` followed by a space or a line break, blank lines and fences included.
 *
 * A typed error rather than a door-local failure because the MCP tools raise it inside a handler,
 * where `codeFor`, `messageFor`, and each door's suggestions give it its envelope; `memhtml apply`
 * and `memhtml session put` refuse with the same reason at exit 2, naming the JSONL line too.
 */
export class MarkupInProse extends Schema.TaggedError<MarkupInProse>()("MarkupInProse", {
  line: Schema.Finite,
  tag: Schema.String,
  unended: Schema.optionalKey(Schema.Boolean)
}) {}

/** Line breaks as the HTML parser reads them, for naming a body's line. */
const LINE_BREAKS = /\r\n|\r|\n/g

/** The 1-based line of a body that holds the character at `offset`. */
const lineAt = (prose: string, offset: number): number =>
  (prose.slice(0, offset).match(LINE_BREAKS)?.length ?? 0) + 1

/**
 * True when the claim, before the position `at`, ran on past where its writer meant it to stop: a
 * whole line before the one holding `at` is blank or opens a fence. No sentence ended there, or
 * the claim would have stopped.
 */
const ranOnBefore = (claim: string, at: number): boolean =>
  claim
    .slice(0, at)
    .split(LINE_BREAKS)
    .slice(0, -1)
    .some((line) => line.trim() === "" || fenceOpeningOf(line) !== undefined)

/**
 * The refusal for a prose body holding a block tag outside code, or `undefined` for none.
 *
 * The body is judged as it renders, not line by line: the claim and tail the door derives are
 * planned into paragraphs by `proseParagraphs`, the plan the template renders, and each `<p>`'s
 * text is read by `blockTagInRun`, the reading `blockTagInArticle` gives the written file. So the
 * claim's line and the next line of the body join with a space, as they do in the `<p>`, and a
 * fenced block is code only when it is a paragraph of its own. The door refuses exactly the
 * bodies whose rendered file `validateOps` would refuse.
 *
 * The claim and each tail paragraph are trimmed runs of the body in order, so each is found in
 * the body from where the one before it ended, and the hit's position in the `<p>` maps back to
 * the body's line. A hit inside a claim that ran on is marked `unended`, so the refusal can say
 * the first sentence never ended rather than advise the fence the writer already used.
 */
export const markupInProse = (prose: string): MarkupInProse | undefined => {
  const claim = claimFromProse(prose)
  const tail = proseTail(prose)
  const claimAt = prose.length - prose.trimStart().length
  const tailAt: Array<number> = []
  let cursor = claimAt + claim.length
  for (const text of tail) {
    const at = prose.indexOf(text, cursor)
    tailAt.push(at)
    cursor = at + text.length
  }
  for (const paragraph of proseParagraphs(claim, tail)) {
    if (paragraph.kind !== "p") continue
    const found = blockTagInRun(proseParagraphText(paragraph))
    if (found === undefined) continue
    const lead = paragraph.claim === undefined ? 0 : paragraph.claim.length + 1
    const inClaim = found.offset < lead
    const offset = inClaim
      ? claimAt + found.offset
      : (tailAt[paragraph.index ?? 0] ?? 0) + found.offset - lead
    return new MarkupInProse({
      line: lineAt(prose, offset),
      tag: found.tag,
      ...(inClaim && ranOnBefore(claim, found.offset) ? { unended: true } : {})
    })
  }
  return undefined
}

/** The reason a {@link MarkupInProse} refusal gives, the same words on every door. */
export const markupInProseReason = (refusal: {
  readonly line: number
  readonly tag: string
  readonly unended?: boolean | undefined
}): string => {
  const found = `\`body\` holds the HTML block tag \`${refusal.tag}\` on its line ${String(refusal.line)}, outside code: \`body\` is prose and is stored as escaped text, so the tag would reach the claim and the paragraphs as literal characters.`
  return refusal.unended === true
    ? `${found} The body's first sentence never ends before the tag: the claim runs to the first . ! or ? followed by a space or a line break, so it takes in what follows, blank lines and fences included, as text. End the first sentence before the tag, put a tag the record discusses in backticks that open and close on its line, or send the article as markup in \`article_html\` instead, with its own <mark> in the first <p>`
    : `${found} Send the article as markup in \`article_html\` instead, with its own <mark> in the first <p>, or put a tag the record discusses in backticks that open and close on its line. A fenced block counts as code only as a paragraph of its own, with a blank line before and after it, once the body's first sentence has ended with . ! or ? and then a space or a line break`
}

/**
 * What a JSONL writer does about a {@link MarkupInProse} refusal: the same line with the markup in
 * `article_html`, or the tag kept in `body` as code. Neither entry holds a backtick itself, because
 * the reference site renders each suggestion inside a code span.
 */
export const MARKUP_IN_PROSE_SUGGESTIONS: ReadonlyArray<string> = [
  '{"op":"write","title":"<title>","type":"semantic","article_html":"<p><mark><the claim></mark></p><ul><li><an item></li></ul>"}',
  "keep body, end its first sentence with . ! or ? before any code, and put a tag the record discusses in backticks that open and close on one line, or in a fenced block set off by blank lines"
]

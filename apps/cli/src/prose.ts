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

import { blockTagInText, closesFence, fenceOpeningOf } from "@memhtml/html"
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
 * entity-escaped.
 *
 * Prose is escaped as text, so `<p>One.</p>` in a body would land as the characters `&lt;p&gt;One.`
 * inside the claim's `<mark>`, and the render gate accepts that because escaped text is valid
 * content. A block tag outside code in prose is almost never meant as text, and the door is the
 * last place that still knows the writer sent it, so the door refuses and names `article_html`, the
 * field that takes markup. A tag the record discusses goes in backticks or a fenced block, which the
 * check reads as code (`blockTagInText` in `@memhtml/html`, the detector `validateOps` shares).
 *
 * A typed error rather than a door-local failure because the MCP tools raise it inside a handler,
 * where `codeFor`, `messageFor`, and each door's suggestions give it its envelope; `memhtml apply`
 * and `memhtml session put` refuse with the same reason at exit 2, naming the JSONL line too.
 */
export class MarkupInProse extends Schema.TaggedError<MarkupInProse>()("MarkupInProse", {
  line: Schema.Finite,
  tag: Schema.String
}) {}

/** The refusal for a prose body holding a block tag outside code, or `undefined` for none. */
export const markupInProse = (prose: string): MarkupInProse | undefined => {
  const found = blockTagInText(prose)
  return found === undefined ? undefined : new MarkupInProse(found)
}

/** The reason a {@link MarkupInProse} refusal gives, the same words on every door. */
export const markupInProseReason = (refusal: {
  readonly line: number
  readonly tag: string
}): string =>
  `\`body\` holds the HTML block tag \`${refusal.tag}\` on its line ${String(refusal.line)}, outside a code fence or backticks: \`body\` is prose and is stored as escaped text, so the tag would reach the claim and the paragraphs as literal characters. Send the article as markup in \`article_html\` instead, with its own <mark> in the first <p>, or put a tag the record discusses in backticks`

/**
 * What a JSONL writer does about a {@link MarkupInProse} refusal: the same line with the markup in
 * `article_html`, or the tag kept as prose in backticks. Neither entry holds a backtick itself,
 * because the reference site renders each suggestion inside a code span.
 */
export const MARKUP_IN_PROSE_SUGGESTIONS: ReadonlyArray<string> = [
  '{"op":"write","title":"<title>","type":"semantic","article_html":"<p><mark><the claim></mark></p><ul><li><an item></li></ul>"}',
  "keep body and put a tag the record discusses in backticks or a fenced block, which the check reads as code"
]

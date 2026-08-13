/**
 * Prose → claim derivation: the single implementation both write doors use.
 *
 * The tools take `{title, body}` because that is what a model produces, and the format needs a
 * `<mark>` claim plus one `<p>` per paragraph. Turning the first into the second is a text heuristic,
 * and it lives here for two reasons. It was duplicated once, as `claimOf`/`restOf` in `apps/mcp` and
 * `claimFromProse`/`proseTail` in `apps/cli`, the same regex in two packages. A sentence-splitting
 * rule that drifts between the doors also makes `memhtml apply` and `memory_write_batch` derive different
 * claims from the same body, so the gist of a memory would depend on which door wrote it.
 *
 * It does not live in `@memhtml/html`, which owns markup and the format's own rules. "Where does a
 * sentence end" is a guess about natural-language prose, and the format states no such constraint. It
 * is not in `operations.ts` either, because that module holds the use cases both doors call, and this
 * is a text helper they apply before calling one.
 *
 * The derivation is defense in depth now; it was once the only guard. `@memhtml/html` constraint 1 now
 * rejects an empty `<mark>` outright, so a door that skipped this would be stopped by the store's
 * render gate instead of landing a file with an empty `files.gist`. What is left here is the
 * authoring convenience the doors exist to provide: a JSONL line and an MCP call carry no `claim`
 * field, so the door derives one instead of asking an author to restate the body's first sentence.
 */

import { closesFence, fenceOpeningOf } from "@memhtml/html"

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

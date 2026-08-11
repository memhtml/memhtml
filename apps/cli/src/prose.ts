/**
 * Prose → claim derivation: the ONE implementation both write doors use.
 *
 * The tools take `{title, body}` because that is what a model produces, and the format needs a
 * `<mark>` claim plus one `<p>` per paragraph. Turning the first into the second is a text heuristic,
 * and it lives here for two reasons. It was duplicated — `claimOf`/`restOf` in `apps/mcp` and
 * `claimFromProse`/`proseTail` in `apps/cli`, the same regex in two packages — and a sentence-splitting
 * rule that drifts between the doors means `memhtml apply` and `memory_write_batch` would derive different
 * claims from the same body, so the gist of a memory would depend on which door wrote it.
 *
 * It is NOT in `@memhtml/html`, which owns markup and the format's own rules; "where does a sentence end"
 * is a guess about natural-language prose, not a constraint the format states. It is not in
 * `operations.ts` either: that module is the use cases both doors call, and this is a text helper they
 * apply BEFORE calling one.
 *
 * The derivation is defense in depth rather than the guard it once was. `@memhtml/html` constraint 1 now
 * refuses an empty `<mark>` outright, so a door that skipped this would be REFUSED by the store's
 * render gate rather than silently landing a file with an empty `files.gist`. What is left here is the
 * authoring convenience the doors exist to provide: a JSONL line and an MCP call carry no `claim`
 * field, so the door derives one instead of asking an author to restate the body's first sentence.
 */

import { closesFence, fenceOpeningOf } from "@memhtml/html"

/**
 * Split prose into paragraphs on blank lines, dropping the empties — except inside a fenced code
 * block, where a blank line is content. Without the fence carve-out, a snippet containing a blank
 * line splits into two paragraphs, neither of which is a complete fence, and both land as escaped
 * backtick text instead of the `<figure><pre><code>` the template renders for an intact fence.
 *
 * The fence grammar is `@memhtml/html`'s (`fenceOpeningOf`/`closesFence`), not a second copy here:
 * the splitter deciding "this is one block" and the template deciding "this is a fence" must be
 * the same judgment, or the doors drift exactly the way the claim derivation once did.
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
 * Prose with no sentence terminator is its own claim in full — a fragment is still an assertion, and
 * refusing it would reject the shortest legitimate memory there is.
 */
export const claimFromProse = (prose: string): string => {
  const trimmed = prose.trim()
  const match = /^(.*?[.!?])(\s|$)/s.exec(trimmed)
  return (match?.[1] ?? trimmed).trim()
}

/**
 * The prose after the claim, as paragraphs. Empty when the claim was the whole body.
 *
 * The first element becomes the claim paragraph's own TAIL rather than a second `<p>` — that is
 * `articleHtmlFor`'s contract in `@memhtml/html`'s template — so a one-paragraph body yields exactly one
 * `<p>` with the `<mark>` inside it, which is what constraint 1 requires.
 */
export const proseTail = (prose: string): ReadonlyArray<string> => {
  const remainder = prose.trim().slice(claimFromProse(prose).length).trim()
  return remainder === "" ? [] : paragraphsOf(remainder)
}

import { Effect, Result } from "effect"

import type { MemoryDoc } from "../src/document.js"
import { parseMemory } from "../src/parse.js"

/** Test fixtures and the two Result helpers every failure-path test uses. */

/**
 * `docs/format.md`'s own example, head and body joined into one file. Every element of the
 * vocabulary that carries indexer semantics appears once, so a parser change that breaks any
 * extraction breaks this fixture.
 */
export const FORMAT_MD_EXAMPLE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Prod rollbacks drain the VIP before the deploy is reverted</title>
<meta name="memhtml-type"         content="procedural">
<meta name="memhtml-status"       content="active">
<meta name="memhtml-created"      content="2026-08-02T14:03:11Z">
<meta name="memhtml-updated"      content="2026-08-02T14:03:11Z">
<meta name="memhtml-confidence"   content="0.90">
<meta name="memhtml-importance"   content="8">
<meta name="memhtml-content-hash" content="sha256:1f4b9c">
<meta name="memhtml-author"       content="agent:claude-fable-5">
<meta name="memhtml-session"      content="f7e32699-d45b-4248-8ae6-894dfc606f49">
<meta name="memhtml-prompt"       content="pr_01JQ8">
<meta name="memhtml-entity"       content="service:checkout-api">
<meta name="memhtml-tag"          content="deploy">
<link rel="memhtml-supersedes" href="/archive/2026/areas/oncall/rollback-order.html">
<link rel="memhtml-part-of"    href="/areas/arcs/reversibility-first.html">
</head>
<body>
<article>
  <p><mark>If a prod rollback is issued, drain the VIP before reverting the deploy.</mark>
  The revert alone leaves in-flight connections pinned to the old target group —
  observed on <time datetime="2026-07-28">July 28</time> during the
  <cite>checkout-api sev2</cite>.</p>

  <dl>
    <dt>Applies to</dt><dd>ALB/NLB target-group deploys</dd>
    <dt>Failure window</dt><dd><data value="120">about two minutes</data> of pinned connections</dd>
  </dl>

  <figure>
    <pre><code>aws elbv2 modify-target-group-attributes --attributes Key=deregistration_delay</code></pre>
    <figcaption>The drain command that must precede the revert.</figcaption>
  </figure>

  <details>
    <summary>How this was learned</summary>
    <p>Three rollbacks in July replayed the same 500-spike; the third was caught live.</p>
  </details>

  <aside>
    <p>Fly.io and Cloud Run drain automatically; this is AWS-target-group specific.</p>
  </aside>
</article>
</body>
</html>
`

/** The four required metas as head lines, for building a minimal file. */
export const REQUIRED_HEAD = [
  '<meta name="memhtml-type" content="semantic">',
  '<meta name="memhtml-status" content="active">',
  '<meta name="memhtml-created" content="2026-08-02T00:00:00Z">',
  '<meta name="memhtml-updated" content="2026-08-02T00:00:00Z">'
].join("\n")

/**
 * A memory file around the given article markup, with a valid head. Extra head lines splice in
 * after the required metas, so a test can add one bad meta or link without restating a document.
 */
export const fileWith = (articleHtml: string, extraHead = ""): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A test memory</title>
${REQUIRED_HEAD}${extraHead === "" ? "" : `\n${extraHead}`}
</head>
<body>
<article>
${articleHtml}
</article>
</body>
</html>
`

/** The minimal valid article: one claim in the first paragraph. */
export const MINIMAL_ARTICLE = "<p><mark>A claim.</mark></p>"

/**
 * A memory file of an arbitrary `memhtml-type`, for the type-conditional head rules. Written as a
 * whole head rather than by splicing over {@link REQUIRED_HEAD}, because a spliced second
 * `memhtml-type` is itself a violation and would mask the rule under test.
 */
export const fileOfType = (
  memoryType: string,
  extraHead = "",
  articleHtml = MINIMAL_ARTICLE
): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A test memory</title>
<meta name="memhtml-type" content="${memoryType}">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="2026-08-02T00:00:00Z">
<meta name="memhtml-updated" content="2026-08-02T00:00:00Z">${extraHead === "" ? "" : `\n${extraHead}`}
</head>
<body>
<article>
${articleHtml}
</article>
</body>
</html>
`

/**
 * A memory file carrying the given `memhtml-created` / `memhtml-updated` stamps, for the rules that
 * govern a required meta's VALUE rather than its presence.
 *
 * A whole head rather than a splice over {@link REQUIRED_HEAD}, for the reason {@link fileOfType} is
 * one: a spliced second `memhtml-created` is itself a duplicate-meta violation and would mask the
 * rule under test.
 */
export const fileWithStamps = (
  created: string,
  updated: string,
  articleHtml = MINIMAL_ARTICLE
): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A test memory</title>
<meta name="memhtml-type" content="semantic">
<meta name="memhtml-status" content="active">
<meta name="memhtml-created" content="${created}">
<meta name="memhtml-updated" content="${updated}">
</head>
<body>
<article>
${articleHtml}
</article>
</body>
</html>
`

/** A minimal valid memory file. */
export const MINIMAL_FILE = fileWith(MINIMAL_ARTICLE)

/**
 * Parse and require success. `Effect.result` is the beta's combinator — `Effect.either` does not
 * exist in effect 4.0.0-beta.102.
 */
export const parseOk = (html: string): MemoryDoc => {
  const result = Effect.runSync(Effect.result(parseMemory(html)))
  if (Result.isFailure(result)) throw new Error(`expected a parse, got: ${result.failure.reason}`)
  return result.success
}

/** Parse and require failure, returning the joined violation reason. */
export const parseErr = (html: string): string => {
  const result = Effect.runSync(Effect.result(parseMemory(html)))
  if (Result.isSuccess(result)) throw new Error("expected InvalidMemory, got a parsed doc")
  return result.failure.reason
}

/**
 * The one reading of "this page carries a JSX expression", shared by the probes that enforce it.
 *
 * `starlight-md-txt` parses every page's raw body through `remark-mdx` unconditionally — authored and
 * generated alike, `.md` as well as `.mdx` — so a brace in flow or text position is handed to acorn as
 * an expression. A value like `{ extractor: undefined }` is not one, and `astro build` fails with
 * `Could not parse expression with acorn`, a message that names neither the page nor the field it came
 * from. Two corpora reach that parser and each has its own probe (`census.test.ts` over the generated
 * Reference tier, `figures.test.ts` over the authored pages); the rule lives here once so the two
 * cannot drift into disagreeing about what a brace is.
 */

/** A fenced block, opener through the matching closer of the same run. */
const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm

/** An inline code span: a backtick run closed by a run of the same length. */
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/g

/**
 * Every `{` the MDX parser reads as the start of an expression, with up to 70 following characters so
 * a failure message shows the offending value rather than a position.
 *
 * Code is stripped first because inside a span or a fence the brace is leaf content `remark-mdx` never
 * parses. That is not a loophole, it is the fix: a braced value belongs in backticks, which is where
 * `internals/the-consolidator.md` already keeps `{"candidates": []}` while the site builds.
 */
export const mdxExpressions = (markdown: string): ReadonlyArray<string> =>
  [
    ...markdown
      .replace(FENCED, "")
      .replace(CODE_SPAN, "")
      .matchAll(/\{[^\n]{0,70}/g)
  ].map((match) => match[0])

# A probe can run over the right corpus with the wrong rule

**Category:** test-failures · **Session:** session-27698a · 2026-08-25

A `verificationNote` in `spec/memhtml.symspec.json` containing `{ extractor: undefined }` broke `astro build` with `Could not parse expression with acorn` — an opaque failure a long way from its cause, because MDX reads a brace as an expression.

A probe for this already existed and already ran over all 57 generated pages, the requirements page included. Its regex was `/\{\s*#[a-z0-9-]+\s*\}/` — **anchor-shaped**. It was written for `{ #some-id }` heading anchors, and `{ extractor: undefined }` walked through a check whose name, location and corpus all said it was covered.

So the search for "which corpus is unguarded" was the wrong search. **The corpus was guarded; the rule was narrower than its name.** The same anchor-only blind spot existed independently in the authored-page probe, which is what a duplicated rule buys you.

## What actually catches it

Fix the rule to the parser, not to the example that prompted it. Driving the repo's own installed `remark-mdx` over five bodies settled the semantics in one pass — probed 2026-08-25: a brace outside a code span fails, the same text inside a code span parses, inside a fence parses, and `{/* comment */}` parses. So the rule is "a brace outside code", which is both broader than anchors and narrower than a blanket ban that would push authors away from documenting braced values.

Then **the negative control is the whole deliverable**, because of a property worth internalising: _both real corpora are clean under the old anchor-only regex too._ Every gate case passes under the mutant. A generalisation whose only evidence is "the gates still pass" is unfalsifiable — passing gates are equally consistent with having changed nothing.

The control has to be synthetic, and it should be permanent rather than a manual poke. Appending a fabricated requirement to the registry (which the loader explicitly supports for this) gives a case that fails when the rule regresses to anchors-only, and asserts the message names the requirement key, the field, and the offending text — replacing the acorn error with something an author can act on.

One rule, one helper, both probes consuming it: two copies of a rule drift into two different blind spots.

Related: [[cross-phase-contamination-and-vacuous-locks]] and [[a-stated-invariant-with-no-gate-is-not-an-invariant]]. The distinction from both: here the gate existed, ran, and reported green over the exact file that broke the build.

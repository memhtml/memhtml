import { describe, expect, it } from "vitest"

import {
  POLARITY_DEMOTION,
  POLARITY_TEXT_CHARS,
  polarityScored,
  TWIN_COSINE
} from "../src/polarity.js"

/**
 * Synthetic vectors, so each case states its geometry instead of depending on an embedder.
 * `TWIN` is a hair off `BASE` (cosine ≈ 0.98, above `TWIN_COSINE`); `FAR` is orthogonal (cosine 0).
 */
const BASE = [1, 0, 0]
const TWIN = [0.98, 0.2, 0]
const FAR = [0, 1, 0]

const row = (path: string, gist: string, vector: ReadonlyArray<number> | undefined, body = "") => ({
  path,
  gist,
  body_text: body,
  vector
})

const order = (scored: ReadonlyArray<{ readonly row: { readonly path: string } }>) =>
  scored.map(({ row: entry }) => entry.path)

describe("the polarity step between fusion and MMR", () => {
  it("demotes the negation-flipped twin below its agreeing twin when the query is affirmative", () => {
    /**
     * The live shape from issue #132 (flipped twin at rank 1, target far below it, every arm blind to
     * the `not`), compressed to a four-row pool. After the step the target leads and the twin sits
     * below it, and below nothing else: the two unrelated rows between them keep their places.
     */
    const scored = polarityScored("search index analyzer chain merges 5 intervals", [
      row("a/flipped.html", "The analyzer chain does not merge 5 intervals.", TWIN),
      row("b/other-1.html", "The indexer batches writes.", FAR),
      row("c/other-2.html", "The cache expires hourly.", FAR),
      row("d/target.html", "The analyzer chain merges 5 intervals.", BASE)
    ])
    expect(order(scored)).toEqual([
      "b/other-1.html",
      "c/other-2.html",
      "d/target.html",
      "a/flipped.html"
    ])
    // Clamped below the agreeing twin's score (1/4), then scaled: the twin stays in the pool.
    expect(scored.at(-1)?.score).toBeCloseTo((1 / 4) * POLARITY_DEMOTION, 10)
  })

  it("is symmetric in the query: a negated query demotes the AFFIRMATIVE twin", () => {
    const scored = polarityScored("why does the analyzer chain not merge intervals", [
      row("a/affirmative.html", "The analyzer chain merges 5 intervals.", BASE),
      row("b/negated.html", "The analyzer chain does not merge 5 intervals.", TWIN)
    ])
    expect(order(scored)).toEqual(["b/negated.html", "a/affirmative.html"])
  })

  it("leaves a lone negated memory exactly where fusion put it", () => {
    /**
     * The false-positive guard, and the reason this is not a blanket penalty on `not`. A true negative
     * fact with no affirmative near-copy in the pool is not a flipped twin, and an affirmatively phrased
     * query must not push it down.
     */
    const scored = polarityScored("retry budget for the checkout service", [
      row("a/negative-fact.html", "Never retry the checkout call more than three times.", BASE),
      row("b/unrelated.html", "The checkout service owns the retry budget.", FAR)
    ])
    expect(order(scored)).toEqual(["a/negative-fact.html", "b/unrelated.html"])
    expect(scored[0]?.score).toBe(1)
  })

  it("leaves near-copies alone when both agree with the query's polarity", () => {
    // Two affirmative paraphrases are MMR's problem (diversity), not this step's (polarity).
    const scored = polarityScored("analyzer chain merges intervals", [
      row("a/one.html", "The analyzer chain merges 5 intervals.", BASE),
      row("b/two.html", "The analyzer chain merges five intervals per pass.", TWIN)
    ])
    expect(order(scored)).toEqual(["a/one.html", "b/two.html"])
    expect(scored.map(({ score }) => score)).toEqual([1, 1 / 2])
  })

  it("never demotes an unembedded row, and never uses one as the twin", () => {
    const noVector = polarityScored("the chain merges intervals", [
      row("a/flipped.html", "The chain does not merge intervals.", undefined),
      row("b/target.html", "The chain merges intervals.", BASE)
    ])
    expect(order(noVector)).toEqual(["a/flipped.html", "b/target.html"])
    const twinWithoutVector = polarityScored("the chain merges intervals", [
      row("a/flipped.html", "The chain does not merge intervals.", TWIN),
      row("b/target.html", "The chain merges intervals.", undefined)
    ])
    expect(order(twinWithoutVector)).toEqual(["a/flipped.html", "b/target.html"])
  })

  it("lands the demoted twin below its LOWEST-ranked agreeing twin", () => {
    // Two agreeing near-copies at ranks 2 and 3: the flipped one must end below both, not only below
    // the better of the two.
    const scored = polarityScored("the chain merges intervals", [
      row("a/flipped.html", "The chain does not merge intervals.", TWIN),
      row("b/target-1.html", "The chain merges intervals.", BASE),
      row("c/target-2.html", "The chain merges intervals every pass.", [0.99, 0.1, 0])
    ])
    expect(order(scored)).toEqual(["b/target-1.html", "c/target-2.html", "a/flipped.html"])
    expect(scored.at(-1)?.score).toBeCloseTo((1 / 3) * POLARITY_DEMOTION, 10)
  })

  it("judges polarity on the body when a file has no claim", () => {
    const scored = polarityScored("the chain merges intervals", [
      row("a/flipped.html", "", TWIN, "The chain does not merge intervals."),
      row("b/target.html", "", BASE, "The chain merges intervals.")
    ])
    expect(order(scored)).toEqual(["b/target.html", "a/flipped.html"])
  })

  it("is deterministic: equal scores break on path, and two runs agree byte for byte", () => {
    const pool = [
      row("b/flipped-2.html", "The chain does not merge intervals.", TWIN),
      row("a/flipped-1.html", "The chain does not merge intervals!", TWIN),
      row("c/target.html", "The chain merges intervals.", BASE)
    ]
    const first = polarityScored("the chain merges intervals", pool)
    expect(order(first)).toEqual(["c/target.html", "a/flipped-1.html", "b/flipped-2.html"])
    expect(first).toEqual(polarityScored("the chain merges intervals", pool))
  })

  it("reads the query's phrasing as the wanted polarity, which ranks a stale affirmative twin first", () => {
    /**
     * The accepted trade-off, pinned so it is a decision and not a surprise. Two LIVE memories that
     * contradict each other are a flipped-twin pair, and an affirmative question prefers the
     * affirmative one even when the negation is the newer correction. `memhtml correct` archives the
     * superseded half and the default scope excludes archived rows, so a resolved contradiction never
     * reaches this step; an unresolved one is the conflict phase's to settle.
     */
    const scored = polarityScored("is the deploy step safe to run in parallel", [
      row("a/older-wrong.html", "The deploy step is safe to run in parallel.", BASE),
      row("b/newer-correction.html", "The deploy step is not safe to run in parallel.", TWIN)
    ])
    expect(order(scored)).toEqual(["a/older-wrong.html", "b/newer-correction.html"])
  })

  it("reads outcome words in the query as negation, since the marker set is the veto's", () => {
    // `without` is a marker, so this query counts as negated and the twin carrying a marker wins. The
    // shared set is kept because "how to avoid retries" needs `avoid` on the query side to read right.
    const scored = polarityScored("how to run the deploy without downtime", [
      row("a/zero-downtime.html", "The deploy runs with zero downtime.", BASE),
      row("b/fails-without.html", "The deploy fails without a warm standby.", TWIN)
    ])
    expect(order(scored)).toEqual(["b/fails-without.html", "a/zero-downtime.html"])
  })

  it("judges at most POLARITY_TEXT_CHARS of a claimless body", () => {
    // A negation past the cap is not seen, so a huge body costs a bounded tokenization and nothing more.
    const filler = "x ".repeat(POLARITY_TEXT_CHARS / 2)
    const scored = polarityScored("the chain merges intervals", [
      row("a/late-not.html", "", TWIN, `${filler} The chain does not merge intervals.`),
      row("b/target.html", "", BASE, "The chain merges intervals.")
    ])
    expect(order(scored)).toEqual(["a/late-not.html", "b/target.html"])
  })

  it("treats the twin threshold as a real boundary", () => {
    // A pair just under the threshold is two memories, not one in two polarities.
    const under = Math.sqrt(TWIN_COSINE ** 2 - 0.001)
    const nearMiss = [under, Math.sqrt(1 - under ** 2), 0]
    const scored = polarityScored("the chain merges intervals", [
      row("a/flipped.html", "The chain does not merge intervals.", nearMiss),
      row("b/target.html", "The chain merges intervals.", BASE)
    ])
    expect(order(scored)).toEqual(["a/flipped.html", "b/target.html"])
  })
})

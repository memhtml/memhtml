import { describe, expect, it } from "vitest"

import { frameKeyOf } from "../src/frame.js"

/**
 * `frameKeyOf` as a PORT, which makes this file a fidelity oracle rather than a behavior spec.
 *
 * The first block is `memhtml-evals/src/adapter/consolidate.test.ts` VERBATIM — the same eight cases,
 * the same expected strings. That is deliberate and it is the point: the eval measured this rule
 * against all 8 MAB Conflict_Resolution rows, and if the port and the reference ever disagree, the
 * eval's number stops describing what memhtml ships. A divergence here must be resolved by fixing
 * the port, never by editing the expectation.
 *
 * The second block pins the two guards AT their boundaries, which the reference's cases straddle but
 * do not sit on. A guard whose threshold is only tested from one side is a guard that can be moved
 * by one without any test failing.
 */

describe("frameKeyOf — port fidelity against the eval reference", () => {
  it("keys the MAB conflict shape on the longest frame, so the pair collides", () => {
    // The last linking token wins: "…of India IS …" keys past the inner "of". A lazy quantifier
    // would key on "the capital of" and collide every country's capital into one slot.
    expect(frameKeyOf("The capital of India is New Delhi.")).toBe("the capital of india is")
    expect(frameKeyOf("The capital of India is Grosseto.")).toBe("the capital of india is")
  })

  it("is case- and whitespace-insensitive, because retyped facts vary in both", () => {
    expect(frameKeyOf("THE  Capital of India is   Mumbai")).toBe("the capital of india is")
  })

  it("keys 'located in the city of X' pairs", () => {
    expect(frameKeyOf("The headquarters of Sony is located in the city of Tokyo.")).toBe(
      frameKeyOf("The headquarters of Sony is located in the city of San Jose.")
    )
  })

  it("returns null for a short frame — a two-word subject must never merge", () => {
    // Frame "Water is" is 2 tokens; merging "Water is wet" into "Water is life" is destruction.
    expect(frameKeyOf("Water is wet.")).toBeNull()
  })

  it("returns null when the tail is a clause, not a value", () => {
    // 7 value tokens: this is prose making a statement, not a slot being assigned.
    expect(
      frameKeyOf("The problem with the design is that it never handles the empty case at all.")
    ).toBeNull()
  })

  it("returns null for prose with no linking token", () => {
    expect(frameKeyOf("Priya adopted a dog named Waffles")).toBeNull()
  })

  it("distinguishes different subjects sharing a frame shape", () => {
    expect(frameKeyOf("The capital of Japan is Tokyo.")).not.toBe(
      frameKeyOf("The capital of India is New Delhi.")
    )
  })

  it("does not key chat-turn prose — the LongMemEval no-op property", () => {
    expect(frameKeyOf("yeah I think we should go with the second option honestly")).toBeNull()
    expect(frameKeyOf("I moved to Denver last spring and I love it here so far")).toBeNull()
  })
})

describe("frameKeyOf — the guards at their thresholds", () => {
  it("admits a frame of exactly MIN_FRAME_TOKENS and refuses one token fewer", () => {
    /**
     * The `>= 3` boundary, from both sides. Only the pair proves the threshold: an admission test
     * alone passes with the guard deleted, and a rejection test alone passes with it set to 10.
     *
     * (Verified by mutation: `< MIN_FRAME_TOKENS` → `<= MIN_FRAME_TOKENS` fails the first
     * expectation; `MIN_FRAME_TOKENS = 2` fails the second.)
     */
    // "the capital is" — exactly 3 frame tokens.
    expect(frameKeyOf("The capital is Paris.")).toBe("the capital is")
    // "capital is" — 2 tokens, one short.
    expect(frameKeyOf("Capital is Paris.")).toBeNull()
  })

  it("admits a value of exactly MAX_VALUE_TOKENS and refuses one token more", () => {
    /**
     * The `<= 6` boundary, from both sides.
     *
     * (Verified by mutation: `> MAX_VALUE_TOKENS` → `>= MAX_VALUE_TOKENS` fails the first
     * expectation; `MAX_VALUE_TOKENS = 7` fails the second.)
     */
    // 6 value tokens after "the deploy runbook owner is".
    expect(frameKeyOf("The deploy runbook owner is a b c d e f")).toBe(
      "the deploy runbook owner is"
    )
    // 7 value tokens — one over, so no key.
    expect(frameKeyOf("The deploy runbook owner is a b c d e f g")).toBeNull()
  })

  it("keys on the LAST linking token even when several are present", () => {
    // Greediness, stated directly rather than inferred from the MAB pair: four linking tokens, and
    // the key runs through the last one.
    expect(frameKeyOf("The owner of the record in the table is Priya")).toBe(
      "the owner of the record in the table is"
    )
  })

  it("does not key a linking token that is only a substring of a word", () => {
    // `\b` on both sides: "isolation", "inbox", and "toast" contain is/in/to and must not split.
    // "Total isolation inbox toast" has no standalone linking token, so there is no frame at all.
    expect(frameKeyOf("Total isolation inbox toast")).toBeNull()
  })

  it("collapses interior newlines and tabs, so a wrapped claim keys like a flat one", () => {
    // The gist arrives from parsed HTML, where a claim may be wrapped across source lines.
    expect(frameKeyOf("The capital of\n\tIndia is\n New Delhi.")).toBe("the capital of india is")
  })

  it("returns null on an empty or whitespace-only gist rather than a bare key", () => {
    expect(frameKeyOf("")).toBeNull()
    expect(frameKeyOf("   \n  ")).toBeNull()
  })

  it("is a pure function: repeated calls on one input agree", () => {
    // No clock, no randomness, no model — which is what a rebuild's byte-identical keys rest on.
    const gist = "The capital of India is New Delhi."
    expect(frameKeyOf(gist)).toBe(frameKeyOf(gist))
  })

  it("stays linear on the three shapes that could make its regex backtrack", () => {
    /**
     * `FRAME` pairs a greedy `.*` with `\s+` and a lazy `(.+?)`, which is the structural shape of a
     * polynomial ReDoS — CodeQL flags it as `js/polynomial-redos` on the grounds that the gist is
     * unbounded library input, and the gist IS unbounded: nothing caps a `<mark>` claim's length.
     *
     * Measured 2026-08-18 at 128k characters, this is linear in all three adversarial shapes —
     * whitespace-dense 0.07 ms, keyword-free 0.27 ms, keyword-dense 12.66 ms, each growing ~1x per
     * doubling. The whitespace shape, which is the one the analyzer names, is defused by the
     * `\s+ -> " "` collapse on the line before the match: `\s+` inside `FRAME` can then only ever
     * consume a single space, so the ambiguity with `.*` never materialises.
     *
     * That collapse is therefore load-bearing for COST, not just for the case- and
     * whitespace-insensitivity it is documented for. This asserts the consequence, so that removing
     * it fails a test here rather than turning a claim into a stall on the write path.
     */
    const shapes = [
      // Collapses to "is x", whose one-token frame is below MIN_FRAME_TOKENS — so null, and the
      // 128k spaces never reach `FRAME` at all, which is exactly the point being asserted.
      { name: "whitespace-dense", gist: `is${" ".repeat(128_000)}x`, expected: null },
      { name: "keyword-free", gist: "x".repeat(128_000), expected: null },
      // Every token is a linking token, so `.*` has 42k candidate split points to backtrack through.
      { name: "keyword-dense", gist: "is ".repeat(42_000), expected: "is ".repeat(41_999).trim() }
    ]

    for (const { name, gist, expected } of shapes) {
      // Correctness first, so the guard cannot lock the cost of a wrong answer.
      expect(frameKeyOf(gist), `${name} result`).toBe(expected)

      const started = process.hrtime.bigint()
      for (let i = 0; i < 5; i++) frameKeyOf(gist)
      const perCallMs = Number(process.hrtime.bigint() - started) / 5e6
      // Three orders of magnitude below a quadratic blow-up at this size, so a loaded machine
      // cannot drift a pass into a fail.
      expect(perCallMs, `frameKeyOf took ${perCallMs.toFixed(1)}ms on ${name}`).toBeLessThan(250)
    }
  })
})

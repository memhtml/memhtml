/**
 * The frame key: a claim's SLOT, as surface grammar states it.
 *
 * A frame is a subject plus a relation up to the last linking token, and the value is what follows.
 * "The capital of India is New Delhi" keys on `the capital of india is` and carries `New Delhi` as
 * the value, so a later claim writing `Grosseto` into the same slot is recognizable as a claim about
 * the SAME thing without an LLM, without an embedding, and without reading the other claim.
 *
 * ── A PORT, not a design ─────────────────────────────────────────────────────────────────────────
 *
 * Ported verbatim from the eval harness's `src/adapter/consolidate.ts` (memhtml-evals), where the
 * rule was measured against all 8 MAB Conflict_Resolution rows before it was believed: keying on it
 * removes 143→5774 stale facts per row, loses 0 single-hop golds on three of four rows (1 on cr-07),
 * and loses 2-11 multi-hop golds. Those last are questions whose published gold disagrees with
 * the benchmark's own later-wins convention, a dataset property visible in the raw rows.
 *
 * The tokens, the two thresholds, the greedy match, and the normalization are therefore FIXED by
 * that measurement rather than chosen here. Tuning any of them in this file alone would mean the
 * eval and the system no longer agree about what a conflict is, and the eval's number would stop
 * describing the shipped behavior. `tests/frame.test.ts` carries the reference's own test cases
 * verbatim for exactly that reason.
 *
 * ── What the two guards rule out ─────────────────────────────────────────────────────────────────
 *
 * The two are asymmetric on purpose, because the costs are asymmetric. A false frame collision
 * claims two unrelated facts occupy one slot; a missed collision merely leaves both facts stored,
 * which is today's behavior and is fine. So both guards fail CLOSED to `null`:
 *
 * - the frame must be at least {@link MIN_FRAME_TOKENS} tokens, so "Water is wet" and "Water is
 *   life" (a two-token frame, ordinary prose) do not share a key;
 * - the value must be 1..{@link MAX_VALUE_TOKENS} tokens, so a frame trailed by a CLAUSE ("the
 *   problem with the design is that it never handles the empty case") is not read as a slot
 *   assignment.
 *
 * Chat-turn prose rarely repeats a ≥3-token frame with a short value, so the rule is close to a
 * no-op on conversational corpora. That is the LongMemEval property, asserted in the tests.
 */

/**
 * The frame/value split. `.*` is GREEDY, and that is the whole rule: "The capital of India is X"
 * matches the frame through `… is` rather than stopping at the inner `of`, so the key is the
 * LONGEST frame the sentence states. A lazy quantifier here would key that sentence on
 * `the capital of` and collide it with every other "the capital of …" claim regardless of country.
 *
 * The trailing `\.?` absorbs one sentence-final period so `"… is New Delhi."` and `"… is New Delhi"`
 * produce the same value token count.
 */
const FRAME = /^(.*\b(?:of|is|in|to|by|as)\b)\s+(.+?)\.?$/

/** Frames shorter than this are ordinary prose, not slots. See the guard rationale above. */
const MIN_FRAME_TOKENS = 3

/** Values longer than this are clauses, not slot assignments. */
const MAX_VALUE_TOKENS = 6

/**
 * The frame key for one claim, or `null` when the claim states no frame+value shape this rule
 * trusts. Pure and synchronous, with no clock, no randomness, no model, and no I/O, so a full
 * index rebuild reproduces byte-identical keys by construction.
 *
 * Case- and whitespace-insensitive, because a restated fact varies in both: `"The Capital of India
 * is  X"` and `"the capital of India is Y"` collide.
 *
 * @param gist The claim text. In memhtml, this is a memory's `<mark>` claim.
 * @returns The lowercased frame, or `null` for no-frame-shape (stored as SQL NULL).
 */
export const frameKeyOf = (gist: string): string | null => {
  const match = FRAME.exec(gist.replace(/\s+/g, " ").trim())
  if (match === null) return null
  const frame = match[1]
  const value = match[2]
  if (frame === undefined || value === undefined) return null
  if (frame.split(" ").length < MIN_FRAME_TOKENS) return null
  const valueTokens = value.split(" ").length
  if (valueTokens < 1 || valueTokens > MAX_VALUE_TOKENS) return null
  return frame.toLowerCase()
}

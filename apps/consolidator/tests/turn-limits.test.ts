import { describe, expect, it } from "vitest"

import { MAX_TRANSCRIPTS_PER_RUN } from "../src/contract.js"
import {
  MODEL_CALL_OUTPUT_TOKEN_LIMIT,
  SESSION_OUTPUT_TOKEN_BASE,
  SESSION_OUTPUT_TOKEN_MAX_BATCH,
  SESSION_OUTPUT_TOKEN_PER_TRANSCRIPT,
  sessionOutputTokenLimit
} from "../src/output-budget.js"

/**
 * The two output-token ceilings the turn enforces (`turn.ts`): one per model call, carried on the
 * model itself (`model.ts`), and one for the whole turn, checked between steps. Both numbers were
 * measured against real runs (issue #113) and the assertions pin the measurements, not the arithmetic.
 */
describe("the output-token ceilings", () => {
  it("caps every model call, since Bedrock's own default is 4096 and the answer does not fit", () => {
    // The measured failure: 28 consecutive calls cut off at exactly 4,096 output tokens. The ceiling
    // must clear that by an order of magnitude, and stay inside what the provider's capability table
    // reports for this model (`claude-opus-5`: 128,000).
    expect(MODEL_CALL_OUTPUT_TOKEN_LIMIT).toBeGreaterThanOrEqual(10 * 4_096)
    expect(MODEL_CALL_OUTPUT_TOKEN_LIMIT).toBeLessThanOrEqual(128_000)
  })

  it("scales the session ceiling with the batch, base plus per transcript", () => {
    expect(sessionOutputTokenLimit(0)).toBe(SESSION_OUTPUT_TOKEN_BASE)
    expect(sessionOutputTokenLimit(10)).toBe(
      SESSION_OUTPUT_TOKEN_BASE + 10 * SESSION_OUTPUT_TOKEN_PER_TRANSCRIPT
    )
  })

  it("fits the batch that exhausted the old flat cap", () => {
    // Four transcripts spent 50,368 output tokens without finishing under the old 50,000 cap, and
    // 77,824 in the repro that ran without one. The ceiling for four must clear both.
    expect(sessionOutputTokenLimit(4)).toBeGreaterThan(77_824)
  })

  it("admits a session ceiling above the per-call one, so no call is bounded by the session", () => {
    expect(sessionOutputTokenLimit(SESSION_OUTPUT_TOKEN_MAX_BATCH)).toBeGreaterThan(
      MODEL_CALL_OUTPUT_TOKEN_LIMIT
    )
  })

  /**
   * The copy that keeps the agent's imports first-party.
   *
   * `output-budget.ts` cannot import `MAX_TRANSCRIPTS_PER_RUN` from `contract.ts`, because
   * `contract.ts` reaches `effect` and `@memhtml/contracts` and both are BUNDLED into the published
   * artifact rather than installed beside it — an agent file that imported them would have dragged both
   * into the model-facing module. So the batch size is duplicated, and this is the gate that keeps the
   * two numbers equal.
   */
  it("keeps its batch literal equal to the contract's transcript ceiling", () => {
    expect(SESSION_OUTPUT_TOKEN_MAX_BATCH).toBe(MAX_TRANSCRIPTS_PER_RUN)
  })
})

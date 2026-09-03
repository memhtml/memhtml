import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  MAX_TRANSCRIPTS_PER_RUN,
  type SettledTurnShape,
  unsettledTurnReason
} from "../src/contract.js"
import {
  MODEL_CALL_OUTPUT_TOKEN_LIMIT,
  SESSION_OUTPUT_TOKEN_BASE,
  SESSION_OUTPUT_TOKEN_MAX_BATCH,
  SESSION_OUTPUT_TOKEN_PER_TRANSCRIPT,
  sessionOutputTokenLimit
} from "../src/output-budget.js"

/**
 * The two token ceilings, and the classifier for a turn eve did not settle (issue #113).
 *
 * Both fixtures are recorded from real runs rather than invented:
 *
 * - the session-limit park is the 2026-09-02 06:39Z cron turn (`$eve.output_tokens` 50,368
 *   against the agent's 50,000 cap, 65 model calls, `input.requested` of kind `session-limit` whose
 *   `action.input` is `{ kind, limit, usedTokens }`);
 * - the failed-and-parked turn is the 13:45Z repro on this branch, which ran 92 model calls, cut 28
 *   of them off at 4,096 output tokens, and ended on a Bedrock `MODEL_CALL_FAILED` followed by
 *   `session.waiting` with NO input request at all.
 *
 * The second fixture is the one that earns its place: the first version of this fix reported that
 * turn as a park on "no input request was recorded", which is true and useless. The provider's own
 * failure code was in the events the whole time.
 *
 * Mutation-verified: replacing `unsettledTurnReason`'s `status !== "waiting"` early return with
 * `return null` fails the first five cases; deleting the `failedTurnEvent` arm fails the
 * MODEL_CALL_FAILED case; restoring a literal cap in `agent.ts` fails the source assertions below.
 */
const sessionLimitPark: SettledTurnShape = {
  status: "waiting",
  inputRequests: [
    {
      kind: "session-limit",
      prompt:
        "This session has hit the output-token limit (50K) per session. This is a guardrail " +
        "against defective long-running sessions.",
      action: { input: { kind: "output", limit: 50_000, usedTokens: 50_368 } }
    }
  ],
  events: [{ type: "message.completed", data: { finishReason: "length" } }]
}

const truncatedThenFailed: SettledTurnShape = {
  status: "waiting",
  inputRequests: [],
  events: [
    ...Array.from({ length: 28 }, () => ({
      type: "message.completed",
      data: { finishReason: "length" }
    })),
    {
      type: "step.failed",
      data: {
        code: "MODEL_CALL_FAILED",
        message:
          "The system encountered an unexpected error during processing. Try your request again."
      }
    },
    {
      type: "turn.failed",
      data: {
        code: "MODEL_CALL_FAILED",
        message: "The system encountered an unexpected error during processing."
      }
    }
  ]
}

describe("unsettledTurnReason", () => {
  /**
   * The case an earlier version of this fix got wrong, and the reason `data` is the discriminator:
   * eve's `emitTurnEpilogue` ends every conversation turn with `session.waiting`, success included.
   * Measured 2026-09-02 14:53Z — a turn that emitted `result.completed` with six candidates came
   * back `status: "waiting"`, and a classifier keyed on the status alone failed the run on it.
   *
   * (Mutation: dropping the `turn.data !== undefined` early return fails this case alone.)
   */
  it("is null for a successful conversation turn, which also ends waiting", () => {
    expect(
      unsettledTurnReason(
        {
          status: "waiting",
          data: { candidates: [], commitments: [], readSessionIds: ["s1"] },
          inputRequests: [],
          events: [{ type: "result.completed" }, { type: "turn.completed" }]
        },
        97
      )
    ).toBeNull()
  })

  it("names the session token-limit prompt with the numbers the operator needs", () => {
    const reason = unsettledTurnReason(sessionLimitPark, 65)
    expect(reason).toContain("session token-limit prompt")
    expect(reason).toContain("65 model call(s)")
    expect(reason).toContain("50368 output tokens against a cap of 50000")
    expect(reason).toContain("no human to")
  })

  it("names the provider's failure code when eve failed the turn and parked it", () => {
    const reason = unsettledTurnReason(truncatedThenFailed, 92)
    expect(reason).toContain("failed and was parked for a human retry")
    expect(reason).toContain("MODEL_CALL_FAILED")
    expect(reason).toContain("92 model call(s)")
    // The truncation count is the actionable half: it says WHICH ceiling was too small.
    expect(reason).toContain("28 of which were cut off at the per-call output limit")
  })

  it("still explains a session-limit request whose numbers are missing", () => {
    const reason = unsettledTurnReason(
      { status: "waiting", inputRequests: [{ kind: "session-limit" }], events: [] },
      3
    )
    expect(reason).toContain("session token-limit prompt")
    expect(reason).toContain("3 model call(s)")
    expect(reason).not.toContain("against a cap of")
  })

  it("names any other input request by kind and prompt, cut to a log line", () => {
    const reason = unsettledTurnReason(
      {
        status: "waiting",
        inputRequests: [{ kind: "question", prompt: `Which transcript first? ${"x".repeat(500)}` }],
        events: []
      },
      7
    )
    expect(reason).toContain("nobody is present to answer")
    expect(reason).toContain("question: Which transcript first?")
    expect(reason?.length ?? 0).toBeLessThan(400)
  })

  it("explains a bare park — no result, no failure, no request — rather than staying silent", () => {
    expect(unsettledTurnReason({ status: "waiting", inputRequests: [], events: [] }, 1)).toContain(
      "ended waiting for a next message"
    )
  })

  it("is null for a turn that completed or failed outright, whatever it carries", () => {
    expect(
      unsettledTurnReason({ status: "completed", inputRequests: [], events: [] }, 65)
    ).toBeNull()
    expect(unsettledTurnReason({ ...sessionLimitPark, status: "completed" }, 65)).toBeNull()
    expect(unsettledTurnReason({ ...truncatedThenFailed, status: "failed" }, 92)).toBeNull()
  })

  it("survives payloads whose shapes it does not own", () => {
    const reason = unsettledTurnReason(
      {
        status: "waiting",
        inputRequests: [{ kind: "session-limit", action: { input: "not an object" } }],
        events: [{ type: "turn.failed" }, { type: "message.completed", data: null }]
      },
      2
    )
    expect(typeof reason).toBe("string")
  })
})

const clientCode = async (): Promise<string> => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "client.ts"),
    "utf8"
  )
  // Comments off, so the assertion is about code and not the prose that describes it.
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("runTurn explains an absent payload before it calls the contract broken", () => {
  it("asks unsettledTurnReason inside the `data === undefined` arm, ahead of the violation", async () => {
    const code = await clientCode()
    const absent = code.indexOf("analysis.data === undefined")
    const unsettled = code.indexOf("unsettledTurnReason(analysis")
    const violation = code.indexOf("ConsolidatorContractViolation.make({")
    expect(absent).toBeGreaterThan(-1)
    // Both orderings are the assertion. The classifier runs only when no payload arrived — eve ends
    // a SUCCESSFUL conversation turn `waiting` too, so asking first and failing on the status alone
    // rejected a turn that had just answered (measured 14:53Z, 2026-09-02). And it runs BEFORE the
    // violation, or the violation swallows a turn the harness stopped (the 09-01/02 misdiagnosis).
    expect(unsettled).toBeGreaterThan(absent)
    expect(unsettled).toBeLessThan(violation)
  })

  it("maps it to ConsolidatorRunFailed in the turn phase", async () => {
    const code = await clientCode()
    expect(code).toMatch(
      /unsettledTurnReason\(analysis, llmCalls\)[\s\S]{0,240}ConsolidatorRunFailed\.make\(\{ phase: "turn", reason: unsettled \}\)/
    )
  })

  it("cancels a waiting turn only when it produced no payload", async () => {
    const code = await clientCode()
    expect(code).toMatch(
      /status === "waiting" &&\s*settled\.result\.data === undefined[\s\S]{0,120}cancelWithinGrace/
    )
  })
})

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
   * artifact rather than installed beside it — an agent file that imported them failed `eve build`
   * from an installed tarball. So the batch size is duplicated, and this is the gate that keeps the
   * two numbers equal.
   */
  it("keeps its batch literal equal to the contract's transcript ceiling", () => {
    expect(SESSION_OUTPUT_TOKEN_MAX_BATCH).toBe(MAX_TRANSCRIPTS_PER_RUN)
  })
})

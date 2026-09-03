import { APICallError, tool } from "ai"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { CONSOLIDATION_OUTPUT_JSON_SCHEMA } from "../src/contract.js"
import { runTurn, withCacheBreakpoint } from "../src/turn.js"
import { answerReply, scriptedModel, textReply, throwReply, toolReply } from "./scripted-model.js"

/**
 * The turn loop's four ways out, each driven through the AI SDK's real `generateText` over a scripted
 * model: an answer, a bound reached (model calls, output tokens), the wall clock, and a provider
 * failure. The bounds are the whole point of the module — through 0.11.x they lived in a spawned
 * server and were consulted cooperatively — so each case asserts the bound fired IN THIS PROCESS and
 * was reported by name.
 */

const BARREN = { candidates: [], commitments: [], readSessionIds: ["s1"] }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const tools = (onCall?: () => void) => ({
  list_sessions: tool({
    description: "manifest",
    inputSchema: z.object({}),
    execute: async () => {
      onCall?.()
      return { sessions: [{ sessionId: "s1" }] }
    }
  })
})

const run = (
  replies: Parameters<typeof scriptedModel>[0],
  overrides: Partial<Parameters<typeof runTurn>[0]> = {},
  modelOptions: Parameters<typeof scriptedModel>[1] = {}
) => {
  const scripted = scriptedModel(replies, modelOptions)
  return {
    scripted,
    outcome: runTurn({
      model: scripted.model,
      instructions: "You are the test agent.",
      message: "Do the thing.",
      tools: tools(),
      outputSchema: CONSOLIDATION_OUTPUT_JSON_SCHEMA,
      accept: (input) =>
        isRecord(input) && Array.isArray(input.candidates) ? null : "candidates must be a list",
      providerOptions: { anthropic: { thinking: { type: "adaptive" }, effort: "high" } },
      maxModelCalls: 10,
      outputTokenLimit: 100_000,
      budgetMs: 10_000,
      ...overrides
    })
  }
}

describe("runTurn", () => {
  it("runs the tool loop to a structured answer and counts every model call", async () => {
    const { outcome, scripted } = run([toolReply("list_sessions"), answerReply(BARREN)])
    const result = await outcome
    expect(result.kind).toBe("answered")
    if (result.kind === "answered") {
      expect(result.output).toEqual(BARREN)
      expect(result.modelCalls).toBe(2)
      expect(result.outputTokens).toBe(200)
    }
    expect(scripted.calls()).toBe(2)
  })

  /**
   * The schema on the answer tool is advisory to the model (measured live: a 300-character cap
   * answered with more). A rejected answer comes back to the model as the tool's result and the
   * loop continues; the accepted resubmission is what the turn returns.
   *
   * (Mutation: stopping on the first answer-tool call regardless of `accept` returns the rejected
   * payload and fails the first assertion.)
   */
  it("hands a rejected answer back to the model and returns the accepted resubmission", async () => {
    const bad = { candidates: "not a list", commitments: [], readSessionIds: ["s1"] }
    const { outcome, scripted } = run([answerReply(bad), answerReply(BARREN)])
    const result = await outcome
    expect(result.kind).toBe("answered")
    if (result.kind === "answered") expect(result.output).toEqual(BARREN)
    // The second call's prompt carries the rejection as a tool result the model could read.
    const second = JSON.stringify(scripted.model.doGenerateCalls[1]?.prompt ?? [])
    expect(second).toContain("candidates must be a list")
  })

  it("stops after three rejected submissions and names the last problem", async () => {
    const bad = { candidates: "still not a list", commitments: [], readSessionIds: ["s1"] }
    const { outcome, scripted } = run([
      answerReply(bad),
      answerReply(bad),
      answerReply(bad),
      answerReply(BARREN)
    ])
    const result = await outcome
    expect(result.kind).toBe("stopped")
    if (result.kind === "stopped") {
      expect(result.reason).toContain("3 rejected submissions")
      expect(result.reason).toContain("candidates must be a list")
    }
    expect(scripted.calls()).toBe(3)
  })

  it("stops at the model-call ceiling and says so by name", async () => {
    const forever = Array.from({ length: 20 }, () => toolReply("list_sessions"))
    const { outcome, scripted } = run(forever, { maxModelCalls: 3 })
    const result = await outcome
    expect(result.kind).toBe("stopped")
    if (result.kind === "stopped") {
      expect(result.reason).toContain("model-call ceiling of 3")
      expect(result.modelCalls).toBe(3)
    }
    // The bound held in THIS process: the model was not asked a fourth time.
    expect(scripted.calls()).toBe(3)
  })

  it("stops at the output-token ceiling and names the tokens spent", async () => {
    const forever = Array.from({ length: 20 }, () => toolReply("list_sessions"))
    const { outcome } = run(forever, { outputTokenLimit: 250 }, { outputTokensPerCall: 100 })
    const result = await outcome
    expect(result.kind).toBe("stopped")
    if (result.kind === "stopped") {
      expect(result.reason).toContain("output-token ceiling of 250")
      expect(result.reason).toContain("(300 spent)")
    }
  })

  it("times out on the wall clock without waiting for the model", async () => {
    const started = Date.now()
    const { outcome } = run(
      [toolReply("list_sessions"), answerReply(BARREN)],
      { budgetMs: 200 },
      { delayMs: 5_000 }
    )
    const result = await outcome
    expect(result.kind).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("reports a provider failure with its status rather than throwing", async () => {
    const error = new APICallError({
      message: "Bad Request",
      url: "http://127.0.0.1:4000/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"message":"ValidationException: bad thinking config"}'
    })
    const { outcome } = run([throwReply(error)])
    const result = await outcome
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toContain("400")
      expect(result.reason).toContain("ValidationException")
    }
  })

  it("reports a turn that ended in prose rather than the object, with the finish reason", async () => {
    const { outcome } = run([textReply("I could not find anything worth writing down.")])
    const result = await outcome
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") expect(result.reason).toContain("without a structured answer")
  })

  it("passes the reasoning provider options on every call", async () => {
    const { outcome, scripted } = run([toolReply("list_sessions"), answerReply(BARREN)])
    await outcome
    const options = scripted.model.doGenerateCalls.map((call) => call.providerOptions)
    expect(options).toHaveLength(2)
    for (const entry of options) {
      expect(entry).toMatchObject({ anthropic: { thinking: { type: "adaptive" }, effort: "high" } })
    }
  })
})

describe("withCacheBreakpoint", () => {
  it("marks only the last message as an Anthropic cache breakpoint", () => {
    const marked = withCacheBreakpoint([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" }
    ])
    expect(marked[0]?.providerOptions).toBeUndefined()
    expect(marked[1]?.providerOptions).toBeUndefined()
    expect(marked[2]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } }
    })
  })

  it("is applied by the loop, so the second call's prompt carries a breakpoint", async () => {
    const { outcome, scripted } = run([toolReply("list_sessions"), answerReply(BARREN)])
    await outcome
    const second = scripted.model.doGenerateCalls[1]?.prompt ?? []
    const last = second.at(-1)
    expect(JSON.stringify(last?.providerOptions ?? {})).toContain("ephemeral")
  })
})

describe("the cache breakpoint MOVES rather than accumulating", () => {
  /**
   * The mark from the previous step is still on its message when the next step runs, and Anthropic
   * allows four per request: a second call that added a mark without clearing the first would carry
   * two, a fifth call five, and the SDK drops the newest (measured live 2026-09-03: "Maximum 4 cache
   * breakpoints exceeded (found 8)"). So re-marking must clear the earlier marks, and the count stays
   * at one however many steps ran, while other provider options on those messages survive.
   *
   * (Mutation: dropping the clearing leaves marks on messages 0 and 2 and fails the count.)
   */
  it("clears earlier marks and keeps other provider options", () => {
    const first = withCacheBreakpoint([{ role: "user", content: "a" }])
    const second = withCacheBreakpoint([
      ...first,
      { role: "assistant", content: "b", providerOptions: { anthropic: { effort: "high" } } },
      { role: "user", content: "c", providerOptions: { bedrock: { note: 1 } } }
    ])
    expect(second[0]?.providerOptions).toBeUndefined()
    expect(second[1]?.providerOptions).toEqual({ anthropic: { effort: "high" } })
    expect(second[2]?.providerOptions).toEqual({
      bedrock: { note: 1 },
      anthropic: { cacheControl: { type: "ephemeral" } }
    })
    const marks = second.filter((m) =>
      JSON.stringify(m.providerOptions ?? {}).includes("ephemeral")
    )
    expect(marks).toHaveLength(1)
  })

  it("holds at one breakpoint across a real multi-step loop", async () => {
    const replies = [
      toolReply("list_sessions"),
      toolReply("list_sessions"),
      toolReply("list_sessions"),
      answerReply(BARREN)
    ]
    const { outcome, scripted } = run(replies)
    await outcome
    const last = scripted.model.doGenerateCalls.at(-1)?.prompt ?? []
    const marks = last.filter((m) => JSON.stringify(m.providerOptions ?? {}).includes("ephemeral"))
    expect(marks).toHaveLength(1)
  })
})

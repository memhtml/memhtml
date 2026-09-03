import { MockLanguageModelV4 } from "ai/test"

/**
 * A scripted `LanguageModelV4` for the test tier: each `doGenerate` pops the next scripted reply, so a
 * test states the whole conversation up front — tool calls the model "makes", then the answer — and
 * drives `generateText`'s real loop with no network. Built on the AI SDK's own mock so the shapes the
 * loop reads (content parts, finish reasons, usage) are the SDK's, not ours.
 */

type Reply =
  | { readonly kind: "tool"; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly kind: "answer"; readonly payload: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "throw"; readonly error: Error }

const usage = (outputTokens: number) => ({
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
})

export const toolReply = (name: string, input: Record<string, unknown> = {}): Reply => ({
  kind: "tool",
  name,
  input
})
export const answerReply = (payload: unknown): Reply => ({ kind: "answer", payload })
export const textReply = (text: string): Reply => ({ kind: "text", text })
export const throwReply = (error: Error): Reply => ({ kind: "throw", error })

export interface ScriptedModel {
  readonly model: MockLanguageModelV4
  /** How many model calls the script has answered so far. */
  readonly calls: () => number
  /** The messages of the most recent call, for assertions about what the model was shown. */
  readonly lastPrompt: () => unknown
}

export const scriptedModel = (
  replies: ReadonlyArray<Reply>,
  options: { readonly outputTokensPerCall?: number; readonly delayMs?: number } = {}
): ScriptedModel => {
  const queue = [...replies]
  let calls = 0
  let lastPrompt: unknown
  let toolCallCounter = 0
  const model = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "scripted-opus",
    doGenerate: async (call) => {
      calls += 1
      lastPrompt = call.prompt
      if (options.delayMs !== undefined) {
        // A real provider call is a fetch, which rejects the moment its signal aborts; the scripted
        // delay does the same, or a wall-clock test would be measuring this mock's sleep.
        await new Promise<void>((settle, reject) => {
          const timer = setTimeout(settle, options.delayMs)
          call.abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(new Error("aborted"))
            },
            { once: true }
          )
        })
      }
      if (call.abortSignal?.aborted) throw new Error("aborted")
      const reply = queue.shift() ?? textReply("(script exhausted)")
      const out = usage(options.outputTokensPerCall ?? 100)
      switch (reply.kind) {
        case "throw":
          throw reply.error
        case "tool":
          toolCallCounter += 1
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `call-${String(toolCallCounter)}`,
                toolName: reply.name,
                input: JSON.stringify(reply.input)
              }
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: out,
            warnings: []
          }
        case "answer":
          toolCallCounter += 1
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `call-${String(toolCallCounter)}`,
                toolName: "submit_answer",
                input: JSON.stringify(reply.payload)
              }
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: out,
            warnings: []
          }
        case "text":
          return {
            content: [{ type: "text", text: reply.text }],
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: out,
            warnings: []
          }
      }
    }
  })
  return { model, calls: () => calls, lastPrompt: () => lastPrompt }
}

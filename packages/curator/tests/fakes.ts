import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult
} from "@ai-sdk/provider"
import type { OverlayOp } from "@memhtml/contracts"
import type { Violation } from "@memhtml/session"
import { MockLanguageModelV4 } from "ai/test"

import type {
  Briefing,
  CuratorExecResult,
  CuratorProposeResult,
  CuratorRecordView,
  CuratorTools
} from "../src/index.js"

/**
 * The two fakes every loop test composes: a scripted model and a recording tool set. Neither knows
 * a head or a session, which is the point of `CuratorTools` being an interface.
 */

/** One scripted model call: a tool call, or a plain text answer. */
export type Scripted = { readonly tool: string; readonly args: unknown } | { readonly text: string }

export const USAGE = { input: 100, output: 20 }

const generateResult = (step: Scripted, index: number): LanguageModelV4GenerateResult => ({
  content:
    "text" in step
      ? [{ type: "text", text: step.text }]
      : [
          {
            type: "tool-call",
            toolCallId: `call-${String(index)}`,
            toolName: step.tool,
            input: JSON.stringify(step.args)
          }
        ],
  finishReason: { unified: "text" in step ? "stop" : "tool-calls", raw: undefined },
  usage: {
    inputTokens: {
      total: USAGE.input,
      noCache: USAGE.input,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: { total: USAGE.output, text: USAGE.output, reasoning: undefined }
  },
  warnings: []
})

/**
 * A model that plays `script` in order and repeats the last entry when asked for more, so a script
 * that never finishes keeps the loop running until a budget stops it. `calls` records every prompt
 * the model received, which is how a test reads what the previous tool result looked like.
 */
export const scriptedModel = (
  script: ReadonlyArray<Scripted>
): LanguageModelV4 & { readonly doGenerateCalls: LanguageModelV4CallOptions[] } => {
  let index = 0
  return new MockLanguageModelV4({
    provider: "test",
    modelId: "scripted",
    doGenerate: async () => {
      const step = script[Math.min(index, script.length - 1)]
      if (step === undefined) throw new Error("an empty script has nothing to play")
      index += 1
      return generateResult(step, index)
    }
  })
}

export interface FakeToolOptions {
  readonly record?: CuratorRecordView | null | undefined
  readonly exec?: Partial<CuratorExecResult> | undefined
  readonly propose?: ((ops: ReadonlyArray<OverlayOp>) => CuratorProposeResult) | undefined
  /** A delay every tool waits before answering, for the wall-clock case. */
  readonly delayMs?: number | undefined
}

export interface FakeTools extends CuratorTools {
  readonly calls: Array<{ readonly name: string; readonly input: unknown }>
  readonly proposed: Array<ReadonlyArray<OverlayOp>>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const fakeTools = (options: FakeToolOptions = {}): FakeTools => {
  const calls: FakeTools["calls"] = []
  const proposed: FakeTools["proposed"] = []
  const delay = () => (options.delayMs === undefined ? Promise.resolve() : wait(options.delayMs))
  return {
    calls,
    proposed,
    search: async (query, limit) => {
      calls.push({ name: "search", input: { query, limit } })
      await delay()
      return [{ path: "areas/inbox/a.html", score: 1, claim: `about ${query}` }]
    },
    read: async (path) => {
      calls.push({ name: "read", input: path })
      await delay()
      return options.record === undefined ? null : options.record
    },
    exec: async (script) => {
      calls.push({ name: "exec", input: script })
      await delay()
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        ops: [],
        appended: 0,
        rejected: [],
        violations: [],
        ...options.exec
      }
    },
    propose: async (ops) => {
      calls.push({ name: "propose", input: ops })
      proposed.push(ops)
      await delay()
      return options.propose === undefined
        ? { appended: ops.length, violations: [] }
        : options.propose(ops)
    },
    status: async () => {
      calls.push({ name: "status", input: {} })
      await delay()
      return {
        baseSha: "0".repeat(40),
        ref: "refs/heads/curate/test",
        ops: { put: 0, archive: 0, link: 0, unlink: 0, label: 0, unlabel: 0, move: 0 }
      }
    }
  }
}

export const duplicateViolation = (path: string, existing: string): Violation => ({
  kind: "duplicate",
  path,
  existing
})

export const emptyBriefing: Briefing = {
  active: 3,
  archived: 1,
  inboxShare: 1,
  duplicates: [],
  duplicatesTotal: 0,
  contradictions: [],
  contradictionsTotal: 0,
  danglingLinks: 0,
  lowestConfidence: [],
  lastCurate: null,
  recent: [],
  recentTotal: 0,
  unlabeled: [],
  unlabeledTotal: 0,
  supersededActive: [],
  supersededActiveTotal: 0,
  danglingEdges: [],
  danglingEdgesTotal: 0,
  inbox: [],
  inboxTotal: 0,
  inboxWithHome: 0,
  inboxHomes: []
}

/** Every text a tool answered with in the prompt the model saw on call `index`. */
export const toolResultTexts = (
  model: { readonly doGenerateCalls: LanguageModelV4CallOptions[] },
  index: number
): ReadonlyArray<string> => {
  const call = model.doGenerateCalls[index]
  if (call === undefined) throw new Error(`the model was not called ${String(index + 1)} time(s)`)
  return call.prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : []
        )
      : []
  )
}

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { runCurator, TOOL_RESULT_CAP, TRUNCATION_MARKER, truncateToolResult } from "../src/index.js"
import {
  duplicateViolation,
  emptyBriefing,
  fakeTools,
  scriptedModel,
  toolResultTexts,
  USAGE
} from "./fakes.js"

/**
 * The loop over a scripted model and recording tools: the tool sequence, the report, the counts, and
 * each budget stop.
 *
 * Mutations, each run once with the change applied and the named case red (2026-09-23):
 * - `loop.ts` `stopWhen`: `isStepCount(budget.maxSteps + 2)` -> "a model that never finishes is
 *   stopped at maxSteps" (five steps, not three). Dropping the condition outright hangs the loop,
 *   which is the same guard proven the loud way.
 * - `loop.ts`: the wall-clock timer no longer calls `controller.abort()` -> "a slow tool under a
 *   50 ms wall clock is stopped by the clock" (the case runs to the 5 s test timeout).
 * - `loop.ts` `asToolResult`: return the text uncut -> "a tool result over the cap is truncated with a
 *   marker" (no marker, full length).
 * - `loop.ts` `propose` execute: return `{ appended, missing }` without `violations` -> "violations
 *   from propose reach the model on the next call" (the kind is absent from the prompt).
 * - `loop.ts` `stopWhen`: drop `() => opsAppended >= budget.maxOps` -> "an op ceiling stops the loop
 *   once the tools report that many appended" (the loop runs to maxSteps).
 */

const CHARTER = "You are the curator under test."

const run = (input: Parameters<typeof runCurator>[0]) => Effect.runPromise(runCurator(input))

describe("the happy path", () => {
  it("calls status, exec, propose, finish in order and returns the report with counts", async () => {
    const tools = fakeTools({ exec: { appended: 1 } })
    const model = scriptedModel([
      { tool: "status", args: {} },
      { tool: "exec", args: { script: "console.log(1)" } },
      {
        tool: "propose",
        args: {
          ops: [
            { kind: "link", path: "areas/inbox/a.html", rel: "supersedes", href: "/archive/x.html" }
          ]
        }
      },
      { tool: "finish", args: { report: "Archived one duplicate.\n\nNothing left undone." } }
    ])
    const result = await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    expect(result.toolCalls).toEqual(["status", "exec", "propose", "finish"])
    expect(tools.calls.map((call) => call.name)).toEqual(["status", "exec", "propose"])
    expect(result.stoppedBy).toBe("finish")
    expect(result.report).toBe("Archived one duplicate.\n\nNothing left undone.")
    expect(result.steps).toBe(4)
    expect(result.inputTokens).toBe(4 * USAGE.input)
    expect(result.outputTokens).toBe(4 * USAGE.output)
    // One from exec's harvest, one from the proposal the fake tools accepted.
    expect(result.opsAppended).toBe(2)
    expect(result.error).toBeNull()
    // The charter is the system message and the briefing is the user message, on every call.
    const first = model.doGenerateCalls[0]
    expect(first?.prompt[0]).toEqual({ role: "system", content: CHARTER })
    const user = first?.prompt[1]
    const userText =
      user?.role === "user"
        ? user.content.map((part) => (part.type === "text" ? part.text : "")).join("")
        : ""
    expect(userText).toContain('"active": 3')
  })

  it("passes a proposed archive through read for its bytes and derives its destination", async () => {
    const tools = fakeTools({
      record: {
        path: "areas/inbox/dup.html",
        title: "Dup",
        claim: "The capital of India is New Delhi.",
        memoryType: "semantic",
        status: "active",
        frameKey: "the capital of india is",
        confidence: null,
        importance: null,
        tags: [],
        entities: [],
        links: [],
        archived: false,
        html: "<!doctype html><html>dup</html>"
      }
    })
    const model = scriptedModel([
      { tool: "propose", args: { ops: [{ kind: "archive", path: "areas/inbox/dup.html" }] } },
      { tool: "finish", args: { report: "done" } }
    ])
    const result = await run({
      tools,
      model,
      briefing: emptyBriefing,
      charter: CHARTER,
      now: () => new Date("2026-09-23T00:00:00Z")
    })
    expect(result.stoppedBy).toBe("finish")
    expect(tools.proposed).toEqual([
      [
        {
          kind: "archive",
          path: "areas/inbox/dup.html",
          to: "archive/2026/areas/inbox/dup.html",
          html: "<!doctype html><html>dup</html>"
        }
      ]
    ])
  })
})

describe("a proposed unlink", () => {
  it("passes through the schema as the contract's own shape", async () => {
    // (Mutation: the `unlink` branch removed from `ProposedOp` -> the SDK refuses the tool input
    // and nothing reaches `propose`; observed `expected [] to deeply equal [ [ { kind: 'unlink',
    // ...(3) } ] ]`.)
    const tools = fakeTools()
    const model = scriptedModel([
      {
        tool: "propose",
        args: {
          ops: [
            {
              kind: "unlink",
              path: "areas/inbox/a.html",
              rel: "relates_to",
              href: "/areas/inbox/gone.html"
            }
          ]
        }
      },
      { tool: "finish", args: { report: "dropped one" } }
    ])
    const result = await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    expect(result.stoppedBy).toBe("finish")
    expect(tools.proposed).toEqual([
      [
        {
          kind: "unlink",
          path: "areas/inbox/a.html",
          rel: "relates_to",
          href: "/areas/inbox/gone.html"
        }
      ]
    ])
    expect(result.opsAppended).toBe(1)
  })
})

describe("a text-only answer", () => {
  it("ends the run as finish with the text as the report, no tool call needed", async () => {
    // The first live run (Opus 5.5 through the proxy, 2026-09-23) closed with prose instead of a
    // `finish` call; under `toolChoice: "required"` that threw and the run was reported as a model
    // failure with its ops stranded. The text is the report.
    const tools = fakeTools({ exec: { appended: 2 } })
    const model = scriptedModel([
      { tool: "exec", args: { script: "console.log(1)" } },
      { text: "Linked two records.\n\nLeft undone: everything else." }
    ])
    const result = await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    expect(result.stoppedBy).toBe("finish")
    expect(result.report).toBe("Linked two records.\n\nLeft undone: everything else.")
    expect(result.toolCalls).toEqual(["exec"])
    expect(result.opsAppended).toBe(2)
    expect(result.error).toBeNull()
    expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: "auto" })
  })
})

describe("the budget stops", () => {
  it("a model that never finishes is stopped at maxSteps", async () => {
    const tools = fakeTools()
    const model = scriptedModel([{ tool: "status", args: {} }])
    const result = await run({
      tools,
      model,
      briefing: emptyBriefing,
      charter: CHARTER,
      budget: { maxSteps: 3 }
    })
    expect(result.stoppedBy).toBe("maxSteps")
    expect(result.steps).toBe(3)
    expect(result.toolCalls).toEqual(["status", "status", "status"])
    expect(result.report).toContain("step ceiling of 3")
  })

  it("a slow tool under a 50 ms wall clock is stopped by the clock", async () => {
    const tools = fakeTools({ delayMs: 120 })
    const model = scriptedModel([{ tool: "status", args: {} }])
    const started = Date.now()
    const result = await run({
      tools,
      model,
      briefing: emptyBriefing,
      charter: CHARTER,
      budget: { maxSteps: 50, wallClockMs: 50 }
    })
    expect(result.stoppedBy).toBe("wallClock")
    expect(result.steps).toBeLessThan(5)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.report).toContain("wall clock of 50 ms")
  })

  it("an op ceiling stops the loop once the tools report that many appended", async () => {
    const tools = fakeTools({ exec: { appended: 2 } })
    const model = scriptedModel([{ tool: "exec", args: { script: "1" } }])
    const result = await run({
      tools,
      model,
      briefing: emptyBriefing,
      charter: CHARTER,
      budget: { maxOps: 3, maxSteps: 20 }
    })
    expect(result.stoppedBy).toBe("maxOps")
    expect(result.opsAppended).toBe(4)
    expect(result.steps).toBe(2)
  })

  it("a throwing model is a modelError with the message, not a thrown run", async () => {
    const tools = fakeTools()
    const model = scriptedModel([{ tool: "status", args: {} }])
    model.doGenerate = async () => {
      throw new Error("the provider is down")
    }
    const result = await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    expect(result.stoppedBy).toBe("modelError")
    expect(result.error).toContain("the provider is down")
    expect(result.steps).toBe(0)
  })
})

describe("tool results are bounded and informative", () => {
  it("truncateToolResult cuts at the cap with a marker and leaves a short text alone", () => {
    expect(truncateToolResult("short", 10)).toBe("short")
    const cut = truncateToolResult("x".repeat(25), 10)
    expect(cut.startsWith("x".repeat(10))).toBe(true)
    expect(cut).toContain(TRUNCATION_MARKER)
    expect(cut).toContain("15 of 25 characters dropped")
  })

  it("a tool result over the cap is truncated with a marker", async () => {
    const html = "y".repeat(TOOL_RESULT_CAP * 2)
    const tools = fakeTools({
      record: {
        path: "areas/inbox/big.html",
        title: "Big",
        claim: "big",
        memoryType: "semantic",
        status: "active",
        frameKey: null,
        confidence: null,
        importance: null,
        tags: [],
        entities: [],
        links: [],
        archived: false,
        html
      }
    })
    const model = scriptedModel([
      { tool: "read", args: { path: "areas/inbox/big.html" } },
      { tool: "finish", args: { report: "done" } }
    ])
    await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    const [text] = toolResultTexts(model, 1)
    expect(text).toBeDefined()
    expect(text?.length ?? 0).toBeLessThan(TOOL_RESULT_CAP + 200)
    expect(text).toContain(TRUNCATION_MARKER)
    expect(text).toContain(`${String(TOOL_RESULT_CAP)}-character cap`)
  })

  it("violations from propose reach the model on the next call", async () => {
    const tools = fakeTools({
      propose: (ops) => ({
        appended: 0,
        violations: ops.map((op) => duplicateViolation(op.path, "areas/inbox/existing.html"))
      })
    })
    const model = scriptedModel([
      {
        tool: "propose",
        args: { ops: [{ kind: "put", path: "areas/inbox/new.html", html: "<html>x</html>" }] }
      },
      { tool: "finish", args: { report: "gave up" } }
    ])
    const result = await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    expect(result.opsAppended).toBe(0)
    const [text] = toolResultTexts(model, 1)
    expect(text).toContain('"kind":"duplicate"')
    expect(text).toContain("areas/inbox/existing.html")
  })

  it("a throwing tool answers the model with the error as a value and the run goes on", async () => {
    const tools = fakeTools()
    tools.exec = async () => {
      throw new Error("sandbox unavailable")
    }
    const model = scriptedModel([
      { tool: "exec", args: { script: "1" } },
      { tool: "finish", args: { report: "done" } }
    ])
    const result = await run({ tools, model, briefing: emptyBriefing, charter: CHARTER })
    expect(result.stoppedBy).toBe("finish")
    const [text] = toolResultTexts(model, 1)
    expect(text).toContain("exec failed: sandbox unavailable")
  })

  it("status carries the run's own spend beside the session's numbers", async () => {
    const tools = fakeTools()
    const model = scriptedModel([
      { tool: "status", args: {} },
      { tool: "status", args: {} },
      { tool: "finish", args: { report: "done" } }
    ])
    await run({ tools, model, briefing: emptyBriefing, charter: CHARTER, budget: { maxSteps: 7 } })
    // The second status answers after one full step: the spend excludes the call in flight.
    const [text] = toolResultTexts(model, 2).slice(-1)
    const status = JSON.parse(text ?? "{}") as Record<string, unknown>
    expect(status.ref).toBe("refs/heads/curate/test")
    expect(status.stepsMax).toBe(7)
    expect(status.stepsUsed).toBe(1)
    expect(status.tokensUsed).toEqual({ input: USAGE.input, output: USAGE.output })
  })
})

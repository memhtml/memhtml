import { describe, expect, it } from "vitest"

import {
  ANTHROPIC_VERSION,
  EMBED_BATCH_LIMIT,
  EMBED_DIM,
  EMBED_MODEL_ID,
  EMBED_WATERMARK,
  MAX_TOKENS_CEILING,
  MAX_TOKENS_DEFAULT,
  STRUCTURED_TOOL_NAME
} from "../src/constants.js"
import { MODELS, modelByKey, thinkingFor } from "../src/models.js"
import {
  asResponseBody,
  buildInvokeBody,
  clampTokens,
  INCOMPLETE_STOP_REASONS,
  incompleteReason,
  readText,
  readToolInput
} from "../src/wire.js"

const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>

describe("bedrock wire constants", () => {
  it("pins the embedder and the dimension the schema stores", () => {
    expect(EMBED_MODEL_ID).toBe("cohere.embed-v4:0")
    expect(EMBED_DIM).toBe(1024)
  })

  it("keeps the batch limit at Cohere's per-request ceiling", () => {
    expect(EMBED_BATCH_LIMIT).toBe(96)
  })

  it("leaves headroom above the 8192 ceiling that truncated structured output", () => {
    expect(MAX_TOKENS_DEFAULT).toBeGreaterThan(8192)
    expect(STRUCTURED_TOOL_NAME).toBe("emit")
  })

  it("states the watermark as model id and dimension together", () => {
    // A model id alone does not identify a vector space; the index compares this string.
    expect(EMBED_WATERMARK).toBe(`${EMBED_MODEL_ID}@${EMBED_DIM}`)
  })
})

describe("MODELS", () => {
  it("carries the three Claude 5 global inference profiles and no other vendor", () => {
    expect(MODELS.map((model) => model.key)).toEqual(["sonnet-5", "opus-5", "fable-5"])
    for (const model of MODELS) {
      expect(model.modelId).toMatch(/^global\.anthropic\.claude-/)
    }
  })

  it("resolves every key in the union", () => {
    expect(modelByKey("sonnet-5").modelId).toBe("global.anthropic.claude-sonnet-5")
    expect(modelByKey("opus-5").modelId).toBe("global.anthropic.claude-opus-5")
    expect(modelByKey("fable-5").modelId).toBe("global.anthropic.claude-fable-5")
  })
})

describe("thinkingFor", () => {
  it("gives the two adaptive models an adaptive block and sonnet none", () => {
    expect(thinkingFor("opus-5")).toEqual({ type: "adaptive" })
    expect(thinkingFor("fable-5")).toEqual({ type: "adaptive" })
    expect(thinkingFor("sonnet-5")).toBeNull()
  })
})

describe("clampTokens", () => {
  it("defaults, passes a request through, and clamps at the 128k ceiling", () => {
    expect(clampTokens(undefined)).toBe(MAX_TOKENS_DEFAULT)
    expect(clampTokens(4096)).toBe(4096)
    expect(clampTokens(MAX_TOKENS_CEILING)).toBe(MAX_TOKENS_CEILING)
    expect(clampTokens(999_999)).toBe(MAX_TOKENS_CEILING)
    expect(MAX_TOKENS_CEILING).toBe(128_000)
  })
})

describe("buildInvokeBody", () => {
  it("omits the thinking key entirely for sonnet-5", () => {
    const body = parse(buildInvokeBody("sonnet-5", "hi", { effort: "low" }))
    expect("thinking" in body).toBe(false)
    expect(body.anthropic_version).toBe(ANTHROPIC_VERSION)
    expect(body.output_config).toEqual({ effort: "low" })
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("sets adaptive thinking for fable-5 and opus-5", () => {
    for (const key of ["fable-5", "opus-5"] as const) {
      const body = parse(buildInvokeBody(key, "hi", { effort: "high" }))
      expect(body.thinking).toEqual({ type: "adaptive" })
    }
  })

  it("clamps max_tokens at the ceiling in the body itself", () => {
    const body = parse(buildInvokeBody("sonnet-5", "hi", { effort: "low", maxTokens: 500_000 }))
    expect(body.max_tokens).toBe(MAX_TOKENS_CEILING)
  })

  it("omits an absent or empty system rather than sending an empty block", () => {
    expect("system" in parse(buildInvokeBody("sonnet-5", "hi", { effort: "low" }))).toBe(false)
    expect(
      "system" in parse(buildInvokeBody("sonnet-5", "hi", { effort: "low", system: "" }))
    ).toBe(false)
    expect(
      parse(buildInvokeBody("sonnet-5", "hi", { effort: "low", system: "be terse" })).system
    ).toBe("be terse")
  })

  it("carries no tools key when no tool is requested", () => {
    const body = parse(buildInvokeBody("sonnet-5", "hi", { effort: "low" }))
    expect("tools" in body).toBe(false)
    expect("tool_choice" in body).toBe(false)
  })

  it("forces the emit tool when one is given", () => {
    const inputSchema = { type: "object", properties: {}, additionalProperties: false }
    const body = parse(
      buildInvokeBody("opus-5", "hi", { effort: "low" }, { inputSchema, description: "emit it" })
    )
    expect(body.tool_choice).toEqual({ type: "tool", name: STRUCTURED_TOOL_NAME })
    expect(body.tools).toEqual([
      { name: STRUCTURED_TOOL_NAME, description: "emit it", input_schema: inputSchema }
    ])
    // Structured output and adaptive thinking compose (verified live 2026-08-02).
    expect(body.thinking).toEqual({ type: "adaptive" })
  })
})

describe("incompleteReason", () => {
  it("names both incomplete stop reasons and nothing else", () => {
    expect([...INCOMPLETE_STOP_REASONS].sort()).toEqual(["max_tokens", "refusal"])
    expect(incompleteReason({ stop_reason: "max_tokens" })).toBe("max_tokens")
    expect(incompleteReason({ stop_reason: "refusal" })).toBe("refusal")
    expect(incompleteReason({ stop_reason: "end_turn" })).toBeNull()
    expect(incompleteReason({ stop_reason: "tool_use" })).toBeNull()
    expect(incompleteReason({})).toBeNull()
  })
})

describe("readText", () => {
  it("joins text blocks and discards thinking blocks", () => {
    const parsed = asResponseBody({
      content: [
        { type: "thinking", text: "deliberation nobody asked for" },
        { type: "text", text: "first" },
        { type: "text", text: "second" }
      ]
    })
    expect(readText(parsed)).toBe("first\n\nsecond")
  })

  it("is empty for a response with no text block", () => {
    expect(
      readText(asResponseBody({ content: [{ type: "tool_use", name: "emit", input: {} }] }))
    ).toBe("")
    expect(readText(asResponseBody({}))).toBe("")
    expect(readText(asResponseBody(null))).toBe("")
  })
})

describe("readToolInput", () => {
  it("finds the emit block by name even when a thinking block precedes it", () => {
    const parsed = asResponseBody({
      content: [
        { type: "thinking", text: "…" },
        { type: "tool_use", name: "emit", input: { keep: "areas/x.html" } }
      ]
    })
    expect(readToolInput(parsed)).toEqual({ keep: "areas/x.html" })
  })

  it("ignores a tool_use block under another name", () => {
    const parsed = asResponseBody({
      content: [{ type: "tool_use", name: "something_else", input: { keep: "x" } }]
    })
    expect(readToolInput(parsed)).toBeUndefined()
  })

  it("is undefined when the model answered in prose instead", () => {
    expect(
      readToolInput(asResponseBody({ content: [{ type: "text", text: "sure!" }] }))
    ).toBeUndefined()
  })
})

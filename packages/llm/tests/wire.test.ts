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
  normalizeOpenAiResponse,
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
    // 64,000: the consolidator's measured per-call need (issue #113), half the model ceiling.
    expect(MAX_TOKENS_DEFAULT).toBe(64_000)
    expect(MAX_TOKENS_DEFAULT).toBeLessThan(MAX_TOKENS_CEILING)
    expect(STRUCTURED_TOOL_NAME).toBe("emit")
  })

  it("states the watermark as model id and dimension together", () => {
    // A model id alone does not identify a vector space; the index compares this string.
    expect(EMBED_WATERMARK).toBe(`${EMBED_MODEL_ID}@${EMBED_DIM}`)
  })
})

describe("MODELS", () => {
  it("carries the global inference profiles for both providers", () => {
    expect(MODELS.map((model) => model.key)).toEqual([
      "sonnet-5",
      "opus-5",
      "fable-5",
      "gpt-5.6-sol"
    ])
    // The global. prefix is mandatory for every entry: the bare openai ids reject
    // on-demand invocation outright, and the anthropic ones would lose cross-region routing.
    for (const model of MODELS) {
      expect(model.modelId).toMatch(/^global\./)
    }
  })

  it("resolves every key in the union with its provider", () => {
    expect(modelByKey("sonnet-5").modelId).toBe("global.anthropic.claude-sonnet-5")
    expect(modelByKey("opus-5").modelId).toBe("global.anthropic.claude-opus-5")
    expect(modelByKey("fable-5").modelId).toBe("global.anthropic.claude-fable-5")
    expect(modelByKey("gpt-5.6-sol").modelId).toBe("global.openai.gpt-5.6-sol")
    expect(modelByKey("gpt-5.6-sol").provider).toBe("openai")
    expect(modelByKey("sonnet-5").provider).toBe("anthropic")
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

  it("floors a zero or negative budget at 1 rather than passing it to the wire", () => {
    // `max_tokens` must be a positive integer, so an unfloored 0 would raise a
    // ValidationException at the service — a malformed request instead of a bounded one.
    expect(clampTokens(0)).toBe(1)
    expect(clampTokens(-5)).toBe(1)
    expect(clampTokens(1)).toBe(1)
  })

  it("resolves NaN to the default, because NaN survives both bounds", () => {
    // NaN loses every comparison, so a min/max pair passes it through unchanged and
    // `JSON.stringify` writes it as `null` — the malformed request the floor exists to
    // prevent. It is also not a budget, so it resolves to the default rather than to a bound.
    expect(clampTokens(Number.NaN)).toBe(MAX_TOKENS_DEFAULT)
  })

  it("truncates a fractional budget, since the field takes an integer", () => {
    expect(clampTokens(1.5)).toBe(1)
    expect(clampTokens(4096.9)).toBe(4096)
    // Truncation toward zero then meets the floor.
    expect(clampTokens(0.5)).toBe(1)
    expect(clampTokens(-0.5)).toBe(1)
  })

  it("meets a bound for either infinity", () => {
    expect(clampTokens(Number.POSITIVE_INFINITY)).toBe(MAX_TOKENS_CEILING)
    expect(clampTokens(Number.NEGATIVE_INFINITY)).toBe(1)
  })
})

describe("the emitted token budget", () => {
  it("is a positive integer on both dialects, whatever the caller asked", () => {
    /**
     * The clamp is the only guard between `StructuredRequest.maxTokens` /
     * `GenerateOptions.maxTokens` and the wire, and the failure is invisible in the clamp's
     * return type: `JSON.stringify({max_tokens: NaN})` emits `"max_tokens":null` and a
     * fractional value emits itself. So the assertion is over the BYTES, per dialect, since
     * each names the field differently.
     */
    const asked = [Number.NaN, 1.5, 0, -5, 4096.9, Number.POSITIVE_INFINITY]
    for (const maxTokens of asked) {
      const anthropic = parse(buildInvokeBody("sonnet-5", "hi", { effort: "low", maxTokens }))
      const openai = parse(buildInvokeBody("gpt-5.6-sol", "hi", { effort: "low", maxTokens }))
      for (const budget of [anthropic.max_tokens, openai.max_completion_tokens]) {
        expect(typeof budget).toBe("number")
        expect(Number.isSafeInteger(budget)).toBe(true)
        expect(budget as number).toBeGreaterThan(0)
        expect(budget as number).toBeLessThanOrEqual(MAX_TOKENS_CEILING)
      }
    }
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

  it("sends a plain system string when caching is not asked for", () => {
    // The default shape, pinned so the cached shape is a deliberate opt-in rather than a drift.
    const body = parse(buildInvokeBody("sonnet-5", "hi", { effort: "low", system: "be terse" }))
    expect(body.system).toBe("be terse")
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  it("sends the system as one ephemeral cache_control text block when caching is asked for", () => {
    const body = parse(
      buildInvokeBody("sonnet-5", "hi", { effort: "low", system: "be terse", cacheSystem: true })
    )
    // A plain string carries no place for the marker, so the shape changes rather than gains a field.
    expect(body.system).toEqual([
      { type: "text", text: "be terse", cache_control: { type: "ephemeral" } }
    ])
    // The version string is not a feature flag; cache_control rides the same one.
    expect(body.anthropic_version).toBe(ANTHROPIC_VERSION)
  })

  it("omits system entirely under cacheSystem when there is no system to cache", () => {
    // An empty cached block would be a rejected input carrying nothing worth caching.
    for (const system of [undefined, ""]) {
      const body = parse(
        buildInvokeBody("sonnet-5", "hi", { effort: "low", system, cacheSystem: true })
      )
      expect("system" in body).toBe(false)
    }
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

describe("buildInvokeBody for the openai dialect", () => {
  const inputSchema = {
    type: "object",
    properties: { groups: { type: "array" } },
    required: ["groups"],
    additionalProperties: false
  }

  it("speaks chat-completions: system message, completion budget, reasoning_effort", () => {
    const body = parse(
      buildInvokeBody("gpt-5.6-sol", "fold these", { effort: "high", system: "you judge" })
    )
    expect(body.messages).toEqual([
      { role: "system", content: "you judge" },
      { role: "user", content: "fold these" }
    ])
    expect(body.reasoning_effort).toBe("high")
    expect(body.max_completion_tokens).toBe(MAX_TOKENS_DEFAULT)
    // The anthropic-only keys must be absent: this dialect rejects unknown fields.
    expect("anthropic_version" in body).toBe(false)
    expect("max_tokens" in body).toBe(false)
    expect("output_config" in body).toBe(false)
    expect("thinking" in body).toBe(false)
    expect("system" in body).toBe(false)
  })

  it("omits the system message entirely when there is none", () => {
    const body = parse(buildInvokeBody("gpt-5.6-sol", "ask", { effort: "low" }))
    expect(body.messages).toEqual([{ role: "user", content: "ask" }])
  })

  it("asks for strict json_schema named emit when a tool is given", () => {
    const body = parse(
      buildInvokeBody(
        "gpt-5.6-sol",
        "fold these",
        { effort: "high" },
        { inputSchema, description: "emit it" }
      )
    )
    // strict: true is the whole point of this lane: constrained decoding, so the
    // double-encoded-string shape of issue #53 cannot be generated at all.
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: STRUCTURED_TOOL_NAME,
        strict: true,
        schema: { description: "emit it", ...inputSchema }
      }
    })
    expect("tools" in body).toBe(false)
    expect("tool_choice" in body).toBe(false)
  })

  it("clamps the completion budget at the same ceiling as the anthropic lane", () => {
    const body = parse(buildInvokeBody("gpt-5.6-sol", "ask", { effort: "low", maxTokens: 999_999 }))
    expect(body.max_completion_tokens).toBe(MAX_TOKENS_CEILING)
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

describe("normalizeOpenAiResponse", () => {
  const reply = (content: string | null, finish = "stop") => ({
    choices: [{ finish_reason: finish, message: { content } }],
    usage: { prompt_tokens: 68, completion_tokens: 34 }
  })

  it("presents a structured answer as the emit tool's input with mapped usage", () => {
    const parsed = normalizeOpenAiResponse(reply('{"groups":[]}'), true)
    expect(readToolInput(parsed)).toEqual({ groups: [] })
    expect(parsed.stop_reason).toBe("stop")
    expect(incompleteReason(parsed)).toBeNull()
    expect(parsed.usage).toEqual({ input_tokens: 68, output_tokens: 34 })
  })

  it("presents a prose answer as a text block", () => {
    const parsed = normalizeOpenAiResponse(reply("the answer"), false)
    expect(readText(parsed)).toBe("the answer")
    expect(readToolInput(parsed)).toBeUndefined()
  })

  it("maps length onto max_tokens and content_filter onto refusal, both incomplete", () => {
    // The severed-answer gate downstream keys on the anthropic vocabulary, so the
    // openai reasons have to land on it or a truncated answer would read as complete.
    expect(incompleteReason(normalizeOpenAiResponse(reply("x", "length"), false))).toBe(
      "max_tokens"
    )
    expect(incompleteReason(normalizeOpenAiResponse(reply("x", "content_filter"), false))).toBe(
      "refusal"
    )
  })

  it("yields NO tool block when structured content is not parseable JSON", () => {
    // Constrained decoding makes this a broken response rather than an off-schema one,
    // so it surfaces as the existing "no tool_use block" violation class downstream.
    const parsed = normalizeOpenAiResponse(reply("not json"), true)
    expect(readToolInput(parsed)).toBeUndefined()
    expect(readText(parsed)).toBe("")
  })

  it("is defensive over an empty or alien payload", () => {
    expect(readToolInput(normalizeOpenAiResponse({}, true))).toBeUndefined()
    expect(readToolInput(normalizeOpenAiResponse(null, true))).toBeUndefined()
    expect(normalizeOpenAiResponse(reply(null), true).content).toEqual([])
  })
})

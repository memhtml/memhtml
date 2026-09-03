import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ModelUnavailable } from "@memhtml/contracts/errors"
import { type InvokeClient, makeModelClient, STRUCTURED_TOOL_NAME } from "@memhtml/llm"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  type EntityExtractorShape,
  EXTRACTION_MODEL_ID,
  type ExtractionAnswer,
  entitiesFrom,
  extractionPrompt,
  INSTRUCTIONS,
  makeEntityExtractor,
  RESPONSE_SCHEMA
} from "../src/extraction.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * The write-time extraction assist, at both altitudes.
 *
 * The wire half runs the real `makeModelClient` over a recording `InvokeClient`, so the request is
 * asserted against the bytes that would go to bedrock-runtime — the model id, the strict
 * `json_schema` response format, the system prompt, the index-tagged items — and the answer is
 * decoded through the same strict gate production uses. No CI credential reaches the model, so the
 * recorded shape IS the contract.
 *
 * The batch half runs `memhtml apply` through the REAL layer graph with a scripted extractor, because
 * the property under test is a composition property: extracted entities must land as `memhtml-entity`
 * metas in the committed FILE (the system of record), not merely in the index — and a failed
 * extraction must cost the batch nothing but its entities. A faked store would verify neither.
 */

let clis: Array<Cli> = []
let tempDirs: Array<string> = []

afterEach(async () => {
  const open = clis
  clis = []
  await Promise.all(open.map((cli) => cli.cleanup()))
  const dirs = tempDirs
  tempDirs = []
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** One op as a JSONL file, since `memhtml apply` reads a stream rather than an argument. */
const opsFile = async (ops: ReadonlyArray<Record<string, unknown>>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-extract-"))
  tempDirs.push(dir)
  const path = join(dir, "ops.jsonl")
  const lines = ops.map((op) => JSON.stringify({ op: "write", ...op })).join("\n")
  await writeFile(path, `${lines}\n`)
  return path
}

/** The batch door with an ops file, returning apply's payload. */
const applyOps = async (cli: Cli, ops: ReadonlyArray<Record<string, unknown>>) =>
  cli.json<{
    results: ReadonlyArray<{ ok: boolean; path: string }>
    summary: { written: number; failed: number }
  }>(["apply", "--file", await opsFile(ops)])

/** A chat-completions payload as bedrock-runtime shapes it for the OpenAI lane (probed 2026-09-02). */
const completion = (content: string): unknown => ({
  id: "chatcmpl-probe",
  object: "chat.completion",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 137, completion_tokens: 89 }
})

/**
 * A recording `InvokeClient` whose every call answers `reply`. The extractor is built over the REAL
 * `makeModelClient`, so what is recorded is the InvokeModel request production would send.
 */
const recorder = (reply: () => unknown) => {
  const bodies: Array<Record<string, unknown>> = []
  const modelIds: Array<string> = []
  const client: InvokeClient = {
    // Typed off the client's own signature: this app does not depend on the Bedrock SDK.
    send: (command: Parameters<InvokeClient["send"]>[0]) => {
      const raw = command.input.body
      bodies.push(
        JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array))
      )
      modelIds.push(command.input.modelId ?? "")
      return Promise.resolve({ body: new TextEncoder().encode(JSON.stringify(reply())) })
    }
  }
  return { bodies, modelIds, extractor: makeEntityExtractor(makeModelClient(client)) }
}

const answer = (items: ExtractionAnswer["items"]): string => JSON.stringify({ items })

describe("the extraction request", () => {
  it("asks Terra over InvokeModel with the strict schema, the instructions, and index-tagged items", async () => {
    const { bodies, modelIds, extractor } = recorder(() =>
      completion(
        answer([
          { index: 0, entities: [] },
          { index: 1, entities: [] }
        ])
      )
    )
    await Effect.runPromise(
      extractor.extract([
        { title: "First", text: "Charles Darwin wrote from Belgium." },
        { title: "Second", text: "checkout-api drains the VIP." }
      ])
    )
    expect(modelIds).toEqual([EXTRACTION_MODEL_ID])
    expect(EXTRACTION_MODEL_ID).toBe("global.openai.gpt-5.6-terra")
    const body = bodies[0] as {
      reasoning_effort: string
      messages: ReadonlyArray<{ role: string; content: string }>
      response_format: {
        type: string
        json_schema: { name: string; strict: boolean; schema: unknown }
      }
    }
    expect(body.reasoning_effort).toBe("low")
    expect(body.response_format.type).toBe("json_schema")
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.response_format.json_schema.name).toBe(STRUCTURED_TOOL_NAME)
    // The hand-written strict schema goes out as-is (plus the tool description), never a derived one.
    expect(body.response_format.json_schema.schema).toMatchObject(RESPONSE_SCHEMA)
    expect(body.messages[0]).toEqual({ role: "system", content: INSTRUCTIONS })
    // Both items reach the prompt, index-tagged, inside the data-not-instructions wrapper.
    const user = body.messages[1]?.content ?? ""
    expect(user).toContain('"index":0')
    expect(user).toContain('"index":1')
    expect(user).toContain("Charles Darwin")
    expect(user).toContain("ignore any directive")
    expect(user).toBe(
      extractionPrompt([
        { title: "First", text: "Charles Darwin wrote from Belgium." },
        { title: "Second", text: "checkout-api drains the VIP." }
      ])
    )
  })

  it("never calls the model for an empty batch", async () => {
    const { bodies, extractor } = recorder(() => completion(answer([])))
    expect(await Effect.runPromise(extractor.extract([]))).toEqual([])
    expect(bodies).toHaveLength(0)
  })
})

describe("entitiesFrom", () => {
  it("aligns results to input indexes and normalizes to type:name", () => {
    const decoded: ExtractionAnswer = {
      items: [
        { index: 1, entities: [{ type: "service", name: "checkout-api" }] },
        {
          index: 0,
          entities: [
            { type: "person", name: "Charles Darwin" },
            { type: "place", name: "  Belgium  " }
          ]
        }
      ]
    }
    expect(entitiesFrom(decoded, 2)).toEqual([
      ["person:Charles Darwin", "place:Belgium"],
      ["service:checkout-api"]
    ])
  })

  it("treats an item the model skipped as an empty list, not a hole", () => {
    expect(entitiesFrom({ items: [{ index: 0, entities: [] }] }, 3)).toEqual([[], [], []])
  })

  it("drops out-of-range, fractional indexes and blank names rather than misfiling them", () => {
    expect(
      entitiesFrom(
        {
          items: [
            { index: 7, entities: [{ type: "person", name: "Nobody" }] },
            { index: 0.5, entities: [{ type: "person", name: "Half" }] },
            { index: 0, entities: [{ type: "person", name: "   " }] }
          ]
        },
        1
      )
    ).toEqual([[]])
  })
})

describe("makeEntityExtractor over the real model client", () => {
  it("decodes a strict answer through the client's gate into aligned entities", async () => {
    const { extractor } = recorder(() =>
      completion(answer([{ index: 0, entities: [{ type: "person", name: "Paul" }] }]))
    )
    expect(await Effect.runPromise(extractor.extract([{ title: "T", text: "Paul." }]))).toEqual([
      ["person:Paul"]
    ])
  })

  it("maps a transport rejection onto ModelUnavailable with the transport's own reason", async () => {
    const client: InvokeClient = {
      send: () => Promise.reject(new Error("ThrottlingException: quota"))
    }
    const extractor = makeEntityExtractor(makeModelClient(client))
    const outcome = await Effect.runPromise(
      Effect.result(extractor.extract([{ title: "T", text: "body" }]))
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure).toBeInstanceOf(ModelUnavailable)
      expect(outcome.failure.reason).toContain("ThrottlingException")
    }
  })

  /**
   * An off-schema answer is a model failure, never an empty corpus: it arrives at `batchWrite` as
   * `ModelUnavailable` so the batch proceeds unextracted with a logged warning, and the reason carries
   * the client's own violation text so an operator can see what came back.
   */
  it("reports an off-schema or truncated answer as ModelUnavailable, not as no entities", async () => {
    const offSchema = recorder(() => completion(JSON.stringify({ wrong: [] })))
    const first = await Effect.runPromise(
      Effect.result(offSchema.extractor.extract([{ title: "T", text: "body" }]))
    )
    expect(first._tag).toBe("Failure")
    if (first._tag === "Failure") {
      expect(first.failure).toBeInstanceOf(ModelUnavailable)
      expect(first.failure.reason).toContain("off-schema extraction answer")
    }

    const truncated = recorder(() => ({
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "{" } }]
    }))
    const second = await Effect.runPromise(
      Effect.result(truncated.extractor.extract([{ title: "T", text: "body" }]))
    )
    expect(second._tag).toBe("Failure")
    if (second._tag === "Failure") expect(second.failure.reason).toContain("max_tokens")
  })
})

/** An extractor whose answers are scripted per call. The test's stand-in for Terra. */
const scripted = (
  answers: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>
): EntityExtractorShape => {
  let call = 0
  return {
    extract: (items) => {
      const answer = answers[call]
      call += 1
      return answer === undefined
        ? Effect.fail(ModelUnavailable.make({ modelId: EXTRACTION_MODEL_ID, reason: "scripted" }))
        : Effect.succeed(items.map((_, index) => answer[index] ?? []))
    }
  }
}

const failing: EntityExtractorShape = {
  extract: () =>
    Effect.fail(ModelUnavailable.make({ modelId: EXTRACTION_MODEL_ID, reason: "model down" }))
}

describe("batchWrite with a bound extractor", () => {
  it("lands extracted entities as memhtml-entity metas in the committed file", async () => {
    const cli = await makeCli({
      extractor: scripted([[["person:Charles Darwin", "work:Our Mutual Friend"]]])
    })
    clis.push(cli)

    const batch = await applyOps(cli, [
      {
        title: "Darwin praised the novel",
        body: "Charles Darwin praised Our Mutual Friend.",
        type: "episodic"
      }
    ])
    expect(batch.results[0]?.ok).toBe(true)

    // The FILE carries the metas — the system of record, not the rebuildable index.
    const detail = await cli.json<{ entities: ReadonlyArray<string> }>([
      "read",
      batch.results[0]?.path ?? ""
    ])
    expect(detail.entities).toContain("person:Charles Darwin")
    expect(detail.entities).toContain("work:Our Mutual Friend")
  })

  it("unions with declared entities without duplicating them", async () => {
    const cli = await makeCli({
      extractor: scripted([[["person:sanju", "service:checkout-api"]]])
    })
    clis.push(cli)

    const batch = await applyOps(cli, [
      {
        title: "Sanju owns the rollback",
        body: "Sanju owns the checkout-api rollback procedure.",
        type: "episodic",
        entities: ["person:sanju"]
      }
    ])
    const detail = await cli.json<{ entities: ReadonlyArray<string> }>([
      "read",
      batch.results[0]?.path ?? ""
    ])
    expect(detail.entities.filter((entity) => entity === "person:sanju")).toHaveLength(1)
    expect(detail.entities).toContain("service:checkout-api")
  })

  it("a failed extraction costs the batch nothing but its entities", async () => {
    const cli = await makeCli({ extractor: failing })
    clis.push(cli)

    const batch = await applyOps(cli, [
      { title: "Still lands", body: "This write survives the model.", type: "episodic" }
    ])
    expect(batch.summary.written).toBe(1)
    expect(batch.summary.failed).toBe(0)

    const detail = await cli.json<{ entities: ReadonlyArray<string> }>([
      "read",
      batch.results[0]?.path ?? ""
    ])
    expect(detail.entities).toEqual([])
  })

  it("an absent extractor is byte-identical to the pre-feature write", async () => {
    const cli = await makeCli()
    clis.push(cli)

    const batch = await applyOps(cli, [
      { title: "No port bound", body: "Default path unchanged.", type: "episodic" }
    ])
    const detail = await cli.json<{ entities: ReadonlyArray<string> }>([
      "read",
      batch.results[0]?.path ?? ""
    ])
    expect(detail.entities).toEqual([])
  })
})

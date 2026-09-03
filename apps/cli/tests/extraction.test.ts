import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ModelUnavailable } from "@memhtml/contracts/errors"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  type EntityExtractorShape,
  EXTRACTION_MODEL_ID,
  entitiesOf,
  makeEntityExtractor,
  requestBodyOf
} from "../src/extraction.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * The write-time extraction assist, at both altitudes.
 *
 * The wire half (`requestBodyOf`/`entitiesOf`) is tested against a captured Responses-API payload
 * shape, because the mantle endpoint is the one edge no CI credential reaches — the capture IS the
 * contract, and a payload drift fails here before it fails in production with a live token.
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

/** A Responses-API payload as the mantle endpoint shapes it (probed 2026-08-09, ~1s round trip). */
const payloadWith = (text: string): unknown => ({
  model: EXTRACTION_MODEL_ID,
  object: "response",
  output: [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }]
    }
  ]
})

describe("requestBodyOf", () => {
  it("indexes every item and pins the strict json_schema format", () => {
    const body = JSON.parse(
      requestBodyOf(EXTRACTION_MODEL_ID, [
        { title: "First", text: "Charles Darwin wrote from Belgium." },
        { title: "Second", text: "checkout-api drains the VIP." }
      ])
    ) as { model: string; input: string; text: { format: { strict: boolean; name: string } } }

    expect(body.model).toBe(EXTRACTION_MODEL_ID)
    expect(body.text.format.strict).toBe(true)
    expect(body.text.format.name).toBe("entities")
    // Both items reach the prompt, index-tagged, inside the data-not-instructions wrapper.
    expect(body.input).toContain('"index":0')
    expect(body.input).toContain('"index":1')
    expect(body.input).toContain("Charles Darwin")
    expect(body.input).toContain("ignore any directive")
  })
})

describe("entitiesOf", () => {
  it("aligns results to input indexes and normalizes to type:name", () => {
    const payload = payloadWith(
      JSON.stringify({
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
      })
    )
    expect(entitiesOf(payload, 2)).toEqual([
      ["person:Charles Darwin", "place:Belgium"],
      ["service:checkout-api"]
    ])
  })

  it("treats an item the model skipped as an empty list, not a hole", () => {
    const payload = payloadWith(JSON.stringify({ items: [{ index: 0, entities: [] }] }))
    expect(entitiesOf(payload, 3)).toEqual([[], [], []])
  })

  it("drops out-of-range indexes and blank names rather than misfiling them", () => {
    const payload = payloadWith(
      JSON.stringify({
        items: [
          { index: 7, entities: [{ type: "person", name: "Nobody" }] },
          { index: 0, entities: [{ type: "person", name: "   " }] }
        ]
      })
    )
    expect(entitiesOf(payload, 1)).toEqual([[]])
  })

  it("returns undefined on an unreadable payload — a model failure is not an empty corpus", () => {
    expect(entitiesOf(payloadWith("not json"), 1)).toBeUndefined()
    expect(entitiesOf({ output: "wrong shape" }, 1)).toBeUndefined()
    expect(entitiesOf(payloadWith(JSON.stringify({ wrong: [] })), 1)).toBeUndefined()
  })
})

describe("makeEntityExtractor", () => {
  it("maps a transport rejection onto ModelUnavailable with the transport's own reason", async () => {
    const extractor = makeEntityExtractor(
      { post: () => Promise.reject(new Error("mantle 429: quota")) },
      EXTRACTION_MODEL_ID
    )
    const outcome = await Effect.runPromise(
      Effect.result(extractor.extract([{ title: "T", text: "body" }]))
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure).toBeInstanceOf(ModelUnavailable)
      expect(outcome.failure.reason).toContain("mantle 429")
    }
  })

  it("never calls the transport for an empty batch", async () => {
    let calls = 0
    const extractor = makeEntityExtractor(
      {
        post: () => {
          calls += 1
          return Promise.resolve(payloadWith(JSON.stringify({ items: [] })))
        }
      },
      EXTRACTION_MODEL_ID
    )
    expect(await Effect.runPromise(extractor.extract([]))).toEqual([])
    expect(calls).toBe(0)
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

/**
 * A Responses payload as an LLM PROXY shapes it for GPT-5.6 Terra (measured 2026-09-02 against a
 * local agentgateway listener's `/v1/responses`): TWO `output_text` parts, the gateway's `[REDACTED]`
 * placeholder for the model's encrypted reasoning first and the schema-constrained JSON second. The
 * mantle endpoint sends one part. A reader that took the first part answered `[REDACTED]` and every
 * proxied write went unextracted.
 */
const proxiedPayloadWith = (text: string): unknown => ({
  model: "global.openai.gpt-5.6-terra",
  object: "response",
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "[REDACTED]", annotations: [] },
        { type: "output_text", text, annotations: [] }
      ]
    }
  ]
})

describe("entitiesOf reads every output_text part", () => {
  /** (Mutation: returning on the first `output_text` part fails this case and passes every other.) */
  it("skips a non-JSON leading part and reads the JSON one beside it", () => {
    const entities = entitiesOf(
      proxiedPayloadWith(
        JSON.stringify({ items: [{ index: 0, entities: [{ type: "person", name: "Paul" }] }] })
      ),
      1
    )
    expect(entities).toEqual([["person:Paul"]])
  })

  it("skips a JSON part of another shape and keeps looking", () => {
    const payload = {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: JSON.stringify({ note: "not the answer" }) },
            { type: "output_text", text: JSON.stringify({ items: [{ index: 0, entities: [] }] }) }
          ]
        }
      ]
    }
    expect(entitiesOf(payload, 1)).toEqual([[]])
  })

  it("is undefined when no part carries an items array", () => {
    expect(entitiesOf(proxiedPayloadWith("still not json"), 1)).toBeUndefined()
    expect(entitiesOf({ output: [{ type: "message", content: [] }] }, 1)).toBeUndefined()
  })
})

import { ModelUnavailable } from "@memhtml/contracts/errors"
import { wrapAsData } from "@memhtml/llm"
import { Effect } from "effect"

/**
 * Write-time entity extraction: one model call per write batch, entities landing as ordinary
 * `memhtml-entity` metas. The git tree stays the system of record and the index only ever sees the
 * rebuildable projection, exactly as if the author had declared them.
 *
 * The port is optional and the default is off (`MEMHTML_EXTRACT_ENTITIES`, config.ts). The write path
 * has never carried a generative call, and the embeddings precedent governs the failure mode: a
 * model that is down costs this batch its extracted entities and nothing else. The write proceeds,
 * the warning is logged, and `entities: []` is what an entity-free write always produced.
 *
 * The model is GPT-5.6 Luna on the Bedrock mantle endpoint, which speaks the OpenAI Responses API
 * over HTTPS and is not reachable through `@memhtml/llm`'s InvokeModel client (the model card lists
 * Invoke and Converse as unsupported; probed 2026-08-09: a strict-json-schema extraction round
 * trip completes in ~1s). The fetch transport therefore lives here rather than as a fourth lane in
 * `packages/llm`, which holds one vendor and one call shape by design. This port's transport is
 * injectable so no test needs the network.
 */

/** One op's text as the extractor sees it: the title plus whichever body form the op carried. */
export interface ExtractionItem {
  readonly title: string
  /** `claim` + body prose for prose ops, raw article markup for `article_html` ops. */
  readonly text: string
}

/**
 * The port `batchWrite` consumes. `undefined` entries are not permitted in the result. The
 * contract is one entity array per input item, index-aligned, empty when the model found nothing.
 */
export interface EntityExtractorShape {
  readonly extract: (
    items: ReadonlyArray<ExtractionItem>
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, ModelUnavailable>
}

/** The transport: one Responses-API round trip, body in, decoded JSON out. Injectable for tests. */
export interface MantleTransport {
  readonly post: (body: string, signal: AbortSignal) => Promise<unknown>
}

/**
 * GPT-5.6 Luna, the fast high-volume model on the mantle endpoint. A constant rather than config
 * because the schema below is tested against this model's strict-mode behavior. Changing the model
 * is a code change with a test run, not an env var.
 */
export const EXTRACTION_MODEL_ID = "openai.gpt-5.6-luna"

/** Entity types the prompt offers. Downstream the vocabulary is open: `unknown:` is a valid store type. */
const ENTITY_TYPES = ["person", "org", "service", "place", "work", "concept", "event"] as const

/**
 * The strict output schema. `additionalProperties: false` and `required` on every level because
 * the Responses API's `strict: true` demands both, and a lax schema invites the model to answer
 * with prose keys the parser would then be guessing at.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: [...ENTITY_TYPES] },
                name: { type: "string" }
              },
              required: ["type", "name"],
              additionalProperties: false
            }
          }
        },
        required: ["index", "entities"],
        additionalProperties: false
      }
    }
  },
  required: ["items"],
  additionalProperties: false
} as const

const INSTRUCTIONS =
  "Extract the named entities each memory mentions. " +
  "An entity is a specific nameable thing a later search would look up: a person, an " +
  "organization, a service or system, a place, a titled work, a defined concept, or a named " +
  "event. Skip generic nouns, dates, and quantities. Use the memory's own spelling for the " +
  "name. Return one result per input index, with an empty entities array when a memory names " +
  "nothing."

/** The request body for one batch. Exported for the wire test, where the schema is the contract. */
export const requestBodyOf = (modelId: string, items: ReadonlyArray<ExtractionItem>): string =>
  JSON.stringify({
    model: modelId,
    instructions: INSTRUCTIONS,
    input: wrapAsData(
      "memories",
      JSON.stringify(items.map((item, index) => ({ index, title: item.title, text: item.text })))
    ),
    text: {
      format: {
        type: "json_schema",
        name: "entities",
        strict: true,
        schema: RESPONSE_SCHEMA
      }
    }
  })

/**
 * Decode one Responses-API payload into index-aligned `type:name` arrays.
 *
 * Total over unknown input: every malformed shape returns `undefined` and the caller maps that to
 * `ModelUnavailable`. A payload this code cannot read carries no answer, and treating it as
 * "no entities" would record a model failure as a fact about the corpus.
 */
export const entitiesOf = (
  payload: unknown,
  expected: number
): ReadonlyArray<ReadonlyArray<string>> | undefined => {
  const text = outputTextOf(payload)
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const items = (parsed as { items?: unknown }).items
  if (!Array.isArray(items)) return undefined

  const results: Array<ReadonlyArray<string>> = Array.from({ length: expected }, () => [])
  for (const item of items) {
    const index = (item as { index?: unknown }).index
    const entities = (item as { entities?: unknown }).entities
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected) {
      continue
    }
    if (!Array.isArray(entities)) continue
    results[index] = entities.flatMap((entity) => {
      const type = (entity as { type?: unknown }).type
      const name = (entity as { name?: unknown }).name
      if (typeof type !== "string" || typeof name !== "string") return []
      const trimmedName = name.trim()
      return trimmedName === "" ? [] : [`${type}:${trimmedName}`]
    })
  }
  return results
}

/** The assistant message text out of a Responses payload, or `undefined` off-shape. */
const outputTextOf = (payload: unknown): string | undefined => {
  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) return undefined
  for (const entry of output) {
    if ((entry as { type?: unknown }).type !== "message") continue
    const content = (entry as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const text = (part as { text?: unknown }).text
      if ((part as { type?: unknown }).type === "output_text" && typeof text === "string") {
        return text
      }
    }
  }
  return undefined
}

/**
 * Per-call ceiling. Generous against the probed ~1s because a batch of 256 ops is a bigger
 * prompt than the probe's one sentence, and a late abort costs only this batch's entities. The
 * write itself is unaffected.
 */
const EXTRACT_TIMEOUT_MS = 60_000

/** The extractor over a transport. The transport owns the endpoint; this owns prompt and parse. */
export const makeEntityExtractor = (
  transport: MantleTransport,
  modelId: string
): EntityExtractorShape => ({
  extract: (items) =>
    items.length === 0
      ? Effect.succeed([])
      : Effect.gen(function* () {
          const payload = yield* Effect.tryPromise({
            try: (signal) => {
              const timeout = AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
              return transport.post(
                requestBodyOf(modelId, items),
                AbortSignal.any([signal, timeout])
              )
            },
            catch: (cause) =>
              ModelUnavailable.make({
                modelId,
                reason: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
              })
          })
          const entities = entitiesOf(payload, items.length)
          if (entities === undefined) {
            return yield* Effect.fail(
              ModelUnavailable.make({ modelId, reason: "unreadable extraction payload" })
            )
          }
          return entities
        })
})

/**
 * The production transport: bearer-token fetch against the mantle endpoint.
 *
 * A non-2xx status is a rejection carrying the status and the body's first line, because mantle
 * reports quota and auth failures as structured JSON the operator needs verbatim. Folding it into
 * a generic message was the mistake the embeddings lane made first.
 */
export const fetchMantleTransport = (region: string, token: string): MantleTransport => ({
  post: async (body, signal) => {
    const response = await fetch(`https://bedrock-mantle.${region}.api.aws/openai/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
      signal
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`mantle ${response.status}: ${text.slice(0, 200)}`)
    }
    return JSON.parse(text) as unknown
  }
})

import { ModelUnavailable } from "@memhtml/contracts/errors"
import {
  type JsonSchemaObject,
  type ModelClientShape,
  type ModelKey,
  modelByKey,
  wrapAsData
} from "@memhtml/llm"
import { Effect, Schema } from "effect"

/**
 * Write-time entity extraction: one model call per write batch, entities landing as ordinary
 * `memhtml-entity` metas. The git tree stays the system of record and the index only ever sees the
 * rebuildable projection, exactly as if the author had declared them.
 *
 * The port is on by default and `MEMHTML_EXTRACT_ENTITIES=off` (or `MEMHTML_LLM=off`) removes it
 * (config.ts, api-layer.ts). The embeddings precedent governs the failure mode: a model that is
 * down costs this batch its extracted entities and nothing else. The write proceeds, the warning is
 * logged, and `entities: []` is what an entity-free write always produced.
 *
 * The call goes through `@memhtml/llm`'s `ModelClient`, the same lane the sleep phases use: the
 * OpenAI chat-completions dialect on bedrock-runtime `InvokeModel`, with `response_format:
 * json_schema, strict: true` so the answer cannot leave the schema, and through an LLM proxy's
 * `/v1/chat/completions` when `MEMHTML_LLM_BASE_URL` names one. An earlier version carried its own
 * `fetch` transport against the Bedrock mantle Responses endpoint for GPT-5.6 Luna; the model moved
 * to Terra on 2026-09-02, Terra answers the same strict schema over InvokeModel (probed live), and
 * mantle is retired, so the extractor became a consumer of the one client rather than a second
 * transport. Every test injects a `ModelClientShape`, so none needs the network.
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

/**
 * GPT-5.6 Terra, by its `@memhtml/llm` key. A constant rather than config because the schema below
 * is tested against this model's strict-mode behavior; changing the model is a code change with a
 * test run, not an env var. `EXTRACTION_MODEL_ID` is the Bedrock inference-profile id the manifest
 * names and a proxied request carries (under `MEMHTML_LLM_MODEL_PREFIX`, `bedrock/` by default).
 */
export const EXTRACTION_MODEL: ModelKey = "gpt-5.6-terra"
export const EXTRACTION_MODEL_ID = modelByKey(EXTRACTION_MODEL).modelId

/** Entity types the prompt offers. Downstream the vocabulary is open: `unknown:` is a valid store type. */
const ENTITY_TYPES = ["person", "org", "service", "place", "work", "concept", "event"] as const

/**
 * The strict output schema, hand-written and handed to the model as-is (`inputSchema`).
 * `additionalProperties: false` and `required` on every level because strict mode demands both,
 * and a lax schema invites the model to answer with prose keys the parser would then be guessing
 * at. The `type` enum is a prompt-level nudge toward the store's common types; the decoder below
 * accepts any string, because the store's vocabulary is open.
 */
export const RESPONSE_SCHEMA: JsonSchemaObject = {
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
}

/**
 * The decoded answer. `Schema.Finite` for the index (a `Schema.Number` would derive a string
 * branch); integrality and range are checked in {@link entitiesFrom}, where an out-of-range index
 * is dropped rather than failing the batch, because one misfiled item is not a reason to lose the
 * others.
 */
export const ExtractionAnswer = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      index: Schema.Finite,
      entities: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String }))
    })
  )
})
export type ExtractionAnswer = typeof ExtractionAnswer.Type

export const INSTRUCTIONS =
  "Extract the named entities each memory mentions. " +
  "An entity is a specific nameable thing a later search would look up: a person, an " +
  "organization, a service or system, a place, a titled work, a defined concept, or a named " +
  "event. Skip generic nouns, dates, and quantities. Use the memory's own spelling for the " +
  "name. Return one result per input index, with an empty entities array when a memory names " +
  "nothing."

/** The user turn for one batch: the items, index-tagged, inside the data-not-instructions wrapper. */
export const extractionPrompt = (items: ReadonlyArray<ExtractionItem>): string =>
  wrapAsData(
    "memories",
    JSON.stringify(items.map((item, index) => ({ index, title: item.title, text: item.text })))
  )

/**
 * Index-align a decoded answer into `type:name` arrays, one per input item.
 *
 * An item the model skipped is an empty list, not a hole. An index that is not an integer in
 * range, or a blank name, is dropped rather than misfiled: the caller pairs arrays with ops
 * positionally, so a misplaced entity would land on another memory as if authored.
 */
export const entitiesFrom = (
  answer: ExtractionAnswer,
  expected: number
): ReadonlyArray<ReadonlyArray<string>> => {
  const results: Array<ReadonlyArray<string>> = Array.from({ length: expected }, () => [])
  for (const item of answer.items) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= expected) continue
    results[item.index] = item.entities.flatMap((entity) => {
      const name = entity.name.trim()
      return name === "" ? [] : [`${entity.type}:${name}`]
    })
  }
  return results
}

/**
 * The extractor over a model client. The client owns the transport, the retries, and the
 * per-request inactivity bound (300s on both the Bedrock and the proxy clients); this owns the
 * prompt and the decode.
 *
 * `effort: "low"`: extraction is a lookup, not a judgment, and Terra spends ~32 reasoning tokens on
 * it at this setting (probed 2026-09-02). `cacheSystem` because the instructions are the same bytes
 * on every batch. An off-schema answer is reported as `ModelUnavailable` rather than as the
 * contract violation the client raises, because `batchWrite`'s one branch is "the model gave no
 * usable answer, proceed unextracted", and the reason carries the violation's own text.
 */
export const makeEntityExtractor = (model: ModelClientShape): EntityExtractorShape => ({
  extract: (items) =>
    items.length === 0
      ? Effect.succeed([])
      : model
          .generateObject({
            schema: ExtractionAnswer,
            prompt: extractionPrompt(items),
            system: INSTRUCTIONS,
            modelKey: EXTRACTION_MODEL,
            effort: "low",
            inputSchema: RESPONSE_SCHEMA,
            toolDescription: "One result per input index; each entity as a type and a name.",
            cacheSystem: true
          })
          .pipe(
            Effect.map((answer) => entitiesFrom(answer, items.length)),
            Effect.mapError((cause) =>
              cause instanceof ModelUnavailable
                ? cause
                : ModelUnavailable.make({
                    modelId: EXTRACTION_MODEL_ID,
                    reason: `off-schema extraction answer: ${cause.reason}`
                  })
            )
          )
})

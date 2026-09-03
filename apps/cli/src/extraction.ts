import { ModelUnavailable } from "@memhtml/contracts/errors"
import { type ProxyConfig, proxyModelId, wrapAsData } from "@memhtml/llm"
import { Effect } from "effect"

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
 * The model is GPT-5.6 Terra, spoken to over the OpenAI Responses API: on the Bedrock mantle
 * endpoint directly, or on an LLM proxy's `/v1/responses` when `MEMHTML_LLM_BASE_URL` names one.
 * Neither is reachable through `@memhtml/llm`'s InvokeModel client (the GPT-5.6 model cards list
 * Invoke and Converse as unsupported for the Responses shape), so the fetch transport lives here
 * rather than as a fourth lane in `packages/llm`, which holds one vendor and one call shape by
 * design. This port's transport is injectable so no test needs the network.
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
 * GPT-5.6 Terra, the mid-tier GPT-5.6 on the mantle endpoint (Luna, the smaller one, stood here
 * until 2026-09-02). A constant rather than config because the schema below is tested against this
 * model's strict-mode behavior — probed live 2026-09-02 on both transports: the mantle endpoint
 * answered the strict `json_schema` request with one `output_text` part, and an LLM proxy's
 * `/v1/responses` answered with two, a redacted-reasoning placeholder and then the JSON, which is
 * why {@link entitiesOf} scans every part rather than reading the first. Changing the model is a
 * code change with a test run, not an env var; through a proxy the name it travels under is
 * `bedrock/` plus this id (`MEMHTML_LLM_MODEL_PREFIX`), or whatever `MEMHTML_LLM_MODEL_MAP` says.
 */
export const EXTRACTION_MODEL_ID = "openai.gpt-5.6-terra"

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
  const items = itemsOf(payload)
  if (items === undefined) return undefined

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

/**
 * The `items` array out of a Responses payload, or `undefined` when no part carries one.
 *
 * Every `output_text` part of every message is tried, in order, and the first that parses to an
 * object with an `items` array wins. Reading only the FIRST part is what an earlier version did,
 * and it is wrong on a proxied transport: measured 2026-09-02 against an LLM proxy's
 * `/v1/responses`, GPT-5.6 Terra's answer arrived as two `output_text` parts, `[REDACTED]` (the
 * gateway's placeholder for the model's encrypted reasoning) and then the schema-constrained JSON.
 * The mantle endpoint sends one part, so scanning costs it nothing.
 *
 * A part that is not JSON, or is JSON of another shape, is skipped rather than fatal, for the same
 * reason: it is not the answer, and the answer may still be beside it. Only when no part qualifies
 * is the payload unreadable.
 */
const itemsOf = (payload: unknown): ReadonlyArray<unknown> | undefined => {
  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) return undefined
  for (const entry of output) {
    if ((entry as { type?: unknown }).type !== "message") continue
    const content = (entry as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const text = (part as { text?: unknown }).text
      if ((part as { type?: unknown }).type !== "output_text" || typeof text !== "string") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      const items = (parsed as { items?: unknown } | null)?.items
      if (Array.isArray(items)) return items
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
 * One Responses-API endpoint over `fetch`, the shape both production transports share.
 *
 * A non-2xx status is a rejection carrying the status and the body's first 200 characters, because
 * both endpoints report quota, auth, and routing failures as structured JSON the operator needs
 * verbatim. Folding it into a generic message was the mistake the embeddings lane made first.
 */
const jsonPostTransport = (
  label: string,
  url: string,
  headers: Record<string, string>
): MantleTransport => ({
  post: async (body, signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      signal
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${text.slice(0, 200)}`)
    }
    return JSON.parse(text) as unknown
  }
})

/** The production transport: bearer-token fetch against the Bedrock mantle endpoint. */
export const fetchMantleTransport = (region: string, token: string): MantleTransport =>
  jsonPostTransport("mantle", `https://bedrock-mantle.${region}.api.aws/openai/v1/responses`, {
    Authorization: `Bearer ${token}`
  })

/**
 * The same Responses API on an LLM proxy's `/v1/responses` route, when `MEMHTML_LLM_BASE_URL` names
 * one (`packages/llm/src/proxy-config.ts`). The proxy's key is optional, so the header is only sent
 * when there is one. The model id the request carries is resolved by the caller through
 * {@link proxiedExtractionModelId}, because a proxy names models on its own terms.
 */
export const fetchProxyTransport = (proxy: ProxyConfig): MantleTransport =>
  jsonPostTransport(
    "llm proxy",
    `${proxy.baseUrl}/v1/responses`,
    proxy.apiKey === null ? {} : { Authorization: `Bearer ${proxy.apiKey}` }
  )

/** {@link EXTRACTION_MODEL_ID} as the proxy wants it named, or unchanged when the map is silent. */
export const proxiedExtractionModelId = (proxy: ProxyConfig): string =>
  proxyModelId(proxy, EXTRACTION_MODEL_ID)

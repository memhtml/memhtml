import { LlmContractViolation } from "@memhtml/contracts/errors"
import { Effect, Result, Schema } from "effect"

import type { JsonSchemaObject } from "./wire.js"

/**
 * The bridge from an effect `Schema` to a forced-tool `input_schema`, and back from the
 * tool's `input` to a decoded value.
 *
 * Every path out of here returns either a value that satisfies the schema or a typed
 * violation. There is no lenient decode, no supplied default for an omitted field, and
 * no accepted extra key. Downstream code cannot tell a
 * coerced object from a real one, and the phases that consume these objects archive and
 * rewrite files.
 *
 * ONE repair is the exception, because it recovers the payload the model meant rather than
 * inventing one: a top-level field the schema declares as an array or object sometimes
 * arrives double-encoded as a JSON STRING. That string is parsed once and the SAME strict
 * decode re-runs on the result, so nothing an off-schema answer carries can slip through —
 * a payload the repair cannot make satisfy the schema still fails with the original
 * violation. See {@link decodeToolInput}.
 */

/** Cap on the raw payload carried on a violation, so a runaway response cannot bloat it. */
export const MAX_RAW = 800

/**
 * Derive the tool's `input_schema` from an effect schema.
 *
 * `Schema.toJsonSchemaDocument` hoists nested structs into a separate `definitions` map and
 * leaves `$ref: "#/$defs/<name>"` behind, so the definitions are folded back under the root
 * as `$defs`, the pointer the refs already name. Verified live 2026-08-02 that Bedrock
 * resolves a `$ref` into a root-level `$defs` inside `input_schema`.
 *
 * A numeric field should be declared `Schema.Finite`, not `Schema.Number`: the latter emits
 * an `anyOf` with a string branch for `Infinity`/`NaN`, which invites the model to answer a
 * number field with the string `"NaN"`.
 */
export const toInputSchema = (schema: Schema.Top): JsonSchemaObject => {
  const document = Schema.toJsonSchemaDocument(schema)
  const definitions = document.definitions
  return Object.keys(definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: definitions }
}

/** Truncate a payload for a violation message, marking that it was cut. */
const preview = (payload: unknown): string => {
  const rendered = (() => {
    try {
      return JSON.stringify(payload) ?? String(payload)
    } catch {
      return String(payload)
    }
  })()
  return rendered.length <= MAX_RAW ? rendered : `${rendered.slice(0, MAX_RAW)}…`
}

/** True when a property's derived JSON schema declares a container: an array, an object, or a
 * `$ref` (every hoisted definition is a struct). A string-typed property is NOT a container,
 * which is what keeps a field that legitimately holds JSON-looking text out of the repair. */
const expectsContainer = (property: unknown): boolean => {
  if (typeof property !== "object" || property === null) return false
  const record = property as Record<string, unknown>
  return typeof record.$ref === "string" || record.type === "array" || record.type === "object"
}

/**
 * Undo ONE level of JSON-string double-encoding on the top-level fields of a tool payload.
 *
 * The shape this repairs was observed on the wire: a field the schema declares as an array
 * arrives as `"{\"groups\":[…]}"` — the whole answer serialized as a string under its own
 * key — or as the array itself serialized. So a string sitting where the derived
 * `input_schema` declares a container is parsed once; when the parsed value is an object
 * carrying the SAME key, the value at that key is taken, otherwise the parsed value stands.
 *
 * Returns `undefined` when there is nothing to repair: no field qualified, or no parse
 * succeeded. The caller then reports the ORIGINAL violation, and a repaired payload still
 * re-runs the same strict decode, so this never widens what the schema accepts.
 */
const unwrapDoubleEncoded = (schema: Schema.Top, input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const properties = (toInputSchema(schema) as { properties?: Record<string, unknown> }).properties
  if (properties === undefined) return undefined
  let repairedAField = false
  const repaired: Record<string, unknown> = {}
  for (const [key, received] of Object.entries(input)) {
    repaired[key] = received
    if (typeof received !== "string" || !expectsContainer(properties[key])) continue
    const parsed = (() => {
      try {
        return { value: JSON.parse(received) as unknown }
      } catch {
        return undefined
      }
    })()
    if (parsed === undefined) continue
    const wrapper =
      typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
        ? (parsed.value as Record<string, unknown>)
        : undefined
    repaired[key] = wrapper !== undefined && key in wrapper ? wrapper[key] : parsed.value
    repairedAField = true
  }
  return repairedAField ? repaired : undefined
}

/**
 * Decode a forced-tool payload against its schema.
 *
 * `onExcessProperty: "error"` is the option this decode depends on. The default, `"ignore"`,
 * strips an undeclared key and SUCCEEDS (verified against effect 4.0.0-beta.102), which
 * would let a model answer a schema next to the one it was given and have the extra field
 * vanish.
 *
 * One failure shape is repaired before the violation is constructed: a top-level container
 * field double-encoded as a JSON string ({@link unwrapDoubleEncoded}). The repaired payload
 * goes through the SAME strict decode, and a repair that still does not satisfy the schema
 * reports the original payload's violation, so the repair cannot mask a genuinely off-schema
 * answer.
 *
 * `undefined` input means the model produced no `emit` call at all. That is the same class
 * of failure as a malformed one, and the reason text names it so a caller can tell the two
 * apart in a log without a second error type.
 */
export const decodeToolInput = <A, I>(
  schema: Schema.Codec<A, I>,
  input: unknown
): Effect.Effect<A, LlmContractViolation> =>
  input === undefined
    ? Effect.fail(
        LlmContractViolation.make({
          reason: "model returned no tool_use block for the forced tool"
        })
      )
    : Effect.gen(function* () {
        const strictDecode = Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })
        const decoded = yield* Effect.result(strictDecode(input))
        if (Result.isSuccess(decoded)) return decoded.success
        const repaired = unwrapDoubleEncoded(schema, input)
        if (repaired !== undefined) {
          const redecoded = yield* Effect.result(strictDecode(repaired))
          if (Result.isSuccess(redecoded)) {
            yield* Effect.logWarning(
              "llm.structured repaired a double-encoded tool field before decoding"
            )
            return redecoded.success
          }
        }
        return yield* Effect.fail(
          LlmContractViolation.make({
            reason: `tool payload does not satisfy its schema: ${String(decoded.failure)} (raw: ${preview(input)})`
          })
        )
      })

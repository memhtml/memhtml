import { LlmContractViolation } from "@memhtml/contracts/errors"
import { Effect, Result, Schema } from "effect"

import type { JsonSchemaObject } from "./wire.js"

/**
 * The bridge from an effect `Schema` to a forced-tool `input_schema`, and back from the
 * tool's `input` to a decoded value.
 *
 * The posture is croq's judge, one layer down: every path out of here is either a value
 * that satisfies the schema or a typed violation. There is no lenient decode, no supplied
 * default for an omitted field, and no accepted extra key — a coerced object is
 * indistinguishable from a real one downstream, and the phases that consume these objects
 * archive and rewrite files.
 */

/** Cap on the raw payload carried on a violation, so a runaway response cannot bloat it. */
export const MAX_RAW = 800

/**
 * Derive the tool's `input_schema` from an effect schema.
 *
 * `Schema.toJsonSchemaDocument` hoists nested structs into a separate `definitions` map and
 * leaves `$ref: "#/$defs/<name>"` behind, so the definitions are folded back under the root
 * as `$defs` — the pointer the refs already name. Verified live 2026-08-02 that Bedrock
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

/**
 * Decode a forced-tool payload against its schema.
 *
 * `onExcessProperty: "error"` is the load-bearing option. The default, `"ignore"`, strips
 * an undeclared key and SUCCEEDS (verified against effect 4.0.0-beta.102), which would let
 * a model answer a schema next to the one it was given and have the extra field silently
 * vanish — the exact drift croq's judge refuses by enumerating its allowed keys.
 *
 * `undefined` input means the model produced no `emit` call at all; it is the same class of
 * failure as a malformed one, and is named as such so a caller can tell them apart in a log
 * without a second error type.
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
        const decoded = yield* Effect.result(
          Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input)
        )
        return Result.isSuccess(decoded)
          ? decoded.success
          : yield* Effect.fail(
              LlmContractViolation.make({
                reason: `tool payload does not satisfy its schema: ${String(decoded.failure)} (raw: ${preview(input)})`
              })
            )
      })

import { Schema } from "effect"

/**
 * A driver or filesystem rejection, reduced to the operation that failed.
 * The payload deliberately excludes SQL text, parameters, and row contents so a
 * storage error can be returned to an agent without leaking corpus content; the
 * driver's own message goes to `Effect.logError` at the adapter edge instead.
 */
export class StorageFailure extends Schema.ErrorClass<StorageFailure>("StorageFailure")({
  _tag: Schema.tag("StorageFailure"),
  operation: Schema.String
}) {}

/**
 * Two writers touched the same file. `ourSha` is the blob sha this process wrote
 * from, `theirSha` the blob sha now in the tree. Recovery belongs to the caller:
 * re-read the current content and reapply.
 */
export class WriteConflict extends Schema.ErrorClass<WriteConflict>("WriteConflict")({
  _tag: Schema.tag("WriteConflict"),
  path: Schema.String,
  ourSha: Schema.String,
  theirSha: Schema.String
}) {}

/** Bedrock refused the call: throttling, an unavailable model, or a denied region. */
export class ModelUnavailable extends Schema.ErrorClass<ModelUnavailable>("ModelUnavailable")({
  _tag: Schema.tag("ModelUnavailable"),
  modelId: Schema.String,
  reason: Schema.String
}) {}

/** A memory that violates the file format or the type/placement vocabulary. */
export class InvalidMemory extends Schema.ErrorClass<InvalidMemory>("InvalidMemory")({
  _tag: Schema.tag("InvalidMemory"),
  reason: Schema.String
}) {}

/** A repo-root-relative path with no file behind it. */
export class PathNotFound extends Schema.ErrorClass<PathNotFound>("PathNotFound")({
  _tag: Schema.tag("PathNotFound"),
  path: Schema.String
}) {}

/**
 * The content hash already belongs to an active file. `existingPath` is what the
 * caller wanted to create, so a deduped write is answerable without a second query.
 */
export class DuplicateContent extends Schema.ErrorClass<DuplicateContent>("DuplicateContent")({
  _tag: Schema.tag("DuplicateContent"),
  contentHash: Schema.String,
  existingPath: Schema.String
}) {}

/** An operation that requires a clean tree found uncommitted changes. */
export class DirtyTree extends Schema.ErrorClass<DirtyTree>("DirtyTree")({
  _tag: Schema.tag("DirtyTree"),
  paths: Schema.Array(Schema.String)
}) {}

/**
 * The model broke its structured-output contract: an undecodable tool payload, a
 * `max_tokens` stop, or a refusal. The item loses its result — a violation is
 * never coerced into a value.
 */
export class LlmContractViolation extends Schema.ErrorClass<LlmContractViolation>(
  "LlmContractViolation"
)({
  _tag: Schema.tag("LlmContractViolation"),
  reason: Schema.String
}) {}

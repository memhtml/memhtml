import { Schema } from "effect"

/**
 * A driver or filesystem rejection, reduced to the operation that failed.
 * The payload deliberately excludes SQL text, parameters, and row contents so a
 * storage error can be returned to an agent without leaking corpus content; the
 * driver's own message goes to `Effect.logError` at the adapter edge instead.
 */
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String
}) {}

/**
 * A git subprocess exited non-zero, or could not be spawned. `command` is the subcommand name
 * only, never the full argv, because arguments carry memory paths and commit subjects carry memory
 * titles, and a `GitFailure` is returned to an agent through a tool response. The stderr text goes
 * to `Effect.logError` at the spawning boundary instead of into the payload.
 *
 * Declared here rather than in `@memhtml/store` because two packages spawn git: the store through
 * its `Git` service, and `@memhtml/session` through its own `execFile` (it needs `GIT_INDEX_FILE`,
 * which the store scrubs). One class means one `_tag`, so the CLI's `ERR_GIT` mapping and an
 * `instanceof` check hold for either producer.
 */
export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  command: Schema.String,
  /** The process exit code, or `null` when the process never started. */
  exitCode: Schema.NullOr(Schema.Int)
}) {}

/**
 * Two writers touched the same file. `ourSha` is the blob sha this process wrote
 * from, `theirSha` the blob sha now in the tree. Recovery belongs to the caller:
 * re-read the current content and reapply.
 */
export class WriteConflict extends Schema.TaggedError<WriteConflict>()("WriteConflict", {
  path: Schema.String,
  ourSha: Schema.String,
  theirSha: Schema.String
}) {}

/** Bedrock refused the call: throttling, an unavailable model, or a denied region. */
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  modelId: Schema.String,
  reason: Schema.String
}) {}

/** A memory that violates the file format or the type/placement vocabulary. */
export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()("InvalidMemory", {
  reason: Schema.String
}) {}

/** A repo-root-relative path with no file behind it. */
export class PathNotFound extends Schema.TaggedError<PathNotFound>()("PathNotFound", {
  path: Schema.String
}) {}

/**
 * The content hash already belongs to an active file. `existingPath` is what the
 * caller wanted to create, so a deduped write is answerable without a second query.
 */
export class DuplicateContent extends Schema.TaggedError<DuplicateContent>()("DuplicateContent", {
  contentHash: Schema.String,
  existingPath: Schema.String
}) {}

/** An operation that requires a clean tree found uncommitted changes. */
export class DirtyTree extends Schema.TaggedError<DirtyTree>()("DirtyTree", {
  paths: Schema.Array(Schema.String)
}) {}

/**
 * The model broke its structured-output contract: an undecodable tool payload, a
 * `max_tokens` stop, or a refusal. The item is reported with no result, and a
 * violation does not become a value.
 */
export class LlmContractViolation extends Schema.TaggedError<LlmContractViolation>()(
  "LlmContractViolation",
  {
    reason: Schema.String
  }
) {}

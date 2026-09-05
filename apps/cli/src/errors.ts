import { type ErrorCode, type Failure, fail } from "./envelope.js"

/**
 * The one translation from a typed domain failure to an envelope code.
 *
 * Every failure in the system reaches an agent through this function, and the mapping is total by
 * construction: an unrecognized `_tag` becomes `ERR_UNKNOWN` rather than an empty response, so a
 * new error class added upstream degrades to a documented code instead of a crash.
 *
 * The codes are `ERROR_CODES` and nothing else. An agent branches on `code` and not on the human
 * `error` string, which changes freely as wording improves. The suggestions are therefore part of
 * the contract and the prose is not.
 */

/** A typed failure as it arrives here: a `_tag` plus whatever payload its class carries. */
interface TaggedError {
  readonly _tag: string
  readonly [field: string]: unknown
}

const isTagged = (value: unknown): value is TaggedError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { _tag?: unknown })._tag === "string"

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const paths = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

/**
 * The code for a tag.
 *
 * `GitFailure` lives in `@memhtml/store` rather than `@memhtml/contracts`. It is the one error class
 * outside the shared contracts package, because it carries a git subcommand name and only the store
 * speaks git. It maps to `ERR_GIT` here at the CLI edge, the only place the two vocabularies meet.
 *
 * `EmbedModelMismatch` is a plain class rather than a schema error (it predates the contracts
 * package), so it arrives with the same `_tag` shape and needs no special case.
 */
export const codeFor = (error: unknown): ErrorCode => {
  if (!isTagged(error)) return "ERR_UNKNOWN"
  switch (error._tag) {
    case "GitFailure":
      return "ERR_GIT"
    case "StorageFailure":
      return "ERR_STORAGE"
    case "InvalidMemory":
      return "ERR_INVALID_MEMORY"
    case "PathNotFound":
      return "ERR_PATH_NOT_FOUND"
    case "WriteConflict":
      return "ERR_WRITE_CONFLICT"
    case "DirtyTree":
      return "ERR_DIRTY_TREE"
    case "DuplicateContent":
      return "ERR_DUPLICATE_CONTENT"
    case "ModelUnavailable":
      return "ERR_MODEL_UNAVAILABLE"
    case "EmbedModelMismatch":
      return "ERR_EMBED_MODEL_MISMATCH"
    // The index describes a commit it is not on, or a rebuild that did not finish. The published
    // recovery is a re-index, carried in SUGGESTIONS below, so an agent recovers in one step.
    case "IndexStale":
      return "ERR_INDEX_STALE"
    // A bare `rebuild --no-embed` over a store that carries vectors. The count is in the prose and
    // on stderr; the recovery is one of the two flag forms carried in SUGGESTIONS below.
    case "RebuildNoEmbedRefused":
      return "ERR_REBUILD_NO_EMBED_REFUSED"
    case "DiscriminationFailed":
      return "ERR_DISCRIMINATION_FAILED"
    default:
      return "ERR_UNKNOWN"
  }
}

/**
 * The human message for a failure.
 *
 * Deliberately narrow. Every payload field named here is one a caller can act on: a path to
 * re-read, two shas to reconcile, a model to check. The message omits the driver's own text, the
 * SQL, the git argv, and any memory body. Each typed error class already dropped those at its
 * adapter edge so a tool response could not carry corpus content, and reconstructing them here
 * would undo that.
 */
export const messageFor = (error: unknown): string => {
  if (!isTagged(error)) return String(error)
  switch (error._tag) {
    case "GitFailure":
      return `git ${text(error.command) ?? "command"} failed (exit ${String(error.exitCode)})`
    case "StorageFailure":
      return `storage operation failed: ${text(error.operation) ?? "unknown"}`
    case "InvalidMemory":
      return `invalid memory: ${text(error.reason) ?? "unstated reason"}`
    case "PathNotFound":
      return `no memory at ${text(error.path) ?? "the given path"}`
    case "WriteConflict":
      return `write conflict on ${text(error.path) ?? "a path"}: ours ${text(error.ourSha) ?? "?"}, theirs ${text(error.theirSha) ?? "?"}`
    case "DirtyTree":
      return `the working tree has uncommitted changes: ${paths(error.paths).join(", ")}`
    case "DuplicateContent":
      return `this content already lives at ${text(error.existingPath) ?? "another path"}`
    case "ModelUnavailable":
      return `bedrock refused ${text(error.modelId) ?? "the model"}: ${text(error.reason) ?? "no reason given"}`
    case "EmbedModelMismatch":
      return `the index was built in vector space ${text(error.stored) ?? "?"}, configured is ${text(error.configured) ?? "?"}`
    case "IndexStale":
      return `the index is stale: ${text(error.reason) ?? "it does not describe the current commit"}`
    case "RebuildNoEmbedRefused":
      return `index rebuild refused: this store carries ${String(error.embeddings ?? "?")} embeddings in ${text(error.model) ?? "the configured space"}, so it was embedded on purpose, and ${error.because === "no-embedder" ? "--embed with no embedder configured (MEMHTML_EMBED=off)" : "--no-embed"} would leave every new or changed chunk without a vector`
    case "LlmContractViolation":
      return `the model broke its structured-output contract: ${text(error.reason) ?? "no reason given"}`
    case "DiscriminationFailed":
      return text(error.reason) ?? "the discrimination gate refused"
    default:
      return `unexpected failure: ${error._tag}`
  }
}

/** One tag's suggestions, given the failure. Some read a payload field, most ignore it. */
type SuggestionsFor = (error: TaggedError) => ReadonlyArray<string>

/**
 * What to do about a failure, as commands the caller can run.
 *
 * A suggestion is part of the contract. An agent that receives `ERR_INDEX_STALE` and a
 * `memhtml index rebuild` suggestion can recover in one step without a round trip to a human, which
 * also means a suggestion has to be a call that MOVES the failure: naming the command that raised the
 * tag would loop. Absent suggestions are an empty array rather than a null, so a parser never
 * branches on presence.
 *
 * A record rather than a `switch`, which is what closes the drift class. Every `memhtml …` string
 * below names a command from the table in `commands.ts`, and a rename there would otherwise leave a
 * stale suggestion here that nothing fails on. A record's keys and arms are both walkable, so the suite
 * can enumerate every tag, run every suggestion through the real `parseArgv`, and fail on a name the
 * table does not hold. A `switch` cannot expose any of that to a test.
 *
 * Validated in the test rather than here on purpose: `errors.ts` importing `commands.ts` closes the
 * cycle `commands.ts` → `operations.ts` → `errors.ts` (commands.ts:8, operations.ts:35) and leaves
 * `AUTHORABLE_RELS` undefined in `commands.ts`'s module body under an operations-first import order.
 */
export const SUGGESTIONS: Readonly<Record<string, SuggestionsFor>> = {
  /*
   * `resolve` FIRST, because the commonest way to reach this error is a path that used to resolve. A
   * correction that rewords a title moves the file and an eviction `git mv`s it, and both mechanisms are
   * recorded — so the walk answers where the fact went, where a search re-derives the answer semantically
   * and may not find it. The two broad reads stay for the case where nothing recorded a move.
   */
  PathNotFound: () => [
    "memhtml resolve <the path you cited> — a correction or an eviction may have moved it",
    "memhtml search <what you were looking for>",
    "memhtml list"
  ],
  /**
   * Two branches produce this tag and they recover differently, so both are offered.
   *
   * An occupied EXPLICIT `--path` is refused rather than overwritten — nothing in this corpus is
   * deleted — and the recovery is `memhtml correct <path>`, which writes the superseding memory and
   * archives what it replaces in one commit. A merge conflict on a sleep branch carries two blob
   * shas instead, and there the recovery is to read the current content and re-apply. The read is
   * first because it is the step both branches start with.
   */
  WriteConflict: (error) => [
    `memhtml read ${text(error.path) ?? "<path>"}`,
    `memhtml correct ${text(error.path) ?? "<path>"} --title <title> --claim <sentence>`,
    "re-apply the change to current content"
  ],
  DirtyTree: () => ["git -C $MEMHTML_ROOT status", "commit or stash the changes, then retry"],
  DuplicateContent: (error) => [`memhtml read ${text(error.existingPath) ?? "<path>"}`],
  EmbedModelMismatch: () => ["memhtml index rebuild --embed"],
  // `index rebuild` only. `index update` is what RAISES this tag — it refuses a watermark row with no
  // commit on it rather than diffing from nothing — so suggesting it would send the operator in a
  // circle. A rebuild is the one call that repopulates the tables the interrupted pass left partial.
  IndexStale: () => ["memhtml index rebuild"],
  // The embedding form first, because it is what a live store wants. `--force` second, for the
  // operator who meant it: the stored vectors survive either way, and what `--no-embed` costs is that
  // new or changed chunks stay unembedded until `memhtml index embed` runs.
  RebuildNoEmbedRefused: () => [
    "memhtml index rebuild --embed",
    "memhtml index rebuild --no-embed --force",
    "memhtml index embed"
  ],
  ModelUnavailable: () => ["retry: search still works on the lexical floor", "memhtml status"],
  InvalidMemory: () => ["memhtml manifest"],
  // No `--json`: there is no such flag — the JSON envelope is the binary's only output — so naming
  // it here would make the suggestion itself a usage error.
  DiscriminationFailed: () => [
    "memhtml eval discriminate",
    "memhtml sleep review",
    "git branch -D <run-id>"
  ]
}

export const suggestionsFor = (error: unknown): ReadonlyArray<string> => {
  if (!isTagged(error)) return []
  return SUGGESTIONS[error._tag]?.(error) ?? []
}

/** A typed failure as an envelope. The one call every command's error path makes. */
export const failureFor = (error: unknown): Failure =>
  fail(codeFor(error), messageFor(error), suggestionsFor(error))

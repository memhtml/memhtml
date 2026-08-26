import { codeFor, messageFor } from "@memhtml/cli"
import { Schema } from "effect"
import { McpSchema } from "effect/unstable/ai"

/**
 * The MCP wire failure: one error class, declared on every tool, whose `.message` IS the response an
 * agent reads.
 *
 * **Why a declared class at all.** `McpServer`'s registration of a toolkit tool wraps the handler in
 * ONE `Effect.catch` with three branches (effect 4.0.0-rc.109), and only one of them lets prose
 * through. An `AiError` takes branch 1 and is rewritten to `INTERNAL_TOOL_ERROR_MESSAGE`, "Tool
 * execution failed due to an internal server error", unless its reason is
 * `ToolParameterValidationError`. A value the tool's own `failureSchema` accepts takes branch 2,
 * where `error instanceof Error ? error.message` passes the text through verbatim. Anything else
 * takes branch 3 and is rewritten. The schema declaration is therefore the whole difference between
 * an agent that can recover and an agent that reads a sentence with no content in it.
 * `Effect.tapCause(Effect.logError)` runs before all three branches, so stderr logging is unaffected
 * either way.
 *
 * **Why the message is composed at construction.** `McpServer` reads `.message` and nothing else.
 * `code` and `suggestions` are not on the wire as fields, because MCP's tool-error channel is one
 * text block. So the three parts are folded into the string HERE, once, and the structured fields stay
 * for tests and for any future surface that can carry them. A consumer that wanted the code back out
 * reads the prefix, which is why the code comes first and is followed by a colon: `ERR_*` is a stable
 * vocabulary and the prose after it is not.
 *
 * **Why `Schema.TaggedError` rather than a hand-written `Error` subclass.** `Schema.is(failureSchema)`
 * is the branch-2 predicate, so the value has to be something a schema accepts, and it has to be an
 * `Error` for `.message` to be read. `Schema.TaggedError` is the one construction that is both: an
 * instance is `instanceof Error`, `Schema.is` accepts it, and `Schema.is` REJECTS a plain `Error`,
 * which is what keeps a genuine defect on branch 3 where it belongs. All three of those are asserted
 * in `tests/failure.test.ts`, so the construction cannot be swapped for one that loses any of them.
 */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  /** The stable code, from the same `ERROR_CODES` vocabulary the CLI envelope publishes. */
  code: Schema.String,
  /** The composed wire text: code, reason, then suggestions. This is what the agent reads. */
  message: Schema.String,
  /** The suggestions, kept structured so a test can assert them without parsing prose. */
  suggestions: Schema.Array(Schema.String)
}) {}

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

/**
 * What to do about a failure, phrased as calls this agent can actually make.
 *
 * The reader is an LLM mid-task holding fifteen tools and no shell. `suggestionsFor` in
 * `apps/cli/src/errors.ts:115-137` answers the same question for a human at a prompt and answers it in
 * `memhtml` commands and `git` invocations, every one of which is unreachable from here. A suggestion
 * an agent cannot execute costs more than none: it spends the model's attention on a plan that ends in
 * "I don't have a terminal", and the recovery that WAS available goes unmentioned. So this is a
 * deliberate parallel mapping rather than a reuse, and the rule it holds to is that every string names
 * a tool in the toolkit or an action inside the current call's own control.
 *
 * The path payloads are interpolated rather than left as `<path>` placeholders: the agent has to type
 * the argument, and a code that already knows the path and does not say it forces a `memory_list` the
 * response could have skipped.
 *
 * The FIRST suggestion is always the action, and any state the agent needs in order to trust that
 * action comes second. `toToolFailure` joins the list behind "Try: ", so a list that opened with
 * "nothing was written" would put a fact where the reader is looking for a verb.
 *
 * `DirtyTree`, `GitFailure` and `StorageFailure` share the same answer, and it states the ceiling:
 * an agent cannot commit, stash, or repair a database from a tool call. `memory_status` is
 * the one read that distinguishes "the repo is wedged" from "that one write raced", and escalation is
 * the correct terminal move rather than a retry loop.
 */
export const mcpSuggestionsFor = (error: unknown): ReadonlyArray<string> => {
  if (!isTagged(error)) return []
  switch (error._tag) {
    case "PathNotFound":
      /*
       * `memory_resolve` first, for the CLI door's reason: the commonest path that is not there is one a
       * correction or an eviction moved, and both mechanisms are recorded, so the walk answers where the
       * fact went rather than re-deriving it semantically.
       */
      return [
        "call memory_resolve on the path you cited — a correction or an eviction may have moved it",
        "call memory_search with a query for what you were looking for",
        "call memory_list to page the corpus by type or workspace"
      ]
    case "WriteConflict":
      return [
        `call memory_read on ${text(error.path) ?? "that path"} to get the current content`,
        "re-apply your change to that content and retry the write"
      ]
    case "DuplicateContent":
      return [
        `call memory_read on ${text(error.existingPath) ?? "that path"} — your content already lives there`,
        "nothing was written and no commit was made, so there is nothing to clean up"
      ]
    case "InvalidMemory":
      return [
        "fix the violated constraint named above and call the same tool again",
        "nothing was written and no commit was made — the store refused at the render gate"
      ]
    case "ModelUnavailable":
      return [
        "retry — search degrades to the lexical floor without the embedder, so results are narrower but real",
        "call memory_status to see whether the embedder is up"
      ]
    case "EmbedModelMismatch":
      return [
        "keep working — memory_search still runs on the lexical, recency, and salience arms",
        "the vector arm stays unusable until an operator rebuilds the index"
      ]
    case "DirtyTree":
    case "GitFailure":
    case "StorageFailure":
      return [
        "call memory_status to see repo health: HEAD, dirty state, and index freshness",
        "report this to the operator if it persists — an agent cannot repair the repo from a tool call"
      ]
    case "DiscriminationFailed":
      return ["call memory_status to see when sleep last ran", "report this to the operator"]
    default:
      return []
  }
}

/**
 * A reason ending in a sentence terminator, so the suggestions read as a second sentence.
 *
 * `messageFor` returns fragments without final punctuation because the CLI envelope carries the reason
 * in its own JSON field and the suggestions in another, so there is nothing to run together. Here the
 * three parts share one string, and "no memory at areas/x.html Try: call memory_search" is a sentence
 * an LLM has to re-parse.
 */
const sentence = (reason: string): string => (/[.!?]$/.test(reason) ? reason : `${reason}.`)

/**
 * The three parts as the one string the protocol carries: code, then reason, then suggestions.
 *
 * One function so the shape is one shape. Every caller here folds the same three parts, and the
 * `ERR_*` prefix followed by a colon is what lets a consumer read the code back out of prose.
 */
const compose = (code: string, reason: string, suggestions: ReadonlyArray<string>): ToolFailure =>
  new ToolFailure({
    code,
    suggestions,
    message:
      suggestions.length === 0
        ? `${code}: ${sentence(reason)}`
        : `${code}: ${sentence(reason)} Try: ${suggestions.join("; ")}`
  })

/**
 * A typed domain failure as the wire failure.
 *
 * Total by construction, three times over: `codeFor` maps an unknown `_tag` to `ERR_UNKNOWN`,
 * `messageFor` maps it to a stated fallback, and `mcpSuggestionsFor` returns an empty array. So an
 * error class added upstream tomorrow reaches an agent as prose with a documented code rather than as
 * the internal-error string. That string is the failure mode this whole module exists to end, and it
 * would come straight back if the mapping could fall off the end.
 *
 * The reason text is `messageFor`'s and only `messageFor`'s: it excludes the driver's message, the
 * SQL, the git argv, and every memory body, because each error class dropped those at its adapter edge
 * so that a tool response could not carry corpus content. Enriching past it here would undo that at
 * the one boundary where the content leaves the process.
 */
export const toToolFailure = (error: unknown): ToolFailure => {
  /**
   * An already-composed failure passes through UNCHANGED, and that branch is what lets a handler
   * compose its own wire failure at all.
   *
   * `handled` in `handlers.ts` is `Effect.mapError(toToolFailure)` over every handler, so a handler that
   * fails with a `ToolFailure` it built itself arrives here too. `batchAbortFailure` is that case,
   * since it needs an op index no typed domain error carries. Without this branch it falls off the end
   * of `codeFor`'s switch (its `_tag` is `"ToolFailure"`, in no error vocabulary) and is rewritten to
   * `ERR_UNKNOWN: unexpected failure: ToolFailure`, the whole composed message replaced by its own
   * class name. That is the masking this module exists to end, arriving from the inside. Caught by the
   * batch abort tests; kept here rather than by exempting the batch handler from `handled`, since a
   * handler outside the one error translation is a handler that can leak an untranslated failure.
   */
  if (error instanceof ToolFailure) return error

  return compose(codeFor(error), messageFor(error), mcpSuggestionsFor(error))
}

/**
 * A refusal the RESOURCE surface owns, composed into the same wire failure a tool call produces.
 *
 * Three refusals belong to that surface and to no use case: a URI outside the published template, a
 * run id with no committed report behind it, and a defect at the boundary. None is a typed error a
 * use case raised, so `toToolFailure` has nothing to translate, and each is composed here for the
 * reason `batchAbortFailure` is — the message shape is one shape, and a second hand-written copy of
 * it drifts the first time the format moves.
 *
 * The reason and the suggestions come from the caller because a resource read's recovery depends on
 * WHICH resource refused, while `mcpSuggestionsFor` answers a different question (what to do about a
 * given error tag). The rule they hold to is the same one: every string names a tool in the toolkit
 * or an action inside the caller's own control.
 */
export const resourceFailure = (
  code: string,
  reason: string,
  suggestions: ReadonlyArray<string>
): ToolFailure => compose(code, reason, suggestions)

/**
 * A failure as the JSON-RPC error the RESOURCE surface has, carrying the tool surface's own prose.
 *
 * `resources/read` has no per-resource failure schema to declare, so a failed read reaches the client
 * as a JSON-RPC error object whose `message` is the only field an agent reads. `toToolFailure`
 * composes that string — same code vocabulary, same reason discipline, same executable suggestions —
 * and this function decides only which error class carries it: `InvalidParams` when the URI names
 * something that is not there, which is the code `McpServer.findResource` itself returns for a URI no
 * template matched, and `InternalError` for every other failure.
 *
 * Nothing here reads the cause's own text. `Effect.orDie` on a resource handler is what puts
 * `Cause.prettyErrors(cause)[0].message` on the wire, and that message carries the ABSOLUTE
 * filesystem path the read was attempted at, plus the stack that reached it. A resource is the one
 * surface with no tool-response envelope to hide behind, so the sanitizing has to happen here.
 */
export const toResourceFailure = (
  error: unknown
): McpSchema.InvalidParams | McpSchema.InternalError => {
  const failure = toToolFailure(error)
  return failure.code === "ERR_PATH_NOT_FOUND"
    ? new McpSchema.InvalidParams({ message: failure.message })
    : new McpSchema.InternalError({ message: failure.message })
}

/**
 * An atomic batch's abort as the wire failure, naming the op that caused it.
 *
 * **Why the error channel and not a success payload.** An atomic batch that aborted wrote nothing, made
 * no commit, and produced no path, so there is no result to return, and a success response carrying
 * `written: 0` is one an agent has to inspect to discover its call did nothing. Every other refusal on
 * this server is an error, so a batch that refused through the success channel would be the one tool
 * whose failures an agent could miss by not looking. `memory_write_batch`'s description promises exactly
 * this ("the first refused op aborts the whole call … and the failure names the offending op as
 * ops[N]"), and that promise is what this function makes true.
 *
 * **Why it is composed HERE rather than in the handler.** `failure.ts` is the single place the wire
 * failure is produced, and there are TWO atomic refusals that must be indistinguishable to a reader: the
 * handler's own per-op XOR check, and an op the store's render gate refused inside `batchWrite`. The
 * second arrives as a `BatchOpReport`, carrying a code and a reason STRING because `operations.ts`
 * already mapped the typed error and deliberately dropped it, so `toToolFailure` cannot be reached for
 * it. Two hand-composed messages would be two shapes for one outcome; one function is one shape.
 *
 * **Why the suggestions are the batch's own and not `mcpSuggestionsFor`'s.** The singular's advice for
 * `InvalidMemory` is "fix the violated constraint and call the same tool again", which is right and
 * incomplete here: the agent is holding N-1 ops that WOULD have landed, and the thing it most needs to
 * know is that `continue_on_error` exists. Both entries open with a verb, because the list is joined
 * behind "Try: ".
 *
 * The `code` is the op's own, carried through unchanged from `codeFor` so the batch and the singular
 * report one refusal under one code. An agent branching on `ERR_INVALID_MEMORY` must not have to know
 * which door produced it.
 */
export const batchAbortFailure = (index: number, code: string, reason: string): ToolFailure => {
  const suggestions = [
    `fix ops[${index}] and call memory_write_batch again`,
    "set continue_on_error to true to write the ops that would have succeeded"
  ]
  return new ToolFailure({
    code,
    suggestions,
    message:
      `${code}: ops[${index}]: ${sentence(reason)} ` +
      `The batch is atomic, so nothing was written and no commit was made. ` +
      `Try: ${suggestions.join("; ")}`
  })
}

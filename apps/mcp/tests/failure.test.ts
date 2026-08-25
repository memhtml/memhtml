import { codeFor } from "@memhtml/cli"
import {
  DirtyTree,
  DuplicateContent,
  InvalidMemory,
  LlmContractViolation,
  ModelUnavailable,
  PathNotFound,
  StorageFailure,
  WriteConflict
} from "@memhtml/contracts/errors"
import { EmbedModelMismatch } from "@memhtml/index"
import { GitFailure } from "@memhtml/store"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  batchAbortFailure,
  mcpSuggestionsFor,
  resourceFailure,
  ToolFailure,
  toResourceFailure,
  toToolFailure
} from "../src/failure.js"
import { MemhtmlToolkit, TOOL_NAMES } from "../src/tools.js"

/**
 * The wire failure as a contract, at the two places it can silently stop working.
 *
 * The FIRST is `toToolFailure`: a code, a reason, and suggestions folded into one string, because MCP's
 * tool-error channel is a single text block and `McpServer` reads `.message` and nothing else. The
 * SECOND is the `failure:` declaration on each tool, which is what selects the branch that passes that
 * string through instead of rewriting it to "Tool execution failed due to an internal server error"
 * (`INTERNAL_TOOL_ERROR_MESSAGE`, effect 4.0.0-rc.109). Either half alone produces a server whose
 * failures are content-free, and neither half's absence is visible in a response shape — only in the
 * text — so both are asserted here and again over real stdio in
 * `tests-integration/tests/mcp-stdio.test.ts`.
 */

/**
 * One instance of every error class that can reach an agent, real rather than a `_tag` literal.
 *
 * Constructed instances, not object literals, because the payload field names are the thing under test:
 * `WriteConflict.ourSha` renamed upstream would leave a literal-based test green while the wire text
 * silently lost the sha an agent reconciles with. The list is the union of `codeFor`'s switch
 * (`apps/cli/src/errors.ts:41-67`) and `messageFor`'s, which is one tag wider.
 */
const EVERY_FAILURE = [
  new GitFailure({ command: "commit", exitCode: 128 }),
  new StorageFailure({ operation: "insert into files" }),
  InvalidMemory.make({ reason: "exactly one <mark> is required, and the article carries none" }),
  new PathNotFound({ path: "areas/oncall/rollback-order.html" }),
  new WriteConflict({ path: "areas/a.html", ourSha: "aaa1111", theirSha: "bbb2222" }),
  new DirtyTree({ paths: ["areas/a.html", "projects/b.html"] }),
  new DuplicateContent({ contentHash: "f00d", existingPath: "areas/oncall/already-here.html" }),
  new ModelUnavailable({ modelId: "amazon.titan-embed-text-v2:0", reason: "throttled" }),
  new EmbedModelMismatch("titan-v1", "titan-v2"),
  new LlmContractViolation({ reason: "the tool payload did not decode" })
] as const

/** The fourteen names an agent can actually call, which is the vocabulary a suggestion may use. */
const CALLABLE = new Set<string>(TOOL_NAMES)

describe("the wire failure a tool call produces", () => {
  it("puts the stable code first for every failure that can reach an agent", () => {
    /**
     * Code-first and colon-delimited because the prose after it is not a contract and the code is: an
     * agent branches on `ERR_WRITE_CONFLICT` and must not have to match wording that improves. Same
     * vocabulary as the CLI envelope's `code`, taken from `codeFor` rather than restated, so the two
     * surfaces cannot drift into two spellings of one failure.
     */
    for (const error of EVERY_FAILURE) {
      const failure = toToolFailure(error)
      const code = codeFor(error)
      expect(failure.code).toBe(code)
      expect(failure.message.startsWith(`${code}: `)).toBe(true)
      expect(failure.message).toContain(code)
    }
  })

  it("composes the whole contract into one readable string", () => {
    /**
     * The wire contract as a LITERAL, once, so the shape of the thing an agent reads is reviewable in a
     * diff rather than inferred from six `toContain`s. Every other assertion in this file is a
     * `toContain` on purpose — wording improves and a literal per case would make that a chore — but the
     * anatomy is worth pinning at one representative failure: code, colon, terminated reason, "Try: ",
     * then the suggestions joined by a semicolon.
     */
    expect(
      toToolFailure(new PathNotFound({ path: "areas/oncall/never-written.html" })).message
    ).toBe(
      "ERR_PATH_NOT_FOUND: no memory at areas/oncall/never-written.html. " +
        "Try: call memory_search with a query for what you were looking for; " +
        "call memory_list to page the corpus by type or workspace"
    )
  })

  it("names every payload field the agent can act on", () => {
    /**
     * The reason is `messageFor`'s, and this is what "actionable" means concretely: a path to re-read,
     * two shas to reconcile, a model to check, the constraint that was violated. A message that said
     * only "write conflict" would cost the agent a `memory_list` to find out where.
     */
    expect(
      toToolFailure(new PathNotFound({ path: "areas/oncall/rollback-order.html" })).message
    ).toContain("areas/oncall/rollback-order.html")

    const conflict = toToolFailure(
      new WriteConflict({ path: "areas/a.html", ourSha: "aaa1111", theirSha: "bbb2222" })
    ).message
    expect(conflict).toContain("areas/a.html")
    expect(conflict).toContain("aaa1111")
    expect(conflict).toContain("bbb2222")

    expect(
      toToolFailure(
        new DuplicateContent({
          contentHash: "f00d",
          existingPath: "areas/oncall/already-here.html"
        })
      ).message
    ).toContain("areas/oncall/already-here.html")

    expect(
      toToolFailure(
        InvalidMemory.make({ reason: "exactly one of body or article_html is required" })
      ).message
    ).toContain("exactly one of body or article_html is required")
  })

  it("leaks no driver message, SQL, or git argv into the wire text", () => {
    /**
     * The reason each error class dropped its cause at its adapter edge: a tool response is the one
     * place corpus content and infrastructure detail leave the process, so `StorageFailure` carries an
     * OPERATION and `GitFailure` a subcommand name — never the driver's sentence and never the argv.
     * Asserted here because "enrich the message" is the obvious next change to this file and it would
     * undo the whole arrangement.
     */
    const storage = toToolFailure(new StorageFailure({ operation: "insert into files" })).message
    expect(storage).toContain("insert into files")
    expect(storage).not.toMatch(/SQLITE|LibsqlError|no such column/i)

    const git = toToolFailure(new GitFailure({ command: "commit", exitCode: 128 })).message
    expect(git).toContain("commit")
    expect(git).toContain("128")
    expect(git).not.toContain("--")
  })

  it("reads as sentences, so the suggestions do not run into the reason", () => {
    /**
     * `messageFor` returns unterminated fragments, correctly: the CLI envelope carries the reason and
     * the suggestions in separate JSON fields, so there is nothing to collide. Here they share one
     * string, and "no memory at areas/x.html Try: call memory_search" is a sentence the reader has to
     * re-parse to find the boundary of.
     */
    const failure = toToolFailure(new PathNotFound({ path: "areas/x.html" }))
    expect(failure.message).toContain("areas/x.html. Try: ")
    // A reason that already ends in a terminator is not given a second one.
    expect(toToolFailure(InvalidMemory.make({ reason: "no <mark>." })).message).not.toContain("..")
  })

  it("omits the Try clause entirely when there is nothing to suggest", () => {
    // Rather than a dangling "Try:" — an empty recovery list is information, and a trailing empty
    // clause reads as a truncated response.
    const failure = toToolFailure(new LlmContractViolation({ reason: "undecodable payload" }))
    expect(failure.suggestions).toEqual([])
    expect(failure.message).not.toContain("Try:")
    expect(failure.message.startsWith("ERR_UNKNOWN: ")).toBe(true)
  })

  it("degrades an unrecognized failure to a coded message, never to the internal-error string", () => {
    /**
     * Totality is the point of the whole module: an error class added upstream tomorrow reaches an agent
     * as `ERR_UNKNOWN` plus a stated tag, because a mapping that could fall off the end would put that
     * failure straight back on `McpServer`'s internal-error branch — the exact masking this task closed.
     */
    for (const odd of [{ _tag: "SomethingNewUpstream" }, "a bare string", null, 42]) {
      const failure = toToolFailure(odd)
      expect(failure.code).toBe("ERR_UNKNOWN")
      expect(failure.message.startsWith("ERR_UNKNOWN: ")).toBe(true)
      expect(failure.message.toLowerCase()).not.toContain("internal server error")
    }
    expect(toToolFailure({ _tag: "SomethingNewUpstream" }).message).toContain(
      "SomethingNewUpstream"
    )
  })

  it("never says 'internal server error' for a typed domain failure", () => {
    for (const error of EVERY_FAILURE) {
      expect(toToolFailure(error).message.toLowerCase()).not.toContain("internal server error")
    }
  })

  it("passes an already-composed ToolFailure through unchanged, rather than re-mapping it", () => {
    /**
     * The masking arriving from the INSIDE, and it is a real bug this assertion closes. `handled` is
     * `Effect.mapError(toToolFailure)` over every handler, so a handler that composes its own wire
     * failure — `batchAbortFailure`, which carries an op index no typed domain error has a field for —
     * passes back through this function. Without the identity branch its `_tag` is `"ToolFailure"`,
     * which is in no error vocabulary, so `codeFor` falls through to `ERR_UNKNOWN` and the whole
     * composed message is replaced by `unexpected failure: ToolFailure` — the tool's own class name
     * standing where the reason belongs.
     *
     * Asserted as reference identity, not field equality: a rebuild that happened to produce the same
     * fields would still be a second composition of a message that is already final.
     */
    const composed = batchAbortFailure(
      4,
      "ERR_INVALID_MEMORY",
      "no <mark>: the claim span is required"
    )
    expect(toToolFailure(composed)).toBe(composed)
    expect(toToolFailure(composed).code).toBe("ERR_INVALID_MEMORY")
    expect(toToolFailure(composed).message).not.toContain("ERR_UNKNOWN")
    expect(toToolFailure(composed).message).not.toContain("unexpected failure")
  })
})

describe("the atomic batch abort as a wire failure", () => {
  /**
   * The batch's own composed failure. It is not `toToolFailure`'s output because it carries something no
   * typed domain error has a field for — WHICH op aborted the batch — and because the recovery it should
   * suggest is different: the agent is holding N-1 ops that would have landed, so the thing it most
   * needs to know is that `continue_on_error` exists.
   */
  it("names the offending op, states that nothing was written, and keeps the op's own code", () => {
    const failure = batchAbortFailure(
      7,
      "ERR_INVALID_MEMORY",
      "no <mark>: the claim span is required"
    )
    // The index, because `results` is ABSENT on an error response: without it an agent holding twenty
    // ops knows only that one of them was wrong.
    expect(failure.message).toContain("ops[7]")
    // The op's reason, verbatim from the per-op report — the same text the continue-mode result carries.
    expect(failure.message).toContain("no <mark>: the claim span is required")
    // "Nothing was written" is the single most consequential fact: an agent that assumed a partial batch
    // goes looking for files to correct, or worse, archives one.
    expect(failure.message).toContain("nothing was written")
    expect(failure.message).toContain("no commit was made")
    // The code is the OP's, carried through: an agent branching on ERR_INVALID_MEMORY must not have to
    // know which door produced it.
    expect(failure.code).toBe("ERR_INVALID_MEMORY")
    expect(failure.message.startsWith("ERR_INVALID_MEMORY: ")).toBe(true)
    expect(failure.message.toLowerCase()).not.toContain("internal server error")
  })

  it("suggests both recoveries, action-first, naming only callable tools", () => {
    /**
     * The same rules `mcpSuggestionsFor` holds to, on a list built outside it: the composed text joins
     * behind "Try: ", so a leading fact would sit where the reader looks for a verb, and a suggestion in
     * `memhtml …` would be one this reader has no shell to run.
     */
    const failure = batchAbortFailure(2, "ERR_INVALID_MEMORY", "both were supplied")
    expect(failure.suggestions).toHaveLength(2)
    expect(failure.suggestions[0]).toMatch(/^fix ops\[2\]/)
    // The second recovery is the one the singular's advice cannot give: the other ops were fine.
    expect(failure.suggestions[1]).toContain("continue_on_error")
    for (const suggestion of failure.suggestions) {
      expect(suggestion).not.toContain("memhtml ")
      expect(suggestion).not.toMatch(/^git /)
      for (const word of suggestion.match(/\b(?:memory|trace)_[a-z_]+\b/g) ?? []) {
        expect(CALLABLE.has(word)).toBe(true)
      }
      // Every suggestion is inside the message, since `.message` is all the protocol carries.
      expect(failure.message).toContain(suggestion)
    }
  })

  it("is a declared failure on the batch tool, which is what un-masks it", () => {
    /**
     * The branch-2 predicate again, on the value the batch handler actually produces. A composed
     * `ToolFailure` is only useful if `memory_write_batch`'s own `failureSchema` accepts it — otherwise
     * every abort reaches the agent as the internal-error string with the op index and all.
     */
    const isDeclaredFailure = Schema.is(MemhtmlToolkit.tools.memory_write_batch.failureSchema)
    expect(
      isDeclaredFailure(batchAbortFailure(0, "ERR_INVALID_MEMORY", "neither was supplied"))
    ).toBe(true)
    expect(batchAbortFailure(0, "ERR_INVALID_MEMORY", "x") instanceof Error).toBe(true)
  })

  it("terminates the reason, so the suggestions do not run into it", () => {
    // `messageFor`'s fragments arrive unterminated, and here they share one string with the sentence
    // that follows — the same reason `sentence` exists for `toToolFailure`.
    expect(batchAbortFailure(1, "ERR_INVALID_MEMORY", "both were supplied").message).toContain(
      "both were supplied. The batch is atomic"
    )
    // A reason that already ends in a terminator is not given a second one.
    expect(batchAbortFailure(1, "ERR_INVALID_MEMORY", "no <mark>.").message).not.toContain("..")
  })
})

describe("the suggestions, as an MCP agent can act on them", () => {
  it("names no CLI command: the reader has fourteen tools and no shell", () => {
    /**
     * The rule that makes this a parallel mapping rather than a reuse of `suggestionsFor`. That function
     * answers the same question for a human at a prompt and answers it in `memhtml search`, `git status`,
     * `memhtml index rebuild` — every one unreachable from a tool call. A suggestion an agent cannot execute
     * is worse than none: it spends the model's attention on a plan that ends in "I have no terminal"
     * while the recovery that WAS available goes unmentioned.
     *
     * `"memhtml "` with the trailing space is the greppable form, and it is why `memory_search` passes and
     * `memhtml search` does not.
     */
    for (const error of [...EVERY_FAILURE, { _tag: "DiscriminationFailed", reason: "the gate" }]) {
      for (const suggestion of mcpSuggestionsFor(error)) {
        expect(suggestion).not.toContain("memhtml ")
        expect(suggestion).not.toMatch(/^git /)
        expect(suggestion).not.toContain("$MEMHTML_ROOT")
        expect(suggestion).not.toContain("--")
      }
      // And the composed wire text carries the same guarantee, since that is what is actually read.
      expect(toToolFailure(error).message).not.toContain("memhtml ")
    }
  })

  it("names only tools that exist, whenever it names one at all", () => {
    /**
     * A suggestion pointing at a tool the toolkit does not publish is a dead end an agent spends a turn
     * discovering. `TOOL_NAMES` is derived from the toolkit, so a renamed tool fails here rather than
     * on a live call.
     */
    for (const error of [...EVERY_FAILURE, { _tag: "DiscriminationFailed", reason: "the gate" }]) {
      for (const suggestion of mcpSuggestionsFor(error)) {
        for (const word of suggestion.match(/\b(?:memory|trace)_[a-z_]+\b/g) ?? []) {
          expect(CALLABLE.has(word)).toBe(true)
        }
      }
    }
  })

  it("tells a lost reader how to find what it wanted", () => {
    const suggestions = mcpSuggestionsFor(new PathNotFound({ path: "areas/x.html" }))
    expect(suggestions.some((entry) => entry.includes("memory_search"))).toBe(true)
    expect(suggestions.some((entry) => entry.includes("memory_list"))).toBe(true)
  })

  it("tells a conflicted writer to re-read the path it actually collided on", () => {
    // The path interpolated rather than left as `<path>`: the agent has to fill the argument, and a
    // message that knows the path and withholds it forces a call the response could have skipped.
    const suggestions = mcpSuggestionsFor(
      new WriteConflict({ path: "areas/a.html", ourSha: "a", theirSha: "b" })
    )
    expect(suggestions[0]).toBe("call memory_read on areas/a.html to get the current content")
    expect(suggestions.some((entry) => entry.includes("retry"))).toBe(true)
  })

  it("points a deduped writer at the memory its content already lives in", () => {
    const suggestions = mcpSuggestionsFor(
      new DuplicateContent({ contentHash: "f00d", existingPath: "areas/here.html" })
    )
    expect(suggestions[0]).toContain("memory_read on areas/here.html")
    // And says nothing needs undoing, because an agent that thinks it half-wrote will try to clean up.
    expect(suggestions.some((entry) => entry.includes("no commit"))).toBe(true)
  })

  it("tells a refused writer that nothing was written before it retries", () => {
    /**
     * The single most useful thing to say about `InvalidMemory`: the store refuses at the render gate,
     * BEFORE any file or commit, so the correct move is to fix the markup and call the same tool again.
     * An agent that assumed a partial write would go looking for a file to correct — or worse, archive
     * one.
     */
    const suggestions = mcpSuggestionsFor(InvalidMemory.make({ reason: "no <mark>" }))
    expect(suggestions.some((entry) => entry.includes("nothing was written"))).toBe(true)
    // The ACTION first, the reassurance second: the list is joined behind "Try: ", so a leading fact
    // puts a statement where the reader is looking for a verb.
    expect(suggestions[0]).toBe(
      "fix the violated constraint named above and call the same tool again"
    )
  })

  it("tells a degraded reader to keep working rather than to stop", () => {
    // `ModelUnavailable` and `EmbedModelMismatch` cost the vector arm, not retrieval: search still runs
    // on the lexical floor. An agent that read "the embedder is down" and abandoned the task would lose
    // a result set it could have had.
    for (const error of [
      new ModelUnavailable({ modelId: "titan", reason: "throttled" }),
      new EmbedModelMismatch("titan-v1", "titan-v2")
    ]) {
      const suggestions = mcpSuggestionsFor(error)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions.join(" ")).toMatch(/lexical|keep working/)
    }
  })

  it("routes an unrepairable repo to memory_status and then to the operator", () => {
    // The honest ceiling: an agent cannot commit, stash, or repair a database from a tool call.
    // `memory_status` is the one read that separates "the repo is wedged" from "that write raced", and
    // escalation is the correct terminal move rather than a retry loop.
    for (const error of [
      new DirtyTree({ paths: ["areas/a.html"] }),
      new GitFailure({ command: "commit", exitCode: 128 }),
      new StorageFailure({ operation: "insert" })
    ]) {
      const suggestions = mcpSuggestionsFor(error)
      expect(suggestions.some((entry) => entry.includes("memory_status"))).toBe(true)
      expect(suggestions.some((entry) => entry.includes("operator"))).toBe(true)
    }
  })

  it("opens with a verb, because the list is joined behind 'Try: '", () => {
    /**
     * The composed text reads "Try: <first>; <second>", so the first entry has to be something to DO.
     * Two of these lists wanted to lead with reassurance — "nothing was written", "the vector arm is
     * unusable" — and both put a fact in the slot the reader scans for an action.
     */
    for (const error of EVERY_FAILURE) {
      const [first] = mcpSuggestionsFor(error)
      if (first === undefined) continue
      expect(first).toMatch(/^(?:call|re-apply|retry|fix|keep|report)\b/)
    }
  })

  it("returns an empty array, never a null, for a failure with no recovery", () => {
    // So a consumer never branches on presence — the same contract `suggestionsFor` holds at the CLI.
    expect(mcpSuggestionsFor(new LlmContractViolation({ reason: "x" }))).toEqual([])
    expect(mcpSuggestionsFor("not tagged at all")).toEqual([])
  })
})

describe("the declared failure schema on every tool", () => {
  it("declares a failure schema on all fourteen, which is what un-masks the message", () => {
    /**
     * `Schema.is(tool.failureSchema)` IS `McpServer`'s branch-2 predicate: `isDeclaredFailure`, built
     * once per tool at registration and consulted on every failed call (effect 4.0.0-rc.109). So this
     * assertion is the mechanism itself rather than a proxy for it: a tool that declared nothing gets
     * `Schema.Never`, the predicate rejects the value, and the response is the internal-error string no
     * matter how good `toToolFailure`'s prose was.
     */
    const failure = toToolFailure(new PathNotFound({ path: "areas/x.html" }))
    expect(TOOL_NAMES).toHaveLength(14)
    for (const name of TOOL_NAMES) {
      const isDeclaredFailure = Schema.is(MemhtmlToolkit.tools[name].failureSchema)
      expect(isDeclaredFailure(failure)).toBe(true)
    }
  })

  it("keeps a genuine defect on the internal-error branch, where it belongs", () => {
    /**
     * The predicate has to REJECT a plain `Error`, and that is a feature: a thrown non-domain error is a
     * defect whose message can carry a stack, a connection string, or a fragment of corpus content, so
     * masking it is correct. This test is what stops a future widening of the schema — to
     * `Schema.Unknown`, say — from turning the whole error channel into a passthrough.
     */
    for (const name of TOOL_NAMES) {
      const isDeclaredFailure = Schema.is(MemhtmlToolkit.tools[name].failureSchema)
      expect(isDeclaredFailure(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(false)
      expect(isDeclaredFailure(new PathNotFound({ path: "areas/x.html" }))).toBe(false)
    }
  })

  it("leaves failureMode at 'error', which is the channel McpServer catches", () => {
    /**
     * `"return"` would fold the failure into the tool's success union (`Toolkit`, effect 4.0.0-rc.109)
     * — the server would see a SUCCESSFUL call whose payload is a failure no MCP client knows to read,
     * so `isError` would be false and the agent would parse the error as a result.
     */
    for (const name of TOOL_NAMES) {
      expect(MemhtmlToolkit.tools[name].failureMode).toBe("error")
    }
  })

  it("is an Error whose message is the whole wire text, since that is all McpServer reads", () => {
    /**
     * Branch 2 is `error instanceof Error ? error.message : INTERNAL_TOOL_ERROR_MESSAGE` (effect
     * 4.0.0-rc.109), so a failure value that is not an `Error` is masked as thoroughly as one
     * with no declared schema — and `code` and `suggestions` are invisible to the protocol. Everything
     * an agent reads has to already be inside `.message`, which is why it is composed at construction.
     */
    const failure = toToolFailure(
      new DuplicateContent({ contentHash: "f00d", existingPath: "areas/here.html" })
    )
    expect(failure instanceof Error).toBe(true)
    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.message).toContain(failure.code)
    for (const suggestion of failure.suggestions) expect(failure.message).toContain(suggestion)
  })
})

/**
 * The RESOURCE channel's half of the same contract.
 *
 * `resources/read` has no per-resource failure schema to declare, so the branch selection above does
 * not apply and a failed read reaches the client as a JSON-RPC error object instead. What survives is
 * the same string — code, reason, suggestions — and the only decision left is which error class carries
 * it. Asserted here rather than only end to end in `resources.test.ts`, because the split is one
 * predicate and a resource read cannot exercise both sides of it without a broken database.
 */
describe("the wire failure a resource read produces", () => {
  it("carries a missing path as InvalidParams, the code McpServer uses for an unmatched URI", () => {
    const error = toResourceFailure(new PathNotFound({ path: "areas/oncall/gone.html" }))
    expect(error.code).toBe(-32602)
    expect(error.message).toBe(
      toToolFailure(new PathNotFound({ path: "areas/oncall/gone.html" })).message
    )
    // The whole point of routing through `toToolFailure`: the code and the suggestions survive.
    expect(error.message).toContain("ERR_PATH_NOT_FOUND")
    expect(error.message).toContain("Try: ")
  })

  it("carries every other failure as InternalError, still with its code and suggestions", () => {
    /**
     * A storage failure is not the caller's bad parameter, so it takes `-32603` — but it must not
     * therefore lose its prose. This is the case an `Effect.orDie` handler answers with the driver's
     * own sentence and an absolute path, so the assertion is that the reason is `messageFor`'s.
     */
    const error = toResourceFailure(new StorageFailure({ operation: "read" }))
    expect(error.code).toBe(-32603)
    expect(error.message).toContain("ERR_STORAGE")
    expect(error.message).toContain("read")
    expect(error.message).toContain("memory_status")
  })

  it("composes a refusal the resource surface owns into the same shape a tool failure has", () => {
    /**
     * `resourceFailure` is the resource counterpart of `batchAbortFailure`: a refusal no use case
     * raised, so there is no typed error for `toToolFailure` to translate. The shape has to match
     * anyway, because an agent reads one format across both surfaces.
     */
    const failure = resourceFailure("ERR_PATH_NOT_FOUND", "no sleep report at memhtml://sleep/x", [
      "call memory_status"
    ])
    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.message).toBe(
      "ERR_PATH_NOT_FOUND: no sleep report at memhtml://sleep/x. Try: call memory_status"
    )
    // Already composed, so it passes through the handler-wide translation unchanged.
    expect(toToolFailure(failure)).toBe(failure)
  })
})

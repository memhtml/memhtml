import { claimFromProse, NEIGHBORS_LIMIT, proseTail } from "@memhtml/cli"
import { MEMORY_RELS } from "@memhtml/contracts/edges"
import { WRITABLE_MEMORY_TYPES } from "@memhtml/contracts/types"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { describe, expect, it } from "vitest"
import { RESOURCE_TEMPLATES } from "../src/resources.js"
import { SERVER_NAME } from "../src/server.js"
import { MemhtmlToolkit, TOOL_NAMES } from "../src/tools.js"

/**
 * The tool surface as a contract: fifteen names, `Schema.Struct` parameters, and JSON Schemas a
 * client can validate against.
 *
 * `TOOL_NAMES` is derived from the toolkit, so every count assertion below is about the SERVER. A
 * hand-maintained list would let a toolkit that builds fourteen tools pass a test asserting fifteen.
 */

/** The fifteen names: design.md §8's table in its own order, with the batch behind the singular. */
const EXPECTED = [
  "memory_write",
  "memory_write_batch",
  "memory_read",
  "memory_search",
  "memory_recall",
  "memory_correct",
  "memory_link",
  "memory_neighbors",
  "memory_resolve",
  "memory_archive",
  "memory_reinforce",
  "memory_list",
  "trace_search",
  "trace_links",
  "memory_status"
] as const

interface JsonSchemaObject {
  readonly type?: string
  readonly properties?: Readonly<Record<string, unknown>>
  readonly required?: ReadonlyArray<string>
  readonly anyOf?: ReadonlyArray<unknown>
}

const schemaFor = (name: string): JsonSchemaObject =>
  Tool.getJsonSchema(
    MemhtmlToolkit.tools[name as keyof typeof MemhtmlToolkit.tools]
  ) as unknown as JsonSchemaObject

describe("tool surface", () => {
  it("declares exactly fifteen distinct tools, in design §8's order", () => {
    expect(TOOL_NAMES).toHaveLength(15)
    expect(new Set(TOOL_NAMES).size).toBe(15)
    expect([...TOOL_NAMES]).toEqual([...EXPECTED])
  })

  it("publishes the batch DIRECTLY after the singular, which is the order an agent reads", () => {
    /**
     * `tools/list` publishes this order and an agent reads it top-down, so a pointer sentence in
     * `memory_write`'s description whose target sits thirteen entries later is one the agent reaches
     * after it has already chosen how to write. Asserted as adjacency rather than as an index, so
     * inserting a tool above `memory_write` does not fail this for the wrong reason.
     */
    expect(TOOL_NAMES.indexOf("memory_write_batch")).toBe(TOOL_NAMES.indexOf("memory_write") + 1)
  })

  it("adds no batch tool for any operation other than write", () => {
    /**
     * D4's op vocabulary v1, as a surface assertion. Correct, link, and archive mutate existing state
     * and carry archival side effects that do not compose into one commit trivially — so a
     * `memory_correct_batch` would be a promise about atomicity the store cannot keep today.
     */
    const batches = TOOL_NAMES.filter((name) => name.endsWith("_batch"))
    expect(batches).toEqual(["memory_write_batch"])
  })

  it("exposes no sleep tool: sleep is an operator action, not an agent one", () => {
    /**
     * A sleep run rewrites confidence across the corpus, archives memories, and produces a branch a
     * human is expected to read. `memhtml sleep run` is the entry point; a read-only `sleep_status` is
     * the only shape this surface could ever take for it, and the write side stays behind an operator.
     */
    for (const name of TOOL_NAMES) {
      expect(name.startsWith("sleep_")).toBe(false)
      expect(name).not.toContain("sleep")
    }
  })

  it("templates every resource under the server's own scheme", () => {
    expect(RESOURCE_TEMPLATES).toHaveLength(3)
    for (const template of RESOURCE_TEMPLATES) {
      expect(template.startsWith(`${SERVER_NAME}://`)).toBe(true)
    }
    expect(RESOURCE_TEMPLATES).toContain("memhtml://file/{path}")
    expect(RESOURCE_TEMPLATES).toContain("memhtml://sleep/{run-id}")
    expect(RESOURCE_TEMPLATES).toContain("memhtml://at/{commit}/{path}")
  })

  it("gives every template a hole whose value spans SEGMENTS, which a route must match across", () => {
    /**
     * The routing defect `memhtml://file/{path}` shipped with, as a surface property rather than as one
     * resource's test. A named router parameter stops at the next `/`, so a template whose only hole is
     * filled with a single segment can pass a read while being unreachable for every real value: every
     * memory path has at least two segments and an archived one has at least four, and a run id is
     * `sleep/<date>`. What has to be true of a template is that its LAST hole is the one that may
     * contain separators, which is where the rest parameter sits.
     */
    for (const template of RESOURCE_TEMPLATES) {
      const holes = [...template.matchAll(/\{[^}]+\}/g)].map((match) => match[0])
      expect(holes.length, template).toBeGreaterThan(0)
      expect(template.endsWith(holes[holes.length - 1] ?? ""), template).toBe(true)
    }
  })

  it("gives every tool a description an agent can choose from", () => {
    for (const name of TOOL_NAMES) {
      const tool = MemhtmlToolkit.tools[name]
      expect(tool.description).toBeDefined()
      expect((tool.description ?? "").length).toBeGreaterThan(40)
    }
  })

  it("states the whole article_html contract in every authoring tool's description", () => {
    /**
     * `tools/list` publishes `description`, and it is the ONLY place an agent reads before it fills
     * a call — so a format rule stated in docs/format.md and nowhere else is a rule the caller learns
     * from a refusal instead. `article_html` is the one parameter where the caller owns a constraint
     * the template would otherwise satisfy itself, which is why the four clauses are asserted here
     * rather than left to a doc comment no client can see.
     *
     * The clauses are format.md's constraint 1 (exactly one `<mark>`, inside the first `<p>` or
     * `<li>`), constraint 3 (no `class`/`style`/`<script>`), the closed vocabulary, and the
     * `<time datetime>` consequence — the first such element becomes `files.event_at`, so the recency
     * arm ranks an episodic memory by the date in the markup and not by when it was written.
     */
    for (const name of ["memory_write", "memory_correct", "memory_write_batch"] as const) {
      const description = MemhtmlToolkit.tools[name].description ?? ""
      expect(description).toContain("<mark>")
      expect(description).toContain("<p>")
      expect(description).toContain("<li>")
      expect(description).toContain("class")
      expect(description).toContain("style")
      expect(description).toContain("<script>")
      expect(description).toContain("docs/format.md")
      expect(description).toContain("<time datetime")
      expect(description).toContain("event time")
      expect(description).toContain("recency")
      // The XOR rule itself, so a caller knows which parameter to send before it sends both.
      expect(description).toMatch(/exactly one of `?body`? or `?article_html`?/i)
    }
  })

  it("carries ONE shared batch guidance in both write tools' descriptions, byte for byte", () => {
    /**
     * D9's shared-constant discipline, asserted as SUBSTRING IDENTITY rather than as two lists of
     * keywords. Two descriptions that each happened to mention batching would pass a keyword check
     * while saying different things about atomicity — and a per-tool paraphrase is exactly what drifts,
     * because the next person to change the semantics will find one of the two copies.
     *
     * The check is that the longest shared run between them IS the whole guidance constant: the batch
     * description carries prose of its own before it and `ARTICLE_HTML_CONTRACT` after, so a plain
     * equality would be wrong, but a shared block of this length cannot be a coincidence.
     */
    const write = MemhtmlToolkit.tools.memory_write.description ?? ""
    const batch = MemhtmlToolkit.tools.memory_write_batch.description ?? ""

    const shared =
      "Call memory_write_batch ONCE rather than memory_write N times whenever this task will write more than about three memories: " +
      "a batch stages every file, makes ONE commit, and reindexes ONCE, so it costs less than N calls and leaves a history a reader can follow. " +
      "It returns one result per op in INPUT ORDER, each naming that op's index, its path, and whether it deduped. " +
      "A batch is ATOMIC by default: the first refused op aborts the whole call, no file is written and no commit is made, and the failure names the offending op as ops[N]. " +
      "Set continue_on_error to true for best-effort instead, and a refused op comes back as a failed result carrying its own code and reason while every surviving op lands in the one commit. " +
      "A duplicate is never a failure: an op whose exact content is already stored returns ok with deduped=true and the existing path. " +
      "Each op supplies EXACTLY ONE of body or article_html, the same rule memory_write follows."

    expect(write).toContain(shared)
    expect(batch).toContain(shared)
  })

  it("states both branches of the path override in every tool that accepts one", () => {
    /**
     * The two branches are surprising in OPPOSITE directions, which is why neither can be left to a
     * refusal. An unusable `path` is silently re-derived, so an agent expecting a refusal gets a memory
     * somewhere it did not name. An OCCUPIED `path` is refused, so an agent expecting last-write-wins
     * gets `ERR_WRITE_CONFLICT` and no file at all. The store's `freePathFor` owns both rules; this
     * asserts the published description tells a caller about them before it sends the parameter.
     *
     * Asserted on both write tools because `writeFields` is shared, so an op in a batch accepts the same
     * parameter under the same rules — and a batch whose description omitted them would let an agent
     * abort twenty ops on the one it could have predicted.
     */
    for (const name of ["memory_write", "memory_write_batch"] as const) {
      const description = MemhtmlToolkit.tools[name].description ?? ""
      expect(description).toContain("IGNORED")
      expect(description).toContain("ERR_WRITE_CONFLICT")
      expect(description).toMatch(/already occupies|ALREADY occupies/)
      // The recovery, because a second write is not it: nothing in this corpus is overwritten.
      expect(description).toContain("memory_correct")
    }
    // Not on `memory_correct`, which takes `target_path` and no override: a paragraph about a
    // parameter a tool does not accept is one that makes an agent try to send it.
    expect(MemhtmlToolkit.tools.memory_correct.description ?? "").not.toContain(
      "ERR_WRITE_CONFLICT"
    )
  })

  it("tells the singular's reader when to reach for the batch, and names it", () => {
    /**
     * The pointer sentence (D9). An agent about to write its fourth memory in a task is reading
     * `memory_write`'s description, not the batch's — so the threshold and the tool NAME both have to
     * be there, or the cheaper path is one it can only find by listing tools again.
     */
    const description = MemhtmlToolkit.tools.memory_write.description ?? ""
    expect(description).toContain("memory_write_batch")
    expect(description).toMatch(/more than about three memories/)
  })

  it("states each batch outcome an agent would otherwise mistake for something else", () => {
    /**
     * The four facts a caller cannot predict from the schema and will assume wrongly: that the default
     * is atomic (so a failed call wrote NOTHING and needs no cleanup), that `continue_on_error` exists
     * at all, that a dedupe is a success rather than an error, and that results come back in input
     * order (so it can index them against the ops it sent). Each one costs a wrong action, not just a
     * round trip: an agent that assumed a partial write goes looking for files to archive.
     */
    const description = MemhtmlToolkit.tools.memory_write_batch.description ?? ""
    expect(description).toContain("ATOMIC by default")
    expect(description).toContain("no file is written and no commit is made")
    expect(description).toContain("continue_on_error")
    expect(description).toContain("INPUT ORDER")
    expect(description).toMatch(/duplicate is never a failure/)
    expect(description).toContain("deduped=true")
    // The one-commit contract, which is the whole reason to prefer this tool.
    expect(description).toContain("ONE commit")
  })

  it("states the conflict assist's PROPOSE-ONLY contract and its reason, in the batch only", () => {
    /**
     * Tool descriptions are this server's only guidance channel — effect 4.0.0-rc.109 never emits MCP's
     * server-level `instructions` (see the note in `server.ts`) — so a semantics not stated in one is a
     * semantics no agent reads. That makes each clause below a behavior lock, not documentation polish.
     *
     * The propose-only clause is the one that matters most, WITH its reason. An agent told only "this
     * does not block" concludes it is a v1 gap and hand-rolls the archiving the design deliberately
     * refuses — so the BEAM caveat (sometimes the contradiction IS the answer) has to be in the text, and
     * so do the three actions the caller may take instead.
     */
    const description = MemhtmlToolkit.tools.memory_write_batch.description ?? ""
    expect(description).toContain("detect_conflicts")
    // Propose-only, and stated unmissably rather than in passing.
    expect(description).toContain("THE ASSIST NEVER CHANGES WHAT IS WRITTEN")
    expect(description).toContain("nothing is archived, nothing is refused, later does not win")
    // The BEAM reason, without which an agent reads the above as a limitation to work around.
    expect(description).toMatch(/[Ss]ometimes the contradiction IS the answer/)
    expect(description).toContain("memory_correct")
    // Not dedupe — the confusion that would make an agent stop checking for either.
    expect(description).toMatch(/not dedupe/i)
    // The two match sources, since `batch_index` is invisible to every other tool.
    expect(description).toContain("conflict.path")
    expect(description).toContain("conflict.batch_index")
    // The nulls, each of which is an absence of INFORMATION rather than of conflict.
    expect(description).toContain("no frame shape")
    expect(description).toContain("article_html")

    /**
     * And NOT on the singular. `memory_write` has no such parameter, so a paragraph about it there would
     * have an agent send a field the tool refuses at decode — the opposite of what a description is for.
     */
    const singular = MemhtmlToolkit.tools.memory_write.description ?? ""
    expect(singular).not.toContain("detect_conflicts")
  })
})

describe("the derived JSON Schema", () => {
  it("derives an object schema with named properties for every tool", () => {
    /**
     * The croq trap, as an executable assertion. `Schema.Struct` derives `{type:"object",properties}`
     * and a client sends a plain object literal against it; `Schema.Class` would derive a schema whose
     * decode expects an instance, and EVERY call would fail at runtime with a decode error. So the
     * check is on the derived shape, which is the thing a client actually reads.
     */
    for (const name of TOOL_NAMES) {
      const schema = schemaFor(name)
      expect(schema.type).toBe("object")
      expect(schema.anyOf).toBeUndefined()
      // `memory_status` takes no parameters, so it legitimately publishes no `properties` key at all;
      // every tool that DOES take parameters must name them.
      if (name !== "memory_status") expect(schema.properties).toBeDefined()
    }
  })

  it("marks only the genuinely required parameters required", () => {
    const write = schemaFor("memory_write")
    /**
     * `body` is NOT required, and that is the `article_html` XOR showing up in the published schema.
     * Neither authoring parameter can be schema-required when exactly one of the two is the rule, so
     * the requirement moved to the handler — see the XOR tests below, which prove it fires. Marking
     * `body` required here would make `article_html` unreachable for every client that validates.
     */
    expect(write.required).toEqual(["title", "memory_type"])
    // The optionals must be absent from `required` but PRESENT in properties: a client that cannot
    // see `session_id` cannot send provenance, and provenance is what makes trace links work.
    expect(Object.keys(write.properties ?? {})).toContain("session_id")
    expect(write.required).not.toContain("session_id")
    expect(Object.keys(write.properties ?? {})).toContain("article_html")
    expect(write.required).not.toContain("article_html")

    // `memory_correct` keeps `reason` required — the XOR loosened the authoring pair and nothing else.
    const correct = schemaFor("memory_correct")
    expect(correct.required).toEqual(["target_path", "title", "reason"])
    expect(Object.keys(correct.properties ?? {})).toContain("article_html")
  })

  it("requires only `ops` on the batch, with continue_on_error and provenance optional", () => {
    /**
     * `ops` is the only thing a batch cannot be called without. `continue_on_error` must NOT be
     * required, because atomic is the default and a client forced to state it would be a client that
     * has to know the flag exists to make the safe call at all.
     *
     * The derived `required` is asserted rather than assumed: this is a struct whose optionals are all
     * `optionalKey(NullOr(…))`, and the whole point of that construction is that it drops out of
     * `required` while staying in `properties`.
     */
    const batch = schemaFor("memory_write_batch")
    expect(batch.required).toEqual(["ops"])
    for (const field of [
      "continue_on_error",
      /**
       * `detect_conflicts` joins the same list, and its absence from `required` is the DEFAULT-OFF
       * contract: the assist costs an extra query, and a caller forced to state the flag would be paying
       * for an answer it did not ask for on every batch it ever sends.
       */
      "detect_conflicts",
      "session_id",
      "prompt_id",
      "turn_uuid"
    ]) {
      expect(Object.keys(batch.properties ?? {})).toContain(field)
      expect(batch.required).not.toContain(field)
    }
  })

  it("publishes ops as an array whose items are the singular's own field set", () => {
    /**
     * D7 says an op is "the same fields as memory_write", and this is that claim as a comparison of the
     * two PUBLISHED schemas rather than of two source literals. They are derived from one shared field
     * record (`writeFields` in `tools.ts`), so a field added to the singular arrives in the op with no
     * edit — and an agent that learned `tags` from `memory_write` cannot have it silently dropped by a
     * batch op, which would file a memory under a facet it is then unfindable by.
     *
     * The `items` schema is asserted to be INLINE: probed on effect 4.0.0-rc.109, a nested
     * `Schema.Struct` inside `Schema.Array` derives under `items` rather than being hoisted into a
     * `$defs` the client would have to resolve — so an agent reading `tools/list` sees the op's fields
     * as directly as it sees the singular's.
     */
    const ops = (schemaFor("memory_write_batch").properties ?? {}).ops as JsonSchemaObject & {
      readonly items?: JsonSchemaObject
    }
    expect(ops.type).toBe("array")
    const item = ops.items
    expect(item?.type).toBe("object")

    const write = schemaFor("memory_write")
    expect(Object.keys(item?.properties ?? {})).toEqual(Object.keys(write.properties ?? {}))
    // And an op carries the SAME requiredness as the singular, XOR included: neither authoring field
    // can be required inside an op either, since the rule is still "exactly one of the two".
    expect(item?.required).toEqual(["title", "memory_type"])
    expect(item?.required).not.toContain("body")
    expect(item?.required).not.toContain("article_html")
  })

  it("publishes every per-op result field as present-and-nullable, never optional", () => {
    /**
     * The `existing_path` rule from `memory_write`, applied to every field of a per-op result: a client
     * reading an ABSENT key cannot tell "this op did not dedupe" from "this server does not report
     * dedupes", and an agent deciding whether to retry a batch needs that distinction on each op.
     *
     * Asserted through `required` on the published success schema, which is where "always present"
     * actually shows up for a consumer.
     */
    const success = Tool.getJsonSchemaFromSchema(
      MemhtmlToolkit.tools.memory_write_batch.successSchema
    ) as unknown as JsonSchemaObject
    expect(success.required).toEqual(["results", "summary", "commit_sha"])

    const results = (success.properties ?? {}).results as JsonSchemaObject & {
      readonly items?: JsonSchemaObject
    }
    expect(results.items?.required).toEqual([
      "index",
      "ok",
      "path",
      "deduped",
      "existing_path",
      "code",
      "error",
      "skipped",
      /**
       * `conflict` obeys the same rule and needs it most: a client reading an absent key cannot tell
       * "this op contradicts nothing" from "this build does not check", and those lead to opposite
       * decisions about whether to go looking. Its own INNER `path`/`batch_index` are nullable rather
       * than optional for the same reason, asserted below.
       */
      "conflict",
      // The two consolidation outcomes follow the same present-and-nullable rule: "not
      // consolidated" and "this build does not consolidate" are different facts.
      "consolidated_into",
      "superseded_path"
    ])

    /**
     * The conflict struct itself: all three fields required, two of them nullable.
     *
     * Asserted here rather than trusted from the outer `required`, because a `NullOr(Struct)` publishes
     * its own nested schema and a field made optional INSIDE it would be invisible to every assertion
     * above — the failure would be a client that branches on `batch_index === null` and instead reads
     * `undefined` on the op where the distinction decides which of two memories it goes and reads.
     */
    const conflict = (results.items?.properties ?? {}).conflict as JsonSchemaObject & {
      readonly anyOf?: ReadonlyArray<JsonSchemaObject>
    }
    const branches: ReadonlyArray<JsonSchemaObject> = conflict.anyOf ?? []
    const struct = branches.find((branch) => branch.type === "object")
    expect(struct?.required).toEqual(["path", "batch_index", "claim"])

    const summary = (success.properties ?? {}).summary as JsonSchemaObject
    expect(summary.required).toEqual([
      "total",
      "written",
      "deduped",
      "failed",
      "skipped",
      "consolidated"
    ])
  })

  it("accepts an op that blanks or nulls the authoring field it did not use", () => {
    /**
     * The `Optional` contract, asserted INSIDE the nested op struct rather than only at the top level —
     * the derived union is flat in both places, but the decoder is the half this repo has already
     * shipped disagreeing with the published schema, and a nested struct is a second construction site
     * where that could regress.
     *
     * Neither-supplied decodes here too, for the same reason it does on the singular: the XOR is a
     * handler rule, not a schema one. The roundtrip tests prove the refusal fires.
     */
    const parameters = MemhtmlToolkit.tools.memory_write_batch.parametersSchema
    for (const input of [
      { ops: [{ title: "t", body: "b.", memory_type: "semantic" }] },
      { ops: [{ title: "t", body: "b.", memory_type: "semantic", article_html: null }] },
      {
        ops: [
          {
            title: "t",
            body: null,
            article_html: "<p><mark>A.</mark></p>",
            memory_type: "semantic"
          }
        ]
      },
      { ops: [{ title: "t", memory_type: "semantic" }] },
      { ops: [], continue_on_error: null, session_id: null, prompt_id: null, turn_uuid: null }
    ]) {
      const decoded = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(parameters)(input)))
      expect(decoded._tag).toBe("Success")
    }

    // And the op's own type enum is the writable one: `arc` is refused at DECODE inside a batch too,
    // so a batch cannot be a way around the vocabulary the singular publishes.
    const refused = Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(parameters)({
          ops: [{ title: "t", body: "b.", memory_type: "arc" }]
        })
      )
    )
    expect(refused._tag).toBe("Failure")
  })

  it("publishes the writable-type enum, which excludes `arc` and includes `task`", () => {
    const memoryType = (schemaFor("memory_write").properties ?? {}).memory_type as {
      readonly enum?: ReadonlyArray<string>
    }
    expect(memoryType.enum).toEqual([...WRITABLE_MEMORY_TYPES])
    expect(memoryType.enum).not.toContain("arc")
    /**
     * `task` arrives here with NO edit to this file: the enum is derived from
     * `WRITABLE_MEMORY_TYPES`, so widening the contract widened the published schema. That is the
     * whole reason the tool count stays 13 — a task is the 10th memory type on one axis, not a
     * second tool surface.
     */
    expect(memoryType.enum).toContain("task")
  })

  it("keeps `memory_link` memory-rels-only, refusing a task rel at DECODE", () => {
    /**
     * The asymmetry with `memhtml link` is deliberate, and it is enforced at the published schema rather
     * than in a handler. An agent's link tool reaches the memory graph; the task graph is authored by
     * the operator's CLI, where `AUTHORABLE_RELS` admits `blocks` and `subtask_of`. Both paths then
     * pass through `@memhtml/store`'s endpoint guard, which is the layer that can see the endpoints'
     * types at all.
     *
     * Asserted at the DECODER, not by comparing the schema's bytes: the published enum and the
     * decoder are two statements of one vocabulary and this repo has already been bitten by them
     * disagreeing (the `Schema.optional` null branch).
     */
    const rel = (schemaFor("memory_link").properties ?? {}).rel as {
      readonly enum?: ReadonlyArray<string>
    }
    expect(rel.enum).toEqual([...MEMORY_RELS])
    expect(rel.enum).not.toContain("blocks")
    expect(rel.enum).not.toContain("subtask_of")

    const parameters = MemhtmlToolkit.tools.memory_link.parametersSchema
    const refused = Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(parameters)({
          src_path: "areas/inbox/tasks/a.html",
          rel: "blocks",
          dst_path: "areas/inbox/tasks/b.html"
        })
      )
    )
    expect(refused._tag).toBe("Failure")

    const admitted = Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(parameters)({
          src_path: "areas/oncall/a.html",
          rel: "relates_to",
          dst_path: "areas/oncall/b.html"
        })
      )
    )
    expect(admitted._tag).toBe("Success")
  })

  it("derives a clean number for every numeric field, with no string branch", () => {
    /**
     * `Schema.Finite`, not `Schema.Number`. `Number` derives an `anyOf` carrying a STRING branch —
     * `{"anyOf":[{"type":"number"},{"type":"string","enum":["Infinity","-Infinity","NaN"]}]}` — because
     * those are not JSON numbers and the codec represents them as strings. A client reading that sees a
     * union where the tool wants a number.
     *
     * The assertion is that no branch is a string, not that there is no union: an optional number's
     * union with `null` is correct and intended.
     */
    for (const [tool, field] of [
      ["memory_write", "confidence"],
      ["memory_write", "importance"],
      ["memory_neighbors", "depth"],
      ["memory_neighbors", "limit"],
      ["memory_search", "limit"],
      ["memory_recall", "budget_chars"]
    ] as const) {
      const schema = (schemaFor(tool).properties ?? {})[field] as JsonSchemaObject
      const branches = schema.anyOf ?? [schema]
      const types = branches.map((branch) => (branch as JsonSchemaObject).type)
      expect(types).not.toContain("string")
      expect(types.some((type) => type === "number" || type === "integer")).toBe(true)
    }
  })

  it("publishes a FLAT null union for an optional, and accepts null at decode", () => {
    /**
     * The seam a byte-comparison fixture is blind to. A bare `Schema.optional(X)` publishes
     * `{"anyOf":[{"type":"string"},{"type":"null"}]}` — telling every client `null` is acceptable —
     * while its DECODER rejects `null` with "Expected string | undefined, got null". A client that
     * read the schema and sent `{"workspace": null}` for "no workspace", which many clients do for an
     * absent optional, would get a decode error on a call the published contract called valid.
     *
     * So both halves are asserted: the shape a client reads, and the values the decoder takes.
     */
    const workspace = (schemaFor("memory_write").properties ?? {}).workspace as JsonSchemaObject
    expect(workspace.anyOf).toEqual([{ type: "string" }, { type: "null" }])

    const parameters = MemhtmlToolkit.tools.memory_write.parametersSchema
    for (const input of [
      { title: "t", body: "b.", memory_type: "semantic" },
      { title: "t", body: "b.", memory_type: "semantic", workspace: null },
      { title: "t", body: "b.", memory_type: "semantic", workspace: "checkout-api" }
    ]) {
      const decoded = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(parameters)(input)))
      expect(decoded._tag).toBe("Success")
    }
  })

  it("publishes article_html as a FLAT null union both authoring tools' decoders accept", () => {
    /**
     * The `Schema.optional` trap again, on the new parameter, and asserted at BOTH halves for the same
     * reason `workspace` is: the published union and the decoder are two statements of one vocabulary,
     * and this repo has already shipped them disagreeing. A client that reads
     * `{"anyOf":[{"type":"string"},{"type":"null"}]}` and sends `article_html: null` to mean "prose,
     * not markup" must be SERVED, not refused at decode — that is the most natural way for a client
     * with both fields in its template to say which one it meant.
     *
     * The decode is where this stops; the XOR itself is a handler refusal, which the roundtrip tests
     * prove. So `{body, article_html: null}` decodes AND writes, while `{}` decodes and then fails.
     */
    for (const tool of ["memory_write", "memory_correct"] as const) {
      const articleHtml = schemaFor(tool).properties?.article_html as JsonSchemaObject
      expect(articleHtml.anyOf).toEqual([{ type: "string" }, { type: "null" }])
      const body = schemaFor(tool).properties?.body as JsonSchemaObject
      expect(body.anyOf).toEqual([{ type: "string" }, { type: "null" }])
    }

    const write = MemhtmlToolkit.tools.memory_write.parametersSchema
    for (const input of [
      // Prose only, markup absent — today's call, unchanged.
      { title: "t", body: "b.", memory_type: "semantic" },
      // Prose only, markup explicitly null — the shape a template-driven client sends.
      { title: "t", body: "b.", memory_type: "semantic", article_html: null },
      // Markup only, prose absent.
      { title: "t", article_html: "<p><mark>A claim.</mark></p>", memory_type: "semantic" },
      // Markup only, prose explicitly null.
      {
        title: "t",
        body: null,
        article_html: "<p><mark>A claim.</mark></p>",
        memory_type: "semantic"
      },
      // Neither: the DECODER admits this, because the XOR is not a schema rule. The handler refuses.
      { title: "t", memory_type: "semantic" }
    ]) {
      const decoded = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(write)(input)))
      expect(decoded._tag).toBe("Success")
    }

    const correct = MemhtmlToolkit.tools.memory_correct.parametersSchema
    const decoded = Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(correct)({
          target_path: "areas/oncall/a.html",
          title: "t",
          body: null,
          article_html: "<p><mark>A corrected claim.</mark></p>",
          reason: "the old claim was wrong"
        })
      )
    )
    expect(decoded._tag).toBe("Success")
  })

  it("publishes memory_search's entity as a FLAT null union its decoder accepts", () => {
    /**
     * The `Optional` contract on the hop parameter. Both halves for the reason `workspace` states:
     * the published union and the decoder are two statements of one vocabulary, and a bare
     * `Schema.optional` makes them disagree — the JSON Schema advertises `null` while the decoder
     * refuses it. A client with `entity` in its parameter template sends `null` to mean "no entity
     * scope", which is the most natural spelling of an unscoped call.
     */
    const entity = (schemaFor("memory_search").properties ?? {}).entity as JsonSchemaObject
    expect(entity.anyOf).toEqual([{ type: "string" }, { type: "null" }])
    // Optional, not required: adding a scope must not break a client already calling this tool.
    expect(schemaFor("memory_search").required ?? []).not.toContain("entity")

    const parameters = MemhtmlToolkit.tools.memory_search.parametersSchema
    for (const input of [
      { query: "drain the vip" },
      { query: "drain the vip", entity: null },
      { query: "drain the vip", entity: "service:checkout-api" }
    ]) {
      const decoded = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(parameters)(input)))
      expect(decoded._tag).toBe("Success")
    }
  })

  it("spells the entity parameter the same way memory_list does, so the two are one vocabulary", () => {
    /**
     * Not a style assertion. A caller reads `person:sanju` off a listing or off a hit and hands it to
     * the other door; two names for one facet (`entity` here, `entity_ref` there) would make that a
     * lookup rather than a copy, and two SHAPES would make it a conversion.
     */
    for (const tool of ["memory_search", "memory_list"] as const) {
      const entity = (schemaFor(tool).properties ?? {}).entity as JsonSchemaObject
      expect(entity, `${tool} has no entity parameter`).toBeDefined()
      expect(entity.anyOf, `${tool}'s entity shape`).toEqual([{ type: "string" }, { type: "null" }])
    }
  })

  it("publishes the hop chain's two halves on memory_search's SUCCESS schema", () => {
    /**
     * The roundtrip contract, at the published response. A hit's `entities` is what the next call's
     * `entity` consumes, so an absent or differently-shaped field is a chain a client cannot follow —
     * and the success schema is where a client learns the field exists at all.
     */
    const success = Tool.getJsonSchemaFromSchema(
      MemhtmlToolkit.tools.memory_search.successSchema
    ) as unknown as JsonSchemaObject
    const properties = success.properties ?? {}
    const hits = properties.hits as { readonly items?: JsonSchemaObject }
    const hit = hits.items ?? {}
    const entities = (hit.properties ?? {}).entities as JsonSchemaObject
    expect(entities.type).toBe("array")
    // Required on every hit, not optional: an absent key cannot be told from "no entities".
    expect(hit.required ?? []).toContain("entities")

    /**
     * `scope_empty` is a plain BOOLEAN, never a null union, and that is the load-bearing half of
     * HOP-3. The CLI's `--dense` strips null-valued keys, so a marker that were null when it did not
     * fire would vanish from exactly the output an agent pastes into a context window — and its
     * absence would then be indistinguishable from a server that does not report it.
     */
    const scopeEmpty = properties.scope_empty as JsonSchemaObject
    expect(scopeEmpty.type).toBe("boolean")
    expect(scopeEmpty.anyOf).toBeUndefined()
    expect(success.required ?? []).toContain("scope_empty")

    // `entity_scope` echoes the caller's scope, so `null` is a real value here rather than an absence.
    const entityScope = properties.entity_scope as JsonSchemaObject
    expect(entityScope.anyOf).toEqual([{ type: "string" }, { type: "null" }])
    expect(success.required ?? []).toContain("entity_scope")
  })

  it("publishes as_of as an optional null-union param and superseded_by on every hit", () => {
    /**
     * The bi-temporal surface, pinned as the consolidation fields were: `as_of` follows `entity`'s
     * `Optional` contract (flat null union, never required — adding a lens must not break a client
     * already calling this tool), and `superseded_by` is present-and-nullable on every hit so a
     * client can tell "not superseded" from "this build does not report supersession".
     */
    const asOf = (schemaFor("memory_search").properties ?? {}).as_of as JsonSchemaObject
    expect(asOf.anyOf).toEqual([{ type: "string" }, { type: "null" }])
    expect(schemaFor("memory_search").required ?? []).not.toContain("as_of")

    const success = Tool.getJsonSchemaFromSchema(
      MemhtmlToolkit.tools.memory_search.successSchema
    ) as unknown as JsonSchemaObject
    const hits = (success.properties ?? {}).hits as { readonly items?: JsonSchemaObject }
    const hit = hits.items ?? {}
    const supersededBy = (hit.properties ?? {}).superseded_by as JsonSchemaObject
    expect(supersededBy.anyOf).toEqual([{ type: "string" }, { type: "null" }])
    expect(hit.required ?? []).toContain("superseded_by")
  })

  it("publishes memory_neighbors' limit as an optional null union, and BOTH truncation markers", () => {
    /**
     * Parity with `memhtml neighbors`, at the published contract. The operation clamps a caller's
     * `limit` and reports `limit` / `nodesDropped` / `scanSaturated`; a tool schema that stopped at
     * `nodes` and `edges` would leave an agent holding a truncated neighborhood it cannot tell from an
     * exhaustive one — and no `limit` at all would make the ceiling something a caller can neither ask
     * for nor lower.
     *
     * `limit` follows the `Optional` contract every other optional parameter has (flat null union,
     * never required), because a client with the field in its template sends `null` for "no ceiling of
     * my own" and must be served rather than refused at decode.
     */
    const limit = schemaFor("memory_neighbors").properties?.limit as JsonSchemaObject
    expect(limit.anyOf).toEqual([{ type: "integer" }, { type: "null" }])
    expect(schemaFor("memory_neighbors").required ?? []).not.toContain("limit")

    const parameters = MemhtmlToolkit.tools.memory_neighbors.parametersSchema
    for (const input of [
      { path: "areas/oncall/a.html" },
      { path: "areas/oncall/a.html", limit: null },
      { path: "areas/oncall/a.html", limit: 1 }
    ]) {
      const decoded = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(parameters)(input)))
      expect(decoded._tag).toBe("Success")
    }

    const success = Tool.getJsonSchemaFromSchema(
      MemhtmlToolkit.tools.memory_neighbors.successSchema
    ) as unknown as JsonSchemaObject
    const properties = success.properties ?? {}
    /**
     * Present-and-required, all three. An absent key cannot be told from "nothing was dropped", which
     * is the same reason `memory_search`'s `scope_empty` is required and non-nullable.
     */
    for (const field of ["node_limit", "dropped_node_count", "scan_saturated"]) {
      expect(properties[field], `${field} is absent from the success schema`).toBeDefined()
      expect(success.required ?? []).toContain(field)
    }
    const saturated = properties.scan_saturated as JsonSchemaObject
    expect(saturated.type).toBe("boolean")
    expect(saturated.anyOf).toBeUndefined()
  })

  it("names both markers in memory_neighbors' description, and which one a bigger limit fixes", () => {
    /**
     * TWO markers rather than one, and the description is the only place a caller learns why: a larger
     * `limit` recovers a dropped node and cannot recover a saturated scan, so one boolean over both
     * would conflate a recoverable truncation with an unrecoverable one. `tools/list` publishes this
     * string and an agent fills the call from it, so a description that claimed the numbers were silent
     * would send it re-asking with a bigger `limit` against a cap no `limit` moves.
     */
    const description = MemhtmlToolkit.tools.memory_neighbors.description ?? ""
    expect(description).toContain("limit")
    expect(description).toContain("node_limit")
    expect(description).toContain("dropped_node_count")
    expect(description).toContain("scan_saturated")
    // The ceiling is the operation's own constant, so the number an agent reads cannot drift from the
    // one the clamp applies.
    expect(description).toContain(String(NEIGHBORS_LIMIT))
    expect(description).toContain("no `limit` recovers")
  })

  it("states the point-in-time contract in memory_search's description", () => {
    // The lens is chosen from the description, like the hop chain: an agent cannot infer from two
    // unrelated fields that as_of returns superseded memories marked with what replaced them.
    const description = MemhtmlToolkit.tools.memory_search.description ?? ""
    expect(description).toContain("as_of")
    expect(description).toContain("superseded_by")
  })

  it("states the hop and the no-widen rule in memory_search's description", () => {
    /**
     * `tools/list` publishes `description`, and an agent chooses and fills a tool from it — so a
     * contract stated only in a doc comment is one the caller never reads. Two clauses an agent cannot
     * infer from the schema: that a value from `entities` is a valid `entity` (the schema shows two
     * strings and no relationship between them), and that an empty scoped result is final rather than
     * something to retry wider.
     */
    const description = MemhtmlToolkit.tools.memory_search.description ?? ""
    expect(description).toContain("entities")
    expect(description).toContain("entity")
    expect(description).toContain("scope_empty")
    expect(description.toLowerCase()).toContain("never widens")
  })

  it("gives memory_status an object schema with no parameters", () => {
    /**
     * `Tool.EmptyParams`, not `Schema.Struct({})`. An empty struct derives
     * `{"anyOf":[{"type":"object"},{"type":"array"}]}` — a union with an ARRAY branch, because a struct
     * with no fields constrains nothing. A client reading that cannot tell it should send `{}`.
     */
    const status = schemaFor("memory_status")
    expect(status.type).toBe("object")
    expect(status.anyOf).toBeUndefined()
    expect(Object.keys(status.properties ?? {})).toHaveLength(0)
  })

  it("publishes a success schema per tool, so a client can validate a response", () => {
    for (const name of TOOL_NAMES) {
      const success = Tool.getJsonSchemaFromSchema(
        MemhtmlToolkit.tools[name].successSchema
      ) as unknown as JsonSchemaObject
      expect(success.type).toBe("object")
      expect(success.properties).toBeDefined()
    }
  })
})

describe("the body-to-claim split", () => {
  /**
   * The tool takes `title` and `body`; the format needs a `<mark>` claim, which is Tier 1 of every
   * disclosure and the span a correction targets. The first sentence is the claim because that is
   * where a model puts the assertion — taking the title instead would make every gist a restatement
   * of the filename.
   *
   * Imported from `@memhtml/cli` rather than from this package: `claimFromProse`/`proseTail` are the ONE
   * implementation both write doors use. This door held a byte-identical copy named `claimOf`/`restOf`
   * until 2026-08-04, and the same sentence-splitting regex in two packages would eventually drift —
   * the same body would then produce a different gist depending on which door wrote it. These cases
   * are the MCP door's half of the shared contract, kept here so a change to the shared function that
   * broke this door's expectations fails in this door's suite.
   */
  it("takes the first sentence as the claim", () => {
    expect(claimFromProse("Drain the VIP first. The revert alone strands connections.")).toBe(
      "Drain the VIP first."
    )
  })

  it("takes the whole body when it has no sentence terminator", () => {
    expect(claimFromProse("drain the vip first")).toBe("drain the vip first")
    expect(proseTail("drain the vip first")).toEqual([])
  })

  it("keeps the remainder as paragraphs, split on blank lines", () => {
    const body = "A claim. Immediate elaboration.\n\nA second paragraph."
    expect(claimFromProse(body)).toBe("A claim.")
    expect(proseTail(body)).toEqual(["Immediate elaboration.", "A second paragraph."])
  })

  it("handles a question or an exclamation as a terminator", () => {
    expect(claimFromProse("Why did it roll back? Because the VIP was live.")).toBe(
      "Why did it roll back?"
    )
  })

  it("drops an empty trailing paragraph rather than emitting an empty element", () => {
    expect(proseTail("A claim. Body.\n\n\n")).toEqual(["Body."])
  })

  /**
   * The grep lock on item 2: this door must hold NO copy of the derivation.
   *
   * Asserted over the emitted `dist` rather than the source, so it is the shipped bytes that are
   * checked — a helper re-added under any NAME is still caught, because what is matched is the regex
   * it would have to contain rather than the identifier it would be called.
   *
   * The two patterns are the derivation's exact signatures, not a loose approximation. A broader
   * `[.!?]` match is wrong: `failure.ts` legitimately tests `/[.!?]$/` to decide whether a wire
   * message already ends in a terminator, and a lock that flagged that would either be deleted by the
   * next reader or force a real function to be written oddly to dodge it.
   */
  it("holds no second copy of the prose split anywhere in its emitted bytes", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    /** `claimFromProse`'s first-sentence pattern and `proseTail`'s blank-line pattern, as emitted. */
    const SIGNATURES = ["(.*?[.!?])(\\s|$)", "\\n\\s*\\n"]
    const dist = new URL("../dist", import.meta.url).pathname
    const entries = await readdir(dist, { recursive: true, withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(entry.parentPath, entry.name))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = await readFile(file, "utf8")
      for (const signature of SIGNATURES) {
        expect(source, `${file} re-implements the prose split: ${signature}`).not.toContain(
          signature
        )
      }
    }
  })
})

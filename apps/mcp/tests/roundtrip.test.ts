import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { type EmbedderShape, layerAppWith, NEIGHBORS_LIMIT } from "@memhtml/cli"
import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Layer, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ToolHandlers } from "../src/handlers.js"
import { MemhtmlToolkit } from "../src/tools.js"

/**
 * A round trip through the REAL toolkit layer: `kit.toLayer(handlers)` over the CLI's own `AppLive`,
 * against a real temp git repo and real migrations.
 *
 * This exercises the whole path an MCP client's `tools/call` takes minus the transport — parameter
 * DECODE against the published schema, the handler, the shared use case, and the success ENCODE. The
 * two ends are the point: a handler returning a shape the success schema does not describe fails
 * here, and so does a client payload the parameter schema rejects. A test that called the handler
 * function directly would skip both codecs, which is where the croq trap lives.
 */

const FAKE_DIM = 1024

/** The deterministic embedder, same construction as the CLI harness so cosines are assertable. */
const fakeEmbedder = (): EmbedderShape => {
  const vector = (text: string): Float32Array => {
    const out = new Float32Array(FAKE_DIM)
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const digest = createHash("sha256").update(token, "utf8").digest()
      const first = digest.readUInt32BE(0) % FAKE_DIM
      const second = digest.readUInt32BE(4) % FAKE_DIM
      out[first] = (out[first] ?? 0) + 1
      out[second] = (out[second] ?? 0) + 0.5
    }
    let norm = 0
    for (const component of out) norm += component * component
    if (norm === 0) return out
    const scale = 1 / Math.sqrt(norm)
    for (let at = 0; at < out.length; at += 1) out[at] = (out[at] ?? 0) * scale
    return out
  }
  const port = {
    embed: (texts: ReadonlyArray<string>) => Effect.sync(() => texts.map(vector)),
    embedQuery: (text: string) => Effect.sync(() => vector(text))
  }
  return { document: port, query: port }
}

describe("a tool call through the toolkit layer", () => {
  let root: string
  let cleanup: () => Promise<void>
  let call: <N extends keyof typeof MemhtmlToolkit.tools>(
    name: N,
    params: unknown
  ) => Promise<Record<string, unknown>>
  /** Two calls started together under one service graph, for the concurrency case. */
  let callBoth: (
    first: readonly [keyof typeof MemhtmlToolkit.tools, unknown],
    second: readonly [keyof typeof MemhtmlToolkit.tools, unknown]
  ) => Promise<ReadonlyArray<Record<string, unknown>>>
  /**
   * The number of commits on HEAD.
   *
   * The observable that separates a BATCH from a loop, and the reason `memory_status.head_sha` alone is
   * not enough: three singular writes also move HEAD, so only the count distinguishes them. Read from
   * the fixture's own git rather than from a status field, because "how many commits did that call
   * make" is a question the index does not answer.
   */
  let commitCount: () => Promise<number>

  beforeAll(async () => {
    const fixture = await Effect.runPromise(makeFixtureRepo())
    root = fixture.root
    cleanup = fixture.cleanup
    commitCount = () =>
      Effect.runPromise(
        fixture.git
          .run(["rev-list", "--count", "HEAD"])
          .pipe(Effect.map((out) => Number(out.trim())))
      )

    /**
     * `provideMerge`, not `provide`.
     *
     * `kit.handle` returns a STREAM whose requirements include each tool's declared `dependencies` —
     * the handler is provided by `ToolHandlers`, but the services the handler yields still have to be
     * in scope where the stream is run. `Layer.provide` would build the handlers against the app graph
     * and then hide it, leaving those requirements unsatisfied; merging keeps both, which is exactly
     * what `McpServer` has in scope when it serves a `tools/call`.
     */
    const layer = ToolHandlers.pipe(
      Layer.provideMerge(layerAppWith({ repo: root, embedder: fakeEmbedder() }))
    )

    /**
     * One call, through the toolkit's own `handle`.
     *
     * `handle` is what `McpServer` itself invokes for a `tools/call`: it decodes `params` against the
     * tool's parameter schema, runs the handler, and streams back both the typed and the ENCODED
     * result. Taking the encoded half is deliberate — it is the JSON a client receives, so a success
     * schema that disagrees with what the handler returned surfaces here rather than at a client.
     *
     * The requirement set is erased at this one boundary, deliberately and with a comment.
     *
     * `kit.handle`'s stream carries `Tool.HandlerServices` — the union of every tool's declared
     * `dependencies` — and TypeScript cannot see that `layer` provides exactly that union, because
     * the two are computed by different type-level paths (a `Layer.Success` of the app graph on one
     * side, a mapped type over thirteen tool definitions on the other). The RUNTIME check is real:
     * a missing service is a defect the first call raises, so every assertion below would fail
     * rather than pass vacuously.
     */
    const invoke = (name: keyof typeof MemhtmlToolkit.tools, params: unknown) =>
      Effect.gen(function* () {
        const kit = yield* MemhtmlToolkit
        const stream = yield* kit.handle(name, params as never)
        const results = yield* Stream.runCollect(stream)
        const last = results.at(-1)
        if (last === undefined) throw new Error(`${String(name)} produced no result`)
        return (last as { readonly encodedResult: unknown }).encodedResult as Record<
          string,
          unknown
        >
      }) as Effect.Effect<Record<string, unknown>, unknown, Layer.Success<typeof layer>>

    call = async (name, params) =>
      Effect.runPromise(Effect.scoped(Effect.provide(invoke(name, params), layer)))

    /**
     * Two calls under ONE layer build, which is the only shape in which concurrency means anything
     * here.
     *
     * `call` provides `layer` per invocation, so two overlapping `call`s construct two independent
     * service graphs — two `Store` instances, two databases opened on the same files, and any
     * in-process serialization inside the store scoped to one of them. That is a faithful model of two
     * PROCESSES and a misleading model of two tool calls: a server builds its layer once at startup and
     * serves every `tools/call` from it. Sharing the build here is what makes the assertion be about the
     * server.
     */
    callBoth = (first, second) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.all([invoke(...first), invoke(...second)], { concurrency: "unbounded" }),
            layer
          )
        )
      )
  })

  afterAll(async () => {
    await cleanup()
  })

  it("memory_write creates a memory and reports its path", async () => {
    const result = await call("memory_write", {
      title: "Prod rollbacks drain the VIP first",
      body: "Drain the VIP before reverting the deploy. The revert alone leaves in-flight connections pinned to the retired target group.",
      memory_type: "procedural",
      workspace: "checkout-api",
      tags: ["deploy"],
      entities: ["service:checkout-api"],
      session_id: "f7e32699-d45b-4248-8ae6-894dfc606f49"
    })

    expect(result.created).toBe(true)
    expect(result.deduped).toBe(false)
    expect(result.path).toMatch(/^projects\/checkout-api\/.*\.html$/)
    // `existing_path` is NULL on a create, never absent: a client reading an absent key cannot tell
    // "no duplicate" from "this server does not report duplicates".
    expect(result.existing_path).toBeNull()
  })

  it("memory_search finds it, with the claim as the gist", async () => {
    const result = await call("memory_search", { query: "drain the vip before reverting" })
    const hits = result.hits as ReadonlyArray<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(0)
    // The first sentence of `body` became the `<mark>` claim, which is what `files.gist` stores and
    // what Tier 1 of every disclosure shows.
    expect(hits[0]?.gist).toBe("Drain the VIP before reverting the deploy.")
    expect(result.degraded).toBe(false)
    expect(result.arms).toContain("vector")
  })

  it("memory_search hits carry a snippet whose text comes from the matched file", async () => {
    const result = await call("memory_search", { query: "drain the vip before reverting" })
    const hits = result.hits as ReadonlyArray<Record<string, unknown>>
    const hit = hits.find((candidate) =>
      String(candidate.path).includes("prod-rollbacks-drain-the-vip")
    )
    expect(hit).toBeDefined()
    /**
     * The snippet is the matched file's best chunk THROUGH THE WIRE — decoded by the published
     * success schema, so an absent field or a shape drift fails here rather than at a client. On a
     * one-chunk file it carries body prose past the gist's first sentence, which is the field's
     * whole reason to exist.
     */
    expect(hit?.snippet).toContain("Drain the VIP before reverting the deploy.")
    expect(hit?.snippet).toContain("in-flight connections pinned to the retired target group")
  })

  /**
   * The two-hop entity chain, THROUGH THE WIRE.
   *
   * Both codecs run here and both matter to this contract: the `entity` parameter has to survive the
   * parameter DECODE, and `entities` has to survive the success ENCODE. A test that called the handler
   * directly would prove neither, and the whole claim is that a value a CLIENT reads out of one
   * response is valid in the next request a CLIENT sends.
   *
   * Written as one `it` on purpose — the hop is the unit. Splitting it would let hop two run against a
   * hardcoded reference and pass while hop one's published form was wrong.
   */
  it("resolves a two-hop entity chain in exactly two memory_search calls", async () => {
    // A rival memory sharing the target's vocabulary under a DIFFERENT entity: the row hop two must
    // exclude. Without it the scope could match everything and this test would still pass.
    const rival = await call("memory_write", {
      title: "Payments rollbacks drain the VIP too",
      body: "Drain the payments VIP before reverting the deploy. The revert alone leaves in-flight connections pinned to the retired target group.",
      memory_type: "procedural",
      workspace: "payments-api",
      tags: ["deploy"],
      entities: ["service:payments-api"]
    })
    expect(rival.created).toBe(true)

    // HOP ONE: an unscoped query. It returns both services' memories, and every hit publishes the
    // references a caller can chain on.
    const first = await call("memory_search", {
      query: "drain the VIP before reverting the deploy",
      limit: 20
    })
    const hits = first.hits as ReadonlyArray<{
      path: string
      entities: ReadonlyArray<string>
    }>
    const seed = hits.find((hit) => hit.path === rival.path)
    expect(seed).toBeDefined()
    /**
     * The `type:` prefix over the wire. `entity_names` — the column recall's fold reads — carries the
     * BARE name, so a hit reusing that projection would publish `payments-api` here and hop two would
     * scope to nothing.
     */
    expect(seed?.entities).toEqual(["service:payments-api"])
    // Hop one saw BOTH services, which is what makes hop two's narrowing observable.
    expect(hits.some((hit) => hit.path !== rival.path)).toBe(true)
    expect(first.scope_empty).toBe(false)
    expect(first.entity_scope).toBeNull()
    // The archived pointer is the zero shape on a non-empty scope, never absent.
    expect(first.archived_matches).toBe(0)
    expect(first.archived).toEqual([])

    // And the non-zero shape crosses the wire: archive the only memory carrying an entity, then scope
    // to it. The scope empties, the pointer counts the archived row, and nothing superseded it.
    const ghost = await call("memory_write", {
      title: "The ghost service owns the retry budget",
      body: "The ghost service owns the retry budget for its own callers.",
      memory_type: "semantic",
      entities: ["service:ghost-api"]
    })
    await call("memory_archive", { path: ghost.path, reason: "decommissioned" })
    const pointer = await call("memory_search", {
      query: "retry budget",
      entity: "service:ghost-api"
    })
    expect(pointer.hits).toEqual([])
    expect(pointer.scope_empty).toBe(true)
    expect(pointer.archived_matches).toBe(1)
    const archived = pointer.archived as ReadonlyArray<Record<string, unknown>>
    expect(archived).toHaveLength(1)
    expect(String(archived[0]?.path)).toMatch(/^archive\//)
    expect(archived[0]?.superseded_by).toBeNull()

    // HOP TWO: the value from hop one, passed VERBATIM. Nothing here reconstructs a reference — that
    // is the contract, and a test that rebuilt the string would be asserting its own arithmetic.
    const reference = seed?.entities[0]
    expect(reference).toBeDefined()
    const second = await call("memory_search", {
      query: "drain the VIP before reverting the deploy",
      entity: reference,
      limit: 20
    })
    const scoped = second.hits as ReadonlyArray<{ path: string; entities: ReadonlyArray<string> }>
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.map((hit) => hit.path)).toEqual([rival.path])
    // Everything returned carries the scoped reference, so the narrowing is the predicate rather than
    // a coincidence of ranking.
    for (const hit of scoped) expect(hit.entities).toContain(reference)
    expect(second.entity_scope).toBe(reference)
    expect(second.scope_empty).toBe(false)
  })

  it("returns a VISIBLY empty memory_search for an entity scope nothing matches", async () => {
    /**
     * HOP-3 at the door an agent calls. Both halves, because either alone is satisfiable by the wrong
     * behavior: an empty `hits` could be a corpus with no answer, and a marker could be set on a
     * response that quietly widened. So the SAME query is run unscoped over the SAME corpus and
     * asserted non-empty.
     */
    const query = "drain the VIP before reverting the deploy"
    const missing = await call("memory_search", { query, entity: "service:nonexistent", limit: 20 })
    expect(missing.hits).toEqual([])
    // Attributable: the caller can tell a typo in the scope from a corpus with nothing to say.
    expect(missing.scope_empty).toBe(true)
    expect(missing.entity_scope).toBe("service:nonexistent")

    // Not widened — the unscoped query over the same corpus has plenty the fallback could have
    // returned, so the empty result above is a decision rather than an absence of candidates.
    const unscoped = await call("memory_search", { query, limit: 20 })
    expect((unscoped.hits as ReadonlyArray<unknown>).length).toBeGreaterThan(0)
    expect(unscoped.scope_empty).toBe(false)
  })

  it("accepts an explicit null entity as no scope, the way the published schema promises", async () => {
    // A client with `entity` in its parameter template sends `null` for "no entity scope". The schema
    // advertises that, so the door has to serve it rather than refuse at decode.
    const result = await call("memory_search", {
      query: "drain the VIP before reverting the deploy",
      entity: null,
      limit: 20
    })
    expect((result.hits as ReadonlyArray<unknown>).length).toBeGreaterThan(0)
    expect(result.entity_scope).toBeNull()
    expect(result.scope_empty).toBe(false)
  })

  it("memory_read returns the full body and the flattened head", async () => {
    const search = await call("memory_search", { query: "drain the vip" })
    const path = (search.hits as ReadonlyArray<{ path: string }>)[0]?.path
    const result = await call("memory_read", { path })

    expect(result.path).toBe(path)
    expect(result.memory_type).toBe("procedural")
    expect(result.archived).toBe(false)
    const meta = result.meta as Record<string, string>
    // Provenance reached the file's head, not only the index — which is what makes it survive a
    // rebuild.
    expect(meta.sessionId).toBe("f7e32699-d45b-4248-8ae6-894dfc606f49")
    expect(meta["entity:service:checkout-api"]).toBe("true")
    expect(meta["tag:deploy"]).toBe("true")
  })

  it("memory_write reports a duplicate instead of writing a second copy", async () => {
    const result = await call("memory_write", {
      title: "Prod rollbacks drain the VIP first",
      body: "Drain the VIP before reverting the deploy. The revert alone leaves in-flight connections pinned to the retired target group.",
      memory_type: "procedural",
      workspace: "checkout-api",
      tags: ["deploy"],
      entities: ["service:checkout-api"]
    })
    expect(result.deduped).toBe(true)
    expect(result.created).toBe(false)
    // The agent learns WHERE the original is in the same response, with no second call.
    expect(result.existing_path).toMatch(/^projects\/checkout-api\//)
  })

  it("accepts an explicit null for an optional parameter", async () => {
    /**
     * The published schema says `null` is acceptable for every optional, so a client that serializes
     * an absent optional as `null` — many do — must be served rather than refused. This is the decode
     * half of the contract the schema test asserts the shape half of.
     */
    const result = await call("memory_write", {
      title: "A memory written with explicit nulls",
      body: "Null and absent both mean not supplied.",
      memory_type: "semantic",
      workspace: null,
      path: null,
      tags: null,
      entities: null,
      importance: null,
      confidence: null,
      session_id: null,
      prompt_id: null,
      turn_uuid: null
    })
    expect(result.created).toBe(true)
  })

  it("memory_status reports the corpus, and takes no parameters", async () => {
    const result = await call("memory_status", {})
    expect(result.dirty).toBe(false)
    expect(result.head_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.index_fresh).toBe(true)
    expect(Object.keys(result.counts_by_type as Record<string, number>).length).toBeGreaterThan(0)
    expect(result.last_sleep).toBeNull()
  })

  it("memory_list pages with a keyset cursor", async () => {
    const first = await call("memory_list", { limit: 1 })
    const files = first.files as ReadonlyArray<{ path: string }>
    expect(files).toHaveLength(1)
    // A next page exists, and the cursor is the last path returned rather than an offset: `files.path`
    // is the primary key AND it moves, so an offset page taken while sleep archives a file would skip
    // a row or repeat one.
    expect(first.next_cursor).toBe(files[0]?.path)

    const second = await call("memory_list", { limit: 1, cursor: first.next_cursor })
    const next = second.files as ReadonlyArray<{ path: string }>
    expect(next[0]?.path).not.toBe(files[0]?.path)
  })

  it("memory_recall returns a pack with the lateral tail named", async () => {
    const result = await call("memory_recall", { query: "vip drain rollback" })
    const sections = result.sections as Record<string, ReadonlyArray<unknown>>
    expect(Array.isArray(sections.arcs)).toBe(true)
    expect(Array.isArray(sections.memories)).toBe(true)
    // `lateral` must be present even when empty: absent, a client cannot tell a complete pack from a
    // truncated one.
    expect(Array.isArray(sections.lateral)).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it("memory_link, memory_neighbors, and memory_archive round-trip", async () => {
    const listed = await call("memory_list", {})
    const files = listed.files as ReadonlyArray<{ path: string }>
    const source = files.find((file) => file.path.includes("prod-rollbacks"))?.path
    const target = files.find((file) => file.path.includes("explicit-nulls"))?.path
    expect(source).toBeDefined()
    expect(target).toBeDefined()

    const linked = await call("memory_link", {
      src_path: source,
      rel: "relates_to",
      dst_path: target
    })
    expect(linked.ok).toBe(true)
    expect(linked.rel).toBe("relates_to")

    /**
     * A SECOND rel over the same pair, which is what makes the `edges` assertion below able to fail.
     *
     * `edges` is a distinct-`(src, rel, dst)` count and `nodes` is one entry per path at its minimal
     * hop, so two rels between two files are ONE node and TWO edges. With a single link the two numbers
     * agree, and a build that published `nodes.length` under the name `edges` would pass.
     */
    const second = await call("memory_link", {
      src_path: source,
      rel: "supports",
      dst_path: target
    })
    expect(second.ok).toBe(true)

    const neighbors = await call("memory_neighbors", { path: source, depth: 1 })
    const nodes = neighbors.nodes as ReadonlyArray<{
      path: string
      hop: number
      rel: string
      derived: boolean
    }>
    expect(nodes.some((node) => node.path === target)).toBe(true)
    expect(nodes.every((node) => node.hop === 1)).toBe(true)
    // One node, two edges: the field's name and its value agree only on a real edge count.
    expect(nodes.filter((node) => node.path === target)).toHaveLength(1)
    expect(neighbors.edges).toBe(2)
    expect(neighbors.edges).not.toBe(nodes.length)
    /**
     * `derived` THROUGH THE WIRE, false for an authored `<link>`. The tool's description advertises
     * sleep-mined edges as the point of the tool, so a success schema that dropped this field would
     * publish a graph in which an agent cannot tell a machine's suspicion from a human's assertion.
     */
    expect(nodes.every((node) => node.derived === false)).toBe(true)

    const archived = await call("memory_archive", {
      path: target,
      reason: "written only to exercise the null path"
    })
    expect(archived.archive_path).toMatch(/^archive\/\d{4}\//)
  })

  it("memory_neighbors clamps the caller's limit and reports both truncation markers", async () => {
    /**
     * Parity with `memhtml neighbors`, THROUGH THE WIRE: the parameter has to survive decode and the
     * three fields have to survive encode, so a `limit` the schema does not publish is silently stripped
     * and a marker the success schema does not describe never reaches a client.
     *
     * A neighborhood of TWO paths joined by THREE edges, which is what makes each assertion able to
     * fail: `limit: 1` drops exactly one path, and `edges` is unchanged by the clamp because it counts
     * the edges the walk enumerated — including the dropped path's.
     */
    const writeOne = async (title: string, body: string): Promise<string> =>
      String((await call("memory_write", { title, body, memory_type: "semantic" })).path)

    const center = await writeOne(
      "The center of a clamped neighborhood",
      "A neighborhood answer states the ceiling it was built under."
    )
    const left = await writeOne(
      "The first neighbor of the clamped center",
      "Two rels over one pair are one node and two edges."
    )
    const right = await writeOne(
      "The second neighbor of the clamped center",
      "A second neighbor is what a limit of one can turn away."
    )
    for (const [rel, dst] of [
      ["relates_to", left],
      ["supports", left],
      ["relates_to", right]
    ] as const) {
      expect((await call("memory_link", { src_path: center, rel, dst_path: dst })).ok).toBe(true)
    }

    const full = await call("memory_neighbors", { path: center })
    expect((full.nodes as ReadonlyArray<unknown>).length).toBe(2)
    expect(full.edges).toBe(3)
    // The default ceiling is the operation's own constant, and an unclamped answer says so rather than
    // leaving a caller to infer completeness.
    expect(full.node_limit).toBe(NEIGHBORS_LIMIT)
    expect(full.dropped_node_count).toBe(0)
    // Three rows, nowhere near the walk's 10000-row cap.
    expect(full.scan_saturated).toBe(false)

    const clamped = await call("memory_neighbors", { path: center, limit: 1 })
    expect(clamped.node_limit).toBe(1)
    expect((clamped.nodes as ReadonlyArray<unknown>).length).toBe(1)
    expect(clamped.dropped_node_count).toBe(1)
    // Deliberately UNCHANGED: an `edges` total that excluded the dropped path's edges would agree with
    // `nodes` while describing a walk that never happened.
    expect(clamped.edges).toBe(3)
    expect(clamped.scan_saturated).toBe(false)

    // Over the ceiling is clamped, not refused: a caller asking for more than the ceiling wants it.
    const asked = await call("memory_neighbors", { path: center, limit: 10_000 })
    expect(asked.node_limit).toBe(NEIGHBORS_LIMIT)
  })

  it("memory_reinforce partitions bumped from cooled-down", async () => {
    const listed = await call("memory_list", {})
    const path = (listed.files as ReadonlyArray<{ path: string }>)[0]?.path
    const result = await call("memory_reinforce", { paths: [path], signal: "positive" })
    const bumped = result.bumped as ReadonlyArray<string>
    const cooled = result.cooled_down as ReadonlyArray<string>
    // Total and disjoint: every path asked about lands on exactly one side. Which side depends on the
    // 900-second window, which the searches above have already touched.
    expect([...bumped, ...cooled]).toEqual([path])
  })

  it("trace_links refuses a call with neither side named", async () => {
    /**
     * The failure path through the toolkit, and it must be a typed refusal rather than an unbounded
     * scan of every link ever recorded. A tool whose no-argument form returns the whole table is one
     * an agent calls by accident.
     */
    await expect(call("trace_links", {})).rejects.toThrow(/session_id or a path/)
  })

  it("surfaces a domain failure as prose carrying no internals", async () => {
    /**
     * MCP has one error channel and it is prose, so the typed error's structure cannot survive — but
     * the message must still say what to do, and it must not carry a driver message, a git argv, or
     * any memory body. Each typed error class dropped those at its adapter edge precisely so a tool
     * response could not carry corpus content.
     */
    await expect(call("memory_read", { path: "areas/inbox/absent.html" })).rejects.toThrow(
      /no memory at areas\/inbox\/absent\.html/
    )
  })

  it("refuses a parameter outside a closed vocabulary at DECODE, before the handler runs", async () => {
    // `arc` is a valid storage type and not a writable one, so the enum in the published schema is
    // narrower than the database's CHECK by exactly that value — and the decode is where it bites.
    await expect(
      call("memory_write", { title: "t", body: "b.", memory_type: "arc" })
    ).rejects.toThrow()
  })

  it("writes a TASK through memory_write, with no tool added and no schema edited", async () => {
    /**
     * The whole MCP half of the task feature, and it is a non-change: `WritableType` derives from
     * `WRITABLE_MEMORY_TYPES`, so widening the contract widened the published enum, the decoder, and
     * this path together. The tool count stays 13.
     *
     * Asserted through `kit.handle` rather than by calling the handler, so the parameter DECODE and
     * the success ENCODE both run — a task's write is only usable if `memory_type: "task"` survives
     * the codec at both ends.
     */
    const written = await call("memory_write", {
      title: "Decide whether the arc profile needs its own half-life",
      body: "The 30-day arc half-life is inherited from the predecessor memory system and nobody has measured it here.",
      memory_type: "task",
      workspace: "memhtml"
    })
    expect(written.created).toBe(true)
    // The placement rule routed it: a workspace task lands under `projects/<slug>/tasks/`.
    expect(written.path).toMatch(/^projects\/memhtml\/tasks\/.*\.html$/)

    // `memhtml-task-status` was stamped by the template's default, so the file is one the parser accepts
    // — a task with no status is a violation, and a client cannot supply one through this tool.
    const read = await call("memory_read", { path: written.path })
    const meta = read.meta as Record<string, string>
    expect(meta.memoryType).toBe("task")
    expect(meta.taskStatus).toBe("todo")
    expect(read.archived).toBe(false)
  })

  it("hides tasks from memory_search by default, and includes them when named", async () => {
    /**
     * The routing decision, asserted at the tool an agent actually calls. A task is intermediate
     * working state: recalling one alongside knowledge would spend a disclosure budget on a to-do.
     * Naming `task` in `memory_types` is the opt-in, and it must WORK — a default-exclusion with no
     * reachable opt-in is a hidden row rather than a routing rule.
     */
    const query = "arc profile half-life measured"
    const excluded = await call("memory_search", { query })
    const hits = excluded.hits as ReadonlyArray<{ path: string; memory_type: string }>
    expect(hits.every((hit) => hit.memory_type !== "task")).toBe(true)

    const included = await call("memory_search", { query, memory_types: ["task"] })
    const taskHits = included.hits as ReadonlyArray<{ path: string; memory_type: string }>
    expect(taskHits.length).toBeGreaterThan(0)
    expect(taskHits.every((hit) => hit.memory_type === "task")).toBe(true)
  })

  it("lists tasks through memory_list, which needs no task-specific parameter", async () => {
    // `memory_list` filters by type and the type vocabulary now holds `task`, so the listing works
    // with no edit — the plan's "no new MCP tools" holds because every axis a task needs already
    // existed.
    const listed = await call("memory_list", { memory_type: "task" })
    const files = listed.files as ReadonlyArray<{ path: string; memory_type: string }>
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => file.memory_type === "task")).toBe(true)
  })
  it("memory_write takes article_html verbatim, with the authored <mark> as the gist", async () => {
    /**
     * The passthrough, asserted through `kit.handle` so the parameter DECODE runs — `article_html` is
     * only usable if it survives the codec, and the whole point of the field is that the caller's
     * markup reaches disk UNCHANGED. So the assertions are on what came back out through
     * `memory_read`: the `<dl>` and the `<time datetime>` are elements the prose path cannot produce
     * at all, which is why they are the ones checked. A handler that had run `claimFromProse` on absent
     * prose would have written an empty `<mark>`, which the render gate now refuses outright.
     */
    const written = await call("memory_write", {
      title: "The retry budget was exhausted before the circuit opened",
      article_html:
        "<p><mark>The retry budget is exhausted before the circuit breaker opens.</mark> " +
        'Observed on <time datetime="2026-07-19">July 19</time> during the ' +
        "<cite>payments-api brownout</cite>.</p>" +
        "<dl><dt>Applies to</dt><dd>every client of the retry middleware</dd></dl>",
      memory_type: "episodic",
      workspace: "payments-api"
    })
    expect(written.created).toBe(true)
    expect(written.deduped).toBe(false)

    const read = await call("memory_read", { path: written.path })
    // The claim came from the caller's own `<mark>`, not from a claim the handler derived: `claim` was
    // `""` on the way in, so an empty gist here would mean the prose path had run anyway.
    expect(read.gist).toBe("The retry budget is exhausted before the circuit breaker opens.")
    // The rich elements survived as MARKUP. Escaped, they would read as prose and the indexer would
    // never see the event date.
    expect(read.body as string).toContain("July 19")
    expect(read.warnings).toEqual([])
  })

  it("lands a caller's <time datetime> on disk as MARKUP, which body cannot", async () => {
    /**
     * The `<time datetime>` clause of the tool description, as the behavior that makes it true rather
     * than as a string in a description test. `files.event_at` is the first `<time datetime>` of the
     * parsed article, and the recency arm ranks by `coalesce(event_at, updated_at)` — so the whole
     * clause reduces to whether an ELEMENT reached the file, since escaped text is prose the parser
     * never reads a date out of.
     *
     * Asserted on the bytes, and paired with the prose path on the same input: `body` escapes its
     * argument (the template calls `escapeText`), so `&lt;time` is what the other path produces and
     * `article_html` is the ONLY way an event time is authorable through MCP at all. Without the pair
     * this test would pass on an implementation that escaped both.
     */
    const authored = await call("memory_write", {
      title: "The very first canary rollout was manual",
      article_html:
        "<p><mark>Canary rollouts were driven by hand before the pipeline existed.</mark> " +
        '<time datetime="2019-03-04">March 2019</time>.</p>',
      memory_type: "episodic",
      workspace: "canary-history"
    })
    const onDisk = await readFile(join(root, authored.path as string), "utf8")
    expect(onDisk).toContain('<time datetime="2019-03-04">March 2019</time>')
    expect(onDisk).not.toContain("&lt;time")

    const prose = await call("memory_write", {
      title: "The same date written as prose instead",
      body: 'Canary rollouts were manual. <time datetime="2019-03-04">March 2019</time>.',
      memory_type: "episodic",
      workspace: "canary-history"
    })
    const escaped = await readFile(join(root, prose.path as string), "utf8")
    expect(escaped).toContain("&lt;time")
    expect(escaped).not.toContain('<time datetime="2019-03-04">')
  })

  it("refuses memory_write with BOTH body and article_html, naming the rule", async () => {
    /**
     * The refusal has to FIRE, and it has to fire loudly rather than pick a winner. A precedence rule
     * would write a memory whose content the caller did not choose — into a commit, indexed,
     * retrievable — on a call that was ambiguous about which of two articles it meant.
     */
    await expect(
      call("memory_write", {
        title: "Ambiguous authoring",
        body: "Prose that would become a claim.",
        article_html: "<p><mark>Markup that carries its own claim.</mark></p>",
        memory_type: "semantic"
      })
    ).rejects.toThrow(/exactly one of body or article_html/)

    // And nothing was written: the refusal precedes the operation, so there is no half-authored file.
    const listed = await call("memory_list", {})
    const files = listed.files as ReadonlyArray<{ title: string }>
    expect(files.some((file) => file.title === "Ambiguous authoring")).toBe(false)
  })

  it("refuses memory_write with NEITHER body nor article_html", async () => {
    /**
     * The decoder admits this call — neither field is `required` in the published schema, because
     * neither can be under an XOR — so the handler is the only thing standing between an agent that
     * forgot the body and a memory with an empty `<mark>` that every disclosure tier renders blank.
     */
    await expect(
      call("memory_write", { title: "A memory with no article at all", memory_type: "semantic" })
    ).rejects.toThrow(/exactly one of body or article_html/)

    // A blank string is "not supplied", not "supplied": a client that fills BOTH template fields with
    // whitespace must get the rule, not a file with an empty claim.
    await expect(
      call("memory_write", {
        title: "A memory whose fields are blank",
        body: "   ",
        article_html: "",
        memory_type: "semantic"
      })
    ).rejects.toThrow(/exactly one of body or article_html/)
  })

  it("serves a client that blanks the authoring field it did not use", async () => {
    /**
     * The other half of "a blank string is not supplied", and the half that discriminates: a client
     * whose request template carries both fields sends `article_html: ""` to mean "prose, not markup".
     * A presence check on `!== undefined` alone reads that as "supplied both" and REFUSES a call that
     * unambiguously supplied one — so this pair is what makes the `.trim() !== ""` in `authored` load
     * bearing rather than decorative. Both directions, because a client can blank either side.
     *
     * Asserted as a SUCCESS. The refusal tests above cannot catch this: under a presence-only check
     * they all still pass, since blanking both fields refuses either way.
     */
    const prose = await call("memory_write", {
      title: "Prose supplied with the markup field blanked",
      body: "A client that blanks the field it did not use is supplying prose.",
      article_html: "",
      memory_type: "semantic"
    })
    expect(prose.created).toBe(true)

    const markup = await call("memory_write", {
      title: "Markup supplied with the prose field blanked",
      body: "   ",
      article_html: "<p><mark>Blanking the prose field still means markup.</mark></p>",
      memory_type: "semantic"
    })
    expect(markup.created).toBe(true)
    // And it took the MARKUP path: the claim is the authored `<mark>`, not a claim derived from the
    // whitespace `body` — which `claimFromProse("   ")` would have made `""`.
    expect((await call("memory_read", { path: markup.path })).gist).toBe(
      "Blanking the prose field still means markup."
    )
  })

  it("memory_correct supersedes through article_html, and refuses both or neither", async () => {
    const original = await call("memory_write", {
      title: "The stale claim a correction will replace",
      body: "The retry budget is per-request. Nothing measured this.",
      memory_type: "semantic",
      workspace: "corrections"
    })
    expect(original.created).toBe(true)

    // Both: refused, and the target stays ACTIVE — the worst outcome a partial correction can
    // produce is an archived target with no live replacement.
    await expect(
      call("memory_correct", {
        target_path: original.path,
        title: "An ambiguous correction",
        body: "Prose.",
        article_html: "<p><mark>Markup.</mark></p>",
        reason: "both supplied"
      })
    ).rejects.toThrow(/exactly one of body or article_html/)
    await expect(
      call("memory_correct", {
        target_path: original.path,
        title: "An empty correction",
        reason: "neither supplied"
      })
    ).rejects.toThrow(/exactly one of body or article_html/)
    expect((await call("memory_read", { path: original.path })).archived).toBe(false)

    // Markup only: the correction lands, the target archives, and the authored `<mark>` is the new
    // gist — the archival semantics are untouched by the new parameter.
    const corrected = await call("memory_correct", {
      target_path: original.path,
      title: "The retry budget is per-connection",
      article_html:
        "<p><mark>The retry budget is per-connection, not per-request.</mark></p>" +
        "<dl><dt>Measured</dt><dd>during the payments-api brownout</dd></dl>",
      reason: "the per-request reading was never measured"
    })
    expect(corrected.archived).toHaveLength(1)
    expect(corrected.superseded).toEqual(corrected.archived)
    expect((corrected.archived as ReadonlyArray<string>)[0]).toMatch(/^archive\/\d{4}\//)

    const read = await call("memory_read", { path: corrected.path })
    expect(read.gist).toBe("The retry budget is per-connection, not per-request.")
    expect(read.archived).toBe(false)
  })

  it("answers as_of with the superseded belief marked superseded_by, THROUGH THE WIRE", async () => {
    /**
     * The bi-temporal round trip over the real store: a correction closes the old fact's validity
     * window at the new fact's `<time datetime>` and opens the new one's, and `as_of` then reads
     * each side of that moment. Both codecs run — `as_of` survives the parameter DECODE and
     * `superseded_by` survives the success ENCODE — which is the half the retrieval-level test
     * cannot see.
     */
    const original = await call("memory_write", {
      title: "The batch window",
      article_html:
        '<p><mark>The nightly batch window opens at 02:00 UTC.</mark> Set on <time datetime="2023-06-01T00:00:00Z">that date</time>.</p>',
      memory_type: "semantic",
      workspace: "corrections"
    })
    expect(original.created).toBe(true)

    const corrected = await call("memory_correct", {
      target_path: original.path,
      title: "The batch window, moved",
      article_html:
        '<p><mark>The nightly batch window opens at 03:30 UTC.</mark> Moved on <time datetime="2025-02-01T00:00:00Z">that date</time>.</p>',
      reason: "the window moved"
    })
    const archivedPath = (corrected.archived as ReadonlyArray<string>)[0]

    // As of 2024: the ORIGINAL was the belief. It comes back although archived, marked with what
    // replaced it; the correction's window has not opened yet, so it must be absent.
    const then = await call("memory_search", {
      query: "nightly batch window opens UTC",
      as_of: "2024-01-01T00:00:00Z",
      limit: 20
    })
    const thenHits = then.hits as ReadonlyArray<{ path: string; superseded_by: string | null }>
    const thenPaths = thenHits.map((hit) => hit.path)
    expect(thenPaths).toContain(archivedPath)
    expect(thenPaths).not.toContain(corrected.path)
    expect(thenHits.find((hit) => hit.path === archivedPath)?.superseded_by).toBe(corrected.path)

    // No as_of: the present, byte-for-byte today's behavior — the correction, marker null.
    const now = await call("memory_search", {
      query: "nightly batch window opens UTC",
      limit: 20
    })
    const nowHits = now.hits as ReadonlyArray<{ path: string; superseded_by: string | null }>
    expect(nowHits.map((hit) => hit.path)).toContain(corrected.path)
    expect(nowHits.map((hit) => hit.path)).not.toContain(archivedPath)
    for (const hit of nowHits) expect(hit.superseded_by).toBeNull()

    // As of after the hand-off: the correction's window is open.
    const later = await call("memory_search", {
      query: "nightly batch window opens UTC",
      as_of: "2026-06-01T00:00:00Z",
      limit: 20
    })
    const laterPaths = (later.hits as ReadonlyArray<{ path: string }>).map((hit) => hit.path)
    expect(laterPaths).toContain(corrected.path)
    expect(laterPaths).not.toContain(archivedPath)
  })

  /**
   * The batch door, through the same `kit.handle` every test above uses — so the ops array survives
   * DECODE as a nested struct array and the per-op results survive ENCODE, which is the half a handler
   * -level test would skip.
   */
  describe("memory_write_batch", () => {
    /** Every per-op result the wire carries, so a cast per assertion is not needed. */
    interface WireResult {
      readonly index: number
      readonly ok: boolean
      readonly path: string | null
      readonly deduped: boolean
      readonly existing_path: string | null
      readonly code: string | null
      readonly error: string | null
      readonly skipped: boolean
      readonly conflict: {
        readonly path: string | null
        readonly batch_index: number | null
        readonly claim: string
      } | null
      readonly near_duplicates: ReadonlyArray<{
        readonly path: string | null
        readonly batch_index: number | null
        readonly similarity: number
        readonly claim: string
      }> | null
    }
    const resultsOf = (batch: Record<string, unknown>): ReadonlyArray<WireResult> =>
      batch.results as ReadonlyArray<WireResult>

    it("writes three ops in ONE commit, reporting three results in input order", async () => {
      /**
       * The whole point of the tool, and the assertion that makes it a batch rather than a loop: the
       * commit count moves by exactly ONE for three written files. `memory_status.head_sha` before and
       * after is the observable — three singular writes would move HEAD three times, so this fails on
       * any implementation that folded the ops into `writeMemory` calls.
       *
       * The `commit_sha` the tool RETURNS is asserted to be that same new HEAD, which is what ties the
       * reported sha to the tree a caller would go read.
       */
      const before = (await call("memory_status", {})).head_sha as string
      const commitsBefore = await commitCount()

      const batch = await call("memory_write_batch", {
        ops: [
          {
            title: "Batch op one: the connection pool ceiling",
            body: "The connection pool ceiling is 64 per instance. Raising it past that starves the event loop before it helps throughput.",
            memory_type: "semantic",
            workspace: "batch-demo",
            tags: ["pool"]
          },
          {
            title: "Batch op two: the brownout runbook step order",
            body: "Shed read traffic before write traffic during a brownout. Writes carry the queue depth the reads are waiting on.",
            memory_type: "procedural",
            workspace: "batch-demo"
          },
          {
            title: "Batch op three: the retry storm of last March",
            article_html:
              "<p><mark>A retry storm saturated the pool before any alarm fired.</mark> " +
              'Observed on <time datetime="2026-03-11">March 11</time>.</p>',
            memory_type: "episodic",
            workspace: "batch-demo"
          }
        ],
        session_id: "b8a1c0de-1111-4222-8333-444455556666"
      })

      const results = resultsOf(batch)
      expect(results).toHaveLength(3)
      // In INPUT ORDER, and each naming its own index — the contract an agent indexes results by.
      expect(results.map((result) => result.index)).toEqual([0, 1, 2])
      expect(results.every((result) => result.ok)).toBe(true)
      expect(results.every((result) => result.path !== null)).toBe(true)
      expect(results.every((result) => result.deduped)).toBe(false)
      expect(results.every((result) => result.skipped)).toBe(false)
      // Never-failed ops carry null in both failure fields rather than omitting them.
      expect(results.every((result) => result.code === null && result.error === null)).toBe(true)
      /**
       * `conflict` is PRESENT and null on a call that did not ask for it — the field is in the encoded
       * payload, not merely absent from it. A client reading an absent key cannot tell "this op
       * contradicts nothing" from "this build does not check", and those decide opposite things.
       *
       * Checked with `in` and not just `=== null`, because `undefined === null` is false but a MISSING
       * key would fail the `=== null` check for the wrong reason and read as if the field were populated
       * incorrectly. Both halves are the assertion.
       */
      expect(results.every((result) => "conflict" in result)).toBe(true)
      expect(results.every((result) => result.conflict === null)).toBe(true)
      // `near_duplicates` follows the same present-and-null rule, with the same two-halves check —
      // and the batch-level degraded flag is false on a call that never asked for the assist.
      expect(results.every((result) => "near_duplicates" in result)).toBe(true)
      expect(results.every((result) => result.near_duplicates === null)).toBe(true)
      expect(batch.near_duplicates_degraded).toBe(false)

      expect(batch.summary).toEqual({
        total: 3,
        written: 3,
        deduped: 0,
        failed: 0,
        skipped: 0,
        consolidated: 0
      })

      const after = (await call("memory_status", {})).head_sha as string
      expect(after).not.toBe(before)
      expect(batch.commit_sha).toBe(after)
      // ONE commit for three files. This is the assertion the whole tool exists for, and it is the one
      // that fails on any implementation that folded the ops into three `writeMemory` calls — which
      // would move HEAD three times and pass every other assertion in this test.
      expect(await commitCount()).toBe(commitsBefore + 1)

      // And ONE reindex that actually landed — the index describes the new commit, so the batch's
      // files are retrievable rather than committed-but-invisible.
      const status = await call("memory_status", {})
      expect(status.index_fresh).toBe(true)
      const listed = await call("memory_list", { workspace: "batch-demo" })
      expect(listed.files as ReadonlyArray<unknown>).toHaveLength(3)
    })

    it("returns ok with deduped=true for an op whose content is already stored", async () => {
      /**
       * D5, at the door. A duplicate is NOT an error — an agent that read a failure here would try to
       * repair something, and in atomic mode a duplicate treated as a failure would abort a batch whose
       * other ops were perfectly good.
       *
       * Two duplicates in one call, deliberately: op 0 collides with the previous test's write (against
       * the STORE) and op 1 collides with op 0 (against the batch's own folded state), which are two
       * different lookups in `writeMemories` and only one of them is exercised by a store-only case.
       */
      const body =
        "The connection pool ceiling is 64 per instance. Raising it past that starves the event loop before it helps throughput."
      const batch = await call("memory_write_batch", {
        ops: [
          {
            title: "Batch op one: the connection pool ceiling",
            body,
            memory_type: "semantic",
            workspace: "batch-demo",
            tags: ["pool"]
          },
          {
            title: "Batch op one: the connection pool ceiling",
            body,
            memory_type: "semantic",
            workspace: "batch-demo",
            tags: ["pool"]
          }
        ]
      })

      const results = resultsOf(batch)
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result.ok).toBe(true)
        expect(result.deduped).toBe(true)
        // The EXISTING path comes back, so the agent knows where its content already lives without a
        // second call.
        expect(result.existing_path).toMatch(/^projects\/batch-demo\//)
        expect(result.path).toBe(result.existing_path)
        expect(result.code).toBeNull()
      }
      expect(batch.summary).toEqual({
        total: 2,
        written: 0,
        deduped: 2,
        failed: 0,
        skipped: 0,
        consolidated: 0
      })
      // An all-deduped batch wrote no file, so it made NO commit — and says so with a null sha rather
      // than by reporting the previous HEAD, which would look like it had committed.
      expect(batch.commit_sha).toBeNull()
    })

    it("refuses the WHOLE batch, naming the op, when one op supplies both body and article_html", async () => {
      /**
       * The per-op XOR in ATOMIC mode. Three things have to be true at once and each one is a separate
       * failure an agent would act wrongly on:
       *
       * 1. It is a ToolFailure — the error channel — not a success carrying failed results. An agent
       *    that has to inspect a success payload to learn its call did nothing will not.
       * 2. The text names the OFFENDING OP by index. `results` is absent on this path, so without the
       *    index an agent holding N ops knows only that one of them was wrong.
       * 3. The code is ERR_INVALID_MEMORY and the text is NOT the internal-error string — which is what
       *    the `failure: ToolFailure` declaration on the new tool buys, and it is invisible in any
       *    response SHAPE (see the failure.test.ts note on the three catch branches).
       */
      const before = (await call("memory_status", {})).head_sha as string
      const commitsBefore = await commitCount()
      const attempt = call("memory_write_batch", {
        ops: [
          {
            title: "Batch atomic op one, perfectly writable",
            body: "This op is fine and must still not be written.",
            memory_type: "semantic",
            workspace: "batch-atomic"
          },
          {
            title: "Batch atomic op two, ambiguous authoring",
            body: "Prose that would become a claim.",
            article_html: "<p><mark>Markup that carries its own claim.</mark></p>",
            memory_type: "semantic",
            workspace: "batch-atomic"
          },
          {
            title: "Batch atomic op three, also writable",
            body: "This op is also fine and must also not be written.",
            memory_type: "semantic",
            workspace: "batch-atomic"
          }
        ]
      })

      await expect(attempt).rejects.toThrow(/ops\[1\]/)
      await expect(attempt).rejects.toThrow(/exactly one of body or article_html/)
      await expect(attempt).rejects.toThrow(/ERR_INVALID_MEMORY/)
      await expect(attempt).rejects.not.toThrow(/internal server error/i)

      // Nothing was written: not the offending op, and not the two ops that would have succeeded. The
      // tree is byte-identical — no commit, and nothing staged or left dirty either.
      const status = await call("memory_status", {})
      expect(status.head_sha).toBe(before)
      expect(status.dirty).toBe(false)
      expect(await commitCount()).toBe(commitsBefore)
      const listed = await call("memory_list", { workspace: "batch-atomic" })
      expect(listed.files as ReadonlyArray<unknown>).toHaveLength(0)
    })

    it("refuses the whole batch for an op that supplies NEITHER, naming that op too", async () => {
      // The other half of the XOR, and it must name its op the same way: an agent that omitted a body
      // on one of twenty ops needs to know which one, not that the rule exists.
      const before = (await call("memory_status", {})).head_sha as string
      await expect(
        call("memory_write_batch", {
          ops: [
            {
              title: "A writable op ahead of an empty one",
              body: "Fine.",
              memory_type: "semantic",
              workspace: "batch-neither"
            },
            { title: "An op with no article at all", memory_type: "semantic" }
          ]
        })
      ).rejects.toThrow(/ops\[1\].*exactly one of body or article_html/s)
      expect((await call("memory_status", {})).head_sha).toBe(before)
    })

    it("serves an op that blanks the authoring field it did not use", async () => {
      /**
       * "A blank string counts as absent", asserted INSIDE a batch op and as a SUCCESS — the
       * discriminating case from the prior lesson. The refusal tests above pass under a presence-only
       * `!== undefined` check too, so a mutant dropping `.trim() !== ""` from `authored` survives them;
       * this is the one that fails, because a client whose op template carries both fields sends
       * `article_html: ""` to mean "prose, not markup" and must be WRITTEN rather than refused.
       *
       * Both directions in one batch, because an op template can blank either side, and because a batch
       * is the place a per-op check could plausibly be written differently from the singular's.
       */
      const batch = await call("memory_write_batch", {
        ops: [
          {
            title: "A batch op supplying prose with the markup field blanked",
            body: "An op that blanks the field it did not use is supplying prose.",
            article_html: "",
            memory_type: "semantic",
            workspace: "batch-blank"
          },
          {
            title: "A batch op supplying markup with the prose field blanked",
            body: "   ",
            article_html:
              "<p><mark>Blanking the prose field in an op still means markup.</mark></p>",
            memory_type: "semantic",
            workspace: "batch-blank"
          }
        ]
      })

      const results = resultsOf(batch)
      expect(results.every((result) => result.ok && !result.deduped)).toBe(true)
      expect(batch.summary).toMatchObject({ total: 2, written: 2, failed: 0 })

      // And op 1 took the MARKUP path: the gist is the authored `<mark>`, not the `""` that
      // `claimFromProse("   ")` would have produced.
      const markup = results[1]?.path as string
      expect((await call("memory_read", { path: markup })).gist).toBe(
        "Blanking the prose field in an op still means markup."
      )
    })

    it("reports the refused op and writes the survivors when continue_on_error is set", async () => {
      /**
       * AC-6-3 at the door, and the index splice is the thing under test. `batchWrite` only ever sees
       * the SURVIVORS, so it indexes its results in a two-element array while the caller sent three —
       * a handler that passed those indices through would report the last op as index 1 and leave index
       * 2 looking unreached. So the assertion is on the identity of each result, not only on the counts.
       */
      const commitsBefore = await commitCount()
      const batch = await call("memory_write_batch", {
        ops: [
          {
            title: "Continue op one, written",
            body: "The first surviving op of a best-effort batch.",
            memory_type: "semantic",
            workspace: "batch-continue"
          },
          {
            title: "Continue op two, ambiguous and refused",
            body: "Prose.",
            article_html: "<p><mark>Markup.</mark></p>",
            memory_type: "semantic",
            workspace: "batch-continue"
          },
          {
            title: "Continue op three, written",
            body: "The second surviving op, which must not be shifted into index 1.",
            memory_type: "semantic",
            workspace: "batch-continue"
          }
        ],
        continue_on_error: true
      })

      const results = resultsOf(batch)
      expect(results.map((result) => result.index)).toEqual([0, 1, 2])

      // Op 1 failed, in place, with the per-op code and reason — not as a thrown ToolFailure.
      expect(results[1]?.ok).toBe(false)
      expect(results[1]?.skipped).toBe(false)
      expect(results[1]?.code).toBe("ERR_INVALID_MEMORY")
      expect(results[1]?.error).toMatch(/exactly one of body or article_html/)
      expect(results[1]?.path).toBeNull()

      // Ops 0 and 2 were written, and op 2 is at index 2 — the splice, which a pass-through of
      // `batchWrite`'s own indices would have put at 1.
      for (const at of [0, 2]) {
        expect(results[at]?.ok).toBe(true)
        expect(results[at]?.path).not.toBeNull()
        expect(results[at]?.code).toBeNull()
      }

      expect(batch.summary).toEqual({
        total: 3,
        written: 2,
        deduped: 0,
        failed: 1,
        skipped: 0,
        consolidated: 0
      })
      // `total` counts the ops the CALLER sent, not the ones `batchWrite` saw — a summary a client
      // could not reconcile with `results.length` is one it cannot use.
      expect(batch.summary).toMatchObject({ total: results.length })

      // The survivors still landed in ONE commit: a refused op costs its own write, not the batch's
      // atomicity.
      expect(batch.commit_sha).not.toBeNull()
      expect(await commitCount()).toBe(commitsBefore + 1)
      const listed = await call("memory_list", { workspace: "batch-continue" })
      expect(listed.files as ReadonlyArray<unknown>).toHaveLength(2)
    })

    it("refuses an op whose markup violates the format, and never bypasses the render gate", async () => {
      /**
       * AC-6-8 at the door, and it is the test that caught a real bug. The store's render gate is the
       * ONLY thing that owns constraint 1, and the batch path must not be a way around it — markup with
       * no `<mark>` in an op has to be refused with the same violation text the singular produces,
       * batch-fatal in atomic mode.
       *
       * The bug: a gate refusal happens INSIDE `batchWrite`, which reports it as a well-formed aborted
       * result — every op present, one failed, `commitSha: null`. Returned verbatim, that is a SUCCESS
       * response for a call that wrote nothing, so the handler's own XOR refusal (an error) and the
       * gate's (a success) were two channels for one outcome, and the description's promise that "the
       * first refused op aborts the whole call" was false for every refusal the handler did not itself
       * detect. So this rejects, and it names its op the same way the XOR path does.
       */
      const before = (await call("memory_status", {})).head_sha as string
      const commitsBefore = await commitCount()
      const attempt = call("memory_write_batch", {
        ops: [
          {
            title: "A writable op ahead of one the render gate refuses",
            body: "Fine prose.",
            memory_type: "semantic",
            workspace: "batch-gate"
          },
          {
            title: "An op whose markup has no claim span",
            article_html: "<p>Prose with no mark at all.</p>",
            memory_type: "semantic",
            workspace: "batch-gate"
          }
        ]
      })
      await expect(attempt).rejects.toThrow(/no <mark>/)
      // The SAME shape the XOR abort produces: op index, the store's code, and the atomicity statement.
      await expect(attempt).rejects.toThrow(/ops\[1\]/)
      await expect(attempt).rejects.toThrow(/ERR_INVALID_MEMORY/)
      await expect(attempt).rejects.toThrow(/nothing was written/)
      await expect(attempt).rejects.not.toThrow(/internal server error/i)

      const status = await call("memory_status", {})
      expect(status.head_sha).toBe(before)
      expect(status.dirty).toBe(false)
      expect(await commitCount()).toBe(commitsBefore)
      // Not even the op that WOULD have been written: an atomic abort leaves a byte-identical tree.
      const listed = await call("memory_list", { workspace: "batch-gate" })
      expect(listed.files as ReadonlyArray<unknown>).toHaveLength(0)
    })

    it("reports a gate refusal per-op in continue mode, writing the survivor", async () => {
      /**
       * The other half of AC-6-8: the render gate is per-op in continue mode, so the refusal is a FAILED
       * RESULT rather than an abort, and the surviving op still lands in the one commit. Paired with the
       * atomic case above deliberately — a handler that routed every gate refusal to the error channel
       * would pass that test and fail this one, and the pair is what pins the mode to the channel.
       */
      const commitsBefore = await commitCount()
      const batch = await call("memory_write_batch", {
        ops: [
          {
            title: "An op the gate refuses in continue mode",
            article_html: "<p>Still no mark anywhere.</p>",
            memory_type: "semantic",
            workspace: "batch-gate-continue"
          },
          {
            title: "The survivor of a gate refusal",
            body: "This op must land in the one commit.",
            memory_type: "semantic",
            workspace: "batch-gate-continue"
          }
        ],
        continue_on_error: true
      })
      const results = resultsOf(batch)
      expect(results[0]?.ok).toBe(false)
      expect(results[0]?.code).toBe("ERR_INVALID_MEMORY")
      expect(results[0]?.error).toMatch(/no <mark>/)
      expect(results[1]?.ok).toBe(true)
      expect(results[1]?.path).not.toBeNull()
      expect(batch.summary).toEqual({
        total: 2,
        written: 1,
        deduped: 0,
        failed: 1,
        skipped: 0,
        consolidated: 0
      })
      expect(await commitCount()).toBe(commitsBefore + 1)
    })

    it("accepts an empty ops array as a no-op rather than refusing it", async () => {
      // A caller that filtered its op list down to nothing gets an honest empty batch: no commit, empty
      // results, zeroed summary. Refusing would make "write whatever survived my filter" a call the
      // agent has to guard.
      const before = (await call("memory_status", {})).head_sha as string
      const batch = await call("memory_write_batch", { ops: [] })
      expect(resultsOf(batch)).toEqual([])
      expect(batch.summary).toEqual({
        total: 0,
        written: 0,
        deduped: 0,
        failed: 0,
        skipped: 0,
        consolidated: 0
      })
      expect(batch.commit_sha).toBeNull()
      expect((await call("memory_status", {})).head_sha).toBe(before)
    })

    it("takes per-op provenance over the batch's own", async () => {
      /**
       * The precedence `batchWrite` implements, asserted where it is observable: in the FILE's head, not
       * in the index, since that is what survives a rebuild. A batch call carries the session the agent
       * is in and an op may name its own — a replay of an earlier session's writes — and per-op wins
       * because it is the more specific statement about where that one memory came from.
       */
      const batch = await call("memory_write_batch", {
        ops: [
          {
            title: "An op inheriting the batch session",
            body: "This op named no session of its own.",
            memory_type: "semantic",
            workspace: "batch-provenance"
          },
          {
            title: "An op naming its own session",
            body: "This op replays a write from an earlier session.",
            memory_type: "semantic",
            workspace: "batch-provenance",
            session_id: "0f0f0f0f-2222-4333-8444-555566667777"
          }
        ],
        session_id: "aaaaaaaa-3333-4444-8555-666677778888"
      })
      const results = resultsOf(batch)
      const inherited = await call("memory_read", { path: results[0]?.path as string })
      const owned = await call("memory_read", { path: results[1]?.path as string })
      expect((inherited.meta as Record<string, string>).sessionId).toBe(
        "aaaaaaaa-3333-4444-8555-666677778888"
      )
      expect((owned.meta as Record<string, string>).sessionId).toBe(
        "0f0f0f0f-2222-4333-8444-555566667777"
      )
    })

    /**
     * `detect_conflicts` over the wire (AC-1-2): DECODE of the new parameter, and ENCODE of the nested
     * `conflict` struct — the two halves a handler-level test would skip, and the second is the first
     * nested struct this tool's success schema has ever carried.
     */
    describe("detect_conflicts", () => {
      /**
       * A frame slot is GLOBAL STATE in this suite, and each test below therefore owns its own.
       *
       * Every test in this file shares ONE fixture repo, so a claim written by any earlier test is a
       * live occupant of its slot for every later one. Two of these tests failed on their first run
       * for exactly that: `the retry budget is` was already held by the correction test at :568, and
       * `the pool ceiling is` had TWO live occupants by the time the archive test ran, so the lookup's
       * `ORDER BY path` answered with the other one. Both times the assist was right and the fixture
       * was careless.
       *
       * So the slots are distinct per test and named for it. The alternative — a fresh repo per test —
       * would cost the property this suite exists to have: every test runs against a corpus other tests
       * have already written to, which is what a real one looks like.
       */
      const CEILING_64 = "The pool ceiling is 64."
      const CEILING_128 = "The pool ceiling is 128."

      it("carries a store match's path and claim through ENCODE, and the write still lands", async () => {
        const first = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire ceiling now",
              body: CEILING_64,
              memory_type: "semantic",
              workspace: "batch-conflict"
            }
          ]
        })
        const storedPath = resultsOf(first)[0]?.path
        const commitsBefore = await commitCount()

        const second = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire ceiling later",
              body: CEILING_128,
              memory_type: "semantic",
              workspace: "batch-conflict"
            }
          ],
          detect_conflicts: true
        })

        const conflict = resultsOf(second)[0]?.conflict
        // The nested struct survived ENCODE with all three fields, `batchIndex` renamed to `batch_index`.
        expect(conflict).not.toBeNull()
        expect(conflict?.path).toBe(storedPath)
        expect(conflict?.claim).toBe(CEILING_64)
        expect(conflict?.batch_index).toBeNull()

        /**
         * PROPOSE-ONLY, asserted at the wire and against the REPO rather than only the payload: the op
         * is `ok`, it made a commit, and BOTH memories are listed afterwards. An assist that refused or
         * archived would pass every assertion above this line.
         */
        expect(resultsOf(second)[0]?.ok).toBe(true)
        expect(second.summary).toEqual({
          total: 1,
          written: 1,
          deduped: 0,
          failed: 0,
          skipped: 0,
          consolidated: 0
        })
        expect(second.commit_sha).not.toBeNull()
        expect(await commitCount()).toBe(commitsBefore + 1)
        const listed = await call("memory_list", { workspace: "batch-conflict" })
        expect(listed.files as ReadonlyArray<unknown>).toHaveLength(2)
      })

      it("reports null WITHOUT the flag, on a batch that would otherwise light up", async () => {
        /**
         * The flag-off lock at the WIRE, and it exists because a mutation exposed its absence.
         *
         * Forcing `detectConflicts: true` in the handler left all 40 wire tests green — the 3-op test
         * asserts `conflict === null`, but its ops share no frame slot, so they report null either way.
         * Every other flag-off evidence lived at the operations layer, which cannot see the handler.
         * So the door needs its own test over ops that WOULD conflict: these two share
         * `the index lock is`, and a default-on handler reports on op 1.
         */
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire flag-off one",
              body: "The index lock is exclusive.",
              memory_type: "semantic",
              workspace: "batch-conflict-off"
            },
            {
              title: "Wire flag-off two",
              body: "The index lock is advisory.",
              memory_type: "semantic",
              workspace: "batch-conflict-off"
            }
          ]
        })
        const results = resultsOf(batch)
        expect(results.every((result) => result.conflict === null)).toBe(true)
        expect(batch.summary).toEqual({
          total: 2,
          written: 2,
          deduped: 0,
          failed: 0,
          skipped: 0,
          consolidated: 0
        })
      })

      it("carries an intra-batch match as batch_index with a null path", async () => {
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire intra one",
              body: "The shard rebalance interval is 30 minutes.",
              memory_type: "semantic",
              workspace: "batch-conflict-intra"
            },
            {
              title: "Wire intra two",
              body: "The shard rebalance interval is 90 minutes.",
              memory_type: "semantic",
              workspace: "batch-conflict-intra"
            }
          ],
          detect_conflicts: true
        })

        const results = resultsOf(batch)
        expect(results[0]?.conflict).toBeNull()
        expect(results[1]?.conflict?.batch_index).toBe(0)
        expect(results[1]?.conflict?.path).toBeNull()
        expect(results[1]?.conflict?.claim).toBe("The shard rebalance interval is 30 minutes.")
        // Both wrote, in the one commit.
        expect(batch.summary).toEqual({
          total: 2,
          written: 2,
          deduped: 0,
          failed: 0,
          skipped: 0,
          consolidated: 0
        })
        const listed = await call("memory_list", { workspace: "batch-conflict-intra" })
        expect(listed.files as ReadonlyArray<unknown>).toHaveLength(2)
      })

      it("translates batch_index into the CALLER's index space in continue mode", async () => {
        /**
         * The bug this test exists for. `batchWrite` only ever sees the SURVIVORS, so an intra-batch
         * finding it produces names a position in that shorter array — and with an XOR-refused op ahead
         * of the conflicting pair, survivor 0 is the caller's op 1. A handler that passed the number
         * through would name op 0 (the refused one) as the thing op 2 contradicts, which is both wrong
         * and plausible enough to go unnoticed: it is an in-range index on an op that exists.
         *
         * Op 0 is refused for the XOR, ops 1 and 2 share a frame slot. The correct answer is
         * `batch_index: 1`; the bug's answer is `0`.
         */
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire shift op zero, refused for the XOR",
              body: "Prose.",
              article_html: "<p><mark>And markup.</mark></p>",
              memory_type: "semantic",
              workspace: "batch-conflict-shift"
            },
            {
              title: "Wire shift op one",
              body: "The deploy window is Tuesday.",
              memory_type: "semantic",
              workspace: "batch-conflict-shift"
            },
            {
              title: "Wire shift op two",
              body: "The deploy window is Thursday.",
              memory_type: "semantic",
              workspace: "batch-conflict-shift"
            }
          ],
          continue_on_error: true,
          detect_conflicts: true
        })

        const results = resultsOf(batch)
        expect(results.map((result) => result.index)).toEqual([0, 1, 2])
        // Op 0 was refused and carries no conflict — it has no claim to derive one from.
        expect(results[0]?.ok).toBe(false)
        expect(results[0]?.conflict).toBeNull()
        // THE ASSERTION: op 2 names op ONE, in the caller's own numbering.
        expect(results[2]?.conflict?.batch_index).toBe(1)
        expect(results[2]?.conflict?.claim).toBe("The deploy window is Tuesday.")
        expect(batch.summary).toEqual({
          total: 3,
          written: 2,
          deduped: 0,
          failed: 1,
          skipped: 0,
          consolidated: 0
        })
      })

      it("reports null for a claim with no frame shape and for an article_html op", async () => {
        /**
         * Two different reasons for the same null, in one call. The short claim is the guard failing
         * closed; the markup op is the honest v1 boundary — the claim lives inside the caller's markup
         * and the ops layer never reads it, which the tool description states rather than hides.
         *
         * The markup op's `<mark>` is deliberately a claim that WOULD key and WOULD match the other op,
         * so a null here is the boundary rather than an absence of anything to find.
         */
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire null one, sub-threshold frame",
              body: "Ship it.",
              memory_type: "semantic",
              workspace: "batch-conflict-null"
            },
            {
              title: "Wire null two, keying prose",
              body: "The rollout owner is Priya.",
              memory_type: "semantic",
              workspace: "batch-conflict-null"
            },
            {
              title: "Wire null three, the same slot but authored as markup",
              article_html: "<p><mark>The rollout owner is Dana.</mark></p>",
              memory_type: "semantic",
              workspace: "batch-conflict-null"
            }
          ],
          detect_conflicts: true
        })

        const results = resultsOf(batch)
        expect(results.every((result) => result.conflict === null)).toBe(true)
        expect(results.every((result) => result.ok)).toBe(true)
        expect(batch.summary).toMatchObject({ total: 3, written: 3, failed: 0 })
      })

      it("decodes an explicit null for detect_conflicts as absent, like every other optional", async () => {
        /**
         * The `Optional` contract on the new parameter: a client that reads the published schema sees
         * `null` advertised and sends it for "not supplied", which must DECODE and behave as off. This is
         * the exact pair — schema says yes, decoder says no — this repo has already shipped once.
         */
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire explicit null flag",
              body: "The cache ttl is 300 seconds.",
              memory_type: "semantic",
              workspace: "batch-conflict-nullflag"
            }
          ],
          detect_conflicts: null
        })
        expect(resultsOf(batch)[0]?.conflict).toBeNull()
        expect(batch.summary).toMatchObject({ total: 1, written: 1, failed: 0 })
      })

      it("never names an ARCHIVED memory, so a correction stops contradicting itself", async () => {
        /**
         * By TRANSITION, at the wire: found while active, then archived through `memory_archive`, then
         * not found. Seeding an already-archived row would pass against a query filtering the wrong
         * column.
         */
        const written = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire archive quorum",
              body: "The write quorum is two replicas.",
              memory_type: "semantic",
              workspace: "batch-conflict-archive"
            }
          ]
        })
        const storedPath = resultsOf(written)[0]?.path as string

        const before = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire archive probe",
              body: "The write quorum is three replicas.",
              memory_type: "semantic",
              workspace: "batch-conflict-archive"
            }
          ],
          detect_conflicts: true
        })
        expect(resultsOf(before)[0]?.conflict?.path).toBe(storedPath)
        const probePath = resultsOf(before)[0]?.path as string

        // BOTH live occupants of the slot are archived — the probe above became the second one.
        await call("memory_archive", { path: storedPath, reason: "superseded" })
        await call("memory_archive", { path: probePath, reason: "superseded" })

        const after = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire archive after",
              body: "The write quorum is four replicas.",
              memory_type: "semantic",
              workspace: "batch-conflict-archive"
            }
          ],
          detect_conflicts: true
        })
        expect(resultsOf(after)[0]?.conflict).toBeNull()
        expect(after.summary).toMatchObject({ total: 1, written: 1, failed: 0 })
      })
    })

    /**
     * `detect_near_duplicates` over the wire: DECODE of the new parameter, ENCODE of the nested
     * entry list, and the batch-level degraded flag — the same three halves the `detect_conflicts`
     * suite pins, one field over.
     *
     * The suite's shared-fixture rule applies with a wider blast radius here: the lookup scans the
     * WHOLE active corpus by cosine, not one frame slot, so these claims carry vocabulary
     * (quorum-election coordinators, leap-second smearing) no other test in this file uses, or an
     * earlier test's memory becomes a legitimate extra finding under the bag-of-words embedder.
     */
    describe("detect_near_duplicates", () => {
      const ELECTION =
        "The quorum election coordinator resigns after three missed heartbeats from the observers."
      const ELECTION_REWORDED =
        "After three missed heartbeats from the observers the quorum election coordinator resigns."

      it("carries a store match's path, claim, and similarity through ENCODE, and the write still lands", async () => {
        const first = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire election rule",
              body: ELECTION,
              memory_type: "semantic",
              workspace: "batch-near"
            }
          ]
        })
        const storedPath = resultsOf(first)[0]?.path

        const second = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire election rule restated",
              body: ELECTION_REWORDED,
              memory_type: "semantic",
              workspace: "batch-near"
            }
          ],
          detect_near_duplicates: true
        })

        const hits = resultsOf(second)[0]?.near_duplicates
        expect(hits).toHaveLength(1)
        expect(hits?.[0]?.path).toBe(storedPath)
        expect(hits?.[0]?.claim).toBe(ELECTION)
        expect(hits?.[0]?.batch_index).toBeNull()
        expect(hits?.[0]?.similarity).toBeGreaterThanOrEqual(0.92)
        expect(second.near_duplicates_degraded).toBe(false)

        // PROPOSE-ONLY at the wire: the op is ok, it committed, and BOTH memories are listed after.
        expect(resultsOf(second)[0]?.ok).toBe(true)
        expect(second.summary).toMatchObject({ total: 1, written: 1, failed: 0 })
        expect(second.commit_sha).not.toBeNull()
        const listed = await call("memory_list", { workspace: "batch-near" })
        expect(listed.files as ReadonlyArray<unknown>).toHaveLength(2)
      })

      it("reports null WITHOUT the flag, on a pair that would otherwise light up", async () => {
        // The flag-off lock at the wire, for the reason `detect_conflicts`' twin exists: a handler
        // forcing the assist on is invisible to every test whose ops share nothing.
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire smear one",
              body: "The leap second smears across the final twelve hours of June.",
              memory_type: "semantic",
              workspace: "batch-near-off"
            },
            {
              title: "Wire smear two",
              body: "Across the final twelve hours of June the leap second smears.",
              memory_type: "semantic",
              workspace: "batch-near-off"
            }
          ]
        })
        const results = resultsOf(batch)
        expect(results.every((result) => result.near_duplicates === null)).toBe(true)
        expect(batch.near_duplicates_degraded).toBe(false)
        expect(batch.summary).toMatchObject({ total: 2, written: 2, failed: 0 })
      })

      it("carries an intra-batch match as batch_index with a null path, translated to the CALLER's index space", async () => {
        /**
         * Both intra-batch properties in one call, in continue mode with an XOR-refused op 0 ahead
         * of the pair — the exact arrangement that caught the untranslated `conflict.batch_index`.
         * `batchWrite` saw the survivors, where the match is (0, 1); the caller must read (1, 2).
         */
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire near shift zero, refused for the XOR",
              body: "Prose.",
              article_html: "<p><mark>And markup.</mark></p>",
              memory_type: "semantic",
              workspace: "batch-near-shift"
            },
            {
              title: "Wire compaction rule",
              body: "The tombstone compaction debt drains during the idle replica window.",
              memory_type: "semantic",
              workspace: "batch-near-shift"
            },
            {
              title: "Wire compaction rule restated",
              body: "During the idle replica window the tombstone compaction debt drains.",
              memory_type: "semantic",
              workspace: "batch-near-shift"
            }
          ],
          continue_on_error: true,
          detect_near_duplicates: true
        })

        const results = resultsOf(batch)
        expect(results[0]?.ok).toBe(false)
        expect(results[0]?.near_duplicates).toBeNull()
        // Asymmetric: the later op reports on the earlier one, never the reverse.
        expect(results[1]?.near_duplicates).toBeNull()
        // THE ASSERTION: op 2 names op ONE in the caller's numbering, with no path — that op's
        // file did not exist when the assist ran.
        expect(results[2]?.near_duplicates?.[0]?.batch_index).toBe(1)
        expect(results[2]?.near_duplicates?.[0]?.path).toBeNull()
        expect(results[2]?.near_duplicates?.[0]?.claim).toBe(
          "The tombstone compaction debt drains during the idle replica window."
        )
        expect(batch.summary).toMatchObject({ total: 3, written: 2, failed: 1 })
      })

      it("decodes an explicit null for detect_near_duplicates as absent, like every other optional", async () => {
        const batch = await call("memory_write_batch", {
          ops: [
            {
              title: "Wire near explicit null flag",
              body: "The snapshot fencing token rotates on every checkpoint boundary.",
              memory_type: "semantic",
              workspace: "batch-near-nullflag"
            }
          ],
          detect_near_duplicates: null
        })
        expect(resultsOf(batch)[0]?.near_duplicates).toBeNull()
        expect(batch.near_duplicates_degraded).toBe(false)
        expect(batch.summary).toMatchObject({ total: 1, written: 1, failed: 0 })
      })
    })
  })

  it("refuses article_html that violates the format, before anything is committed", async () => {
    /**
     * The division of labour, asserted at the tool. The handler owns the XOR and NOTHING about the
     * markup; the store's render gate owns constraint 1. So markup with no `<mark>` must be refused
     * HERE too — reaching the caller as prose through the same one error channel — rather than
     * landing in a commit the indexer then declines to project.
     */
    await expect(
      call("memory_write", {
        title: "Markup with no claim span",
        article_html: "<p>Prose with no mark at all.</p>",
        memory_type: "semantic"
      })
    ).rejects.toThrow(/no <mark>/)

    const status = await call("memory_status", {})
    // The refusal left the tree clean: no partial file, staged or otherwise.
    expect(status.dirty).toBe(false)
  })

  /**
   * Two `memory_write` calls started together land as TWO commits, each carrying its own file.
   *
   * An MCP server is the surface where this actually happens: one client, one process, many tool calls
   * in flight. Two writes racing share a git index, and the loser's staged file lands inside the
   * winner's commit while its own commit finds nothing to make — one path reported to a caller with no
   * commit of its own behind it, in a store whose whole contract is one corpus change per commit.
   *
   * The serialization lives in `makeStore`'s own semaphore, which is the only correct place for it: a
   * lock here would guard this door and leave `memhtml apply` racing the same index, and two locks over
   * one resource is a deadlock waiting for an ordering. So this asserts the OUTCOME an agent depends on
   * and nothing about the mechanism.
   *
   * Two commits and two distinct paths are both required. Two paths with one commit is exactly the
   * swallowed-file failure; one path would mean a dedupe, which these two bodies rule out.
   */
  it("serializes two concurrent writes into two commits, each with its own file", async () => {
    const before = await commitCount()
    const [first, second] = await callBoth(
      [
        "memory_write",
        {
          title: "Concurrent write one",
          body: "The first racer drains the VIP. It exists to collide with the second.",
          memory_type: "semantic",
          workspace: "concurrency-probe"
        }
      ],
      [
        "memory_write",
        {
          title: "Concurrent write two",
          body: "The second racer reverts the deploy. It exists to collide with the first.",
          memory_type: "semantic",
          workspace: "concurrency-probe"
        }
      ]
    )
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(false)
    expect(first.path).not.toBe(second.path)
    // Exactly two, not "at least two": a third would mean one call committed twice.
    expect(await commitCount()).toBe(before + 2)

    /**
     * And each file is really in the tree, which the commit count alone does not say. A commit that
     * staged nothing still moves HEAD, so reading both paths back is what proves neither write was
     * swallowed by the other's commit.
     */
    for (const path of [first.path, second.path]) {
      const read = await call("memory_read", { path })
      expect(read.path).toBe(path)
      expect(String(read.body).length + String(read.gist).length).toBeGreaterThan(0)
    }
    const status = await call("memory_status", {})
    expect(status.dirty).toBe(false)
  })
})

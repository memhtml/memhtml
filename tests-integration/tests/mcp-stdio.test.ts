import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { DatabaseService } from "@memhtml/index"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"
import { type Client, connect, failureText, handshake, structured } from "./spawned.js"

/**
 * The regression lock for `docs/bugs/2026-08-03-event-at-unreachable-through-write-paths.md`, run as
 * the bug report's own repro INVERTED: `memhtml serve mcp` in a temp repo, JSON-RPC over stdio, one
 * `memory_write` carrying the Alice fixture — and this time the `<time>` element reaches disk and
 * `files.event_at` carries the date. The fixture wording is kept verbatim from the report so the
 * lineage is greppable from either end.
 *
 * **Why a child process rather than `kit.handle`.** `apps/mcp/tests/roundtrip.test.ts` already drives
 * the toolkit in-process, which covers the parameter decode and the success encode. What it cannot
 * cover is the thing the bug report actually ran: a real client, a real transport, a real
 * `layerApp` built from the ENVIRONMENT rather than from an injected embedder. Three of the five
 * links in this chain only exist in that configuration — the supervisor's `MEMHTML_ROOT` hand-off, the
 * NDJSON framing, and `MEMHTML_EMBED=off` resolving to an absent embedder at layer-build time. A
 * passthrough that worked in-process and broke over the wire would be invisible to every other test
 * in this repo.
 *
 * **Why `memhtml serve mcp` rather than `apps/mcp/dist/bin.js` directly.** That is the command in the
 * report, so it is the command the fix has to answer. It also exercises the supervisor's one job —
 * spawn the child, keep its own hands off the database — and its clean exit is what RELEASES the
 * lock this test then needs.
 *
 * **BUILD ORDER.** This drives `dist`, not `src`. `turbo` makes `test:integration` depend on
 * `build`, and {@link cliEntryPoint} fails loudly rather than let a stale or absent build read as a
 * behavioural failure.
 *
 * **The second subject: what a FAILED call says.** The same session also makes two calls that must
 * fail, because a failure's wire text is only observable here. `McpServer` catches a failed handler and
 * decides whether to pass its message through or replace it with "Tool execution failed due to an
 * internal server error" (`McpServer.ts:831-847`), and that decision is invisible in-process — every
 * `apps/mcp` test sees the message the handler produced, not the one the client receives. This file
 * shipped for a while against a server whose every typed failure reached its agent with the code, the
 * reason, and the recovery all discarded after the handler had computed them. So the two failing calls
 * belong to the same `beforeAll` as the two writes: same transport, same server, same session.
 */

/**
 * The client, the spawn, and the two unwrappers live in `./spawned.js`.
 *
 * They were inlined here until the batch suite needed the same session shape over the same transport,
 * at which point one of two things had to be true: either two files own two NDJSON framers that can
 * disagree about where the supervisor's envelope starts, or the transport is a module. It is a module.
 */

/**
 * The fixture from the bug report, verbatim in its content and inverted in its authoring.
 *
 * The report sent this markup as `body` and got it entity-escaped inside the `<mark>`; the same
 * markup as `article_html` is the fix. Kept as one constant used by BOTH calls below, so the pair
 * differs in exactly one thing — which parameter carried it.
 */
const ALICE_MARKUP =
  "<p><mark>Alice moved to Paris.</mark> " +
  '<time datetime="2023-05-20T02:21:00Z">2023-05-20</time></p>'

/** The event time the report could not reach through any write path. */
const ALICE_EVENT_AT = "2023-05-20T02:21:00Z"

/** One `files` row's temporal columns, read after the server has let go of the database. */
const temporalRow = (
  cli: Cli,
  path: string
): Promise<{ event_at: string | null; updated_at: string; gist: string } | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService
      return yield* db.get<{ event_at: string | null; updated_at: string; gist: string }>(
        "SELECT event_at, updated_at, gist FROM files WHERE path = ?",
        [path]
      )
    }).pipe(Effect.provide(cli.layer), Effect.scoped, Effect.orDie)
  )

describe("the event_at bug report, inverted: article_html over real MCP stdio", () => {
  let cli: Cli
  let authoredPath: string
  let prosePath: string
  let tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>
  let exit: { readonly exitCode: number; readonly envelope: Record<string, unknown> }
  /** The wire text of an XOR refusal and of a read at a path with no file behind it. */
  let xorText: string
  let notFoundText: string

  beforeAll(async () => {
    /**
     * The real harness: a real temp git repo, the real `memhtml init`, real migrations. `makeCli` builds
     * its layer per invocation and releases it (`run` ends in `Effect.scoped`), so the database is
     * unlocked again by the time the child opens it — which is the ONLY reason an in-process
     * `memhtml init` and an out-of-process server can share one repo.
     */
    cli = await makeCli()

    const client: Client = connect(cli.root)

    /**
     * The handshake, asserted rather than assumed. `initialize` is where a protocol-version or
     * `serverInfo` regression would land, and it is the first thing a real client does — the design
     * doc's M4 DoD names this exact sequence (`docs/design.md:655`).
     */
    const opened = await handshake(client)
    expect(opened.protocolVersion).toBe("2025-06-18")
    expect(opened.serverInfo.name).toBe("memhtml")

    const listed = await client.rpc("tools/list", {})
    tools = (listed.result as { readonly tools: typeof tools }).tools

    /**
     * The write the report said was impossible. `body` is ABSENT, not blank — the whole article is
     * the caller's, and the `<mark>` inside it is the claim.
     */
    authoredPath = structured(
      await client.rpc("tools/call", {
        name: "memory_write",
        arguments: {
          title: "Alice moved to Paris",
          memory_type: "episodic",
          article_html: ALICE_MARKUP
        }
      })
    ).path as string

    /**
     * The report's ORIGINAL call, verbatim, as the control.
     *
     * Without it this suite would pass on an implementation that escaped both paths — or one that
     * escaped neither, which would be a sanitizer regression rather than a fix. The pair is the
     * assertion: the prose path still escapes (that is its documented contract, and prose that
     * silently became markup would be an injection surface), and `article_html` is the one way an
     * event time is authorable at all.
     */
    prosePath = structured(
      await client.rpc("tools/call", {
        name: "memory_write",
        arguments: {
          title: "Alice moved to Paris, written as prose",
          memory_type: "episodic",
          body: '<p><time datetime="2023-05-20T02:21:00Z">2023-05-20T02:21:00Z</time> Alice moved to Paris.</p>'
        }
      })
    ).path as string

    /**
     * The two FAILING calls, over the same real transport as the two writes above.
     *
     * These exist because a failure's wire text is invisible to every other test in this repo.
     * `apps/mcp/tests/failure.test.ts` proves the mapping composes the right string, and
     * `roundtrip.test.ts` proves a handler fails — but neither one crosses `McpServer`'s catch, which is
     * where the text was being REPLACED. Until the `failure:` schema landed, both of these calls came
     * back as "Tool execution failed due to an internal server error", with the code, the reason, and
     * the recovery all discarded after the handler had computed them. So the assertion has to be here,
     * on the bytes a client receives, and it has to be mutation-proven — which it was: reverting the
     * declaration on `memory_write` restores the internal-error string and fails the first test below.
     *
     * The pair is chosen for coverage of both shapes: the XOR is a refusal the WIRE BOUNDARY owns
     * (`authored` in handlers.ts), and `PathNotFound` is a refusal the store owns — so one proves a
     * handler-level failure survives and the other proves a use-case-level one does.
     */
    xorText = failureText(
      await client.rpc("tools/call", {
        name: "memory_write",
        arguments: {
          title: "Ambiguous authoring over the wire",
          memory_type: "semantic",
          body: "Prose that would become a claim.",
          article_html: "<p><mark>Markup that carries its own claim.</mark></p>"
        }
      })
    )

    notFoundText = failureText(
      await client.rpc("tools/call", {
        name: "memory_read",
        arguments: { path: "areas/oncall/never-written.html" }
      })
    )

    // Every row assertion below needs the lock back, so the shutdown is part of the setup rather
    // than an afterAll.
    exit = await client.shutdown()
  })

  afterAll(async () => {
    await cli.cleanup()
  })

  it("completes initialize -> tools/list with article_html on the published wire", () => {
    /**
     * Fourteen, and the delta is auditable rather than a number that drifts: `article_html` cost NO
     * tool (it is a parameter on `memory_write`), and `memory_write_batch` cost exactly one. So the
     * count is asserted alongside the name that raised it, and a regression that added a fifteenth
     * tool fails on the count while one that renamed the fourteenth fails on the name.
     */
    expect(tools).toHaveLength(14)
    expect(tools.map((tool) => tool.name)).toContain("memory_write_batch")
    const write = tools.find((tool) => tool.name === "memory_write")
    const schema = write?.inputSchema as {
      readonly properties: Record<string, unknown>
      readonly required: ReadonlyArray<string>
    }
    expect(Object.keys(schema.properties)).toContain("article_html")
    /**
     * NEITHER authoring field is `required`, and that is forced rather than sloppy: a JSON Schema
     * cannot express "exactly one of these two" without an `anyOf` over the whole thirteen-field
     * object twice, so the XOR lives in the handler and the schema stays flat. A client reading this
     * learns the rule from the description, which is why the description carries it.
     */
    expect(schema.required).toEqual(["title", "memory_type"])
    expect(schema.required).not.toContain("body")
  })

  it("lands the caller's <time> element on disk UNESCAPED, which body cannot", async () => {
    const authored = await readFile(join(cli.root, authoredPath), "utf8")
    // The bytes, not a parse: an escaped element is still a well-formed file, so only the raw text
    // discriminates.
    expect(authored).toContain(`<time datetime="${ALICE_EVENT_AT}">2023-05-20</time>`)
    expect(authored).not.toContain("&lt;time")
    expect(authored).toContain("<mark>Alice moved to Paris.</mark>")

    // The control, exactly as the report recorded it: markup sent as prose is text, inside the
    // claim span.
    const prose = await readFile(join(cli.root, prosePath), "utf8")
    expect(prose).toContain("&lt;time")
    expect(prose).not.toContain(`<time datetime="${ALICE_EVENT_AT}"`)
  })

  it("populates files.event_at from that element, and leaves the prose row NULL", async () => {
    /**
     * The end of the chain, and the claim the report's Impact section rests on: the recency arm
     * orders by `coalesce(event_at, updated_at)` (`packages/index/src/retrieval-sql.ts:125`), so an
     * `event_at` that stays NULL means an episodic memory sorts by when it was written down. This is
     * the row that makes backdating real.
     */
    const authored = await temporalRow(cli, authoredPath)
    expect(authored?.event_at).toBe(ALICE_EVENT_AT)
    // 2023 vs the write instant: the two columns genuinely disagree, so `coalesce` has something to
    // prefer. Equal values would make the assertion vacuous.
    expect(authored?.updated_at.startsWith("2023")).toBe(false)
    // And the gist is prose, not escaped HTML — the report's secondary effect, also gone: the
    // caller's own `<mark>` is the claim.
    expect(authored?.gist).toBe("Alice moved to Paris.")

    const prose = await temporalRow(cli, prosePath)
    expect(prose).toBeDefined()
    expect(prose?.event_at).toBeNull()
    /**
     * The report's secondary effect, still exactly as it recorded it: with no sentence terminator the
     * claim regex accepts, the whole blob became the `<mark>` — so the Tier-1 disclosure line is
     * markup-as-prose rather than a claim.
     *
     * Compared as TEXT, not as the disk bytes. `files.gist` is the `<mark>`'s text CONTENT, so the
     * `&lt;` on disk decodes back to `<` on the way into the row — which is why the report's own
     * recorded gist reads `"<p><time datetime=…"` while the file at the same path holds `&lt;time`.
     * The two are the same escaping, seen from either side of the parser, and asserting the disk form
     * here would be asserting the wrong plane.
     */
    expect(prose?.gist).toContain('<time datetime="2023-05-20T02:21:00Z">')
    expect(prose?.gist.startsWith("<p>")).toBe(true)
  })

  it("delivers an XOR refusal as prose an agent can act on, not as an internal error", () => {
    /**
     * The regression lock on the masking, at the only place it is observable: a real client reading a
     * real `tools/call` response. All three parts, because an agent needs all three and the old text had
     * none of them — the stable code it branches on, the rule it violated, and a next step it can take.
     */
    expect(xorText).toContain("ERR_INVALID_MEMORY")
    expect(xorText).toContain("exactly one of body or article_html")
    expect(xorText).toContain("both were supplied")

    /**
     * The string this task exists to delete, asserted case-insensitively because it is
     * `INTERNAL_TOOL_ERROR_MESSAGE`'s exact wording that would come back and matching loosely is what
     * makes the lock hold if effect rewords it.
     */
    expect(xorText.toLowerCase()).not.toContain("internal server error")

    /**
     * The recovery, and the most load-bearing sentence in it: the store refuses at the render gate
     * BEFORE any file or commit, so nothing was written. An agent that assumed a partial write would go
     * looking for a file to correct, or archive one that does not exist.
     */
    expect(xorText).toContain("call the same tool again")
    expect(xorText).toContain("nothing was written and no commit was made")
  })

  it("delivers a missing path with the path, and a suggestion phrased as a tool call", () => {
    expect(notFoundText).toContain("ERR_PATH_NOT_FOUND")
    // The path itself: a code that knows where the caller looked and withholds it costs a round trip.
    expect(notFoundText).toContain("areas/oncall/never-written.html")
    expect(notFoundText.toLowerCase()).not.toContain("internal server error")

    /**
     * `memory_search`, not `memhtml search`. The reader is an LLM mid-task holding fourteen tools and no
     * shell, so the CLI suggestions the envelope hands a human (`apps/cli/src/errors.ts:119`) are all
     * unreachable here — a suggestion an agent cannot execute spends its attention on a plan that ends
     * in "I have no terminal" while the recovery that WAS available goes unmentioned.
     */
    expect(notFoundText).toContain("call memory_search")
    expect(notFoundText).toContain("call memory_list")
    expect(notFoundText).not.toContain("memhtml search")
    expect(notFoundText).not.toContain("memhtml list")
  })

  it("shuts the supervisor down cleanly, which is what released the database", () => {
    /**
     * Asserted because the row reads above DEPEND on it. Turso's lock excludes a second writable
     * opener of `.memhtml/index.db`, so a supervisor that leaked the child would make `temporalRow` fail with
     * "File is locked by another process" — a confusing failure in a test whose subject is an event
     * date. The `serve.exit` envelope is also the CLI's one-envelope contract holding on a command
     * whose stdout belonged to someone else for most of its life.
     */
    expect(exit.exitCode).toBe(0)
    expect(exit.envelope.type).toBe("serve.exit")
    const data = exit.envelope.data as { readonly server: string }
    expect(data.server).toMatch(/apps\/mcp\/dist\/bin\.js$/)
  })
})

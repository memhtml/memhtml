import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Logger } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { DatabaseService, Retrieval } from "../src/api-layer.js"
import { EXIT_OK, EXIT_USAGE } from "../src/envelope.js"
import {
  GIST_MAX_CHARS,
  OPEN_TASKS_HEADER,
  PROMPT_HEADER,
  queryForCwd,
  renderPromptHits,
  renderSessionPack,
  runHook,
  sessionHeader
} from "../src/hook.js"
import { parseArgv, run, validate } from "../src/run.js"
import { type Cli, makeCli } from "./harness.js"

/**
 * `memhtml hook`: the usage refusals, the engine against a real store, and the two properties that
 * make a hook safe to install — it never writes this CLI's envelope to a host's stream, and it never
 * exits non-zero.
 *
 * A hook runs inside a developer's turn. On `UserPromptSubmit` a non-zero exit BLOCKS the prompt and
 * stdout is pasted into the model's context, so the assertions below are as much about what is absent
 * (an envelope, a non-zero code, a scaffolded store) as about what is injected.
 *
 * Every invocation names `--repo` or injects a layer, like every other suite here, and every indexing
 * case names `--trace-root`: `MEMHTML_TRACE_ROOT` defaults to `~/.claude`, and a test that omitted it
 * would read the operator's own transcripts.
 */

const stdinOf = (text: string) => async (): Promise<string> => text

describe("hook and integrations usage refusals", () => {
  it("refuses an event outside the vocabulary at exit 2, naming all four", async () => {
    const failure = validate(parseArgv(["hook", "sessionStart", "--host", "claude"]))
    expect(failure?.code).toBe("ERR_UNKNOWN_HOOK_EVENT")
    expect(failure?.error).toContain("sessionStart")
    // Copy-pasteable: each suggestion carries the host the caller already named.
    expect(failure?.suggestions).toEqual([
      "memhtml hook session-start --host claude",
      "memhtml hook user-prompt-submit --host claude",
      "memhtml hook pre-compact --host claude",
      "memhtml hook session-end --host claude",
      "memhtml help hook"
    ])

    const result = await run(
      ["hook", "sessionStart", "--host", "claude", "--repo", "/nonexistent"],
      undefined,
      stdinOf("{}")
    )
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(JSON.parse(result.stdout).code).toBe("ERR_UNKNOWN_HOOK_EVENT")
  })

  it("refuses an unknown --host through the closed-vocabulary FLAG check, not ERR_UNKNOWN_HOST", () => {
    /**
     * `--host` declares `values` in `commands.ts`, so the check that already refuses every other
     * closed-vocabulary flag value covers it. Asserted rather than assumed, because the event
     * refusal's suggestions interpolate the named host and are only copy-pasteable while an invalid
     * one cannot reach them.
     */
    const failure = validate(parseArgv(["hook", "session-start", "--host", "nope"]))
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
    expect(failure?.error).toContain("claude, codex, cursor, opencode")
    expect(failure?.suggestions).toContain("memhtml help hook")
  })

  it("refuses an unknown host POSITIONAL on the integrations verbs at exit 2", async () => {
    for (const verb of ["install", "uninstall", "doctor"]) {
      const failure = validate(parseArgv(["integrations", verb, "nope"]))
      expect(failure?.code).toBe("ERR_UNKNOWN_HOST")
      expect(failure?.suggestions).toEqual([
        `memhtml integrations ${verb} claude`,
        `memhtml integrations ${verb} codex`,
        `memhtml integrations ${verb} cursor`,
        `memhtml integrations ${verb} opencode`,
        `memhtml help integrations ${verb}`
      ])
    }

    const result = await run(["integrations", "install", "nope"], undefined, stdinOf(""))
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(JSON.parse(result.stdout).code).toBe("ERR_UNKNOWN_HOST")
  })

  it("passes a real host and an absent one, so the check narrows nothing else", () => {
    expect(validate(parseArgv(["integrations", "install", "claude"]))).toBeUndefined()
    // The host positional is optional: omitted means every host whose home directory exists.
    expect(validate(parseArgv(["integrations", "install"]))).toBeUndefined()
    expect(validate(parseArgv(["integrations", "doctor", "opencode"]))).toBeUndefined()
    expect(validate(parseArgv(["hook", "session-start", "--host", "claude"]))).toBeUndefined()
  })
})

describe("the hook engine, against a real store", () => {
  let cli: Cli
  let traceRoot: string
  let vipPath: string
  let indexPath: string

  const hook = (
    argv: ReadonlyArray<string>,
    payload: string
  ): Promise<{ readonly stdout: string; readonly exitCode: number }> =>
    run([...argv, "--repo", cli.root], cli.layer, stdinOf(payload))

  beforeAll(async () => {
    cli = await makeCli()

    vipPath = (
      await cli.json<{ readonly path: string }>([
        "write",
        "--type",
        "procedural",
        "--title",
        "Prod rollbacks drain the VIP before the deploy is reverted",
        "--claim",
        "Drain the VIP before reverting the deploy.",
        "--body",
        "The revert alone leaves in-flight connections pinned to the old target group.",
        "--workspace",
        "checkout-api"
      ])
    ).path

    indexPath = (
      await cli.json<{ readonly path: string }>([
        "write",
        "--type",
        "semantic",
        "--title",
        "The SQLite index is a disposable projection of the git tree",
        "--claim",
        "Anything that must survive rm index.db lives in a file.",
        "--workspace",
        "checkout-api"
      ])
    ).path

    // A synthesized Claude Code transcript, for the indexing events. Never `~/.claude`.
    traceRoot = await mkdtemp(join(tmpdir(), "memhtml-hook-trace-"))
    const slugDir = join(traceRoot, "projects", "-home-dev-checkout-api")
    await mkdir(slugDir, { recursive: true })
    await writeFile(
      join(slugDir, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          promptId: "pr_01",
          sessionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          cwd: "/home/dev/checkout-api",
          gitBranch: "main",
          version: "2.0.14",
          timestamp: "2026-09-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "why did the deploy roll back" }]
          }
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          timestamp: "2026-09-01T10:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "ok" }]
          }
        })
      ].join("\n"),
      "utf8"
    )
  })

  afterAll(async () => {
    await cli.cleanup()
    await rm(traceRoot, { recursive: true, force: true })
    delete process.env.MEMHTML_TRACE_ROOT
  })

  it("injects Claude Code's plain text for a prompt, and NOT an envelope", async () => {
    const result = await hook(
      ["hook", "user-prompt-submit", "--host", "claude"],
      JSON.stringify({ prompt: "drain the vip before reverting the deploy" })
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout).toContain(PROMPT_HEADER)
    expect(result.stdout).toContain(vipPath)
    // The whole point of the second exception to the one-envelope contract: this stream is the
    // HOST's, and an envelope on it would be pasted into a context window as if it were a memory.
    expect(() => JSON.parse(result.stdout)).toThrow()
    expect(result.stdout).not.toContain("apiVersion")
  })

  it("injects Codex's additionalContext JSON for the same prompt", async () => {
    const result = await hook(
      ["hook", "user-prompt-submit", "--host", "codex"],
      JSON.stringify({ prompt: "drain the vip before reverting the deploy" })
    )

    expect(result.exitCode).toBe(EXIT_OK)
    const payload = JSON.parse(result.stdout) as {
      readonly hookSpecificOutput: {
        readonly hookEventName: string
        readonly additionalContext: string
      }
    }
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(payload.hookSpecificOutput.additionalContext).toContain(vipPath)
    expect(payload.hookSpecificOutput.additionalContext).toContain(PROMPT_HEADER)
  })

  it("says nothing on a per-prompt hook for Cursor, which cannot inject there", async () => {
    const result = await hook(
      ["hook", "user-prompt-submit", "--host", "cursor"],
      JSON.stringify({ prompt: "drain the vip before reverting the deploy" })
    )
    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout).toBe("")
  })

  it("answers a session start with the recall pack for the working directory", async () => {
    const result = await hook(
      ["hook", "session-start", "--host", "claude"],
      JSON.stringify({ cwd: "/home/dev/checkout-api" })
    )

    expect(result.exitCode).toBe(EXIT_OK)
    // Either text or nothing is a correct answer — what the ranker returns for a directory name is
    // corpus-dependent — but a NON-EMPTY answer has to be the pack's shape.
    if (result.stdout !== "") {
      expect(result.stdout).toContain(sessionHeader("checkout-api"))
      expect(result.stdout).toMatch(/\[[^\]]+\.html\]/)
    }
  })

  it("says nothing when the payload carries no prompt and no cwd", async () => {
    for (const event of ["user-prompt-submit", "session-start"]) {
      const result = await hook(["hook", event, "--host", "claude"], JSON.stringify({ other: 1 }))
      expect(result.exitCode).toBe(EXIT_OK)
      expect(result.stdout).toBe("")
    }
  })

  it("says nothing when the payload is not JSON at all", async () => {
    const result = await hook(
      ["hook", "user-prompt-submit", "--host", "claude"],
      "not json {oops\n"
    )
    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout).toBe("")
  })

  it("indexes transcripts on pre-compact through --trace-root, and injects nothing", async () => {
    const result = await hook(
      ["hook", "pre-compact", "--host", "claude", "--trace-root", traceRoot],
      JSON.stringify({ session_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", cwd: "/home/dev" })
    )
    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout).toBe("")

    /**
     * The row is the assertion, and it is the only one that can be: the output contract for this
     * event is "nothing" on every host, so a hook that indexed NOTHING would be indistinguishable
     * from this one by stdout alone. It also proves the one door `--trace-root` has — the dispatch
     * sets `MEMHTML_TRACE_ROOT` before the layer is built, because `indexTraces()` takes its root
     * from `Roots` and nothing overrides that layer.
     */
    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return yield* db.all<{ readonly session_id: string; readonly cwd: string | null }>(
          "SELECT session_id, cwd FROM traces"
        )
      }).pipe(Effect.provide(cli.layer), Effect.scoped)
    )
    expect(sessions.map((row) => row.session_id)).toContain("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb")
  })

  it("returns nothing when the deadline expires, rather than a late injection", async () => {
    /**
     * The stall is staged on the ONE service that can stall in production — retrieval, whose vector arm
     * embeds the query over the network — and the rest of the graph is the real one. `Effect.never`
     * rather than a slow query, so the assertion is that the bound INTERRUPTS running work rather than
     * that it happened to beat a race.
     *
     * A `deadlineMs: 1` against the fixture store is deliberately not the test here, and the reason is
     * the harness rather than the code: with the fake embedder the whole search completes inside one
     * tick, so the timer never gets the event loop and the bound cannot win however small it is
     * (measured 2026-09-13). That is also the honest bound on what `Effect.timeout` protects — an async
     * stall, not one synchronous `node:sqlite` call.
     *
     * Mutation-verified: with `Effect.timeout` removed from `runHook`, this case hangs until vitest
     * kills it instead of returning the empty string.
     */
    const stalled = Layer.succeed(Retrieval)({
      search: () => Effect.never,
      recall: () => Effect.never
    })

    const text = await Effect.runPromise(
      runHook({
        event: "user-prompt-submit",
        host: "claude",
        payload: { prompt: "drain the vip before reverting the deploy" },
        limit: 5,
        budget: 3000,
        deadlineMs: 20
      }).pipe(
        Effect.provide(stalled),
        Effect.provide(cli.layer),
        Effect.provideService(Logger.LogToStderr, true),
        Effect.scoped
      )
    )
    expect(text).toBe("")
  })

  it("bounds a session start the same way, so neither recall event can hold a turn", async () => {
    const stalled = Layer.succeed(Retrieval)({
      search: () => Effect.never,
      recall: () => Effect.never
    })

    const text = await Effect.runPromise(
      runHook({
        event: "session-start",
        host: "claude",
        payload: { cwd: "/home/dev/checkout-api" },
        limit: 5,
        budget: 3000,
        deadlineMs: 20
      }).pipe(
        Effect.provide(stalled),
        Effect.provide(cli.layer),
        Effect.provideService(Logger.LogToStderr, true),
        Effect.scoped
      )
    )
    expect(text).toBe("")
  })

  it("keeps both memories reachable, so the injection above was a ranking and not the whole corpus", async () => {
    const result = await hook(
      ["hook", "user-prompt-submit", "--host", "claude"],
      JSON.stringify({ prompt: "the sqlite index is a disposable projection" })
    )
    expect(result.stdout).toContain(indexPath)
  })
})

describe("a hook against a store that does not exist", () => {
  it("exits 0 and prints nothing for an unreachable root", async () => {
    const absent = "/nonexistent"
    expect(existsSync(absent)).toBe(false)

    const result = await run(
      ["hook", "session-start", "--host", "claude", "--repo", absent],
      undefined,
      stdinOf(JSON.stringify({ cwd: "/home/dev/checkout-api" }))
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout).toBe("")
    expect(existsSync(absent)).toBe(false)
    expect(existsSync(join(absent, ".memhtml"))).toBe(false)
  })

  it("scaffolds NOTHING at a root it could have created", async () => {
    /**
     * The case above cannot carry this claim on its own, and that is the point of writing both: `/` is
     * not writable, so `/nonexistent` would stay absent even with the readiness probe removed and the
     * assertion would pass vacuously. This root IS creatable, so removing the probe makes
     * `layerDatabase`'s `mkdir -p` create `<root>/.memhtml` and this case fail — which is what a hook
     * on a host whose config carries a stale root would do at every session start.
     */
    const absent = join(tmpdir(), `memhtml-hook-absent-${process.pid}`)
    await rm(absent, { recursive: true, force: true })

    const result = await run(
      ["hook", "session-start", "--host", "claude", "--repo", absent],
      undefined,
      stdinOf(JSON.stringify({ cwd: "/home/dev/checkout-api" }))
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.stdout).toBe("")
    expect(existsSync(absent)).toBe(false)
  })
})

describe("the injection renderers, without a store", () => {
  const entry = (path: string, gist: string) => ({ path, title: "A title", gist })

  it("renders one line per hit, path last, and nothing at all for no hits", () => {
    const rendered = renderPromptHits(
      [entry("areas/a.html", "first gist"), entry("areas/b.html", "second gist")],
      5
    )
    expect(rendered.split("\n")).toEqual([
      PROMPT_HEADER,
      "- A title — first gist [areas/a.html]",
      "- A title — second gist [areas/b.html]"
    ])
    // A header with nothing under it would spend context, once per prompt, to say "nothing found".
    expect(renderPromptHits([], 5)).toBe("")
  })

  it("honors the limit and clips a gist to its bound, marker included", () => {
    expect(
      renderPromptHits([entry("a.html", "x"), entry("b.html", "y")], 1).split("\n")
    ).toHaveLength(2)

    const long = "z".repeat(GIST_MAX_CHARS + 200)
    const line = renderPromptHits([entry("a.html", long)], 1).split("\n")[1] as string
    const gist = line.slice("- A title — ".length, line.indexOf(" [a.html]"))
    expect(gist).toHaveLength(GIST_MAX_CHARS)
    expect(gist.endsWith("…")).toBe(true)
  })

  it("folds a session pack into arcs, memories, then open tasks", () => {
    const rendered = renderSessionPack({
      label: "checkout-api",
      pack: {
        arcs: { disclosed: [entry("areas/arcs/rule.html", "the general rule")], indexLines: [] },
        memories: {
          disclosed: [entry("projects/checkout-api/one.html", "an instance")],
          indexLines: [entry("projects/checkout-api/two.html", "another")]
        }
      },
      tasks: [
        { path: "areas/inbox/tasks/t-1.html", title: "Drain the VIP", taskStatus: "doing" },
        { path: "areas/inbox/tasks/t-2.html", title: "Unpin the toolchain", taskStatus: null }
      ]
    })

    expect(rendered.split("\n")).toEqual([
      sessionHeader("checkout-api"),
      "- A title — the general rule [areas/arcs/rule.html]",
      "- A title — an instance [projects/checkout-api/one.html]",
      "- A title — another [projects/checkout-api/two.html]",
      OPEN_TASKS_HEADER,
      "- Drain the VIP (doing) [areas/inbox/tasks/t-1.html]",
      "- Unpin the toolchain [areas/inbox/tasks/t-2.html]"
    ])
  })

  it("renders an empty pack with no tasks as nothing, not as a header", () => {
    expect(
      renderSessionPack({
        label: "checkout-api",
        pack: {
          arcs: { disclosed: [], indexLines: [] },
          memories: { disclosed: [], indexLines: [] }
        },
        tasks: []
      })
    ).toBe("")
  })

  it("queries on the directory's own name and its parent's, never the whole path", () => {
    expect(queryForCwd("/home/me/work/worktrees/memhtml-integrations")).toBe(
      "memhtml-integrations worktrees"
    )
    // A leaf whose parent repeats it is one word, not two.
    expect(queryForCwd("/srv/memhtml/memhtml")).toBe("memhtml")
    expect(queryForCwd("/")).toBe("")
  })
})

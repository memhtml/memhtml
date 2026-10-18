import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { layerAppWith } from "@memhtml/cli"
import { STORE_CONFIG_FILE } from "@memhtml/contracts"
import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Layer, Stream } from "effect"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ToolHandlers } from "../src/handlers.js"
import { MemhtmlToolkit } from "../src/tools.js"

/**
 * The store's `v1Doors` mode over the MCP record tools, through the real toolkit layer.
 *
 * The three tools that create a record (`memory_write`, `memory_write_batch`, `memory_correct`)
 * read `memhtml.config.json` on every call and refuse under its mode, with `MEMHTML_SESSION` read
 * from this process's environment as the MCP server reads it: `closed-in-session` (the default)
 * refuses only with the variable set, `open` never refuses, `closed` always does. `memory_link`
 * and `memory_archive` edit existing records and stay open under every mode. A file that does not
 * decode refuses the record tools with `ERR_STORE_CONFIG`.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `handlers.ts`: the `guardV1Door("memory_write")` call removed -> "closed refuses each record
 *   tool" (the write lands); the same for `memory_write_batch` and `memory_correct`.
 * - `failure.ts` `mcpReasonFor`: answer `undefined` for `V1DoorClosed` -> "speaks in tools, not
 *   CLI commands" (the reason names `memhtml session start`).
 */

const SESSION_VAR = "MEMHTML_SESSION"

type Body = Record<string, unknown>

let root: string
let cleanup: () => Promise<void>
let call: (name: keyof typeof MemhtmlToolkit.tools, params: unknown) => Promise<Body>
let saved: string | undefined

const policy = (config: unknown): Promise<void> =>
  writeFile(
    join(root, STORE_CONFIG_FILE),
    typeof config === "string" ? config : JSON.stringify(config),
    "utf8"
  )

/** A tool call's wire failure text, or a thrown assertion when the call succeeded. */
const failureOf = async (
  name: keyof typeof MemhtmlToolkit.tools,
  params: unknown
): Promise<string> => {
  try {
    await call(name, params)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`${String(name)} succeeded`)
}

const write = (title: string) => ({
  title,
  body: `${title} holds for the door tests.`,
  memory_type: "semantic",
  entities: ["system:fixture"]
})

beforeAll(async () => {
  const fixture = await Effect.runPromise(makeFixtureRepo())
  root = fixture.root
  cleanup = fixture.cleanup
  const noEmbedder = { document: undefined, query: undefined }
  const layer = ToolHandlers.pipe(
    Layer.provideMerge(layerAppWith({ repo: root, embedder: noEmbedder }))
  )
  // The same `kit.handle` path `McpServer` runs for a `tools/call`; see `roundtrip.test.ts` for
  // why the requirement set is erased at this one boundary.
  const invoke = (name: keyof typeof MemhtmlToolkit.tools, params: unknown) =>
    Effect.gen(function* () {
      const kit = yield* MemhtmlToolkit
      const stream = yield* kit.handle(name, params as never)
      const results = yield* Stream.runCollect(stream)
      return (results.at(-1) as { readonly encodedResult: unknown }).encodedResult as Body
    }) as Effect.Effect<Body, unknown, Layer.Success<typeof layer>>
  call = (name, params) =>
    Effect.runPromise(Effect.scoped(Effect.provide(invoke(name, params), layer)))
})

afterAll(async () => {
  await cleanup()
})

beforeEach(() => {
  saved = process.env[SESSION_VAR]
  delete process.env[SESSION_VAR]
})

afterEach(async () => {
  if (saved === undefined) delete process.env[SESSION_VAR]
  else process.env[SESSION_VAR] = saved
  await rm(join(root, STORE_CONFIG_FILE), { force: true })
})

describe("the record tools under the store's v1Doors", () => {
  it("closed-in-session, the default, is open in a server outside a run", async () => {
    const result = await call("memory_write", write("Default door fact"))
    expect(result.created).toBe(true)
  })

  it("closed-in-session refuses inside a run with the session code, naming the session", async () => {
    process.env[SESSION_VAR] = "run-mcp"
    const message = await failureOf("memory_write", write("Run door fact"))
    expect(message).toMatch(/^ERR_SESSION_BOUND: /)
    expect(message).toContain('"run-mcp"')
  })

  it("closed refuses each record tool and leaves the edits of records open", async () => {
    const target = await call("memory_write", write("Closed door target"))
    const other = await call("memory_write", write("Closed door other"))
    await policy({ v1Doors: "closed" })
    for (const [name, params] of [
      ["memory_write", write("Closed door fact")],
      ["memory_write_batch", { ops: [write("Closed batch fact")] }],
      [
        "memory_correct",
        {
          target_path: target.path,
          title: "Closed door target",
          body: "The corrected target holds.",
          reason: "door test"
        }
      ]
    ] as const) {
      const message = await failureOf(name, params)
      expect(message, name).toMatch(/^ERR_V1_DOOR_CLOSED: /)
      expect(message).toContain(`${name} creates a record`)
    }
    const linked = await call("memory_link", {
      src_path: target.path,
      rel: "relates_to",
      dst_path: other.path
    })
    expect(linked.ok).toBe(true)
  })

  it("speaks in tools, not CLI commands", async () => {
    await policy({ v1Doors: "closed" })
    const message = await failureOf("memory_write", write("Wording fact"))
    expect(message).not.toContain("memhtml ")
    expect(message).not.toContain("--")
    expect(message).toContain("memory_link")
  })

  it("open admits them even inside a run", async () => {
    await policy({ v1Doors: "open" })
    process.env[SESSION_VAR] = "run-open"
    const result = await call("memory_write", write("Open door fact"))
    expect(result.created).toBe(true)
  })

  it("a file that does not decode refuses the record tools with ERR_STORE_CONFIG", async () => {
    await policy('{"v1Door":"open"}')
    const message = await failureOf("memory_write", write("Malformed door fact"))
    expect(message).toMatch(/^ERR_STORE_CONFIG: /)
    expect(message).toContain("v1Door")
    expect(message).not.toContain("memhtml ")
  })
})

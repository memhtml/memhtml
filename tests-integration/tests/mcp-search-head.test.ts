import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Cli, makeCli } from "./harness.js"
import { type Client, cliEntryPoint, connect, handshake, structured } from "./spawned.js"

/**
 * `memory_search` and `memory_recall` answered from the head server, over real MCP stdio
 * (`docs/v2-poc.md`, "Search and recall on the head"): the built `memhtml serve mcp` and the built
 * `memhtml head serve` as two processes over one temp store, a record committed after the index's
 * last update, and the same two calls made with the head in reach, with it switched off, and with it
 * stopped.
 *
 * This is the fleet's failure as a test. Run sessions commit to the store without touching
 * `.memhtml/index.db`, and the gateway's MCP server answered search from that index, so a record a
 * run wrote was invisible until something reindexed. The index here is left behind the ref on
 * purpose (`memory_status` says `index_fresh: false`), and the record past it is found through the
 * head and not through the index.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `apps/mcp/src/handlers.ts` `memory_search`: call `searchMemories` alone -> "finds a record
 *   committed after the index's watermark" (the head client is never asked).
 * - `apps/mcp/src/handlers.ts` `memory_recall`: call `recallMemories` alone -> the same case, on
 *   the recall half.
 */

const AT = "2026-03-01T12:00:00Z"

const note = (slug: string, title: string, claim: string) => ({
  path: `areas/inbox/${slug}.html`,
  html: renderTemplate({ title, claim, memoryType: "semantic", at: AT })
})

const LATE = note(
  "compass-declination",
  "Compass declination",
  "The compass declination at the north camp is eleven degrees east."
)

let cli: Cli
let server: ChildProcess | undefined

const commit = async (
  files: ReadonlyArray<{ readonly path: string; readonly html: string }>,
  message: string
) => {
  for (const file of files) {
    await mkdir(dirname(join(cli.root, file.path)), { recursive: true })
    await writeFile(join(cli.root, file.path), file.html, "utf8")
  }
  await cli.git("add", "-A")
  await cli.git("commit", "-q", "-m", message)
}

/** `memhtml head serve` on the store, awaited to its listening line. */
const startServer = async (): Promise<ChildProcess> => {
  const child = spawn(
    process.execPath,
    [cliEntryPoint, "head", "serve", "--poll-ms", "0", "--repo", cli.root],
    {
      env: { ...process.env, MEMHTML_EMBED: "off", MEMHTML_LLM: "off" },
      stdio: ["ignore", "ignore", "pipe"]
    }
  )
  let stderr = ""
  await new Promise<void>((resolve, reject) => {
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
      if (stderr.includes("head serve: listening on")) resolve()
    })
    child.once("exit", (code) => reject(new Error(`head serve exited ${String(code)}: ${stderr}`)))
  })
  return child
}

const stopServer = async () => {
  if (server === undefined || server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise((resolve) => server?.once("exit", resolve))
  server.kill("SIGTERM")
  await exited
}

/** One session: the handshake, the calls, and a clean shutdown, so two never share the index. */
const session = async (
  extraEnv: Readonly<Record<string, string>> = {}
): Promise<{
  readonly search: ReadonlyArray<string>
  readonly recall: ReadonlyArray<string>
  readonly status: Record<string, unknown>
}> => {
  const client: Client = connect(cli.root, extraEnv)
  try {
    await handshake(client)
    const call = async (name: string, args: Record<string, unknown>) =>
      structured(await client.rpc("tools/call", { name, arguments: args }))
    const search = await call("memory_search", { query: "compass declination north camp" })
    const recall = await call("memory_recall", { query: "compass declination north camp" })
    const status = await call("memory_status", {})
    const sections = recall.sections as Record<string, ReadonlyArray<{ readonly path: string }>>
    return {
      search: (search.hits as ReadonlyArray<{ readonly path: string }>).map((hit) => hit.path),
      recall: [
        ...(sections.memories ?? []),
        ...(sections.arcs ?? []),
        ...(sections.lateral ?? [])
      ].map((entry) => entry.path),
      status
    }
  } finally {
    await client.shutdown()
  }
}

beforeAll(async () => {
  cli = await makeCli()
  await commit(
    [
      note("harbor-pilots", "Harbor pilots", "Harbor pilots board ships at the outer buoy."),
      note("glacier-speed", "Glacier speed", "Glacier ice moves about a meter a day."),
      note("orchard-pruning", "Orchard pruning", "Orchard trees are pruned in late winter.")
    ],
    "corpus"
  )
  await cli.json(["index", "update"])
  // Past the index's watermark: what a run session's commit is to the fleet's index.
  await commit([LATE], "a run session's commit")
  server = await startServer()
}, 60_000)

afterAll(async () => {
  await stopServer()
  await cli.cleanup()
})

describe("memory_search and memory_recall over the head server", () => {
  it("finds a record committed after the index's watermark, which the index path does not", async () => {
    const onHead = await session()
    expect(onHead.status.index_fresh).toBe(false)
    expect(onHead.search[0]).toBe(LATE.path)
    expect(onHead.recall).toContain(LATE.path)

    const onIndex = await session({ MEMHTML_MCP_HEAD: "off" })
    expect(onIndex.status.index_fresh).toBe(false)
    expect(onIndex.search).not.toContain(LATE.path)
    expect(onIndex.recall).not.toContain(LATE.path)
  })

  it("answers from the index when no head server is running", async () => {
    await stopServer()
    const fallback = await session()
    expect(fallback.search).not.toContain(LATE.path)
    expect(fallback.search.length).toBeGreaterThan(0)
  })
})

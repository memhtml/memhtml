import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The built `memhtml` binary, driven as a CHILD PROCESS.
 *
 * Everything in this module exists because `harness.ts` cannot reach it: that harness calls `run()`
 * in-process with an injected layer, which is the right tier for a state contract and the wrong one
 * for anything the PROCESS boundary owns — the supervisor's `MEMHTML_ROOT` hand-off, `MEMHTML_EMBED=off`
 * resolving to an absent embedder at layer-build time, NDJSON framing over stdio, the exit code, and
 * the one-envelope-on-stdout rule. A passthrough that worked in-process and broke over the wire would
 * be invisible to every in-process test in this repo.
 *
 * **BUILD ORDER.** This drives `dist`, not `src`. `turbo` makes `test:integration` depend on `build`,
 * and {@link cliEntryPoint} names a build artifact so a stale or absent build fails as a missing file
 * rather than as a behavioural difference.
 */

/**
 * The `memhtml` binary, as a sibling of this test rather than through node resolution.
 *
 * `import.meta.resolve("@memhtml/cli")` would land on `dist/index.js` — the library entry, not the `bin`
 * — and `@memhtml/cli`'s `exports` deliberately publishes no `./bin` subpath. So the binary is located as
 * what it is: a build artifact at a known place in this repo, the same relative walk `mcpEntryPoint`
 * uses one directory over (`apps/cli/src/serve.ts:34-47`).
 */
export const cliEntryPoint = fileURLToPath(new URL("../../apps/cli/dist/bin.js", import.meta.url))

/**
 * The child environment every spawn here uses.
 *
 * `MEMHTML_EMBED`/`MEMHTML_LLM` are read through `Config` when the layer is built, INSIDE the process that
 * builds it — so setting them here is the only thing that keeps Bedrock out of the graph, and setting
 * them on this process would not reach the child's `layerEmbedder` at all
 * (`apps/cli/src/api-layer.ts:234-246`). `MEMHTML_ROOT` is passed for the same reason the supervisor
 * passes it: an inherited environment does not carry a `--repo` override.
 */
const childEnv = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  MEMHTML_ROOT: root,
  MEMHTML_EMBED: "off",
  MEMHTML_LLM: "off"
})

/** What one out-of-process `memhtml` invocation produced. */
export interface Spawned {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * One `memhtml <argv>` against a repo, through the BUILT binary.
 *
 * The exit code is returned rather than asserted because it is half of the contract under test: a
 * usage refusal is exit 2 and a runtime failure is exit 1, and only a real process has one at all.
 */
export const runBuilt = (root: string, argv: ReadonlyArray<string>): Promise<Spawned> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntryPoint, ...argv, "--repo", root], {
      env: childEnv(root),
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }))
  })

/**
 * The BARE binary: no repo, no `--repo`, no arguments.
 *
 * Separate from {@link runBuilt} precisely because it passes no `--repo` — the manifest's own claim is
 * that it answers on a machine with no repo, no database, and no credentials, and threading a repo
 * flag would make that claim untestable here.
 */
export const runBare = (argv: ReadonlyArray<string> = []): Promise<Spawned> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntryPoint, ...argv], {
      env: { ...process.env, MEMHTML_EMBED: "off", MEMHTML_LLM: "off" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }))
  })

/** The one JSON envelope a `memhtml` invocation writes to stdout. */
export const envelopeOf = (spawned: Spawned): Record<string, unknown> => {
  try {
    return JSON.parse(spawned.stdout) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `stdout was not one JSON envelope (${String(error)}): ${spawned.stdout.slice(0, 400)}`
    )
  }
}

/** One JSON-RPC client over a spawned `memhtml serve mcp`, and its shutdown. */
export interface Client {
  /** A request/response pair. Rejects only if the server dies before answering. */
  readonly rpc: (method: string, params: unknown) => Promise<Record<string, unknown>>
  /** A notification: no id, so no answer to wait for. */
  readonly notify: (method: string, params: unknown) => void
  /**
   * Close stdin, wait for the supervisor to exit, and return its `serve.exit` envelope.
   *
   * Returning the envelope rather than discarding it is what makes the exit ASSERTABLE, and the exit
   * is load bearing: Turso's writer lock is held on `.memhtml/index.db` for as long as the child is
   * alive, so every row assertion has to happen after this resolves.
   */
  readonly shutdown: () => Promise<{
    readonly exitCode: number
    readonly envelope: Record<string, unknown>
  }>
}

/**
 * `memhtml serve mcp` over a repo, speaking NDJSON JSON-RPC.
 *
 * `memhtml serve mcp` rather than `apps/mcp/dist/bin.js` directly, because that is the command an operator
 * and a client config name — and it exercises the supervisor's one job (spawn the child, keep its own
 * hands off the database), whose clean exit is what RELEASES the lock a row assertion then needs.
 */
export const connect = (root: string): Client => {
  const child = spawn(process.execPath, [cliEntryPoint, "serve", "mcp", "--repo", root], {
    env: childEnv(root),
    stdio: ["pipe", "pipe", "pipe"]
  })

  /**
   * stderr is drained and dropped. It carries the graph's logs — `Logger.LogToStderr` is set for
   * exactly this reason (`apps/mcp/src/server.ts:22-25`) — and an undrained pipe would eventually
   * block the child on a full buffer, which reads as a hang rather than as a log.
   */
  child.stderr.resume()

  let buffer = ""
  /**
   * Framing off, once the RPC session is over.
   *
   * The supervisor writes its own `serve.exit` envelope to stdout after the child's descriptors are
   * its again — pretty-printed JSON, not NDJSON — so a parser still running then would throw on `{`.
   * The flag is the seam between the two writers of one file descriptor.
   */
  let framing = true
  const pending = new Map<number, (message: Record<string, unknown>) => void>()

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    if (!framing) return
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line !== "") {
        const message = JSON.parse(line) as Record<string, unknown>
        const resolve = pending.get(message.id as number)
        if (resolve !== undefined) {
          pending.delete(message.id as number)
          resolve(message)
        }
      }
      newline = buffer.indexOf("\n")
    }
  })

  let nextId = 0
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      nextId += 1
      const id = nextId
      pending.set(id, resolve)
      child.once("exit", () => {
        if (pending.delete(id)) reject(new Error(`server exited before answering ${method}`))
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })

  return {
    rpc,
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
    },
    shutdown: async () => {
      framing = false
      buffer = ""
      child.stdin.end()
      const exitCode = await new Promise<number>((resolve) => {
        child.once("exit", (code) => resolve(code ?? 0))
      })
      return { exitCode, envelope: JSON.parse(buffer) as Record<string, unknown> }
    }
  }
}

/**
 * The handshake every client makes, asserted by the caller from what this returns.
 *
 * Kept here so two suites cannot open a session two different ways — the protocol version and the
 * `notifications/initialized` that follows it are the client half of the contract, not a per-test
 * choice.
 */
export const handshake = async (
  client: Client
): Promise<{
  readonly protocolVersion: string
  readonly serverInfo: { readonly name: string; readonly version: string }
}> => {
  const initialize = await client.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "memhtml-integration", version: "0.1.0" }
  })
  client.notify("notifications/initialized", {})
  return initialize.result as {
    readonly protocolVersion: string
    readonly serverInfo: { readonly name: string; readonly version: string }
  }
}

/** A `tools/call` result, unwrapped to the structured payload a client would read. */
export const structured = (result: Record<string, unknown>): Record<string, unknown> => {
  const payload = result.result as
    | { readonly structuredContent?: Record<string, unknown>; readonly isError?: boolean }
    | undefined
  if (payload === undefined) throw new Error(`no result: ${JSON.stringify(result)}`)
  if (payload.isError === true) throw new Error(`tool failed: ${JSON.stringify(payload)}`)
  if (payload.structuredContent === undefined) {
    throw new Error(`no structuredContent: ${JSON.stringify(payload)}`)
  }
  return payload.structuredContent
}

/**
 * A FAILED `tools/call`, unwrapped to the one thing an agent actually reads.
 *
 * The mirror of {@link structured}, and the shape MCP gives a tool error: `isError: true` plus text
 * content — not a JSON-RPC error, because the CALL succeeded and the TOOL refused. `isError` is
 * asserted here rather than at each call site so a regression that turned a refusal into a success
 * fails as "expected a failure" rather than as a confusing text mismatch.
 */
export const failureText = (result: Record<string, unknown>): string => {
  const payload = result.result as
    | {
        readonly isError?: boolean
        readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
      }
    | undefined
  if (payload === undefined) throw new Error(`no result: ${JSON.stringify(result)}`)
  if (payload.isError !== true) {
    throw new Error(`expected a tool failure, got: ${JSON.stringify(payload)}`)
  }
  const text = (payload.content ?? []).map((block) => block.text ?? "").join("\n")
  if (text === "") throw new Error(`failure carried no text: ${JSON.stringify(payload)}`)
  return text
}

/**
 * A digest over every byte of the working tree, for the literal reading of "byte-identical".
 *
 * Walks the tree and hashes path + contents in sorted order. It is a companion to
 * `git status --porcelain`, not a replacement — probed on this repo, `--porcelain` also reports a file
 * written and never staged, and one staged and then reset. What the digest adds is INDEPENDENCE from
 * git's bookkeeping and a different failure signature ("these bytes moved" rather than "this path is
 * dirty"), which is what a rollback bug gets diagnosed from.
 *
 * `.git` is excluded because git's own object store legitimately grows — a refused batch may still
 * have left a loose blob behind, and an assertion that failed on that would be asserting git's
 * internals rather than the corpus. `.memhtml` is excluded because it holds the gitignored databases,
 * which the indexer touches on every read.
 */
export const treeDigest = async (root: string): Promise<string> => {
  const files: Array<string> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".memhtml") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(full)
    }
  }
  await walk(root)
  files.sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(relative(root, file), "utf8")
    hash.update("\0", "utf8")
    hash.update(await readFile(file))
    hash.update("\0", "utf8")
  }
  return hash.digest("hex")
}

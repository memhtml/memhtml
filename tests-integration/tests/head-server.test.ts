import { type ChildProcess, spawn } from "node:child_process"
import { lstat, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { cliEntryPoint, runBuilt } from "./spawned.js"

/**
 * `memhtml head serve` as a real process (`docs/v2-poc.md`, "Head server"): the built binary serving
 * a temp repo over its socket, a second built binary asking it, a commit landed through `session
 * commit` while it serves, and SIGTERM and SIGINT ending it with its envelope written and its socket
 * gone.
 *
 * What only a process shows: the envelope arrives on stdout when a signal stops the server (and
 * nothing before), the socket is removed by the process's own finalizers rather than by a test's
 * scope, and the client is a separate process that knows the server only through the socket.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-server.ts` `untilSignal`: register SIGTERM only -> "SIGINT stops the server the same way"
 *   (Node's default SIGINT exit leaves no envelope).
 * - `head-server.ts` `app`: the search route reads `state.version` instead of `yield* fresh`, with
 *   `--poll-ms 0` -> "a commit landed through session commit is in the next search, with no
 *   restart" (the search answers the old sha).
 */

const repos: Array<FixtureRepo> = []
const servers: Array<ChildProcess> = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve))
      server.kill("SIGKILL")
      await exited
    }
  }
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const memory = (word: string, claim: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim,
    memoryType: "semantic",
    at: "2026-03-01T12:00:00Z",
    entities: ["system:fixture"]
  })
})

const corpus = async (): Promise<FixtureRepo> => {
  const repo = await run(makeFixtureRepo())
  repos.push(repo)
  for (const [word, claim] of [
    ["harbor", "Harbor pilots board ships at the outer buoy."],
    ["glacier", "Glacier ice moves about a meter a day."],
    ["orchard", "Orchard trees are pruned in late winter."]
  ] as const) {
    const file = memory(word, claim)
    await mkdir(dirname(join(repo.root, file.path)), { recursive: true })
    await writeFile(join(repo.root, file.path), file.html, "utf8")
  }
  await run(repo.git.run(["add", "-A"]))
  await run(repo.git.run(["commit", "-q", "-m", "corpus"]))
  return repo
}

interface Served {
  readonly child: ChildProcess
  readonly socket: string
  readonly stdout: () => string
  readonly exit: Promise<number | null>
}

/** Start `head serve` on `root` and wait for its listening line on stderr. */
const startServer = async (root: string, argv: ReadonlyArray<string> = []): Promise<Served> => {
  const child = spawn(process.execPath, [cliEntryPoint, "head", "serve", ...argv, "--repo", root], {
    env: { ...process.env, MEMHTML_EMBED: "off", MEMHTML_LLM: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  servers.push(child)
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve))
  await new Promise<void>((resolve, reject) => {
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
      if (stderr.includes("head serve: listening on")) resolve()
    })
    void exit.then((code) => reject(new Error(`head serve exited ${String(code)}: ${stderr}`)))
  })
  return { child, socket: join(root, ".memhtml", "head.sock"), stdout: () => stdout, exit }
}

const envelope = (stdout: string) =>
  JSON.parse(stdout) as { type?: string; code?: string; data: Record<string, unknown> }

const headOf = (stdout: string) =>
  envelope(stdout).data.head as { readonly sha: string; readonly source: string }

const tip = async (repo: FixtureRepo): Promise<string> => {
  const sha = await run(repo.git.revParseHead())
  if (sha === null) throw new Error("no HEAD")
  return sha
}

describe("memhtml head serve as a process", () => {
  it("a commit landed through session commit is in the next search, with no restart", async () => {
    const repo = await corpus()
    const server = await startServer(repo.root, ["--poll-ms", "0"])
    const before = await tip(repo)

    const first = await runBuilt(repo.root, ["head", "search", "glacier ice", "--limit", "1"])
    expect(first.exitCode).toBe(0)
    expect(headOf(first.stdout)).toMatchObject({ sha: before, source: "server" })
    const status = await runBuilt(repo.root, ["head", "status"])
    const pid = (envelope(status.stdout).data.server as { readonly pid: number }).pid
    expect(pid).toBe(server.child.pid)

    expect((await runBuilt(repo.root, ["session", "start", "--id", "s1"])).exitCode).toBe(0)
    // Inside `.git`, so the op file is neither tracked nor left behind.
    const ops = join(repo.root, ".git", "ops.jsonl")
    await writeFile(
      ops,
      `${JSON.stringify({ op: "write", title: "Lantern oil", type: "semantic", body: "Lantern oil is whale oil in the old lighthouse logs.", entity: "system:fixture" })}\n`
    )
    const put = await runBuilt(repo.root, ["session", "put", "--id", "s1", "--file", ops])
    expect(put.exitCode).toBe(0)
    expect(headOf(put.stdout)).toMatchObject({ sha: before, source: "server" })
    const committed = await runBuilt(repo.root, [
      "session",
      "commit",
      "--id",
      "s1",
      "--message",
      "lantern"
    ])
    expect(committed.exitCode).toBe(0)
    expect(envelope(committed.stdout).data.kind).toBe("committed")
    const landed = await tip(repo)
    expect(landed).not.toBe(before)

    const next = await runBuilt(repo.root, [
      "head",
      "search",
      "lantern oil lighthouse",
      "--limit",
      "1"
    ])
    expect(next.exitCode).toBe(0)
    expect(headOf(next.stdout)).toMatchObject({ sha: landed, source: "server" })
    const hits = envelope(next.stdout).data.hits as ReadonlyArray<{ readonly claim: string }>
    expect(hits[0]?.claim).toContain("Lantern oil")
    const after = await runBuilt(repo.root, ["head", "status"])
    const served = envelope(after.stdout).data.server as {
      readonly pid: number
      readonly advances: number
    }
    expect(served).toMatchObject({ pid: server.child.pid, advances: 1 })

    server.child.kill("SIGTERM")
    expect(await server.exit).toBe(0)
    const final = envelope(server.stdout())
    expect(final.type).toBe("head.served")
    expect(final.data).toMatchObject({ signal: "SIGTERM", sha: landed, advances: 1 })
    await expect(lstat(server.socket)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("SIGINT stops the server the same way, and a second server is refused while one runs", async () => {
    const repo = await corpus()
    const server = await startServer(repo.root)
    const second = await runBuilt(repo.root, ["head", "serve"])
    expect(second.exitCode).toBe(1)
    expect(envelope(second.stdout).code).toBe("ERR_HEAD_SERVER_RUNNING")
    expect((await lstat(server.socket)).isSocket()).toBe(true)

    server.child.kill("SIGINT")
    expect(await server.exit).toBe(0)
    expect(envelope(server.stdout()).data).toMatchObject({ signal: "SIGINT" })
    await expect(lstat(server.socket)).rejects.toMatchObject({ code: "ENOENT" })

    // With the server gone the same command loads locally.
    const local = await runBuilt(repo.root, ["head", "search", "orchard"])
    expect(headOf(local.stdout).source).not.toBe("server")
  })
})

import { type ChildProcess, spawn } from "node:child_process"
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { cliEntryPoint, runBuilt } from "./spawned.js"

/**
 * `session commit` and `session rebase` through `memhtml head serve` as a real process
 * (`/v1/commit`, `/v1/rebase`): the built binary serving a temp repo with its poll off, and separate
 * built binaries committing, rebasing after another session moved main, and committing with
 * `--no-server` beside it.
 *
 * What only a process shows: the CLI that commits knows the server only through the socket, the
 * server's held version follows its own commits with no poll and no restart, and the payload a
 * separate process prints names the path that answered.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `v2.ts` `sessionCommit`: skip the ask (`input.server !== false` -> `false`) -> "commits through
 *   the server, rebases after main moved, and holds every commit with no poll" (`via` is `local`).
 * - `head-server.ts` `landed`: drop the `state.version = next` step -> the same case (the held
 *   version stays behind the commit, so `head status` advances again and reports two advances
 *   for one commit).
 */

const repos: Array<FixtureRepo> = []
const servers: Array<ChildProcess> = []
const dirs: Array<string> = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve))
      server.kill("SIGKILL")
      await exited
    }
  }
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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

type Data = Record<string, unknown>

const envelope = (stdout: string) =>
  JSON.parse(stdout) as { type?: string; code?: string; data: Data }

/** One built `memhtml` call that must succeed, its payload. */
const ok = async (root: string, argv: ReadonlyArray<string>): Promise<Data> => {
  const result = await runBuilt(root, argv)
  expect(result.exitCode, result.stdout + result.stderr).toBe(0)
  return envelope(result.stdout).data
}

/** A session started at main's tip holding one put, the ops file outside the repo. */
const session = async (root: string, id: string, title: string): Promise<void> => {
  await ok(root, ["session", "start", "--id", id])
  const dir = await mkdtemp(join(tmpdir(), "memhtml-commit-it-"))
  dirs.push(dir)
  const ops = join(dir, `${id}.jsonl`)
  await writeFile(
    ops,
    `${JSON.stringify({ op: "write", title, type: "semantic", body: `${title} is a fact a session wrote.`, entity: "system:fixture" })}\n`
  )
  await ok(root, ["session", "put", "--id", id, "--file", ops])
}

const mainOf = async (repo: FixtureRepo): Promise<string> =>
  (await run(repo.git.run(["rev-parse", "refs/heads/main"]))).trim()

const serverOf = async (root: string) =>
  (await ok(root, ["head", "status"])).server as { readonly sha: string; readonly advances: number }

describe("session commit through memhtml head serve as a process", () => {
  it("commits through the server, rebases after main moved, and holds every commit with no poll", async () => {
    const repo = await corpus()
    const server = await startServer(repo.root, ["--poll-ms", "0"])
    await session(repo.root, "first", "Lantern oil")
    await session(repo.root, "second", "Beacon wicks")

    const first = await ok(repo.root, ["session", "commit", "--id", "first", "--message", "one"])
    expect(first).toMatchObject({
      kind: "committed",
      via: "server",
      server: { used: true, base: "tip", reason: null, detail: null }
    })
    expect(await mainOf(repo)).toBe(first.sha)
    const snapshot = first.snapshot as { readonly path: string; readonly sha: string }
    expect(snapshot.sha).toBe(first.sha)
    await access(snapshot.path)
    // With the poll off, only the commit itself can have moved the server's version.
    expect(await serverOf(repo.root)).toMatchObject({ sha: first.sha, advances: 1 })

    const behind = await ok(repo.root, ["session", "commit", "--id", "second", "--message", "two"])
    expect(behind).toMatchObject({
      kind: "rebase-needed",
      mainSha: first.sha,
      via: "server",
      server: { used: true, base: "ancestor" }
    })
    const rebased = await ok(repo.root, ["session", "rebase", "--id", "second"])
    expect(rebased).toMatchObject({
      moved: true,
      baseSha: first.sha,
      via: "server",
      head: { source: "server", sha: first.sha }
    })
    const second = await ok(repo.root, ["session", "commit", "--id", "second", "--message", "two"])
    expect(second).toMatchObject({ kind: "committed", via: "server", server: { base: "tip" } })
    expect(await serverOf(repo.root)).toMatchObject({ sha: second.sha, advances: 2 })

    // Beside the server, --no-server commits here; the server finds the new tip on its next answer.
    await session(repo.root, "third", "Harbor bells")
    const third = await ok(repo.root, [
      "session",
      "commit",
      "--id",
      "third",
      "--message",
      "three",
      "--no-server"
    ])
    expect(third).toMatchObject({
      kind: "committed",
      via: "local",
      server: { used: false, reason: "disabled" }
    })
    expect(await serverOf(repo.root)).toMatchObject({ sha: third.sha, advances: 3 })

    server.child.kill("SIGTERM")
    expect(await server.exit).toBe(0)
    expect(envelope(server.stdout()).data).toMatchObject({ sha: third.sha, advances: 3 })
    await expect(lstat(server.socket)).rejects.toMatchObject({ code: "ENOENT" })

    // With the server gone the same command commits here and says why.
    await session(repo.root, "fourth", "Orchard ladders")
    const fourth = await ok(repo.root, ["session", "commit", "--id", "fourth", "--message", "four"])
    expect(fourth).toMatchObject({
      kind: "committed",
      via: "local",
      server: { used: false, reason: "no-server" }
    })
  }, 60_000)
})

import { spawn } from "node:child_process"
import { lstat, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { snapshotPathFor } from "@memhtml/snapshot"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { EmbedderShape } from "../src/api-layer.js"
import { recordView } from "../src/curate-run.js"
import { askHead } from "../src/head-client.js"
import {
  HeadServerRunning,
  HeadServerStatus,
  headSocketPath,
  NeighborsAnswer,
  SearchAnswer
} from "../src/head-protocol.js"
import { type HeadServer, startHeadServer } from "../src/head-server.js"
import { headVectorsPath, loadForSearch } from "../src/head-vectors.js"
import { parseArgv, run, validate } from "../src/run.js"
import { loadHeadAt, preparePuts } from "../src/v2.js"
import { fakeEmbedder, noEmbedder } from "./harness.js"

/**
 * The head server (`head-server.ts`), its client (`head-client.ts`), and the three commands that
 * ask it first, in process over a real temp git repo and a real Unix socket.
 *
 * Every claim about freshness is checked against the ref as git reports it (`rev-parse`), every claim
 * about an answer against the same computation done locally over a head loaded from git, and every
 * claim about the socket against the filesystem (`lstat`, the mode bits, `git check-ignore`).
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-server.ts` `app`: the search route reads `state.version` instead of `yield* fresh` ->
 *   "answers a commit that landed while the poll was off, in the very next request".
 * - `head-server.ts` `advance`: drop `advanceLock.withPermits(1)` -> "runs one advance for every
 *   request that arrived during it" (`advances` is 8).
 * - `head-server.ts` `advance`: drop the `now === state.version.sha` re-check inside the permit ->
 *   "runs one advance for every request that arrived during it" (`advances` is 8).
 * - `head-server.ts` `claimSocket`: drop the `rm` of a stale socket -> "replaces a socket left by a
 *   killed server" (the bind fails with EADDRINUSE).
 * - `head-server.ts` `claimSocket`: treat `live` as `stale` -> "refuses to start beside a live
 *   server, naming it" (the second server replaces the first).
 * - `head-server.ts` `startHeadServer`: drop the umask narrowing and the `chmod` -> "binds a 0600
 *   socket inside the store" (the mode is 0755).
 * - `head-server.ts` `startHeadServer`: drop the `ensureExcludedQuietly` call -> "binds a 0600
 *   socket inside the store" (`check-ignore` misses the socket in a store whose .gitignore predates
 *   it).
 * - `head-client.ts` `askHead`: `Effect.catchCause` rethrows instead of answering null -> "falls back
 *   to the local load when no server answers" (the command fails instead of loading).
 * - `head-server.ts` `heldVectors`: return `vectors.read` without the `stat` -> "picks up a cache
 *   written while it runs, with no restart" (the search still reports `no-cache`), and every case
 *   that embeds before it serves.
 * - `head-protocol.ts` `OverlayOpSchema`: drop the `label`/`unlabel` member -> "computes session
 *   put's neighbors at the session's base" (the answer carrying the label fails to decode, so the
 *   client reads it as no server).
 * - `head-server.ts` `heldVectors`: drop the stamp re-check inside `vectorLock` -> "reads a changed
 *   cache once for every request that saw the change" (`loads` is 8).
 * - `head-server.ts` `heldVectors`: drop the `!embedderOn` early return -> "with no embedder never
 *   reads the cache, and says embedder-off" (the status holds the cache).
 */

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const WORDS = ["harbor", "glacier", "orchard", "furnace", "lantern", "compass"]

const memory = (word: string, claim?: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim: claim ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)} facts are recorded here.`,
    memoryType: "semantic",
    at: "2026-03-01T12:00:00Z",
    entities: ["system:fixture"]
  })
})

const commit = async (
  repo: FixtureRepo,
  files: ReadonlyArray<{ readonly path: string; readonly html: string }>,
  message = "fixture"
): Promise<string> => {
  for (const file of files) {
    const target = join(repo.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", message]))
  const sha = await run_(repo.git.revParseHead())
  if (sha === null) throw new Error("no HEAD")
  return sha
}

const corpus = async (): Promise<{ repo: FixtureRepo; sha: string }> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  const sha = await commit(
    repo,
    WORDS.map((word) => memory(word)),
    "corpus"
  )
  return { repo, sha }
}

/** A server in its own scope, closed after the test. */
const serve = async (
  root: string,
  pollMs = 0,
  embedder: EmbedderShape = noEmbedder()
): Promise<HeadServer> => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  return run_(startHeadServer({ root, pollMs, embedder }).pipe(Scope.provide(scope)))
}

/** `memhtml <argv> --repo <root>` in process, parsed, with `embedder` bound to the v2 arms. */
const cli = async (
  root: string,
  argv: ReadonlyArray<string>,
  embedder?: EmbedderShape
): Promise<{ exitCode: number; body: Record<string, unknown> }> => {
  const result = await run([...argv, "--repo", root], undefined, undefined, false, embedder)
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Record<string, unknown> }
}

/** The fields of a `vector` report that do not depend on timing. */
const vectorFacts = (vector: unknown) => {
  const { used, reason, detail, cached, coverage } = vector as Record<string, unknown>
  return { used, reason, detail, cached, coverage }
}

const dataOf = (body: Record<string, unknown>) => body.data as Record<string, unknown>
const headOf = (body: Record<string, unknown>) =>
  dataOf(body).head as { readonly sha: string; readonly source: string }

/** One raw HTTP request over the socket, for the cases the typed client never sends. */
const raw = (
  socket: string,
  method: string,
  path: string,
  body?: string
): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path }, (res) => {
      let text = ""
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8")
      })
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> })
      )
    })
    req.once("error", reject)
    if (body !== undefined) req.setHeader("content-type", "application/json")
    req.end(body)
  })

/** A socket file with no listener: what a server killed with SIGKILL leaves behind. */
const staleSocket = async (socket: string): Promise<void> => {
  await mkdir(dirname(socket), { recursive: true })
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.stdout.write("up"))`
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  )
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGKILL")
  await exited
  expect((await lstat(socket)).isSocket()).toBe(true)
}

describe("the head server", () => {
  it("binds a 0600 socket inside the store, ignored by git even when .gitignore predates it", async () => {
    const { repo } = await corpus()
    // A store scaffolded before the server: its committed .gitignore does not name the socket.
    await writeFile(join(repo.root, ".gitignore"), ".memhtml/index.db\n.memhtml/state.db\n")
    await commit(repo, [], "older gitignore")
    const server = await serve(repo.root)
    expect(server.socket).toBe(join(repo.root, ".memhtml", "head.sock"))
    const info = await lstat(server.socket)
    expect(info.isSocket()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
    await run_(repo.git.run(["check-ignore", "-q", ".memhtml/head.sock"]))
    expect((await run_(repo.git.run(["status", "--porcelain"]))).trim()).toBe("")
  })

  it("answers status, search, and read the way a local load of the same commit does", async () => {
    const { repo, sha } = await corpus()
    const server = await serve(repo.root)
    const local = await run_(loadHeadAt(repo.root, sha, "git"))

    const status = await run_(
      askHead({ root: repo.root, route: "status", schema: HeadServerStatus })
    )
    expect(status?.data).toMatchObject({
      protocol: "1",
      pid: process.pid,
      ref: "refs/heads/main",
      sha,
      records: WORDS.length,
      // The scaffold's README.html, skipped by design and counted.
      skipped: local.view.skipped,
      loadSource: "git",
      advances: 0,
      pollMs: 0
    })

    const search = await run_(
      askHead({
        root: repo.root,
        route: "search",
        schema: SearchAnswer,
        body: { query: "orchard facts", limit: 3 }
      })
    )
    expect(search?.data.head).toEqual({
      sha,
      ref: "refs/heads/main",
      records: WORDS.length,
      skipped: local.view.skipped
    })
    const { searchHead } = await import("@memhtml/head")
    expect(search?.data.hits).toEqual(searchHead(local.view, { query: "orchard facts", limit: 3 }))

    const read = await raw(
      server.socket,
      "POST",
      "/v1/read",
      JSON.stringify({ path: "areas/inbox/orchard.html" })
    )
    expect(read.status).toBe(200)
    expect(read.json.record).toEqual(recordView(local.view, "areas/inbox/orchard.html"))
    const missing = await raw(
      server.socket,
      "POST",
      "/v1/read",
      JSON.stringify({ path: "areas/inbox/nope.html" })
    )
    expect(missing.json.record).toBeNull()
  })

  it("refuses a body its schema does not describe, and a route it does not serve", async () => {
    const { repo } = await corpus()
    const server = await serve(repo.root)
    const excess = await raw(
      server.socket,
      "POST",
      "/v1/search",
      JSON.stringify({ query: "x", k: 1 })
    )
    expect(excess.status).toBe(400)
    expect(excess.json.code).toBe("ERR_INVALID_FLAG")
    const notJson = await raw(server.socket, "POST", "/v1/search", "{")
    expect(notJson.status).toBe(400)
    const unknown = await raw(server.socket, "GET", "/v2/status")
    expect(unknown.status).toBe(404)
    expect(unknown.json.code).toBe("ERR_UNKNOWN_COMMAND")
  })

  it("answers a commit that landed while the poll was off, in the very next request", async () => {
    const { repo } = await corpus()
    const server = await serve(repo.root, 0)
    const before = server.held().sha
    const landed = await commit(repo, [memory("quarry", "Quarry stone is cut in winter.")])
    expect(server.held().sha).toBe(before)

    const searched = await cli(repo.root, ["head", "search", "quarry stone winter", "--limit", "1"])
    expect(searched.exitCode).toBe(0)
    expect(headOf(searched.body)).toMatchObject({ sha: landed, source: "server" })
    const hits = dataOf(searched.body).hits as ReadonlyArray<{ readonly path: string }>
    expect(hits[0]?.path).toBe("areas/inbox/quarry.html")
    // One version held, with no chain behind it.
    expect(server.held().sha).toBe(landed)
    expect(server.held().parent).toBeNull()
  })

  it("runs one advance for every request that arrived during it", async () => {
    const { repo } = await corpus()
    const server = await serve(repo.root, 0)
    const landed = await commit(repo, [memory("saddle"), memory("turbine"), memory("velvet")])
    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        run_(askHead({ root: repo.root, route: "status", schema: HeadServerStatus }))
      )
    )
    for (const answer of answers) expect(answer?.data.sha).toBe(landed)
    expect(server.stats().advances).toBe(1)
    expect(server.stats().records).toBe(WORDS.length + 3)
  })

  it("follows the ref between requests and caches the advanced version's snapshot", async () => {
    const { repo } = await corpus()
    const server = await serve(repo.root, 25)
    const landed = await commit(repo, [memory("anvil")])
    const deadline = Date.now() + 5000
    while (server.held().sha !== landed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(server.held().sha).toBe(landed)
    expect(server.stats().requests).toBe(0)
    const snapshot = snapshotPathFor(repo.root, landed)
    while (Date.now() < deadline) {
      if (
        await stat(snapshot).then(
          () => true,
          () => false
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect((await stat(snapshot)).size).toBeGreaterThan(0)
  })

  it("computes session put's neighbors at the session's base, not at the ref's tip", async () => {
    const { repo, sha: base } = await corpus()
    const started = await cli(repo.root, ["session", "start", "--id", "s1"])
    expect(started.exitCode).toBe(0)
    // main moves past the session's base; the server follows main. The cache is keyed by content
    // hash, so one embed at the tip covers every record the base holds too.
    await commit(repo, [memory("beacon", "Beacon towers are lit at dusk.")])
    const embedder = fakeEmbedder()
    expect((await cli(repo.root, ["head", "embed"], embedder)).exitCode).toBe(0)
    await serve(repo.root, 0, embedder)

    // A write and a label in one batch, the label on a record the base holds.
    const lines = [
      {
        op: "write" as const,
        params: {
          title: "Orchard pruning",
          claim: "Orchard trees are pruned in March.",
          memoryType: "semantic",
          entities: ["system:fixture"]
        }
      },
      { op: "label" as const, path: "areas/inbox/orchard.html", entity: "system:orchard" }
    ]
    const at = "2026-09-27T12:00:00Z"
    const answered = await run_(
      askHead({
        root: repo.root,
        route: "neighbors",
        schema: NeighborsAnswer,
        body: { sha: base, ops: [], lines, at }
      })
    )
    const local = await run_(loadHeadAt(repo.root, base, "git"))
    const expected = await run_(
      preparePuts({
        base: local.view,
        sessionOps: [],
        lines,
        at,
        cache: loadForSearch(repo.root),
        embedder
      })
    )
    expect(answered?.data.head.sha).toBe(base)
    expect(answered?.data.appended).toEqual(expected.appended)
    expect(answered?.data.appended.map((op) => op.kind)).toEqual(["put", "label"])
    expect(answered?.data.puts).toEqual(expected.puts)
    expect(answered?.data.neighbors).toEqual(expected.neighbors)
    expect(answered?.data.violations).toEqual(expected.violations)
    expect(answered?.data.blocking).toEqual([])
    expect(vectorFacts(answered?.data.vector)).toEqual(vectorFacts(expected.vector))
    expect(answered?.data.vector).toMatchObject({ used: true, reason: null })
    expect(answered?.data.neighbors[0]?.hits.some((hit) => hit.arms.includes("vector"))).toBe(true)
    // The record main gained after the base is nobody's neighbor here.
    const paths = answered?.data.neighbors.flatMap((entry) => entry.hits.map((hit) => hit.path))
    expect(paths).not.toContain("areas/inbox/beacon.html")

    // A label the base record already carries blocks the call on both paths, and only that one.
    const again = [
      { op: "label" as const, path: "areas/inbox/orchard.html", entity: "system:fixture" }
    ]
    const refused = await run_(
      askHead({
        root: repo.root,
        route: "neighbors",
        schema: NeighborsAnswer,
        body: { sha: base, ops: [], lines: again, at }
      })
    )
    const refusedHere = await run_(
      preparePuts({
        base: local.view,
        sessionOps: [],
        lines: again,
        at,
        cache: loadForSearch(repo.root),
        embedder
      })
    )
    expect(refused?.data.blocking).toEqual(refusedHere.blocking)
    expect(refused?.data.blocking.map((violation) => violation.kind)).toEqual(["format"])
    expect(refused?.data.vector).toBeNull()

    const ops = join(repo.root, "ops.jsonl")
    await writeFile(
      ops,
      [
        JSON.stringify({
          op: "write",
          title: "Orchard pruning",
          type: "semantic",
          body: "Orchard trees are pruned in March.",
          entity: "system:fixture"
        }),
        JSON.stringify({ op: "label", path: "areas/inbox/orchard.html", entity: "system:orchard" }),
        ""
      ].join("\n")
    )
    const put = await cli(repo.root, ["session", "put", "--id", "s1", "--file", ops])
    expect(put.exitCode).toBe(0)
    expect(headOf(put.body)).toMatchObject({ sha: base, source: "server" })
    expect(dataOf(put.body)).toMatchObject({
      appended: 2,
      labels: [{ kind: "label", path: "areas/inbox/orchard.html", entity: "system:orchard" }],
      vector: { used: true, reason: null }
    })
    const status = await cli(repo.root, ["session", "status", "--id", "s1"])
    expect(dataOf(status.body)).toMatchObject({ puts: 1, labels: 1 })
  })

  it("searches with the vector arm over the cache it holds, the same hits as the local path", async () => {
    const { repo, sha } = await corpus()
    const embedder = fakeEmbedder()
    expect((await cli(repo.root, ["head", "embed"], embedder)).exitCode).toBe(0)
    await serve(repo.root, 0, embedder)
    const served = await cli(repo.root, ["head", "search", "orchard facts"], embedder)
    const local = await cli(repo.root, ["head", "search", "orchard facts", "--no-server"], embedder)
    expect(headOf(served.body)).toMatchObject({ sha, source: "server" })
    expect(headOf(local.body).source).toBe("git")
    expect(dataOf(served.body).vector).toMatchObject({
      used: true,
      reason: null,
      cached: WORDS.length,
      coverage: 1,
      loadMs: 0
    })
    expect(vectorFacts(dataOf(served.body).vector)).toEqual(vectorFacts(dataOf(local.body).vector))
    expect(dataOf(served.body).hits).toEqual(dataOf(local.body).hits)
    const hits = dataOf(served.body).hits as ReadonlyArray<{ readonly arms: ReadonlyArray<string> }>
    expect(hits[0]?.arms).toContain("vector")
    // Same fields on both paths; only `head` tells them apart.
    expect(Object.keys(dataOf(served.body)).sort()).toEqual(Object.keys(dataOf(local.body)).sort())
  })

  it("picks up a cache written while it runs, with no restart", async () => {
    const { repo } = await corpus()
    const embedder = fakeEmbedder()
    const server = await serve(repo.root, 0, embedder)
    const search = () =>
      run_(
        askHead({
          root: repo.root,
          route: "search",
          schema: SearchAnswer,
          body: { query: "orchard facts" }
        })
      )
    expect((await search())?.data.vector).toMatchObject({ used: false, reason: "no-cache" })
    expect(server.stats().vectors).toMatchObject({ held: false, reason: "no-cache", loads: 0 })

    expect((await cli(repo.root, ["head", "embed"], embedder)).exitCode).toBe(0)
    const after = await search()
    expect(after?.data.vector).toMatchObject({ used: true, cached: WORDS.length, coverage: 1 })
    expect(after?.data.hits[0]?.arms).toContain("vector")
    const status = await run_(
      askHead({ root: repo.root, route: "status", schema: HeadServerStatus })
    )
    expect(status?.data.vectors).toMatchObject({
      held: true,
      reason: null,
      path: headVectorsPath(repo.root),
      entries: WORDS.length,
      coverage: 1,
      mtime: (await stat(headVectorsPath(repo.root))).mtime.toISOString(),
      loads: 1
    })

    // A record lands and a second embed rewrites the file: the server follows both.
    await commit(repo, [memory("quarry", "Quarry stone is cut in winter.")])
    expect((await cli(repo.root, ["head", "embed"], embedder)).exitCode).toBe(0)
    const status2 = await run_(
      askHead({ root: repo.root, route: "status", schema: HeadServerStatus })
    )
    expect(status2?.data.vectors).toMatchObject({
      entries: WORDS.length + 1,
      coverage: 1,
      loads: 2
    })

    // A file removed turns the arm off again, with the reason.
    await rm(headVectorsPath(repo.root))
    expect((await search())?.data.vector).toMatchObject({ used: false, reason: "no-cache" })
  })

  it("reads a changed cache once for every request that saw the change", async () => {
    const { repo } = await corpus()
    const embedder = fakeEmbedder()
    const server = await serve(repo.root, 0, embedder)
    expect((await cli(repo.root, ["head", "embed"], embedder)).exitCode).toBe(0)
    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        run_(
          askHead({
            root: repo.root,
            route: "search",
            schema: SearchAnswer,
            body: { query: "orchard facts" }
          })
        )
      )
    )
    for (const answer of answers) expect(answer?.data.vector.used).toBe(true)
    expect(server.stats().vectors.loads).toBe(1)
  })

  it("with no embedder never reads the cache, and says embedder-off", async () => {
    const { repo } = await corpus()
    expect((await cli(repo.root, ["head", "embed"], fakeEmbedder())).exitCode).toBe(0)
    const server = await serve(repo.root, 0, noEmbedder())
    const searched = await cli(repo.root, ["head", "search", "orchard facts"])
    expect(dataOf(searched.body).vector).toMatchObject({ used: false, reason: "embedder-off" })
    const status = await cli(repo.root, ["head", "status"])
    expect((dataOf(status.body).server as { readonly vectors: unknown }).vectors).toMatchObject({
      held: false,
      reason: "embedder-off",
      entries: null,
      loads: 0
    })
    expect(server.stats().vectors.loads).toBe(0)
  })

  it("reports a cache it cannot read and keeps answering on two arms", async () => {
    const { repo } = await corpus()
    const path = headVectorsPath(repo.root)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "not an arrow file")
    const server = await serve(repo.root, 0, fakeEmbedder())
    expect(server.stats().vectors).toMatchObject({
      held: false,
      reason: "cache-unreadable",
      detail: "vectors.read.decode",
      loads: 1
    })
    const searched = await run_(
      askHead({
        root: repo.root,
        route: "search",
        schema: SearchAnswer,
        body: { query: "orchard" }
      })
    )
    expect(searched?.data.vector).toMatchObject({ used: false, reason: "cache-unreadable" })
    expect(searched?.data.hits.length).toBeGreaterThan(0)
  })

  it("replaces a socket left by a killed server", async () => {
    const { repo, sha } = await corpus()
    const socket = headSocketPath(repo.root)
    await staleSocket(socket)
    const server = await serve(repo.root)
    const status = await run_(
      askHead({ root: repo.root, route: "status", schema: HeadServerStatus })
    )
    expect(status?.data).toMatchObject({ sha, socket: server.socket })
  })

  it("refuses to start beside a live server, naming it, and leaves that server serving", async () => {
    const { repo, sha } = await corpus()
    await serve(repo.root)
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    const second = await Effect.runPromiseExit(
      startHeadServer({ root: repo.root, pollMs: 0 }).pipe(Scope.provide(scope))
    )
    expect(Exit.isFailure(second)).toBe(true)
    const failure = Exit.isFailure(second) ? second.cause.reasons[0] : undefined
    const error = failure !== undefined && "error" in failure ? failure.error : undefined
    expect(error).toBeInstanceOf(HeadServerRunning)
    expect(error).toMatchObject({ pid: process.pid, ref: "refs/heads/main", sha })

    const refused = await cli(repo.root, ["head", "serve"])
    expect(refused.exitCode).toBe(1)
    expect(refused.body.code).toBe("ERR_HEAD_SERVER_RUNNING")
    expect(String(refused.body.error)).toContain(String(process.pid))

    const status = await run_(
      askHead({ root: repo.root, route: "status", schema: HeadServerStatus })
    )
    expect(status?.data.sha).toBe(sha)
  })

  it("removes its socket when its scope closes", async () => {
    const { repo } = await corpus()
    const scope = Scope.makeUnsafe()
    const server = await run_(
      startHeadServer({ root: repo.root, pollMs: 0 }).pipe(Scope.provide(scope))
    )
    expect((await lstat(server.socket)).isSocket()).toBe(true)
    await run_(Scope.close(scope, Exit.void))
    await expect(lstat(server.socket)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("the clients", () => {
  it("fall back to the local load when no server answers, stale socket or none", async () => {
    const { repo, sha } = await corpus()
    const none = await cli(repo.root, ["head", "search", "orchard"])
    expect(none.exitCode).toBe(0)
    expect(headOf(none.body)).toMatchObject({ sha, source: "git" })

    await staleSocket(headSocketPath(repo.root))
    const started = Date.now()
    const stale = await cli(repo.root, ["head", "status"])
    expect(stale.exitCode).toBe(0)
    expect(dataOf(stale.body)).toMatchObject({ sha, source: "git", server: null })
    expect(Date.now() - started).toBeLessThan(5000)

    await cli(repo.root, ["session", "start", "--id", "s2"])
    const ops = join(repo.root, "ops.jsonl")
    await writeFile(
      ops,
      `${JSON.stringify({ op: "write", title: "Compass rose", type: "semantic", body: "A compass rose has thirty-two points.", entity: "system:fixture" })}\n`
    )
    const put = await cli(repo.root, ["session", "put", "--id", "s2", "--file", ops])
    expect(put.exitCode).toBe(0)
    expect(headOf(put.body).source).not.toBe("server")
  })

  it("load locally under --no-server even with a server running", async () => {
    const { repo, sha } = await corpus()
    await serve(repo.root)
    const served = await cli(repo.root, ["head", "status"])
    expect(dataOf(served.body)).toMatchObject({ sha, source: "server" })
    expect((dataOf(served.body).server as { readonly pid: number }).pid).toBe(process.pid)
    const local = await cli(repo.root, ["head", "status", "--no-server"])
    expect(dataOf(local.body)).toMatchObject({ sha, source: "git", server: null })
    const search = await cli(repo.root, ["head", "search", "orchard", "--no-server"])
    expect(headOf(search.body).source).toBe("git")
  })
})

describe("head serve's usage guards", () => {
  it("refuses a negative --poll-ms and a blank --ref at exit 2", () => {
    expect(validate(parseArgv(["head", "serve", "--poll-ms", "-1"]))?.code).toBe("ERR_INVALID_FLAG")
    expect(validate(parseArgv(["head", "serve", "--ref", " "]))?.code).toBe("ERR_INVALID_FLAG")
    expect(validate(parseArgv(["head", "serve", "--poll-ms", "0"]))).toBeUndefined()
  })
})

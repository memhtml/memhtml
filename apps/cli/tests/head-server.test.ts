import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { OverlayOp } from "@memhtml/contracts"
import { renderTemplate } from "@memhtml/html"
import { snapshotPathFor } from "@memhtml/snapshot"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Logger, Schema, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { EmbedderShape } from "../src/api-layer.js"
import { COMMANDS } from "../src/commands.js"
import { recordView } from "../src/curate-run.js"
import { askHead } from "../src/head-client.js"
import {
  HeadServerRunning,
  HeadServerStatus,
  HeadSocketPathTooLong,
  headSocketPath,
  NeighborsAnswer,
  NeighborsRequest,
  SearchAnswer,
  socketPathMax
} from "../src/head-protocol.js"
import { type HeadServer, startHeadServer } from "../src/head-server.js"
import { headVectorsPath, loadForSearch } from "../src/head-vectors.js"
import { parseArgv, run, validate } from "../src/run.js"
import { loadHeadAt, preparePuts } from "../src/v2.js"
import { fakeEmbedder, noEmbedder } from "./harness.js"
import { writeStoreConfig } from "./strict-store.js"

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
 * - `head-protocol.ts` `NeighborsAnswer`: decode `appended` with a union lacking the
 *   `label`/`unlabel` members -> "computes session put's neighbors at the session's base" (the
 *   answer carrying the label fails to decode, so the client reads it as no server) and "decodes
 *   every op kind a log holds, unchanged" (2026-10-18).
 * - `head-protocol.ts` `NeighborsRequest` and `NeighborsAnswer`: decode the ops with
 *   `OverlayOpSchema.members.slice(0, 6)`, a union lacking `move` as the wire's own copy did ->
 *   "serves session put for a session whose log holds a move" (the server answers 400 and the put
 *   loads from git) and "decodes every op kind a log holds, unchanged" (2026-10-18).
 * - `commands.ts` `head status`: the `--server` help naming `head.source` again, as it did before
 *   0.16 -> "answers at the payload path each --server flag's help names" (`data.head.source` is
 *   undefined: `head status` reports `source` at the top level) (2026-10-18).
 * - `head-server.ts` `heldVectors`: drop the stamp re-check inside `vectorLock` -> "reads a changed
 *   cache once for every request that saw the change" (`loads` is 8).
 * - `head-server.ts` `heldVectors`: drop the `!embedderOn` early return -> "with no embedder never
 *   reads the cache, and says embedder-off" (the status holds the cache).
 * - `head-server.ts` `startHeadServer`: drop the `refuseLongSocket` call -> "refuses a store whose
 *   socket path is past the platform's limit, before it loads anything" (the start fails reading a
 *   ref in a directory that is no repo, and `head serve` answers ERR_GIT at the listen's EINVAL).
 * - `head-client.ts` `askHeadFor`: read the connect phase by errno again -> "fall back to the local
 *   load on a store whose socket path is past the limit" (`session exec` fails with ERR_STORAGE,
 *   "it may have appended the harvest", once the length check is also dropped).
 * - `head-server.ts` `startHeadServer`: drop the policy-source log line -> "logs where the store's
 *   policy comes from at startup" (no line names the defaults or the file).
 * - `head-server.ts` `app`: answer the status route without `policy` -> "logs where the store's
 *   policy comes from at startup, and status reports it as of each request" (`policy` is absent).
 */

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
const scopes: Array<Scope.Closeable> = []
const dirs: Array<string> = []
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A directory under a fresh temp dir whose `.memhtml/head.sock` is `bytes` UTF-8 bytes long, padded
 * with `unit` (one character, any width). The directory is made, empty.
 */
const deepRoot = async (bytes: number, unit = "d"): Promise<string> => {
  const base = await mkdtemp(join(tmpdir(), "memhtml-deep-"))
  dirs.push(base)
  // Everything but the padded segment: `<base>/` and `/.memhtml/head.sock`.
  const fixed = Buffer.byteLength(headSocketPath(join(base, "x"))) - 1
  const unitBytes = Buffer.byteLength(unit)
  const units = Math.floor((bytes - fixed) / unitBytes)
  const root = join(base, unit.repeat(units) + "d".repeat(bytes - fixed - units * unitBytes))
  await mkdir(root, { recursive: true })
  expect(Buffer.byteLength(headSocketPath(root))).toBe(bytes)
  return root
}

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
    expect(answered?.data.placements).toEqual(expected.placements)
    expect(answered?.data.placements).toEqual([
      { path: "areas/inbox/orchard-pruning.html", ordinal: 1 }
    ])
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
    // A dry run through the server answers the same placements and appends nothing.
    const preview = await cli(repo.root, [
      ...["session", "put", "--id", "s1", "--file", ops, "--dry-run"]
    ])
    expect(preview.exitCode).toBe(0)
    expect(headOf(preview.body)).toMatchObject({ sha: base, source: "server" })
    expect(dataOf(preview.body)).toMatchObject({
      dryRun: true,
      appended: 0,
      ops: 0,
      placements: [{ path: "areas/inbox/orchard-pruning.html", ordinal: 1 }]
    })
    const put = await cli(repo.root, ["session", "put", "--id", "s1", "--file", ops])
    expect(put.exitCode).toBe(0)
    expect(headOf(put.body)).toMatchObject({ sha: base, source: "server" })
    expect(dataOf(put.body)).toMatchObject({
      dryRun: false,
      appended: 2,
      placements: [{ path: "areas/inbox/orchard-pruning.html", ordinal: 1 }],
      labels: [{ kind: "label", path: "areas/inbox/orchard.html", entity: "system:orchard" }],
      vector: { used: true, reason: null }
    })
    const status = await cli(repo.root, ["session", "status", "--id", "s1"])
    expect(dataOf(status.body)).toMatchObject({ puts: 1, labels: 1 })
  })

  it("serves session put for a session whose log holds a move", async () => {
    const { repo, sha: base } = await corpus()
    expect((await cli(repo.root, ["session", "start", "--id", "s1"])).exitCode).toBe(0)
    await serve(repo.root)
    const from = "areas/inbox/orchard.html"
    const to = "resources/orchards/orchard.html"
    const moved = await cli(repo.root, [
      "session",
      "exec",
      "--id",
      "s1",
      "--lang",
      "bash",
      "--script",
      `mkdir -p /mnt/memhtml/resources/orchards && mv /mnt/memhtml/${from} /mnt/memhtml/${to}`
    ])
    expect(moved.exitCode).toBe(0)
    expect(dataOf(moved.body).server).toMatchObject({ used: true })
    expect(dataOf(moved.body)).toMatchObject({
      appended: 1,
      harvested: [{ kind: "move", path: from, to }]
    })
    const logged = await cli(repo.root, ["session", "status", "--id", "s1"])
    expect(dataOf(logged.body)).toMatchObject({ ops: 1, moves: 1, paths: [from, to] })

    // The log now carries the move, and every later put sends it to the neighbors route.
    const ops = join(repo.root, "ops.jsonl")
    await writeFile(
      ops,
      `${JSON.stringify({
        op: "write",
        title: "Glacier melt",
        type: "semantic",
        body: "Glacier melt peaks in late summer.",
        entity: "system:fixture"
      })}\n`
    )
    const put = await cli(repo.root, ["session", "put", "--id", "s1", "--file", ops])
    expect(put.exitCode).toBe(0)
    expect(headOf(put.body)).toMatchObject({ sha: base, source: "server" })
    expect(dataOf(put.body)).toMatchObject({ appended: 1, ops: 2 })

    // The commit route reads the log itself, the move included, and lands it.
    const landed = await cli(repo.root, ["session", "commit", "--id", "s1", "--message", "file"])
    expect(landed.exitCode).toBe(0)
    expect(dataOf(landed.body)).toMatchObject({ kind: "committed", via: "server" })
    expect(dataOf(landed.body).paths).toEqual(expect.arrayContaining([from, to]))
  })

  it("answers at the payload path each --server flag's help names", async () => {
    const { repo } = await corpus()
    expect((await cli(repo.root, ["session", "start", "--id", "s1"])).exitCode).toBe(0)
    await serve(repo.root)
    const ops = join(repo.root, "ops.jsonl")
    await writeFile(
      ops,
      `${JSON.stringify({
        op: "write",
        title: "Glacier melt",
        type: "semantic",
        body: "Glacier melt peaks in late summer.",
        entity: "system:fixture"
      })}\n`
    )
    const calls: Readonly<Record<string, ReadonlyArray<string>>> = {
      "head status": ["head", "status"],
      "head search": ["head", "search", "orchard facts"],
      "session put": ["session", "put", "--id", "s1", "--file", ops],
      "session exec": ["session", "exec", "--id", "s1", "--lang", "bash", "--script", "true"],
      "session rebase": ["session", "rebase", "--id", "s1"]
    }
    // Every command whose --server help says "`<field>` is `server`", with the field it names.
    const claims = COMMANDS.flatMap((command) => {
      const help = command.flags.find((flag) => flag.name === "server")?.description ?? ""
      const field = /`([\w.]+)` is `server`/.exec(help)?.[1]
      return field === undefined ? [] : [{ name: command.name, field }]
    })
    expect(claims.map((claim) => claim.name).sort()).toEqual(Object.keys(calls).sort())
    for (const { name, field } of claims) {
      const result = await cli(repo.root, calls[name] ?? [])
      expect(result.exitCode, name).toBe(0)
      const value = field
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          dataOf(result.body)
        )
      expect(value, `${name}: data.${field}`).toBe("server")
    }
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

  it("refuses a store whose socket path is past the platform's limit, before it loads anything", async () => {
    const max = socketPathMax()
    if (max === null) return
    // 100 characters, 110 bytes: a character count would let it through to a listen that fails.
    const root = await deepRoot(110, "é")
    expect(headSocketPath(root).length).toBeLessThanOrEqual(max)
    // No repo here at all, so anything that read a ref first would fail on that instead.
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    const started = await Effect.runPromiseExit(
      startHeadServer({ root, pollMs: 0 }).pipe(Scope.provide(scope))
    )
    expect(Exit.isFailure(started)).toBe(true)
    const reason = Exit.isFailure(started) ? started.cause.reasons[0] : undefined
    const error = reason !== undefined && "error" in reason ? reason.error : undefined
    expect(error).toBeInstanceOf(HeadSocketPathTooLong)
    expect(error).toMatchObject({ socket: headSocketPath(root), bytes: 110, max })

    const refused = await cli(root, ["head", "serve"])
    expect(refused.exitCode).toBe(1)
    expect(refused.body.code).toBe("ERR_STORAGE")
    expect(String(refused.body.error)).toContain(`110 bytes, past the ${String(max)}`)
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

  it("fall back to the local load on a store whose socket path is past the limit", async () => {
    const max = socketPathMax()
    if (max === null) return
    const { repo, sha } = await corpus()
    // The store moved under a path that puts its socket at 127 bytes, with no server running.
    const root = await deepRoot(127)
    await rm(root, { recursive: true })
    await rename(repo.root, root)
    const status = await cli(root, ["head", "status"])
    expect(status.exitCode).toBe(0)
    expect(dataOf(status.body)).toMatchObject({ sha, source: "git", server: null })

    expect((await cli(root, ["session", "start", "--id", "deep"])).exitCode).toBe(0)
    const exec = await cli(root, [
      "session",
      "exec",
      "--id",
      "deep",
      "--script",
      "ls /mnt/memhtml/areas/inbox"
    ])
    expect(exec.exitCode).toBe(0)
    expect(dataOf(exec.body).server).toEqual({
      used: false,
      base: null,
      reason: "no-server",
      detail: `socket path is 127 bytes, past the ${String(max)} this platform allows`
    })
    expect(String(dataOf(exec.body).stdout)).toContain("harbor.html")
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

describe("the wire's op schema", () => {
  const html = memory("orchard").html
  /** One op of every kind; a kind the contract gains and this lacks is a type error here. */
  const everyKind: { readonly [K in OverlayOp["kind"]]: Extract<OverlayOp, { kind: K }> } = {
    put: { kind: "put", path: "areas/inbox/new.html", html },
    archive: {
      kind: "archive",
      path: "areas/inbox/orchard.html",
      to: "archive/2026/areas/inbox/orchard.html",
      html
    },
    link: {
      kind: "link",
      path: "areas/inbox/a.html",
      rel: "supports",
      href: "/areas/inbox/b.html"
    },
    unlink: {
      kind: "unlink",
      path: "areas/inbox/a.html",
      rel: "supports",
      href: "/areas/inbox/b.html"
    },
    label: { kind: "label", path: "areas/inbox/a.html", entity: "system:orchard" },
    unlabel: { kind: "unlabel", path: "areas/inbox/a.html", entity: "system:fixture" },
    move: {
      kind: "move",
      path: "areas/inbox/orchard.html",
      to: "resources/orchards/orchard.html",
      html
    }
  }
  const ops = Object.values(everyKind)

  it("decodes every op kind a log holds, unchanged, in a neighbors request and its answer", () => {
    for (const op of ops) {
      const request = { sha: "0".repeat(40), ops: [op], lines: [], at: "2026-10-18T12:00:00Z" }
      const decoded = Schema.decodeUnknownSync(NeighborsRequest, { onExcessProperty: "error" })(
        request
      )
      expect(decoded).toEqual(request)
      expect(Schema.encodeSync(NeighborsRequest)(decoded)).toEqual(request)
      const answer = {
        appended: [op],
        puts: [],
        placements: [],
        neighbors: [],
        violations: [],
        blocking: [],
        vector: null,
        head: { sha: request.sha, ref: "refs/heads/main", records: 0, skipped: null }
      }
      expect(
        Schema.decodeUnknownSync(NeighborsAnswer, { onExcessProperty: "error" })(answer)
      ).toEqual(answer)
    }
    expect(ops.map((op) => op.kind).sort()).toEqual(
      ["archive", "label", "link", "move", "put", "unlabel", "unlink"].sort()
    )
  })
})

describe("head serve's usage guards", () => {
  it("refuses a negative --poll-ms and a blank --ref at exit 2", () => {
    expect(validate(parseArgv(["head", "serve", "--poll-ms", "-1"]))?.code).toBe("ERR_INVALID_FLAG")
    expect(validate(parseArgv(["head", "serve", "--ref", " "]))?.code).toBe("ERR_INVALID_FLAG")
    expect(validate(parseArgv(["head", "serve", "--poll-ms", "0"]))).toBeUndefined()
  })
})

describe("the store's policy source", () => {
  /** A server in its own scope, with every log line it writes kept in `logs`. */
  const serveLogged = async (root: string, logs: Array<string>): Promise<HeadServer> => {
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    const capture = Logger.layer([Logger.make((options) => logs.push(String(options.message)))])
    return run_(
      startHeadServer({ root, pollMs: 0, embedder: noEmbedder() }).pipe(
        Scope.provide(scope),
        Effect.provide(capture)
      )
    )
  }

  it("logs where the store's policy comes from at startup, and status reports it as of each request", async () => {
    const { repo } = await corpus()
    const logs: Array<string> = []
    const server = await serveLogged(repo.root, logs)
    expect(logs.filter((line) => line.includes("policy") || line.includes("config.json"))).toEqual([
      "head serve: memhtml.config.json absent: library defaults"
    ])
    const path = join(repo.root, "memhtml.config.json")
    const status = async () => (await raw(server.socket, "GET", "/v1/status")).json.policy
    expect(await status()).toEqual({ source: "defaults", path, reason: null })
    const headStatus = dataOf((await cli(repo.root, ["head", "status"])).body)
    expect(headStatus.policy).toEqual({ source: "defaults", path, reason: null })
    expect((headStatus.server as Record<string, unknown>).policy).toEqual(headStatus.policy)

    // The file appears, then breaks: the next status says so, with no restart, and still answers.
    await writeStoreConfig(repo.root)
    expect(await status()).toEqual({ source: "file", path, reason: null })
    await writeStoreConfig(repo.root, { config: "{not json" })
    const broken = await raw(server.socket, "GET", "/v1/status")
    expect(broken.status).toBe(200)
    expect(broken.json.policy).toMatchObject({
      source: "invalid",
      path,
      reason: expect.any(String)
    })
    const local = dataOf((await cli(repo.root, ["head", "status", "--no-server"])).body)
    expect(local).toMatchObject({ server: null, policy: { source: "invalid", path } })
  })

  it("names the policy file a server starts over, and warns when it does not decode", async () => {
    const { repo } = await corpus()
    const path = await writeStoreConfig(repo.root, { commit: true })
    const logs: Array<string> = []
    await serveLogged(repo.root, logs)
    expect(logs).toContain(`head serve: policy from ${path}`)

    const other = await corpus()
    await writeStoreConfig(other.repo.root, { config: "{not json" })
    const warned: Array<string> = []
    await serveLogged(other.repo.root, warned)
    expect(
      warned.filter((line) =>
        line.startsWith(
          `head serve: ${join(other.repo.root, "memhtml.config.json")} does not decode`
        )
      )
    ).toHaveLength(1)
  })
})

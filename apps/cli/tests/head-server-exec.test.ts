import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { withOverlay } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import { sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { EmbedderShape } from "../src/api-layer.js"
import { killedStderr, makeExecPool } from "../src/exec-pool.js"
import { askHead } from "../src/head-client.js"
import { EXEC_BODY_MAX_BYTES, headSocketPath, SearchAnswer } from "../src/head-protocol.js"
import { type HeadServer, startHeadServer } from "../src/head-server.js"
import { run } from "../src/run.js"
import { cacheImage, type GuestJob, seedFor } from "../src/session-exec.js"
import { loadHeadAt } from "../src/v2.js"
import { fakeEmbedder } from "./harness.js"

/**
 * `session exec` through the head server (`/v1/exec`, `docs/v2-poc.md`, "Head server", "Exec"), in
 * process over real temp git repos and a real Unix socket, with the deterministic embedder bound
 * to the server.
 *
 * Every parity claim compares the server's payload with a `--no-server` run of the same script on a
 * twin session started at the same base, field by field except the ones that name the path taken
 * (`head`, `server`), the session id, and the wall clock; and the two logs after, op by op.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-server.ts` `serveExec`: run the body directly instead of through `oneAtATime` -> "runs two
 *   execs of one session one after the other" (the second harvest is refused as `session log`
 *   moved, `opsTotal` 1).
 * - `head-server.ts` `startHeadServer`: `runtime.runner` -> `inProcessRunner` (the script runs on the
 *   server's thread) -> "keeps answering searches while a runaway script runs to its deadline" (no
 *   search answers until the loop ends).
 * - `head-server.ts` `execBase`: treat every base as an ancestor -> "declines a base off its ref's
 *   history, and the CLI runs the script itself" (the server serves it).
 * - `head-server.ts` `execBody`: drop the `MaxBodySize` bound -> "refuses a body over the cap with
 *   413" (the chunked case is read whole and answered 500 for its session).
 * - `run.ts`: drop the `EXEC_BODY_MAX_BYTES` check -> "refuses a script over the cap at exit 2,
 *   with the server and without it" (the script runs).
 * - `v2.ts` `sessionExec`: treat a `lost` answer as `no-server` -> "fails rather than runs the
 *   script again when the server took it and the answer was lost" (the script runs here and appends).
 * - `session-exec.ts` `seedFor`: reuse the base's bytes whenever the path matches, without the
 *   `hit.html === record.html` check -> "answers the same report as a local run" (the read after the
 *   label sees the base's head, not the labeled one) and "seeds an overlaid path from the view".
 * - `exec-pool.ts` `post`: drop the deadline `setTimeout` -> "terminates a worker that passes its
 *   deadline, and starts another" (the job never answers; the case times out).
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

const WORDS = ["harbor", "glacier", "orchard", "furnace", "lantern", "compass"]
const AT = "2026-03-01T12:00:00Z"

const memory = (word: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim: `${word[0]?.toUpperCase() ?? ""}${word.slice(1)} facts are recorded here.`,
    memoryType: "semantic",
    at: AT,
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
  options: { readonly embedder?: EmbedderShape; readonly execWorkerPath?: string } = {}
): Promise<HeadServer> => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  return run_(
    startHeadServer({
      root,
      pollMs: 0,
      embedder: options.embedder ?? fakeEmbedder(),
      execWorkerPath: options.execWorkerPath
    }).pipe(Scope.provide(scope))
  )
}

type Body = Record<string, unknown>

/** `memhtml <argv> --repo <root>` in process, parsed. */
const cli = async (
  root: string,
  argv: ReadonlyArray<string>
): Promise<{ exitCode: number; body: Body }> => {
  const result = await run([...argv, "--repo", root], undefined, undefined, false)
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Body }
}

const dataOf = (body: Body) => body.data as Body

/** `session exec --id <id> --script <script>`, through the server unless `local`. */
const exec = async (
  root: string,
  id: string,
  script: string,
  options: {
    readonly local?: boolean
    readonly lang?: "bash" | "js" | undefined
    readonly timeoutMs?: number
  } = {}
): Promise<{ exitCode: number; body: Body }> =>
  cli(root, [
    "session",
    "exec",
    "--id",
    id,
    "--script",
    script,
    ...(options.lang === undefined ? [] : ["--lang", options.lang]),
    ...(options.timeoutMs === undefined ? [] : ["--timeout-ms", String(options.timeoutMs)]),
    ...(options.local === true ? ["--no-server"] : [])
  ])

/** The payload without what names the path taken, the session, or the wall clock. */
const comparable = (data: Body) => {
  const { head: _head, server: _server, id: _id, durationMs: _ms, ...rest } = data
  return rest
}

const logOf = async (root: string, id: string) =>
  (JSON.parse(await readFile(sessionStateFile(root, id), "utf8")) as { ops: unknown[] }).ops

/** A record under the workspace that clears the write bar, as a nested heredoc writes it. */
const NEW_RECORD = renderTemplate({
  title: "Session exec through the head server",
  claim: "The head server runs session exec scripts in a worker thread.",
  memoryType: "semantic",
  at: AT,
  entities: ["system:memhtml"]
})

const writeScript = (path: string, html: string) =>
  [
    `mkdir -p /mnt/memhtml/${dirname(path)}`,
    `cat > /mnt/memhtml/${path} <<'HTML'`,
    html.trimEnd(),
    "HTML"
  ].join("\n")

describe("session exec through the head server", () => {
  it("answers the same report as a local run, for a read, a heredoc write, a sed label, and js", async () => {
    const { repo } = await corpus()
    const server = await serve(repo.root)
    for (const id of ["srv", "loc"]) {
      expect((await cli(repo.root, ["session", "start", "--id", id])).exitCode).toBe(0)
    }
    const scripts: ReadonlyArray<{ readonly script: string; readonly lang?: "js" }> = [
      {
        script:
          "grep -rl 'system:fixture' /mnt/memhtml/areas | sort; wc -l < /mnt/memhtml/areas/inbox/orchard.html"
      },
      { script: writeScript("projects/memhtml/server-exec.html", NEW_RECORD) },
      {
        script:
          'sed -i \'s#</head>#<meta name="memhtml-entity" content="project:fixture">\\n</head>#\' /mnt/memhtml/areas/inbox/harbor.html'
      },
      // The label is in the log now, not in the base: the server's cached image of the base holds
      // the old head for this path, and the guest must be seeded with the labeled one.
      {
        script:
          "grep -c 'project:fixture' /mnt/memhtml/areas/inbox/harbor.html; ls /mnt/memhtml/projects/memhtml"
      },
      {
        lang: "js",
        script: [
          'import { corpus } from "/workspace/lib/corpus.mjs"',
          "const memories = corpus()",
          'console.log(JSON.stringify({ records: memories.size, labeled: memories.get("/areas/inbox/harbor.html")?.entities }))'
        ].join("\n")
      }
    ]
    for (const { script, lang } of scripts) {
      const served = await exec(repo.root, "srv", script, { lang })
      const local = await exec(repo.root, "loc", script, { lang, local: true })
      expect(served.exitCode).toBe(0)
      expect(local.exitCode).toBe(0)
      const s = dataOf(served.body)
      const l = dataOf(local.body)
      expect(s.head).toMatchObject({ source: "server" })
      expect(s.server).toEqual({ used: true, base: "tip", reason: null, detail: null })
      expect((l.head as Body).source).not.toBe("server")
      expect(l.server).toEqual({ used: false, base: null, reason: "disabled", detail: null })
      expect(comparable(s)).toEqual(comparable(l))
      expect(s.exitCode).toBe(0)
      expect(await logOf(repo.root, "srv")).toEqual(await logOf(repo.root, "loc"))
    }
    const log = (await logOf(repo.root, "srv")) as ReadonlyArray<Body>
    expect(log.map((op) => [op.kind, op.path])).toEqual([
      ["put", "projects/memhtml/server-exec.html"],
      ["label", "areas/inbox/harbor.html"]
    ])
    const reads = await exec(
      repo.root,
      "srv",
      "grep -c 'project:fixture' /mnt/memhtml/areas/inbox/harbor.html"
    )
    expect(dataOf(reads.body).stdout).toBe("1\n")
    expect(server.stats().exec.jobs).toBe(scripts.length + 1)
  })

  it("serves a session whose base is an ancestor of the tip, built from the tip", async () => {
    const { repo } = await corpus()
    for (const id of ["srv", "loc"]) {
      expect((await cli(repo.root, ["session", "start", "--id", id])).exitCode).toBe(0)
    }
    const server = await serve(repo.root)
    await commit(repo, [memory("beacon")], "a later commit")
    const script = "ls /mnt/memhtml/areas/inbox"
    const served = dataOf((await exec(repo.root, "srv", script)).body)
    const local = dataOf((await exec(repo.root, "loc", script, { local: true })).body)
    expect(served.server).toMatchObject({ used: true, base: "ancestor" })
    expect(served.stdout).not.toContain("beacon")
    expect(comparable(served)).toEqual(comparable(local))
    expect(server.held().sha).not.toBe(served.baseSha)
  })

  it("declines a base off its ref's history, and the CLI runs the script itself", async () => {
    const { repo, sha } = await corpus()
    await run_(repo.git.run(["checkout", "-q", "-b", "side"]))
    await commit(repo, [memory("beacon")], "on a side branch")
    await run_(repo.git.run(["checkout", "-q", "main"]))
    expect(
      (await cli(repo.root, ["session", "start", "--id", "side", "--ref", "side"])).exitCode
    ).toBe(0)
    await serve(repo.root)
    const result = await exec(repo.root, "side", "ls /mnt/memhtml/areas/inbox")
    expect(result.exitCode).toBe(0)
    const data = dataOf(result.body)
    expect(data.server).toMatchObject({ used: false, reason: "base-unservable" })
    expect(String((data.server as Body).detail)).toContain(sha)
    expect((data.head as Body).source).not.toBe("server")
    expect(data.stdout).toContain("beacon.html")
  })

  it("runs two execs of one session one after the other, the second over the first's harvest", async () => {
    const { repo } = await corpus()
    await serve(repo.root)
    expect((await cli(repo.root, ["session", "start", "--id", "pair"])).exitCode).toBe(0)
    const record = (index: number) =>
      renderTemplate({
        title: `Serialized exec ${index}`,
        claim: `Serialized exec number ${index} lands in the session log.`,
        memoryType: "semantic",
        at: AT,
        entities: ["system:memhtml"]
      })
    // Each script sleeps, so the two overlap unless the server holds the second back.
    const script = (index: number) =>
      `sleep 0.4\n${writeScript(`projects/memhtml/serialized-${index}.html`, record(index))}`
    const [first, second] = await Promise.all([
      exec(repo.root, "pair", script(1)),
      exec(repo.root, "pair", script(2))
    ])
    const reports = [dataOf(first.body), dataOf(second.body)]
    for (const report of reports) {
      expect(report.server).toMatchObject({ used: true })
      expect(report.appended).toBe(1)
      expect(report.blocking).toEqual([])
    }
    expect(reports.map((report) => report.opsTotal).sort()).toEqual([1, 2])
    const log = (await logOf(repo.root, "pair")) as ReadonlyArray<Body>
    expect(log.map((op) => op.path).sort()).toEqual([
      "projects/memhtml/serialized-1.html",
      "projects/memhtml/serialized-2.html"
    ])
  })

  it("keeps answering searches while a runaway script runs to its deadline", async () => {
    const { repo } = await corpus()
    await serve(repo.root)
    expect((await cli(repo.root, ["session", "start", "--id", "loop"])).exitCode).toBe(0)
    const started = Date.now()
    let execDone = 0
    const looping = exec(repo.root, "loop", "while true; do :; done", { timeoutMs: 3000 }).then(
      (result) => {
        execDone = Date.now()
        return result
      }
    )
    // Let the exec reach its worker before searching.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const searches: Array<{ readonly ms: number; readonly at: number }> = []
    for (let index = 0; index < 5; index += 1) {
      const asked = Date.now()
      const answer = await run_(
        askHead({
          root: repo.root,
          route: "search",
          schema: SearchAnswer,
          body: { query: `${WORDS[index] ?? "harbor"} facts`, limit: 3 }
        })
      )
      expect(answer?.data.hits.length).toBeGreaterThan(0)
      searches.push({ ms: Date.now() - asked, at: Date.now() })
    }
    const result = await looping
    const data = dataOf(result.body)
    expect(result.exitCode).toBe(0)
    expect(data).toMatchObject({ exitCode: 124, timedOut: true, timeoutMs: 3000, appended: 0 })
    expect(data.server).toMatchObject({ used: true })
    // Every search answered while the loop was still running, and fast.
    for (const search of searches) {
      expect(search.at).toBeLessThan(execDone)
      expect(search.ms).toBeLessThan(1000)
    }
    expect(execDone - started).toBeGreaterThanOrEqual(3000)
  }, 20_000)

  it("refuses a body over the cap with 413, declared or chunked", async () => {
    const { repo } = await corpus()
    const server = await serve(repo.root)
    const big = JSON.stringify({ id: "s1", script: "x".repeat(EXEC_BODY_MAX_BYTES), lang: "bash" })
    const post = (chunked: boolean): Promise<{ status: number; json: Body }> =>
      new Promise((resolve, reject) => {
        const req = request(
          { socketPath: server.socket, method: "POST", path: "/v1/exec" },
          (res) => {
            let text = ""
            res.on("data", (chunk: Buffer) => {
              text += chunk.toString("utf8")
            })
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Body })
            )
          }
        )
        req.once("error", reject)
        req.setHeader("content-type", "application/json")
        if (chunked) {
          for (let at = 0; at < big.length; at += 65_536) req.write(big.slice(at, at + 65_536))
          req.end()
        } else {
          req.setHeader("content-length", String(Buffer.byteLength(big)))
          req.end(big)
        }
      })
    for (const chunked of [false, true]) {
      const answer = await post(chunked)
      expect(answer.status).toBe(413)
      expect(answer.json).toMatchObject({ code: "ERR_INVALID_FLAG" })
      expect(String(answer.json.error)).toContain(String(EXEC_BODY_MAX_BYTES))
    }
  })

  it("refuses a script over the cap at exit 2, with the server and without it", async () => {
    const { repo } = await corpus()
    expect((await cli(repo.root, ["session", "start", "--id", "cap"])).exitCode).toBe(0)
    const script = `echo ${"x".repeat(EXEC_BODY_MAX_BYTES)} > /mnt/memhtml/projects/memhtml/big.html`
    for (const withServer of [true, false]) {
      if (withServer) await serve(repo.root)
      const result = await exec(repo.root, "cap", script, { local: !withServer })
      expect(result.exitCode).toBe(2)
      expect(result.body).toMatchObject({ code: "ERR_INVALID_FLAG" })
      expect(String(result.body.error)).toContain(String(EXEC_BODY_MAX_BYTES))
      await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
    }
    expect(await logOf(repo.root, "cap")).toEqual([])
  })

  it("runs the script here when no server answers, and says so", async () => {
    const { repo } = await corpus()
    expect((await cli(repo.root, ["session", "start", "--id", "alone"])).exitCode).toBe(0)
    const result = await exec(
      repo.root,
      "alone",
      writeScript("projects/memhtml/alone.html", NEW_RECORD)
    )
    expect(result.exitCode).toBe(0)
    const data = dataOf(result.body)
    expect(data.server).toEqual({ used: false, base: null, reason: "no-server", detail: "ENOENT" })
    expect((data.head as Body).source).not.toBe("server")
    expect(data.appended).toBe(1)
    expect(await logOf(repo.root, "alone")).toHaveLength(1)
  })

  it("fails rather than runs the script again when the server took it and the answer was lost", async () => {
    const { repo } = await corpus()
    expect((await cli(repo.root, ["session", "start", "--id", "lost"])).exitCode).toBe(0)
    // A listener that reads the request and hangs up without answering: a server that crashed
    // mid-exec looks like this to the client.
    const socket = headSocketPath(repo.root)
    await mkdir(dirname(socket), { recursive: true })
    const fake: Server = createServer((connection) => {
      connection.once("data", () => connection.destroy())
    })
    await new Promise<void>((resolve) => fake.listen(socket, resolve))
    try {
      const result = await exec(
        repo.root,
        "lost",
        writeScript("projects/memhtml/lost.html", NEW_RECORD)
      )
      expect(result.exitCode).toBe(1)
      expect(result.body).toMatchObject({ code: "ERR_STORAGE" })
      expect(String(result.body.error)).toContain("session status")
      expect(await logOf(repo.root, "lost")).toEqual([])
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })
})

describe("the seed image", () => {
  it("seeds an overlaid path from the view, not from the cached base", async () => {
    const { repo, sha } = await corpus()
    const base = (await run_(loadHeadAt(repo.root, sha, "git"))).view
    const cached = cacheImage(base)
    const path = "areas/inbox/harbor.html"
    const view = await run_(withOverlay(base, [{ kind: "label", path, entity: "project:fixture" }]))
    const { image, seeded } = seedFor(view, cached)
    const at = image.paths.indexOf(path)
    const [buffer, start, end] = [
      image.slots[at * 3],
      image.slots[at * 3 + 1],
      image.slots[at * 3 + 2]
    ]
    const bytes = new Uint8Array(image.buffers[buffer ?? 0] as ArrayBuffer).subarray(start, end)
    const html = new TextDecoder().decode(bytes)
    expect(html).toBe(view.get(path)?.html)
    expect(html).toContain("project:fixture")
    expect(seeded.get(path)?.html).toBe(html)
    // Every other path reuses the base's shared buffer.
    const other = image.paths.indexOf("areas/inbox/orchard.html")
    expect(image.slots[other * 3]).toBe(0)
    expect(image.buffers[0]).toBe(cached.image.buffers[0])
  })
})

describe("the exec pool", () => {
  it("terminates a worker that passes its deadline, and starts another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memhtml-exec-pool-"))
    dirs.push(dir)
    // A stand-in runner that answers ready, then blocks its thread on every job.
    const stub = join(dir, "wedged.mjs")
    await writeFile(
      stub,
      [
        'import { parentPort } from "node:worker_threads"',
        "parentPort.on('message', () => { for (;;) {} })",
        "parentPort.postMessage({ ready: true })"
      ].join("\n")
    )
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    const pool = await run_(makeExecPool({ size: 1, workerPath: stub }).pipe(Scope.provide(scope)))
    const job = {} as GuestJob
    const started = Date.now()
    const first = await run_(pool.runner(1000)(job, { deadlineMs: 400 }))
    expect(first).toMatchObject({ exitCode: 124, stderr: killedStderr(400), changed: [] })
    expect(Date.now() - started).toBeLessThan(3000)
    const second = await run_(pool.runner(1000)(job, { deadlineMs: 300 }))
    expect(second.exitCode).toBe(124)
    expect(pool.stats()).toMatchObject({ killed: 2, started: 2, jobs: 2, busy: 0 })
  })
})

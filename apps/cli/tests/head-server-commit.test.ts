import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { archivePathFor } from "@memhtml/contracts/paths"
import { addLink, renderTemplate } from "@memhtml/html"
import { SESSIONS_DIR, sessionStateFile } from "@memhtml/session"
import { snapshotPathFor } from "@memhtml/snapshot"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Fiber, Option, Scope, Semaphore } from "effect"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { COMMIT_DEADLINE_VAR, headSocketPath } from "../src/head-protocol.js"
import { type HeadServer, holdingPermit, startHeadServer } from "../src/head-server.js"
import { run } from "../src/run.js"
import { writeStoreConfig } from "./strict-store.js"

/**
 * `session commit` and `session rebase` through the head server (`/v1/commit`, `/v1/rebase`), in
 * process over real temp git repos and a real Unix socket.
 *
 * The parity case runs one script of commits and rebases twice, through the server on one repo and
 * with `--no-server` on its twin, under a pinned git clock, so the two repos make byte-identical
 * commits and every payload can be compared as printed JSON, key order included, with only `via`,
 * `server`, `head`, and the snapshot write's wall clock and root taken out.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-server.ts` `holdingPermit`: run the effect without taking the permit -> "declines a
 *   commit that waited past the queue bound as busy, and the CLI commits it here" (none is busy)
 *   and "answers none, having run nothing, when the permit stays held past the wait".
 * - `head-server.ts` `holdingPermit`: drop `uninterruptibleMask`, so the effect runs interruptibly
 *   -> "finishes an effect that started when its caller is interrupted, and runs none that was
 *   waiting" (`first` is cut short). The stop case below passes either way: the platform's close
 *   waits for a request in flight, so it is a behavior check, not this guard's proof.
 * - `head-server.ts` `landed`: drop the `state.version = next` step -> "commits concurrent sessions
 *   one at a time, holds every new commit, and writes its snapshot" (the held version stays at the
 *   old tip with the poll off); answer `null` instead of `commitSnapshot(next)` -> the same case
 *   (no snapshot in the answer).
 * - `head-server.ts` `serveCommit`: judge the session against the held tip instead of the version
 *   at its base -> "answers the four conflict cases exactly as a local commit does" (a session
 *   behind the tip is committed without the `rebase-needed` a local commit answers).
 * - `head-protocol.ts` `CommitResult`: swap `sha` and `paths` -> the same case (the printed
 *   envelopes differ in key order).
 * - `head-server.ts` `sessionToWrite`: drop the `other-ref` check -> "declines a session on another
 *   ref, and the CLI commits it here" (the server commits it).
 * - `head-server.ts` `app`: decode `/v1/commit` without `onExcessProperty: "error"` -> "refuses a
 *   body with an unknown field" (the commit runs).
 * - `v2.ts` `unanswered`: answer a 5xx as `refused` -> "fails rather than commits again when the
 *   server took the commit and answered 500" (the commit runs here and moves main).
 * - `v2.ts` `unanswered`: answer `lost` as `no-server` -> "fails rather than commits again when no
 *   answer came within the deadline" (the commit runs here and moves main).
 * - `head-server.ts` `serveCommit`: `COMMIT_REBASE_ROUNDS` rounds -> none (the loop never runs) ->
 *   "lands each of six concurrent run-end commits in one call" (five answer `rebase-needed`) and
 *   "reports the ops an early round dropped" (`rebase-needed`).
 * - `head-server.ts` `serveCommit`: rebase rounds without `dropRefused` -> "lands each of six ...
 *   and without the flag answers rebase-needed as before" (all six plain commits land).
 * - `head-server.ts` `serveCommit`: answer the last round's `dropped` alone -> "reports the ops an
 *   early round dropped" (`dropped` is empty).
 * - `v2.ts` `commitOverHead`: commit a log with no ops instead of answering `refused` -> "a commit
 *   of a log with no ops ... touches nothing" (main gains an empty `memhtml(session)` commit).
 * - `v2.ts` `commitOverHead` (2026-10-26): the log committed without the repoints it lacks appended
 *   -> "completes the new edge when the log is committed after a rebase here" and "completes a log
 *   an older writer left with the archive alone" (both refused, naming the note that still cites
 *   the vacated path) and "completes it in the server's rebase round under --drop-refused" (the
 *   archive and the first note's repoint are dropped and the successor lands alone).
 * - `v2.ts` `commitOverHead` (2026-10-26): the completion's `overflow` ignored -> "refuses by name
 *   an archive whose new repoints would pass the cap" (the commit goes on to a dangling-edge
 *   refusal); the drop rounds without completing the kept ops again -> "puts back a repoint a drop
 *   on its holder took" (the archive is dropped next and the successor lands alone).
 * - `moves.ts` `afterDroppedVacates` (2026-10-26): `keep` answered unchanged -> "takes the
 *   archive's own repoint pairs with it" (the label and the move go with the pairs), "keeps a move
 *   whose holder cited a move the round dropped" (the second move goes too), "aims a kept put's
 *   edge to a dropped move's destination back at the record" and "refuses by name an archive whose
 *   new repoints would pass the cap" (the edge names a path nothing wrote, and doctor reports the
 *   successor's); the pair match skipped -> the first two and the cap case (the pairs land aimed
 *   back at the record, and `dropped` lists the vacate alone); the put rewrite skipped -> the last
 *   two; the ops at a dropped move's destination left there -> "makes the ops kept at a dropped
 *   move's destination at its source" (the archive overflows the cap and is dropped too). Since
 *   2026-10-26, also: the pairs taken only when the destination is empty and the record live ->
 *   the four "takes ... pairs" cases under "when its destination is held, its record is not live,
 *   or the round drops a chain" (a note lands citing the record at the held path, or loses its
 *   label); the chain stopped at the vacate's own source -> the two "aims ..." cases there (the
 *   edge names a path nothing wrote).
 * - `v2.ts` `commitOverHead` (2026-10-26): a dropped pair keyed by its own path -> "does not list a
 *   pair the round took at a dropped move's destination that comes back where the holder stays".
 */

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
const scopes: Array<Scope.Closeable> = []
const dirs: Array<string> = []
const fakes: Array<Server> = []
afterEach(async () => {
  await Promise.all(
    fakes.splice(0).map(
      (fake) =>
        new Promise<void>((resolve) => {
          fake.closeAllConnections()
          fake.close(() => resolve())
        })
    )
  )
  await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const AT = "2026-03-01T12:00:00Z"

const memory = (word: string, claim: string) => ({
  path: `areas/inbox/${word}.html`,
  html: renderTemplate({
    title: word,
    claim,
    memoryType: "semantic",
    at: AT,
    entities: ["system:fixture"]
  })
})

/** The record the frame-key case contradicts: `the capital of India is` with one value. */
const CAPITAL = memory("capital-of-india", "The capital of India is New Delhi.")

const CORPUS = [
  memory("harbor", "Harbor pilots board ships at the outer buoy."),
  memory("glacier", "Glacier ice moves about a meter a day."),
  memory("orchard", "Orchard trees are pruned in late winter."),
  CAPITAL
]

const commitFiles = async (
  repo: FixtureRepo,
  files: ReadonlyArray<{ readonly path: string; readonly html: string }>,
  message: string
): Promise<string> => {
  for (const file of files) {
    const target = join(repo.root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.html, "utf8")
  }
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", message]))
  return tipOf(repo)
}

const tipOf = async (repo: FixtureRepo): Promise<string> => {
  const sha = await run_(repo.git.revParseHead())
  if (sha === null) throw new Error("no HEAD")
  return sha
}

const corpus = async (): Promise<FixtureRepo> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  await commitFiles(repo, CORPUS, "corpus")
  return repo
}

/** A server in its own scope, closed after the test; the poll is off unless a case turns it on. */
const serve = async (
  root: string,
  options: { readonly commitQueueWaitMs?: number } = {}
): Promise<HeadServer> => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  return run_(
    startHeadServer({ root, pollMs: 0, commitQueueWaitMs: options.commitQueueWaitMs }).pipe(
      Scope.provide(scope)
    )
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

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-commit-route-"))
  dirs.push(dir)
  return dir
}

/** `session put --no-server` of `write` lines, every one anchored to an entity. */
const put = async (
  root: string,
  id: string,
  lines: ReadonlyArray<Record<string, unknown>>
): Promise<Body> => {
  const file = join(await scratch(), `${id}.jsonl`)
  await writeFile(
    file,
    lines
      .map((line) => JSON.stringify({ op: "write", entity: "system:fixture", ...line }))
      .join("\n"),
    "utf8"
  )
  const result = await cli(root, ["session", "put", "--id", id, "--file", file, "--no-server"])
  expect(result.exitCode, JSON.stringify(result.body)).toBe(0)
  return dataOf(result.body)
}

const start = async (root: string, id: string, ref?: string): Promise<void> => {
  const result = await cli(root, [
    "session",
    "start",
    "--id",
    id,
    ...(ref === undefined ? [] : ["--ref", ref])
  ])
  expect(result.exitCode, JSON.stringify(result.body)).toBe(0)
}

const commitCli = (
  root: string,
  id: string,
  options: { readonly local?: boolean; readonly dropRefused?: boolean } = {}
) =>
  cli(root, [
    "session",
    "commit",
    "--id",
    id,
    "--message",
    `commit ${id}`,
    ...(options.dropRefused === true ? ["--drop-refused"] : []),
    ...(options.local === true ? ["--no-server"] : [])
  ])

const rebaseCli = (root: string, id: string, options: { readonly local?: boolean } = {}) =>
  cli(root, ["session", "rebase", "--id", id, ...(options.local === true ? ["--no-server"] : [])])

const logOf = async (root: string, id: string) =>
  JSON.parse(await readFile(sessionStateFile(root, id), "utf8")) as {
    readonly baseSha: string
    readonly ops: ReadonlyArray<unknown>
    readonly pending?: string
  }

const mainOf = async (repo: FixtureRepo): Promise<string> =>
  (await run_(repo.git.run(["rev-parse", "refs/heads/main"]))).trim()

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/** A listener on the store's socket that answers every request with `answer`, or never. */
const fakeServer = async (
  root: string,
  answer: ((incoming: IncomingMessage) => { status: number; body: unknown }) | "hang"
): Promise<void> => {
  const socket = headSocketPath(root)
  await mkdir(dirname(socket), { recursive: true })
  const fake = createServer((incoming, outgoing) => {
    incoming.resume()
    if (answer === "hang") return
    incoming.once("end", () => {
      const { status, body } = answer(incoming)
      outgoing.writeHead(status, { "content-type": "application/json" })
      outgoing.end(JSON.stringify(body))
    })
  })
  fakes.push(fake)
  await new Promise<void>((resolve) => fake.listen(socket, resolve))
}

/** A session holding one fresh put, ready to commit. */
const oneWrite = async (root: string, id: string, title: string): Promise<void> => {
  await start(root, id)
  await put(root, id, [{ title, type: "semantic", body: `${title} is recorded in this session.` }])
}

const SHARED = "areas/inbox/shared-slot.html"

/**
 * The parity script's sessions, every one started at the corpus tip with its puts. A put stamps its
 * record with the clock, so the twin repo gets a copy of these logs rather than puts of its own.
 */
const conflictSessions = async (root: string): Promise<void> => {
  for (const id of ["dj-a", "dj-b", "sp-a", "sp-b", "sp-c", "dh-a", "dh-b", "fk"]) {
    await start(root, id)
  }
  const one = { title: "Shared", type: "semantic", path: SHARED, body: "Shared slot one." }
  await put(root, "dj-a", [
    { title: "Disjoint A", type: "semantic", body: "Disjoint fact A names lane one." }
  ])
  await put(root, "dj-b", [
    { title: "Disjoint B", type: "semantic", body: "Disjoint fact B names lane two." }
  ])
  await put(root, "sp-a", [one])
  await put(root, "sp-b", [{ ...one, body: "Shared slot two." }])
  await put(root, "sp-c", [one])
  const twin = "Twins share exactly one claim about lane forty."
  await put(root, "dh-a", [{ title: "Twin A", type: "semantic", body: twin }])
  await put(root, "dh-b", [{ title: "Twin B", type: "semantic", body: twin }])
  await put(root, "fk", [
    { title: "Capital revised", type: "semantic", body: "The capital of India is Mumbai." }
  ])
}

/** The twin gets the same sessions: the logs and index files, over the same base commit. */
const copySessions = (from: string, to: string): Promise<void> =>
  cp(join(from, SESSIONS_DIR), join(to, SESSIONS_DIR), { recursive: true })

/**
 * The parity script: the four conflict cases of the session suite (disjoint paths, the same path,
 * the same article under two titles, a frame-key contradiction), each a sequence of commits and
 * rebases, with `--drop-refused` on one refusal. Every commit and rebase payload in order.
 */
const conflictScript = async (root: string, local: boolean): Promise<ReadonlyArray<Body>> => {
  const payloads: Array<Body> = []
  const step = async (result: Promise<{ exitCode: number; body: Body }>): Promise<Body> => {
    const { exitCode, body } = await result
    expect(exitCode, JSON.stringify(body)).toBe(0)
    payloads.push(dataOf(body))
    return dataOf(body)
  }
  const commit = (id: string, dropRefused = false) =>
    step(commitCli(root, id, { local, dropRefused }))
  const rebase = (id: string) => step(rebaseCli(root, id, { local }))
  const shared = SHARED

  // Disjoint: the second is behind the first and lands after a rebase.
  expect((await commit("dj-a")).kind).toBe("committed")
  expect(await commit("dj-b")).toMatchObject({ kind: "rebase-needed", overlapping: [] })
  expect((await rebase("dj-b")).moved).toBe(true)
  expect((await commit("dj-b")).kind).toBe("committed")
  // The same path: the overlap is named, then a rebase reveals a claim edit and a duplicate.
  await rebase("sp-a")
  expect((await commit("sp-a")).kind).toBe("committed")
  expect(await commit("sp-b")).toMatchObject({ kind: "rebase-needed", overlapping: [shared] })
  await rebase("sp-b")
  expect(await commit("sp-b")).toMatchObject({
    kind: "refused",
    violations: [{ kind: "claim-edit", path: shared }]
  })
  await rebase("sp-c")
  const dropped = await commit("sp-c", true)
  expect(dropped).toMatchObject({ kind: "refused", dropped: [{ kind: "put", path: shared }] })
  // One article under two titles: the second is refused naming the first once rebased.
  await rebase("dh-a")
  expect((await commit("dh-a")).kind).toBe("committed")
  await rebase("dh-b")
  expect(await commit("dh-b")).toMatchObject({
    kind: "refused",
    violations: [
      { kind: "duplicate", path: "areas/inbox/twin-b.html", existing: "areas/inbox/twin-a.html" }
    ]
  })
  // A frame-key contradiction: both live, the new one linked to the old.
  await rebase("fk")
  expect(await commit("fk")).toMatchObject({
    kind: "committed",
    contradictions: [
      { path: "areas/inbox/capital-revised.html", against: "areas/inbox/capital-of-india.html" }
    ]
  })
  return payloads
}

/** A payload as printed, without what names the path taken, the root, or the snapshot's clock. */
const printed = (root: string, data: Body): string => {
  const { via: _via, server: _server, head: _head, ...rest } = data
  return JSON.stringify(rest, (key, value: unknown) =>
    key === "ms" ? 0 : typeof value === "string" ? value.replaceAll(root, "<root>") : value
  )
}

describe("session commit and rebase through the head server", () => {
  // A pinned git clock, so the twin repos below make byte-identical commits.
  const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE }
  beforeAll(() => {
    process.env.GIT_AUTHOR_DATE = "2026-03-01T12:00:00Z"
    process.env.GIT_COMMITTER_DATE = "2026-03-01T12:00:00Z"
  })
  afterAll(() => {
    for (const [name, value] of [
      ["GIT_AUTHOR_DATE", saved.author],
      ["GIT_COMMITTER_DATE", saved.committer]
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("answers the four conflict cases exactly as a local commit does", async () => {
    const served = await corpus()
    const local = await corpus()
    expect(await mainOf(served)).toBe(await mainOf(local))
    const server = await serve(served.root)
    await conflictSessions(served.root)
    await copySessions(served.root, local.root)

    const viaServer = await conflictScript(served.root, false)
    const viaLocal = await conflictScript(local.root, true)

    expect(viaServer).toHaveLength(viaLocal.length)
    for (const [index, data] of viaServer.entries()) {
      const twin = viaLocal[index] as Body
      expect(data.via).toBe("server")
      expect(data.server).toMatchObject({ used: true, base: expect.any(String), reason: null })
      expect(twin.via).toBe("local")
      expect(twin.server).toEqual({ used: false, base: null, reason: "disabled", detail: null })
      if (data.head !== undefined) {
        expect(data.head).toMatchObject({ source: "server" })
        expect((twin.head as Body).source).not.toBe("server")
      }
      expect(printed(served.root, data)).toBe(printed(local.root, twin))
    }
    // Behind the tip, the server judged the base it built from the tip; at the tip, the tip.
    const bases = viaServer.flatMap((data) =>
      data.kind === undefined ? [] : [(data.server as Body).base]
    )
    expect(bases).toContain("ancestor")
    expect(bases).toContain("tip")
    expect(await mainOf(served)).toBe(await mainOf(local))
    for (const id of ["dj-b", "sp-b", "sp-c", "dh-b", "fk"]) {
      expect(await logOf(served.root, id)).toEqual(await logOf(local.root, id))
    }
    expect(server.held().sha).toBe(await mainOf(served))
  }, 60_000)

  it("judges a base off the ref's history from a version it loads, as a local commit does", async () => {
    const served = await corpus()
    const local = await corpus()
    await oneWrite(served.root, "off", "Off history")
    await copySessions(served.root, local.root)
    for (const repo of [served, local]) {
      // Main is rewritten to a commit that does not descend from the session's base.
      await run_(repo.git.run(["checkout", "-q", "--orphan", "rewritten"]))
      await commitFiles(repo, [memory("beacon", "Beacon lamps burn kerosene.")], "rewritten")
      await run_(repo.git.run(["branch", "-f", "main", "rewritten"]))
      await run_(repo.git.run(["checkout", "-q", "main"]))
    }
    await serve(served.root)
    const viaServer = await commitCli(served.root, "off")
    const viaLocal = await commitCli(local.root, "off", { local: true })
    expect(viaServer.exitCode).toBe(0)
    const data = dataOf(viaServer.body)
    expect(data).toMatchObject({ kind: "rebase-needed", via: "server" })
    expect(data.server).toMatchObject({ used: true, base: "loaded" })
    expect(printed(served.root, data)).toBe(printed(local.root, dataOf(viaLocal.body)))
  })
})

describe("the head server's commit route", () => {
  it("commits concurrent sessions one at a time, holds every new commit, and writes its snapshot", async () => {
    const repo = await corpus()
    const before = await mainOf(repo)
    const server = await serve(repo.root)
    const ids = ["c1", "c2", "c3", "c4", "c5"]
    for (const id of ids) await oneWrite(repo.root, id, `Concurrent note ${id}`)

    const first = await Promise.all(ids.map((id) => commitCli(repo.root, id)))
    const kinds = first.map((result) => dataOf(result.body).kind)
    expect(kinds.filter((kind) => kind === "committed")).toHaveLength(1)
    expect(kinds.filter((kind) => kind === "rebase-needed")).toHaveLength(ids.length - 1)
    for (const result of first) expect(dataOf(result.body).via).toBe("server")

    let pending = ids.filter((_, index) => kinds[index] !== "committed")
    for (let round = 0; pending.length > 0 && round < ids.length; round += 1) {
      const rebased = await Promise.all(pending.map((id) => rebaseCli(repo.root, id)))
      for (const result of rebased) {
        expect(dataOf(result.body)).toMatchObject({ via: "server", head: { source: "server" } })
      }
      const again = await Promise.all(pending.map((id) => commitCli(repo.root, id)))
      pending = pending.filter((_, index) => dataOf(again[index]?.body ?? {}).kind !== "committed")
    }
    expect(pending).toEqual([])
    const count = Number(
      (await run_(repo.git.run(["rev-list", "--count", `${before}..main`]))).trim()
    )
    expect(count).toBe(ids.length)

    // One more, with nothing asked after it: the held version is the commit it made, and the
    // snapshot the answer names is on disk.
    await oneWrite(repo.root, "c6", "Concurrent note c6")
    const last = dataOf((await commitCli(repo.root, "c6")).body)
    expect(last).toMatchObject({ kind: "committed", via: "server" })
    expect(server.held().sha).toBe(last.sha)
    expect(server.stats().advances).toBe(ids.length + 1)
    const snapshot = last.snapshot as Body
    expect(snapshot.sha).toBe(last.sha)
    expect(snapshot.path).toBe(snapshotPathFor(repo.root, String(last.sha)))
    expect(await exists(String(snapshot.path))).toBe(true)
  }, 60_000)

  it("declines a commit that waited past the queue bound as busy, and the CLI commits it here", async () => {
    const repo = await corpus()
    // Off main, so the local commits racing the server's never move the shared checkout at once.
    await run_(repo.git.run(["checkout", "-q", "--detach"]))
    await serve(repo.root, { commitQueueWaitMs: 1 })
    const ids = ["b1", "b2", "b3", "b4"]
    for (const id of ids) await oneWrite(repo.root, id, `Busy note ${id}`)
    const results = await Promise.all(ids.map((id) => commitCli(repo.root, id)))
    const data = results.map((result) => dataOf(result.body))
    const busy = data.filter((entry) => (entry.server as Body).reason === "busy")
    expect(busy.length).toBeGreaterThan(0)
    for (const entry of busy) {
      expect(entry.via).toBe("local")
      expect((entry.server as Body).used).toBe(false)
    }
    // However they were split, one commit of the same base landed and the rest are behind it.
    expect(data.filter((entry) => entry.kind === "committed")).toHaveLength(1)
    expect(data.filter((entry) => entry.kind === "rebase-needed")).toHaveLength(ids.length - 1)
  })

  it("declines a session on another ref, and the CLI commits it here", async () => {
    const repo = await corpus()
    const server = await serve(repo.root)
    const before = server.held().sha
    await start(repo.root, "side", "curate/2026-10-01")
    await put(repo.root, "side", [
      { title: "Side note", type: "semantic", body: "A side branch note lands on its own ref." }
    ])
    const result = await commitCli(repo.root, "side")
    expect(result.exitCode).toBe(0)
    const data = dataOf(result.body)
    expect(data).toMatchObject({
      kind: "committed",
      via: "local",
      ref: "refs/heads/curate/2026-10-01"
    })
    expect(data.server).toMatchObject({ used: false, base: null, reason: "other-ref" })
    expect(String((data.server as Body).detail)).toContain("refs/heads/main")
    expect(await mainOf(repo)).toBe(before)

    const rebased = dataOf((await rebaseCli(repo.root, "side")).body)
    expect(rebased).toMatchObject({ via: "local", server: { reason: "other-ref" } })
  })

  it("declines a session whose log does not read, and the CLI answers the local error", async () => {
    const repo = await corpus()
    await serve(repo.root)
    const viaServer = await commitCli(repo.root, "missing")
    const viaLocal = await commitCli(repo.root, "missing", { local: true })
    expect(viaServer.exitCode).toBe(1)
    expect(viaServer.body).toEqual(viaLocal.body)
    expect(viaServer.body).toMatchObject({ code: "ERR_STORAGE" })
  })

  it("refuses a body with an unknown field", async () => {
    const repo = await corpus()
    const server = await serve(repo.root)
    await oneWrite(repo.root, "extra", "Extra field")
    const before = await mainOf(repo)
    const post = (path: string, body: Body) =>
      new Promise<{ status: number; json: Body }>((resolve, reject) => {
        const req = request({ socketPath: server.socket, method: "POST", path }, (res) => {
          let text = ""
          res.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8")
          })
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Body })
          )
        })
        req.once("error", reject)
        req.setHeader("content-type", "application/json")
        req.end(JSON.stringify(body))
      })
    for (const answer of [
      await post("/v1/commit", { id: "extra", message: "m", force: true }),
      await post("/v1/rebase", { id: "extra", force: true })
    ]) {
      expect(answer.status).toBe(400)
      expect(answer.json).toMatchObject({ code: "ERR_INVALID_FLAG" })
    }
    expect(await mainOf(repo)).toBe(before)
    expect((await logOf(repo.root, "extra")).ops).toHaveLength(1)
  })

  it("finishes a commit it started when the server stops mid-commit", async () => {
    const repo = await corpus()
    const scope = Scope.makeUnsafe()
    const server = await run_(
      startHeadServer({ root: repo.root, pollMs: 0 }).pipe(Scope.provide(scope))
    )
    const before = await mainOf(repo)
    await oneWrite(repo.root, "stopped", "Stopped server")
    // The compare-and-swap of main waits 3 s in git's reference-transaction hook, past the 2 s the
    // closing server grants requests in flight, so the stop lands in the middle of the commit.
    const hooks = join(repo.root, ".git", "hooks")
    await mkdir(hooks, { recursive: true })
    await writeFile(
      join(hooks, "reference-transaction"),
      '#!/bin/sh\nread -r _old _new ref\nif [ "$1" = prepared ] && [ "$ref" = refs/heads/main ]; then sleep 3; fi\nexit 0\n',
      { mode: 0o755 }
    )
    await run_(repo.git.run(["config", "core.hooksPath", hooks]))
    const req = request({ socketPath: server.socket, method: "POST", path: "/v1/commit" })
    req.once("error", () => undefined)
    req.setHeader("content-type", "application/json")
    req.end(JSON.stringify({ id: "stopped", message: "stopped" }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const stopping = Date.now()
    await run_(Scope.close(scope, Exit.void))
    // The stop waited for the commit rather than cut it short.
    expect(Date.now() - stopping).toBeGreaterThan(1500)
    const tip = await mainOf(repo)
    expect(tip).not.toBe(before)
    const log = await logOf(repo.root, "stopped")
    expect(log).toMatchObject({ baseSha: tip, ops: [] })
    expect(log.pending).toBeUndefined()
    expect(server.held().sha).toBe(tip)
    expect(await exists(snapshotPathFor(repo.root, tip))).toBe(true)
  }, 60_000)
})

describe("the head server's rebase rounds under --drop-refused", () => {
  it("lands each of six concurrent run-end commits in one call, and without the flag answers rebase-needed as before", async () => {
    const repo = await corpus()
    const before = await mainOf(repo)
    await serve(repo.root)
    // With --drop-refused: the first in line lands at its base, and each one behind it is rebased
    // onto the tip and committed again while it holds the permit, so every call answers committed.
    const ids = ["r1", "r2", "r3", "r4", "r5", "r6"]
    for (const id of ids) await oneWrite(repo.root, id, `Run end note ${id}`)
    const rounds = await Promise.all(
      ids.map((id) => commitCli(repo.root, id, { dropRefused: true }))
    )
    for (const result of rounds) {
      expect(result.exitCode, JSON.stringify(result.body)).toBe(0)
      expect(dataOf(result.body)).toMatchObject({ kind: "committed", via: "server", dropped: [] })
    }
    const rebased = rounds.map((result) => dataOf(result.body).rebased).sort()
    expect(rebased).toEqual([0, 1, 1, 1, 1, 1])
    for (const result of rounds) {
      if (dataOf(result.body).rebased === 1) {
        expect(dataOf(result.body).server).toMatchObject({ used: true, base: "tip" })
      }
    }
    const count = async () =>
      Number((await run_(repo.git.run(["rev-list", "--count", `${before}..main`]))).trim())
    expect(await count()).toBe(ids.length)
    for (const id of ids) expect((await logOf(repo.root, id)).ops).toEqual([])

    // Without it: one lands and the rest are answered rebase-needed, unrebased, for the caller to decide.
    const plain = ["p1", "p2", "p3", "p4", "p5", "p6"]
    for (const id of plain) await oneWrite(repo.root, id, `Plain note ${id}`)
    const answers = (await Promise.all(plain.map((id) => commitCli(repo.root, id)))).map((result) =>
      dataOf(result.body)
    )
    for (const data of answers) expect(data).toMatchObject({ via: "server", rebased: 0 })
    const kinds = answers.map((data) => data.kind)
    expect(kinds.filter((kind) => kind === "committed")).toHaveLength(1)
    expect(kinds.filter((kind) => kind === "rebase-needed")).toHaveLength(plain.length - 1)
    expect(await count()).toBe(ids.length + 1)
  }, 60_000)

  it("reports the ops an early round dropped with the outcome the last round reached", async () => {
    const repo = await corpus()
    await serve(repo.root)
    await start(repo.root, "dup")
    const putted = await put(repo.root, "dup", [
      // The glacier record's article under another title: a duplicate at the session's base.
      { title: "Glacier again", type: "semantic", body: "Glacier ice moves about a meter a day." },
      { title: "Fresh fact", type: "semantic", body: "Fresh facts arrive with the morning tide." }
    ])
    const [twin, fresh] = putted.paths as ReadonlyArray<string>
    // Another session lands first, so the drop round is followed by a rebase-needed round.
    await oneWrite(repo.root, "ahead", "Ahead of dup")
    expect(dataOf((await commitCli(repo.root, "ahead")).body).kind).toBe("committed")

    const data = dataOf((await commitCli(repo.root, "dup", { dropRefused: true })).body)
    expect(data).toMatchObject({
      kind: "committed",
      via: "server",
      rebased: 1,
      paths: [fresh],
      dropped: [{ kind: "put", path: twin }]
    })
  }, 60_000)
})

/** A note with one edge, as a record of the corpus or a put of a log. */
const note = (
  title: string,
  claim: string,
  rel: "relates_to" | "supersedes",
  href: string,
  entities: ReadonlyArray<string> = ["project:acme-widget"]
) =>
  addLink(
    renderTemplate({ title, claim, memoryType: "semantic", at: AT, entities: [...entities] }),
    rel,
    href
  )

const treeOf = async (repo: FixtureRepo): Promise<ReadonlyArray<string>> =>
  (await run_(repo.git.run(["ls-tree", "-r", "--name-only", "main"])))
    .split("\n")
    .filter((path) => path.length > 0)

describe("an archive whose ref gained an edge to the archived path before the commit", () => {
  const retired = "areas/inbox/orchard.html"
  const slot = archivePathFor(retired, 2031)
  const successor = "resources/acme-widget/a.html"
  const cited = "resources/acme-widget/c.html"
  const later = "resources/acme-widget/d.html"
  const citedHtml = (entities?: ReadonlyArray<string>) =>
    note(
      "Orchard note",
      "Orchard ladders are stored by the gate.",
      "relates_to",
      `/${retired}`,
      entities
    )

  /** The corpus, a note citing the orchard record, and the session `retire` started over both. */
  const citedCorpus = async (): Promise<FixtureRepo> => {
    const repo = await corpus()
    await commitFiles(
      repo,
      [{ path: cited, html: citedHtml() }],
      "a note citing the orchard record"
    )
    await start(repo.root, "retire")
    return repo
  }

  /**
   * The session's exec puts a successor that supersedes the orchard record at its archive slot and
   * archives the record, so the harvest repoints the note that cites it.
   */
  const retireByExec = async (root: string): Promise<void> => {
    const script = [
      `mkdir -p /mnt/memhtml/${dirname(successor)} /mnt/memhtml/${dirname(slot)}`,
      `cat > /mnt/memhtml/${successor} <<'HTML'`,
      note(
        "Orchard pruning, revised",
        "Pruning in the orchard moved to the first dry week of spring.",
        "supersedes",
        `/${slot}`
      ).trimEnd(),
      "HTML",
      `mv /mnt/memhtml/${retired} /mnt/memhtml/${slot}`
    ].join("\n")
    const harvest = await cli(root, [
      "session",
      "exec",
      "--id",
      "retire",
      "--script",
      script,
      "--no-server"
    ])
    expect(dataOf(harvest.body).blocking, JSON.stringify(harvest.body)).toEqual([])
    expect(dataOf(harvest.body).harvested).toEqual([
      { kind: "put", path: successor },
      { kind: "unlink", path: cited },
      { kind: "link", path: cited },
      { kind: "archive", path: retired, to: slot }
    ])
  }

  /** Another writer lands a second note citing the record at its live path. */
  const anotherCites = (repo: FixtureRepo) =>
    commitFiles(
      repo,
      [
        {
          path: later,
          html: note(
            "Orchard gate note",
            "The orchard gate is locked at dusk.",
            "relates_to",
            `/${retired}`
          )
        }
      ],
      "another writer's note citing the orchard record"
    )

  /** The exec's session, then another writer's note the log knows nothing of. */
  const raced = async (): Promise<FixtureRepo> => {
    const repo = await citedCorpus()
    await retireByExec(repo.root)
    await anotherCites(repo)
    return repo
  }

  /** The landed tree: the record at its slot, the notes and the successor naming the slot. */
  const landedWhole = async (
    repo: FixtureRepo,
    notes: ReadonlyArray<string> = [cited, later]
  ): Promise<void> => {
    const paths = await treeOf(repo)
    expect(paths).toContain(slot)
    expect(paths).not.toContain(retired)
    for (const [path, rel] of [
      ...notes.map((one) => [one, "relates-to"] as const),
      [successor, "supersedes"] as const
    ]) {
      const html = await run_(repo.git.run(["show", `main:${path}`]))
      expect(html, path).toContain(`<link rel="memhtml-${rel}" href="/${slot}">`)
      expect(html, path).not.toContain(`href="/${retired}"`)
    }
  }

  it("completes the new edge when the log is committed after a rebase here", async () => {
    const repo = await raced()
    const first = dataOf((await commitCli(repo.root, "retire", { local: true })).body)
    expect(first.kind).toBe("rebase-needed")
    expect((await rebaseCli(repo.root, "retire", { local: true })).exitCode).toBe(0)
    const landed = await commitCli(repo.root, "retire", { local: true })
    expect(dataOf(landed.body), JSON.stringify(landed.body)).toMatchObject({
      kind: "committed",
      dropped: []
    })
    await landedWhole(repo)
  }, 60_000)

  it("completes a log an older writer left with the archive alone", async () => {
    const repo = await raced()
    expect((await rebaseCli(repo.root, "retire", { local: true })).exitCode).toBe(0)
    // The repoint pair taken out, as a log written before the harvest completed archives holds it.
    const file = sessionStateFile(repo.root, "retire")
    const state = JSON.parse(await readFile(file, "utf8")) as { ops: Array<{ kind: string }> }
    state.ops = state.ops.filter((op) => op.kind === "put" || op.kind === "archive")
    await writeFile(file, JSON.stringify(state), "utf8")
    const landed = await commitCli(repo.root, "retire", { local: true })
    expect(dataOf(landed.body), JSON.stringify(landed.body)).toMatchObject({
      kind: "committed",
      dropped: []
    })
    await landedWhole(repo)
  }, 60_000)

  it("refuses by name an archive whose new repoints would pass the cap, writes nothing, and lets --drop-refused land the rest", async () => {
    const repo = await citedCorpus()
    // 195 puts and the exec's four ops: 199, one short of the cap, until the ref gains a citer.
    await put(
      repo.root,
      "retire",
      Array.from({ length: 195 }, (_, at) => ({
        title: `Filler ${String(at)}`,
        type: "semantic",
        body: `Filler record ${String(at)} weighs ${String(at + 3)} grams in this fixture.`
      }))
    )
    await retireByExec(repo.root)
    await anotherCites(repo)
    expect((await rebaseCli(repo.root, "retire", { local: true })).exitCode).toBe(0)
    const log = await readFile(sessionStateFile(repo.root, "retire"), "utf8")
    expect((await logOf(repo.root, "retire")).ops).toHaveLength(199)
    const refused = dataOf((await commitCli(repo.root, "retire", { local: true })).body)
    expect(refused).toMatchObject({
      kind: "refused",
      violations: [
        {
          kind: "format",
          path: retired,
          reasons: [
            `archived to ${slot}, and repointing the 1 edge live records carry to /${retired} that the log does not repoint would take it to 201 ops, over the cap of 200: archive it in a session of its own`
          ]
        }
      ]
    })
    expect(await readFile(sessionStateFile(repo.root, "retire"), "utf8")).toBe(log)
    // --drop-refused takes the archive out with the first note's repoint pair, in one round, and
    // lands the rest. The record stays live, so both notes still cite it where it is, and the
    // successor's supersedes edge to the slot nothing writes now names the live record instead.
    const landed = dataOf(
      (await commitCli(repo.root, "retire", { local: true, dropRefused: true })).body
    )
    expect(landed.kind, JSON.stringify(landed)).toBe("committed")
    const dropped = landed.dropped as ReadonlyArray<{
      kind: string
      path: string
      reasons: string[]
    }>
    expect(dropped.map((op) => [op.kind, op.path])).toEqual([
      ["archive", retired],
      ["unlink", cited],
      ["link", cited]
    ])
    expect(dropped[0]?.reasons.at(-1)).toBe(
      `the edges kept ops aimed at /${slot} now name /${retired}, where the record still is: ${successor} supersedes`
    )
    // The pair goes under the archive's own refusal.
    expect(dropped[1]?.reasons).toEqual(dropped[0]?.reasons.slice(0, -1))
    expect(dropped[2]?.reasons).toEqual(dropped[1]?.reasons)
    expect(landed.paths).toHaveLength(196)
    const paths = await treeOf(repo)
    expect(paths).toContain(retired)
    expect(paths).not.toContain(slot)
    expect(paths).toContain(successor)
    for (const [path, rel] of [
      [cited, "relates-to"],
      [later, "relates-to"],
      [successor, "supersedes"]
    ] as const) {
      const html = await run_(repo.git.run(["show", `main:${path}`]))
      expect(html, path).toContain(`<link rel="memhtml-${rel}" href="/${retired}">`)
      expect(html, path).not.toContain(`href="/${slot}"`)
    }
    expect((await logOf(repo.root, "retire")).ops).toEqual([])
    // So doctor, over the landed tree, finds no dangling edge for --fix or the curator's integrity
    // rule to cut.
    await run_(repo.git.run(["reset", "-q", "--hard", "main"]))
    expect((await cli(repo.root, ["index", "update"])).exitCode).toBe(0)
    const doctor = dataOf((await cli(repo.root, ["doctor"])).body)
    expect(doctor.dangling).toEqual([])
  }, 120_000)

  it("puts back a repoint a drop on its holder took, and drops only the refused op", async () => {
    const repo = await citedCorpus()
    await retireByExec(repo.root)
    await put(repo.root, "retire", [{ op: "label", path: cited, entity: "system:orchard" }])
    // Another writer gives the note the same label, keeping its edge, so the session's label is
    // refused, and the drop of every op on the note takes its repoint pair with the label.
    await commitFiles(
      repo,
      [{ path: cited, html: citedHtml(["project:acme-widget", "system:orchard"]) }],
      "another writer labels the note"
    )
    expect((await rebaseCli(repo.root, "retire", { local: true })).exitCode).toBe(0)
    const landed = dataOf(
      (await commitCli(repo.root, "retire", { local: true, dropRefused: true })).body
    )
    expect(landed.kind, JSON.stringify(landed)).toBe("committed")
    expect((landed.dropped as ReadonlyArray<Body>).map((op) => [op.kind, op.path])).toEqual([
      ["label", cited]
    ])
    await landedWhole(repo, [cited])
  }, 60_000)

  it("completes it in the server's rebase round under --drop-refused, and drops nothing", async () => {
    const repo = await raced()
    await serve(repo.root)
    const landed = await commitCli(repo.root, "retire", { dropRefused: true })
    expect(dataOf(landed.body), JSON.stringify(landed.body)).toMatchObject({
      kind: "committed",
      via: "server",
      rebased: 1,
      dropped: []
    })
    await landedWhole(repo)
  }, 60_000)
})

describe("a --drop-refused round that drops an archive or a move", () => {
  const harbor = "areas/inbox/harbor.html"
  const glacier = "areas/inbox/glacier.html"
  const slot = archivePathFor(harbor, 2031)
  const n1 = "resources/acme-widget/n1.html"
  const n3 = "resources/acme-widget/n3.html"
  const n4 = "resources/acme-widget/n4.html"
  const htmlAt = (repo: FixtureRepo, path: string) => run_(repo.git.run(["show", `main:${path}`]))

  /** Ops a writer appends to the log as written, after `count` filler puts. */
  const writeLog = async (
    root: string,
    count: number,
    ops: ReadonlyArray<Record<string, unknown>>
  ): Promise<void> => {
    await start(root, "s")
    await put(
      root,
      "s",
      Array.from({ length: count }, (_, at) => ({
        title: `Filler ${String(at)}`,
        type: "semantic",
        body: `Filler record ${String(at)} weighs ${String(at + 3)} grams in this fixture.`
      }))
    )
    const file = sessionStateFile(root, "s")
    const state = JSON.parse(await readFile(file, "utf8")) as { ops: Array<unknown> }
    state.ops.push(...ops)
    await writeFile(file, JSON.stringify(state), "utf8")
  }

  /** Another writer's note citing `href`, then the session rebased over it. */
  const raceACiter = async (repo: FixtureRepo, href: string): Promise<void> => {
    await commitFiles(
      repo,
      [
        {
          path: n4,
          html: note("Note four", "Note four came from another writer.", "relates_to", href)
        }
      ],
      "another writer's citer"
    )
    expect((await rebaseCli(repo.root, "s", { local: true })).exitCode).toBe(0)
  }

  type Dropped = ReadonlyArray<{ kind: string; path: string; reasons: ReadonlyArray<string> }>
  const kindsOf = (dropped: Dropped) => dropped.map((op) => `${op.kind} ${op.path}`)

  // Mutation: return `keep` unchanged from `afterDroppedVacates` and the next round refuses each
  // holder's link to the slot, so the label and the move go with the pairs. Skip only the pair
  // match and the pairs land, aimed back at the record, and `dropped` lists the archive alone.
  it("takes the archive's own repoint pairs with it and keeps the holders' other ops", async () => {
    const repo = await corpus()
    await commitFiles(
      repo,
      [
        {
          path: n1,
          html: note("Note one", "Note one cites the harbor.", "relates_to", `/${harbor}`)
        },
        {
          path: n3,
          html: note("Note three", "Note three cites the harbor.", "relates_to", `/${harbor}`)
        }
      ],
      "two citers"
    )
    const moved = "resources/acme-gadget/n3.html"
    // The pairs withRepoints put before the archive, then a label on one holder and a move of the
    // other: 199 ops, until another writer's citer needs a pair of its own.
    await writeLog(repo.root, 192, [
      { kind: "unlink", path: n1, rel: "relates_to", href: `/${harbor}` },
      { kind: "link", path: n1, rel: "relates_to", href: `/${slot}` },
      { kind: "unlink", path: n3, rel: "relates_to", href: `/${harbor}` },
      { kind: "link", path: n3, rel: "relates_to", href: `/${slot}` },
      { kind: "label", path: n1, entity: "system:harbor" },
      { kind: "move", path: n3, to: moved, html: await htmlAt(repo, n3) },
      { kind: "archive", path: harbor, to: slot, html: await htmlAt(repo, harbor) }
    ])
    await raceACiter(repo, `/${harbor}`)
    const landed = dataOf(
      (await commitCli(repo.root, "s", { local: true, dropRefused: true })).body
    )
    expect(landed.kind, JSON.stringify(landed)).toBe("committed")
    const dropped = landed.dropped as Dropped
    expect(kindsOf(dropped)).toEqual([
      `archive ${harbor}`,
      `unlink ${n1}`,
      `link ${n1}`,
      `unlink ${n3}`,
      `link ${n3}`
    ])
    for (const op of dropped) {
      expect(op.reasons, `${op.kind} ${op.path}`).toEqual([
        expect.stringContaining(`archived to ${slot}`)
      ])
    }
    const paths = await treeOf(repo)
    expect(paths).toContain(harbor)
    expect(paths).not.toContain(slot)
    expect(paths).toContain(moved)
    expect(paths).not.toContain(n3)
    const one = await htmlAt(repo, n1)
    expect(one).toContain(`<meta name="memhtml-entity" content="system:harbor">`)
    for (const html of [one, await htmlAt(repo, moved)]) {
      expect(html).toContain(`<link rel="memhtml-relates-to" href="/${harbor}">`)
    }
    const trail = (await readFile(join(repo.root, SESSIONS_DIR, "s.dropped.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Dropped[number])
    expect(kindsOf(trail)).toEqual(kindsOf(dropped))
    expect(trail.map((op) => op.reasons)).toEqual(dropped.map((op) => op.reasons))
  }, 120_000)

  // Mutation: either of the two above, and the second move goes with its holder's link to the first
  // move's destination, or `dropped` lists the first move alone.
  it("keeps a move whose holder cited a move the round dropped", async () => {
    const repo = await corpus()
    const h1 = "resources/acme-widget/h1.html"
    const h2 = "resources/acme-widget/h2.html"
    const h1To = "resources/acme-gadget/h1.html"
    const h2To = "resources/acme-gadget/h2.html"
    await commitFiles(
      repo,
      [
        {
          path: h1,
          html: note("Holder one", "Holder one cites holder two.", "relates_to", `/${h2}`)
        },
        {
          path: h2,
          html: note("Holder two", "Holder two cites holder one.", "relates_to", `/${h1}`)
        }
      ],
      "two holders citing each other"
    )
    await writeLog(repo.root, 193, [
      { kind: "unlink", path: h2, rel: "relates_to", href: `/${h1}` },
      { kind: "link", path: h2, rel: "relates_to", href: `/${h1To}` },
      { kind: "unlink", path: h1, rel: "relates_to", href: `/${h2}` },
      { kind: "link", path: h1, rel: "relates_to", href: `/${h2To}` },
      { kind: "move", path: h1, to: h1To, html: await htmlAt(repo, h1) },
      { kind: "move", path: h2, to: h2To, html: await htmlAt(repo, h2) }
    ])
    await raceACiter(repo, `/${h1}`)
    const landed = dataOf(
      (await commitCli(repo.root, "s", { local: true, dropRefused: true })).body
    )
    expect(landed.kind, JSON.stringify(landed)).toBe("committed")
    // The first holder's own pair to the second move comes back, as its repoint, and is not
    // listed.
    expect(kindsOf(landed.dropped as Dropped)).toEqual([`move ${h1}`, `unlink ${h2}`, `link ${h2}`])
    const paths = await treeOf(repo)
    expect(paths).toContain(h1)
    expect(paths).not.toContain(h1To)
    expect(paths).toContain(h2To)
    expect(paths).not.toContain(h2)
    expect(await htmlAt(repo, h1)).toContain(`<link rel="memhtml-relates-to" href="/${h2To}">`)
    expect(await htmlAt(repo, h2To)).toContain(`<link rel="memhtml-relates-to" href="/${h1}">`)
  }, 120_000)

  // Mutation: skip the ops at a dropped move's destination in `afterDroppedVacates` and the
  // completion wants the note's pair again at its own path, so the archive overflows the cap and is
  // dropped too.
  it("makes the ops kept at a dropped move's destination at its source, and lands the archive they repoint for", async () => {
    const repo = await corpus()
    await commitFiles(
      repo,
      [
        {
          path: n1,
          html: note("Note one", "Note one cites the harbor.", "relates_to", `/${harbor}`)
        }
      ],
      "a citer"
    )
    const moved = "resources/acme-gadget/n1.html"
    // The log moves the note and archives the record it cites, and a commit already appended the
    // note's repoint at the path the move takes it to: 200 ops, until another writer cites the note.
    await writeLog(repo.root, 196, [
      { kind: "move", path: n1, to: moved, html: await htmlAt(repo, n1) },
      { kind: "archive", path: harbor, to: slot, html: await htmlAt(repo, harbor) },
      { kind: "unlink", path: moved, rel: "relates_to", href: `/${harbor}` },
      { kind: "link", path: moved, rel: "relates_to", href: `/${slot}` }
    ])
    await raceACiter(repo, `/${n1}`)
    const landed = dataOf(
      (await commitCli(repo.root, "s", { local: true, dropRefused: true })).body
    )
    expect(landed.kind, JSON.stringify(landed)).toBe("committed")
    const dropped = landed.dropped as Dropped
    expect(kindsOf(dropped)).toEqual([`move ${n1}`])
    expect(dropped[0]?.reasons).toEqual([
      expect.stringContaining(`${n1}: moved to ${moved}`),
      `the ops kept at ${moved} are made at ${n1}, where the record still is: unlink relates_to, link relates_to`
    ])
    const paths = await treeOf(repo)
    expect(paths).toContain(slot)
    expect(paths).not.toContain(harbor)
    expect(paths).toContain(n1)
    expect(paths).not.toContain(moved)
    const html = await htmlAt(repo, n1)
    expect(html).toContain(`<link rel="memhtml-relates-to" href="/${slot}">`)
    expect(html).not.toContain(`href="/${harbor}"`)
    expect(await htmlAt(repo, n4)).toContain(`<link rel="memhtml-relates-to" href="/${n1}">`)
  }, 120_000)

  // Mutation: skip the put rewrite in `afterDroppedVacates` and the landed put cites the
  // destination, a path nothing wrote.
  it("aims a kept put's edge to a dropped move's destination back at the record", async () => {
    const repo = await corpus()
    await commitFiles(
      repo,
      [
        {
          path: n1,
          html: note("Note one", "Note one cites the glacier.", "relates_to", `/${glacier}`)
        }
      ],
      "a citer"
    )
    const dest = "resources/acme-gadget/glacier.html"
    const cites = "resources/acme-widget/p.html"
    // The move's pair for the citer is missing, and 199 ops leave no room for it.
    await writeLog(repo.root, 197, [
      {
        kind: "put",
        path: cites,
        html: note(
          "Glacier note",
          "The glacier record moves to the gadget area.",
          "relates_to",
          `/${dest}`
        )
      },
      { kind: "move", path: glacier, to: dest, html: await htmlAt(repo, glacier) }
    ])
    const refused = dataOf((await commitCli(repo.root, "s", { local: true })).body)
    expect(refused).toMatchObject({
      kind: "refused",
      violations: [
        {
          kind: "format",
          path: glacier,
          reasons: [
            `moved to ${dest}, and repointing the 1 edge live records carry to /${glacier} that the log does not repoint would take it to 201 ops, over the cap of 200: move it in a session of its own`
          ]
        }
      ]
    })
    const landed = dataOf(
      (await commitCli(repo.root, "s", { local: true, dropRefused: true })).body
    )
    expect(landed.kind, JSON.stringify(landed)).toBe("committed")
    expect(landed.dropped).toEqual([
      {
        kind: "move",
        path: glacier,
        reasons: [
          `${glacier}: ${(refused.violations as ReadonlyArray<{ reasons: ReadonlyArray<string> }>)[0]?.reasons[0]}`,
          `the edges kept ops aimed at /${dest} now name /${glacier}, where the record still is: ${cites} relates_to`
        ]
      }
    ])
    const paths = await treeOf(repo)
    expect(paths).toContain(glacier)
    expect(paths).not.toContain(dest)
    const html = await htmlAt(repo, cites)
    expect(html).toContain(`<link rel="memhtml-relates-to" href="/${glacier}">`)
    expect(html).not.toContain(`href="/${dest}"`)
  }, 120_000)

  describe("when its destination is held, its record is not live, or the round drops a chain", () => {
    const orchard = "areas/inbox/orchard.html"
    const n2 = "resources/acme-widget/n2.html"
    const succ = "resources/acme-widget/succ.html"
    const linksAt = async (repo: FixtureRepo, path: string) =>
      (await htmlAt(repo, path)).match(/<link rel="memhtml-[^"]+" href="[^"]+">/g) ?? []
    const edge = (rel: string, path: string) => `<link rel="memhtml-${rel}" href="/${path}">`
    const cites = (path: string, title: string, href: string) => ({
      path,
      html: note(title, `${title} cites a fixture record.`, "relates_to", `/${href}`)
    })
    const dropRefused = async (repo: FixtureRepo) => {
      const landed = dataOf(
        (await commitCli(repo.root, "s", { local: true, dropRefused: true })).body
      )
      expect(landed.kind, JSON.stringify(landed)).toBe("committed")
      return landed.dropped as Dropped
    }

    // Mutation: take the pairs only when the destination is empty and the record live, as the
    // rewrites are, and this case and the next three go red: the notes land citing the older copy
    // in the slot or the record at the held path, or lose their label to the next round.
    it("takes a dropped archive's pairs when an older copy holds its slot, and leaves the edges to that copy", async () => {
      const repo = await corpus()
      const earlier = renderTemplate({
        title: "Harbor, earlier",
        claim: "Harbor pilots boarded ships at the north pier.",
        memoryType: "semantic",
        at: AT,
        entities: ["system:fixture"]
      })
      await commitFiles(
        repo,
        [{ path: slot, html: earlier }, cites(n1, "Note one", harbor)],
        "an earlier copy in the slot, and a citer"
      )
      await writeLog(repo.root, 196, [
        {
          kind: "put",
          path: succ,
          html: note(
            "Harbor, revised",
            "Harbor pilots now board at the inner buoy.",
            "supersedes",
            `/${slot}`
          )
        },
        { kind: "unlink", path: n1, rel: "relates_to", href: `/${harbor}` },
        { kind: "link", path: n1, rel: "relates_to", href: `/${slot}` },
        { kind: "archive", path: harbor, to: slot, html: await htmlAt(repo, harbor) }
      ])
      await raceACiter(repo, `/${harbor}`)
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped)).toEqual([`archive ${harbor}`, `unlink ${n1}`, `link ${n1}`])
      // The slot holds a record, so nothing is aimed back and the reasons gain nothing.
      expect(dropped[0]?.reasons).toEqual([expect.stringContaining(`archived to ${slot}`)])
      expect(await treeOf(repo)).toContain(harbor)
      expect(await htmlAt(repo, slot)).toBe(earlier)
      expect(await linksAt(repo, n1)).toEqual([edge("relates-to", harbor)])
      expect(await linksAt(repo, succ)).toContain(edge("supersedes", slot))
    }, 120_000)

    it("takes a dropped move's pairs when its destination holds a record", async () => {
      const repo = await corpus()
      await commitFiles(repo, [cites(n1, "Note one", glacier)], "a citer")
      await writeLog(repo.root, 3, [
        { kind: "unlink", path: n1, rel: "relates_to", href: `/${glacier}` },
        { kind: "link", path: n1, rel: "relates_to", href: `/${orchard}` },
        { kind: "label", path: n1, entity: "system:ice" },
        { kind: "move", path: glacier, to: orchard, html: await htmlAt(repo, glacier) }
      ])
      const orchardHtml = await htmlAt(repo, orchard)
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped)).toEqual([`move ${glacier}`, `unlink ${n1}`, `link ${n1}`])
      expect(dropped[0]?.reasons).toEqual([
        expect.stringContaining("move destination already holds a record")
      ])
      expect(await htmlAt(repo, orchard)).toBe(orchardHtml)
      expect(await linksAt(repo, n1)).toEqual([edge("relates-to", glacier)])
      expect(await htmlAt(repo, n1)).toContain(`<meta name="memhtml-entity" content="system:ice">`)
    }, 120_000)

    it("takes each move's pairs when a chain of moves ends on a held path", async () => {
      const repo = await corpus()
      const trees = "areas/inbox/orchard-trees.html"
      await commitFiles(
        repo,
        [cites(n1, "Note one", glacier), cites(n2, "Note two", orchard)],
        "two citers"
      )
      await writeLog(repo.root, 3, [
        { kind: "unlink", path: n2, rel: "relates_to", href: `/${orchard}` },
        { kind: "link", path: n2, rel: "relates_to", href: `/${trees}` },
        { kind: "unlink", path: n1, rel: "relates_to", href: `/${glacier}` },
        { kind: "link", path: n1, rel: "relates_to", href: `/${orchard}` },
        { kind: "move", path: orchard, to: trees, html: await htmlAt(repo, orchard) },
        { kind: "move", path: glacier, to: orchard, html: await htmlAt(repo, glacier) }
      ])
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped).sort()).toEqual(
        [
          `move ${orchard}`,
          `move ${glacier}`,
          `unlink ${n2}`,
          `link ${n2}`,
          `unlink ${n1}`,
          `link ${n1}`
        ].sort()
      )
      const paths = await treeOf(repo)
      expect(paths).toEqual(expect.arrayContaining([glacier, orchard]))
      expect(paths).not.toContain(trees)
      expect(await linksAt(repo, n1)).toEqual([edge("relates-to", glacier)])
      expect(await linksAt(repo, n2)).toEqual([edge("relates-to", orchard)])
    }, 120_000)

    it("takes the pairs of a dropped archive of a record the log put, and keeps the holder's label", async () => {
      const repo = await corpus()
      const ghost = "areas/inbox/ghost.html"
      const ghostSlot = archivePathFor(ghost, 2031)
      // The note cites a path the version does not hold; the log writes a record there and
      // archives it, 199 ops, until another writer cites the path too.
      await commitFiles(repo, [cites(n1, "Note one", ghost)], "a citer of an empty path")
      const ghostHtml = renderTemplate({
        title: "Ghost",
        claim: "Ghost records are written and retired in one log.",
        memoryType: "semantic",
        at: AT,
        entities: ["system:fixture"]
      })
      await writeLog(repo.root, 194, [
        { kind: "put", path: ghost, html: ghostHtml },
        { kind: "unlink", path: n1, rel: "relates_to", href: `/${ghost}` },
        { kind: "link", path: n1, rel: "relates_to", href: `/${ghostSlot}` },
        { kind: "label", path: n1, entity: "system:ghost" },
        { kind: "archive", path: ghost, to: ghostSlot, html: ghostHtml }
      ])
      await raceACiter(repo, `/${ghost}`)
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped)).toEqual([
        `put ${ghost}`,
        `archive ${ghost}`,
        `unlink ${n1}`,
        `link ${n1}`
      ])
      const paths = await treeOf(repo)
      expect(paths).not.toContain(ghost)
      expect(paths).not.toContain(ghostSlot)
      expect(await linksAt(repo, n1)).toEqual([edge("relates-to", ghost)])
      expect(await htmlAt(repo, n1)).toContain(
        `<meta name="memhtml-entity" content="system:ghost">`
      )
    }, 120_000)

    // Mutation: stop the chain at the vacate's own source in `afterDroppedVacates` and the kept
    // edge to the chain's last path lands naming a path nothing wrote.
    it("aims an edge to the end of a chain of two dropped moves at the record", async () => {
      const repo = await corpus()
      const placed = "resources/acme-gadget/glacier.html"
      const further = "resources/acme-gadget/ice/glacier.html"
      const p = "resources/acme-widget/p.html"
      await commitFiles(repo, [cites(n1, "Note one", glacier)], "a citer")
      await writeLog(repo.root, 3, [
        { kind: "put", ...cites(p, "Note p", further) },
        { kind: "unlink", path: n1, rel: "relates_to", href: `/${glacier}` },
        { kind: "link", path: n1, rel: "relates_to", href: `/${placed}` },
        { kind: "move", path: glacier, to: placed, html: await htmlAt(repo, glacier) },
        { kind: "move", path: placed, to: further, html: await htmlAt(repo, glacier) }
      ])
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped)).toEqual([
        `move ${glacier}`,
        `move ${placed}`,
        `unlink ${n1}`,
        `link ${n1}`
      ])
      expect(dropped[1]?.reasons.at(-1)).toBe(
        `the edges kept ops aimed at /${further} now name /${glacier}, where the record still is: ${p} relates_to`
      )
      const paths = await treeOf(repo)
      expect(paths).toContain(glacier)
      expect(paths).not.toContain(placed)
      expect(paths).not.toContain(further)
      expect(await linksAt(repo, p)).toEqual([edge("relates-to", glacier)])
      expect(await linksAt(repo, n1)).toEqual([edge("relates-to", glacier)])
    }, 120_000)

    it("aims a successor's edge to the slot of a dropped move and archive at the record", async () => {
      const repo = await corpus()
      const placed = "resources/acme-gadget/harbor.html"
      const placedSlot = archivePathFor(placed, 2031)
      await writeLog(repo.root, 3, [
        {
          kind: "put",
          path: succ,
          html: note(
            "Harbor, revised",
            "Harbor pilots now board at the inner buoy.",
            "supersedes",
            `/${placedSlot}`
          )
        },
        { kind: "move", path: harbor, to: placed, html: await htmlAt(repo, harbor) },
        { kind: "archive", path: placed, to: placedSlot, html: await htmlAt(repo, harbor) }
      ])
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped)).toEqual([`move ${harbor}`, `archive ${placed}`])
      expect(dropped[1]?.reasons.at(-1)).toBe(
        `the edges kept ops aimed at /${placedSlot} now name /${harbor}, where the record still is: ${succ} supersedes`
      )
      const paths = await treeOf(repo)
      expect(paths).toContain(harbor)
      expect(paths).not.toContain(placed)
      expect(paths).not.toContain(placedSlot)
      const links = await linksAt(repo, succ)
      expect(links).toContain(edge("supersedes", harbor))
      expect(links).not.toContain(edge("supersedes", placedSlot))
    }, 120_000)

    // Mutation: key a dropped pair by its own path in the drop loop and `dropped` lists the pair
    // the round took at the move's destination, though it lands at the holder's path.
    it("does not list a pair the round took at a dropped move's destination that comes back where the holder stays", async () => {
      const repo = await corpus()
      await writeStoreConfig(repo.root, { commit: true })
      // A project record, anchored by its path, that the log moves where nothing anchors it.
      const project = "projects/acme/p.html"
      const moved = "areas/inbox/p.html"
      const projectHtml = addLink(
        renderTemplate({
          title: "Project note",
          claim: "The project note cites the harbor.",
          memoryType: "semantic",
          at: AT,
          entities: []
        }),
        "relates_to",
        `/${harbor}`
      )
      await commitFiles(repo, [{ path: project, html: projectHtml }], "a project citer")
      await writeLog(repo.root, 3, [
        { kind: "move", path: project, to: moved, html: projectHtml },
        { kind: "archive", path: harbor, to: slot, html: await htmlAt(repo, harbor) },
        { kind: "unlink", path: moved, rel: "relates_to", href: `/${harbor}` },
        { kind: "link", path: moved, rel: "relates_to", href: `/${slot}` }
      ])
      const dropped = await dropRefused(repo)
      expect(kindsOf(dropped)).toEqual([`move ${project}`])
      const paths = await treeOf(repo)
      expect(paths).toContain(slot)
      expect(paths).not.toContain(harbor)
      expect(paths).toContain(project)
      expect(paths).not.toContain(moved)
      expect(await linksAt(repo, project)).toEqual([edge("relates-to", slot)])
    }, 120_000)
  })
})

describe("a commit of a log with no ops", () => {
  it("is answered refused with no violations and touches nothing, here and through the server, with or without --drop-refused", async () => {
    const repo = await corpus()
    const before = await mainOf(repo)
    await start(repo.root, "empty")
    const log = await readFile(sessionStateFile(repo.root, "empty"), "utf8")
    const nothing = {
      id: "empty",
      kind: "refused",
      violations: [],
      snapshot: null,
      dropped: [],
      rebased: 0
    }
    const touchedNothing = async () => {
      expect(await mainOf(repo)).toBe(before)
      expect(await readFile(sessionStateFile(repo.root, "empty"), "utf8")).toBe(log)
      expect(await exists(snapshotPathFor(repo.root, before))).toBe(false)
    }
    for (const dropRefused of [false, true]) {
      const local = await commitCli(repo.root, "empty", { local: true, dropRefused })
      expect(local.exitCode, JSON.stringify(local.body)).toBe(0)
      expect(dataOf(local.body)).toMatchObject({ ...nothing, via: "local" })
      await touchedNothing()
    }
    await serve(repo.root)
    for (const dropRefused of [false, true]) {
      const served = await commitCli(repo.root, "empty", { dropRefused })
      expect(served.exitCode, JSON.stringify(served.body)).toBe(0)
      expect(dataOf(served.body)).toMatchObject({ ...nothing, via: "server" })
      await touchedNothing()
    }
  }, 60_000)
})

describe("the commit permit", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it("finishes an effect that started when its caller is interrupted, and runs none that was waiting", async () => {
    const gate = await run_(Semaphore.make(1))
    const hold = holdingPermit(gate, 5_000)
    const done: Array<string> = []
    const first = Effect.runFork(
      hold(Effect.sleep(300).pipe(Effect.andThen(Effect.sync(() => done.push("first")))))
    )
    await sleep(50)
    const second = Effect.runFork(hold(Effect.sync(() => done.push("second"))))
    await sleep(50)
    await run_(Fiber.interrupt(second))
    await run_(Fiber.interrupt(first))
    expect(done).toEqual(["first"])
    expect(await run_(hold(Effect.succeed("third")))).toEqual(Option.some("third"))
  })

  it("answers none, having run nothing, when the permit stays held past the wait", async () => {
    const gate = await run_(Semaphore.make(1))
    const hold = holdingPermit(gate, 50)
    const held = Effect.runFork(hold(Effect.sleep(400)))
    await sleep(20)
    let ran = false
    const waited = await run_(
      hold(
        Effect.sync(() => {
          ran = true
        })
      )
    )
    expect(waited).toEqual(Option.none())
    expect(ran).toBe(false)
    await run_(Fiber.join(held))
  })
})

describe("the CLI's fallback rules for a commit", () => {
  it("commits here when no server answers, and says so", async () => {
    const repo = await corpus()
    await oneWrite(repo.root, "alone", "Alone note")
    const data = dataOf((await commitCli(repo.root, "alone")).body)
    expect(data).toMatchObject({ kind: "committed", via: "local" })
    expect(data.server).toEqual({ used: false, base: null, reason: "no-server", detail: "ENOENT" })
    const rebased = dataOf((await rebaseCli(repo.root, "alone")).body)
    expect(rebased).toMatchObject({ via: "local", moved: false, server: { reason: "no-server" } })
  })

  it("commits here when the server answers 404, as one without the route does", async () => {
    const repo = await corpus()
    await oneWrite(repo.root, "older", "Older server")
    await fakeServer(repo.root, () => ({
      status: 404,
      body: { apiVersion: "1", error: "no route", code: "ERR_UNKNOWN_COMMAND", suggestions: [] }
    }))
    const data = dataOf((await commitCli(repo.root, "older")).body)
    expect(data).toMatchObject({ kind: "committed", via: "local" })
    expect(data.server).toMatchObject({ used: false, reason: "refused" })
    expect(String((data.server as Body).detail)).toMatch(/^404: /)
  })

  it("fails rather than commits again when the server took the commit and answered 500", async () => {
    const repo = await corpus()
    await oneWrite(repo.root, "crashed", "Crashed server")
    const before = await mainOf(repo)
    await fakeServer(repo.root, () => ({
      status: 500,
      body: {
        apiVersion: "1",
        error: "git update-ref failed (exit 128)",
        code: "ERR_GIT",
        suggestions: []
      }
    }))
    const result = await commitCli(repo.root, "crashed")
    expect(result.exitCode).toBe(1)
    expect(result.body).toMatchObject({ code: "ERR_STORAGE" })
    expect(String(result.body.error)).toContain("ERR_GIT")
    expect(String(result.body.error)).toContain("session status --id crashed")
    expect(await mainOf(repo)).toBe(before)
    expect((await logOf(repo.root, "crashed")).ops).toHaveLength(1)
  })

  it("fails rather than commits again when no answer came within the deadline", async () => {
    const repo = await corpus()
    await oneWrite(repo.root, "lost", "Lost answer")
    const before = await mainOf(repo)
    await fakeServer(repo.root, "hang")
    const saved = process.env[COMMIT_DEADLINE_VAR]
    process.env[COMMIT_DEADLINE_VAR] = "300"
    try {
      const started = Date.now()
      const result = await commitCli(repo.root, "lost")
      expect(Date.now() - started).toBeLessThan(5000)
      expect(result.exitCode).toBe(1)
      expect(result.body).toMatchObject({ code: "ERR_STORAGE" })
      expect(String(result.body.error)).toContain(`within 300 ms (${COMMIT_DEADLINE_VAR})`)
      expect(await mainOf(repo)).toBe(before)
      expect((await logOf(repo.root, "lost")).ops).toHaveLength(1)

      const rebased = await rebaseCli(repo.root, "lost")
      expect(rebased.exitCode).toBe(1)
      expect(String(rebased.body.error)).toContain("session rebase")
    } finally {
      if (saved === undefined) delete process.env[COMMIT_DEADLINE_VAR]
      else process.env[COMMIT_DEADLINE_VAR] = saved
    }
  })

  it("refuses a malformed deadline at exit 2 naming the variable", async () => {
    const repo = await corpus()
    const saved = process.env[COMMIT_DEADLINE_VAR]
    process.env[COMMIT_DEADLINE_VAR] = "soon"
    try {
      for (const argv of [
        ["session", "commit", "--id", "s1", "--message", "m"],
        ["session", "rebase", "--id", "s1"]
      ]) {
        const result = await cli(repo.root, argv)
        expect(result.exitCode).toBe(2)
        expect(result.body).toMatchObject({ code: "ERR_INVALID_FLAG" })
        expect(String(result.body.error)).toContain(COMMIT_DEADLINE_VAR)
      }
    } finally {
      if (saved === undefined) delete process.env[COMMIT_DEADLINE_VAR]
      else process.env[COMMIT_DEADLINE_VAR] = saved
    }
  })
})

describe("the store's write bar on the server path", () => {
  // Mutation: drop `writeBar` from `serveCommit`'s `commitOverHead` call and the served commit
  // lands the narrative under the library default, so `kind` is `committed` and main moves.
  it("judges a served commit by memhtml.config.json, as the local path does", async () => {
    const repo = await corpus()
    await start(repo.root, "narrative")
    await put(repo.root, "narrative", [
      {
        title: "The run that rebuilt the fixture index",
        type: "episodic",
        body: "The run that rebuilt the fixture index finished in four minutes."
      }
    ])
    await writeStoreConfig(repo.root)
    await serve(repo.root)
    const before = await mainOf(repo)
    const served = dataOf((await commitCli(repo.root, "narrative")).body)
    expect(served).toMatchObject({ kind: "refused", via: "server" })
    expect((served.violations as ReadonlyArray<Body>).map((v) => v.kind)).toEqual(["write-bar"])
    expect(await mainOf(repo)).toBe(before)
    const local = dataOf((await commitCli(repo.root, "narrative", { local: true })).body)
    expect(local).toMatchObject({ kind: "refused", via: "local" })
    expect(await mainOf(repo)).toBe(before)
  })
})

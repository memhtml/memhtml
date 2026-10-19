import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { startHeadServer } from "../src/head-server.js"
import { run } from "../src/run.js"
import { fakeEmbedder } from "./harness.js"

/**
 * A run that writes after its session's commit died past its swap. The log then carries `pending`
 * (the commit's sha, written before the ref moved) beside the ops that commit landed: a SIGKILL
 * between `update-ref` and the cleared log, or a failed write of that log. Every door that appends
 * to the log settles `pending` first (`appendOps`), so the next `session commit` lands what was
 * appended on top of the landed commit instead of answering `recovered` for the old ops and clearing
 * the new ones with them.
 *
 * The killed commit is staged the way the kill leaves it: the log as it was before the commit, plus
 * `pending` naming the commit that landed. The package suite (`packages/session/tests/checkout.test.ts`)
 * drives the same states with a real SIGKILL at each step.
 *
 * Mutation, run once with the change applied and every case here red: `appendOps` appends without
 * settling (`settleStored` returns the session as read) -> the next commit answers `recovered: true`
 * naming only the first path, and the appended record is not on main.
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

type Body = Record<string, unknown>

const cli = async (root: string, argv: ReadonlyArray<string>) => {
  const result = await run([...argv, "--repo", root], undefined, undefined, false)
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Body }
}

const ok = async (root: string, argv: ReadonlyArray<string>): Promise<Body> => {
  const { exitCode, body } = await cli(root, argv)
  expect(exitCode, JSON.stringify(body)).toBe(0)
  return body.data as Body
}

const AT = "2026-03-01T12:00:00Z"

const record = (title: string, claim: string) =>
  renderTemplate({ title, claim, memoryType: "semantic", at: AT, entities: ["system:fixture"] })

const corpus = async (): Promise<FixtureRepo> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  const path = join(repo.root, "areas/inbox/harbor.html")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, record("Harbor", "Harbor pilots board ships at the outer buoy."), "utf8")
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", "corpus"]))
  return repo
}

const lines = async (title: string, body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-pending-"))
  dirs.push(dir)
  const file = join(dir, "ops.jsonl")
  await writeFile(
    file,
    `${JSON.stringify({ op: "write", title, type: "semantic", body, entity: "system:fixture" })}\n`,
    "utf8"
  )
  return file
}

const put = async (root: string, id: string, title: string, body: string): Promise<Body> =>
  ok(root, ["session", "put", "--id", id, "--file", await lines(title, body), "--no-server"])

const commit = (root: string, id: string, message: string, local = true): Promise<Body> =>
  ok(root, [
    "session",
    "commit",
    "--id",
    id,
    "--message",
    message,
    ...(local ? ["--no-server"] : [])
  ])

const treeOf = async (repo: FixtureRepo): Promise<ReadonlyArray<string>> =>
  (await run_(repo.git.run(["ls-tree", "-r", "--name-only", "main"])))
    .split("\n")
    .filter((path) => path.endsWith(".html"))

/**
 * A session whose first commit landed and whose log still reads as the kill left it: its one op
 * (alpha) and `pending` naming the commit on main. The landed commit's sha.
 */
const landedButUnsettled = async (repo: FixtureRepo, id: string): Promise<string> => {
  await ok(repo.root, ["session", "start", "--id", id])
  await put(repo.root, id, "Alpha", "Alpha is the first fact the pending run wrote.")
  const before = await readFile(sessionStateFile(repo.root, id), "utf8")
  const first = await commit(repo.root, id, "one")
  expect(first.kind).toBe("committed")
  const sha = String(first.sha)
  await writeFile(
    sessionStateFile(repo.root, id),
    `${JSON.stringify({ ...JSON.parse(before), pending: sha }, null, 2)}\n`,
    "utf8"
  )
  return sha
}

/** The next commit lands bravo alone, on top of the landed commit, and both are on main. */
const bravoLandsOn = async (
  repo: FixtureRepo,
  id: string,
  landed: string,
  bravo: string,
  local = true
) => {
  const second = await commit(repo.root, id, "two", local)
  expect(second).toMatchObject({ kind: "committed", recovered: false, paths: [bravo] })
  expect((await run_(repo.git.run(["rev-parse", `${String(second.sha)}^`]))).trim()).toBe(landed)
  const tree = await treeOf(repo)
  expect(tree).toContain("areas/inbox/alpha.html")
  expect(tree).toContain(bravo)
  const log = JSON.parse(await readFile(sessionStateFile(repo.root, id), "utf8")) as Body
  expect(log).toMatchObject({ baseSha: second.sha, ops: [] })
  expect(log).not.toHaveProperty("pending")
}

/** A script that writes one record at `path` through a heredoc. */
const writeScript = (path: string, html: string) =>
  [
    `mkdir -p /mnt/memhtml/${dirname(path)}`,
    `cat > /mnt/memhtml/${path} <<'HTML'`,
    html.trimEnd(),
    "HTML"
  ].join("\n")

const BRAVO_PATH = "areas/inbox/bravo.html"
const BRAVO = record("Bravo", "Bravo is the fact the run wrote after its commit died.")

describe("a write after a commit that landed and was not settled", () => {
  it("session put settles the landed commit, and the next commit lands the new record on it", async () => {
    const repo = await corpus()
    const landed = await landedButUnsettled(repo, "p-put")
    const appended = await put(
      repo.root,
      "p-put",
      "Bravo",
      "Bravo is the fact the run wrote after its commit died."
    )
    expect(appended).toMatchObject({ baseSha: landed, appended: 1, ops: 1 })
    await bravoLandsOn(repo, "p-put", landed, "areas/inbox/bravo.html")
  })

  it("session exec here settles the landed commit before appending its harvest", async () => {
    const repo = await corpus()
    const landed = await landedButUnsettled(repo, "p-exec")
    const report = await ok(repo.root, [
      "session",
      "exec",
      "--id",
      "p-exec",
      "--script",
      writeScript(BRAVO_PATH, BRAVO),
      "--no-server"
    ])
    expect(report).toMatchObject({ exitCode: 0, appended: 1, opsTotal: 1, baseSha: landed })
    await bravoLandsOn(repo, "p-exec", landed, BRAVO_PATH)
  })

  it("session exec through the head server settles the landed commit before appending its harvest", async () => {
    const repo = await corpus()
    const landed = await landedButUnsettled(repo, "p-served")
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    await run_(
      startHeadServer({ root: repo.root, pollMs: 0, embedder: fakeEmbedder() }).pipe(
        Scope.provide(scope)
      )
    )
    const report = await ok(repo.root, [
      "session",
      "exec",
      "--id",
      "p-served",
      "--script",
      writeScript(BRAVO_PATH, BRAVO)
    ])
    expect(report).toMatchObject({
      exitCode: 0,
      appended: 1,
      opsTotal: 1,
      baseSha: landed,
      server: { used: true }
    })
    await bravoLandsOn(repo, "p-served", landed, BRAVO_PATH, false)
  })
})

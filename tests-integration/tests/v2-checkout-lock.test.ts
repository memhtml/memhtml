import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { loadHead } from "@memhtml/head"
import { renderTemplate } from "@memhtml/html"
import {
  appendOps,
  type CommitOutcome,
  commitSession,
  makePlumbing,
  type PlumbingFactory,
  rebaseSession,
  type Session,
  saveSession,
  checkoutLockTarget as sessionLockTarget,
  startSession
} from "@memhtml/session"
import { checkoutLockTarget as storeLockTarget } from "@memhtml/store"
import { type FixtureRepo, makeFixtureRepo, writeInput } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { runBuilt } from "./spawned.js"

/**
 * Session commits and v1 store writes on one checkout, all at once, through the real packages: the
 * store's commit path (`@memhtml/store`, `git add` then `git commit` of the whole shared index) and
 * the session's (`@memhtml/session`, checkout move then ref swap). Before the checkout lock, a v1
 * commit landing between a session's two steps swept the session's file into its own commit and the
 * session's rollback then staged the file's deletion, so the next v1 commit removed it from `main`.
 *
 * Every assertion reads git: each path every writer reported is on `main`, each v1 commit changes its
 * own path and nothing else, each session commit its own paths and nothing else, and the checkout is
 * clean. Counts are derived from `rev-list`, not from the writers' answers.
 *
 * Mutation: `landOnRef` runs its section without `withCheckoutLock` -> "N session commits racing M
 * v1 writes lose no record" red (a v1 commit takes a session's file into its own). What makes that
 * reproducible is the aim: each v1 write fires as a session's checkout moves, into a window held
 * open long enough for the write to reach its commit. Fired on a timer instead, the v1 writes move
 * the ref faster than a session can build its commit, so every attempt is turned away at the ref
 * check before its checkout moves, and the case stays green with the lock removed. The
 * cross-process case is not aimed and is not part of that proof.
 */

const execFileP = promisify(execFile)
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
const scratch: Array<string> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const gitOut = async (root: string, ...args: ReadonlyArray<string>): Promise<string> =>
  (await execFileP("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim()

const AT = "2026-10-18T12:00:00Z"
const SESSIONS = 6
const PUTS = 2
const V1_WRITES = 12
/** The longest a v1 write waits for a session's checkout to move before it fires anyway. */
const V1_AIM_MS = 1_000
const RETRY_BOUND = 40

const sessionPut = (session: number, slot: number) => ({
  kind: "put" as const,
  path: `projects/race-${session}/note-${slot}.html`,
  html: renderTemplate({
    title: `Race ${session} note ${slot}`,
    claim: `Session ${session} recorded lane fact ${slot}.`,
    memoryType: "semantic",
    at: AT
  })
})

/**
 * The real plumbing with the session's window held open: `moved()` as the shared checkout moves, then
 * a pause before the swap that follows. A slow disk does the same; here it makes the window a v1
 * commit could land in wide enough that the race is run, not hoped for. A v1 write takes about
 * 200 ms from its start to its commit.
 */
const WINDOW_MS = 300
const slowWindow =
  (root: string, moved: () => void): PlumbingFactory =>
  (indexFile) => {
    const real = makePlumbing({ root, indexFile })
    return {
      ...real,
      readTreeIntoWorktree: (from, to) =>
        real.readTreeIntoWorktree(from, to).pipe(
          Effect.tap(() => Effect.sync(moved)),
          Effect.andThen(Effect.sleep(WINDOW_MS))
        )
    }
  }

/** A signal the v1 writer waits on: the next move of the shared checkout, or `ms`, whichever is first. */
const checkoutMoves = () => {
  const waiting: Array<() => void> = []
  return {
    moved: () => {
      for (const wake of waiting.splice(0)) wake()
    },
    next: (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        waiting.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
  }
}

/** Commit with the caller's loop: on `rebase-needed`, reload the head at the tip, rebase, retry. */
const commitWithRetry = (
  repo: FixtureRepo,
  session: Session,
  plumbing: PlumbingFactory
): Effect.Effect<{ readonly outcome: CommitOutcome; readonly retries: number }, unknown> =>
  Effect.gen(function* () {
    let current = session
    let head = yield* loadHead(repo.git, session.baseSha)
    for (let retries = 0; retries <= RETRY_BOUND; retries += 1) {
      const outcome = yield* commitSession({
        session: current,
        head,
        message: current.id,
        plumbing
      })
      if (outcome.kind !== "rebase-needed") return { outcome, retries }
      head = yield* loadHead(repo.git, outcome.mainSha)
      current = rebaseSession(current, head)
      yield* saveSession(current)
    }
    return yield* Effect.fail(new Error(`${session.id}: ${RETRY_BOUND} rebases were not enough`))
  })

/** Each commit on `main` since `base` with the paths it changed, from git alone. */
const commitsSince = async (root: string, base: string) => {
  const shas = (await gitOut(root, "rev-list", "--reverse", `${base}..main`))
    .split("\n")
    .filter((sha) => sha !== "")
  return Promise.all(
    shas.map(async (sha) => ({
      sha,
      subject: await gitOut(root, "log", "-1", "--format=%s", sha),
      paths: (await gitOut(root, "show", "--name-only", "--format=", sha))
        .split("\n")
        .filter((path) => path !== "")
        .sort()
    }))
  )
}

describe("the checkout lock across packages", () => {
  it("the store and the session lock the same path", () => {
    for (const root of ["/srv/store", "/srv/store/", "relative/store"]) {
      expect(sessionLockTarget(root)).toBe(storeLockTarget(root))
    }
  })

  it("N session commits racing M v1 writes lose no record", async () => {
    const repo = await run(makeFixtureRepo())
    repos.push(repo)
    const base = await gitOut(repo.root, "rev-parse", "HEAD")
    const sessions = await Promise.all(
      Array.from({ length: SESSIONS }, (_, index) =>
        run(
          startSession({ root: repo.root, id: `race-${index}`, base: { sha: base } }).pipe(
            Effect.flatMap((session) =>
              appendOps(
                session,
                Array.from({ length: PUTS }, (_, slot) => sessionPut(index, slot))
              )
            )
          )
        )
      )
    )
    const moves = checkoutMoves()
    const plumbing = slowWindow(repo.root, moves.moved)
    // Every writer is a root fiber of its own, as a separate process would be: none inherits
    // another's hold on the lock.
    const [committed, written] = await Promise.all([
      Promise.all(sessions.map((session) => run(commitWithRetry(repo, session, plumbing)))),
      // The v1 writes arrive one after another, each aimed at the instant a session's checkout
      // moves: with the lock it waits for that session's swap, without it it commits in the gap.
      (async () => {
        const results = []
        for (let index = 0; index < V1_WRITES; index += 1) {
          await moves.next(V1_AIM_MS)
          results.push(
            await run(
              repo.store.writeMemory(
                writeInput({
                  title: `V1 race write ${index}`,
                  claim: `The v1 door recorded race fact ${index}.`,
                  entities: ["system:fixture"]
                })
              )
            )
          )
        }
        return results
      })()
    ])
    const sessionPaths = committed.flatMap(({ outcome }) =>
      outcome.kind === "committed" ? outcome.paths : []
    )
    for (const { outcome } of committed) expect(outcome.kind).toBe("committed")
    expect(sessionPaths).toHaveLength(SESSIONS * PUTS)
    for (const result of written) expect(result.created).toBe(true)

    const tree = new Set(
      (await gitOut(repo.root, "ls-tree", "-r", "--name-only", "main")).split("\n")
    )
    for (const path of [...sessionPaths, ...written.map((result) => result.path)]) {
      expect(tree.has(path), path).toBe(true)
    }
    const commits = await commitsSince(repo.root, base)
    expect(commits).toHaveLength(SESSIONS + V1_WRITES)
    for (const commit of commits) {
      if (commit.subject.startsWith("memhtml(session):")) {
        const session = sessions.find((one) => commit.subject === `memhtml(session): ${one.id}`)
        expect(commit.paths, commit.subject).toEqual(
          [...(session?.ops ?? [])].map((op) => op.path).sort()
        )
      } else {
        // A v1 write commits its own file and nothing a session staged.
        expect(commit.paths, commit.subject).toHaveLength(1)
        expect(commit.paths[0]?.startsWith("projects/race-"), commit.subject).toBe(false)
      }
    }
    expect(await gitOut(repo.root, "status", "--porcelain")).toBe("")
    console.info(
      `v2-checkout-lock: rebases per session racing ${V1_WRITES} v1 writes: ${committed.map((entry) => entry.retries).join(",")}`
    )
  })

  it("the same race across processes, through the built binary", async () => {
    const repo = await run(makeFixtureRepo())
    repos.push(repo)
    const root = repo.root
    const ops = await mkdtemp(join(tmpdir(), "memhtml-race-ops-"))
    scratch.push(ops)
    const processes = 3
    const envelope = async (argv: ReadonlyArray<string>) => {
      const spawned = await runBuilt(root, argv, { MEMHTML_SESSION: "" })
      if (spawned.stdout.trim() === "") {
        throw new Error(
          `${argv.join(" ")} exited ${spawned.exitCode} with no envelope: ${spawned.stderr.slice(-3000)}`
        )
      }
      return { exitCode: spawned.exitCode, body: JSON.parse(spawned.stdout) }
    }
    /** One session's life, each step its own process: start, put, then commit until it lands. */
    const sessionFlow = async (index: number) => {
      const id = `proc-${index}`
      const file = join(ops, `${id}.jsonl`)
      await writeFile(
        file,
        `${JSON.stringify({ op: "write", title: `Process ${index} fact`, type: "semantic", body: `Process ${index} recorded a fact.`, entity: "system:fixture" })}\n`
      )
      expect((await envelope(["session", "start", "--id", id])).exitCode).toBe(0)
      expect(
        (await envelope(["session", "put", "--id", id, "--file", file, "--no-server"])).exitCode
      ).toBe(0)
      for (let attempt = 0; attempt < RETRY_BOUND; attempt += 1) {
        const answer = await envelope(["session", "commit", "--id", id, "--message", id])
        expect(answer.exitCode, JSON.stringify(answer.body)).toBe(0)
        if (answer.body.data.kind === "committed") return answer.body.data.paths as Array<string>
        expect(answer.body.data.kind).toBe("rebase-needed")
        expect((await envelope(["session", "rebase", "--id", id])).exitCode).toBe(0)
      }
      throw new Error(`${id} never landed`)
    }
    const v1Write = async (index: number) => {
      const answer = await envelope([
        "write",
        "--title",
        `Process v1 fact ${index}`,
        "--type",
        "semantic",
        "--claim",
        `A v1 process recorded fact ${index}.`,
        "--entity",
        "system:fixture"
      ])
      expect(answer.exitCode, JSON.stringify(answer.body)).toBe(0)
      return answer.body.data.path as string
    }
    // One process opens the store's index first, alone: concurrent first opens race each other on
    // the index's migration ledger (`@memhtml/index` reads the applied set outside its transaction),
    // which is not the race under test.
    await v1Write(-1)
    const base = await gitOut(root, "rev-parse", "HEAD")
    const [sessionPaths, v1Paths] = await Promise.all([
      Promise.all(Array.from({ length: processes }, (_, index) => sessionFlow(index))),
      Promise.all(Array.from({ length: processes + 1 }, (_, index) => v1Write(index)))
    ])
    const tree = new Set((await gitOut(root, "ls-tree", "-r", "--name-only", "main")).split("\n"))
    for (const path of [...sessionPaths.flat(), ...v1Paths]) expect(tree.has(path), path).toBe(true)
    const commits = await commitsSince(root, base)
    expect(commits).toHaveLength(processes + processes + 1)
    for (const commit of commits) expect(commit.paths, commit.subject).toHaveLength(1)
    expect(await gitOut(root, "status", "--porcelain")).toBe("")
  })
})

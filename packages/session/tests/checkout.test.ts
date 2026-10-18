import { spawn } from "node:child_process"
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECKOUT_LOCK_STALE_MS, CHECKOUT_LOCKED } from "@memhtml/contracts"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { withCheckoutLock } from "../src/checkout-lock.js"
import { commitSession, type PlumbingFactory } from "../src/commit.js"
import { makePlumbing } from "../src/plumbing.js"
import {
  appendOps,
  rebaseSession,
  resumeSession,
  SESSION_LOCK_STALE_MS,
  SESSIONS_DIR,
  saveSession,
  startSession
} from "../src/session.js"
import {
  commitFiles,
  fileAt,
  git,
  loadHead,
  type MapHead,
  makeRepo,
  memory,
  type Repo,
  treePaths
} from "./helpers.js"

/**
 * A session commit beside the v1 store and beside its own death. The v1 store commits the WHOLE
 * shared index (`git add` then `git commit`, `packages/store/src/git.ts`), and a session commit moves
 * that index one commit ahead of `HEAD` for the instant before its ref moves, so the two must exclude
 * each other (the checkout lock), and a commit killed inside that instant must be settled by the
 * next one (`pending`, written first).
 *
 * The v1 writer here is what the store does, `git add -- <path>` and `git commit`, run under the
 * same `withCheckoutLock` the store takes (`@memhtml/contracts` `checkout-lock.ts`: one policy, one
 * path; `tests-integration` drives the real store against the real commit path). It runs in a ROOT
 * fiber (`Effect.runPromise`), so it is another writer, not a nested holder.
 *
 * Mutation notes, each run once with the change applied and the named case red:
 * - `landOnRef` runs its section without `withCheckoutLock` -> "a v1 commit that reaches the shared
 *   index while the checkout is ahead waits for the swap" (the v1 commit lands in the gap and takes
 *   the session's file; the swap loses).
 * - the lock's wait (`Effect.retry` in `withCheckoutLockUsing`) dropped -> "a session commit that
 *   finds a v1 writer mid-commit waits for it" (`checkout.locked` at once).
 * - `landOnRef`'s first check (`tip !== input.expected`) dropped -> the same case (the checkout is
 *   moved and rolled back over a ref that had already moved, instead of left alone).
 * - `landOnRef` treats `swapped === "raced"` as landed -> "a writer that ignores the lock moves the
 *   ref after the checkout moved" (the commit reports `committed` over a ref it never moved).
 * - step 5 (`pending`) moved after `landOnRef` -> "killed after the checkout moved" (the retry finds
 *   no `pending` and answers `worktree-dirty`, the bug this order fixes).
 * - `settlePending` skips its `readTreeIntoWorktree` -> "killed after the checkout moved" (same
 *   `worktree-dirty`).
 * - `settlePending` rolls back to `pending^` instead of the tip -> "a v1 commit that swept a dead
 *   commit's file in keeps it" (the file is staged as deleted and the next v1 commit drops it).
 * - `worktree-dirty` keeps `pending` -> commit.test.ts "refuses to move a checked-out ref over a
 *   session path" (the log still names the commit).
 * - the `checkout.locked` branch in `commitSession` keeps `pending` -> "a commit whose checkout lock
 *   never frees" (the log names a commit nothing will land).
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const ALPHA = memory("Alpha", "Alpha is the first letter of the Greek alphabet.")

const seeded = async () => {
  const repo = await makeRepo()
  repos.push(repo)
  const base = await commitFiles(repo.root, { "areas/inbox/alpha.html": ALPHA })
  return { root: repo.root, base, head: await loadHead(repo.root) }
}

const start = async (root: string, id: string, head: MapHead, path: string, html: string) =>
  run(
    startSession({ root, id, base: head }).pipe(
      Effect.flatMap((session) => appendOps(session, [{ kind: "put", path, html }]))
    )
  )

/**
 * A v1 store write: the file, `git add -- <path>`, `git commit`, under the checkout lock, from a root
 * fiber of its own. The new HEAD.
 */
const v1Commit = (root: string, path: string, html: string, subject: string): Promise<string> =>
  Effect.runPromise(
    withCheckoutLock(
      root,
      Effect.promise(async () => {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), html, "utf8")
        await git(root, ["add", "--", path])
        await git(root, ["commit", "-q", "-m", subject])
        return git(root, ["rev-parse", "HEAD"])
      })
    )
  )

/** True when `promise` settles within `ms`. */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  ])

/** The real plumbing with `after` run once, right after the checkout's forward move. */
const afterCheckout =
  (root: string, after: Effect.Effect<void>): PlumbingFactory =>
  (indexFile) => {
    const real = makePlumbing({ root, indexFile })
    let moves = 0
    return {
      ...real,
      readTreeIntoWorktree: (from, to) =>
        real
          .readTreeIntoWorktree(from, to)
          .pipe(Effect.tap(() => (moves++ === 0 ? after : Effect.void)))
    }
  }

const SESSION_PATH = "areas/inbox/session-fact.html"
const SESSION_FACT = memory("Session fact", "A fact a run session wrote.")
const V1_ONE = memory("V1 one", "A fact the v1 write path committed.")
const V1_TWO = memory("V1 two", "A second fact the v1 write path committed.")

describe("a session commit beside a v1 writer", () => {
  it("a v1 commit that reaches the shared index while the checkout is ahead waits for the swap, and the session's file stays on main", async () => {
    const { root, base, head } = await seeded()
    const session = await start(root, "v1-gap", head, SESSION_PATH, SESSION_FACT)
    let v1: Promise<string> | undefined
    let landedInGap: boolean | undefined
    const outcome = await run(
      commitSession({
        session,
        head,
        message: "session fact",
        plumbing: afterCheckout(
          root,
          Effect.promise(async () => {
            // The v1 door fires at the exact instant the probe found: the shared index already holds
            // the session's file and the ref has not moved.
            v1 = v1Commit(root, "areas/inbox/v1-one.html", V1_ONE, "memhtml(write): v1 one")
            landedInGap = await settlesWithin(v1, 600)
          })
        )
      })
    )
    expect(landedInGap).toBe(false)
    expect(outcome.kind).toBe("committed")
    if (outcome.kind !== "committed" || v1 === undefined) return
    expect(await git(root, ["rev-parse", `${outcome.sha}^`])).toBe(base)
    // The v1 commit waited, then landed on top of the session's, holding its own file and nothing else.
    const v1Sha = await v1
    expect(await git(root, ["rev-parse", `${v1Sha}^`])).toBe(outcome.sha)
    expect(await git(root, ["show", "--name-status", "--format=", v1Sha])).toBe(
      "A\tareas/inbox/v1-one.html"
    )
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    // The next v1 commit from the shared index keeps the session's file on main.
    await v1Commit(root, "areas/inbox/v1-two.html", V1_TWO, "memhtml(write): v1 two")
    expect(await treePaths(root, "main")).toEqual([
      ".gitignore",
      "areas/inbox/alpha.html",
      SESSION_PATH,
      "areas/inbox/v1-one.html",
      "areas/inbox/v1-two.html"
    ])
    expect(await fileAt(root, "main", SESSION_PATH)).toBe(SESSION_FACT)
  })

  it("a session commit that finds a v1 writer mid-commit waits for it instead of failing, then answers rebase-needed with nothing touched", async () => {
    const { root, head } = await seeded()
    const session = await start(root, "v1-first", head, SESSION_PATH, SESSION_FACT)
    let staged: () => void = () => {}
    const isStaged = new Promise<void>((resolve) => {
      staged = resolve
    })
    // A v1 write that holds the lock with its file staged for 400 ms before it commits.
    const holder = Effect.runPromise(
      withCheckoutLock(
        root,
        Effect.promise(async () => {
          await writeFile(join(root, "areas/inbox/v1-one.html"), V1_ONE, "utf8")
          await git(root, ["add", "--", "areas/inbox/v1-one.html"])
          staged()
          await new Promise((resolve) => setTimeout(resolve, 400))
          await git(root, ["commit", "-q", "-m", "memhtml(write): v1 one"])
          return git(root, ["rev-parse", "HEAD"])
        })
      )
    )
    await isStaged
    const began = Date.now()
    let checkoutMoves = 0
    const counting: PlumbingFactory = (indexFile) => {
      const real = makePlumbing({ root, indexFile })
      return {
        ...real,
        readTreeIntoWorktree: (from, to) =>
          Effect.sync(() => {
            checkoutMoves += 1
          }).pipe(Effect.andThen(real.readTreeIntoWorktree(from, to)))
      }
    }
    const outcome = await run(
      commitSession({ session, head, message: "session fact", plumbing: counting })
    )
    const v1Sha = await holder
    expect(Date.now() - began).toBeGreaterThanOrEqual(250)
    // The ref moved while the session waited, so it touched nothing and asks for a rebase.
    expect(outcome).toEqual({ kind: "rebase-needed", overlapping: [], mainSha: v1Sha })
    expect(checkoutMoves).toBe(0)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    await expect(stat(join(root, SESSION_PATH))).rejects.toThrow()
    expect((await run(resumeSession({ root, id: "v1-first" }))).pending).toBeUndefined()

    const fresh = await loadHead(root)
    const rebased = rebaseSession(await run(resumeSession({ root, id: "v1-first" })), fresh)
    await run(saveSession(rebased))
    const landed = await run(commitSession({ session: rebased, head: fresh, message: "again" }))
    expect(landed.kind).toBe("committed")
    expect(await treePaths(root, "main")).toEqual([
      ".gitignore",
      "areas/inbox/alpha.html",
      SESSION_PATH,
      "areas/inbox/v1-one.html"
    ])
  })

  it("a writer that ignores the lock moves the ref after the checkout moved: the swap loses and the checkout rolls back", async () => {
    const { root, base, head } = await seeded()
    const session = await start(root, "unlocked", head, SESSION_PATH, SESSION_FACT)
    // A writer that takes no lock (an older build, a hand `update-ref`) advances main to a commit
    // with the base's tree at the worst instant: the checkout already holds the session's file.
    const intruder = await git(root, [
      "commit-tree",
      `${base}^{tree}`,
      "-p",
      base,
      "-m",
      "intruder"
    ])
    const outcome = await run(
      commitSession({
        session,
        head,
        message: "session fact",
        plumbing: afterCheckout(
          root,
          Effect.promise(() => git(root, ["update-ref", "refs/heads/main", intruder, base]))
        )
      })
    )
    expect(outcome).toEqual({ kind: "rebase-needed", overlapping: [], mainSha: intruder })
    expect(await git(root, ["rev-parse", "main"])).toBe(intruder)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    await expect(stat(join(root, SESSION_PATH))).rejects.toThrow()
    const resumed = await run(resumeSession({ root, id: "unlocked" }))
    expect(resumed.ops).toHaveLength(1)
    expect(resumed.pending).toBeUndefined()
  })

  it("a commit whose checkout lock never frees fails with checkout.locked, moves nothing, and keeps no pending", async () => {
    const { root, base, head } = await seeded()
    const session = await start(root, "starved", head, SESSION_PATH, SESSION_FACT)
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let held: () => void = () => {}
    const isHeld = new Promise<void>((resolve) => {
      held = resolve
    })
    const holder = Effect.runPromise(
      withCheckoutLock(
        root,
        Effect.promise(async () => {
          held()
          await released
        })
      )
    )
    await isHeld
    const result = await run(
      Effect.result(
        commitSession({ session, head, message: "starved", checkoutLock: { waitMs: 300 } })
      )
    )
    release()
    await holder
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "StorageFailure",
      operation: CHECKOUT_LOCKED
    })
    expect(await git(root, ["rev-parse", "main"])).toBe(base)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    const resumed = await run(resumeSession({ root, id: "starved" }))
    expect(resumed.ops).toHaveLength(1)
    expect(resumed.pending).toBeUndefined()
  })
})

/** The SIGKILL fixture: a commit of `id` that dies at `step`. Resolves with the signal it died of. */
const FIXTURE = fileURLToPath(new URL("./fixtures/killed-commit.mjs", import.meta.url))
const killedCommit = (root: string, id: string, step: string): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, root, id, step], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (signal === null) reject(new Error(`the commit exited ${String(code)}: ${stderr}`))
      else resolve(signal)
    })
  })

/** Time passing for the locks a killed holder left: both go stale, so the next writer reclaims them. */
const ageLocks = async (root: string, id: string) => {
  const past = new Date(
    Date.now() - Math.max(SESSION_LOCK_STALE_MS, CHECKOUT_LOCK_STALE_MS) - 5_000
  )
  for (const dir of [
    join(root, ".memhtml", "checkout.lock"),
    join(root, SESSIONS_DIR, `${id}.lock`)
  ]) {
    await utimes(dir, past, past).catch(() => undefined)
  }
}

describe("a session commit killed mid-sequence", () => {
  it("killed after the checkout moved and before the ref did: the next commit undoes the checkout and lands", async () => {
    const { root, base, head } = await seeded()
    await start(root, "crash", head, SESSION_PATH, SESSION_FACT)
    expect(await killedCommit(root, "crash", "after-checkout")).toBe("SIGKILL")
    // The state the kill left: the intent in the log, the checkout one step ahead, the ref unmoved,
    // and both locks still on disk.
    const dead = await run(resumeSession({ root, id: "crash" }))
    expect(dead.pending).toMatch(/^[0-9a-f]{40}$/)
    expect(dead.ops).toHaveLength(1)
    expect(await git(root, ["status", "--porcelain"])).toBe(`A  ${SESSION_PATH}`)
    expect(await git(root, ["rev-parse", "main"])).toBe(base)
    expect((await stat(join(root, ".memhtml", "checkout.lock"))).isDirectory()).toBe(true)

    await ageLocks(root, "crash")
    const retry = await run(commitSession({ session: dead, head, message: "retry" }))
    if (retry.kind !== "committed") throw new Error(JSON.stringify(retry))
    expect(retry.recovered).toBe(false)
    expect(retry.sha).not.toBe(dead.pending)
    expect(await git(root, ["rev-parse", "main"])).toBe(retry.sha)
    expect(await fileAt(root, "main", SESSION_PATH)).toBe(SESSION_FACT)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    expect((await run(resumeSession({ root, id: "crash" }))).pending).toBeUndefined()
  })

  it("killed after the intent and before anything shared moved: the next commit lands", async () => {
    const { root, head } = await seeded()
    await start(root, "intent", head, SESSION_PATH, SESSION_FACT)
    expect(await killedCommit(root, "intent", "after-intent")).toBe("SIGKILL")
    const dead = await run(resumeSession({ root, id: "intent" }))
    expect(dead.pending).toMatch(/^[0-9a-f]{40}$/)
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    await ageLocks(root, "intent")
    const retry = await run(commitSession({ session: dead, head, message: "retry" }))
    expect(retry).toMatchObject({ kind: "committed", recovered: false })
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    expect(await treePaths(root, "main")).toContain(SESSION_PATH)
  })

  it("killed after the ref moved and before the log was cleared: the next commit reports it as recovered", async () => {
    const { root, head } = await seeded()
    await start(root, "swapped", head, SESSION_PATH, SESSION_FACT)
    expect(await killedCommit(root, "swapped", "after-swap")).toBe("SIGKILL")
    const dead = await run(resumeSession({ root, id: "swapped" }))
    const tip = await git(root, ["rev-parse", "main"])
    expect(dead.pending).toBe(tip)
    // The checkout followed before the ref moved, so the kill left nothing staged.
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    await ageLocks(root, "swapped")
    expect(await run(commitSession({ session: dead, head, message: "retry" }))).toEqual({
      kind: "committed",
      sha: tip,
      paths: [SESSION_PATH],
      contradictions: [],
      worktreeSynced: true,
      recovered: true
    })
    expect(await run(resumeSession({ root, id: "swapped" }))).toMatchObject({
      baseSha: tip,
      ops: []
    })
  })

  it("a v1 commit that swept a dead commit's file in keeps it: recovery does not stage its deletion", async () => {
    const { root, head } = await seeded()
    await start(root, "swept", head, SESSION_PATH, SESSION_FACT)
    expect(await killedCommit(root, "swept", "after-checkout")).toBe("SIGKILL")
    // The dead holder's lock went stale and a v1 writer reclaimed it: its commit took the staged file.
    await ageLocks(root, "swept")
    const v1Sha = await v1Commit(root, "areas/inbox/v1-one.html", V1_ONE, "memhtml(write): v1 one")
    expect(await git(root, ["show", "--name-only", "--format=", v1Sha])).toBe(
      `${SESSION_PATH}\nareas/inbox/v1-one.html`
    )

    const dead = await run(resumeSession({ root, id: "swept" }))
    const retry = await run(commitSession({ session: dead, head, message: "retry" }))
    // The ref moved past the base, so the session is asked to rebase; nothing was rolled back that
    // the branch holds.
    expect(retry).toEqual({ kind: "rebase-needed", overlapping: [SESSION_PATH], mainSha: v1Sha })
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    expect(await readFile(join(root, SESSION_PATH), "utf8")).toBe(SESSION_FACT)
    await v1Commit(root, "areas/inbox/v1-two.html", V1_TWO, "memhtml(write): v1 two")
    expect(await fileAt(root, "main", SESSION_PATH)).toBe(SESSION_FACT)
  })
})

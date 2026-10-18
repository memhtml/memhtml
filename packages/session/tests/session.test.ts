import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { OverlayOp } from "@memhtml/contracts"
import { Effect, Logger, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { commitSession } from "../src/commit.js"
import {
  appendOps,
  DEFAULT_REF,
  LOG_MOVED,
  rebaseSession,
  resumeSession,
  SESSION_LOCK_STALE_MS,
  SESSIONS_DIR,
  saveSession,
  sessionStateFile,
  startSession,
  withSessionLock
} from "../src/session.js"
import { commitFiles, loadHead, makeRepo, mapHead, memory, type Repo } from "./helpers.js"

/**
 * Session state on disk: `.memhtml/sessions/<id>.json` and nothing else between calls.
 *
 * Mutation notes: `checkId` always succeeds -> "refuses an id that is not one path segment";
 * `resumeSession` skips the `state.id !== input.id` check -> "refuses a log whose id disagrees";
 * `startSession` skips the `exists` check -> "refuses to start over an id that already has a log";
 * `requireLogUnmoved` always succeeds -> "refuses an append, a save, and a commit over a log that
 * moved since it was read" (the stale append drops the first writer's op, the stale save drops it
 * too, and the stale commit lands without it and empties the log); the base check in `startSession`
 * dropped -> "refuses a base that names no commit" (the log is written over a bogus sha).
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const seeded = async () => {
  const repo = await makeRepo()
  repos.push(repo)
  await commitFiles(repo.root, {
    "areas/inbox/a.html": memory("A", "Alpha is the first letter of the Greek alphabet.")
  })
  return { root: repo.root, head: await loadHead(repo.root) }
}

describe("startSession", () => {
  it("writes an empty log on the default ref and no index file", async () => {
    const { root, head } = await seeded()
    const session = await run(startSession({ root, id: "s1", base: head }))
    expect(session).toEqual({ root, id: "s1", baseSha: head.sha, ref: DEFAULT_REF, ops: [] })
    expect(await readdir(join(root, SESSIONS_DIR))).toEqual(["s1.json"])
    expect(JSON.parse(await readFile(sessionStateFile(root, "s1"), "utf8"))).toEqual({
      id: "s1",
      baseSha: head.sha,
      ref: DEFAULT_REF,
      ops: []
    })
  })

  it("takes a curator ref", async () => {
    const { root, head } = await seeded()
    const ref = "refs/heads/curate/2026-09-23"
    const session = await run(startSession({ root, id: "cur", base: head, ref }))
    expect(session.ref).toBe(ref)
  })

  it("refuses to start over an id that already has a log, unless forced", async () => {
    const { root, head } = await seeded()
    const started = await run(startSession({ root, id: "again", base: head }))
    const html = memory("B", "Beta is the second letter.")
    await run(appendOps(started, [{ kind: "put", path: "areas/inbox/b.html", html }]))
    const result = await run(Effect.result(startSession({ root, id: "again", base: head })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ _tag: "StorageFailure", operation: "session.exists" })
    }
    // The in-progress overlay is intact.
    expect((await run(resumeSession({ root, id: "again" }))).ops).toHaveLength(1)
    const forced = await run(startSession({ root, id: "again", base: head, force: true }))
    expect(forced.ops).toEqual([])
    expect((await run(resumeSession({ root, id: "again" }))).ops).toEqual([])
  })

  it("refuses a base that names no commit, and writes no log", async () => {
    const { root } = await seeded()
    const result = await run(
      Effect.result(startSession({ root, id: "nobase", base: { sha: "f".repeat(40) } }))
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ _tag: "GitFailure", command: "rev-parse" })
    }
    await expect(stat(sessionStateFile(root, "nobase"))).rejects.toThrow()
  })

  it("refuses an id that is not one path segment", async () => {
    const { root, head } = await seeded()
    for (const id of ["../escape", "a/b", "", ".hidden"]) {
      const result = await run(Effect.result(startSession({ root, id, base: head })))
      expect(Result.isFailure(result), id).toBe(true)
    }
  })
})

describe("appendOps and resumeSession", () => {
  it("persists the log and reads it back with root restored", async () => {
    const { root, head } = await seeded()
    const started = await run(startSession({ root, id: "s2", base: head }))
    const html = memory("B", "Beta is the second letter.")
    const appended = await run(
      appendOps(started, [
        { kind: "put", path: "areas/inbox/b.html", html },
        { kind: "link", path: "areas/inbox/b.html", rel: "relates_to", href: "/areas/inbox/a.html" }
      ])
    )
    expect(appended.ops).toHaveLength(2)
    expect(started.ops).toHaveLength(0)
    const resumed = await run(resumeSession({ root, id: "s2" }))
    expect(resumed).toEqual(appended)
  })

  /**
   * Every `OverlayOp` kind survives the log. (Mutation: a kind left out of `OverlayOpSchema` fails
   * this case with `session.decode` on resume, which is what an `unlink` in a log did before the
   * schema named it: the op was written and the session could not be read back.)
   */
  it("round-trips an op of every kind", async () => {
    const { root, head } = await seeded()
    const started = await run(startSession({ root, id: "kinds", base: head }))
    const html = memory("B", "Beta is the second letter.")
    const ops: ReadonlyArray<OverlayOp> = [
      { kind: "put", path: "areas/inbox/b.html", html },
      { kind: "link", path: "areas/inbox/b.html", rel: "relates_to", href: "/areas/inbox/a.html" },
      {
        kind: "unlink",
        path: "areas/inbox/b.html",
        rel: "relates_to",
        href: "/areas/inbox/a.html"
      },
      { kind: "label", path: "areas/inbox/b.html", entity: "system:memhtml" },
      { kind: "unlabel", path: "areas/inbox/b.html", entity: "system:memhtml" },
      {
        kind: "archive",
        path: "areas/inbox/a.html",
        to: "archive/2026/areas/inbox/a.html",
        html: head.get("areas/inbox/a.html")?.html ?? ""
      }
    ]
    const appended = await run(appendOps(started, ops))
    const resumed = await run(resumeSession({ root, id: "kinds" }))
    expect(resumed.ops).toEqual(ops)
    expect(resumed).toEqual(appended)
  })

  it("refuses an append, a save, and a commit over a log that moved since it was read", async () => {
    const { root, head } = await seeded()
    await run(startSession({ root, id: "race", base: head }))
    // Two writers read the same empty log, the way two `session exec` calls do before their scripts run.
    const first = await run(resumeSession({ root, id: "race" }))
    const second = await run(resumeSession({ root, id: "race" }))
    const b: OverlayOp = {
      kind: "put",
      path: "areas/inbox/b.html",
      html: memory("B", "Beta is the second letter.")
    }
    const c: OverlayOp = {
      kind: "put",
      path: "areas/inbox/c.html",
      html: memory("C", "Gamma is the third letter.")
    }
    await run(appendOps(first, [b]))
    const failureOf = async (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
      const result = await run(Effect.result(effect))
      return Result.isFailure(result) ? (result.failure as { operation?: string }).operation : "ok"
    }
    expect(await failureOf(appendOps(second, [c]))).toBe(LOG_MOVED)
    expect(await failureOf(saveSession(rebaseSession(second, head)))).toBe(LOG_MOVED)
    expect(await failureOf(commitSession({ session: second, head, message: "stale" }))).toBe(
      LOG_MOVED
    )
    // The first writer's op is still the whole log, and nothing was committed.
    expect((await run(resumeSession({ root, id: "race" }))).ops).toEqual([b])
    // A writer that read the log as it now stands appends normally.
    const fresh = await run(resumeSession({ root, id: "race" }))
    expect((await run(appendOps(fresh, [c]))).ops).toEqual([b, c])
  })

  it("fails typed on a missing, malformed, or id-disagreeing log", async () => {
    const { root, head } = await seeded()
    expect(Result.isFailure(await run(Effect.result(resumeSession({ root, id: "nope" }))))).toBe(
      true
    )
    await run(startSession({ root, id: "s3", base: head }))
    await writeFile(sessionStateFile(root, "s3"), "{not json", "utf8")
    expect(Result.isFailure(await run(Effect.result(resumeSession({ root, id: "s3" }))))).toBe(true)
    await writeFile(
      sessionStateFile(root, "s3"),
      JSON.stringify({ id: "other", baseSha: head.sha, ref: DEFAULT_REF, ops: [] }),
      "utf8"
    )
    const result = await run(Effect.result(resumeSession({ root, id: "s3" })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.operation).toBe("session.id-mismatch")
  })

  it("round-trips a pending commit sha and omits the key when there is none", async () => {
    const { root, head } = await seeded()
    const started = await run(startSession({ root, id: "pend", base: head }))
    expect(JSON.parse(await readFile(sessionStateFile(root, "pend"), "utf8"))).not.toHaveProperty(
      "pending"
    )
    await run(saveSession({ ...started, pending: "a".repeat(40) }))
    expect((await run(resumeSession({ root, id: "pend" }))).pending).toBe("a".repeat(40))
    await run(saveSession({ ...started, pending: undefined }))
    expect((await run(resumeSession({ root, id: "pend" }))).pending).toBeUndefined()
  })

  it("rejects an op of an unknown kind on resume", async () => {
    const { root, head } = await seeded()
    await run(startSession({ root, id: "s4", base: head }))
    await writeFile(
      sessionStateFile(root, "s4"),
      JSON.stringify({
        id: "s4",
        baseSha: head.sha,
        ref: DEFAULT_REF,
        ops: [{ kind: "delete", path: "areas/inbox/a.html" }]
      }),
      "utf8"
    )
    expect(Result.isFailure(await run(Effect.result(resumeSession({ root, id: "s4" }))))).toBe(true)
  })
})

describe("withSessionLock", () => {
  /**
   * A lock directory a killed holder left behind. proper-lockfile reclaims it only when the SAME id
   * is locked again and its mtime is older than the stale window, so for a run's id, which nothing
   * locks again, it stays until `pruneSessions` removes it.
   * Mutation: `stale: SESSION_LOCK_STALE_MS` -> `stale: 24 * 3600 * 1000` -> the backdated lock is
   * refused as held.
   */
  it("refuses a fresh lock left by another holder, and reclaims it once it is stale", async () => {
    const { root, head } = await seeded()
    const started = await run(startSession({ root, id: "left", base: head }))
    const lockDir = join(root, SESSIONS_DIR, "left.lock")
    await mkdir(lockDir)
    const op: OverlayOp = { kind: "put", path: "areas/inbox/b.html", html: memory("B", "Beta.") }
    const held = await run(Effect.result(appendOps(started, [op])))
    expect(Result.isFailure(held) && held.failure).toMatchObject({ operation: "session.locked" })
    const past = new Date(Date.now() - SESSION_LOCK_STALE_MS - 5_000)
    await utimes(lockDir, past, past)
    expect((await run(appendOps(started, [op]))).ops).toHaveLength(1)
    // The reclaiming writer released its own lock, so the directory is gone.
    await expect(stat(lockDir)).rejects.toThrow()
  })

  /**
   * A held lock whose directory is removed under it (a prune, or a writer that judged it stale):
   * proper-lockfile's refresh finds it gone and calls `onCompromised`, whose default throws from the
   * timer, an uncaught exception that would end `head serve` mid-commit.
   * Mutation: drop the `onCompromised` option -> the exception reaches the process (`uncaught` holds
   * it, and vitest reports it as unhandled) and no warning is logged.
   */
  it("survives a held lock that is compromised: nothing is thrown, the holder finishes, and a warning names the lock", async () => {
    const { root, head } = await seeded()
    await run(startSession({ root, id: "lost", base: head }))
    const lockDir = join(root, SESSIONS_DIR, "lost.lock")
    const uncaught: Array<unknown> = []
    const onUncaught = (error: unknown) => {
      uncaught.push(error)
    }
    process.on("uncaughtException", onUncaught)
    const logs: Array<string> = []
    const capture = Logger.layer([Logger.make((options) => logs.push(String(options.message)))])
    try {
      const held = withSessionLock(
        root,
        "lost",
        Effect.gen(function* () {
          yield* Effect.promise(() => rm(lockDir, { recursive: true, force: true }))
          // Past one refresh, which finds the directory gone.
          yield* Effect.sleep("1500 millis")
          return "finished"
        }),
        { updateMs: 1_000 }
      )
      expect(await run(held.pipe(Effect.provide(capture)))).toBe("finished")
    } finally {
      process.off("uncaughtException", onUncaught)
    }
    expect(uncaught).toEqual([])
    expect(
      logs.filter(
        (line) => line.startsWith("session lost: its lock") && line.includes("compromised")
      )
    ).toHaveLength(1)
    // The next writer of the id takes the lock as usual.
    expect(await run(withSessionLock(root, "lost", Effect.succeed("again")))).toBe("again")
  })
})

describe("rebaseSession", () => {
  it("moves baseSha, keeps ops and ref, and is pure", () => {
    const session = {
      root: "/r",
      id: "x",
      baseSha: "a".repeat(40),
      ref: DEFAULT_REF,
      ops: [{ kind: "put" as const, path: "areas/inbox/p.html", html: "" }]
    }
    const onto = mapHead("b".repeat(40), [])
    const rebased = rebaseSession(session, onto)
    expect(rebased).toEqual({ ...session, baseSha: "b".repeat(40) })
    expect(session.baseSha).toBe("a".repeat(40))
    expect(join(session.root)).toBe("/r")
  })
})

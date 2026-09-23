import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  appendOps,
  DEFAULT_REF,
  rebaseSession,
  resumeSession,
  saveSession,
  sessionIndexFile,
  sessionStateFile,
  startSession
} from "../src/session.js"
import { commitFiles, loadHead, makeRepo, mapHead, memory, type Repo } from "./helpers.js"

/**
 * Session state on disk: `.memhtml/sessions/<id>.idx` and `<id>.json`.
 *
 * Mutation notes: `checkId` always succeeds -> "refuses an id that is not one path segment";
 * `resumeSession` skips the `state.id !== input.id` check -> "refuses a log whose id disagrees";
 * `startSession` skips the `exists` check -> "refuses to start over an id that already has a log".
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
  it("creates the index file and an empty log on the default ref", async () => {
    const { root, head } = await seeded()
    const session = await run(startSession({ root, id: "s1", base: head }))
    expect(session).toEqual({ root, id: "s1", baseSha: head.sha, ref: DEFAULT_REF, ops: [] })
    expect((await stat(sessionIndexFile(root, "s1"))).size).toBeGreaterThan(0)
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

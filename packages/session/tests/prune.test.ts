import { execFileSync } from "node:child_process"
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { commitSession } from "../src/commit.js"
import { pruneSessions } from "../src/prune.js"
import {
  appendOps,
  resumeSession,
  SESSION_REFS_PREFIX,
  SESSIONS_DIR,
  sessionStateFile,
  startSession
} from "../src/session.js"
import { commitFiles, git, loadHead, makeRepo, memory, type Repo } from "./helpers.js"

/**
 * `pruneSessions` over a fixture carrying every kind of session state a store accumulates, aged on
 * either side of a seven-day cutoff.
 *
 * Mutation notes, each run once with the change applied and the named case red:
 * - `if (state.success.ops.length > 0)` -> `if (false)` -> "removes old state and keeps every log
 *   that holds ops" (the unlanded log is deleted).
 * - `dryRun ||` dropped before an `unlink` -> "a dry run reports the same and removes nothing".
 * - the `lockStamp.mtimeMs >= lockCutoff` gate dropped -> "a dry run reports ..." (the live
 *   session's log is counted for removal while its lock is fresh; a real run still spares it, because
 *   taking that session's lock fails).
 * - the ref filter's `committedAt * 1000 < cutoff` dropped -> "removes old state ..." (the fresh
 *   ref is deleted).
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const repos: Array<Repo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const DAY_MS = 24 * 3600 * 1000
const WEEK_MS = 7 * DAY_MS

const age = async (path: string, ms: number) => {
  const at = new Date(Date.now() - ms)
  await utimes(path, at, at)
}

/** A commit whose committer time is `ms` ago, for a ref that old. */
const commitAged = (root: string, tree: string, ms: number): string => {
  const at = `${Math.floor((Date.now() - ms) / 1000)} +0000`
  return execFileSync("git", ["-C", root, "commit-tree", tree, "-m", "aged"], {
    encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at }
  }).trim()
}

/** The fixture: one of every kind, old (ten days) or new (now). */
const fixture = async () => {
  const repo = await makeRepo()
  repos.push(repo)
  const root = repo.root
  await commitFiles(root, { "areas/inbox/a.html": memory("A", "Alpha is the first letter.") })
  const head = await loadHead(root)
  const dir = join(root, SESSIONS_DIR)
  const old = 10 * DAY_MS
  const put = (name: string) => ({
    kind: "put" as const,
    path: `areas/inbox/${name}.html`,
    html: memory(`Fact ${name}`, `The ${name} fact.`)
  })

  // A session whose commit landed (zero ops), ten days ago; and one that started just now.
  const landed = await run(
    startSession({ root, id: "landed-old", base: head }).pipe(
      Effect.flatMap((s) => appendOps(s, [put("landed")]))
    )
  )
  const outcome = await run(commitSession({ session: landed, head, message: "landed" }))
  expect(outcome.kind).toBe("committed")
  await age(sessionStateFile(root, "landed-old"), old)
  const tip = await loadHead(root)
  await run(startSession({ root, id: "landed-new", base: tip }))

  // Logs that still hold ops: one ten days old, one fresh.
  await run(
    startSession({ root, id: "unlanded-old", base: tip }).pipe(
      Effect.flatMap((s) => appendOps(s, [put("one"), put("two")]))
    )
  )
  await age(sessionStateFile(root, "unlanded-old"), old)
  await run(
    startSession({ root, id: "unlanded-new", base: tip }).pipe(
      Effect.flatMap((s) => appendOps(s, [put("three")]))
    )
  )

  // A log that does not decode.
  await writeFile(join(dir, "corrupt-old.json"), "{not json", "utf8")
  await age(join(dir, "corrupt-old.json"), old)

  // Index files an older build kept per session.
  await writeFile(join(dir, "legacy-old.idx"), Buffer.alloc(1000))
  await age(join(dir, "legacy-old.idx"), old)
  await writeFile(join(dir, "unlanded-old.idx"), Buffer.alloc(500))
  await age(join(dir, "unlanded-old.idx"), old)
  await writeFile(join(dir, "legacy-new.idx"), Buffer.alloc(200))

  // A run killed while it held its session lock, ten days ago; and a writer holding one now.
  await run(startSession({ root, id: "dead-run", base: tip }))
  await age(sessionStateFile(root, "dead-run"), old)
  await mkdir(join(dir, "dead-run.lock"))
  await age(join(dir, "dead-run.lock"), old)
  await run(startSession({ root, id: "live", base: tip }))
  await age(sessionStateFile(root, "live"), old)
  await mkdir(join(dir, "live.lock"))

  // A drop trail, which stays.
  await writeFile(join(dir, "landed-old.dropped.jsonl"), "{}\n", "utf8")
  await age(join(dir, "landed-old.dropped.jsonl"), old)

  // Provenance refs an older build wrote: one naming a ten-day-old commit, one naming today's.
  const tree = await git(root, ["rev-parse", "HEAD^{tree}"])
  await git(root, ["update-ref", `${SESSION_REFS_PREFIX}old`, commitAged(root, tree, old)])
  await git(root, [
    "update-ref",
    `${SESSION_REFS_PREFIX}new`,
    await git(root, ["rev-parse", "HEAD"])
  ])

  return { root, dir }
}

const listing = async (dir: string) => (await readdir(dir)).sort()
const refsOf = async (root: string) =>
  (await git(root, ["for-each-ref", "--format=%(refname)", SESSION_REFS_PREFIX])).split("\n")

describe("pruneSessions", () => {
  it("a dry run reports what a real run removes and removes nothing", async () => {
    const { root, dir } = await fixture()
    const before = await listing(dir)
    const refsBefore = await refsOf(root)
    const report = await run(pruneSessions({ root, olderThanMs: WEEK_MS, dryRun: true }))
    expect(report).toMatchObject({
      dryRun: true,
      olderThanMs: WEEK_MS,
      indexes: { count: 2, bytes: 1500 },
      refs: { count: 1 },
      locks: { count: 1 },
      logs: { count: 2 },
      busy: ["live"],
      unreadable: ["corrupt-old"]
    })
    expect(report.unlanded.map(({ id, ops, pending }) => ({ id, ops, pending }))).toEqual([
      { id: "unlanded-old", ops: 2, pending: null }
    ])
    expect(await listing(dir)).toEqual(before)
    expect(await refsOf(root)).toEqual(refsBefore)
  })

  it("removes old state and keeps every log that holds ops", async () => {
    const { root, dir } = await fixture()
    const report = await run(pruneSessions({ root, olderThanMs: WEEK_MS }))
    expect(report).toMatchObject({
      dryRun: false,
      indexes: { count: 2, bytes: 1500 },
      refs: { count: 1 },
      locks: { count: 1 },
      logs: { count: 2 },
      busy: ["live"],
      unreadable: ["corrupt-old"]
    })
    expect(report.unlanded).toHaveLength(1)
    expect(report.unlanded[0]).toMatchObject({ id: "unlanded-old", ops: 2 })
    expect(report.unlanded[0]?.ageMs).toBeGreaterThan(9 * DAY_MS)
    expect(await listing(dir)).toEqual([
      "corrupt-old.json",
      "landed-new.json",
      "landed-old.dropped.jsonl",
      "legacy-new.idx",
      "live.json",
      "live.lock",
      "unlanded-new.json",
      "unlanded-old.json"
    ])
    expect(await refsOf(root)).toEqual([`${SESSION_REFS_PREFIX}new`])
    // The unlanded session is intact and still commits.
    const kept = await run(resumeSession({ root, id: "unlanded-old" }))
    expect(kept.ops).toHaveLength(2)
    const outcome = await run(
      commitSession({ session: kept, head: await loadHead(root), message: "late" })
    )
    expect(outcome.kind).toBe("committed")

    // A second run finds nothing more to remove.
    const again = await run(pruneSessions({ root, olderThanMs: WEEK_MS }))
    expect(again).toMatchObject({
      indexes: { count: 0, bytes: 0 },
      refs: { count: 0 },
      locks: { count: 0 },
      logs: { count: 0 },
      unlanded: []
    })
  })

  it("reports nothing on a store with no sessions directory", async () => {
    const repo = await makeRepo()
    repos.push(repo)
    await commitFiles(repo.root, { "areas/inbox/a.html": memory("A", "Alpha.") })
    const report = await run(pruneSessions({ root: repo.root, olderThanMs: WEEK_MS }))
    expect(report).toMatchObject({
      indexes: { count: 0, bytes: 0 },
      refs: { count: 0 },
      locks: { count: 0 },
      logs: { count: 0 },
      unlanded: [],
      busy: [],
      unreadable: []
    })
  })
})

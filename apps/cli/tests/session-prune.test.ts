import { execFileSync } from "node:child_process"
import { access, mkdir, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { SESSION_REFS_PREFIX, SESSIONS_DIR, sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { EXIT_OK, EXIT_USAGE } from "../src/envelope.js"
import { parseArgv, run, validate } from "../src/run.js"
import { parseOlderThan } from "../src/v2.js"

/**
 * `memhtml session prune` through the CLI: the flag's parsing, the envelope, and the one rule that
 * matters to a runtime reading `<id>.json`: a log that still holds ops is never removed. The package
 * suite (`packages/session/tests/prune.test.ts`) covers every kind of state; this one covers the door.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `parseOlderThan`: drop the bare-number refusal -> "refuses a cutoff with no unit" (`7` reads as
 *   seven milliseconds).
 * - `run.ts` `sessionIdFlag`: drop the `session prune` exemption -> "needs no --id" (ERR_MISSING_ARGUMENT).
 */

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Body = Record<string, unknown>

const cli = async (root: string, argv: ReadonlyArray<string>, input = "") => {
  const result = await run(
    [...argv, "--repo", root],
    undefined,
    () => Promise.resolve(input),
    false
  )
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Body }
}

const DAY_MS = 24 * 3600 * 1000

const age = async (path: string, ms: number) => {
  const at = new Date(Date.now() - ms)
  await utimes(path, at, at)
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

const line = (title: string, body: string) =>
  `${JSON.stringify({ op: "write", title, type: "semantic", body, entity: "system:fixture" })}\n`

describe("session prune --older-than", () => {
  it("reads a duration with a unit", () => {
    expect(parseOlderThan("7d")).toEqual({ ok: true, ms: 7 * DAY_MS })
    expect(parseOlderThan("48h")).toEqual({ ok: true, ms: 2 * DAY_MS })
    expect(parseOlderThan("90m")).toEqual({ ok: true, ms: 90 * 60 * 1000 })
    expect(parseOlderThan("1.5h")).toEqual({ ok: true, ms: 1.5 * 3600 * 1000 })
    expect(parseOlderThan("2 weeks")).toEqual({ ok: true, ms: 14 * DAY_MS })
    expect(parseOlderThan("0s")).toEqual({ ok: true, ms: 0 })
  })

  it("refuses a cutoff with no unit, a negative one, an empty one, and a word", () => {
    for (const value of ["7", "", "-1d", "banana", "7 fortnights"]) {
      expect(parseOlderThan(value).ok, value).toBe(false)
    }
    const failure = validate(parseArgv(["session", "prune", "--older-than", "7"]))
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
  })

  it("is required, and needs no --id", () => {
    const saved = process.env.MEMHTML_SESSION
    delete process.env.MEMHTML_SESSION
    try {
      expect(validate(parseArgv(["session", "prune"]))?.code).toBe("ERR_MISSING_ARGUMENT")
      expect(validate(parseArgv(["session", "prune", "--older-than", "7d"]))).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.MEMHTML_SESSION = saved
    }
  })
})

describe("memhtml session prune", () => {
  it("dry-runs, then removes old state, and keeps the log that holds ops for session status", async () => {
    const repo = await run_(makeFixtureRepo())
    repos.push(repo)
    const root = repo.root
    // A session that landed (its log now holds zero ops) and one that did not, both ten days idle.
    expect((await cli(root, ["session", "start", "--id", "landed"])).exitCode).toBe(EXIT_OK)
    const put = await cli(
      root,
      ["session", "put", "--id", "landed", "--file", "-", "--no-server"],
      line("Pruned session fact", "A fact the landed session wrote.")
    )
    expect(put.exitCode).toBe(EXIT_OK)
    expect(
      (await cli(root, ["session", "commit", "--id", "landed", "--message", "landed"])).exitCode
    ).toBe(EXIT_OK)
    expect((await cli(root, ["session", "start", "--id", "unlanded"])).exitCode).toBe(EXIT_OK)
    await cli(
      root,
      ["session", "put", "--id", "unlanded", "--file", "-", "--no-server"],
      line("Unlanded session fact", "A fact that has not landed yet.")
    )
    const dir = join(root, SESSIONS_DIR)
    await writeFile(join(dir, "legacy.idx"), Buffer.alloc(2048))
    for (const name of ["landed.json", "unlanded.json", "legacy.idx"]) {
      await age(join(dir, name), 10 * DAY_MS)
    }
    await mkdir(join(dir, "killed.lock"))
    await age(join(dir, "killed.lock"), 10 * DAY_MS)
    const at = `${Math.floor((Date.now() - 10 * DAY_MS) / 1000)} +0000`
    const old = execFileSync(
      "git",
      ["-C", root, "commit-tree", "HEAD^{tree}", "-m", "old provenance"],
      { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } }
    ).trim()
    execFileSync("git", ["-C", root, "update-ref", `${SESSION_REFS_PREFIX}landed`, old])

    const dry = await cli(root, ["session", "prune", "--older-than", "7d", "--dry-run"])
    expect(dry.exitCode).toBe(EXIT_OK)
    expect(dry.body).toMatchObject({ apiVersion: "1", type: "session.pruned" })
    const planned = dry.body.data as Body
    expect(planned).toMatchObject({
      dryRun: true,
      olderThan: "7d",
      olderThanMs: 7 * DAY_MS,
      indexes: { count: 1, bytes: 2048 },
      refs: { count: 1 },
      locks: { count: 1 },
      logs: { count: 1 },
      busy: [],
      unreadable: []
    })
    expect(planned.unlanded).toMatchObject([{ id: "unlanded", ops: 1, pending: null, age: "10d" }])
    expect(await exists(sessionStateFile(root, "landed"))).toBe(true)

    const done = await cli(root, ["session", "prune", "--older-than", "7d"])
    expect(done.exitCode).toBe(EXIT_OK)
    expect(done.body.data).toMatchObject({
      dryRun: false,
      indexes: { count: 1 },
      refs: { count: 1 },
      locks: { count: 1 },
      logs: { count: 1 }
    })
    expect(await exists(sessionStateFile(root, "landed"))).toBe(false)
    expect(await exists(join(dir, "legacy.idx"))).toBe(false)
    expect(await exists(join(dir, "killed.lock"))).toBe(false)
    // The log a runtime reads is where it was, with its op.
    const status = await cli(root, ["session", "status", "--id", "unlanded"])
    expect(status.exitCode).toBe(EXIT_OK)
    expect(status.body.data).toMatchObject({ ops: 1 })
  })

  it("refuses a bad cutoff at exit 2 before it opens anything", async () => {
    const result = await cli("/nonexistent/memhtml-prune", [
      "session",
      "prune",
      "--older-than",
      "soon"
    ])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(result.body).toMatchObject({ code: "ERR_INVALID_FLAG" })
  })
})

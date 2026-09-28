import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CONFIG_VARS } from "../src/config.js"
import { ERROR_CODES, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../src/envelope.js"
import { startHeadServer } from "../src/head-server.js"
import { USAGE_ERROR_CODES } from "../src/help.js"
import { parseArgv, run, validate } from "../src/run.js"
import { ensureSession } from "../src/v2.js"
import { fakeEmbedder } from "./harness.js"

/**
 * `MEMHTML_SESSION`: the session an agent runtime hands every subprocess of one run. With it set, a
 * `session` command defaults `--id` to it, `session put` and `session exec` start that session on
 * first use, and the v1 doors that create a record refuse with `ERR_SESSION_BOUND`.
 *
 * The variable, the code, and the door list are spelled as literals here rather than imported, so
 * a rename of any of them fails a case below instead of following it.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `run.ts` `validateAgainst`: drop the `sessionBoundRefusal(parsed)` call -> "refuses each v1
 *   door that creates a record" (validate answers undefined for `task add` and the rest).
 * - `run.ts` `sessionIdOf`: ignore the variable (`fromEnv` never read) -> "starts the session on
 *   the first put" (the blank id is refused before anything starts).
 * - `v2.ts` `sessionPut` and `sessionExec`: `implicitStart` never true -> "starts the session on the
 *   first put" and "starts the session on the first exec, through the head server" (resume fails
 *   with session.read).
 * - `v2.ts` `ensureSession`: drop the `catchIf` on `session.exists` / `session.locked` -> "two first
 *   uses at once start one session" (the loser fails with `session.locked`).
 */

const VAR = "MEMHTML_SESSION"
const CODE = "ERR_SESSION_BOUND"
const AT = "2026-03-01T12:00:00Z"

type Body = Record<string, unknown>

const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const repos: Array<FixtureRepo> = []
const scopes: Array<Scope.Closeable> = []
let saved: string | undefined

beforeEach(() => {
  saved = process.env[VAR]
})

afterEach(async () => {
  if (saved === undefined) delete process.env[VAR]
  else process.env[VAR] = saved
  await Promise.all(scopes.splice(0).map((scope) => run_(Scope.close(scope, Exit.void))))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const record = (title: string, claim: string, entities: ReadonlyArray<string>) =>
  renderTemplate({ title, claim, memoryType: "semantic", at: AT, entities: [...entities] })

/** A committed corpus of two labeled records on `main`. */
const corpus = async (): Promise<FixtureRepo> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  for (const [word, entity] of [
    ["harbor", "system:fixture"],
    ["orchard", "system:fixture"]
  ] as const) {
    const target = join(repo.root, "areas", "inbox", `${word}.html`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, record(word, `${word} facts are recorded here.`, [entity]), "utf8")
  }
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", "corpus"]))
  return repo
}

/** `memhtml <argv> --repo <root>` in process, stdin from `input`, parsed. */
const cli = async (
  root: string,
  argv: ReadonlyArray<string>,
  input = ""
): Promise<{ exitCode: number; body: Body }> => {
  const result = await run(
    [...argv, "--repo", root],
    undefined,
    () => Promise.resolve(input),
    false
  )
  return { exitCode: result.exitCode, body: JSON.parse(result.stdout) as Body }
}

const dataOf = (body: Body) => body.data as Body

const hasLog = (root: string, id: string) =>
  access(sessionStateFile(root, id)).then(
    () => true,
    () => false
  )

/** A heredoc an agent would write: one record at the bar, one that names nothing. */
const GOOD = record(
  "Run sessions commit at run end",
  "hex-bonk commits a run's memhtml session after the answer posts.",
  ["project:hex-bonk"]
)
const BARE = record("A note that names nothing", "This record is about nothing in particular.", [])

describe("the manifest declares MEMHTML_SESSION and ERR_SESSION_BOUND", () => {
  it("lists the variable and the code, as a usage code", () => {
    expect(CONFIG_VARS.map((row) => row.name)).toContain(VAR)
    expect(ERROR_CODES).toContain(CODE)
    expect(USAGE_ERROR_CODES).toContain(CODE)
  })
})

describe("with MEMHTML_SESSION unset", () => {
  it("still refuses a session command with no --id as a missing argument naming the variable", () => {
    delete process.env[VAR]
    const failure = validate(parseArgv(["session", "status"]))
    expect(failure?.code).toBe("ERR_MISSING_ARGUMENT")
    expect(failure?.error).toContain("--id")
    expect(failure?.error).toContain(VAR)
  })

  it("leaves the v1 write doors open", () => {
    delete process.env[VAR]
    expect(
      validate(parseArgv(["write", "--title", "t", "--claim", "c.", "--type", "semantic"]))
    ).toBeUndefined()
  })
})

describe("with MEMHTML_SESSION set", () => {
  it("accepts a session command with no --id, and refuses a malformed value naming the variable", () => {
    process.env[VAR] = "run-4f1c"
    expect(validate(parseArgv(["session", "status"]))).toBeUndefined()
    process.env[VAR] = "../escape"
    const failure = validate(parseArgv(["session", "status"]))
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
    expect(failure?.error).toContain(VAR)
  })

  it("treats a blank value as unset", () => {
    process.env[VAR] = "   "
    expect(validate(parseArgv(["session", "status"]))?.code).toBe("ERR_MISSING_ARGUMENT")
    expect(
      validate(parseArgv(["write", "--title", "t", "--claim", "c.", "--type", "semantic"]))
    ).toBeUndefined()
  })

  it("refuses each v1 door that creates a record, at exit 2, pointing at the session commands", () => {
    process.env[VAR] = "run-4f1c"
    const doors = [
      ["write", "--title", "t", "--claim", "c.", "--type", "semantic"],
      ["apply", "--file", "ops.jsonl"],
      ["correct", "areas/inbox/x.html", "--title", "t", "--claim", "c."],
      ["task", "add", "--title", "t", "--claim", "c."]
    ]
    for (const argv of doors) {
      const failure = validate(parseArgv(argv))
      expect(failure?.code, argv.join(" ")).toBe(CODE)
      expect(failure?.error, argv.join(" ")).toContain(VAR)
      expect(
        failure?.suggestions.some((line) => line.startsWith("memhtml session")),
        argv.join(" ")
      ).toBe(true)
    }
    // Refused before any other rule: a `write` missing its required flags still answers the door.
    expect(validate(parseArgv(["write"]))?.code).toBe(CODE)
  })

  it("leaves reads and the edits of existing records open", () => {
    process.env[VAR] = "run-4f1c"
    for (const argv of [
      ["search", "harbor"],
      ["read", "areas/inbox/harbor.html"],
      ["link", "areas/inbox/a.html", "supersedes", "areas/inbox/b.html"],
      ["archive", "areas/inbox/a.html", "--reason", "done"],
      ["task", "status", "areas/inbox/tasks/t.html", "done"],
      ["reinforce", "areas/inbox/a.html"]
    ]) {
      expect(validate(parseArgv(argv)), argv.join(" ")).toBeUndefined()
    }
  })

  it("refuses `write` end to end before anything opens", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-4f1c"
    const before = await run_(repo.git.revParseHead())
    const result = await cli(repo.root, [
      "write",
      "--title",
      "t",
      "--claim",
      "c.",
      "--type",
      "semantic",
      "--entity",
      "system:fixture"
    ])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(result.body.code).toBe(CODE)
    expect(await run_(repo.git.revParseHead())).toBe(before)
  })

  it("reads a session named by MEMHTML_SESSION on status, and starts nothing there", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-status"
    const missing = await cli(repo.root, ["session", "status"])
    expect(missing.exitCode).toBe(EXIT_RUNTIME)
    expect(missing.body.code).toBe("ERR_STORAGE")
    expect(await hasLog(repo.root, "run-status")).toBe(false)
  })

  it("starts the session on the first put, resumes it on the second, and commits it with no --id", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-put"
    const line = (title: string, body: string) =>
      `${JSON.stringify({ op: "write", title, type: "semantic", body, entity: "project:hex-bonk" })}\n`
    const first = await cli(
      repo.root,
      ["session", "put", "--file", "-", "--no-server"],
      line("First fact", "The first fact holds.")
    )
    expect(first.exitCode).toBe(EXIT_OK)
    expect(dataOf(first.body)).toMatchObject({ id: "run-put", started: true, appended: 1 })
    const second = await cli(
      repo.root,
      ["session", "put", "--file", "-", "--no-server"],
      line("Second fact", "The second fact holds.")
    )
    expect(dataOf(second.body)).toMatchObject({ started: false, appended: 1, ops: 2 })
    const status = await cli(repo.root, ["session", "status"])
    expect(dataOf(status.body)).toMatchObject({ id: "run-put", ref: "refs/heads/main", puts: 2 })
    const committed = await cli(repo.root, ["session", "commit", "--message", "two facts"])
    expect(dataOf(committed.body)).toMatchObject({ kind: "committed" })
    const log = await run_(repo.git.run(["log", "-1", "--format=%B"]))
    expect(log).toContain("memhtml(session): two facts")
    expect(log).toContain("Memhtml-Session: run-put")
  })

  it("refuses a put below the write bar in-turn, at exit 1, naming what to add", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-bare"
    const bare = `${JSON.stringify({ op: "write", title: "Bare", type: "semantic", body: "About nothing." })}\n`
    const result = await cli(repo.root, ["session", "put", "--file", "-", "--no-server"], bare)
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    expect(result.body.code).toBe("ERR_INVALID_MEMORY")
    expect(String(result.body.error)).toContain("below the write bar")
    expect(String(result.body.error)).toContain("memhtml-entity")
  })

  it("keeps an id given on the line to the explicit contract: it must name a started session", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-other"
    const result = await cli(
      repo.root,
      ["session", "put", "--id", "never-started", "--file", "-", "--no-server"],
      `${JSON.stringify({ op: "write", title: "T", type: "semantic", body: "B.", entity: "system:x" })}\n`
    )
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    expect(result.body.code).toBe("ERR_STORAGE")
    expect(await hasLog(repo.root, "never-started")).toBe(false)
  })

  it("starts the session on the first exec, through the head server, and reports the bar in-turn", async () => {
    const repo = await corpus()
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    await run_(
      startHeadServer({ root: repo.root, pollMs: 0, embedder: fakeEmbedder() }).pipe(
        Scope.provide(scope)
      )
    )
    process.env[VAR] = "run-exec"
    const script = [
      "mkdir -p /mnt/memhtml/projects/hex-bonk",
      "cat > /mnt/memhtml/projects/hex-bonk/run-sessions.html <<'HTML'",
      GOOD.trimEnd(),
      "HTML",
      "cat > /mnt/memhtml/areas/inbox/bare-note.html <<'HTML'",
      BARE.trimEnd(),
      "HTML",
      ""
    ].join("\n")
    const both = await cli(repo.root, ["session", "exec"], script)
    expect(both.exitCode).toBe(EXIT_OK)
    const report = dataOf(both.body)
    expect(report).toMatchObject({ started: true, appended: 0 })
    expect((report.head as Body).source).toBe("server")
    const violations = report.violations as ReadonlyArray<Body>
    expect(violations.map((violation) => [violation.kind, violation.path])).toEqual([
      ["write-bar", "areas/inbox/bare-note.html"]
    ])
    const blocking = report.blocking as ReadonlyArray<string>
    expect(blocking).toHaveLength(1)
    expect(blocking[0]).toContain("below the write bar")
    expect(blocking[0]).toContain("memhtml-entity")

    // The agent fixes the call by dropping the bare record; the good one lands in the same session.
    const good = script.split("cat > /mnt/memhtml/areas/inbox/bare-note.html")[0] ?? ""
    const fixed = await cli(repo.root, ["session", "exec"], good)
    expect(dataOf(fixed.body)).toMatchObject({ started: false, appended: 1 })
    const log = JSON.parse(await readFile(sessionStateFile(repo.root, "run-exec"), "utf8")) as {
      ops: ReadonlyArray<Body>
    }
    expect(log.ops.map((op) => [op.kind, op.path])).toEqual([
      ["put", "projects/hex-bonk/run-sessions.html"]
    ])
  })

  it("two first uses at once start one session, and both go on with it", async () => {
    const repo = await corpus()
    const answers = await run_(
      Effect.all(
        [
          ensureSession({ root: repo.root, id: "run-race" }),
          ensureSession({ root: repo.root, id: "run-race" })
        ],
        { concurrency: "unbounded" }
      )
    )
    expect([...answers].sort()).toEqual([false, true])
    expect(await hasLog(repo.root, "run-race")).toBe(true)
  })
})

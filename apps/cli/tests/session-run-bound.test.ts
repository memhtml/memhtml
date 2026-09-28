import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect, Exit, Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { decodeSessionPut } from "../src/apply.js"
import { EXIT_OK, EXIT_RUNTIME } from "../src/envelope.js"
import { startHeadServer } from "../src/head-server.js"
import { parseArgv, RECORD_CREATING_V1_COMMANDS, run, validate } from "../src/run.js"
import { fakeEmbedder } from "./harness.js"

/**
 * A run-bound session (its id is `MEMHTML_SESSION`'s) and the runtime's end-of-run commit.
 *
 * One repeated fact used to sink a whole run: `duplicate` and `claim-edit` were reported and
 * appended, and the commit at run end refused the session whole. Now a run-bound `session put` and
 * `session exec` refuse those two in-turn, where the agent reads why, and `session commit
 * --drop-refused` (the finalize's commit) drops what a later refusal names and lands the rest.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `v2.ts` `RUN_BOUND_BLOCKING_VIOLATIONS`: drop `"duplicate"` -> "refuses a repeated put in-turn"
 *   and "blocks a harvest that repeats a record, locally and through the head server"; drop
 *   `"claim-edit"` -> "refuses a put over an active record's path in-turn".
 * - `run.ts` `sessionIdOf`: `runBound` false for an id on the line -> "holds an id spelled with
 *   --id to the run's bar when it is the variable's".
 * - `head-server.ts`: drop `runBound: body.runBound === true` from the neighbors route -> "refuses a
 *   repeated put in-turn" (its server leg), from serveExec -> "blocks a harvest ... through the
 *   head server".
 * - `v2.ts` `sessionExec`: stop passing `runBound` to the local `execOverHead` -> the local leg of
 *   "blocks a harvest that repeats a record".
 * - `v2.ts` `sessionCommit`: drop the `--drop-refused` loop -> "drops what the refusal names and
 *   commits the rest"; `opsToDrop` keeping every op -> the same case (nothing dropped, refused).
 * - `run.ts` `RECORD_CREATING_V1_COMMANDS`: `"memoryType": "task"` in the task hint -> "every
 *   suggested put line decodes".
 * - `head-protocol.ts` `execRequestOf` and `v2.ts` `sessionPut` leaving `runBound` out of the body
 *   -> the server leg of the matching case.
 * - `contracts/paths.ts` `placementFor`: restoring the person rule, or dropping the guard on a tag
 *   that slugs to `people` -> the two people cases in `packages/contracts/tests/paths.test.ts`.
 */

const VAR = "MEMHTML_SESSION"
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

const HARBOR = record("harbor", "harbor facts are recorded here.", ["system:fixture"])

/** A committed corpus of one labeled record on `main`, at `areas/inbox/harbor.html`. */
const corpus = async (): Promise<FixtureRepo> => {
  const repo = await run_(makeFixtureRepo())
  repos.push(repo)
  const target = join(repo.root, "areas", "inbox", "harbor.html")
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, HARBOR, "utf8")
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", "corpus"]))
  return repo
}

/** Another writer lands `html` at `path` on `main` while a session is open. */
const landOnMain = async (repo: FixtureRepo, path: string, html: string) => {
  const target = join(repo.root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, html, "utf8")
  await run_(repo.git.run(["add", "-A"]))
  await run_(repo.git.run(["commit", "-q", "-m", "other writer"]))
}

const serve = async (repo: FixtureRepo) => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  await run_(
    startHeadServer({ root: repo.root, pollMs: 0, embedder: fakeEmbedder() }).pipe(
      Scope.provide(scope)
    )
  )
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

const writeLine = (fields: Record<string, string>) =>
  `${JSON.stringify({ op: "write", type: "semantic", entity: "project:hex-bonk", ...fields })}\n`

const FACT = writeLine({ title: "Run sessions commit at run end", body: "The fact holds." })

const opsOf = async (root: string, id: string) =>
  (
    JSON.parse(await readFile(sessionStateFile(root, id), "utf8")) as {
      ops: ReadonlyArray<Body>
    }
  ).ops

describe("a run-bound session put", () => {
  for (const via of ["local", "server"] as const) {
    it(`refuses a repeated put in-turn, at exit 1, appending nothing (${via})`, async () => {
      const repo = await corpus()
      if (via === "server") await serve(repo)
      process.env[VAR] = `run-dup-${via}`
      const flags = via === "local" ? ["--no-server"] : []
      const first = await cli(repo.root, ["session", "put", "--file", "-", ...flags], FACT)
      expect(first.exitCode).toBe(EXIT_OK)
      const again = await cli(repo.root, ["session", "put", "--file", "-", ...flags], FACT)
      expect(again.exitCode).toBe(EXIT_RUNTIME)
      expect(again.body.code).toBe("ERR_INVALID_MEMORY")
      expect(String(again.body.error)).toContain("duplicate of")
      expect(String(again.body.error)).toContain("search before writing")
      expect(await opsOf(repo.root, `run-dup-${via}`)).toHaveLength(1)
    })
  }

  it("refuses a put over an active record's path in-turn", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-claim"
    const over = writeLine({
      title: "harbor",
      body: "A different harbor claim.",
      path: "areas/inbox/harbor.html",
      entity: "system:fixture"
    })
    const result = await cli(repo.root, ["session", "put", "--file", "-", "--no-server"], over)
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    expect(String(result.body.error)).toContain("claim is never edited in place")
  })

  it("holds an id spelled with --id to the run's bar when it is the variable's", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-spelled"
    await cli(repo.root, ["session", "start", "--id", "run-spelled"])
    const argv = ["session", "put", "--id", "run-spelled", "--file", "-", "--no-server"]
    expect((await cli(repo.root, argv, FACT)).exitCode).toBe(EXIT_OK)
    expect((await cli(repo.root, argv, FACT)).exitCode).toBe(EXIT_RUNTIME)
  })

  it("leaves a session outside the run to report a repeat and append it, as before", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-elsewhere"
    await cli(repo.root, ["session", "start", "--id", "manual"])
    const argv = ["session", "put", "--id", "manual", "--file", "-", "--no-server"]
    await cli(repo.root, argv, FACT)
    const again = await cli(repo.root, argv, FACT)
    expect(again.exitCode).toBe(EXIT_OK)
    const violations = dataOf(again.body).violations as ReadonlyArray<Body>
    expect(violations.map((violation) => violation.kind)).toContain("duplicate")
    expect(await opsOf(repo.root, "manual")).toHaveLength(2)
  })

  it("files a fact that names a person where its other fields send it, so the run can write it", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-person"
    const line = writeLine({
      title: "Laith reviews run sessions",
      body: "Laith approves fleet write changes.",
      entity: "person:laith"
    })
    const result = await cli(repo.root, ["session", "put", "--file", "-", "--no-server"], line)
    expect(result.exitCode).toBe(EXIT_OK)
    expect(dataOf(result.body).paths).toEqual(["areas/inbox/laith-reviews-run-sessions.html"])
  })
})

describe("a run-bound session exec", () => {
  const copy = [
    "mkdir -p /mnt/memhtml/projects/hex-bonk",
    "cat > /mnt/memhtml/projects/hex-bonk/harbor-copy.html <<'HTML'",
    HARBOR.trimEnd(),
    "HTML",
    ""
  ].join("\n")

  for (const via of ["local", "server"] as const) {
    it(`blocks a harvest that repeats a record, locally and through the head server (${via})`, async () => {
      const repo = await corpus()
      if (via === "server") await serve(repo)
      process.env[VAR] = `run-exec-${via}`
      const flags = via === "local" ? ["--no-server"] : []
      const result = await cli(repo.root, ["session", "exec", ...flags], copy)
      expect(result.exitCode).toBe(EXIT_OK)
      const report = dataOf(result.body)
      expect((report.head as Body).source).toBe(via === "server" ? "server" : "git")
      expect(report.appended).toBe(0)
      const blocking = report.blocking as ReadonlyArray<string>
      expect(blocking).toHaveLength(1)
      expect(blocking[0]).toContain("duplicate of areas/inbox/harbor.html")
    })
  }

  it("appends the same harvest in a session outside the run", async () => {
    const repo = await corpus()
    delete process.env[VAR]
    await cli(repo.root, ["session", "start", "--id", "manual-exec"])
    const result = await cli(
      repo.root,
      ["session", "exec", "--id", "manual-exec", "--no-server"],
      copy
    )
    expect(dataOf(result.body)).toMatchObject({ appended: 1 })
  })
})

describe("session commit --drop-refused", () => {
  /** A run session with two facts, then another writer lands the first one's article on main. */
  const racedRun = async (id: string) => {
    const repo = await corpus()
    process.env[VAR] = id
    const second = writeLine({ title: "Second fact", body: "The second fact holds." })
    const put = await cli(
      repo.root,
      ["session", "put", "--file", "-", "--no-server"],
      FACT + second
    )
    expect(put.exitCode).toBe(EXIT_OK)
    const [firstPath] = dataOf(put.body).paths as ReadonlyArray<string>
    const html = await run_(
      Effect.promise(() => readFile(sessionStateFile(repo.root, id), "utf8"))
    ).then((text) => ((JSON.parse(text) as { ops: ReadonlyArray<Body> }).ops[0] as Body).html)
    await landOnMain(repo, "projects/other/same-fact.html", String(html))
    const rebased = await cli(repo.root, ["session", "rebase"])
    expect(rebased.exitCode).toBe(EXIT_OK)
    return { repo, firstPath: String(firstPath) }
  }

  it("without the flag, refuses the whole session", async () => {
    const { repo } = await racedRun("run-refused")
    const before = await run_(repo.git.revParseHead())
    const result = await cli(repo.root, ["session", "commit", "--message", "run"])
    expect(dataOf(result.body)).toMatchObject({ kind: "refused", dropped: [] })
    expect(await run_(repo.git.revParseHead())).toBe(before)
  })

  it("drops what the refusal names and commits the rest", async () => {
    const { repo, firstPath } = await racedRun("run-drop")
    const result = await cli(repo.root, ["session", "commit", "--message", "run", "--drop-refused"])
    expect(result.exitCode).toBe(EXIT_OK)
    const data = dataOf(result.body)
    expect(data.kind).toBe("committed")
    const dropped = data.dropped as ReadonlyArray<Body>
    expect(dropped.map((op) => [op.kind, op.path])).toEqual([["put", firstPath]])
    expect(String((dropped[0]?.reasons as ReadonlyArray<string> | undefined)?.[0])).toContain(
      "duplicate of projects/other/same-fact.html"
    )
    const tree = await run_(repo.git.run(["ls-tree", "-r", "--name-only", "HEAD"]))
    expect(tree).toContain("areas/inbox/second-fact.html")
    expect(tree).not.toContain(firstPath)
    const trail = await readFile(
      join(repo.root, ".memhtml", "sessions", "run-drop.dropped.jsonl"),
      "utf8"
    )
    expect(
      trail
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as Body).path)
    ).toEqual([firstPath])
  })

  it("leaves nothing to commit when every op is dropped, and says so", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-all"
    await cli(repo.root, ["session", "put", "--file", "-", "--no-server"], FACT)
    const html = ((await opsOf(repo.root, "run-all"))[0] as Body).html
    await landOnMain(repo, "projects/other/same-fact.html", String(html))
    await cli(repo.root, ["session", "rebase"])
    const before = await run_(repo.git.revParseHead())
    const result = await cli(repo.root, ["session", "commit", "--message", "run", "--drop-refused"])
    const data = dataOf(result.body)
    expect(data.kind).toBe("refused")
    expect((data.dropped as ReadonlyArray<Body>).map((op) => op.kind)).toEqual(["put"])
    expect(await opsOf(repo.root, "run-all")).toHaveLength(0)
    expect(await run_(repo.git.revParseHead())).toBe(before)
  })
})

describe("ERR_SESSION_BOUND suggestions", () => {
  const PUT_LINE = /^printf '%s\\n' '(.*)' \| memhtml session put --file -$/

  it("every suggested put line decodes with the decoder session put runs", () => {
    for (const [command, { suggestions }] of RECORD_CREATING_V1_COMMANDS) {
      const lines = suggestions.flatMap((line) => {
        const match = PUT_LINE.exec(line)
        return match?.[1] === undefined ? [] : [match[1]]
      })
      expect(lines.length, command).toBeGreaterThan(0)
      for (const line of lines) {
        const decoded = decodeSessionPut(line)
        expect(decoded.ok, `${command}: ${line}`).toBe(true)
      }
      // Every suggestion is either a runnable put line or a plain memhtml command.
      for (const line of suggestions) {
        expect(PUT_LINE.test(line) || /^memhtml [a-z]/.test(line), line).toBe(true)
      }
    }
  })

  it("the task hint's line decodes as a task", () => {
    const hint = RECORD_CREATING_V1_COMMANDS.get("task add")?.suggestions[0] ?? ""
    const decoded = decodeSessionPut(PUT_LINE.exec(hint)?.[1] ?? "")
    expect(decoded.ok).toBe(true)
    if (decoded.ok)
      expect(decoded.ops[0]).toMatchObject({ op: "write", params: { memoryType: "task" } })
  })

  it("the refusal carries the map's suggestions", () => {
    process.env[VAR] = "run-hint"
    for (const [command, { suggestions }] of RECORD_CREATING_V1_COMMANDS) {
      const argv = command === "task add" ? ["task", "add"] : [command]
      const failure = validate(parseArgv(argv))
      expect(failure?.suggestions.slice(0, suggestions.length), command).toEqual(suggestions)
    }
  })

  it("the task hint's line lands in a run session as written", async () => {
    const repo = await corpus()
    process.env[VAR] = "run-hint-land"
    const hint = RECORD_CREATING_V1_COMMANDS.get("task add")?.suggestions[0] ?? ""
    const line = `${PUT_LINE.exec(hint)?.[1] ?? ""}\n`
    const result = await cli(repo.root, ["session", "put", "--file", "-", "--no-server"], line)
    expect(result.exitCode, JSON.stringify(result.body)).toBe(EXIT_OK)
  })
})

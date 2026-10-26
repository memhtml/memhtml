import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { sessionStateFile } from "@memhtml/session"
import { type FixtureRepo, makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterAll, afterEach, describe, expect, it } from "vitest"

import { COMMANDS } from "../src/commands.js"
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, RESPONSE_TYPES } from "../src/envelope.js"
import { parseArgv, run, validate } from "../src/run.js"

/**
 * The usage guards `run.ts` adds for the v2 commands (`docs/design.md` §15, "The command
 * families"). Every case here is exit 2 and never touches a repo: the point of a guard in
 * `validate` is that a wrong call is refused before any service is built, and a refusal raised any
 * later would be masked as exit 1.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - drop the `headSnapshotFlags(parsed)` call from `validateAgainst` -> "head snapshot takes exactly
 *   one of --write / --read" (both arms).
 * - `SCRIPT_COMMANDS` back to `["exec"]` -> "session exec takes at most one script door".
 * - drop the `sessionIdFlag(parsed)` call from `validate` -> "a session id is one path segment"
 *   (the traversal case answers undefined instead of exit 2).
 * - drop the blank-script check in the v2 branch of `run` -> "session exec refuses a blank script".
 * - drop the `curateMergeFlags(parsed)` call from `validateAgainst` -> "curate merge refuses landing
 *   a branch on itself" and "curate merge refuses a blank --into".
 */

const parse = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** A directory that is NOT a repo. Named on the line so the refuse-env-root pin never fires. */
const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "memhtml-v2-cli-"))
  roots.push(root)
  return root
}

describe("the v2 command table", () => {
  const V2 = [
    "session start",
    "session put",
    "session exec",
    "session commit",
    "session rebase",
    "session status",
    "head status",
    "head search",
    "head snapshot",
    "head embed",
    "head serve",
    "curate merge",
    "curate run",
    "path"
  ]

  it("declares every v2 command with at least one example and a response type the envelope knows", () => {
    const known = new Set<string>(RESPONSE_TYPES)
    for (const name of V2) {
      const spec = COMMANDS.find((command) => command.name === name)
      expect(spec, name).toBeDefined()
      expect(spec?.examples?.length ?? 0, name).toBeGreaterThan(0)
      for (const type of spec?.responseTypes ?? []) expect(known.has(type), type).toBe(true)
    }
  })

  it("requires --id on every session command, as a missing-argument usage error", () => {
    for (const name of V2.filter((command) => command.startsWith("session "))) {
      const failure = validate(parseArgv(name.split(" ")))
      expect(failure?.code, name).toBe("ERR_MISSING_ARGUMENT")
      expect(failure?.error, name).toContain("--id")
    }
  })
})

describe("head snapshot takes exactly one of --write / --read", () => {
  it("refuses neither, naming both spellings", () => {
    const failure = validate(parseArgv(["head", "snapshot"]))
    expect(failure?.code).toBe("ERR_MISSING_ARGUMENT")
    expect(failure?.suggestions).toContain("memhtml head snapshot --write")
    expect(failure?.suggestions).toContain("memhtml head snapshot --read")
  })

  it("refuses both, so a call cannot both build the cache and report it", () => {
    const failure = validate(parseArgv(["head", "snapshot", "--write", "--read"]))
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
  })

  it("accepts each alone", () => {
    expect(validate(parseArgv(["head", "snapshot", "--write"]))).toBeUndefined()
    expect(validate(parseArgv(["head", "snapshot", "--read"]))).toBeUndefined()
  })
})

describe("session exec takes at most one script door and a bounded timeout", () => {
  it("refuses --file beside --script", () => {
    const failure = validate(
      parseArgv(["session", "exec", "--id", "s1", "--file", "a.mjs", "--script", "1"])
    )
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
    expect(failure?.error).toContain("session exec")
    // The suggestions name THIS command, not `exec`, so a copied line lands on the right table.
    for (const suggestion of failure?.suggestions ?? []) {
      expect(suggestion).not.toMatch(/memhtml exec /)
    }
  })

  it("refuses a non-positive or over-cap --timeout-ms", () => {
    for (const value of ["0", "-5", "600001", "soon"]) {
      const failure = validate(
        parseArgv(["session", "exec", "--id", "s1", "--script", "1", "--timeout-ms", value])
      )
      expect(failure?.code, value).toBe("ERR_INVALID_FLAG")
    }
  })

  it("refuses a blank script at exit 2 before any repo is opened", async () => {
    const root = await scratch()
    const result = await run(["session", "exec", "--id", "s1", "--script", "   ", "--repo", root])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).code).toBe("ERR_MISSING_ARGUMENT")
  })
})

describe("session put judges the whole op stream before any service is built", () => {
  it("refuses a malformed line at exit 2 naming the line, with nothing opened", async () => {
    const root = await scratch()
    const file = join(root, "ops.jsonl")
    await writeFile(
      file,
      `${JSON.stringify({ op: "write", title: "ok", type: "semantic", body: "Fine." })}\n{not json\n`
    )
    const result = await run(["session", "put", "--id", "s1", "--file", file, "--repo", root])
    expect(result.exitCode).toBe(EXIT_USAGE)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(body.error).toContain("line 2")
  })

  it("refuses an unreadable --file at exit 2", async () => {
    const root = await scratch()
    const result = await run([
      "session",
      "put",
      "--id",
      "s1",
      "--file",
      join(root, "absent.jsonl"),
      "--repo",
      root
    ])
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(parse(result.stdout).code).toBe("ERR_PATH_NOT_FOUND")
  })
})

describe("a session id is one path segment, judged before any repo opens", () => {
  it("refuses a traversal or malformed id at exit 2 on every session command", () => {
    // Each command's other required flags are supplied, so the id rule is the only thing judged.
    const REST: Record<string, ReadonlyArray<string>> = {
      start: [],
      put: ["--file", "ops.jsonl"],
      exec: ["--script", "1"],
      commit: ["--message", "m"],
      rebase: [],
      status: []
    }
    for (const [command, rest] of Object.entries(REST)) {
      for (const bad of ["../evil", "a/b", ".hidden", "x".repeat(129)]) {
        const failure = validate(parseArgv(["session", command, "--id", bad, ...rest]))
        expect(failure, `${command} ${JSON.stringify(bad)}`).toBeDefined()
        expect(failure?.code, `${command} ${JSON.stringify(bad)}`).toBe("ERR_INVALID_FLAG")
        expect(failure?.suggestions[0]).toContain("memhtml session start --id s1")
      }
    }
  })

  it("passes a plain id through to the command", () => {
    expect(validate(parseArgv(["session", "status", "--id", "curate-2026-09-23"]))).toBeUndefined()
  })
})

describe("curate merge takes one ref and lands it somewhere else", () => {
  it("requires the ref positional, as a missing-argument usage error", () => {
    const failure = validate(parseArgv(["curate", "merge"]))
    expect(failure?.code).toBe("ERR_MISSING_ARGUMENT")
    expect(failure?.error).toContain("ref")
  })

  it("refuses landing a branch on itself, under either spelling of the name", () => {
    for (const argv of [
      ["curate", "merge", "main"],
      ["curate", "merge", "refs/heads/main"],
      ["curate", "merge", "curate/x", "--into", "refs/heads/curate/x"],
      ["curate", "merge", "refs/heads/curate/x", "--into", "curate/x"]
    ]) {
      const failure = validate(parseArgv(argv))
      expect(failure?.code, argv.join(" ")).toBe("ERR_INVALID_FLAG")
      expect(failure?.error, argv.join(" ")).toContain("on itself")
    }
  })

  it("refuses a blank --into", () => {
    const failure = validate(parseArgv(["curate", "merge", "curate/x", "--into", "  "]))
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
    expect(failure?.error).toContain("--into")
  })

  it("refuses a value-shaped token after --skip-gate, which is boolean", () => {
    const failure = validate(parseArgv(["curate", "merge", "curate/x", "--skip-gate", "true"]))
    expect(failure?.code).toBe("ERR_INVALID_FLAG")
    expect(failure?.suggestions).toContain("memhtml curate merge --skip-gate=true")
  })

  it("refuses a second positional", () => {
    const failure = validate(parseArgv(["curate", "merge", "curate/x", "curate/y"]))
    expect(failure?.code).toBe("ERR_UNEXPECTED_ARGUMENT")
  })

  it("accepts a bare branch, a full ref, --into, and --skip-gate", () => {
    expect(validate(parseArgv(["curate", "merge", "curate/2026-09-23"]))).toBeUndefined()
    expect(
      validate(parseArgv(["curate", "merge", "refs/heads/curate/2026-09-23", "--into", "main"]))
    ).toBeUndefined()
    expect(validate(parseArgv(["curate", "merge", "curate/x", "--skip-gate"]))).toBeUndefined()
  })

  it("refuses a ref that does not exist at exit 1 with ERR_INVALID_MEMORY once a repo is open", async () => {
    const root = await scratch()
    const git = (...args: ReadonlyArray<string>) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", root, ...args], (error) => (error ? reject(error) : resolve()))
      })
    await git("init", "-q", "-b", "main", ".")
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "seed"
    )
    const result = await run(["curate", "merge", "curate/absent", "--skip-gate", "--repo", root])
    expect(result.exitCode).toBe(EXIT_RUNTIME)
    const body = parse(result.stdout)
    expect(body.code).toBe("ERR_INVALID_MEMORY")
    expect(body.error).toContain("refs/heads/curate/absent")
  })
})

describe("sessionScopeOf names the scope a session is judged under from its ref", () => {
  it("is curate for a ref under refs/heads/curate/ and session for every other ref", async () => {
    const { sessionScopeOf } = await import("../src/v2.js")
    expect(sessionScopeOf("refs/heads/curate/2026-09-28-collapse")).toBe("curate")
    expect(sessionScopeOf("refs/heads/main")).toBe("session")
    expect(sessionScopeOf("refs/heads/curated")).toBe("session")
    expect(sessionScopeOf("refs/tags/curate/x")).toBe("session")
  })
})

/**
 * The two read-only answers to "where would this write land": `memhtml path` over the version at
 * HEAD, and `session put --dry-run` over a session's view. Both run the placement a put runs
 * (`putPathFor` in `v2.ts`), so a caller can learn the path, and the collision ordinal it took,
 * before anything is appended or committed. Every case checks that nothing under the root moved.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `v2.ts` `pathPreview`: pass an empty set instead of the `--claimed` paths -> "steps past the
 *   paths --claimed names" (answers `-2`, which the claimed file holds).
 * - `v2.ts` `sessionPut`: append under `--dry-run` -> "places each put as the real put would" (the
 *   log gains the put).
 * - `v2.ts` `sessionPut`: start the session under `--dry-run` -> "starts no session" (the log exists).
 */
describe("memhtml path and session put --dry-run preview a write's path, writing nothing", () => {
  const AT = "2031-03-01T12:00:00Z"
  const run_ = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
  const repos: Array<FixtureRepo> = []
  const SESSION_VAR = "MEMHTML_SESSION"
  /** Puts `MEMHTML_SESSION` back as the case found it, when the case set it. */
  let restoreSession: (() => void) | undefined
  afterEach(async () => {
    restoreSession?.()
    restoreSession = undefined
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  /** A committed head holding `areas/inbox/a-fact.html` and `projects/acme-widget/a-fact.html`. */
  const corpus = async (): Promise<FixtureRepo> => {
    const repo = await run_(makeFixtureRepo())
    repos.push(repo)
    for (const [path, claim] of [
      ["areas/inbox/a-fact.html", "The inbox fact is recorded here."],
      ["projects/acme-widget/a-fact.html", "The acme-widget fact is recorded here."]
    ] as const) {
      const target = join(repo.root, path)
      await mkdir(dirname(target), { recursive: true })
      const html = renderTemplate({
        title: "A fact",
        claim,
        memoryType: "semantic",
        at: AT,
        entities: ["project:acme-widget"]
      })
      await writeFile(target, html, "utf8")
    }
    await run_(repo.git.run(["add", "-A"]))
    await run_(repo.git.run(["commit", "-q", "-m", "corpus"]))
    return repo
  }

  /**
   * Everything a write could leave: every file under the root outside `.git/` with its size and
   * mtime, every ref, and the status git reports with ignored files listed.
   */
  const stateOf = async (repo: FixtureRepo): Promise<string> => {
    const files: Array<string> = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        const rel = full.slice(repo.root.length + 1)
        if (rel === ".git") continue
        if (entry.isDirectory()) {
          files.push(`${rel}/`)
          await walk(full)
        } else {
          const info = await stat(full)
          files.push(`${rel} ${String(info.size)} ${String(info.mtimeMs)}`)
        }
      }
    }
    await walk(repo.root)
    const refs = await run_(repo.git.run(["for-each-ref", "--format=%(refname) %(objectname)"]))
    const status = await run_(repo.git.run(["status", "--porcelain", "--ignored"]))
    return [...files.sort(), refs, status].join("\n")
  }

  type Body = Record<string, unknown>
  const cli = async (repo: FixtureRepo, argv: ReadonlyArray<string>) => {
    const result = await run([...argv, "--repo", repo.root], undefined, undefined, false)
    return { exitCode: result.exitCode, body: parse(result.stdout) as Body }
  }
  const data = async (repo: FixtureRepo, argv: ReadonlyArray<string>): Promise<Body> => {
    const { exitCode, body } = await cli(repo, argv)
    expect(exitCode, JSON.stringify(body)).toBe(EXIT_OK)
    return body.data as Body
  }

  const opsFile = async (lines: ReadonlyArray<Record<string, unknown>>): Promise<string> => {
    const file = join(await scratch(), "ops.jsonl")
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8")
    return file
  }

  const aFact = { op: "write", title: "A fact", type: "semantic", body: "A second fact." }

  it("steps past a path the head holds, with the ordinal it took", async () => {
    const repo = await corpus()
    const before = await stateOf(repo)
    const { exitCode, body } = await cli(repo, ["path", "--title", "A fact", "--type", "semantic"])
    expect(exitCode, JSON.stringify(body)).toBe(EXIT_OK)
    expect(body.type).toBe("memory.path")
    const answer = body.data as Body
    expect(answer.path).toBe("areas/inbox/a-fact-2.html")
    expect(answer.ordinal).toBe(2)
    expect(answer.occupied).toBe(false)
    expect((answer.head as Body).sha).toBe(await run_(repo.git.revParseHead()))
    expect(await stateOf(repo)).toBe(before)
  })

  it("steps past the paths --claimed names as it steps past the head's", async () => {
    const repo = await corpus()
    const claimed = join(await scratch(), "claimed.txt")
    await writeFile(claimed, "areas/inbox/a-fact-2.html\n\n/areas/inbox/a-fact-4.html\n", "utf8")
    const before = await stateOf(repo)
    const answer = await data(repo, [
      "path",
      "--title",
      "A fact",
      "--type",
      "semantic",
      "--claimed",
      claimed
    ])
    expect(answer.path).toBe("areas/inbox/a-fact-3.html")
    expect(answer.ordinal).toBe(3)
    expect(answer.claimed).toBe(2)
    expect(await stateOf(repo)).toBe(before)
  })

  it("routes by type, workspace and tag the way a write line does", async () => {
    const repo = await corpus()
    const before = await stateOf(repo)
    const inWorkspace = await data(repo, [
      "path",
      ...["--title", "A fact", "--type", "semantic", "--workspace", "acme-widget"]
    ])
    expect(inWorkspace).toMatchObject({ path: "projects/acme-widget/a-fact-2.html", ordinal: 2 })
    const tagged = await data(repo, [
      "path",
      ...["--title", "A fact", "--type", "procedural", "--tag", "acme-widget", "--tag", "other"]
    ])
    expect(tagged).toMatchObject({ path: "resources/acme-widget/a-fact.html", ordinal: 1 })
    const task = await data(repo, [
      "path",
      ...["--title", "A fact", "--type", "task", "--workspace", "acme-widget"]
    ])
    expect(task).toMatchObject({ path: "projects/acme-widget/tasks/a-fact.html", ordinal: 1 })
    const episodic = await data(repo, ["path", "--title", "A fact", "--type", "episodic"])
    expect(String(episodic.path)).toMatch(/^areas\/inbox\/\d{8}-a-fact\.html$/)
    expect(await stateOf(repo)).toBe(before)
  })

  it("answers a usable explicit path as given, with no ordinal, and says when it is held", async () => {
    const repo = await corpus()
    const held = await data(repo, [
      "path",
      ...["--title", "Another", "--type", "semantic", "--path", "areas/inbox/a-fact.html"]
    ])
    expect(held).toMatchObject({ path: "areas/inbox/a-fact.html", ordinal: null, occupied: true })
    const free = await data(repo, [
      "path",
      ...["--title", "Another", "--type", "semantic", "--path", "/areas/inbox/elsewhere.html"]
    ])
    expect(free).toMatchObject({
      path: "areas/inbox/elsewhere.html",
      ordinal: null,
      occupied: false
    })
    // An unusable path is ignored and the path derived, as a put derives it.
    const ignored = await data(repo, [
      "path",
      ...["--title", "A fact", "--type", "semantic", "--path", "nowhere/a-fact.html"]
    ])
    expect(ignored).toMatchObject({ path: "areas/inbox/a-fact-2.html", ordinal: 2 })
  })

  it("refuses a --claimed line that is not a memory path at exit 2, naming the line", async () => {
    const repo = await corpus()
    const claimed = join(await scratch(), "claimed.txt")
    await writeFile(claimed, `areas/inbox/a-fact-2.html\n${JSON.stringify(aFact)}\n`, "utf8")
    const before = await stateOf(repo)
    const { exitCode, body } = await cli(repo, [
      "path",
      ...["--title", "A fact", "--type", "semantic", "--claimed", claimed]
    ])
    expect(exitCode).toBe(EXIT_USAGE)
    expect(body.code).toBe("ERR_INVALID_FLAG")
    expect(String(body.error)).toContain("line 2")
    const missing = await cli(repo, [
      "path",
      ...["--title", "A fact", "--type", "semantic", "--claimed", join(claimed, "absent")]
    ])
    expect(missing.exitCode).toBe(EXIT_USAGE)
    expect(missing.body.code).toBe("ERR_PATH_NOT_FOUND")
    expect(await stateOf(repo)).toBe(before)
  })

  it("requires --title and --type before any repo opens", () => {
    expect(validate(parseArgv(["path", "--type", "semantic"]))?.code).toBe("ERR_MISSING_ARGUMENT")
    expect(validate(parseArgv(["path", "--title", "A fact"]))?.code).toBe("ERR_MISSING_ARGUMENT")
    expect(validate(parseArgv(["path", "--title", "A fact", "--type", "nonsense"]))?.code).toBe(
      "ERR_INVALID_FLAG"
    )
    expect(validate(parseArgv(["path", "--title", "  ", "--type", "semantic"]))?.code).toBe(
      "ERR_INVALID_FLAG"
    )
    expect(validate(parseArgv(["path", "--title", "A fact", "--type", "semantic"]))).toBeUndefined()
  })

  it("places each put as the real put would, and leaves the log as it was", async () => {
    const repo = await corpus()
    await data(repo, ["session", "start", "--id", "s1"])
    const log = await readFile(sessionStateFile(repo.root, "s1"), "utf8")
    const file = await opsFile([aFact, { ...aFact, body: "A third fact." }])
    const before = await stateOf(repo)
    const preview = await data(repo, [
      "session",
      ...["put", "--id", "s1", "--file", file, "--no-server", "--dry-run"]
    ])
    expect(preview.dryRun).toBe(true)
    expect(preview.appended).toBe(0)
    expect(preview.ops).toBe(0)
    expect(preview.paths).toEqual(["areas/inbox/a-fact-2.html", "areas/inbox/a-fact-3.html"])
    expect(preview.placements).toEqual([
      { path: "areas/inbox/a-fact-2.html", ordinal: 2 },
      { path: "areas/inbox/a-fact-3.html", ordinal: 3 }
    ])
    expect(await readFile(sessionStateFile(repo.root, "s1"), "utf8")).toBe(log)
    expect(await stateOf(repo)).toBe(before)

    // The put itself lands where the dry run said, and `memhtml path` agrees for one line.
    const put = await data(repo, ["session", "put", "--id", "s1", "--file", file, "--no-server"])
    expect(put.dryRun).toBe(false)
    expect(put.paths).toEqual(preview.paths)
    expect(put.placements).toEqual(preview.placements)
    const single = await data(repo, ["path", "--title", "A fact", "--type", "semantic"])
    expect(single.path).toBe("areas/inbox/a-fact-2.html")
  })

  it("starts no session when a dry run is the first use of MEMHTML_SESSION", async () => {
    const repo = await corpus()
    const saved = process.env[SESSION_VAR]
    restoreSession = () => {
      if (saved === undefined) delete process.env[SESSION_VAR]
      else process.env[SESSION_VAR] = saved
    }
    process.env[SESSION_VAR] = "run-1"
    const file = await opsFile([aFact])
    const before = await stateOf(repo)
    const preview = await data(repo, ["session", "put", "--file", file, "--no-server", "--dry-run"])
    expect(preview).toMatchObject({ dryRun: true, started: false, appended: 0, ops: 0 })
    expect(preview.paths).toEqual(["areas/inbox/a-fact-2.html"])
    await expect(access(sessionStateFile(repo.root, "run-1"))).rejects.toThrow()
    expect(await stateOf(repo)).toBe(before)
  })
})

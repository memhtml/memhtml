import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { renderTemplate } from "@memhtml/html"
import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterAll, describe, expect, it } from "vitest"

import { COMMANDS } from "../src/commands.js"
import { EXIT_RUNTIME, EXIT_USAGE, RESPONSE_TYPES } from "../src/envelope.js"
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
    "curate run"
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

describe("a put beside a held archive slot", () => {
  it("keeps the put's derived path, and its later archive takes the next generation of the year", async () => {
    // The head holds an archived record at the slot `areas/inbox/a-fact.html` mirrors, and nothing
    // live at that path. The put lands there, and archiving it later writes `archive/<YYYY>.2/`,
    // leaving the older record in its slot. Mutation: `stageArchive` back to `archivePathFor` ->
    // the archive fails with ERR_GIT (`destination exists`) and the record stays live.
    const repo = await Effect.runPromise(makeFixtureRepo())
    const root = repo.root
    roots.push(root)
    const year = String(new Date().getUTCFullYear())
    const path = "areas/inbox/a-fact.html"
    const heldSlot = `archive/${year}/${path}`
    const older = renderTemplate({
      title: "A fact",
      claim: "The acme widget build caches to a shared directory.",
      memoryType: "semantic",
      at: "2031-03-01T12:00:00Z",
      entities: ["system:memhtml"]
    }).replace('content="active"', 'content="archived"')
    await mkdir(dirname(join(root, heldSlot)), { recursive: true })
    await writeFile(join(root, heldSlot), older, "utf8")
    await Effect.runPromise(repo.git.run(["add", "-A"]))
    await Effect.runPromise(repo.git.run(["commit", "-q", "-m", "held slot"]))

    const cli = async (argv: ReadonlyArray<string>) => {
      const result = await run([...argv, "--repo", root], undefined, undefined, false)
      const body = parse(result.stdout)
      expect(result.exitCode, result.stdout).toBe(0)
      return body.data as Record<string, unknown>
    }
    const ops = join(await scratch(), "ops.jsonl")
    await writeFile(
      ops,
      `${JSON.stringify({
        op: "write",
        title: "A fact",
        type: "semantic",
        body: "The acme widget build caches to a per-user directory.",
        entity: "system:memhtml"
      })}\n`,
      "utf8"
    )
    await cli(["session", "start", "--id", "held-slot"])
    await cli(["session", "put", "--id", "held-slot", "--file", ops, "--no-server"])
    const landed = await cli([
      "session",
      "commit",
      "--id",
      "held-slot",
      "--message",
      "a fact",
      "--no-server"
    ])
    expect(landed.kind).toBe("committed")
    expect(landed.paths).toEqual([path])

    const archived = await cli(["archive", path, "--reason", "evicted"])
    expect(archived.archivePath).toBe(`archive/${year}.2/${path}`)
    const tree = await Effect.runPromise(repo.git.run(["ls-tree", "-r", "--name-only", "HEAD"]))
    const files = tree.split("\n").filter((line) => line.endsWith(".html"))
    expect(files).toContain(heldSlot)
    expect(files).toContain(`archive/${year}.2/${path}`)
    expect(files).not.toContain(path)
    expect(await Effect.runPromise(repo.git.run(["show", `HEAD:${heldSlot}`]))).toBe(older)
  })
})

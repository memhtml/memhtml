import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { COMMANDS } from "../src/commands.js"
import { EXIT_USAGE, RESPONSE_TYPES } from "../src/envelope.js"
import { parseArgv, run, validate } from "../src/run.js"

/**
 * The usage guards `run.ts` adds for the v2 commands (`docs/v2-poc.md`, "CLI commands"). Every case
 * here is exit 2 and never touches a repo: the point of a guard in `validate` is that a wrong call is
 * refused before any service is built, and a refusal raised any later would be masked as exit 1.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - drop the `headSnapshotFlags(parsed)` call from `validateAgainst` -> "head snapshot takes exactly
 *   one of --write / --read" (both arms).
 * - `SCRIPT_COMMANDS` back to `["exec"]` -> "session exec takes at most one script door".
 * - drop the blank-script check in the v2 branch of `run` -> "session exec refuses a blank script".
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
    "head snapshot"
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

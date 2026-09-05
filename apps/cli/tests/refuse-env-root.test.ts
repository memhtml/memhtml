import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeFixtureRepo } from "@memhtml/store/testing"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CONFIG_VARS } from "../src/config.js"
import { ERROR_CODES, EXIT_OK, EXIT_USAGE } from "../src/envelope.js"
import { USAGE_ERROR_CODES } from "../src/help.js"
import { run } from "../src/run.js"
import { makeCli } from "./harness.js"

/**
 * `MEMHTML_REFUSE_ENV_ROOT` (issue #144): with it set, `run()` takes its repo from `--repo` or from an
 * injected layer and from nowhere else. `MEMHTML_ROOT` and the `~/memhtml` default stop being doors.
 *
 * The variable and the code are spelled as literals here rather than imported, so the suite is also
 * the census: a rename of either constant fails the declaration test below instead of following it.
 */
const VAR = "MEMHTML_REFUSE_ENV_ROOT"
const CODE = "ERR_REPO_REQUIRED"

/** The repo root, three levels up from this file: `apps/cli/tests` to the workspace. */
const REPO_ROOT = new URL("../../..", import.meta.url).pathname

const parse = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>

/** stdout is a pipe: what a test runner, a shell pipeline, and an agent all are. */
const piped = (argv: ReadonlyArray<string>) => run(argv, undefined, undefined, false)

describe("MEMHTML_REFUSE_ENV_ROOT", () => {
  let parent = ""
  let envRoot = ""
  let savedRoot: string | undefined
  let savedFlag: string | undefined

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "memhtml-refuse-"))
    envRoot = join(parent, "never-created")
    savedRoot = process.env.MEMHTML_ROOT
    savedFlag = process.env[VAR]
    process.env.MEMHTML_ROOT = envRoot
    process.env[VAR] = "1"
  })

  afterEach(async () => {
    if (savedRoot === undefined) delete process.env.MEMHTML_ROOT
    else process.env.MEMHTML_ROOT = savedRoot
    if (savedFlag === undefined) delete process.env[VAR]
    else process.env[VAR] = savedFlag
    await rm(parent, { recursive: true, force: true })
  })

  it("refuses `status` without --repo as ERR_REPO_REQUIRED, exit 2, and creates nothing", async () => {
    const result = await piped(["status"])
    const body = parse(result.stdout)
    expect(body.code).toBe(CODE)
    expect(result.exitCode).toBe(EXIT_USAGE)
    expect(body.error).toContain(VAR)
    // The recovery is the flag spelling, and the refusal ends with the command's help like every
    // other usage error of a known command.
    expect(body.suggestions).toEqual(["memhtml status --repo <path>", "memhtml help status"])
    await expect(access(envRoot)).rejects.toThrow()
  })

  it("refuses every arm that resolves a root from the environment: init, a write, serve mcp, exec", async () => {
    /**
     * Three resolution sites, one guard. `init` and `write` go through the app layer; `serve mcp`
     * and `exec` read the configured root themselves without a layer. A guard on one site alone
     * would leave the others as the door the incident walked through.
     */
    for (const argv of [
      ["init"],
      ["write", "--title", "x", "--claim", "y", "--type", "arc"],
      ["serve", "mcp"],
      ["exec", "--script", "console.log(1)"]
    ]) {
      const result = await piped(argv)
      expect(parse(result.stdout).code, argv.join(" ")).toBe(CODE)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_USAGE)
    }
    await expect(access(envRoot)).rejects.toThrow()
  })

  it("fails closed: every value but 0, false, no, off, and blank refuses, case-insensitively", async () => {
    for (const value of ["1", "true", "ON", " yes ", "y", "enabled"]) {
      process.env[VAR] = value
      expect(parse((await piped(["status"])).stdout).code, JSON.stringify(value)).toBe(CODE)
    }
    await expect(access(envRoot)).rejects.toThrow()
    // The five off spellings leave the door open: the call reaches the layer, which opens the
    // (non-git) env root and fails there with a code that is not the refusal's. The root is a
    // throwaway under the temp dir, removed by afterEach.
    for (const value of ["0", "false", "NO", " off ", ""]) {
      process.env[VAR] = value
      expect(parse((await piped(["status"])).stdout).code, JSON.stringify(value)).not.toBe(CODE)
    }
    await expect(access(envRoot)).resolves.toBeUndefined()
  })

  it("still answers with --repo <path>", async () => {
    const fixture = await Effect.runPromise(makeFixtureRepo())
    try {
      const result = await piped(["status", "--repo", fixture.root])
      expect(result.exitCode).toBe(EXIT_OK)
      expect(parse(result.stdout).type).toBe("status.health")
    } finally {
      await fixture.cleanup()
    }
    await expect(access(envRoot)).rejects.toThrow()
  })

  it("still answers with an injected layer, with and without --repo on the line", async () => {
    const cli = await makeCli()
    try {
      // The harness threads `--repo`; the second call drops it so the layer alone is the door.
      expect((await cli.run(["status"])).exitCode).toBe(EXIT_OK)
      const bare = await run(["status"], cli.layer, undefined, false)
      expect(bare.exitCode).toBe(EXIT_OK)
      expect(parse(bare.stdout).type).toBe("status.health")
    } finally {
      await cli.cleanup()
    }
    await expect(access(envRoot)).rejects.toThrow()
  })

  it("leaves the commands that never open a repo alone: manifest, help, agents-doc, eval discriminate", async () => {
    for (const [argv, type] of [
      [["manifest"], "cli.manifest"],
      [["help", "search"], "cli.help"],
      [["search", "--help"], "cli.help"],
      [["agents-doc", "--check", "--out", join(REPO_ROOT, "AGENTS.md")], "agents.doc"],
      [
        ["eval", "discriminate", "--size", "20", "--probes", "2", "--mrr-floor", "0"],
        "eval.discrimination"
      ]
    ] as ReadonlyArray<readonly [ReadonlyArray<string>, string]>) {
      const result = await piped(argv)
      expect(result.exitCode, argv.join(" ")).toBe(EXIT_OK)
      expect(parse(result.stdout).type, argv.join(" ")).toBe(type)
    }
    await expect(access(envRoot)).rejects.toThrow()
  }, 120_000)

  it("is declared for the manifest, and its code is a usage code the envelope knows", () => {
    expect(CONFIG_VARS.some((variable) => variable.name === VAR)).toBe(true)
    expect(ERROR_CODES).toContain(CODE)
    expect(USAGE_ERROR_CODES).toContain(CODE)
  })
})

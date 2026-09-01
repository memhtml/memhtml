import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  PARENT_PID_ENV,
  parentTetherUrl,
  tetherEnv,
  tetheredNodeArgs
} from "../src/child-tether.js"

/**
 * The parent tether (issue #100): a spawned eve child must die with the process that spawned it,
 * on the one path no Effect finalizer can cover — the parent SIGKILLed.
 *
 * This tier drives REAL PROCESS TREES rather than the tether's arithmetic, because the defect lives
 * in kernel behavior no fake reproduces: reparenting on parent death, signal default actions, and
 * the difference between a poll that observes `process.ppid` and one that observes a value somebody
 * wrote down. The "child" is a plain node script standing in for `eve start` — what is under test is
 * the tether riding in front of the entry, which never inspects what the entry is.
 *
 * The FIRST case is the reproduction: it asserts the defect's shape (an untethered child survives
 * its parent's SIGKILL), so the fix's cases cannot pass vacuously against a harness that kills the
 * whole tree by accident. Reverting the tether wiring fails the tethered cases and leaves this one
 * green, which is the direction that proves the guard fires.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Whether a pid is currently alive, by the zero signal. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms))

/** Poll until `check` holds, or fail with `label` when the deadline passes. */
const waitFor = async (check: () => boolean, deadlineMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}

/**
 * A long-lived stand-in for the eve child. `KEEPALIVE` holds the event loop; the SIGTERM handler is
 * optional so one script covers both the cooperative child and the stubborn one the backstop exists
 * for. It prints nothing — the intermediary reports its pid.
 */
const serverSource = (ignoreSigterm: boolean): string =>
  [ignoreSigterm ? 'process.on("SIGTERM", () => {})' : "", "setInterval(() => {}, 1000)", ""].join(
    "\n"
  )

/**
 * The intermediary playing the memhtml client: it spawns the "server", prints the server's pid, and
 * stays alive until the test SIGKILLs it. It has to be a separate process — the tether fires on the
 * SPAWNER's death, and the test runner is not something a test can kill.
 *
 * With `TETHER=1` it spawns exactly the argv and environment `src/client.ts` composes:
 * `tetheredNodeArgs` plus `tetherEnv()`, resolved inside the intermediary so the stamped pid is the
 * intermediary's own.
 */
const clientSource = (tetherUrl: string): string =>
  [
    'import { spawn } from "node:child_process"',
    "const [serverScript, withTether] = process.argv.slice(2)",
    'const args = withTether === "1"',
    `  ? ["--import", ${JSON.stringify(tetherUrl)}, serverScript]`,
    "  : [serverScript]",
    "const env = { ...process.env }",
    'if (withTether === "1") env.MEMHTML_CONSOLIDATOR_PARENT_PID = String(process.pid)',
    'const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "inherit"], env })',
    "console.log('server-pid:' + String(child.pid))",
    "setInterval(() => {}, 1000)",
    ""
  ].join("\n")

interface Tree {
  readonly clientPid: number
  readonly serverPid: number
}

let fixtureDir = ""
const leftover: number[] = []

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "memhtml-tether-test-"))
  await writeFile(join(fixtureDir, "server.mjs"), serverSource(false))
  await writeFile(join(fixtureDir, "stubborn.mjs"), serverSource(true))
  await writeFile(join(fixtureDir, "client.mjs"), clientSource(parentTetherUrl()))
})

afterAll(async () => {
  for (const pid of leftover) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone, which is what the tests wanted
    }
  }
  await rm(fixtureDir, { recursive: true, force: true })
})

/** Spawn the client intermediary and read back both pids. */
const spawnTree = async (server: string, withTether: boolean): Promise<Tree> => {
  const client = spawn(
    process.execPath,
    [join(fixtureDir, "client.mjs"), join(fixtureDir, server), withTether ? "1" : "0"],
    { stdio: ["ignore", "pipe", "inherit"] }
  )
  const clientPid = client.pid
  if (clientPid === undefined) throw new Error("the client intermediary did not spawn")
  leftover.push(clientPid)
  const serverPid = await new Promise<number>((settle, reject) => {
    let out = ""
    client.stdout.setEncoding("utf8")
    client.stdout.on("data", (chunk: string) => {
      out += chunk
      const match = /server-pid:(\d+)/.exec(out)
      if (match?.[1] !== undefined) settle(Number(match[1]))
    })
    client.once("exit", () => reject(new Error(`the client exited before reporting: ${out}`)))
  })
  leftover.push(serverPid)
  await waitFor(() => alive(serverPid), 5_000, "the spawned server to come up")
  return { clientPid, serverPid }
}

describe("an eve child and its parent's ungraceful death", () => {
  /**
   * The REPRODUCTION: without the tether, the child survives its parent's SIGKILL indefinitely.
   * This is the orphan census's finding in miniature — 19 leaked `eve start` processes, several
   * days old — and it is also the harness's validity check: a runner that killed the whole process
   * group would fail HERE, not pass the fix's cases vacuously.
   */
  it("the untethered child outlives a SIGKILLed parent (the defect)", async () => {
    const { clientPid, serverPid } = await spawnTree("server.mjs", false)
    process.kill(clientPid, "SIGKILL")
    await sleep(2_500)
    expect(alive(clientPid)).toBe(false)
    expect(alive(serverPid)).toBe(true)
    process.kill(serverPid, "SIGKILL")
  }, 15_000)

  /** The fix: the tether notices the reparenting within its poll interval and the child exits. */
  it("a tethered child exits when its parent is SIGKILLed", async () => {
    const { clientPid, serverPid } = await spawnTree("server.mjs", true)
    process.kill(clientPid, "SIGKILL")
    await waitFor(() => !alive(serverPid), 10_000, "the tethered child to exit")
  }, 15_000)

  /**
   * The backstop: a child that IGNORES SIGTERM still dies, by the tether's in-process hard exit.
   * `eve start` handles SIGTERM properly, so this is the wedged-server case rather than the normal
   * one — the grace is 5s, so the deadline here is grace plus polling slack.
   */
  it("a tethered child that ignores SIGTERM is force-exited by the backstop", async () => {
    const { clientPid, serverPid } = await spawnTree("stubborn.mjs", true)
    process.kill(clientPid, "SIGKILL")
    await waitFor(() => !alive(serverPid), 12_000, "the stubborn child to be force-exited")
  }, 20_000)

  /**
   * INERT without the variable: the tether module loading is not the same as the tether being
   * armed, and a hand-run `eve start` that somehow loads it must not start killing itself over a
   * ppid nobody declared. The child here is this test process's own — its real ppid never matches
   * nothing, because nothing was declared.
   */
  it("does nothing when the parent-pid variable is absent", async () => {
    const child = spawn(
      process.execPath,
      ["--import", parentTetherUrl(), join(fixtureDir, "server.mjs")],
      {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, [PARENT_PID_ENV]: "" }
      }
    )
    const pid = child.pid
    if (pid === undefined) throw new Error("the child did not spawn")
    leftover.push(pid)
    await sleep(2_500)
    expect(alive(pid)).toBe(true)
    process.kill(pid, "SIGKILL")
  }, 10_000)
})

/**
 * The authored-file half, same tier as `run-auth.test.ts` uses for the spawn it cannot reach from a
 * unit test: the tether only protects the children whose spawn actually composes it.
 */
describe("the tether is wired into both eve children", () => {
  const codeOnly = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  const codeOf = async (...parts: string[]): Promise<string> =>
    codeOnly(await readFile(join(packageRoot, ...parts), "utf8"))

  it("the eve start spawn rides the tether and stamps the parent pid", async () => {
    const code = await codeOf("src", "client.ts")
    expect(code).toMatch(/tetheredNodeArgs\(eveBin, \["start"/)
    expect(code).toContain("...tetherEnv()")
  })

  it("the eve build spawn rides the tether and stamps the parent pid", async () => {
    const code = await codeOf("src", "agent-build.ts")
    expect(code).toMatch(/tetheredNodeArgs\(input\.eveBin, \["build"\]\)/)
    expect(code).toContain("...tetherEnv()")
  })

  /**
   * The tether is plain source loaded OUTSIDE this package's module graph, so the environment
   * variable's name is restated there rather than imported — this is the assertion that pins the
   * two spellings to each other, and to the value `tetherEnv()` stamps.
   */
  it("the tether module and the client spell the same environment variable", async () => {
    const tether = await readFile(join(packageRoot, "tether", "parent-tether.mjs"), "utf8")
    expect(tether).toContain(`const PARENT_PID_ENV = "${PARENT_PID_ENV}"`)
    expect(Object.keys(tetherEnv())).toEqual([PARENT_PID_ENV])
    expect(tetherEnv()[PARENT_PID_ENV]).toBe(String(process.pid))
  })

  it("the composed argv puts the tether before the entry", () => {
    const args = tetheredNodeArgs("/opt/eve/bin/eve.js", ["start", "--port", "1"])
    expect(args.slice(0, 2)).toEqual(["--import", parentTetherUrl()])
    expect(args.slice(2)).toEqual(["/opt/eve/bin/eve.js", "start", "--port", "1"])
    expect(parentTetherUrl().startsWith("file://")).toBe(true)
  })
})

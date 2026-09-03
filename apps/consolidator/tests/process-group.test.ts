import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { killProcessGroup } from "../src/process-group.js"

/**
 * The orphan half of the 2026-09-03 stall: `eve start` supervises the built server as a grandchild,
 * and a kill addressed to the supervisor's pid leaves a grandchild whose event loop is blocked running
 * at full CPU with no client. This tier drives a REAL process tree, because the defect lives in kernel
 * behavior no fake reproduces: process groups, signal default actions, and a JavaScript SIGTERM
 * handler that can never run because the loop it would run on is busy.
 *
 * The stand-in supervisor spawns a grandchild that installs a SIGTERM handler and then spins forever —
 * the exact shape of a built server holding a runaway regex. The FIRST case is the reproduction: the
 * old pid-addressed SIGKILL ends the supervisor and leaves the grandchild alive. The second is the fix.
 *
 * (Mutation: changing `process.kill(-pid, ...)` back to `child.kill(...)` in `process-group.ts`
 * leaves the grandchild alive in the second case and fails it; the first case stays green.)
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms))

const waitFor = async (check: () => boolean, deadlineMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

/** A supervisor over a busy grandchild that has a SIGTERM handler it can never run. */
const SUPERVISOR_SOURCE = `
import { spawn } from "node:child_process"
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); for (;;) {}'], {
  stdio: "ignore"
})
process.stdout.write(String(child.pid) + "\\n")
setInterval(() => {}, 1000)
`

let dir = ""
let supervisorPath = ""
const spawned: Array<{ readonly leader: ChildProcess; readonly grandchild: number }> = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "memhtml-process-group-"))
  supervisorPath = join(dir, "supervisor.mjs")
  await writeFile(supervisorPath, SUPERVISOR_SOURCE)
})

afterEach(() => {
  // Whatever a case left behind dies here, so a failing case cannot leak a spinning process.
  for (const { leader, grandchild } of spawned.splice(0)) {
    for (const pid of [grandchild, leader.pid ?? -1]) {
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Spawn the tree as the client spawns eve start: detached, so the leader's pid is a group id. */
const spawnTree = async (): Promise<{
  readonly leader: ChildProcess
  readonly grandchild: number
}> => {
  const leader = spawn(process.execPath, [supervisorPath], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  })
  const grandchild = await new Promise<number>((settle, reject) => {
    let buffer = ""
    leader.stdout?.setEncoding("utf8")
    leader.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      const line = buffer.split("\n")[0]
      if (buffer.includes("\n") && line !== undefined) settle(Number(line))
    })
    leader.once("error", reject)
    leader.once("exit", () => reject(new Error("the supervisor exited before reporting")))
  })
  const tree = { leader, grandchild }
  spawned.push(tree)
  await waitFor(() => alive(grandchild), 5_000, "the grandchild to be alive")
  return tree
}

describe("killing the eve process tree", () => {
  it("REPRODUCTION: a pid-addressed SIGKILL ends the supervisor and leaves the grandchild spinning", async () => {
    const { leader, grandchild } = await spawnTree()
    leader.kill("SIGKILL")
    await waitFor(
      () => leader.exitCode !== null || leader.signalCode !== null,
      5_000,
      "leader exit"
    )
    await sleep(300)
    expect(alive(grandchild)).toBe(true)
  }, 15_000)

  it("killProcessGroup ends the supervisor AND the blocked grandchild within the grace", async () => {
    const { leader, grandchild } = await spawnTree()
    const started = Date.now()
    await killProcessGroup(leader, 1_000)
    await waitFor(() => !alive(grandchild), 3_000, "the grandchild to die")
    expect(leader.exitCode !== null || leader.signalCode !== null).toBe(true)
    expect(alive(grandchild)).toBe(false)
    // SIGTERM grace of one second, then SIGKILL: the whole tree is gone in a few seconds, not 20.
    expect(Date.now() - started).toBeLessThan(6_000)
  }, 15_000)

  it("is safe to call on a child that already exited, and still clears the group it led", async () => {
    const { leader, grandchild } = await spawnTree()
    leader.kill("SIGKILL")
    await waitFor(
      () => leader.exitCode !== null || leader.signalCode !== null,
      5_000,
      "leader exit"
    )
    expect(alive(grandchild)).toBe(true)
    await killProcessGroup(leader, 500)
    await waitFor(() => !alive(grandchild), 3_000, "the orphaned grandchild to die")
    expect(alive(grandchild)).toBe(false)
  }, 15_000)
})

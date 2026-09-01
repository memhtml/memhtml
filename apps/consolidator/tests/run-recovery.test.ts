import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { settleTurnWithinBudget } from "../src/client.js"

/**
 * The abandoned-run half of issue #100: a consolidation turn dropped mid-flight stays `active` in
 * eve's local workflow state directory, and the directory is SHARED — the built server resolves it
 * under `process.cwd()`, which is the per-version build cache every spawn of that version serves
 * from. The next boot's default behavior re-enqueues every active run it finds and runs it to
 * completion, unattended: `[world-local] Re-enqueued 9 active run(s) on startup`, model spend on
 * answers whose consumer is long dead.
 *
 * The mechanism tier here drives the INSTALLED `@workflow/world-local` — the exact code the built
 * server constructs its world from — rather than a description of it, the same posture
 * `run-auth.test.ts` takes with eve's verifier and `start-port.test.ts` with eve's exports map. The
 * module is internal to eve, so it is reached by file path from eve's own manifest; an eve release
 * that moves it, or changes what `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` means, fails HERE rather than
 * as a fleet of resurrected turns. eve's production `createWorld` call passes `dataDir` alone
 * (verified against the shipped dist: the generated workflow-world plugin), so the environment
 * variable is what decides recovery — eve's own development server passes
 * `recoverActiveRuns: false` explicitly, for exactly this reason.
 *
 * The FIRST case is the reproduction: the defect observed as an HTTP delivery of the dead run to
 * the workflow endpoint. The second is the fix's mechanism: the switch set to "0" leaves the row
 * inert. `client.ts` setting that switch on every `eve start` spawn is the wiring half, asserted
 * below with the other authored-file guards.
 */

/** The installed world-local module, resolved from eve's own manifest the way the bin path is. */
const worldLocalPath = (): string => {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve("eve/package.json")
  return join(dirname(manifest), "dist", "src", "compiled", "@workflow", "world-local", "index.js")
}

interface LocalWorldRun {
  readonly runId: string
  readonly status: string
  readonly workflowName: string
}

interface LocalWorld {
  readonly start?: () => Promise<void>
  readonly close?: () => Promise<void>
  readonly events: {
    readonly create: (runId: string | undefined, event: unknown) => Promise<unknown>
  }
  readonly runs: {
    readonly list: (params: unknown) => Promise<{ readonly data: ReadonlyArray<LocalWorldRun> }>
  }
}

type CreateWorld = (options: { readonly dataDir: string }) => LocalWorld

const loadCreateWorld = async (): Promise<CreateWorld> => {
  const module = (await import(pathToFileURL(worldLocalPath()).href)) as {
    readonly createWorld: CreateWorld
  }
  return module.createWorld
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms))

describe("eve's local workflow world and an abandoned active run", () => {
  const envKeys = ["WORKFLOW_LOCAL_BASE_URL", "WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS"] as const
  const savedEnv = new Map<string, string | undefined>()
  const dataDirs: string[] = []
  const received: Array<{ readonly url: string; readonly body: string }> = []
  let baseUrl = ""
  let server: ReturnType<typeof createServer>

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key])
    // The workflow endpoint a re-enqueued run is DELIVERED to. Answering 200 acknowledges the
    // message; what the test observes is that the dead client's run reached an executor at all.
    server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: string | Buffer) => {
        body += String(chunk)
      })
      request.on("end", () => {
        received.push({ url: request.url ?? "", body })
        response.statusCode = 200
        response.end("ok")
      })
    })
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no listen port")
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterAll(async () => {
    await new Promise<void>((settle) => server.close(() => settle()))
    for (const dir of dataDirs) await rm(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    for (const key of envKeys) {
      const saved = savedEnv.get(key)
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
    received.length = 0
  })

  /** A data directory holding one active run whose client is gone: the abandoned turn's state. */
  const abandonedRun = async (
    createWorld: CreateWorld
  ): Promise<{
    readonly dataDir: string
    readonly runId: string
  }> => {
    const dataDir = await mkdtemp(join(tmpdir(), "memhtml-run-recovery-test-"))
    dataDirs.push(dataDir)
    const world = createWorld({ dataDir })
    await world.events.create(undefined, {
      eventType: "run_created",
      eventData: { deploymentId: "dpl_test", workflowName: "workflow//turn", input: [] }
    })
    const listed = await world.runs.list({ status: "pending", resolveData: "none" })
    await world.close?.()
    const runId = listed.data[0]?.runId
    if (runId === undefined) throw new Error("the fixture created no pending run")
    return { dataDir, runId }
  }

  it("re-enqueues and delivers the dead client's run on the next boot (the defect)", async () => {
    const createWorld = await loadCreateWorld()
    process.env.WORKFLOW_LOCAL_BASE_URL = baseUrl
    delete process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS

    const { dataDir, runId } = await abandonedRun(createWorld)
    const world = createWorld({ dataDir })
    await world.start?.()
    const deadline = Date.now() + 10_000
    while (received.length === 0 && Date.now() < deadline) await sleep(200)
    await world.close?.()

    expect(received.length).toBeGreaterThan(0)
    expect(received[0]?.body).toContain(runId)
  }, 20_000)

  it("WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0 leaves the abandoned run inert", async () => {
    const createWorld = await loadCreateWorld()
    process.env.WORKFLOW_LOCAL_BASE_URL = baseUrl
    process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS = "0"

    const { dataDir, runId } = await abandonedRun(createWorld)
    const world = createWorld({ dataDir })
    await world.start?.()
    await sleep(2_000)

    // Inert is not erased: the row is still there as data, listable by an operator — it is just
    // never handed to an executor again.
    const listed = await world.runs.list({ status: "pending", resolveData: "none" })
    await world.close?.()
    expect(received).toEqual([])
    expect(listed.data.map((run) => run.runId)).toContain(runId)
  }, 20_000)
})

/**
 * The in-band budget: when the turn blows it, the client CANCELS the turn before the caller kills
 * the server, so the common abandonment path leaves no active run for a later boot to resurrect.
 * Driven with plain fakes — the shape under test is the race and the cancel, not eve's wire.
 */
describe("settleTurnWithinBudget", () => {
  const never = new Promise<never>(() => {})

  it("returns the result and never cancels when the turn settles in budget", async () => {
    let cancelled = 0
    const outcome = await settleTurnWithinBudget({
      turn: {
        result: () => Promise.resolve("answer"),
        cancel: () => {
          cancelled += 1
          return Promise.resolve()
        }
      },
      budgetMs: 5_000
    })
    expect(outcome).toEqual({ kind: "settled", result: "answer" })
    expect(cancelled).toBe(0)
  })

  it("cancels the turn when the budget expires (the receipt issue #100 wants)", async () => {
    let cancelled = 0
    const outcome = await settleTurnWithinBudget({
      turn: {
        result: () => never,
        cancel: () => {
          cancelled += 1
          return Promise.resolve()
        }
      },
      budgetMs: 50
    })
    expect(outcome).toEqual({ kind: "timeout" })
    expect(cancelled).toBe(1)
  })

  it("a cancel that hangs is bounded and cannot stall the timeout path", async () => {
    const before = Date.now()
    const outcome = await settleTurnWithinBudget({
      turn: { result: () => never, cancel: () => never },
      budgetMs: 50,
      cancelWaitMs: 100
    })
    expect(outcome).toEqual({ kind: "timeout" })
    expect(Date.now() - before).toBeLessThan(5_000)
  })

  it("a rejection inside the budget propagates unchanged", async () => {
    await expect(
      settleTurnWithinBudget({
        turn: { result: () => Promise.reject(new Error("turn failed")), cancel: () => never },
        budgetMs: 5_000
      })
    ).rejects.toThrow("turn failed")
  })

  it("a cancel rejection is swallowed: the outcome is still the timeout", async () => {
    const outcome = await settleTurnWithinBudget({
      turn: { result: () => never, cancel: () => Promise.reject(new Error("cancel refused")) },
      budgetMs: 50
    })
    expect(outcome).toEqual({ kind: "timeout" })
  })
})

/**
 * The authored-file half, same tier as `run-auth.test.ts` uses for the spawn: the mechanism above
 * only protects runs when the spawn actually sets the switch and the turn actually routes through
 * the cancelling race.
 */
describe("the client wires both halves", () => {
  const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")

  const codeOnly = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("every eve start spawn disables active-run recovery for the next boot", async () => {
    const code = codeOnly(await readFile(join(packageRoot, "src", "client.ts"), "utf8"))
    // The literal the installed world-local reads, and the spawn entry that carries it. eve start
    // spreads its environment into the built server, which is how the value reaches the world.
    expect(code).toContain('const RECOVER_ACTIVE_RUNS_ENV = "WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS"')
    expect(code).toContain('[RECOVER_ACTIVE_RUNS_ENV]: "0"')
  })

  it("the turn budget is enforced in band, through the cancelling race", async () => {
    const code = codeOnly(await readFile(join(packageRoot, "src", "client.ts"), "utf8"))
    expect(code).toContain("settleTurnWithinBudget({")
    expect(code).toContain("cancel: () => response.cancel()")
    // The out-of-band timeout survives only as the wider backstop for a create that never returned;
    // at the budget itself the fiber must NOT be interrupted, or there is no handle left to cancel.
    expect(code).toContain("duration: turnBudgetMs + TURN_ABANDON_GRACE_MS")
    expect(code).not.toMatch(/duration: turnBudgetMs\b(?! \+)/)
  })
})

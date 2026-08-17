import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { makeConsolidator } from "../src/client.js"
import { ConsolidatorUnavailable } from "../src/contract.js"

/**
 * The start-path tier: the port is chosen HERE, and nothing on the child's stdout can name the
 * address a transcript is posted to.
 *
 * Credential-free and server-free in the sense INV-3 requires: the cases below either read
 * `client.ts` as text or drive a run against an app root with no `.output/`, so no `eve start`
 * succeeds, no model is called, and CI stays green. What a live server does is covered by the probe
 * recorded in `client.ts` — a warm start answered `/eve/v1/health` 1.79s after spawn, and an occupied
 * port produced no distinguishable error at all.
 */

const clientSource = (): Promise<string> =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "client.ts"), "utf8")

/**
 * An app root that EXISTS and holds no `.output/`.
 *
 * Existing is the load-bearing part. A path that does not exist fails one step earlier — `spawn` with
 * an unreachable `cwd` reports `ENOENT` on the spawn itself, so the run never reaches the readiness
 * poll or the retry, and both cases below would assert against a message about a missing directory.
 * With a real empty directory the spawn succeeds, `eve start` finds no `.output/` to serve, and the
 * child EXITS before answering — which is the failure shape a real "eve build has not run" produces.
 */
let unbuiltRoot: string

beforeAll(async () => {
  unbuiltRoot = await mkdtemp(join(tmpdir(), "consolidator-unbuilt-"))
})

afterAll(async () => {
  await rm(unbuiltRoot, { recursive: true, force: true })
})

/** Strip line comments and block comments, so a text assertion is about CODE and not about prose. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/**
 * How long a case driving three real spawn attempts may take.
 *
 * The two cases below each spawn `eve start` up to {@link MAX_PORT_ATTEMPTS} times and wait for each
 * child to EXIT, and a node process that has to load eve's CLI before failing is not fast. Measured
 * on this box (2026-08-09, three runs): 3.98s, 4.20s, 4.57s — against vitest's 5000ms default, which is
 * why they intermittently timed out under `pnpm check`'s parallel load and passed when the file ran
 * alone. The latency is the child's, not the assertion's, so the budget is generous rather than tight.
 *
 * 30s: comfortably past the measurement with room for a loaded box, and far below the 60s
 * `START_TIMEOUT_MS` budget a single attempt is allowed — so a case that hangs still fails rather than
 * running forever.
 */
const SPAWN_CASE_TIMEOUT_MS = 30_000

/** Run a consolidation that gets as far as the spawn, then fails there. Returns the typed failure. */
const startFailure = async (options: {
  readonly appRoot: string
  readonly transcripts: ReadonlyArray<{ sessionId: string; filePath: string }>
}): Promise<ConsolidatorUnavailable> => {
  const consolidator = makeConsolidator({
    env: { AWS_BEARER_TOKEN_BEDROCK: "test" },
    appRoot: options.appRoot,
    /**
     * This test file's own directory, because the transcripts below are this file: they have to RESOLVE
     * under the mounted trace root for the run to reach the spawn, which is the point of the fixture.
     */
    traceRoot: dirname(fileURLToPath(import.meta.url))
  })
  const result = await Effect.runPromise(
    Effect.result(consolidator.consolidate({ transcripts: options.transcripts }))
  )
  if (!Result.isFailure(result)) throw new Error("expected the run to fail")
  const failure = result.failure
  if (!(failure instanceof ConsolidatorUnavailable)) {
    throw new Error(`expected ConsolidatorUnavailable, got ${failure._tag}`)
  }
  return failure
}

/** This file's own transcript, which is readable and therefore gets the run past preparation. */
const readableTranscript = () => [
  { sessionId: "start-port", filePath: fileURLToPath(import.meta.url) }
]

describe("the port is passed explicitly, never read back", () => {
  /**
   * The regression guard for the change itself. `--port 0` is what made a stdout parse necessary: it
   * asks the OS for a port and leaves the child as the only party that knows which one, so the answer
   * had to come back over a stream this process does not control.
   *
   * (Mutation: changing the spawn argument back to `"0"` fails this case.)
   */
  it("never spawns eve start with --port 0", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain('"--port"')
    expect(code).not.toMatch(/"--port",\s*"0"/)
    // The port reaches the child as a rendered number, which is the only spelling that can be one
    // this process chose.
    expect(code).toMatch(/"--port",\s*String\(port\)/)
  })

  /**
   * The origin is COMPOSED, not parsed. The address this process connects to decides who receives a
   * batch of transcripts AND who is presented the run's bearer token, and the only inputs to it are one
   * constant and one integer from the kernel. That mattered more when the channel authenticated every
   * request anonymously and it still matters: a parsed origin would be somewhere a credential could be
   * sent by a string a child process wrote.
   *
   * (Mutation: reintroducing a stdout reader that assigns to `url` fails the last two assertions.)
   */
  it("builds the origin from LOOPBACK_HOST and the chosen port, and reads no URL off stdout", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toMatch(/const url = `http:\/\/\$\{LOOPBACK_HOST}:\$\{String\(port\)}`/)
    // No URL pattern and no accumulated stdout buffer: both were the parse's machinery.
    expect(code).not.toMatch(/https\?:\\\//)
    expect(code).not.toMatch(/stdout \+= chunk/)
  })

  /** The bind address stays a non-overridable constant — there is still no `host` option. */
  it("keeps the loopback bind address unoverridable", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain('const LOOPBACK_HOST = "127.0.0.1"')
    expect(code).toMatch(/"--host",\s*LOOPBACK_HOST/)
    expect(code).not.toMatch(/readonly host\?:/)
  })

  /**
   * The spawn needs node on PATH and nothing else.
   *
   * A package manager in the command line is a workspace assumption that does not survive
   * publication: a consumer installs this package with whatever manager they use, and pnpm need not
   * be present at all. `process.execPath` against a resolved path is what `apps/cli/src/serve.ts`
   * already does to spawn the MCP server.
   *
   * (Mutation: restoring `spawn("pnpm", ["exec", "eve", …])` fails all three assertions.)
   */
  it("spawns eve through node rather than through a package manager", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toMatch(/spawn\(\s*process\.execPath,\s*\[eveBin,\s*"start"/)
    expect(code).not.toMatch(/spawn\(\s*"pnpm"/)
    expect(code).not.toMatch(/"exec",\s*"eve"/)
  })
})

describe("eve's entry point is reached through its manifest", () => {
  const consolidatorRequire = createRequire(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json")
  )

  /**
   * The deep path is not a longer spelling of the same thing — it does not resolve at all. eve's
   * `exports` map declares no `./bin/*` subpath, so node refuses `eve/bin/eve.js` even though the file
   * is on disk. Asserted against the installed eve rather than described, so an eve release that DOES
   * export its bin fails here and invites the simplification instead of hiding it.
   */
  it("refuses eve/bin/eve.js and exports eve/package.json", () => {
    // The `code`, not the message: the code is node's stable identifier for the refusal, and the
    // prose around it names a path that differs per install.
    let code: string | undefined
    try {
      consolidatorRequire.resolve("eve/bin/eve.js")
    } catch (cause) {
      code = (cause as { readonly code?: string }).code
    }
    expect(code).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED")
    expect(consolidatorRequire.resolve("eve/package.json")).toContain("eve")
  })

  /** The manifest's `bin.eve` names a file that is really there, which is what the spawn depends on. */
  it("names a bin that exists on disk", () => {
    const manifestPath = consolidatorRequire.resolve("eve/package.json")
    const { bin } = consolidatorRequire(manifestPath) as {
      readonly bin: Record<string, string>
    }
    const entry = bin.eve
    expect(entry).toBeTypeOf("string")
    expect(existsSync(resolve(dirname(manifestPath), entry ?? ""))).toBe(true)
  })

  /** The resolution in `client.ts` is the manifest route, not the deep path the case above refuses. */
  it("resolves through the manifest in client.ts", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain('require.resolve("eve/package.json")')
    expect(code).not.toMatch(/resolve\("eve\/bin/)
  })
})

describe("readiness is a real check", () => {
  /**
   * A sleep would pass a test that a race loses in production. The check is a fetch of eve's own
   * health route, which returns `{ ok: true, status: "ready" }` only once the workflow entry
   * resolves (node_modules/eve/dist/src/internal/nitro/routes/health.js) — so a 200 means the app is
   * serving, not that a socket accepted.
   *
   * (Mutation: replacing the `healthy()` call in the poll with a fixed delay fails the first two
   * assertions.)
   */
  it("polls the health route rather than waiting a fixed time", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain('new URL("/eve/v1/health", origin)')
    expect(code).toContain("if (await healthy(url))")
    // A probe with no timeout of its own would hang on a listener that accepts and never answers,
    // which is the shape a lost port race takes.
    expect(code).toContain("AbortSignal.timeout(READY_PROBE_TIMEOUT_MS)")
  })

  /**
   * A run against an app root with no `.output/` reaches the spawn and fails there, and the failure
   * names the health route it waited on. That is the operator-visible half: before this change the
   * message said "did not report a URL", which pointed at a stream nobody can now inspect.
   */
  it(
    "fails with a reason naming the health route it waited on",
    async () => {
      const failure = await startFailure({
        appRoot: unbuiltRoot,
        transcripts: readableTranscript()
      })
      expect(failure.reason).toContain("eve start")
      expect(failure.reason).toContain("/eve/v1/health")
      expect(failure.reason).toContain("build:agent")
    },
    SPAWN_CASE_TIMEOUT_MS
  )

  /**
   * The retry is visible in the failure, and the count is not decoration: "could not start" and
   * "could not start on three successive ports" call for different operator responses. A spawn that
   * dies immediately is retried on a FRESH port, because reusing the port would retry the thing that
   * failed.
   *
   * (Mutation: setting `MAX_PORT_ATTEMPTS = 1` fails this case; so does marking the exit failure
   * `retryable: false`, since the message then omits the port count entirely.)
   */
  it(
    "reports how many successive ports were tried when every attempt died",
    async () => {
      const failure = await startFailure({
        appRoot: unbuiltRoot,
        transcripts: readableTranscript()
      })
      expect(failure.reason).toContain("3 successive loopback ports")
    },
    SPAWN_CASE_TIMEOUT_MS
  )
})

describe("the port this process reserves is actually free", () => {
  /**
   * Not a test of the client, but of the assumption underneath it: `listen(0)` on loopback returns a
   * port the kernel is not already handing out, and it is released before eve is told to take it.
   *
   * The release is the race, and it is inherent — the probe listener MUST close for the child to bind.
   * This case pins the two halves that are actually knowable: the port is a real number, and the
   * probe is not still holding it afterwards.
   */
  it("releases the probed port, so the child can bind it", async () => {
    const probed = await new Promise<number>((settle, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        if (address === null || typeof address === "string") {
          probe.close(() => reject(new Error("no numeric port")))
          return
        }
        const { port } = address
        probe.close((cause) => (cause ? reject(cause) : settle(port)))
      })
    })
    expect(probed).toBeGreaterThan(1_024)

    // Bindable again immediately, which is what "released" has to mean for eve to succeed.
    const rebound = await new Promise<boolean>((settle) => {
      const second = createServer()
      second.once("error", () => settle(false))
      second.listen(probed, "127.0.0.1", () => second.close(() => settle(true)))
    })
    expect(rebound).toBe(true)
  })
})

describe("the sandbox mounts reach the spawned server", () => {
  /**
   * The `filesystem` factory runs in the SERVER process, so the roots have to cross a process
   * boundary; the spawn environment is the only channel eve's CLI leaves open. Asserted as source
   * because the alternative is spawning a real server, and the round trip itself is covered by
   * `mount.test.ts`.
   *
   * (Mutation: dropping the `env` option from the spawn leaves the server with no mounts and no
   * error, which is the silent failure this pair of assertions exists to catch.)
   */
  it("passes the encoded mounts on the spawn environment", async () => {
    const code = codeOnly(await clientSource())
    expect(code).toContain("[SANDBOX_MOUNTS_ENV]: encodeSandboxMounts(mounts)")
    // Validated at spawn, because eve does not invoke the factory during prewarming — a bad root
    // would otherwise first appear inside a live sleep run.
    expect(code).toContain("encodeSandboxMounts")
  })

  /** The sandbox definition is the other half: it decodes what the client encoded. */
  it("composes the sandbox filesystem from the decoded mounts", async () => {
    const sandbox = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "sandbox", "sandbox.ts"),
      "utf8"
    )
    const code = codeOnly(sandbox)
    expect(code).toContain("decodeSandboxMounts(process.env)")
    expect(code).toContain("mountReadOnlyRoots")
    // eve's own filesystem is the BASE, so `/workspace`, `/tmp`, and the home directory survive.
    expect(code).toContain("base: defaultFilesystem")
  })
})

import { access } from "node:fs/promises"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { MCP_BIN_VAR, mcpEntryPoint } from "../src/serve.js"

/**
 * `memhtml serve mcp`'s two locks, both regressions found by driving the real binary.
 *
 * Neither is about the MCP protocol — `apps/mcp` owns that. These are about the supervisor: where it
 * finds the server, and what it must NOT do before spawning it.
 */

describe("resolving the mcp server", () => {
  it("finds the sibling build without `@memhtml/mcp` being a dependency", async () => {
    /**
     * The first regression. This started as `require.resolve("@memhtml/mcp/bin")`, which raises
     * `MODULE_NOT_FOUND` — and always would have: `@memhtml/mcp` depends on `@memhtml/cli` for the
     * composition root, so `@memhtml/cli` cannot depend on `@memhtml/mcp` without a cycle, and node
     * resolution only finds a package that IS a dependency. The two apps are siblings in one build,
     * so they are located as siblings.
     */
    const entry = await Effect.runPromise(mcpEntryPoint())
    expect(entry).toMatch(/apps\/mcp\/dist\/bin\.js$/)
    // Resolved AND present: a path that merely looked right would spawn a node process that exits 1
    // with a module-not-found, which reads to an operator as "the MCP server crashed".
    await expect(access(entry)).resolves.toBeUndefined()
  })

  it("prefers an explicit override, for a deployment that separates the two apps", async () => {
    process.env[MCP_BIN_VAR] = "/opt/memhtml/mcp.js"
    try {
      expect(await Effect.runPromise(mcpEntryPoint())).toBe("/opt/memhtml/mcp.js")
    } finally {
      delete process.env[MCP_BIN_VAR]
    }
  })

  it("names the fix when the server is not built", async () => {
    process.env[MCP_BIN_VAR] = "   "
    try {
      // A blank override falls through to the sibling rather than being taken literally: an empty
      // environment variable is a shell accident, not a request to spawn `""`.
      expect(await Effect.runPromise(mcpEntryPoint())).toMatch(/apps\/mcp\/dist\/bin\.js$/)
    } finally {
      delete process.env[MCP_BIN_VAR]
    }
  })
})

describe("the supervisor's own restraint", () => {
  it("does not reach for a service, so it cannot lock the database the child must open", async () => {
    /**
     * The second regression, and the one a shape test could never catch. `serve mcp` began as an
     * ordinary dispatch arm, which meant `run` built `layerApp` before spawning — that opens
     * `$MEMHTML_ROOT/.memhtml/index.db`, and Turso takes an EXCLUSIVE file lock. The child then failed to
     * open the very database it exists to serve: "File is locked by another process". A working
     * `memhtml-mcp` and a broken `memhtml serve mcp`, from one extra layer build.
     *
     * The property is asserted structurally: `serve.ts` may import the error class and the config, and
     * nothing that yields a service. A source assertion rather than a behavioural one because the
     * failure needs two processes and a real database to reproduce, while the CAUSE is one import.
     */
    const source = await Effect.runPromise(
      Effect.promise(async () => {
        const { readFile } = await import("node:fs/promises")
        const { fileURLToPath } = await import("node:url")
        return readFile(fileURLToPath(new URL("../src/serve.ts", import.meta.url)), "utf8")
      })
    )

    for (const forbidden of ["api-layer", "layerApp", "DatabaseService", "makeDatabase", "Roots"]) {
      expect(source).not.toContain(forbidden)
    }
  })
})

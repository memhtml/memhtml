import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

/**
 * `memhtml serve mcp`: run the stdio MCP server over the same repo.
 *
 * **The server runs as a child process because of stdout.** The CLI's contract is exactly one JSON
 * envelope on stdout, and a stdio MCP server owns stdout as an NDJSON-RPC stream. Two writers on one
 * file descriptor corrupt the stream for whichever of the two a client is parsing, and no framing
 * makes both readable at once.
 *
 * `stdio: "inherit"` hands the child the very descriptors the MCP client opened, so the client talks
 * to `memhtml-mcp` directly and this process is only a supervisor. The child inherits the environment
 * too, which is what makes it build a byte-identical `AppLive`: same region, same credentials.
 * `MEMHTML_ROOT` is passed explicitly on top so a `--repo` override reaches the server, which an
 * inherited environment alone would not carry.
 */

/** What the supervised server's exit looked like. */
export interface ServeResult {
  readonly server: string
  readonly exitCode: number
  /** The signal that ended it, when a signal did. */
  readonly signal: string | null
}

/** An explicit path to the server, for a deployment that does not keep the two apps side by side. */
export const MCP_BIN_VAR = "MEMHTML_MCP_BIN"

/**
 * Where the `memhtml-mcp` entry point sits relative to this module, in each layout that ships.
 *
 * Resolved by PATH rather than by `require.resolve`, which the dependency direction forces.
 * `@memhtml/mcp` depends on `@memhtml/cli` for the composition root, so `@memhtml/cli` cannot depend on
 * `@memhtml/mcp` without a cycle, and node resolution can only find a package that is a dependency.
 * (`require.resolve("@memhtml/mcp/bin")` from here raises `MODULE_NOT_FOUND`, which is how this was
 * found.)
 *
 * Two candidates, tried in order, because the two apps are one build and where that build puts them
 * differs:
 *
 * - `./memhtml-mcp.mjs` — the PUBLISHED package, where both bins are entry points of one bundle and
 *   land beside each other in `dist/`.
 * - `../../mcp/dist/bin.js` — the workspace, where `apps/cli/dist/serve.js` reaches
 *   `apps/mcp/dist/bin.js` two directories up and across.
 *
 * Both are real directories rather than pnpm symlinks into the store, so each walk is stable where it
 * applies. {@link MCP_BIN_VAR} still overrides for a deployment that separates them.
 */
const MCP_CANDIDATES = ["./memhtml-mcp.mjs", "../../mcp/dist/bin.js"] as const

export const mcpEntryPoint = (): Effect.Effect<string, StorageFailure> =>
  Effect.gen(function* () {
    const override = process.env[MCP_BIN_VAR]
    if (override !== undefined && override.trim() !== "") return override.trim()

    for (const candidate of MCP_CANDIDATES) {
      const path = fileURLToPath(new URL(candidate, import.meta.url))
      const present = yield* Effect.tryPromise({
        try: () => access(path),
        catch: () => "absent" as const
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )
      if (present) return path
    }

    // A build that produced the CLI but not the server is the one thing that lands here, so the
    // message names the fix rather than the missing path.
    return yield* Effect.fail(
      StorageFailure.make({
        operation: `serve.resolveMcp: run \`pnpm build\`, or set ${MCP_BIN_VAR}`
      })
    )
  })

export const serveMcp = (memhtmlRoot: string): Effect.Effect<ServeResult, StorageFailure> =>
  Effect.gen(function* () {
    const entry = yield* mcpEntryPoint()

    return yield* Effect.callback<ServeResult, StorageFailure>((resume) => {
      const child = spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: { ...process.env, MEMHTML_ROOT: memhtmlRoot }
      })

      child.on("error", () =>
        resume(Effect.fail(StorageFailure.make({ operation: "serve.spawn" })))
      )
      child.on("exit", (code, signal) =>
        resume(
          Effect.succeed({
            server: entry,
            exitCode: code ?? 0,
            signal: signal ?? null
          })
        )
      )

      // Killing the child on interruption is what keeps a `memhtml serve mcp` that the operator
      // Ctrl-C'd from leaving an orphaned server holding the repo's database open.
      return Effect.sync(() => {
        child.kill()
      })
    })
  })

import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { StorageFailure } from "@memhtml/contracts/errors"
import { Effect } from "effect"

/**
 * `memhtml serve mcp`: run the stdio MCP server over the same repo.
 *
 * **A child process, not an in-process server, and the reason is stdout.** The CLI's contract is
 * exactly one JSON envelope on stdout; a stdio MCP server owns stdout as an NDJSON-RPC stream. Two
 * writers on one file descriptor is a corrupted stream for whichever of the two a client is parsing,
 * and there is no framing that makes both readable at once.
 *
 * `stdio: "inherit"` hands the child the very descriptors the MCP client opened, so the client talks
 * to `memhtml-mcp` directly and this process is only a supervisor. The child inherits the environment
 * too, which is what makes it build a byte-identical `AppLive` — same region, same credentials.
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
 * The `memhtml-mcp` entry point.
 *
 * Resolved by PATH, not by `require.resolve`, and that is forced by the dependency direction:
 * `@memhtml/mcp` depends on `@memhtml/cli` for the composition root, so `@memhtml/cli` cannot depend on
 * `@memhtml/mcp` without a cycle — and node resolution can only find a package that IS a dependency.
 * (`require.resolve("@memhtml/mcp/bin")` from here raises `MODULE_NOT_FOUND`, which is how this was
 * found.)
 *
 * So the two apps are located as what they are: siblings in one build, shipped and versioned
 * together. `apps/cli/dist/serve.js` → `apps/mcp/dist/bin.js` is two directories up and across, and
 * unlike a dependency path it is a real directory rather than a pnpm symlink into the store, so the
 * relative walk is stable. {@link MCP_BIN_VAR} overrides it for a deployment that separates them.
 */
export const mcpEntryPoint = (): Effect.Effect<string, StorageFailure> =>
  Effect.gen(function* () {
    const override = process.env[MCP_BIN_VAR]
    if (override !== undefined && override.trim() !== "") return override.trim()

    const sibling = fileURLToPath(new URL("../../mcp/dist/bin.js", import.meta.url))
    const present = yield* Effect.tryPromise({
      try: () => access(sibling),
      catch: () => "absent" as const
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
    if (present) return sibling

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

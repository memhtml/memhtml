import { defineTool, type ToolDefinition } from "eve/tools"
import { bash } from "eve/tools/defaults"

import {
  BASH_WORKER_ENV,
  type BashResult,
  commandTimeoutMsFrom,
  runBoundedCommand,
  SCRATCH_ROOT_ENV
} from "../../src/command-bound.js"
import { SANDBOX_MOUNTS_ENV } from "../../src/mount.js"

/**
 * eve's built-in `bash`, with its executor replaced by the bounded runner.
 *
 * Authored at the built-in's slug, so it TAKES OVER the framework tool of that name
 * (node_modules/eve/docs/concepts/built-in-tools.md, "Override a default"); spreading the default
 * keeps its description and both schemas, so the model sees the same tool it always saw. What
 * changes is where the command runs: on a worker thread that `src/command-bound.ts` can terminate
 * at the deadline, instead of on the server's own event loop where the 2026-09-03 regex ran for 7.5
 * hours (the file explains why nothing cooperative could have stopped it).
 *
 * The three values this reads are stamped into the spawn environment by `src/client.ts`, the same
 * channel `agent/sandbox/sandbox.ts` reads its mounts from. A server started without them FAILS the
 * call rather than running an unbounded command: the whole reason this file exists is that the
 * unbounded path looked like a slow model for three nights.
 *
 * eve's own sandbox is still constructed (`agent/sandbox/sandbox.ts`) and still serves `read_file`
 * and `write_file`. Both see the same read-only mounts as this tool; only `/workspace` differs, and
 * `agent/instructions.md` tells the model to reach scratch files through `bash`.
 */
interface BashInput {
  readonly command: string
}

const defaults = bash as ToolDefinition<BashInput, BashResult>

export default defineTool<BashInput, BashResult>({
  ...defaults,
  async execute(input) {
    const workerPath = process.env[BASH_WORKER_ENV]
    const scratchRoot = process.env[SCRATCH_ROOT_ENV]
    if (
      workerPath === undefined ||
      workerPath === "" ||
      scratchRoot === undefined ||
      scratchRoot === ""
    ) {
      throw new Error(
        `the bounded bash tool needs ${BASH_WORKER_ENV} and ${SCRATCH_ROOT_ENV} in its environment; ` +
          "start this server through the consolidator client"
      )
    }
    return runBoundedCommand({
      command: input.command,
      timeoutMs: commandTimeoutMsFrom(process.env),
      workerPath,
      mountsEncoded: process.env[SANDBOX_MOUNTS_ENV],
      scratchRoot
    })
  }
})

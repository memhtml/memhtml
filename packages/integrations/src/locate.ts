/**
 * Which binary an install wires: the node executable, the `memhtml` entry script, the `memhtml-mcp`
 * entry script, and the version to record.
 *
 * Resolved ONCE per install and recorded in the receipt, because every command line in every host's
 * config is derived from it — so `integrations doctor` comparing what resolves today against what the
 * receipt names is what tells an upgrade from a move.
 *
 * Nothing here imports `@memhtml/cli`: the dependency runs the other way, and this package must build
 * with no knowledge of the binary that ships it. The caller therefore hands in the entry script it was
 * started as (`process.argv[1]`) and the version it reports, and this module only resolves the sibling
 * server and refuses a build that produced one bin and not the other.
 */

import { access } from "node:fs/promises"
import { dirname, resolve as resolvePath, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { realpathOrSelf } from "./fs.js"
import type { BinaryLocation } from "./types.js"

/**
 * Where `memhtml-mcp` sits relative to the `memhtml` entry script, in each layout that ships.
 *
 * The same two candidates `apps/cli/src/serve.ts` walks, and for the same reason: the two apps are one
 * build, and where that build puts them differs. `./memhtml-mcp.mjs` is the published package, where
 * both bins are entry points of one bundle and land beside each other; `../../mcp/dist/bin.js` is the
 * workspace, where `apps/cli/dist/bin.js` reaches `apps/mcp/dist/bin.js` two directories up and across.
 */
export const MCP_CANDIDATES = ["./memhtml-mcp.mjs", "../../mcp/dist/bin.js"] as const

const present = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export interface LocateInput {
  /** The `memhtml` entry script this process was started as, normally `process.argv[1]`. */
  readonly entry: string
  /** The version to record, normally the CLI manifest's. */
  readonly version: string
  /** An explicit `memhtml-mcp` path, for a deployment that does not keep the two bins together. */
  readonly mcpOverride?: string
}

/**
 * The binary an install records.
 *
 * Both entry scripts are realpath-resolved, so a config written through a version manager's shim names
 * the file rather than the shim — a shim that moves on the next `nvm use` leaves a host config pointing
 * at nothing, and the failure surfaces as an MCP server that will not start.
 *
 * A missing server script throws a plain `Error` naming `pnpm build` rather than returning a partial
 * location. An install that wired hooks and no MCP entry would be a half-integration whose receipt
 * claims a server nothing can spawn, which is exactly the state `doctor` exists to find and which
 * install should never create.
 */
export const locateBinary = async (input: LocateInput): Promise<BinaryLocation> => {
  const cli = await realpathOrSelf(resolvePath(input.entry))
  const override = input.mcpOverride?.trim()
  if (override !== undefined && override !== "") {
    return {
      node: process.execPath,
      cli,
      mcp: await realpathOrSelf(resolvePath(override)),
      version: input.version
    }
  }
  // A file URL rather than string concatenation: a `#` or a space in the install path would make a
  // hand-built URL resolve somewhere else entirely, and `pathToFileURL` escapes both.
  const base = pathToFileURL(`${dirname(cli)}${sep}`)
  for (const candidate of MCP_CANDIDATES) {
    const path = fileURLToPath(new URL(candidate, base))
    if (await present(path)) {
      return {
        node: process.execPath,
        cli,
        mcp: await realpathOrSelf(path),
        version: input.version
      }
    }
  }
  throw new Error(
    `no memhtml-mcp entry script beside ${cli} (looked for ${MCP_CANDIDATES.join(", ")}): run \`pnpm build\``
  )
}

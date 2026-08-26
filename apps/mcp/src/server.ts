import { layerApp } from "@memhtml/cli"
import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"

import { ToolHandlers } from "./handlers.js"
import { Resources } from "./resources.js"
import { MemhtmlToolkit } from "./tools.js"

export const SERVER_NAME = "memhtml"
export const SERVER_VERSION = "0.6.0" // x-release-please-version

/**
 * The server as one layer: fifteen tools, three resources, over the CLI's own `AppLive`.
 *
 * The same composition the CLI builds, deliberately. An MCP server with its own layer graph would be
 * a second set of answers to which database file, which git root, and which vector space. An agent
 * whose `memory_write` landed in one repo while its operator's `memhtml search` read another would
 * be very hard to diagnose from either side.
 *
 * **`Logger.LogToStderr` is required here.** Effect's default logger writes to stdout, and stdout
 * on this transport is the NDJSON-RPC stream, so one log line would corrupt the frame a client is
 * mid-parse on. The CLI sets the same reference for the same reason, one fd over.
 *
 * **There is no server-level `instructions` here, because effect provides no way to set one.** MCP
 * defines an `instructions` field on the initialize response for exactly the cross-tool guidance
 * this server wants to give (when to batch, the three doors, the commit duty), and effect does not
 * emit it. Verified against effect 4.0.0-rc.109 in the dependency's own declarations: `McpSchema`
 * DECLARES `instructions: optional(Schema.String)` on `InitializeResult`, while `layerStdio`'s
 * options are `{name, version, protocols, extensions}`, so there is not even an argument to pass,
 * and the handler that builds the result supplies none.
 *
 * **TOOL DESCRIPTIONS are this server's only guidance channel.** That consequence is recorded here,
 * beside the field a maintainer would come looking for, rather than in a doc. It is why
 * `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` in `tools.ts` are shared constants appended to every
 * description they apply to, and why they read as prose to an agent rather than as reference notes to a
 * maintainer. Do not patch the dependency; revisit this when effect wires the field, at which point the
 * duplicated prose can move up here.
 */
export const layerServer = (repoOverride?: string | undefined) =>
  Layer.mergeAll(McpServer.toolkit(MemhtmlToolkit), Resources).pipe(
    Layer.provide(ToolHandlers),
    Layer.provide(
      McpServer.layerStdio({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        // The protocol revision is the caller's to state, and `v2025_06_18` is the only adapter this
        // dependency ships. Naming it here keeps a future revision an explicit, reviewable choice
        // rather than a default that moves the wire format under a shipped client.
        protocols: [McpProtocol.v2025_06_18]
      })
    ),
    Layer.provide(layerApp(repoOverride)),
    Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
  )

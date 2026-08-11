import { layerApp } from "@memhtml/cli"
import { Layer, Logger } from "effect"
import { McpServer } from "effect/unstable/ai"

import { ToolHandlers } from "./handlers.js"
import { Resources } from "./resources.js"
import { MemhtmlToolkit } from "./tools.js"

export const SERVER_NAME = "memhtml"
export const SERVER_VERSION = "0.1.0"

/**
 * The server as one layer: fourteen tools, two resources, over the CLI's own `AppLive`.
 *
 * The same composition the CLI builds, deliberately. An MCP server with its own layer graph would be
 * a second set of answers to which database file, which git root, and which vector space — and an
 * agent whose `memory_write` landed in one repo while its operator's `memhtml search` read another would
 * be very hard to diagnose from either side.
 *
 * **`Logger.LogToStderr` is not optional here.** Effect's default logger writes to stdout, and stdout
 * on this transport is the NDJSON-RPC stream: one log line would corrupt the frame a client is
 * mid-parse on. The CLI sets the same reference for the same reason, one fd over.
 *
 * **There is no server-level `instructions` here, and it is not an omission.** MCP defines an
 * `instructions` field on the initialize response for exactly the cross-tool guidance this server wants
 * to give — when to batch, the three doors, the commit duty — and effect 4.0.0-beta.102 does not emit
 * it. Verified in the dependency's own source: `McpSchema.ts:701` DECLARES
 * `instructions: optional(Schema.String)` on the initialize result, and the handler that builds that
 * result (`McpServer.ts:1497-1501`) returns `{capabilities, serverInfo, protocolVersion}` and nothing
 * else, with no path to supply one — `layerStdio`'s options are `{name, version, extensions}`
 * (`McpServer.ts:683-687`), so there is not even an argument to pass.
 *
 * The consequence, which is why this is recorded where a maintainer would come looking for the field
 * rather than in a doc: **TOOL DESCRIPTIONS are this server's only guidance channel.** That is why
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
        version: SERVER_VERSION
      })
    ),
    Layer.provide(layerApp(repoOverride)),
    Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
  )

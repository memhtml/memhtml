import { layerApp } from "@memhtml/cli"
import { layerTelemetry } from "@memhtml/telemetry"
import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/ai"

import { ToolHandlers } from "./handlers.js"
import { Resources } from "./resources.js"
import { MemhtmlToolkit } from "./tools.js"

export const SERVER_NAME = "memhtml"
export const SERVER_VERSION = "0.17.0" // x-release-please-version

/**
 * The server as one layer: fifteen tools, two resources, over the CLI's own `layerApp`.
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
 * **There is no server-level `instructions` here yet.** MCP defines an `instructions` field on the
 * initialize response for exactly the cross-tool guidance this server wants to give (when to batch,
 * the three doors, the commit duty). effect wires it: verified against effect 4.0.6 in the
 * dependency's own source, `layerStdio` takes an `instructions` option and the initialize handler
 * returns it on `InitializeResult`. The call below passes none, so the initialize response carries
 * no `instructions`.
 *
 * **TOOL DESCRIPTIONS are this server's only guidance channel today.** That consequence is recorded
 * here, beside the field a maintainer would come looking for, rather than in a doc. It is why
 * `BATCH_GUIDANCE` and `ARTICLE_HTML_CONTRACT` in `tools.ts` are shared constants appended to every
 * description they apply to, and why they read as prose to an agent rather than as reference notes to a
 * maintainer. The duplicated cross-tool prose can move up here, into the `instructions` option; until
 * it does, the descriptions are the only place an agent reads it.
 */
export const layerServer = (repoOverride?: string | undefined) =>
  Layer.mergeAll(McpServer.toolkit(MemhtmlToolkit), Resources).pipe(
    Layer.provide(ToolHandlers),
    Layer.provide(
      McpServer.layerStdio({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        // The protocol revision is the caller's to state. effect 4.0.6 ships five adapters
        // (`v2024_11_05`, `v2025_03_26`, `v2025_06_18`, `v2025_11_25`, `v2026_07_28`), and this
        // server names one. Naming it here keeps another revision an explicit, reviewable choice
        // rather than a default that moves the wire format under a shipped client.
        protocols: [McpProtocol.v2025_06_18]
      })
    ),
    Layer.provide(layerApp(repoOverride)),
    /**
     * The tracer, below the app layer so every `Effect.withSpan` in the graph exports — one trace
     * per tool call for the lifetime of the process. Opt-in: `OTEL_EXPORTER_OTLP_ENDPOINT` unset
     * means `Layer.empty` and no exporter module is even loaded. The exporter writes nothing to
     * stdout (the RPC stream); its one collector-down warning goes through the logger, which the
     * line below points at stderr.
     */
    Layer.provide(layerTelemetry({ serviceName: "memhtml-mcp" })),
    Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
  )

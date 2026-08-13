/**
 * `@memhtml/mcp` is the `memhtml-mcp` stdio server: fourteen tools and two resources over the memory repo.
 *
 * Sleep is deliberately absent from the tool surface. It is a cron/operator action producing a
 * reviewable branch. A run rewrites confidence across the corpus, archives memories, and creates a
 * branch a human is expected to read, so `memhtml sleep run` is its entry point and no tool fires it.
 */

export { mcpSuggestionsFor, ToolFailure, toToolFailure } from "./failure.js"
export type { AppServices } from "./handlers.js"
export { ToolHandlers } from "./handlers.js"
export { FileResource, RESOURCE_TEMPLATES, Resources, SleepResource } from "./resources.js"
export { layerServer, SERVER_NAME, SERVER_VERSION } from "./server.js"
export { MemhtmlToolkit, TOOL_NAMES, type ToolName } from "./tools.js"

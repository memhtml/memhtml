/**
 * `@memhtml/mcp` is the `memhtml-mcp` stdio server: fifteen tools and two resources over the memory repo.
 *
 * Curation is deliberately absent from the tool surface. It is an operator action producing a
 * reviewable branch a human is expected to read, so no tool fires it.
 */

export { mcpSuggestionsFor, ToolFailure, toToolFailure } from "./failure.js"
export type { AppServices } from "./handlers.js"
export { ToolHandlers } from "./handlers.js"
export {
  FileResource,
  PinnedResource,
  pinnedUri,
  RESOURCE_TEMPLATES,
  Resources
} from "./resources.js"
export { layerServer, SERVER_NAME, SERVER_VERSION } from "./server.js"
export { MemhtmlToolkit, TOOL_NAMES, type ToolName } from "./tools.js"

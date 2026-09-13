/**
 * `@memhtml/integrations`: wire a coding agent to a memhtml store.
 *
 * Pure rendering and file transactions only. Nothing here opens the store or runs retrieval; the
 * `memhtml hook` engine that does lives in `apps/cli`, and calls the dialect renderers exported here to
 * speak each host's hook protocol.
 *
 * Two barrels sit under this one so the modules can be authored independently: `primitives.ts` is the
 * file layer (atomic writes, JSON/TOML/Markdown fragment editing, the receipt), `render.ts` is the
 * content layer (the instruction block, the skill, each host's hook and MCP config shapes, the OpenCode
 * plugin, the shell snippet). `hosts.ts` and `transaction.ts` compose the two into install, uninstall,
 * list, and doctor.
 */

export * from "./dialect.js"
export * from "./errors.js"
export * from "./hosts.js"
export * from "./primitives.js"
export * from "./render.js"
export * from "./transaction.js"
export * from "./types.js"

/**
 * The content layer: pure functions from options to the bytes a host's config, instruction file, skill,
 * or plugin needs. Nothing here touches the filesystem, reads env, or opens the store — the file layer
 * (`primitives.ts`) writes what these return, and `transaction.ts` decides when.
 *
 * Splitting it this way is what makes every host's rendered output testable without a HOME to install
 * into, so a vendor's config shape can be asserted byte for byte.
 */

export * from "./command-line.js"
export * from "./render/block.js"
export * from "./render/hooks.js"
export * from "./render/mcp.js"
export * from "./render/plugin.js"
export * from "./render/skill.js"
export * from "./shell.js"

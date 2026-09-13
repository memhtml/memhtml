/**
 * The transaction layer: install, uninstall, list, doctor, and the binary they all record.
 *
 * One barrel over four modules, split by verb rather than by host. `install.ts` owns the plan and the
 * all-or-nothing write; `uninstall.ts` reverses exactly what the receipt claims; `list.ts` reports state;
 * `doctor.ts` proves the wiring, ending with a live MCP handshake. `locate.ts` resolves which binary an
 * install writes into a config, which is the one fact all four share.
 *
 * Everything here is a plain async function over `hosts.ts`'s registry, `primitives.ts`'s file layer, and
 * `render.ts`'s content layer. Nothing opens the store, builds an Effect layer, or reads the environment —
 * the CLI resolves `$HOME`, the git top level, and the store root and hands them in, so these functions
 * are drivable against a temp directory and every path they touch is one the caller named.
 */

export * from "./doctor.js"
export * from "./install.js"
export * from "./list.js"
export * from "./locate.js"
export * from "./uninstall.js"

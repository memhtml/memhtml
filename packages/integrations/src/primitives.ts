/**
 * The file layer: hashing, atomic writes, snapshot/restore, the four config-format adapters, the receipt.
 *
 * Everything here is a plain async or pure function. The content layer (`render.ts`) decides WHAT to
 * write, `transaction.ts` decides WHEN and in what order, and this layer is the only one that touches
 * disk or parses a config format — so a new host adds a renderer, not a new way to edit JSON.
 */

export * from "./adapters/fenced.js"
export * from "./adapters/json.js"
export * from "./adapters/markdown.js"
export * from "./adapters/shellrc.js"
export * from "./adapters/toml.js"
export * from "./fs.js"
export * from "./receipt.js"

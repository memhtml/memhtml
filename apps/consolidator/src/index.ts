/**
 * The consolidator app's public surface: the contract, and the client that satisfies it.
 *
 * A standalone app, NOT a `@memhtml/*` library. Nothing here may be reached from a `@memhtml/*` read
 * path, per `.erpaval` lesson `performance/synchronous-detector-on-untrusted-write-path.md` and §8 of
 * the task packet. So no barrel in `packages/*` re-exports this, and only the sleep phase that
 * owns trace consolidation depends on it.
 */
export * from "./client.js"
export * from "./contract.js"
/**
 * The LLM-proxy environment reader is exported for one consumer: `apps/cli/tests/llm-proxy-parity.test.ts`,
 * which pins this app's dependency-free copy to `@memhtml/llm`'s original. Production callers read the
 * environment through `hasConsolidatorCredentials` and the agent file, never through this export.
 */
export * from "./llm-proxy.js"
/**
 * The model, tools, and turn are exported for the test tier and for a reader tracing a run; the
 * production caller reaches them only through `makeConsolidator`.
 */
export * from "./model.js"
/**
 * The mount composition is exported because `memhtml exec` builds on it: one shared helper rather than
 * the same `MountableFs` + read-only `OverlayFs` shape written twice, and this package is where
 * `just-bash` is a real dependency pinned to the version eve loads.
 */
export * from "./mount.js"
export * from "./output-budget.js"
export * from "./tools.js"
export * from "./turn.js"

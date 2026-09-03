/**
 * The consolidator app's public surface: the contract, and the client that satisfies it.
 *
 * A standalone app, NOT a `@memhtml/*` library. Nothing here may be reached from a `@memhtml/*` read
 * path, per `.erpaval` lesson `performance/synchronous-detector-on-untrusted-write-path.md` and §8 of
 * the task packet. So no barrel in `packages/*` re-exports this, and only the sleep phase that
 * owns trace consolidation depends on it.
 */
export * from "./client.js"
/**
 * The per-command sandbox bound is exported for the composition root, which reads the operator's
 * `MEMHTML_CONSOLIDATOR_COMMAND_TIMEOUT_MS` through `parseCommandTimeoutMs` so the CLI and the client
 * cannot disagree about what a valid value is. `agent/tools/bash.ts` reaches the same module by
 * relative path from inside eve's build.
 */
export * from "./command-bound.js"
export * from "./contract.js"
/**
 * The LLM-proxy environment reader is exported for one consumer: `apps/cli/tests/llm-proxy-parity.test.ts`,
 * which pins this app's dependency-free copy to `@memhtml/llm`'s original. Production callers read the
 * environment through `hasConsolidatorCredentials` and the agent file, never through this export.
 */
export * from "./llm-proxy.js"
/**
 * The mount composition is exported because `memhtml exec` builds on it: one shared helper rather than
 * the same `MountableFs` + read-only `OverlayFs` shape written twice, and this package is where
 * `just-bash` is a real dependency pinned to the version eve loads.
 */
export * from "./mount.js"
/**
 * The run credential is exported because `agent/channels/eve.ts` imports it, and that file is compiled
 * by eve into the SERVER process. That is a different build than this package's `tsc -b`, reaching
 * `src/` by relative path exactly as `agent/sandbox/sandbox.ts` reaches `mount.ts`. Nothing outside
 * this app consumes it: the client mints and signs, the channel verifies, and there is no third caller.
 */
export * from "./run-auth.js"

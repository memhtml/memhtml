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

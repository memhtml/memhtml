import { throwawayRootGlobalSetup } from "@memhtml/store/testing"

/**
 * Vitest `globalSetup`: before the run, remove a stale throwaway root; after it, fail the run if any
 * test opened the pinned `MEMHTML_ROOT` (issue #144). The pin itself is `env` in `vitest.config.ts`.
 */
export default throwawayRootGlobalSetup

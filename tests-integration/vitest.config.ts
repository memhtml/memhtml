import { throwawayTestEnv } from "@memhtml/store/testing"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * The same pin `apps/cli` carries (issue #144). The harness threads `--repo` on every call and the
     * spawned binaries inherit this environment, so anything that drops the flag lands in a throwaway
     * under the temp dir, and the teardown fails the run if one did.
     */
    env: throwawayTestEnv(),
    globalSetup: ["./tests/throwaway-root.setup.ts"],
    /**
     * Every test here drives a real git repository and a real database through the whole stack, and
     * several of them run a fifteen-phase sleep cycle. The default five seconds would time out on the
     * work rather than on a defect.
     */
    testTimeout: 180_000,
    hookTimeout: 180_000,
    /**
     * One file at a time. These suites each `git init` a temp repo and open a SQLite database on disk,
     * and running them concurrently on one machine makes the timings — not the assertions — decide
     * whether they pass.
     */
    fileParallelism: false
  }
})

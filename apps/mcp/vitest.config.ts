import { throwawayTestEnv } from "@memhtml/store/testing"
import { defineConfig } from "vitest/config"

/**
 * The same pin `apps/cli` carries (issue #144). These tests build their layer with an explicit repo,
 * and `layerServer()` with no override would build it from `MEMHTML_ROOT`, so the environment a test
 * here can reach is a throwaway under the temp dir, and the teardown fails the run if one did.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: throwawayTestEnv(),
    globalSetup: ["./tests/throwaway-root.setup.ts"]
  }
})

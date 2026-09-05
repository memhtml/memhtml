import { throwawayTestEnv } from "@memhtml/store/testing"
import { defineConfig } from "vitest/config"

/**
 * `env` pins `MEMHTML_ROOT` to a throwaway under the temp dir, turns both network edges off, and sets
 * `MEMHTML_REFUSE_ENV_ROOT`, so an in-process `run()` that names no repo is refused at exit 2 and a
 * layer built from the environment by any other path can only ever touch a directory nothing else
 * uses (issue #144: a help mutant rebuilt a developer's live index). The `globalSetup` teardown fails
 * the run if anything created that directory, and `tests/help.test.ts` asserts the pin is in force,
 * so no half of this can be removed in silence. Tests that assert an exec or apply usage code
 * decided below the refusal thread `--repo`; `refuse-env-root.test.ts` sets its own values per case.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: throwawayTestEnv(),
    globalSetup: ["./tests/throwaway-root.setup.ts"]
  }
})

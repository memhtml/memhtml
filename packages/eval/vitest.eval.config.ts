import { defineConfig } from "vitest/config"

/**
 * The `test:eval` tier: the refusable discrimination gate.
 *
 * Its own config because design §9 makes this a separate turbo task rather than a unit test — it
 * generates a 300-file corpus into a temp git repo, indexes it, and runs 36 probes through the real
 * four-arm fold. `fileParallelism: false` because each suite `git init`s a repo and opens a database,
 * and running them at once makes the timings rather than the assertions decide the outcome.
 */
export default defineConfig({
  test: {
    include: ["eval/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false
  }
})

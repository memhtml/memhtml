import { defineConfig } from "vitest/config"

/**
 * The browser tier. One file, one worker: each suite opens a Chromium and a static server on a real
 * port, and running them in parallel would put several browsers on a two-core CI runner competing
 * for the same measurement.
 */
export default defineConfig({
  test: {
    include: ["tests/a11y.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000
  }
})

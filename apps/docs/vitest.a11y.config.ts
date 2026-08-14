import { defineConfig } from "vitest/config"

/**
 * The browser tier: the accessibility audit and the layout-stability probe. One worker, never
 * parallel — each suite opens a Chromium and a static server on a real port, and running them at
 * once would put several browsers on a two-core CI runner competing for the same measurement. The
 * layout probe is the sharper case for that: it measures WHEN things move, so a second browser
 * stealing the CPU is not noise around its answer, it is a different answer.
 */
export default defineConfig({
  test: {
    include: ["tests/a11y.test.ts", "tests/layout-stability.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000
  }
})

import { defineConfig } from "vitest/config"

/**
 * The default tier: everything that needs no browser.
 *
 * The two browser suites are excluded rather than left to be discovered. They drive Chromium, so
 * folding them in here would make `mise run test` — and `mise run test-pkg docs` — require a 150 MB
 * browser download to run a string assertion, and it would run them a second time in a tier with no
 * `fileParallelism: false`, putting two browsers on one runner while one of them measures WHEN the
 * layout settles. They have their own task and their own config.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/a11y.test.ts",
      "tests/layout-stability.test.ts",
      "**/node_modules/**",
      "**/dist/**"
    ]
  }
})

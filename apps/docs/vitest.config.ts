import { defineConfig } from "vitest/config"

/**
 * The default tier: everything that needs no browser.
 *
 * `tests/a11y.test.ts` is excluded rather than left to be discovered. It drives Chromium, so folding
 * it in here would make `mise run test` — and `mise run test-pkg docs` — require a 150 MB browser
 * download to run a string assertion. It has its own task and its own config.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/a11y.test.ts", "**/node_modules/**", "**/dist/**"]
  }
})

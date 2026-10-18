import { defineConfig } from "vitest/config"

/**
 * `testTimeout: 30_000`, matching `@memhtml/index` and `@memhtml/html`.
 *
 * Every case here drives real git in a temporary repository, one subprocess per plumbing call. Vitest's
 * 5-second default is a limit on that work rather than on a defect: measured on 2026-10-18, the slowest
 * cases take 1.7 to 3.0 s with the package to itself and passed 5 s under a parallel `pnpm check` on a
 * loaded host, so the failure reported machine load. Thirty seconds is what the other heavy suites use.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 }
})

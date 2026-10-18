import { defineConfig } from "vitest/config"

/**
 * `testTimeout: 30_000`, matching `@memhtml/index`, `@memhtml/html`, and `@memhtml/session`.
 *
 * Most cases drive real git in a temporary repository. On 2026-10-18 the suite passed alone (200
 * tests) and hit Vitest's 5-second default only under a parallel `pnpm check` on a loaded host, so
 * the failure reported machine load, not a defect.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 }
})

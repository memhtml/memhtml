import { defineConfig } from "vitest/config"

/**
 * `testTimeout: 30_000`, matching `@memhtml/index`.
 *
 * Every test here drives a REAL temp-dir git repository and a real in-memory Turso with the shipped
 * migrations, and several run the whole fifteen-phase cycle — the fixed-point test runs it three times
 * over. Vitest's 5-second default is a limit on the WORK rather than on a defect: measured, that test
 * times out at 5s under a parallel `turbo run test` across twelve packages while passing in ~5s when the
 * package runs alone, so the failure reported machine load and not a regression.
 *
 * A timeout has to be long enough that hitting it means something is actually wrong. Thirty seconds is
 * what `@memhtml/index` already uses for the same reason, so the two heaviest suites now agree.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 }
})

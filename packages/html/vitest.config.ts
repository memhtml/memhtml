import { defineConfig } from "vitest/config"

/**
 * `testTimeout: 30_000`, matching `@memhtml/index` and `@memhtml/sleep`.
 *
 * The reference-fidelity cases in `tests/detect.test.ts` call `detect()`, and the FIRST such call in a
 * worker pays for loading highlight.js's grammar registry — a one-time cost that lands on whichever
 * case happens to run first rather than on the case that deserves it. Vitest's 5-second default is a
 * limit on that work rather than on a defect: measured, the first case takes ~1.5s with the package to
 * itself and exceeds 5s under a parallel `turbo run test` across twelve packages, so the failure
 * reports machine load and not a shifted confidence.
 *
 * A timeout has to be long enough that hitting it means something is actually wrong, and the grammar
 * load is bounded work. Thirty seconds is what the other two heavy suites already use.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 }
})

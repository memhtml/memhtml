import { defineConfig } from "vitest/config"

/**
 * The fast tier: the pure generator and the control-family suites.
 *
 * The discrimination gate itself lives under `eval/` behind `vitest.eval.config.ts` and the
 * `test:eval` turbo task, per design §9 — it builds a git repo, indexes 300 files, and runs 36 probes
 * through the whole ranking stack, so it is a refusable GATE rather than a unit test. Keeping the two
 * apart is what lets `pnpm test` stay fast while `pnpm check` still runs both.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 }
})

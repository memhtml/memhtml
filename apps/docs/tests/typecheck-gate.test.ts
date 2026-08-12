import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Why this package's typecheck task is `astro check` and not `tsc`.
 *
 * `tsc` does not read `.astro` files at all and `astro build` does not typecheck, so a type error
 * inside a component is invisible to both — measured against exactly the input in
 * `tests/fixtures/type-error.astro.txt`. `astro check` is the only task that refuses it, and this
 * test is what keeps the task from being swapped for a cheaper one that reports nothing.
 *
 * The probe is written into `src/components/` because that is where a component would live, and it is
 * removed in a `finally`: a leftover probe would fail every later build for a reason that has nothing
 * to do with the change under review.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = join(root, "src", "components", "type-error-probe.astro")

const runAstro = (command: string) =>
  spawnSync("pnpm", ["exec", "astro", command], { cwd: root, encoding: "utf8" })

describe("the typecheck gate", () => {
  it("refuses a type error in a component that the build accepts", () => {
    const fixture = readFileSync(join(root, "tests", "fixtures", "type-error.astro.txt"), "utf8")
    mkdirSync(dirname(probe), { recursive: true })
    writeFileSync(probe, fixture)
    try {
      const checked = runAstro("check")
      expect(checked.status).not.toBe(0)
      expect(`${checked.stdout}${checked.stderr}`).toContain("type-error-probe.astro")

      const built = runAstro("build")
      expect(built.status).toBe(0)
    } finally {
      rmSync(probe, { force: true })
      // Leave no directory behind that this test invented, but never remove one holding a component.
      if (readdirSync(dirname(probe)).length === 0) rmSync(dirname(probe), { recursive: true })
    }
  }, 300_000)
})

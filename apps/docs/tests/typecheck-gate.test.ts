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
 *
 * Because it puts a broken file into this package's own source tree, it must not run beside a sibling
 * `astro check`. `turbo.json` gives `@memhtml/docs#test` a dependency on `typecheck` for exactly that
 * reason — without it the two run concurrently and the package's real typecheck fails on this test's
 * probe, which reads as a defect in whatever change happens to be under review.
 *
 * Its `astro build` writes somewhere other than `dist/`, so a run of this test never leaves the
 * published output describing a component that exists only to be broken.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = join(root, "src", "components", "type-error-probe.astro")
const probeOut = join(root, "dist-typecheck-probe")

const runAstro = (command: string, args: ReadonlyArray<string> = []) =>
  spawnSync("pnpm", ["exec", "astro", command, ...args], { cwd: root, encoding: "utf8" })

describe("the typecheck gate", () => {
  it("refuses a type error in a component that the build accepts", () => {
    const fixture = readFileSync(join(root, "tests", "fixtures", "type-error.astro.txt"), "utf8")
    mkdirSync(dirname(probe), { recursive: true })
    // Clear any probe a HARD-KILLED run left behind. The `finally` below is the normal path, and a
    // SIGKILL bypasses it — after which the leftover fails this package's real `typecheck` on every
    // later change, reading as a defect in whatever is under review rather than as debris. Removing it
    // here makes that state self-healing on the next run instead of a manual discovery.
    rmSync(probe, { force: true })
    writeFileSync(probe, fixture)
    try {
      const checked = runAstro("check")
      expect(checked.status).not.toBe(0)
      expect(`${checked.stdout}${checked.stderr}`).toContain("type-error-probe.astro")

      const built = runAstro("build", ["--outDir", probeOut])
      expect(built.status).toBe(0)
    } finally {
      rmSync(probe, { force: true })
      rmSync(probeOut, { force: true, recursive: true })
      // Leave no directory behind that this test invented, but never remove one holding a component.
      if (readdirSync(dirname(probe)).length === 0) rmSync(dirname(probe), { recursive: true })
    }
  }, 300_000)
})

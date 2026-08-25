import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

const read = (name: string): string => readFileSync(join(REPO_ROOT, name), "utf8")

interface RootManifest {
  readonly scripts: Readonly<Record<string, string>>
}

const rootManifest = JSON.parse(read("package.json")) as RootManifest
/** turbo.json carries comments, so it is read as text — the assertions here are about one key. */
const turbo = read("turbo.json")
const biome = JSON.parse(read("biome.json")) as {
  readonly files: { readonly includes: readonly string[] }
}
const lefthook = read("lefthook.yml")

/**
 * That the set of files biome LINTS is the set of files biome FORMATS, and that CI reads it.
 *
 * Each of the thirteen packages lints narrow paths (`biome check src tests`) while `pnpm format`
 * writes over `.`, so a per-package union is a smaller set than the formatter's: `scripts/*.mjs`
 * (including the script the release smoke depends on), `apps/cli/guest/corpus.mjs`,
 * `tests-integration/probe-*.mjs`, `tsdown.config.ts`, and every package's `vitest.config.ts` sit
 * outside every package's paths. The root `//#lint:repo` task is the one `biome check .` that makes
 * the two sets equal, and it makes `biome.json`'s `files.includes` the single declaration of the
 * surface.
 *
 * There is no per-file census here on purpose: the argument is `.`, so a new file is covered by
 * construction, and what has to be gated instead is that the argument stays `.` and that `check`
 * still names the task.
 */

const script = (name: string): string => {
  const value = rootManifest.scripts[name]
  expect(value, `the root package.json defines a \`${name}\` script`).toBeTypeOf("string")
  return value ?? ""
}

/** The paths a script hands biome, flags dropped — the surface, independent of how it is checked. */
const biomePaths = (source: string): readonly string[] => {
  const invocation = source
    .split("&&")
    .map((part) => part.trim())
    .find((part) => part.startsWith("biome check"))
  expect(invocation, `a \`biome check\` invocation in: ${source}`).toBeTypeOf("string")
  return (invocation ?? "")
    .split(/\s+/)
    .slice(2)
    .filter((token) => !token.startsWith("-"))
}

/** The task names a `turbo run …` script drives. */
const turboTasks = (source: string): readonly string[] => {
  expect(source.startsWith("turbo run "), `${source} drives turbo`).toBe(true)
  return source.slice("turbo run ".length).split(/\s+/)
}

describe("the biome lint surface", () => {
  it("checks exactly what `format` writes", () => {
    // The invariant, stated as an equality rather than as two path lists nobody compares: a file
    // that formatting rewrites and linting never reads is a file whose formatting no gate defends.
    expect(biomePaths(script("lint:repo"))).toEqual(biomePaths(script("format")))
  })

  it("is reached by `check`, which is what CI runs", () => {
    /**
     * Three declarations have to agree, and none of them implies the others: the root package.json
     * defines the script, turbo.json addresses it with the `//#` root-package prefix (a bare
     * `lint:repo` key would address a per-package task no package defines), and `check` names it in
     * its task list. `//#lint:md` is the same shape, which is the precedent this follows.
     */
    expect(turbo).toContain('"//#lint:repo"')
    expect(turboTasks(script("check"))).toContain("lint:repo")
    expect(turboTasks(script("lint"))).toContain("lint:repo")
  })

  it("is formatted on commit for every extension it lints", () => {
    /**
     * lefthook's pre-commit biome job matches by extension, and biome.json's `files.includes` names
     * the linted extensions. A drift either way is a broken loop: an extension CI lints but the hook
     * does not format means every commit of such a file arrives unformatted and fails the gate, and
     * an extension the hook rewrites but no include names is a file being edited by a tool no gate
     * reads.
     */
    const linted = new Set(
      biome.files.includes
        .map((include) => /^\*\*\/\*\.([a-z]+)$/.exec(include)?.[1])
        .filter((extension): extension is string => extension !== undefined)
    )
    const staged = new Set(
      (/glob: "\*\.\{([^}]+)\}"/.exec(lefthook)?.[1] ?? "").split(",").map((part) => part.trim())
    )
    expect(linted.size, "biome.json names its extensions as **/*.EXT includes").toBeGreaterThan(0)
    expect(staged).toEqual(linted)
  })
})

import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The workspace catalog's own invariant: Effect v4 is a pre-release whose four packages are a
 * SET, and `pnpm-workspace.yaml` holds them at one version string.
 *
 * This tier is the right home because the subject is the repo, not a package: no single package's
 * suite can see all three declarations, and `mise run build` cannot see them either — a catalog
 * whose entries disagree resolves and typechecks, because each package imports only the one it
 * declares. `effect@rc.109` beside `@effect/vitest@beta.107` is two copies of the runtime in one
 * `node_modules`, where a `Layer` built by the test helper and a `Layer` consumed by the code
 * under test come from different modules — a failure that surfaces as a mismatched `_tag` or a
 * missing service at run time, far from its cause, and only in whichever suites happen to cross
 * that seam.
 *
 * The declaration is asserted rather than the resolution, because the resolution is downstream:
 * `pnpm install` can only produce one string per catalog entry, so a lockfile that disagrees with
 * this file is a lockfile that was never regenerated.
 */

/** The catalog entry name and the value on its line, for every `catalog:` key. */
const readCatalog = async (): Promise<ReadonlyMap<string, string>> => {
  const source = await readFile(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8")
  const lines = source.split("\n")
  const start = lines.indexOf("catalog:")
  expect(start, "pnpm-workspace.yaml declares a top-level `catalog:` block").toBeGreaterThanOrEqual(
    0
  )

  const entries = new Map<string, string>()
  for (const line of lines.slice(start + 1)) {
    // The block ends at the first line that is neither indented nor blank.
    if (line.trim() !== "" && !line.startsWith("  ")) break
    const matched = /^ {2}"?([^":]+)"?:\s*(\S+)\s*$/.exec(line)
    if (matched?.[1] !== undefined && matched[2] !== undefined) {
      entries.set(matched[1], matched[2])
    }
  }
  return entries
}

/** Every workspace manifest, by its directory, so a declaration can be attributed. */
const readManifests = async (): Promise<
  ReadonlyMap<string, Record<string, Record<string, string> | undefined>>
> => {
  const manifests = new Map<string, Record<string, Record<string, string> | undefined>>()
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(REPO_ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(parent, entry.name)
      manifests.set(
        dir,
        JSON.parse(await readFile(join(REPO_ROOT, dir, "package.json"), "utf8")) as Record<
          string,
          Record<string, string> | undefined
        >
      )
    }
  }
  manifests.set(
    "tests-integration",
    JSON.parse(
      await readFile(join(REPO_ROOT, "tests-integration", "package.json"), "utf8")
    ) as Record<string, Record<string, string> | undefined>
  )
  return manifests
}

const EFFECT_SET = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/vitest"
] as const

describe("the workspace catalog", () => {
  it("holds every Effect package at ONE version string", async () => {
    const catalog = await readCatalog()

    for (const name of EFFECT_SET) {
      expect(catalog.get(name), `${name} is a catalog entry`).toBeTypeOf("string")
    }

    const distinct = new Set(EFFECT_SET.map((name) => catalog.get(name)))
    expect(
      distinct.size,
      `the Effect set must move together, got ${EFFECT_SET.map((n) => `${n}=${catalog.get(n)}`).join(", ")}`
    ).toBe(1)
  })

  it("names every Effect package the set is supposed to cover", async () => {
    /**
     * The completeness half, and the reason the assertion above cannot be trusted alone: an
     * `@effect/*` entry added to the catalog without being added to {@link EFFECT_SET} would be
     * free to drift, and a same-string check over a stale list would still pass. So the list is
     * derived from the catalog and compared, rather than assumed to be exhaustive.
     */
    const catalog = await readCatalog()
    const effectEntries = [...catalog.keys()].filter(
      (name) => name === "effect" || name.startsWith("@effect/")
    )
    expect([...effectEntries].sort()).toStrictEqual([...EFFECT_SET].sort())
  })

  it("is what every package actually declares, so no manifest pins Effect itself", async () => {
    /**
     * A catalog pins nothing it is not asked for. A manifest that wrote `"effect": "4.0.0-rc.109"`
     * instead of `"effect": "catalog:"` would satisfy the two assertions above while running a
     * different version, so the mechanism is checked as well as the value: every Effect dependency
     * in the workspace reaches its version through `catalog:`.
     */
    const offenders: string[] = []
    for (const [dir, manifest] of await readManifests()) {
      for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          const isEffect = name === "effect" || name.startsWith("@effect/")
          if (isEffect && range !== "catalog:") {
            offenders.push(`${dir}/package.json ${field}.${name} = ${range}`)
          }
        }
      }
    }
    expect(offenders).toStrictEqual([])
  })

  it("is reflected by the lockfile, so the installed tree is the declared one", async () => {
    /**
     * The declaration is the contract; this is the receipt. pnpm records the resolved catalog in
     * `pnpm-lock.yaml`, so a manifest edit that was never followed by an install shows up here as
     * a disagreement — the same condition `pnpm install --frozen-lockfile` fails on in CI, asserted
     * where the failure names the entry rather than printing a config-mismatch code.
     */
    const catalog = await readCatalog()
    const lock = await readFile(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8")
    for (const name of EFFECT_SET) {
      const version = catalog.get(name)
      const quoted = name.startsWith("@") ? `'${name}'` : name
      expect(lock, `${name} resolves to ${version} in pnpm-lock.yaml`).toContain(
        `${quoted}:\n      specifier: ${version}\n      version: ${version}`
      )
    }
  })
})

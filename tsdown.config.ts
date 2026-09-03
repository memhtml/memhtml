import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

/**
 * The published artifact: one package, `memhtml`, with two binaries.
 *
 * ## Why a bundler, and why this one
 *
 * tsdown is the library bundler this ecosystem settled on — Rolldown and Oxc underneath, and the
 * foundation of Rolldown Vite's library mode. tsup, the tool it succeeded, is unmaintained and cannot
 * emit declarations under the TypeScript 7 this repo pins. Nothing here needs declarations (the
 * published surface is two binaries and a JSON envelope, not an importable API), so `dts` is off and
 * the build is a transform plus a link.
 *
 * ## What is bundled, and what must not be
 *
 * The twelve `@memhtml/*` packages are the bundle. Every real dependency stays external, and two of
 * them MUST: `memhtml exec` reads `node-html-parser`'s published `dist/index.mjs` as BYTES to seed the
 * QuickJS guest, and `@memhtml/html` loads `highlight.js` through `createRequire` on the first
 * detection. Inlined, each becomes a module in this graph rather than a file on disk, and both break
 * with no unit-test signal. The externals are derived from the workspace manifests below rather than
 * listed, so a dependency added to any package cannot be silently absorbed.
 *
 * ## Where the assets go, and why not into `dist/`
 *
 * Five things resolve a path from their own module location at run time, and after bundling that
 * location is `dist/`. So each asset is copied to the PACKAGE ROOT, one level above the bundle, which
 * is exactly where `../migrations` and `../guest` land from a module in `dist/`:
 *
 * - `migrations/`, `state-migrations/` — `new URL("../migrations", import.meta.url)`
 * - `guest/corpus.mjs` — read as bytes by `memhtml exec`
 * - `prompts/instructions.md` — the consolidator's system prompt, read as a file from
 *   `join(packageRoot(), "prompts", "instructions.md")` in `apps/consolidator/src/instructions.ts`
 */

const WORKSPACE_PACKAGES = [
  "apps/cli",
  "apps/mcp",
  "apps/consolidator",
  "packages/contracts",
  "packages/domain",
  "packages/eval",
  "packages/html",
  "packages/index",
  "packages/llm",
  "packages/sleep",
  "packages/store",
  "packages/telemetry",
  "packages/traces"
] as const

/**
 * Every non-`@memhtml` dependency any shipped package declares, as patterns that also match SUBPATHS.
 *
 * A bare package name is not enough, and the gap is expensive rather than theoretical: this repo
 * imports `effect/unstable/cli`, `effect/unstable/ai`, and `@effect/platform-node`'s subpaths, none of
 * which a `"effect"` string matches. Externalizing only the bare specifier inlined the rest and took
 * `memhtml-mcp.mjs` from 192 kB to 1.45 MB (measured 2026-08-17), with no warning — tsdown's
 * bundled-dependency hint reports top-level names, so it stayed silent.
 *
 * Derived from the manifests rather than listed, so a dependency added to any shipped package is
 * external the moment it is declared.
 */
const externalDependencies = (): ReadonlyArray<RegExp> => {
  const names = new Set<string>()
  for (const dir of WORKSPACE_PACKAGES) {
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as {
      readonly dependencies?: Record<string, string>
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith("@memhtml/")) names.add(name)
    }
  }
  return [...names]
    .sort()
    .map((name) => new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`))
}

const OUT_DIR = "dist-package"

export default defineConfig({
  entry: {
    memhtml: "apps/cli/src/bin.ts",
    "memhtml-mcp": "apps/mcp/src/bin.ts"
  },
  outDir: `${OUT_DIR}/dist`,
  format: "esm",
  platform: "node",
  target: "node24",
  // No declarations: the contract is the two binaries and their JSON envelope, not an import surface.
  dts: false,
  // Deliberately unminified. A user's stack trace should name something a maintainer can read, and
  // the difference is ~400 kB in a package whose dependencies are two orders of magnitude larger.
  minify: false,
  sourcemap: true,
  /**
   * Only `neverBundle`. The `@memhtml/*` packages need no `alwaysBundle` entry — nothing declares them
   * as a dependency of this root, so they are not candidates for externalization and get bundled by
   * default. Naming them in `alwaysBundle` additionally force-bundles what THEY import, which drags
   * `effect`, `eve`, and `msgpackr`'s native loader into the output and takes `memhtml-mcp.mjs` from
   * 192 kB to 1.45 MB (measured 2026-08-17).
   */
  deps: {
    neverBundle: [...externalDependencies(), /^node:/]
  },
  /**
   * Directory sources, not globs. A glob plus `flatten: false` preserves each match's path relative to
   * the glob's own base, so `packages/index/migrations/**` lands as
   * `migrations/index/migrations/0001_files.sql` — a directory that exists, contains no `.sql` at its
   * top level, and therefore applies zero migrations. The symptom was `no such table: files` on the
   * first write, three steps away from the cause. A directory `from` mirrors its contents, which is
   * what the flat sets get anyway.
   *
   * `tests-integration/tests/packaging.test.ts` asserts each of these lands where the code looks for
   * it, resolved the way the code spells the path.
   */
  copy: [
    // `to` is the PARENT: a directory source keeps its own name, so `to: OUT_DIR` yields
    // `dist-package/migrations/0001_files.sql` while `to: OUT_DIR/migrations` would nest it one
    // `migrations/` deeper and leave the directory the code reads empty of `.sql`.
    { from: "packages/index/migrations", to: OUT_DIR },
    { from: "packages/index/state-migrations", to: OUT_DIR },
    { from: "apps/cli/guest", to: OUT_DIR },
    // The consolidator's system prompt, read as a FILE at run time (`src/instructions.ts`).
    { from: "apps/consolidator/prompts", to: OUT_DIR },
    { from: "README.md", to: OUT_DIR },
    { from: "LICENSE", to: OUT_DIR }
  ]
})

# The published artifact is not the workspace, and only one gate can tell

**Tags**: npm, publish, tsdown, bundling, pnpm-workspace, packaging, run-time-assets
**Modules**: tsdown.config.ts, scripts/package-manifest.mjs, scripts/smoke-package.mjs,
tests-integration/tests/packaging.test.ts

## The rule

**A green suite says nothing about what npm serves.** Every tier in this repo resolves `@memhtml/*`
through pnpm's links, where `guest/`, `agent/`, `src/`, and the two migration directories are on disk
whether or not anything declares them. `npm publish` ships only what `files` names, and a bundler moves
the emitting module away from the assets its relative paths were written against. Both blindnesses are
structural: no amount of unit, property, integration, or eval coverage can see through them.

Three assets shipped absent from every tarball under exactly that blindness, and a fourth broke the
moment bundling arrived:

| Asset | Failure | Symptom |
|---|---|---|
| `apps/cli/guest/corpus.mjs` | `files: ["dist"]` never named `guest/` | `memhtml exec` ENOENT — code mode could not start |
| `apps/consolidator/src/*.ts` | `files` named `dist` and `agent`, not `src` | `eve build` `UNRESOLVED_IMPORT` on `../../src/run-auth.js` |
| `packages/index/migrations/` | survived only because that manifest happened to name it | — |
| the same migrations, after bundling | copied by a glob to `migrations/index/migrations/` | `no such table: files` on the first write |

**So the gate has to be the artifact.** `mise run package:smoke` packs, installs into a throwaway
directory, and drives every command and MCP tool through the installed binary. It found every one of the
above. Nothing else did.

## Assertions that hold it

1. **A claim table over the source, not a list of assets.** Each claim in
   `tests-integration/tests/packaging.test.ts` names the asset, the shipper line that copies it, AND the
   source line that resolves it. A claim whose resolution has left the source fails as STALE, so a guard
   cannot outlive the thing it guards. Roughly a quarter of the regression tests written in this repo
   were vacuous until someone reverted the fix and watched them fail.
2. **A census over `import.meta.url`.** Every shipped source file that resolves a path from its own
   location is declared or a failure, at the commit that adds it. The census asserts a scanned TOTAL
   (`> 60` files) so a scan that silently matched nothing cannot pass by finding no violations in an
   empty set.
3. **Enumerate the surface from the artifact, never from a literal.** `memhtml manifest` yields the 36
   commands (the same table that drives argument parsing); `tools/list` yields the 14 MCP tools. A new
   command or tool fails a census rather than going untested. A hand-maintained list would have gone
   stale the first time either grew.
4. **A skip is not a pass.** The live tier's credential check FAILS when `--live` was asked for and no
   credential is present. A tier that quietly proves less is the failure mode the whole file exists to
   prevent.

## npm behaviours, each probed rather than assumed (2026-08-17)

Relevant to any future change of packaging strategy, and none of it is in the guides:

- **`npm pack` excludes `node_modules` unconditionally.** `files` cannot override it;
  `bundleDependencies` is the only mechanism that includes it.
- **`bundleDependencies` must be given REAL directories.** Pointed at pnpm's symlink farm it crashes npm
  itself with `Exit handler never called!`.
- **A bundled name that `dependencies` does not also list is silently ignored** — a five-file tarball
  with the whole vendored tree missing, and no warning.
- **A vendored manifest that declares dependencies is actively harmful.** npm plants a phantom EMPTY
  directory in the bundled subtree for each one, and an empty `memhtml/node_modules/effect` breaks
  `import "effect"` from every sibling.

Vendoring by `bundleDependencies` was measured and works (811.8 kB, 588 files) but is not idiomatic and
was replaced; these notes exist so the decision is not re-litigated from scratch.

## tsdown, two rules that cost real debugging

- **Externals are patterns that match SUBPATHS, derived from the manifests.** `"effect"` does not match
  `effect/unstable/cli`, and this repo imports exactly that. Externalizing only bare names inlined the
  rest and took `memhtml-mcp.mjs` from 192 kB to **1.45 MB** — silently, because tsdown's
  bundled-dependency hint reports only top-level names and printed an empty list.
- **`deps.alwaysBundle` force-bundles what the matched packages IMPORT.** Naming `@memhtml/*` there
  dragged `effect`, `eve`, and `msgpackr`'s native loader into the output. It is also unnecessary: a
  package nothing declares as a dependency of the bundling root is not a candidate for externalization
  and is bundled by default.
- **Asset copies take a directory `from` and `to: OUT_DIR`.** A glob with `flatten: false` preserves each
  match's path relative to the glob's own base, and a directory source keeps its own name — so
  `{from: "packages/index/migrations", to: OUT_DIR}` is right, while both the glob form and
  `to: OUT_DIR/migrations` nest one level deeper and leave the directory the code reads empty of `.sql`.

## Two dependencies must never be bundled, for a reason a bundler cannot infer

`memhtml exec` reads `node-html-parser`'s published `dist/index.mjs` as BYTES to seed the QuickJS guest,
and `@memhtml/html` loads `highlight.js` through `createRequire` on the first detection. A third, `eve`,
is SPAWNED. Each needs a resolvable file on disk, not a module in the graph; inlined, all three fail with
no unit-test signal. `require.resolve("eve/bin/eve.js")` additionally raises
`ERR_PACKAGE_PATH_NOT_EXPORTED` — eve's `exports` map declares no `./bin/*` subpath — so the bin is
located through `eve/package.json`, which IS exported.

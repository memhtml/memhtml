# An exact-pin manifest reaches only declared names, and a pre-release set includes its transitives

**Tags**: npm, publish, dependencies, effect-v4, catalog, ERESOLVE, transitive, pin
**Modules**: scripts/package-manifest.mjs, pnpm-workspace.yaml, apps/mcp/package.json,
tests-integration/tests/catalog.test.ts, tests-integration/tests/packaging.test.ts

## The rule

**The generated manifest pins the versions the gates ran against — but only for names a workspace
package DECLARES.** `scripts/package-manifest.mjs` walks each workspace manifest's `dependencies`
and emits exact installed versions, so every direct dependency of the artifact is frozen. A
dependency's OWN dependencies keep whatever range upstream wrote, and for a stable-semver package
that is fine — it is the same trust every npm consumer extends. For a pre-release set it is not:
the caret `^4.0.0-rc.109` admits every later rc, and Effect rcs break between versions.

Measured 2026-08-18 on a fresh `npm install -g memhtml@0.2.3`: `@effect/platform-node@4.0.0-rc.109`
(pinned) resolves its `@effect/platform-node-shared: ^4.0.0-rc.109` to **rc.110** (published the day
before, after the release's gates ran), whose peer wants `effect@^4.0.0-rc.110` — npm prints
`ERESOLVE overriding peer dependency` and installs a mixed set the repo never tested. The binaries
happened to still answer; nothing guarantees the next rc pair does.

## Fix

Declare the transitive where the generator can see it, at the set's one version string:

- `pnpm-workspace.yaml` catalog gains `"@effect/platform-node-shared": <same string>` — the Effect
  set is FOUR members, and membership includes any `@effect/*` package a member depends on.
- `apps/mcp/package.json` declares `"@effect/platform-node-shared": "catalog:"` even though no code
  imports it. That single line is what puts the exact pin into the published manifest; a consumer's
  npm then dedupes the upstream caret onto the pinned copy. No ERESOLVE, matched set.

Gates (each mutation-verified): `catalog.test.ts` derives the `@effect/*` entries from the catalog
and compares against `EFFECT_SET`, so an entry added or dropped without updating the set fails;
`packaging.test.ts` claims the apps/mcp declaration, so deleting the one load-bearing line fails at
the commit that deletes it. Dropping the catalog entry alone fails `pnpm install` outright
(`ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC`).

## Why this matters

The workspace lockfile makes transitive drift invisible locally: pnpm resolved rc.109 everywhere,
every tier was green, and the defect existed only at a consumer's install after upstream shipped
the next rc — the exact blindness of [the-published-artifact-is-not-the-workspace], on the version
axis instead of the files axis. When a set of pre-release packages must move together, enumerate
the set from what the members DEPEND ON, not from what the code imports. pnpm consumers of the
artifact still resolve upstream carets independently — only bundling the set would close that path,
and npm (this artifact's install path, and what `package:smoke` drives) is closed by the pin.

# Repository rules a dependency bump has to respect

Each of these is a mechanism, not a preference. Every one has produced a wrong outcome when ignored.

## The Effect catalog is a SET, not four entries

`pnpm-workspace.yaml`'s `catalog:` holds `effect`, `@effect/platform-node`, `@effect/platform-node-shared` and `@effect/vitest` at ONE version string. They move together or the catalog is a state the repo refuses.

Why this cannot be relaxed: a catalog whose entries disagree **resolves and typechecks**, because each package imports only the entry it declares. `effect@rc.109` beside `@effect/vitest@beta.107` is two copies of the runtime in one `node_modules`, where a `Layer` built by a test helper and a `Layer` consumed by the code under test come from different modules. That surfaces as a mismatched `_tag` or a missing service at run time, far from its cause, and only in whichever suites happen to cross the seam.

`tests-integration/tests/catalog.test.ts` is the backstop. It asserts the DECLARATION rather than the resolution, because the resolution is downstream: `pnpm install` can only produce one string per catalog entry, so a lockfile disagreeing with the file is a lockfile nobody regenerated.

Consequence for a split bot PR: **never merge one of a set.** Take the whole set to one version in a single commit.

`@effect/platform-node-shared` is in the set even though no code imports it — it is `@effect/platform-node`'s own caret-ranged dependency, and `apps/mcp` declares it so the published manifest pins it. Leave it to the caret and a consumer's installer resolves the newest rc, shipping a mixed set the gates never ran against.

## Dependabot group semantics: `update-types` excludes a prerelease move

A group naming `update-types: [major, minor, patch]` does **not** match a prerelease-to-prerelease move, so Dependabot falls back to one PR per package. Observed 2026-08-25: the `effect` group matched all four by `patterns` and still fanned out into four PRs, because rc.109 → rc.111 is none of those three types.

A `patterns`-only group matches every update type. The absence of `update-types` on the `effect` group is therefore load-bearing — restoring the list reintroduces the split.

## `minimumReleaseAge` blocks the newest release, on purpose

`pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (72 hours). A version published inside that window is **not installable**, and `pnpm install` refusing it is the policy working rather than a broken lockfile.

Consequences:

- A bot PR proposing a just-published version cannot pass CI. Take the newest version that clears the window instead of fighting the install.
- Dependabot moves faster than the window. A PR left open for a day often proposes a _newer_ version than when it was opened, so re-read the body rather than trusting an earlier reading.
- For a genuine CVE fix inside the window, override per-package with `minimumReleaseAgeExclude` — not by lowering the global number.

Run `scripts/cooldown-check.mjs --pr <n>` rather than computing ages by hand.

## `deps:` does not move a version, and that is deliberate

The commit-message hook accepts `spec`, `merge` and `deps` beyond the standard Conventional Commits set. None of the three is a release-please type, so **a dependency bump only ships when a maintainer promotes it with `fix:` or `feat:`**.

Related and easy to get wrong: a type moves a version and a scope does not save you. `fix(ci):` on something that ships nothing cuts a release PR whose changelog describes a change no consumer receives. CI-only work is `ci:`.

## Auto-merge is disabled on this repository

`gh pr merge --auto` fails with `Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`. Worse, `gh pr merge --merge` on a PR whose non-required checks are still pending **merges immediately**. Waiting for the checks is a manual loop; do not mistake a successful `gh pr merge` invocation for a gate that reported.

## Six scanners block a merge; Scorecard deliberately does not

The repository ruleset gates on CodeQL, Semgrep OSS, Trivy, Grype, osv-scanner and betterleaks. `check` and `package` are the substantive jobs and take roughly 5 and 2.5 minutes.

Scorecard is intentionally not a gate: its high findings are repo posture and `MaintainedID` scores commit cadence, so gating on it would block PRs for reasons unrelated to any diff and flip with the calendar.

## `highlight.js` and `typescript` carry standing ignore rules

Both are ignored for specific update types with the reason recorded in `.github/dependabot.yml`. Read the comment before overriding either:

- `typescript` majors are held because the name covers two roles — the compiler `tsc -b` runs at the root, and the in-process parser `apps/docs/src/loaders/repo-sources.ts` calls. `@astrojs/check` also pins a peer range that a major violates.
- `highlight.js` minors and majors are held because a language grammar's relevance scores are measured against a corpus that lives elsewhere; a red PR there can be the regression the pin exists to catch.

## The lockfile is regenerated, never merge-resolved

When a bot PR's base has moved, do not rebase its lockfile. Apply the version bumps to the `package.json` files and run `pnpm install`, which produces a lockfile that matches the declarations by construction. A hand-resolved lockfile conflict is a lockfile nobody can vouch for.

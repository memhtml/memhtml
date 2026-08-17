# Releasing

Versions are cut by [release-please][rp] from Conventional Commit subjects, and published to npm as
**one package, `memhtml`**, using [npm Trusted Publishing][tp]: OIDC, with no long-lived token in any
secret.

[rp]: https://github.com/googleapis/release-please
[tp]: https://docs.npmjs.com/trusted-publishers

## One package, two binaries

`memhtml` is the whole system. Installing it gives `memhtml` and `memhtml-mcp`, and with them the CLI,
code mode, the fifteen-phase sleep cycle, the trace indexer, the discrimination gate, and the MCP
server. There is no `@memhtml/*` package on npm: the twelve workspace packages are `private`, and
`npm publish` refuses a private package, so the assembled artifact is the only thing that can ship.

The JS API is not part of the contract yet. The published surface is the two binaries and the JSON
envelope they write. Adding an importable subpath later is a minor bump; removing one would be a
major, so the cheap direction stays available.

```bash
npm i -g memhtml     # or: npx memhtml manifest
```

## How the artifact is built

`mise run package:assemble` runs [tsdown][td] against `tsdown.config.ts` and writes `dist-package/`:
two bundled entry points in `dist/`, the run-time assets beside them, and a generated `package.json`
from `scripts/package-manifest.mjs`. tsdown is the library bundler this ecosystem settled on — Rolldown
and Oxc underneath, and the foundation of Rolldown Vite's library mode. tsup, the tool it succeeded, is
unmaintained and cannot emit declarations under the TypeScript 7 this repo pins.

[td]: https://tsdown.dev

The twelve `@memhtml/*` packages are the bundle. **Every real dependency stays external**, and two of
them must, because their FILES are read rather than imported:

| What | How it resolves | Consequence |
|---|---|---|
| `node-html-parser` | `createRequire().resolve()`, then read as BYTES into QuickJS | inlined, code mode has no file to read |
| `highlight.js` | `createRequire()` on the first detection | inlined, language detection cannot load |
| `eve` | its bin is SPAWNED, located via `eve/package.json` | inlined, the consolidator has nothing to spawn |

Externals are derived from the workspace manifests, as patterns that also match **subpaths**. A bare
name is not enough: this repo imports `effect/unstable/cli` and `@effect/platform-node`'s subpaths, and
externalizing only `"effect"` inlined the rest and took `memhtml-mcp.mjs` from 192 kB to 1.45 MB with
no warning — tsdown's bundled-dependency hint reports top-level names, so it stayed silent.

Five things resolve a path from their own module location at run time, and after bundling that location
is `dist/`. So each is copied to the **package root**, one level above the bundle, which is exactly
where `../migrations` and `../guest` land from a module in `dist/`:

| Asset | Resolved by | Copied from |
|---|---|---|
| `migrations/`, `state-migrations/` | `new URL("../migrations", import.meta.url)` | `packages/index/` |
| `guest/corpus.mjs` | `"..", "guest", "corpus.mjs"` | `apps/cli/` |
| `agent/`, `src/` | eve compiles these; `agent/` reaches `../../src/*.js` | `apps/consolidator/` |

The copies use a **directory** `from` with `to: OUT_DIR`, not a glob. A glob with `flatten: false`
preserves each match's path relative to the glob's own base, so `packages/index/migrations/**` lands as
`migrations/index/migrations/0001_files.sql` — a directory that exists, holds no `.sql` at its top
level, and applies zero migrations. The symptom was `no such table: files` on the first write, three
steps from the cause.

`publint --strict` runs over the staged package before the smoke tier. There is no `attw` step: the
package ships no types, so there is nothing for it to check.

## The gate that matters

`mise run package:smoke` assembles, lints with publint, packs, installs into a throwaway directory, and
drives twelve checks through the installed binary — the manifest, `init`, `write` (asserted against `git log`, not
against the report), `search`, migrations, code mode in the QuickJS sandbox, fifteen sleep phases, the
MCP handshake by both entry points, and the consolidator agent building outside `node_modules` and
answering `/eve/v1/health`.

**`mise run check` cannot replace it.** Check resolves `@memhtml/*` through pnpm's links, where every
asset is on disk whether or not a manifest names it. Three assets shipped broken under exactly that
blindness. Smoke is a separate CI job because it needs the registry to resolve the twelve external
dependencies, while check is offline and credential-free; smoke is credential-free too
(`MEMHTML_EMBED=off`, `MEMHTML_LLM=off`).

## The normal path

1. Merge Conventional Commits to `main`. `feat:` moves the minor, `fix:` the patch, and a `!` or a
   `BREAKING CHANGE:` footer moves the major.
2. release-please opens (and keeps updating) a release PR bumping the version and writing
   `CHANGELOG.md`.
3. Merge that PR. release-please tags the release, and the `publish` job in the same workflow run
   re-runs `pnpm check`, then `pnpm package:smoke` on the tag, then `npm publish` from
   `dist-package/`.

The version lives in **fifteen** places and release-please updates all of them from the one root
manifest: the root `package.json`, the twelve workspace manifests via `json` extra-files, and two
source constants carrying an `x-release-please-version` comment on the version's own line
(`apps/cli/src/commands.ts` `buildManifest`, `apps/mcp/src/server.ts` `SERVER_VERSION`). The generic
updater is a per-line substring match, so those comments must stay on the version's line.

The workspace manifests still move even though none of them publishes and the bundle carries none of
them. Keeping them in lockstep is bookkeeping, not a runtime requirement: a reader who opens
`packages/index/package.json` sees which release that code belongs to, and a version that never moved
would read as an unreleased package rather than as a private one.

## Cutting a specific version

Put a `Release-As:` trailer in the commit BODY:

```
chore: cut the first minor

Release-As: 0.2.0
```

Squash-merge and confirm the trailer survived with `git log -1 --format=%B`. GitHub's default *merge*
commit message drops footers, and the trailer is what release-please reads.

## First publish: the one manual sequence

Trusted publishing cannot bootstrap a package that does not exist — npm requires the package on the
registry before a trusted publisher can be configured for it (npm/cli#8544). So the first release
needs a token, exactly once. With one package this is one publish and one `npm trust`, not twelve.

Until it is done the `publish` job fails, and the log is the useful part:

```
GET .../idtoken/...?audience=npm%3Aregistry.npmjs.org  200
[WARN] Skipped OIDC: Failed token exchange request with body message: Unknown error (status code 404)
[E404] 404 Not Found - PUT https://registry.npmjs.org/memhtml - Not found
```

Read it top to bottom: GitHub issued the OIDC token (`200`, so `id-token: write` is scoped correctly
and the workflow side is fine), **npm** refused the exchange with a 404 because no trusted publisher
exists for a package that does not exist, and the unauthenticated `PUT` then 404s too. That pair on a
first release means "the bootstrap has not happened yet", not "the workflow is wrong". The same pair
AFTER bootstrapping means the trusted publisher does not match: check the workflow filename and that
`repository.url` matches the GitHub repo case-sensitively.

```bash
# 0. 2FA must be enabled on the account: npm profile enable-2fa auth-and-writes
#    `memhtml` is unscoped, so it is owned by the publishing ACCOUNT rather than by the
#    memhtml org. Transfer it afterwards if org ownership is wanted:
#      npm owner add memhtml-org-member memhtml

# 1. Land the release PR so the tag and all fifteen version sites agree, then check out the tag
#    and assemble from it. The bytes that get published have to be the bytes that were released.
git checkout v0.2.0 && pnpm install --frozen-lockfile
pnpm package:smoke            # assembles, lints, and proves the artifact works

# 2. A short-lived granular token: read-write, "Bypass 2FA" ON (required for a non-interactive
#    publish), shortest expiry. Create at https://www.npmjs.com/settings/~/tokens
cd dist-package
NODE_AUTH_TOKEN=<token> npm publish --tag latest

# 3. Register the trusted publisher, now that the package exists.
#    `--file` takes a bare filename, not a path.
npm trust github memhtml --repo memhtml/memhtml --file release-please.yml --allow-publish -y
npm trust ls memhtml

# 4. Revoke the token. It is the thing OIDC exists to remove.
npm token list && npm token revoke <id>
```

That first publish carries no provenance attestation: provenance requires a cloud-hosted CI runner and
cannot be generated from a laptop. Every release after it gets one automatically, per version.

## Repository settings this depends on

- **Allow GitHub Actions to create and approve pull requests** must be ON, or release-please fails
  with `GitHub Actions is not permitted to create or approve pull requests`.
  `default_workflow_permissions` stays `read`: every workflow here declares its own per-job
  permissions.

  It is set in **two** places and the outer one wins, which is the part worth knowing before debugging
  the inner one (probed 2026-08-14, on this repo's first release run):

  ```
  # Repository — refused while the org forbids it, with a 409 that names the reason:
  #   "The organization does not allow GitHub Actions to create or approve pull requests"
  gh api -X PUT repos/memhtml/memhtml/actions/permissions/workflow \
    -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

  # Organization — https://github.com/organizations/memhtml/settings/actions
  # ("Workflow permissions" → tick the create-and-approve box), or by API with a token
  # carrying admin:org, which a default `gh` login does NOT have:
  gh api -X PUT orgs/memhtml/actions/permissions/workflow \
    -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
  ```

  The failure is not destructive and loses no work: release-please computes every bump, pushes
  `release-please--branches--main`, and fails only on the PR call, so flipping the setting and
  re-running the workflow opens the PR from the branch already there.
- The npm trusted publisher must name `release-please.yml`, because that is the workflow whose
  `publish` job runs `npm publish`.

## The release PR runs no CI, and cannot

release-please creates its release PR with the default `GITHUB_TOKEN`, and GitHub does not start
workflow runs from `GITHUB_TOKEN` events. This is why the `publish` job runs `pnpm check` and
`pnpm package:smoke` on the tag before publishing: those steps are the ONLY gate on a release PR's
contents. Do not remove them to save minutes.

## Why one workflow with two jobs

A second workflow keyed on `release: [published]` would never fire: GitHub does not start workflow runs
from events raised by the default `GITHUB_TOKEN`, and release-please tags with that token. Keeping
release-please and publish as two jobs of one `push`-triggered workflow sidesteps the whole class of
problem, and keeps `id-token: write` scoped to the one job that publishes.

The publish job carries no `mise`, deliberately: `actions/setup-node` owns the node that writes the
OIDC `.npmrc`, and a second node on PATH is a way for the wrong `npm` to run the publish. It calls the
pnpm scripts that the mise tasks delegate to.

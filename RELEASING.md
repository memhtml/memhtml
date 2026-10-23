# Releasing

Versions are cut by [release-please][rp] from Conventional Commit subjects, and published to npm as **one package, `memhtml`**, using [npm Trusted Publishing][tp]: OIDC, with no long-lived token in any secret.

[rp]: https://github.com/googleapis/release-please
[tp]: https://docs.npmjs.com/trusted-publishers

## One package, two binaries

`memhtml` is the whole system. Installing it gives `memhtml` and `memhtml-mcp`, and with them the CLI, code mode, the trace indexer, the discrimination gate, and the MCP server. There is no `@memhtml/*` package on npm: every workspace package is `private`, and `npm publish` refuses a private package, so the assembled artifact is the only thing that can ship.

The JS API is not part of the contract yet. The published surface is the two binaries and the JSON envelope they write. Adding an importable subpath later is a minor bump; removing one would be a major, so the cheap direction stays available.

```bash
npm i -g memhtml     # or: npx memhtml manifest
```

## How the artifact is built

`mise run package:assemble` runs [tsdown][td] against `tsdown.config.ts` and writes `dist-package/`: two bundled entry points in `dist/`, the run-time assets beside them, and a generated `package.json` from `scripts/package-manifest.mjs`. tsdown is the library bundler this ecosystem settled on — Rolldown and Oxc underneath, and the foundation of Rolldown Vite's library mode. tsup, the tool it succeeded, is unmaintained and cannot emit declarations under the TypeScript 7 this repo pins.

[td]: https://tsdown.dev

The fourteen `@memhtml/*` packages are the bundle. **Every real dependency stays external**, and two of them must, because their FILES are read rather than imported:

| What               | How it resolves                                              | Consequence                             |
| ------------------ | ------------------------------------------------------------ | --------------------------------------- |
| `node-html-parser` | `createRequire().resolve()`, then read as BYTES into QuickJS | inlined, code mode has no file to read  |
| `highlight.js`     | `createRequire()` on the first detection                     | inlined, language detection cannot load |

Externals are derived from the workspace manifests, as patterns that also match **subpaths**. A bare name is not enough: this repo imports `effect/ai`, `effect/http`, `effect/observability` and `@effect/platform-node`'s subpaths, and externalizing only `"effect"` inlined the rest and took `memhtml-mcp.mjs` from 192 kB to 1.45 MB with no warning — tsdown's bundled-dependency hint reports top-level names, so it stayed silent.

Five things resolve a path from their own module location at run time, and after bundling that location is `dist/`. So each is copied to the **package root**, one level above the bundle, which is exactly where `../migrations` and `../guest` land from a module in `dist/`:

| Asset                              | Resolved by                                 | Copied from       |
| ---------------------------------- | ------------------------------------------- | ----------------- |
| `migrations/`, `state-migrations/` | `new URL("../migrations", import.meta.url)` | `packages/index/` |
| `guest/corpus.mjs`                 | `"..", "guest", "corpus.mjs"`               | `apps/cli/`       |

The copies use a **directory** `from` with `to: OUT_DIR`, not a glob. A glob with `flatten: false` preserves each match's path relative to the glob's own base, so `packages/index/migrations/**` lands as `migrations/index/migrations/0001_files.sql` — a directory that exists, holds no `.sql` at its top level, and applies zero migrations. The symptom was `no such table: files` on the first write, three steps from the cause.

`publint --strict` runs over the staged package before the smoke tier. There is no `attw` step: the package ships no types, so there is nothing for it to check.

`publishConfig` carries `access` and nothing else. It must NOT carry `provenance: false`: trusted publishing generates a SLSA attestation automatically, and an explicit `false` suppresses the one thing OIDC gives for free. The manual bootstrap needs no opt-out either — provenance requires a cloud-hosted runner, so a laptop publish produces none unless `--provenance` is passed.

## The gate that matters

`mise run package:smoke` assembles, lints with publint, packs, installs into a throwaway directory, and drives every command, every MCP tool, and every published MCP resource template through the installed binary — 88 checks as of 0.16.0. The count is not written down anywhere in the script, which reports its own `checks: results.length`, so this sentence is the only place it can drift. The surface is enumerated from the artifact itself — `memhtml manifest` for commands, `tools/list` for tools, `resources/templates/list` for resources — so a new command, tool, or template fails a census rather than going untested. Writes are asserted against `git log`, not against the report.

`resources/read` earns its own coverage because it is a second RPC family with a router of its own that no tool check reaches: a resource route can be wholly unreachable while every tool check is green. The specific hazard the census answers is depth — a named router parameter's value stops at the next `/`, every memory path has at least two segments, and an archived one has at least four.

`mise run package:smoke:live` adds the checks for the one edge nothing else can reach from an install: Bedrock embeddings through the installed binary. It spends real tokens and needs `AWS_BEARER_TOKEN_BEDROCK` (or SigV4 keys); the credential check FAILS rather than skips, because `--live` was asked for. lefthook's pre-push runs it when a credential is present and prints what goes unproven when it cannot.

**`mise run check` cannot replace it.** Check resolves `@memhtml/*` through pnpm's links, where every asset is on disk whether or not a manifest names it. Three assets shipped broken under exactly that blindness. Smoke is a separate CI job because it needs the registry to resolve the external dependencies, while check is offline. Its default mode is credential-free too (`MEMHTML_EMBED=off`, `MEMHTML_LLM=off`), which is what CI gates on; `--live` is the mode that spends tokens, and it runs pre-push rather than in CI.

## The normal path

1. Merge Conventional Commits to `main`. `feat:` moves the minor, `fix:` the patch, and a `!` or a `BREAKING CHANGE:` footer moves the major.
2. release-please opens (and keeps updating) a release PR bumping the version and writing `CHANGELOG.md`.
3. On the release PR, click **Approve workflows to run**, then wait for `check`, `package`, and CodeQL to pass before merging. Bot-created PR runs wait for this approval.
4. Merge that PR. release-please tags the release — `memhtml-v0.2.0`, component-prefixed because the package is named in the config — and the `publish` job in the same workflow run re-runs `pnpm check`, then `pnpm package:smoke` on the tag, then packs `dist-package/` once, publishes that tarball, and attests the release assets. A separate job uploads the verified assets to the GitHub release.

**A publish that fails for an environment reason is retryable without cutting another version.** The workflow takes a `workflow_dispatch` with a `tag` input for exactly that:

```bash
gh workflow run release-please.yml -f tag=memhtml-v0.2.0
```

The staging log reports `publish: "true"` when npm has no version matching the tag, so the workflow publishes the packed tarball. It reports `publish: "false"` when that version already exists, so the workflow skips npm publication and restages, attests, and reuploads the assets. Registry lookup failures stop the run; only an explicit package-not-found response or a successful version list that omits the version means unpublished. A retry compares the packed tarball's SHA512 integrity with npm's metadata. If rebuilding produced different bytes, it downloads the actual published tarball and verifies that integrity before generating the SBOM and attestations. It never overwrites the npm version. `--clobber` replaces the release's asset copies after all local and cryptographic checks pass.

The retry must run this workflow from a revision containing the asset pipeline, against a tag that contains `scripts/release-assets.mjs`. It does not add assets to older tags that predate it.

This exists because the first real release failed that way: the publish job had no mise, so the `d2` binary was absent, and the docs build inside `pnpm check` died in `astro:config:setup` — nothing to do with the bytes being published.

The version lives in **seventeen** places and release-please updates all of them from the one root manifest: the root `package.json`, the fourteen workspace manifests via `json` extra-files, and two source constants carrying an `x-release-please-version` comment on the version's own line (`apps/cli/src/commands.ts` `buildManifest`, `apps/mcp/src/server.ts` `SERVER_VERSION`). The generic updater is a per-line substring match, so those comments must stay on the version's line.

The workspace manifests still move even though none of them publishes and the bundle carries none of them. Keeping them in lockstep is bookkeeping, not a runtime requirement: a reader who opens `packages/index/package.json` sees which release that code belongs to, and a version that never moved would read as an unreleased package rather than as a private one.

## Cutting a specific version

Put a `Release-As:` trailer in the commit BODY:

```
chore: cut the first minor

Release-As: 0.2.0
```

Squash-merge and confirm the trailer survived with `git log -1 --format=%B`. GitHub's default _merge_ commit message drops footers, and the trailer is what release-please reads.

## First publish: the one manual sequence

Trusted publishing cannot bootstrap a package that does not exist — npm requires the package on the registry before a trusted publisher can be configured for it (npm/cli#8544). So the first release needs a human, exactly once. With one package this is one publish and one `npm trust`, not twelve.

**The package cannot be reserved ahead of time.** A trusted publisher is configured at `npmjs.com/package/<name>/access`, which does not exist until the package does, so the ordering is forced: publish once by hand, then configure OIDC, then never touch a credential again.

Until it is done the `publish` job fails, and the log is the useful part:

```
GET .../idtoken/...?audience=npm%3Aregistry.npmjs.org  200
[WARN] Skipped OIDC: Failed token exchange request with body message: Unknown error (status code 404)
[E404] 404 Not Found - PUT https://registry.npmjs.org/memhtml - Not found
```

Read it top to bottom: GitHub issued the OIDC token (`200`, so `id-token: write` is scoped correctly and the workflow side is fine), **npm** refused the exchange with a 404 because no trusted publisher exists for a package that does not exist, and the unauthenticated `PUT` then 404s too. That pair on a first release means "the bootstrap has not happened yet", not "the workflow is wrong". The same pair AFTER bootstrapping means the trusted publisher does not match: check the workflow filename and that `repository.url` matches the GitHub repo case-sensitively.

```bash
# 0. 2FA must be enabled on the account: npm profile enable-2fa auth-and-writes
#    `memhtml` is unscoped, so it is owned by the publishing ACCOUNT rather than by the
#    memhtml org. Transfer it afterwards if org ownership is wanted:
#      npm owner add memhtml-org-member memhtml

# 1. Land the release PR so the tag and all seventeen version sites agree, then check out the tag
#    and assemble from it. The bytes that get published have to be the bytes that were released.
git checkout memhtml-v0.2.0 && pnpm install --frozen-lockfile
pnpm package:smoke            # assembles, lints, and proves the artifact works

# 2. Publish INTERACTIVELY. This step is a human at a terminal, so it needs no token at all:
#    `npm login` opens the browser flow, and `npm publish` prompts for the 2FA one-time
#    password. A granular token with "Bypass 2FA" is the CI shape and is the wrong tool here —
#    it creates a stealable credential to do a job a session already does, and npm now steers
#    that checkbox toward trusted publishing anyway.
npm login
cd dist-package
npm publish --tag latest      # prompts for the OTP; --dry-run first if you want to see the tarball

# 3. Register the trusted publisher, now that the package exists.
#    `--file` takes a bare filename, not a path.
npm trust github memhtml --repo memhtml/memhtml --file release-please.yml --allow-publish -y
npm trust ls memhtml

# 4. Require 2FA for future publishes, so the session that just published cannot be replayed:
#    npmjs.com/package/memhtml/access -> Publishing access -> require 2FA.
#    Nothing to revoke, because nothing long-lived was created.
```

That first publish carries no provenance attestation: provenance requires a cloud-hosted CI runner and cannot be generated from a laptop. Every release after it gets one automatically, per version.

## Repository settings this depends on

- **Allow GitHub Actions to create and approve pull requests** must be ON, or release-please fails with `GitHub Actions is not permitted to create or approve pull requests`. `default_workflow_permissions` stays `read`: every workflow here declares its own per-job permissions.

  It is set in **two** places and the outer one wins, which is the part worth knowing before debugging the inner one (probed 2026-08-14, on this repo's first release run):

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

  The failure is not destructive and loses no work: release-please computes every bump, pushes `release-please--branches--main`, and fails only on the PR call, so flipping the setting and re-running the workflow opens the PR from the branch already there.
- The npm trusted publisher must name `release-please.yml`, because that is the workflow whose `publish` job runs `npm publish`.

## Approve the release PR's waiting workflows

release-please opens its PR with the default `GITHUB_TOKEN`. GitHub starts bot-created `pull_request` runs in an approval-required state. A maintainer with write access must click **Approve workflows to run** on the PR, then wait for the `check`, `package`, and CodeQL checks to pass before merging. Approval starts the runs; it is not evidence that they passed. A manually dispatched run does not replace these PR checks.

The publish job still runs `pnpm check` and `pnpm package:smoke` on the tag. Keep both: they verify the source and the assembled package at the exact release revision.

## Release assets and verification

For version `0.16.2`, the primary assets are `memhtml-0.16.2.tgz`, `memhtml-0.16.2.cyclonedx.json`, and `memhtml-0.16.2-SHA256SUMS`. The SBOM catalogs the packed npm tarball, including the published package manifest; it describes what is in the archive, not a resolved installation of every dependency. The checksum file covers the tarball and SBOM. Each primary asset also has `<asset>.sigstore.json` containing its complete SLSA provenance bundle and `<asset>.intoto.jsonl` containing exactly one compact DSSE envelope. The checksum file has its own attestation, since a checksum file cannot contain its own digest.

Download the release assets, check their checksums, then verify each primary asset against the expected repository and workflow identity:

```bash
gh release download memhtml-v0.16.2 --repo memhtml/memhtml
sha256sum --check memhtml-0.16.2-SHA256SUMS
for asset in memhtml-0.16.2.tgz memhtml-0.16.2.cyclonedx.json memhtml-0.16.2-SHA256SUMS; do
  gh attestation verify "$asset" --repo memhtml/memhtml \
    --bundle "$asset.sigstore.json" \
    --signer-workflow memhtml/memhtml/.github/workflows/release-please.yml
done
```

`gh attestation verify` checks the signature and artifact digest, using SLSA provenance by default. The signer-workflow restriction prevents accepting another workflow's valid signature. The `.intoto.jsonl` files expose the same signed envelopes to tools that consume in-toto provenance; they are not unsigned copies of the statements.

For fully offline verification, supply a previously obtained Sigstore trusted root with `--custom-trusted-root trusted_root.jsonl`. The bundle conversion is also checked against a GitHub CLI release artifact with this command, using its own repository and workflow identity:

```bash
gh attestation verify gh_2.103.0_linux_amd64.tar.gz --repo cli/cli \
  --bundle gh_2.103.0_linux_amd64.tar.gz.sigstore.json \
  --custom-trusted-root trusted_root.jsonl \
  --signer-workflow cli/cli/.github/workflows/deployment.yml
```

Appending even one byte to the artifact makes verification fail. A JSON-lines bundle may contain several predicate types; the converter selects SLSA provenance by predicate type and matching artifact name/digest, then preserves the complete selected bundle.

## Why one workflow

A second workflow keyed on `release: [published]` would never fire: GitHub does not start those workflow runs from events raised by the default `GITHUB_TOKEN`, and release-please tags with that token. Keeping release-please, publish, and asset upload in one `push`-triggered workflow preserves the flow. The publish job alone holds job-level `id-token: write` and `attestations: write`, while the upload job alone gets the additional `contents: write` needed to attach release assets. The release-please job retains its existing release/PR permissions.

The publish job installs mise before `actions/setup-node`: mise supplies the tools the checks need, while setup-node owns the node and npm that use trusted publishing. The upload job receives the immutable Actions artifact by ID, verifies its file census, checksums, bundles, and signatures, and calls `gh release upload` only after those checks pass.

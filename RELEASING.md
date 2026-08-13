# Releasing

Versions are cut by [release-please][rp] from Conventional Commit subjects, and published
to npm by GitHub Actions using [npm Trusted Publishing][tp]: OIDC, with no long-lived
token in any secret.

[rp]: https://github.com/googleapis/release-please
[tp]: https://docs.npmjs.com/trusted-publishers

Twelve packages ship, and they move in lockstep: `@memhtml/cli`, `@memhtml/mcp`,
`@memhtml/consolidator`, and the nine libraries under `packages/`. The `linked-versions`
plugin in `release-please-config.json` keeps every version identical, so one release PR
bumps all twelve. `@memhtml/docs` and `tests-integration` stay private.

## The normal path

1. Merge Conventional Commits to `main`. `feat:` moves the minor, `fix:` the patch, and a
   `!` or a `BREAKING CHANGE:` footer moves the major.
2. release-please opens (and keeps updating) a release PR that bumps all twelve
   `package.json` files, writes per-package `CHANGELOG.md`s, and updates the two source
   constants.
3. Merge that PR. release-please tags the release, and the `publish` job in the same
   workflow run re-runs the full `pnpm check` gate on the tag and publishes all twelve
   packages to npm with provenance.

The version lives in **fourteen** places and release-please updates all of them: the
twelve manifests, plus two source constants marked with an `x-release-please-version`
comment on the same line (`apps/cli/src/commands.ts` `buildManifest`, and
`apps/mcp/src/server.ts` `SERVER_VERSION`). The updater is a per-line substring match, so
the comment must stay on the version's own line.

`workspace:*` and `catalog:` ranges in the manifests are rewritten to concrete versions
by `pnpm publish` at pack time; nothing needs to pin them by hand.

## Cutting a specific version

Put a `Release-As:` trailer in the commit BODY:

```
chore: cut the first minor

Release-As: 0.2.0
```

Squash-merge and confirm the trailer survived with `git log -1 --format=%B`. GitHub's
default *merge* commit message drops footers, and the trailer is what release-please
reads.

## What the un-bootstrapped publish job looks like

Until the bootstrap below is done, the `publish` job fails, and the log is the useful
part (signature probed live on symspec's first release):

```
GET .../idtoken/...?audience=npm%3Aregistry.npmjs.org  200
[WARN] Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE: Failed token exchange request
       with body message: Unknown error (status code 404)
[E404] 404 Not Found - PUT https://registry.npmjs.org/@memhtml%2fcli - Not found
```

Read it top to bottom: GitHub issued the OIDC token (`200`, so `id-token: write` is
scoped correctly and the workflow side is fine), **npm** refused the exchange with a 404
because no trusted publisher exists for a package that does not exist, and pnpm then fell
through to an unauthenticated `PUT` which also 404s.

So `ERR_PNPM_AUTH_TOKEN_EXCHANGE` + `404` on a first release means "the bootstrap has not
happened yet", not "the workflow is wrong". The same pair AFTER bootstrapping means the
trusted publisher does not match: check the workflow filename and that `repository.url`
matches the GitHub repo case-sensitively.

## First publish: the one manual sequence

Trusted publishing cannot bootstrap a package that does not exist. npm requires the
package to be on the registry before a trusted publisher can be configured for it
(npm/cli#8544). So the first release needs a token, exactly once:

```bash
# 0. Create the org (website only): https://www.npmjs.com/org/create → memhtml
#    2FA must be enabled on the account: npm profile enable-2fa auth-and-writes

# 1. Land the release PR so the tag and all fourteen version sites agree, then check
#    out the tag. Any of the twelve tags names the same tree; the CLI's is the anchor.
git checkout cli-v0.2.0 && pnpm install --frozen-lockfile && pnpm build

# 2. A short-lived granular token: read-write, "Bypass 2FA" ON (required for
#    non-interactive publish), shortest expiry. It cannot be scoped to @memhtml yet,
#    because the packages are not selectable until they exist.
#    Create at https://www.npmjs.com/settings/~/tokens
NODE_AUTH_TOKEN=<token> pnpm -r --filter '!@memhtml/docs' publish --no-git-checks --tag latest

# 3. Register the trusted publisher on each package, now that they exist.
#    `--file` takes a bare filename, not a path.
for p in cli mcp consolidator contracts domain eval html index llm sleep store traces; do
  npm trust github "@memhtml/$p" \
    --repo memhtml/memhtml \
    --file release-please.yml \
    --allow-publish -y
done
npm trust ls @memhtml/cli   # spot-check one

# 4. Revoke the token. It is the thing OIDC exists to remove.
npm token list && npm token revoke <id>
```

That first publish carries no provenance attestation: provenance requires a cloud-hosted
CI runner and cannot be generated from a laptop. Every release after it gets one
automatically. Provenance is per-version, not per-package.

## Repository settings this depends on

- **Settings → Actions → General → Allow GitHub Actions to create and approve pull
  requests** must be ON, or release-please fails with `GitHub Actions is not permitted
  to create or approve pull requests`. `default_workflow_permissions` stays `read`:
  every workflow here declares its own per-job permissions.
- The npm trusted publisher must name `release-please.yml`, because that is the workflow
  whose `publish` job runs `pnpm publish`.

## The release PR runs no CI, and cannot

release-please creates its release PR with the default `GITHUB_TOKEN`, and GitHub does
not start workflow runs from `GITHUB_TOKEN` events. This is why the `publish` job runs
`pnpm check` on the tag before `pnpm publish`: that step is the ONLY gate on a release
PR's contents. Do not remove it to save minutes.

## Why one workflow with two jobs

A second workflow keyed on `release: [published]` would never fire: GitHub does not start
workflow runs from events raised by the default `GITHUB_TOKEN`, and release-please tags
with that token. Keeping release-please and publish as two jobs of one `push`-triggered
workflow sidesteps the whole class of problem, and keeps `id-token: write` scoped to the
one job that publishes.

# pnpm 11 and npm 11 user config are disjoint surfaces, and one of them ignores kebab-case silently

**Tags**: pnpm, npm, npmrc, config, allow-scripts, install-scripts, machine-config
**Modules**: ~/.npmrc, ~/.config/pnpm/config.yaml, pnpm-workspace.yaml (allowBuilds)

## The rule

**pnpm-only keys in `~/.npmrc` make every npm invocation warn `Unknown user config`, and npm says
they stop working at its next major.** The pnpm 11 home for user-level settings is
`~/.config/pnpm/config.yaml` with **camelCase** keys (`storeDir`, `packageImportMethod`) — the same
casing as `pnpm-workspace.yaml` settings. Probed 2026-08-18 (pnpm 11.21.0, strace + `pnpm config
get`): pnpm opens and reads that file, then **silently ignores kebab-case keys in it** — a
hand-written `store-dir:` migration sat there dead while the `~/.npmrc` copy did the work.
`~/.config/pnpm/rc` (INI) is not read at all. Verify a move with `pnpm config get storeDir` from a
directory OUTSIDE any workspace; `~/.npmrc` then holds only auth tokens and registry mappings.

**npm 11.17's install-script gating has no user-level deny.** `allow-scripts` (config/flag) is an
allow-list for global/one-off contexts; the deny ledger (`npm deny-scripts` → `"pkg": false` under
`allowScripts`) lives in a PROJECT `package.json`, which `npm install -g` does not have. In the
current release unreviewed install scripts **warn but still run** (the docs announce a future
default-block); `strict-allow-scripts=true` would hard-fail every global install carrying an
unreviewed script, with no way to record the deny. So for a global install the honest states are:
allow explicitly, or accept the recurring warning as default-deny surfacing.

## Applied here

memhtml's tree carries two such packages — `@mongodb-js/zstd` and `node-liblzma`, optional native
accelerators of just-bash, lazily loaded for zstd/xz decompression inside the sandbox VFS. The repo
already denies their builds under pnpm (`allowBuilds: false` in pnpm-workspace.yaml, with the
reasoning) and the full suite is green without them; the installed CLI and MCP server answer with
the scripts skipped. The consistent posture for `npm install -g memhtml` is the same deny: do NOT
add them to `allow-scripts`, and read the warning as policy working. The
`npm warn deprecated prebuild-install` line is zstd's install-script dependency and carries no
action either.

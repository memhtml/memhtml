---
title: Install memhtml and initialize a store
description: Clone the repository, build the binary, and scaffold a memory store, which is the whole install path because nothing is published to a registry.
---

There is no package to install. Probed 2026-08-12: `npm view memhtml` and `npm view @memhtml/cli`
both answer 404, there are zero GitHub releases, and every workspace package is `private: true`. The
install is a clone and a build, and this page is the whole of it. Anything you read elsewhere that
starts with `npm install memhtml` is describing a package that does not exist.

At the end you will have a `memhtml` binary on your `PATH` and a scaffolded, git-initialized store.

## Get the toolchain

[`mise`](https://mise.jdx.dev) is the command surface for this repository. It installs the toolchain
itself, meaning node 24, pnpm 11.21.0, lefthook, and the scanners, from `mise.toml`. The committed
`mise.lock` pins each one by checksum and provenance, so your clone resolves the same binaries CI
does.

```bash
git clone https://github.com/memhtml/memhtml.git
cd memhtml
mise install        # node, pnpm, lefthook, scanners, from mise.lock
mise run install    # dependencies from the lockfile, plus the git hooks
mise run build      # tsc -b across the project-reference graph
```

`mise run install` depends on `mise run tools:verify`, which fails when `mise.toml`'s `[tools] pnpm`
pin and `package.json`'s `packageManager` disagree. Both declare the same pnpm and neither can be
derived from the other, which is why the check runs on every install.

When `mise run install` refuses because a dependency is too young to install, that is
`minimumReleaseAge: 1440` working: the newest release of a package stays uninstallable for its first
24 hours. Wait, or take the previous release.

## Put the binary on your PATH

`mise run build` emits an executable with a `node` shebang at `apps/cli/dist/bin.js`. Symlink it:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/apps/cli/dist/bin.js" ~/.local/bin/memhtml
memhtml manifest | head -5
```

```json
{
  "apiVersion": "1",
  "type": "cli.manifest",
  "data": {
```

`memhtml manifest` is the liveness check, and it answers on a machine with no repository, no
database, and no credentials. An envelope back means the build is good.

Two alternatives to the symlink, both equivalent:

- `mise run cli <args>` runs the same `apps/cli/dist/bin.js` from inside the repository. The task is
  declared `raw`, so mise prefixes nothing onto its output lines and the one-envelope-per-command
  contract survives.
- `node /path/to/memhtml/apps/cli/dist/bin.js <args>` from anywhere.

Every `@memhtml/*` package's exports resolve only to `./dist`, so after editing any package's `src/`
run `mise run build` again before the binary reflects the edit.

## Point at a store and scaffold it

`MEMHTML_ROOT` is where the memory repository lives. It defaults to `~/memhtml`, and the binary
expands a leading `~` itself, because the value arrives from a shell profile, an MCP client config,
and a cron line, and only the shell expands tildes.

```bash
export MEMHTML_ROOT=~/memhtml
memhtml init
```

```json
{
  "apiVersion": "1",
  "type": "repo.init",
  "data": {
    "root": "/home/you/memhtml",
    "created": true,
    "headSha": "1d12ed327db623a2fdcfbec91f78e41fd8d9c6c4",
    "wrote": [
      "projects/.gitkeep",
      "areas/.gitkeep",
      "resources/.gitkeep",
      "archive/.gitkeep",
      "areas/arcs/.gitkeep",
      "resources/people/.gitkeep",
      "areas/inbox/.gitkeep",
      ".memhtml/state/.gitkeep",
      ".memhtml/sleep/.gitkeep",
      ".gitignore",
      ".gitattributes",
      "README.html"
    ]
  }
}
```

`created: true` means this call created the repository. On a re-run it is `false`, `wrote` is empty,
and `headSha` is the existing HEAD: `memhtml init` is convergent, asking the repository what is
already true and supplying only what is missing (`packages/store/src/layout.ts:183`). It reaches the
same end state from an empty directory, from a fully scaffolded repository, and from one a killed run
left half finished, so re-running it is always safe.

The top level is fixed at four PARA buckets: `projects/`, `areas/`, `resources/`, and `archive/`. A
workspace is a directory
under `projects/`, and there is no workspaces table. [Store layout and path
algebra](/internals/store-layout-and-path-algebra/) explains the rest of the tree.

## Build the index

`memhtml init` applies the migrations, so `.memhtml/index.db` exists and holds nothing. Project the
tree into it:

```bash
memhtml index rebuild --embed
```

`--embed` fills vectors from Bedrock. With no AWS credentials yet, pass `--no-embed`: the rebuild
becomes instant, retrieval runs on its lexical floor, and you fill the vectors later by running
`memhtml index rebuild --embed`. Both states are honest ones to be in:

```bash
export MEMHTML_EMBED=off      # an explicit opt-out, distinct from a missing credential
memhtml index rebuild --no-embed
```

A missing credential degrades one search at call time, while `MEMHTML_EMBED=off` degrades every
search. Only the second is a decision you made, and the manifest reports the two as different
states.

## Confirm it

```bash
memhtml status
```

```json
{
  "apiVersion": "1",
  "type": "status.health",
  "data": {
    "root": "/home/you/memhtml",
    "headSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "dirty": false,
    "dirtyPaths": [],
    "countsByType": {},
    "archivedCount": 0,
    "edges": 0,
    "derivedEdges": 0,
    "chunks": 0,
    "embeddings": 0,
    "traces": 0,
    "indexFresh": true,
    "indexHeadSha": "4e232759bfad745b0445ecd83cc9883c30a0c426",
    "embedModel": "cohere.embed-v4:0@1024",
    "embedderUp": false,
    "hasState": true,
    "lastSleep": null
  }
}
```

`indexFresh: true` means the index describes the current HEAD. `embedderUp` is read off the stored
watermark rather than by probing Bedrock, so it reads `false` on a store with zero vectors and stays
`false` until an embedding pass writes some.

`memhtml doctor` is the other confirmation. On a fresh store it answers `healthy: true` with every
finding list empty. [Audit and publish the
corpus](/learn/operations/audit-and-publish-the-corpus/) covers what each finding means when the
lists are not empty.

## Where the state lives

Two databases sit under `.memhtml/`, and they differ in what you can recover:

- `index.db` is gitignored and rebuildable from the tree. Losing it costs a rebuild.
- `state.db` is gitignored and holds the one set of facts the tree cannot reproduce: access counts,
  reinforcement counts, and the outcome EWMA. Its durability comes from the committed sidecar
  `.memhtml/state/access.jsonl`.

Both are plain SQLite, opened through node's built-in `node:sqlite`. The only database dependency is
node itself, with no driver flags to keep in step, so `sqlite3` or any GUI browser opens both files
directly and a stuck index stays inspectable without this binary.

Next: [write your first memory](/learn/tutorial/first-memory/).

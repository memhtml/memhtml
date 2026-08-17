# Where a filesystem-first agent gets built decides whether it can boot

**Tags**: eve, nitro, rolldown, node_modules, bundling, consolidator, cache-dir, exit-13
**Modules**: apps/consolidator/src/agent-build.ts, apps/consolidator/agent/

## The rule

**nitro externalizes any module it resolves from inside `node_modules`, and the resulting server cannot
boot.** The discriminator is the tree's LOCATION, not its contents. Measured 2026-08-17 against an
npm-installed tarball of this system:

| Built from | `server/index.mjs` | `eve build` | `eve start` |
|---|---|---|---|
| a checkout | 317 kB, sources inlined | exit 0 | `200 {"ok":true,"status":"ready"}` in ~2s |
| inside `node_modules` | 17.3 kB beside a traced 4.73 MB `_libs/@memhtml/…` chunk | **exit 0** | **exit 13**, `Detected unsettled top-level await … await workflowWorld.start?.()` |

The build SUCCEEDS in both cases. That is what makes it dangerous: an install looks fine, and the server
dies on first use with an error that names neither the cause nor the package.

**So the agent tree is copied out and built where nothing above it is named `node_modules`** —
`~/.cache/memhtml/eve/<version>/`, respecting `XDG_CACHE_HOME`, once per version rather than once per run.

## What travels, and why it is source

`eve` is filesystem-first: `eve build` compiles `agent/` and the `../../src/*.js` it reaches. So `agent/`
and `src/` travel TOGETHER and at their original depth — two levels up from `agent/<dir>/` must be the
staged root. Staging `agent/` alone reproduces the same `UNRESOLVED_IMPORT` a tarball without `src/`
produces. This is why the published package ships TypeScript source for one subtree, which otherwise
looks like an oversight.

## The link list comes from the imports, not from a manifest

A cache directory under `~/.cache` has no ancestor holding the package's dependencies, so node's upward
walk finds nothing and each imported package is symlinked in by name. The list is read off the staged
sources rather than from `dependencies`, for two reasons:

1. The published manifest **cannot** carry them (declaring dependencies in a bundled vendored manifest
   makes npm plant phantom empty directories — see
   `build-errors/the-published-artifact-is-not-the-workspace.md`).
2. What the agent tree needs is what it IMPORTS, which is a strict subset. Only `mount.ts` and
   `run-auth.ts` are reachable from `agent/`, so `@memhtml/contracts` — imported by `client.ts` and
   `contract.ts` — is never needed by the build, despite appearing in a naive scan of `src/`.

Resolving each dependency's directory uses an **ancestor `node_modules` walk, not
`require.resolve("<name>/package.json")`**: an `exports` map that omits `./package.json` makes node refuse
the subpath, and two of this package's own dependencies do exactly that (`@memhtml/contracts`,
`just-bash`). Asking the filesystem cannot be blocked by an exports map.

## Rejected: shipping a prebuilt `.output/`

The obvious alternative, and wrong. `eve build` traces platform-specific native binaries into the output
(`server/node_modules/node-liblzma/build/Release/node_lzma.node`) and says so itself: *"Ensure your
production environment matches the builder OS and architecture (linux-x64)."* A cross-platform npm
package cannot carry one platform's binaries. Building on the machine that runs it is the honest answer,
and it costs one ~17 MB build per version.

## Spawn through node, never a package manager

`spawn("pnpm", ["exec", "eve", …])` is a workspace assumption. A consumer installs with whatever manager
they use and need not have pnpm on PATH at all, so the one command that reaches the agent was unreachable
everywhere except a checkout. `process.execPath` against a resolved path depends on nothing but node —
the same shape `apps/cli/src/serve.ts` uses to spawn the MCP server.

## Reaching this path from a test is itself gated

The consolidation phase selects transcripts that clear `TRACE_MIN_BYTES` (8 KB) and whose `file_mtime`
predates `TRACE_QUIET_MILLIS` (one hour) — a small file cannot yield a memory that is more than a
restatement, and a recent one is a session still in progress. **The repo's own fixtures are ~2.5 KB and
freshly copied, so they fail both and the phase reports `batch: 0`** — correct behaviour that reads
exactly like coverage. A live test must synthesize a session over 8 KB and backdate it, or it proves
nothing while appearing to pass.

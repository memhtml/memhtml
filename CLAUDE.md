# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`memhtml` is an agent's long-term memory store: a git repository of semantic HTML5 files (one fact per
file) with a rebuildable SQLite index, four-arm RRF retrieval, and a fifteen-phase nightly curation
pipeline. A pnpm + turbo TypeScript monorepo on Effect v4 (beta, pinned via catalog), Node 24, driven
through `mise`.

Read first, in this order: `README.md` (the system in one page), `docs/design.md` (every architectural
decision with the file:line that implements it), `.erpaval/INDEX.md` (prior-session lessons — grep
`.erpaval/solutions/**` before related work). `AGENTS.md` is **generated** — never hand-edit it.

## Commands

`mise` is the command surface — `mise run check` is the definition of done, and it is exactly what CI
runs, so the gate cannot drift from the local one. It resolves to `pnpm check` →
`turbo run lint typecheck test test:integration test:eval test:a11y test:budget`, and it is
credential-free by construction (eval defaults to `--mode fake`; integration sets `MEMHTML_EMBED=off` /
`MEMHTML_LLM=off` itself; the two browser tiers read `apps/docs/dist` over a loopback static server).

The two browser tiers need a Chromium, which nothing fetches implicitly — Playwright 1.62 ships no
install script. `mise run install` ends with `mise run browsers`, and CI runs that step behind a cache
of `~/.cache/ms-playwright`. One binary (Chrome for Testing) serves both: axe drives it through
Playwright, Lighthouse through `CHROME_PATH`.

Every mise task is a thin delegation to the pnpm script under it. **turbo owns the task graph and the
cache**; no mise task carries `sources`/`outputs`, because mise judges freshness by mtime and turbo by
content hash, and a mise-level skip would preempt turbo's per-package hashing. Do not re-express
`turbo.json` as mise `depends` — it runs in parallel (`jobs = 8`) and would race the
build-before-integration ordering.

| Command | What it runs |
|---|---|
| `mise run build` | `tsc -b` across the project-reference graph |
| `mise run lint` / `mise run format` | biome check / check --write |
| `mise run typecheck` | `tsc --noEmit -p tsconfig.check.json` per package — tests included |
| `mise run test` | every package's unit + property suites |
| `mise run test:integration` | `tests-integration/` — real git repo, real database, whole stack |
| `mise run test:eval` | the discrimination gate (fake embedder) |
| `mise run test:a11y` | WCAG 2.2 AA over four pages of `apps/docs/dist`, plus the probes axe lacks |
| `mise run test:budget` | Lighthouse category floors + the byte budget over `apps/docs/dist` |
| `mise run spell` | cspell over `apps/docs/src/content/**` (also the tail of `mise run lint`) |
| `mise run browsers` | fetch the pinned Chromium the two browser tiers drive |
| `mise run docs:links` | external links in the built site — reports, never gates |
| `mise run gen:fixture` | write a browsable fixture corpus (pure function of a seed) |
| `mise run agents-doc` | regenerate `AGENTS.md` from the built CLI's table |
| `mise run security` | osv-scanner + semgrep + betterleaks → SARIF in `.sarif/` (report-only) |
| `mise run tools:verify` / `tools:bump` | check the two pnpm pins agree / re-resolve `latest` in `mise.lock` |
| `mise run cli <args>` | the built CLI, `raw` so stdout stays one JSON envelope |

Narrowing to one package — the positional is a filename substring, `-t` matches the test name:

```bash
mise run test-pkg domain rrf -t "strictly"   # one case
mise run test-pkg index retrieval            # one file
mise run test-pkg integration sleep          # tests-integration
```

`test-pkg` is a **file task**, not a TOML one, and that is forced: mise appends a task's trailing args
to the END of an inline `run` string, so an inline task can neither consume the package name nor place
the rest mid-command, and only a file task sees real `$@`. It also cannot go through the root script —
`pnpm test` is `turbo run test`, so `mise run test rrf` would become `turbo run test rrf` and turbo
would read `rrf` as a second task name. Because it calls the package's vitest directly it **skips turbo
and does not build first** — see the rebuild discipline below.

Two more consequences of that argv rule: never add a `usage` spec to a task that needs passthrough (a
spec is a whitelist and rejects undeclared flags), and any task proxying the binary needs `raw = true`,
since mise's default line-prefixed output would corrupt the one-envelope stdout contract and the MCP
RPC stream.

The pnpm version is declared twice — `mise.toml`'s `[tools] pnpm` and `package.json`'s
`packageManager` — because neither can derive the other: mise resolves `[tools]` before any Node exists
to evaluate a template, and pnpm will not read `mise.toml`. `mise run tools:verify` fails on
disagreement and `install` depends on it. `pnpm` is declared **above** `node` on purpose: node's bin
holds a `pnpm` symlink into corepack wherever `corepack enable` has run, and with node first every
pnpm call resolves to corepack instead of the pinned binary.

## Architecture

Two invariants hold the whole design together, and most bugs are a violation of one of them:

- **The git tree is the system of record; `.memhtml/index.db` is a disposable projection.** Anything
  that must survive `rm index.db` lives in a file — authored links are `<link>` elements, metadata is
  `<meta>` elements. Re-derivable artifacts (embeddings, mined edges) live only in the index.
  `.memhtml/state.db` is the exception: it is NOT rebuildable from git, which is why
  `.memhtml/state/access.jsonl` is a committed sidecar.
- **Every corpus change is exactly one git commit.** The store owns staging, so a caller cannot bundle
  two unrelated writes. Nothing is deleted: eviction is a `git mv` into `archive/<YYYY>/` mirroring the
  original path, so `git log --follow` reads through a memory's whole life.

Dependencies point inward, enforced by TypeScript project references (`tsconfig.json` `references`) plus
`tsconfig.check.json` for the test-inclusive typecheck:

```
contracts ← domain, html ← store ← index (+domain, +llm) ← traces, sleep, eval ← apps/cli ← apps/mcp
```

`@memhtml/contracts` imports only `effect`. `@memhtml/domain`'s purity is a **test**, not a convention:
`packages/domain/tests/layering.test.ts` greps the emitted `dist/*.js` for `node:sqlite`, `@aws-sdk`, or
`node:fs`. `apps/mcp` depends on `@memhtml/cli` rather than re-composing services, so there is one
answer to which database, which git root, which vector space.

There is exactly one composition root: `AppLive` in `apps/cli/src/api-layer.ts`. The design's single
dependency cycle is broken there — the store needs a SQL lookup for content dedup and `@memhtml/store`
is SQL-free, so the lookup arrives as an injected function.

`apps/consolidator` (`@memhtml/consolidator`) is the eve agent that distils candidate memories from raw
transcripts; it is the one package outside the Effect service graph (ai-sdk + zod + `just-bash`).

### The contract surface

Every command writes **one** JSON envelope to stdout and nothing else; logs go to stderr. Exit 0
success / 2 usage / 1 runtime. `type` and `code` values are **append-only**: a shipped value never
changes meaning and is never removed, and callers branch on `code`, never on the `error` prose. The
`COMMANDS` array in `apps/cli/src/commands.ts` drives both argument parsing and `AGENTS.md` generation,
so adding a command means editing that one array.

## Non-obvious rules (each cost real debugging time)

**Every `@memhtml/*` package's exports resolve only to `./dist`.** A change under `packages/*/src` is
invisible to any downstream package's tests until that package is rebuilt. Root `mise run build` before any
integration or e2e run that follows a source edit, or you silently test stale dist. For mutation
testing, rebuild between mutate and run *and* after restore — otherwise every downstream mutant
survives vacuously.

**`AGENTS.md` regenerates from the BUILT CLI**, and the drift gate is a vitest case
(`apps/cli/tests/agents-doc.test.ts`), not a pipeline step. After touching `commands.ts`:
`mise run agents-doc`, which builds `@memhtml/cli` first for exactly this reason.

**Effect v4 is a pre-release and breaks between versions.** The catalog in `pnpm-workspace.yaml` moves
`effect`, `@effect/platform-node`, and `@effect/vitest` as one set — never one of the three. A typed
error is `Schema.TaggedError<Self>()("Tag", fields)`, which supplies `_tag` itself, so the fields must
NOT declare one; and `McpServer.layerStdio` requires `protocols: [McpProtocol.v2025_06_18]`, the only
adapter shipped. `minimumReleaseAge: 1440` also means the newest release is not installable for its
first 24 hours — a blocked install is that policy working, not a broken lockfile.

**Effect 4.0.0-beta.107 differs from recall** (full list in
`.erpaval/solutions/effect-v4/effect-4-beta-102-api-reality.md`): `Effect.either` does not exist — use
`Effect.result`. `Schema.decodeUnknownEffect` strips excess properties unless you pass
`{onExcessProperty: "error"}`, so an LLM answering a neighbouring schema decodes "successfully". Use
`Schema.Finite` in JSON-Schema-derived surfaces (`Schema.Number` derives a string branch). Compose
layers **top-down** — `Layer.provideMerge(that)` feeds `that` into `self`, so bottom-up chaining
typechecks and is wrong at runtime. `effect/Config` snapshots `process.env`, so tests must set env
before building the layer. `effect/unstable/ai` + `effect/unstable/cli` are sufficient — no
`@modelcontextprotocol/sdk`, no `@effect/cli`. Effect's default logger writes to stdout, which IS the
MCP RPC stream: any stdio server needs `Logger.LogToStderr`.

**Two runtime assets are not compiled by `tsc` and resolve relative to `dist/`.** SQL migrations are
read from disk in filename order via `new URL("../migrations", import.meta.url)`
(`packages/index/src/schema-const.ts`) — adding one means adding a `.sql` file to
`packages/index/migrations/` (index plane) or `state-migrations/` (the ATTACHed `state` plane, which
keeps its own `state.schema_migrations` ledger), with no code change. `apps/cli/guest/corpus.mjs` is the
code-mode sandbox helper, read as bytes at run time and never typechecked.

## Testing posture

Fakes are limited to the two edges that reach the network — the embedder and the model — because a
stateless fake verifies the shape of a call and misses the state semantics behind it, which is where
this system's defects have actually lived. Everything else is real: the real `node:sqlite` driver with
the shipped migrations, and the real `git` binary against a temp-dir repo. `tests-integration` runs
`fileParallelism: false` with a 180s timeout because each suite `git init`s a repo and opens a database
on disk.

Property tests (`fast-check`) cover `@memhtml/domain` and `@memhtml/html`. `packages/eval` owns the
**discrimination gate**: controls are derived mechanically from each probe's target (negation, numeric,
qualifier flips) so they are high-cosine wrong-fact adversaries by construction. One inversion fails the
run regardless of MRR. `mrr` (gated, floor 0.85) and `corpusMrr` (reported only) are different
coordinate spaces — do not read the second as a retrieval defect.

Standing hazards to write tests against, learned here:

- **A clean-database test can pass against a real bug.** Seed a *neighbour's* rows, not only the
  subject's, wherever a table is shared across entities.
- **Mutation-verify every lock you call a lock** — roughly a quarter of candidate regression tests
  written in this repo were vacuous until someone reverted the fix and watched them fail.
- **A wrong count reads as a finding.** `0/410 edges resolved` and `withClaim: 0` were both bugs in the
  probe (path normalization; `article > mark`, which matches nothing — the markup is
  `<article><p><mark>`). A census probe asserts an independently-derived total; it never just reports.
- **Assert shape when correctness and cost diverge** — e.g. capture `EXPLAIN` output to prove the
  planner uses a partial index, since the rows come back either way.
- **A third-party rule can be nondeterministic, and a blocking gate cannot hold one.** Measured
  2026-08-12: axe's `scrollable-region-focusable` reported a violation on one of five runs over an
  unchanged page whose geometry was identical throughout. The rule is disabled and the criterion is
  covered by a probe in `apps/docs/tests/a11y.test.ts` that reads the geometry itself. Measure the flake
  before trusting or before suppressing.

The docs site's accessibility gate carries a **declared baseline** — `KNOWN_A11Y_FAILURES` in
`apps/docs/src/gates.ts`, three violations owned by `src/styles/rfc.css`, Expressive Code and Starlight.
It is a ratchet, not an exemption: a violation outside it fails, and an entry that stops firing fails
too, so a fix cannot leave its suppression behind. Each entry's `signature` must match every offending
node, so the same rule failing for a new reason is still a failure.

## Conventions

Conventional Commits on a typed branch (`feature/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`,
`test/…`, `spec/…`); a clean local merge to `main` is fine provided the branch is green. Biome
formatting is non-negotiable and machine-applied: double quotes, no semicolons, 2-space indent, 100
columns, no trailing commas. `noExplicitAny`, `noNonNullAssertion`, and unused-variable/import are
errors; `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.

`spec/memhtml.symspec.json` is the EARS requirements ledger (keys like `RET-3`, `STORE-2`, each naming
its verification method and the code that satisfies it) — retiring or adding a requirement is its own
`spec:` commit. `docs/backlog.md` is the fine-grained ledger, `ROADMAP.md` the system-level view with
measured benchmark standing. Durable lessons land in `.erpaval/solutions/**` as the rule, never the
diff.

Artifacts describe what the code does now — never what it did before. No "used to", "previously", "this
replaces". A dated, probed external fact ("probed live 2026-08-03: …") is present-tense knowledge and
stays.

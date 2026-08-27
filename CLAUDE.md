# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`memhtml` is an agent's long-term memory store: a git repository of semantic HTML5 files (one fact per file) with a rebuildable SQLite index, four-arm RRF retrieval, and a seventeen-phase curation pipeline a caller triggers. A pnpm + turbo TypeScript monorepo on Effect v4 (beta, pinned via catalog), Node 24, driven through `mise`.

Read first, in this order: `README.md` (the system in one page), `docs/design.md` (every architectural decision with the file:line that implements it), `.erpaval/INDEX.md` (prior-session lessons — grep `.erpaval/solutions/**` before related work). `AGENTS.md` is **generated** — never hand-edit it.

## Commands

`mise` is the command surface — `mise run check` is the definition of done, and it is exactly what CI runs, so the gate cannot drift from the local one. It resolves to `pnpm check` → `turbo run lint lint:repo lint:md typecheck test test:integration test:eval test:a11y test:budget`, and it is credential-free by construction (eval defaults to `--mode fake`; integration sets `MEMHTML_EMBED=off` / `MEMHTML_LLM=off` itself; the two browser tiers read `apps/docs/dist` over a loopback static server).

The two browser tiers need a Chromium, which nothing fetches implicitly — Playwright 1.62 ships no install script. `mise run install` ends with `mise run browsers`, and CI runs that step behind a cache of `~/.cache/ms-playwright`. One binary (Chrome for Testing) serves both: axe drives it through Playwright, Lighthouse through `CHROME_PATH`.

Every mise task is a thin delegation to the pnpm script under it. **turbo owns the task graph and the cache**; no mise task carries `sources`/`outputs`, because mise judges freshness by mtime and turbo by content hash, and a mise-level skip would preempt turbo's per-package hashing. Do not re-express `turbo.json` as mise `depends` — it runs in parallel (`jobs = 8`) and would race the build-before-integration ordering.

| Command                                      | What it runs                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mise run build`                             | `tsc -b` across the project-reference graph                                                                                                                                                            |
| `mise run lint` / `mise run format`          | per-package biome check / check --write, plus `lint:repo` (`biome check .`) so the linted set is `biome.json`'s `files.includes` rather than each package's `src tests`, then dprint over the Markdown |
| `mise run lint:md` / `mise run format:md`    | dprint check / fmt over every authored `*.md` (textWrap: never — one line per paragraph)                                                                                                               |
| `mise run typecheck`                         | `tsc --noEmit -p tsconfig.check.json` per package — tests included                                                                                                                                     |
| `mise run test`                              | every package's unit + property suites                                                                                                                                                                 |
| `mise run test:integration`                  | `tests-integration/` — real git repo, real database, whole stack                                                                                                                                       |
| `mise run test:eval`                         | the discrimination gate (fake embedder)                                                                                                                                                                |
| `mise run test:a11y`                         | the browser tier: WCAG 2.2 AA over four pages of `apps/docs/dist`, the probes axe lacks, and the layout-shift probe                                                                                    |
| `mise run test:budget`                       | Lighthouse category floors + the byte budget over `apps/docs/dist`                                                                                                                                     |
| `mise run spell`                             | cspell over `apps/docs/src/content/**` (also the tail of `mise run lint`)                                                                                                                              |
| `mise run browsers`                          | fetch the pinned Chromium the two browser tiers drive                                                                                                                                                  |
| `mise run docs:links`                        | external links in the built site — reports, never gates                                                                                                                                                |
| `mise run gen:fixture`                       | write a browsable fixture corpus (pure function of a seed)                                                                                                                                             |
| `mise run agents-doc`                        | regenerate `AGENTS.md` from the built CLI's table                                                                                                                                                      |
| `mise run package:assemble` / `package:pack` | tsdown-build the one publishable `memhtml` into `dist-package/` / also `npm pack` it                                                                                                                   |
| `mise run package:lint`                      | publint over the staged package                                                                                                                                                                        |
| `mise run package:smoke`                     | install that tarball in a temp dir and drive every command, MCP tool, and MCP resource template through it                                                                                             |
| `mise run package:smoke:live`                | the same, plus the three edges that reach Bedrock (spends tokens)                                                                                                                                      |
| `mise run security`                          | osv-scanner + semgrep + betterleaks + syft/grype (SBOM) + trivy → SARIF in `.sarif/` (report-only)                                                                                                     |
| `mise run security:vex`                      | regenerate `osv-scanner.toml` from the OpenVEX ledger — run after editing it                                                                                                                           |
| `mise run tools:verify` / `tools:bump`       | check the two pnpm pins agree / re-resolve `latest` in `mise.lock`                                                                                                                                     |
| `mise run cli <args>`                        | the built CLI, `raw` so stdout stays one JSON envelope                                                                                                                                                 |

Narrowing to one package — the positional is a filename substring, `-t` matches the test name:

```bash
mise run test-pkg domain rrf -t "strictly"   # one case
mise run test-pkg index retrieval            # one file
mise run test-pkg integration sleep          # tests-integration
```

`test-pkg` is a **file task**, not a TOML one, and that is forced: mise appends a task's trailing args to the END of an inline `run` string, so an inline task can neither consume the package name nor place the rest mid-command, and only a file task sees real `$@`. It also cannot go through the root script — `pnpm test` is `turbo run test`, so `mise run test rrf` would become `turbo run test rrf` and turbo would read `rrf` as a second task name. Because it calls the package's vitest directly it **skips turbo and does not build first** — see the rebuild discipline below.

Two more consequences of that argv rule: never add a `usage` spec to a task that needs passthrough (a spec is a whitelist and rejects undeclared flags), and any task proxying the binary needs `raw = true`, since mise's default line-prefixed output would corrupt the one-envelope stdout contract and the MCP RPC stream.

The pnpm version is declared twice — `mise.toml`'s `[tools] pnpm` and `package.json`'s `packageManager` — because neither can derive the other: mise resolves `[tools]` before any Node exists to evaluate a template, and pnpm will not read `mise.toml`. `mise run tools:verify` fails on disagreement and `install` depends on it. `pnpm` is declared **above** `node` on purpose: node's bin holds a `pnpm` symlink into corepack wherever `corepack enable` has run, and with node first every pnpm call resolves to corepack instead of the pinned binary.

## Code intelligence

codegraph is initialized in this repo (`.codegraph/`) — `codegraph query`, `codegraph explore`, and `codegraph node` are available for symbol lookup and impact tracing. It resolves by bare method name, so confirm a consumer actually names the surface before citing an impact result.

## Architecture

Two invariants hold the whole design together, and most bugs are a violation of one of them:

- **The git tree is the system of record; `.memhtml/index.db` is a disposable projection.** Anything that must survive `rm index.db` lives in a file — authored links are `<link>` elements, metadata is `<meta>` elements. Re-derivable artifacts (embeddings, mined edges) live only in the index. `.memhtml/state.db` is the exception: it is NOT rebuildable from git, which is why `.memhtml/state/access.jsonl` is a committed sidecar.
- **Every corpus change is exactly one git commit.** The store owns staging, so a caller cannot bundle two unrelated writes. Nothing is deleted: eviction is a `git mv` into `archive/<YYYY>/` mirroring the original path, so `git log --follow` reads through a memory's whole life.

Dependencies point inward, enforced by TypeScript project references (`tsconfig.json` `references`) plus `tsconfig.check.json` for the test-inclusive typecheck:

```
contracts ← domain, html ← store ← index (+domain, +llm) ← traces, sleep, eval ← apps/cli ← apps/mcp
```

`@memhtml/contracts` imports only `effect`. `@memhtml/domain`'s purity is a **test**, not a convention: `packages/domain/tests/layering.test.ts` greps the emitted `dist/*.js` for `node:sqlite`, `@aws-sdk`, or `node:fs`. `apps/mcp` depends on `@memhtml/cli` rather than re-composing services, so there is one answer to which database, which git root, which vector space.

There is exactly one composition root: `AppLive` in `apps/cli/src/api-layer.ts`. The design's single dependency cycle is broken there — the store needs a SQL lookup for content dedup and `@memhtml/store` is SQL-free, so the lookup arrives as an injected function.

`apps/consolidator` (`@memhtml/consolidator`) is the eve agent that distills candidate memories from raw transcripts; it is the one package outside the Effect service graph (ai-sdk + zod + `just-bash`).

### The contract surface

Every command writes **one** JSON envelope to stdout and nothing else; logs go to stderr. Exit 0 success / 2 usage / 1 runtime. `type` and `code` values are **append-only**: a shipped value never changes meaning and is never removed, and callers branch on `code`, never on the `error` prose. The `COMMANDS` array in `apps/cli/src/commands.ts` drives both argument parsing and `AGENTS.md` generation, so adding a command means editing that one array.

## Non-obvious rules (each cost real debugging time)

**Every `@memhtml/*` package's exports resolve only to `./dist`.** A change under `packages/*/src` is invisible to any downstream package's tests until that package is rebuilt. Root `mise run build` before any integration or e2e run that follows a source edit, or you silently test stale dist. For mutation testing, rebuild between mutate and run _and_ after restore — otherwise every downstream mutant survives vacuously.

**`AGENTS.md` regenerates from the BUILT CLI**, and the drift gate is a vitest case (`apps/cli/tests/agents-doc.test.ts`), not a pipeline step. After touching `commands.ts`: `mise run agents-doc`, which builds `@memhtml/cli` first for exactly this reason.

**A green suite says nothing about the published artifact.** Every tier resolves `@memhtml/*` through pnpm's links, where `guest/`, `agent/`, `src/`, and `migrations/` are on disk whether or not a manifest names them — while `npm publish` ships only what `files` names. Three assets were absent from every tarball under exactly that blindness: `guest/corpus.mjs` (so code mode could not start) and the consolidator's `src/*.ts` (so `eve build` failed `UNRESOLVED_IMPORT`), with the migrations surviving only because `packages/index` happened to name them. Two gates hold it now: a claim table over the pack manifest (`tests-integration/tests/packaging.test.ts`), where each claim also names the source line that resolves it so a guard cannot outlive the thing it guards, and `mise run package:smoke`, which installs the tarball and runs the binary. **A new run-time asset means a claim in that table**, or the census over `import.meta.url` resolutions in shipped source fails at the commit that adds it.

**Where eve's agent gets built decides whether it can boot.** nitro externalizes any module it resolves from inside `node_modules`, so building the agent in an installed package yields `eve build` exit 0 and then `eve start` exit 13 on an unsettled top-level await — a build that looks fine and a server that dies. `agent-build.ts` copies `agent/` plus `src/` to `~/.cache/memhtml/eve/<version>/` and builds there, where the emitted `index.mjs` is ~316 kB inlined rather than ~17 kB beside a traced `_libs/@memhtml/…` chunk. Shipping a prebuilt `.output/` is refused: it traces platform-specific native binaries.

**Effect v4 is a pre-release and breaks between versions.** The catalog in `pnpm-workspace.yaml` moves `effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/vitest` as one set — never one of the four. `@effect/platform-node-shared` is in the set even though no code imports it: it is `@effect/platform-node`'s own caret-ranged dependency, and `apps/mcp` declares it so the published manifest pins it — otherwise a consumer's installer resolves the newest rc and ships a mixed set the gates never ran against (`catalog.test.ts` + the packaging claim gate this). A typed error is `Schema.TaggedError<Self>()("Tag", fields)`, which supplies `_tag` itself, so the fields must NOT declare one; and `McpServer.layerStdio` requires `protocols: [McpProtocol.v2025_06_18]`, the only adapter shipped. `minimumReleaseAge: 4320` also means the newest release is not installable for its first 72 hours (Dependabot security PRs bypass the cooldown; for a fresh CVE fix inside the window, override per-package with `minimumReleaseAgeExclude`) — a blocked install is that policy working, not a broken lockfile.

**Effect 4.0.0-rc.109 differs from recall** — the catalog in `pnpm-workspace.yaml` is the pin, and it is what these claims were re-verified against (full list in `.erpaval/solutions/effect-v4/effect-4-beta-102-api-reality.md`, whose filename records the version it was first written for): `Effect.either` does not exist — use `Effect.result`. `Schema.decodeUnknownEffect` strips excess properties unless you pass `{onExcessProperty: "error"}`, so an LLM answering a neighboring schema decodes "successfully". Use `Schema.Finite` in JSON-Schema-derived surfaces (`Schema.Number` derives a string branch). Compose layers **top-down** — `Layer.provideMerge(that)` feeds `that` into `self`, so bottom-up chaining typechecks and is wrong at runtime. `effect/Config` snapshots `process.env`, so tests must set env before building the layer. `effect/unstable/ai` + `effect/unstable/cli` are sufficient — no `@modelcontextprotocol/sdk`, no `@effect/cli`. Effect's default logger writes to stdout, which IS the MCP RPC stream: any stdio server needs `Logger.LogToStderr`.

**Two runtime assets are not compiled by `tsc` and resolve relative to `dist/`.** SQL migrations are read from disk in filename order via `new URL("../migrations", import.meta.url)` (`packages/index/src/schema-const.ts`) — adding one means adding a `.sql` file to `packages/index/migrations/` (index plane) or `state-migrations/` (the ATTACHed `state` plane, which keeps its own `state.schema_migrations` ledger), with no code change. `apps/cli/guest/corpus.mjs` is the code-mode sandbox helper, read as bytes at run time and never typechecked.

## Testing posture

Fakes are limited to the two edges that reach the network — the embedder and the model — because a stateless fake verifies the shape of a call and misses the state semantics behind it, which is where this system's defects have actually lived. Everything else is real: the real `node:sqlite` driver with the shipped migrations, and the real `git` binary against a temp-dir repo. `tests-integration` runs `fileParallelism: false` with a 180s timeout because each suite `git init`s a repo and opens a database on disk.

Property tests (`fast-check`) cover `@memhtml/domain` and `@memhtml/html`. `packages/eval` owns the **discrimination gate**: controls are derived mechanically from each probe's target (negation, numeric, qualifier flips) so they are high-cosine wrong-fact adversaries by construction. One inversion fails the run regardless of MRR. `mrr` (gated, floor 0.85) and `corpusMrr` (reported only) are different coordinate spaces — do not read the second as a retrieval defect.

Standing hazards to write tests against, learned here:

- **A clean-database test can pass against a real bug.** Seed a _neighbor's_ rows, not only the subject's, wherever a table is shared across entities.
- **Mutation-verify every lock you call a lock** — roughly a quarter of candidate regression tests written in this repo were vacuous until someone reverted the fix and watched them fail.
- **A wrong count reads as a finding.** `0/410 edges resolved` and `withClaim: 0` were both bugs in the probe (path normalization; `article > mark`, which matches nothing — the markup is `<article><p><mark>`). A census probe asserts an independently-derived total; it never just reports.
- **Assert shape when correctness and cost diverge** — e.g. capture `EXPLAIN` output to prove the planner uses a partial index, since the rows come back either way.
- **A third-party rule can be nondeterministic, and a blocking gate cannot hold one.** Measured 2026-08-12: axe's `scrollable-region-focusable` reported a violation on one of five runs over an unchanged page whose geometry was identical throughout. The rule is disabled and the criterion is covered by a probe in `apps/docs/tests/a11y.test.ts` that reads the geometry itself. Measure the flake before trusting or before suppressing.
- **A measurement can describe the harness rather than the subject, and it reads as a regression.** Measured 2026-08-14: Lighthouse scored one unchanged page `1, 1, 0.81` at identical `screenEmulation` and host speed, the outlier carrying `CLS 0.427` beside `TBT 0 ms` and `LCP 324 ms` — a shift whose recorded box (1335px wide, ending at x=2370) does not fit the 1350px viewport it was supposedly measured in, because Lighthouse's own viewport emulation raced the first paint. So `categories:performance` aggregates `optimistic` (contention can only depress a static page's score) and layout stability is gated by `apps/docs/tests/layout-stability.test.ts`, which fixes the viewport before navigating. Check whether a metric's units and geometry are even possible before believing it.

The docs site's accessibility gate carries a **declared baseline** — `KNOWN_A11Y_FAILURES` in `apps/docs/src/gates.ts`, currently one violation owned upstream by Starlight (its search button's label/name mismatch). It is a ratchet, not an exemption: a violation outside it fails, and an entry that stops firing fails too, so a fix cannot leave its suppression behind. Each entry's `signature` must match every offending node, so the same rule failing for a new reason is still a failure. The layout probe carries the same shape of baseline — `KNOWN_LAYOUT_SHIFTS`, one bounded Starlight right-sidebar shift — where an entry is a bound (`node` + `most`), not a license.

## Security gates and the VEX ledger

The scanners **report**; the repository ruleset **gates**. Six tools block a merge at `alerts_threshold: errors` / `security_alerts_threshold: high_or_higher` — CodeQL, Semgrep OSS, Trivy, Grype, osv-scanner, betterleaks. **Scorecard is deliberately not one of them**: its high findings are repo posture (`BranchProtectionID`, `CodeReviewID`, `TokenPermissionsID`) and `MaintainedID` scores commit cadence, so gating on it would block PRs for reasons unrelated to any diff and would flip with the calendar. A gate a quiet fortnight can turn red is a gate people learn to bypass.

CodeQL lives in its own workflow (`javascript-typescript`, `build-mode: none`, `security-extended`) rather than as a mise task, because its analysis runs inside the action — there is no local command it could drift from, which is the reason every _other_ scanner IS a mise task. Its `init`, `analyze`, and `upload-sarif` must pin the same version; mixing them is unsupported.

**An exception is an OpenVEX statement, never a click.** `security/memhtml.openvex.json` is the ledger, and the scanners disagree about reading it (probed 2026-08-18): grype 0.111.1 and trivy 0.70.0 take `--vex`, osv-scanner 2.5.0 has no VEX support at all. So `osv-scanner.toml` is **generated** from the ledger by `scripts/vex-to-osv-config.mjs` — edit the ledger, run `mise run security:vex`, commit both. `tests-integration/tests/vex.test.ts` gates the pair, and the assertions that matter are the silent ones: a status or justification outside the spec enum makes a scanner decline to match rather than error, so the finding reappears while the document reads as applied; and `affected` / `under_investigation` must never render an ignore entry, which would invert the ledger while still parsing. Aliases are expanded because osv-scanner reports the GHSA where Dependabot and trivy report the CVE. A VEX-suppressed finding auto-closes as `fixed`, which is why this is preferred to dismissing an alert: the record is in git.

Two hazards this setup exists to answer, both measured here:

- **A scanner can exit 0 having produced nothing.** `--exit-code=0` / `|| true` collapses "found none" and "never ran" into one status. `security:leaks` therefore verifies its SARIF and retries once before failing; the other scanners still carry the hole.
- **Measure a finding before believing OR dismissing it.** CodeQL raised two identical-looking `js/polynomial-redos`; one was a real order-dependence (a regex that takes 3049 ms alone, defused only by a preceding collapse, on a function with 42 call sites) and one was a false positive measured linear at 128k. Cost-curve assertions lock both, because the reordered version returned byte-identical output in 5.5 seconds — this defect class is invisible to output.

## Conventions

Conventional Commits on a typed branch (`feature/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`, `test/…`, `spec/…`); a clean local merge to `main` is fine provided the branch is green. `deps` is also accepted, since `.github/dependabot.yml` sets it as its prefix. **A type moves a version and a scope does not save you**: `fix(ci):` on a scanner task cuts a release PR whose changelog describes a change that ships nothing — CI-only work is `ci:`. Biome formatting is non-negotiable and machine-applied: double quotes, no semicolons, 2-space indent, 100 columns, no trailing commas. `noExplicitAny`, `noNonNullAssertion`, and unused-variable/import are errors; `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.

Releases are cut by release-please from those Conventional Commit subjects and published to npm with OIDC trusted publishing as **one package, `memhtml`**, carrying two binaries. `RELEASING.md` documents the flow, the fifteen version sites, and the failure signatures. Commit subjects therefore move version numbers: `feat:` the minor, `fix:` the patch, `!`/`BREAKING CHANGE:` the major.

**The thirteen workspace packages are `private` and cannot publish.** `mise run package:assemble` runs **tsdown** (`tsdown.config.ts`) to bundle the two bins into `dist-package/dist/`, copies the run-time assets beside them, and generates the manifest from `scripts/package-manifest.mjs`. Two rules hold that build together, and both cost real debugging:

- **Externals are patterns that match subpaths, derived from the manifests.** `"effect"` does not match `effect/unstable/cli`, and externalizing only the bare name inlined the rest and took `memhtml-mcp.mjs` from 192 kB to 1.45 MB — silently, because tsdown's bundled-dependency hint reports only top-level names. `node-html-parser`, `highlight.js`, and `eve` must stay external for a stronger reason: their FILES are read or spawned, not imported.
- **Assets are copied with a directory `from` and `to: OUT_DIR`.** A glob plus `flatten: false` keeps each match's path relative to the glob's base, so `packages/index/migrations/**` becomes `migrations/index/migrations/…` — a directory that exists, holds no `.sql` at its top level, and applies zero migrations. The symptom was `no such table: files` on the first write.

`mise run package:smoke` is the only gate whose subject is the artifact: publint, then install the tarball and drive **every one of the 39 commands, all 15 MCP tools, and all three MCP resource templates** through the installed binary. The check total is whatever that run reports (`checks` in its own summary) rather than a number restated here, because only the run can count it and a stale total reads as a finding. The surface is enumerated from `memhtml manifest`, `tools/list`, and `resources/templates/list`, each diffed for set equality against the script's own invocation table, so a new command, tool, or resource fails a census rather than going untested. The resource census also asserts its read paths are multi-segment: a single-segment read passes under a route no client can use, which is how the `memhtml://file/{path}` routing defect reached a release. It is outside `check` because it needs the registry, and `check` is offline by construction.

`package:smoke:live` adds the three edges the credential-free run cannot see — Bedrock embeddings, the sleep phases that call a model, and the consolidator distilling a transcript through eve — and is what lefthook's pre-push runs when a credential is present, saying so on stderr when it cannot. Reaching the consolidation phase needs a transcript over `TRACE_MIN_BYTES` (8 KB) whose mtime predates `TRACE_QUIET_MILLIS` (1 hour); a fresh fixture fails both and the phase reports `batch: 0`, which is correct behavior that reads as coverage.

`spec/memhtml.symspec.json` is the EARS requirements ledger (keys like `RET-3`, `STORE-2`, each naming its verification method and the code that satisfies it) — retiring or adding a requirement is its own `spec:` commit. `docs/backlog.md` is the fine-grained ledger, `ROADMAP.md` the system-level view with measured benchmark standing. Durable lessons land in `.erpaval/solutions/**` as the rule, never the diff.

Artifacts describe what the code does now — never what it did before. No "used to", "previously", "this replaces". A dated, probed external fact ("probed live 2026-08-03: …") is present-tense knowledge and stays.

# 006 — derived task plan

Derived from `spec.md`. Session `session-046ecf`, 2026-08-12. Five waves, 13 tasks, 63 acceptance
criteria.

Branch: `feature/docs-site`. Gate at each wave boundary is `mise run check` green plus the wave's own
verification. Nothing merges to `main` until wave 5 closes.

## Pinned dependency set

Every version below was resolved live against the registry on 2026-08-12 and, where marked
**(built)**, installed and built successfully in a throwaway probe site.

| Package | Version | Note |
|---|---|---|
| `astro` | `^7.2.1` **(built)** | caret, never exact — `minimumReleaseAgeStrict` fails resolution rather than falling back |
| `@astrojs/starlight` | `^0.41.7` **(built)** | floor 0.41.5 for the `docsSchema({extend})` enum fix; peers `astro ^7.0.2`, dropped Astro 6 |
| `typescript` | `6.0.3` | **docs-app-local devDependency**; the repo stays on 7.0.2 |
| `@astrojs/check` | `^0.9.10` | dev |
| `starlight-llms-txt` | `^0.11.0` | peers `astro ^7`, `starlight >=0.41` |
| `starlight-links-validator` | `^0.25.3` | runs inside `astro build` |
| `starlight-heading-badges` | `^0.8.0` | |
| `starlight-package-managers` | `^0.12.0` | |
| `starlight-sidebar-topics` | `^0.8.0` | the three Diátaxis topics |
| `astro-og-canvas` | `^0.13.0` | per-page social images |
| `@expressive-code/plugin-line-numbers` | `^0.44.1` | matches Starlight's bundled Expressive Code |
| `@expressive-code/plugin-collapsible-sections` | `^0.44.1` | |
| `cspell` | `^10.0.1` | |
| `astro-d2` | `^0.13.1` | peers `astro >=7`; needs the `d2` binary — **pending D3 re-decision** |
| `@axe-core/playwright` | `^4.13.0` | blocking a11y gate (D4) |
| `@lhci/cli` | latest at scaffold time | blocking perf gate (D4), `staticDistDir` mode |
| `starlight-md-txt` | `^0.1.0` | raw `.md` routes via `injectRoute`; real remark-mdx AST unwrap, base-correct by construction |
| `starlight-base-path` | `^0.2.1` | auto-prefixes `base` onto content links; Sätteri-aware |
| `@memhtml/cli` | `workspace:*` | the generated reference's source; gives turbo its `^build` ordering edge |

All eleven original KEEPs were re-verified 2026-08-12 at exactly these versions, with no breaking
release shipped past any, and every Markdown-touching one confirmed dual-processor aware.

**Deferred, not rejected:** `starlight-auto-sidebar ^0.4.0` (sidebar order from `_meta` files) ·
`@inox-tools/star-warp ^2.0.0` (tightest peers on the official page, zero visual footprint) ·
`astro-contributors ^0.9.0` (does admit Astro 7 — the prior pass's successor recommendation holds).

**All 21 Starlight themes: skipped categorically.** This site overrides essentially the whole visual
layer, so a theme is a stylesheet installed in order to be fought.

**Traps found on the official page** — appealing and unusable, each with how we know:
`starlight-toc-overview-customizer` was **unpublished 2026-01-01** (the registry returns 200 with
`versions: []`) and is still listed · `starlight-markdown-blocks@0.1.1` **throws under Sätteri** by
design per its CHANGELOG, and it was the best RFC-furniture candidate · `starlight-copy-button` was
never published (404; its GitHub caps `astro ^5.15.9`) · `astro-mermaid@2.1.0` is inert under Astro 7
(its issue #71) · `astro-plantuml` caps Astro 5 **and POSTs diagrams to a remote server** ·
`starlight-to-pdf@1.4.0` abandoned 16 months — which stings, because a spec-styled site is exactly
what wants a PDF rendering. `starlight-typedoc`'s rejection is now precise: `typedoc@0.28.20` peers
TypeScript `… || 6.0.x`, so TS 7 is excluded by declaration, not just by crash.

**Correction to the earlier pass:** `starlight-ion-theme` *is* on npm (2.4.0) — the prior lookup used
the wrong package name. It is skipped on the categorical themes rule, not for absence.

**Hand-rolled rather than installed:** the page-action controls (AC-7-7), scroll-to-top (three lines),
contributor list, download links, and the site credit.

Two **mise tools** are added alongside the packages, pinned by `mise.lock` like the rest:
`d2` (diagram rendering) and whatever browser `@axe-core/playwright` resolves to. Acquiring the
browser through mise, or through a cached CI step, is preferred over a per-run download — see
AC-9-7.

Do **not** declare `@astrojs/mdx`, `@astrojs/sitemap`, `astro-expressive-code`, or `pagefind` —
Starlight carries them as direct dependencies and auto-applies both integrations.

**Rejected, with cause:** `expressive-code-twoslash@0.6.1` peers `^0.41.7` against Starlight's bundled
0.44.x — unsatisfiable · `starlight-contextual-menu@0.1.5` caps at `astro ^5` ·
`starlight-contributor-list` npm-deprecated (successor `astro-contributors@0.9.0`) ·
`starlight-site-graph@0.5.0` stale 11.5 months · `starlight-theme-ion` / `-mine` do not exist on npm ·
`starlight-theme-rapide@0.5.2` zero open PRs, still dev-deps Astro 6 · `@astrojs/starlight-docsearch`
(credential-bearing; see AC-4-1) · `withastro/action` (see AC-8-7) · TypeDoc (see Deferred).

## Dependency set, revised — prefer a dependency over local code

Settled 2026-08-12 under an explicit "lean into plugins and deps" bias. A dependency still loses when
it ships a verified defect, is unmaintained or incompatible, or collides with one we need — but when it
loses, the next move is a better dependency, not local code. Set grows 12 → 21.

**Config beats a plugin beats code.** Starlight 0.41.7's `integrations/markdown-plugins.ts` *additively
mutates* the processor we supply, so we own `markdown.processor` and Sätteri's opt-ins are reachable
with `mdastPlugins` a sanctioned extension point. Three of the six RFC-furniture gaps close in two
lines of `astro.config.ts` and need no dependency at all: **footnotes are on by default** (GFM, with
customizable labels and backrefs), **definition lists are a feature flag**
(`features: { definitionList: true }`), and **directives are already force-enabled by Starlight**.

**One install-blocking trap, corrected:** declare `starlight-links-validator` as **`^0.25.2`**, not
`^0.25.3`. 0.25.3 shipped 2026-08-12, so under `minimumReleaseAge: 1440` + `minimumReleaseAgeStrict`
a `^0.25.3` range has **no satisfying version and the install fails outright**. `^0.25.2` floats up on
its own once the release ages past the window.

**Promoted to install:** `starlight-auto-sidebar ^0.4.0` · `@inox-tools/star-warp ^2.0.0` (tightest
peers on the official page, zero UI footprint) · `astro-contributors ^0.9.0` · `starlight-changelogs
^0.5.1` · `astro-og-canvas ^0.13.0` · `starlight-scroll-to-top ^1.0.1` (source confirms
`injectScript('page')` and no component-slot override — the cleanest integration surveyed) ·
`starlight-cooler-credit ^0.6.0`, with the caveat that it claims `TableOfContents` and `Pagination`,
and `TableOfContents` is contested by the numbered table of contents.

### The one deliberate exception to the bias

`starlight-md-txt` owns the `.md` routes and the page-action buttons are **local**, roughly twenty
lines. Reasoning, measured on this project's own content rather than in the abstract: the `.md` copy in
`starlight-page-context-action` cannot be config-disabled while keeping the button
(`shouldGenerateMarkdown = copy || viewMarkdown || llmsTxt`), and its extractor is regex-based — it
**discards `<TabItem label>`**, which makes the pnpm / npm / yarn variants of an install snippet
indistinguishable, and it leaks raw JSX for unknown components because its tag-strip pass is commented
out. This site installs `starlight-package-managers`, whose whole output is exactly those tabs, so the
defect lands on the most common component we ship. `starlight-md-txt` unwraps through a real AST
transform and loses only on self-closing components. Head-to-head on our content: md-txt wins 3, ties
3, loses 1.

Hand-rolling the buttons also buys the **Cursor** target, which no dependency provides —
`starlight-page-context-action`'s `actions` is a closed boolean set with no custom-target hook, and
`starlight-page-actions`' Cursor link is malformed.

### Section numbering — no dependency can do it

Confirmed dead: `remark-heading-numbering@0.0.3` (2023), `remark-sectionize`,
`@vivliostyle/remark-sectionize` are all inert under Sätteri, and the `satteri-*` namespace has no
numbering plugin. But the deeper finding is that **an AST plugin is the wrong shape regardless**:
`starlight-md-txt` reads `entry.body`, the raw pre-processor source, so an mdast transform would number
the HTML and `llms.txt` while leaving the raw `.md` routes unnumbered — a human citing "§3.2" and an
agent reading the Markdown would disagree about which section that is.

**Therefore: numbers are authored literally into the source headings**, gated by a contiguity test.
Simpler than a plugin, and it is the only option where every surface agrees.

### Deferred

`astro-pdf ^1.10.1` (real and maintained, peers `astro ^7`) — a spec-styled site genuinely wants a PDF
rendering, but it pulls `puppeteer`, whose postinstall downloads Chromium. That is a **second** browser
stack alongside Playwright for the axe gate, and a PDF is not in the must-ship set. Revisit once the
site is live, and check first whether it can be pointed at Playwright's Chromium.

`starlight-theme-mdbook@0.1.5` — ships no font overrides and near-monochrome white/black/blue tokens,
which is close to the brief. It still loses: nine component overrides including `PageSidebar`, which
collides with the page actions, and `Pagination`, which collides with the credit. **Lift its ~10 lines
of tokens; do not install it.** The remaining 20 themes stay skipped on the categorical rule.

**Total install cost of leaning in:** one new `allowBuilds` answer, and only if `astro-pdf` lands
(`puppeteer`). Zero new answers otherwise across ~60 manifests, no new mise tools, and one benign peer
warning (`vite-plugin-virtual@0.3.0` caps `vite ^7`).

## Wave 1 — the package, alone

One task. Everything else is blocked on it, because `@memhtml/*` exports resolve only to `./dist` and
because an unanswered `allowBuilds` entry makes `pnpm install` refuse.

### T-AC-1-1 — scaffold `@memhtml/docs`
**Covers** AC-1-1 … AC-1-10, AC-9-2.
**Touches** `apps/docs/**` (new), `pnpm-workspace.yaml` (`allowBuilds` + one comment), `.gitignore`
(`.astro/`), `mise.toml` (two tasks).
**Does**
- `apps/docs/package.json`: `@memhtml/docs`, private, ESM, caret ranges, local `typescript@6.0.3`,
  scripts `build`/`dev`/`typecheck` (= `astro check`)/`lint`.
- `apps/docs/tsconfig.json` extending `astro/tsconfigs/strictest` — **not** `tsconfig.base.json`, no
  `composite`, not referenced by anything. Fall back to `astro/tsconfigs/strict` only if `strictest`
  cannot be satisfied against the plugin surface, and record which was used and why.
- `astro.config.mjs` with `starlight()`, `image: {service: passthroughImageService()}`, and origin +
  base read from config with production defaults.
- `pnpm-workspace.yaml`: add `esbuild: false` to `allowBuilds` with the justifying comment. Measured
  2026-08-12, that was the **only** new gate across 352 packages — not sharp, not pagefind, not
  `@astrojs/compiler-rs`, not lightningcss, not rolldown. **That inventory predates the D4 gate
  packages**: `@axe-core/playwright` and `@lhci/cli` pull a browser driver whose acquisition is an
  install-time step, so re-derive the inventory empirically after adding them and answer every new
  entry (AC-9-7). Do not assume the count is still one.
- `mise.toml`: `docs:dev` and `docs:build`, each a thin `run = "pnpm --filter @memhtml/docs <script>"`
  delegation with `raw_args = true`, no `sources`/`outputs`/`cache`, no `usage` spec.
- Leave `turbo.json` untouched: `build` already gives `dependsOn: ["^build"]` + `outputs: ["dist/**"]`,
  and `.astro/**` must **not** become an output (it holds `dev.json` with a live PID; a restored cache
  makes `astro dev` refuse to start).
**Verify** `pnpm install --frozen-lockfile` exit 0 with no undecided-build prompt · `astro check`
exit 0 · `astro build` exit 0 · `pnpm peers check` zero violations · `mise run check` exit 0 ·
`git status` clean after a build.
**Regression lock** break a component override deliberately and assert `astro check` exits non-zero
while `astro build` exits 0 — the mutation that proves the typecheck task is not vacuous (AC-1-7).

## Wave 2 — four independent tracks

All four start together once wave 1 is green. None reads another's output.

### T-AC-2-1 — information architecture and the Learn topic
**Covers** AC-2-1, AC-2-3, AC-2-8, and the Learn half of AC-2-7.
**Does** the three-topic Diátaxis sidebar; the twelve `RUNBOOK.md` sections as twelve how-to pages;
four tutorials (install/init, first memory, first retrieval, wiring the MCP server); the honest
clone-and-build install page.
**Verify** census probe: twelve Operations pages, count derived from `RUNBOOK.md`'s numbered headings
rather than a literal.

### T-AC-2-2 — the Internals topic
**Covers** AC-2-2, AC-2-5, and the glossary (AC-2-7).
**Does** thirteen `docs/design.md` chapters as thirteen pages with citations preserved; the 22-term
glossary from the inventoried `file:line` provenance; the benchmark table with its judge caveat
adjacent; `docs/format.md`, `docs/tasks.md`, `docs/code-mode.md` placed.
**Verify** census probe on chapter count derived from source; a test asserting the caveat and the
table share a page.

### T-AC-3-1 — the virtual-page loader
**Covers** AC-3-1 … AC-3-4.
**Does** a content-layer loader injecting entries into the `docs` collection from `memhtml manifest`
and the exported registries — 36 commands, 6 guide topics, 32 response types, 15 error codes, 7 config
vars, 14 MCP tools, 2 resources, 61 symspec requirements, 11 migrations, 15 sleep phases, 4 RRF arms,
10 memory types, 14 edge rels, 12 package descriptions. `filePath` is mandatory on every injected
entry or the loader throws a `TypeError`. Reads the manifest; never constructs the application layer,
because that opens a database.
**Verify** per-registry census probe asserting page count equals registry length read from source ·
the build runs with no database present · `AGENTS.md`'s existing byte-compare test still passes.
**Regression lock** append a synthetic member to a registry in a fixture and assert the rendered page
count increments (AC-3-4). A test that passes without the loader is vacuous.

### T-AC-8-1 — publication
**Covers** AC-8-1 … AC-8-8.
**Does** `.github/workflows/pages.yml`: `push: [main]` + `workflow_dispatch`; top-level
`permissions: {contents: read}` with `pages: write` + `id-token: write` on the deploy job only;
`concurrency: {group: pages, cancel-in-progress: false}`; `actions/checkout@v7` →
`jdx/mise-action@v4` → the `pnpm store path` + `actions/cache@v6` pair keyed on `pnpm-lock.yaml` →
`mise run install:ci` → `mise run docs:build` → `actions/upload-pages-artifact@v5` with
`path: apps/docs/dist` → `actions/deploy-pages@v5` in `environment: github-pages`. A leading comment
explains why the workflow is separate from `check.yml`. No `.nojekyll`, no `configure-pages`, no
`withastro/action`, no `setup-node`. No second PR workflow — `mise run check` already builds the app.
**Verify** a real workflow run deploys; `_astro/` asset returns 200; a build under a non-root base
emits no unprefixed internal href.
**Human prerequisite** Settings → Pages → Source = "GitHub Actions". Pages is currently disabled
(`GET /repos/memhtml/memhtml/pages` → 404), so the first run fails without this click.

## Wave 3 — three tracks

### T-AC-6-1 — raw Markdown routes
**Covers** AC-6-1 … AC-6-6. **Blocked by** T-AC-2-1, T-AC-2-2, T-AC-3-1.
**Does** wires `starlight-md-txt` for `<path>.md` on every page including virtual ones, each with a
canonical backlink. Prefer it over a hand-rolled `src/pages/[...slug].md.ts` because it unwraps MDX
through a real AST transform — generically unwrapping unknown components is the hard part, and a regex
cleaner leaks JSX — and because `injectRoute` makes it base-correct by construction. Where the plugin
needs supplementing, use `render(entry)`, never `entry.rendered`, which is `undefined` for `.mdx`.
Enforce the single-producer rule: nothing else may emit `<path>.md`.
**Verify** for every page in the collection there is a `.md` artifact, count derived from the
collection · a fixture `.mdx` page's raw route is non-empty and its heading count matches an
independently derived total · exactly one artifact per raw route.
**Note** the plugin has two releases. Tests are written against behavior, not the plugin, and its
~220-line surface can be vendored if it stalls — so the risk is bounded and reversible.

### T-AC-10-1 — visual identity
**Covers** AC-10-1 … AC-10-3. **Blocked by** T-AC-2-1, T-AC-2-2.
**Does** accent ramp derived from the four `README.md` `classDef` fills; self-hosted variable font;
favicon; per-page OG images via `astro-og-canvas`; a landing page that is not the default splash.
Note `hero.actions[].link` emits an unprefixed href — a 404 under a base segment.
**Verify** accessibility pass over `dist/`; no unprefixed hero href.

### T-AC-10-2 — diagrams
**Covers** AC-10-4, AC-10-5. **Blocked by** T-AC-2-2, T-AC-10-1.
**Does** `astro-d2` wired with `d2` as a mise tool; the four `README.md` diagrams rewritten in D2 and
styled from the AC-10-1 palette; 5–8 new diagrams for the Internals chapters (write path, index
rebuild, sleep phase sequence, RRF fusion, path algebra are the identified gaps). Keeps `README.md`
readable on GitHub, which renders Mermaid natively and does not render D2 — so the README either
retains its Mermaid blocks with D2 sources maintained separately for the site, or substitutes
committed SVG. Decide which and record it.
**Verify** static SVG in `dist/` and no diagram JS bundle; the README renders on GitHub.

### T-AC-5-1 — llms.txt
**Covers** AC-5-1 … AC-5-5. **Blocked by** T-AC-2-1, T-AC-2-2, T-AC-3-1.
**Does** `starlight-llms-txt` emitting `llms.txt` and `llms-full.txt` under the base segment, linked
from every page's `<head>`. The redaction denylist runs against the **bundles**, not only the HTML,
because the plugin's `exclude` affects `llms-small.txt` only. Records why `robots.txt` and
`.well-known/` are not attempted.
**Verify** both routes exist and are non-empty · size under the 1 MB ceiling · denylist clean.

## Scope priority — what yields if the work compresses

The agent-facing surface is **non-droppable**: AC-5 (llms.txt, llms-full.txt, sitemap, the `<head>`
discovery layer), AC-6 (raw `.md` routes), AC-7 (copy, open-raw, and the verified assistant deep
links), and AC-11 (the agent-addressed page and inline agent notes). These ship.

What yields first, in order: the diagram set (T-AC-10-2) down to the four existing figures · visual
refinement (T-AC-10-1) down to the palette and type stack alone · the blocking performance budget
(T-AC-9-2) demoted to scheduled. Content breadth yields before content accuracy — fewer pages is fine,
a wrong page is not.

The machinery is deliberately proven early rather than bolted on: the virtual-page loader (wave 2)
produces well over a hundred pages by itself, so the raw routes, sitemap, and llms bundles in wave 3
have real content to exercise long before the authored prose is finished.

## Wave 4 — page actions and the agent surface

### T-AC-7-1 — copy, open, and forward
**Covers** AC-7-1 … AC-7-6. **Blocked by** T-AC-6-1.
**Does** a component override at the page header offering copy-as-Markdown, open-raw, and verified
deep links. Evaluate `starlight-page-context-action@0.4.3` against a hand-rolled override and pick
one; if the plugin ships a control whose URL does not match its target's documented format, that
control is replaced rather than shipped. `starlight-page-actions@0.7.0` is rejected outright — it
emits `cursor.com/link/prompt?${prompt}` with no `text=` key and its `normalizeUrl` discards the base
path.
**Verify — the dead-button lock** a table-driven test asserting every shipped control's href matches
its verified format and carries a non-empty payload, and that payloads stay within 7,500 characters.
Shipped targets and their verified formats are enumerated in AC-7-3; **Codex web is confirmed absent**,
so a Codex control is the desktop scheme or it is not shipped. Labels say "Open in", never "Ask".

### T-AC-11-1 — the agent-addressed surface
**Covers** AC-11-1 … AC-11-6. **Blocked by** T-AC-3-1, T-AC-6-1, T-AC-5-1.
**Does** the agent page — opening address, the assumptions-to-unlearn section, the door-selection guide
(CLI vs MCP), the ordered reading list carrying each entry's raw `.md` URL, and the pointers to
`llms.txt` / `llms-full.txt` / the `.md` convention. Plus the inline agent-note component, built so the
note survives into the `.md` twin and `llms-full.txt` and carries meaning without color. Plus the
canonicality decision across the four agent-facing surfaces, with the divergence check that enforces it.
**Substance, not invention** — every claim on this page already exists in the repo: the 6 `GUIDE`
topics, `memhtml manifest` as the self-describing entry, the append-only `code` registry and the rule
that agents branch on `code` and never on `error` prose, eviction as a `git mv` so absence means
archived, the git tree as system of record with `index.db` disposable, one fact per memory.
**Verify** every URL on the page 200s · each stated trap cites a resolving source · every quantity is
a build-time census, never a literal · the agent note appears in HTML, in the `.md` twin, and in
`llms-full.txt` · the divergence check asserts shared facts are *equal* across the four surfaces, not
merely present.

## Wave 5 — gates, then merge

### T-AC-9-1 — quality gates
**Covers** AC-9-1, AC-9-3, AC-9-5, and the AC-2-4 / AC-2-6 redaction scan as a build-time gate.
**Does** `starlight-links-validator` failing the build on a broken internal link; `cspell` with a
project dictionary over the domain vocabulary; the redaction denylist scan over HTML **and** llms
bundles; `lychee` on a schedule, non-blocking.
**Verify** each gate is mutation-verified — introduce a broken link, a typo, and a denylisted token,
and assert each fails. A gate that has not been watched to fail is not a gate.

### T-AC-9-2 — accessibility and performance budgets, blocking
**Covers** AC-9-4, AC-9-6, AC-9-7. **Blocked by** T-AC-10-1, T-AC-10-2.
**Does** `@axe-core/playwright` over a bounded representative page set — one landing page, one authored
prose page, one generated virtual page, one raw-route consumer — asserting WCAG 2.2 AA, with 2.4.11
(focus not obscured) and 2.5.8 (target size) as the criteria most likely to bite a customized
Starlight. `@lhci/cli` against `staticDistDir` asserting **category floors, never wall-clock
timings** — a millisecond assertion on a shared runner fails for reasons unrelated to the commit, and
that flakiness is the whole objection to this gate. Browser acquisition is cached in CI and answered
in `allowBuilds`.
**Verify — both mutation-verified** introduce a contrast or focus violation and watch axe fail; ship a
deliberately oversized asset and watch the budget fail. Neither gate is trusted until it has been
watched to fail.
**Note** this task is the one most likely to want its scope trimmed after first contact. If the perf
budget proves flaky in practice despite the category-floor constraint, the honest move is to demote it
to scheduled and say so — not to raise the floor until it passes.

### T-AC-VAL — validation sweep
Full `mise run check`; a real deploy; live probes of the deployed site (`_astro/` 200, `.md`
content-type, subpath `llms.txt` 200, search returns a generated page); then the Gate 2 review.

## Verification strategy — where this plan expects to be wrong

The repo's standing lessons say a green suite is the likeliest place a bug hides, so four of them are
wired in as locks rather than hopes:

1. **A vacuous typecheck.** `tsc --noEmit` typechecks zero `.astro` files and `astro build`
   typechecks nothing; both exit 0 against a broken override. T-AC-1-1 carries the mutation.
2. **A wrong count reading as a finding.** Every page-count assertion derives its total from the
   source registry or heading list, never from a literal copied from output. `entry.rendered` being
   `undefined` for `.mdx` is exactly the trap: it yields an empty heading list that looks like a
   content defect.
3. **A dead button.** Six deep-link formats, two of them undocumented and one confirmed absent, and a
   third-party plugin already shipping a malformed one. The table-driven href test is the only thing
   standing between "we shipped five buttons" and "we shipped five buttons that work".
4. **A silent base-segment 404.** `hero.actions[].link` is unprefixed and `Astro.site` excludes the
   base. A build under a non-root base is asserted to emit no unprefixed internal href.

## Decisions — all settled 2026-08-12

Full reasoning is in `spec.md` § Settled decisions.

| | Decision | Effect on this plan |
|---|---|---|
| **D1** | Project site, `base: '/memhtml'`, origin + base as config | as planned; `robots.txt` and `.well-known/` knowingly dropped |
| **D2** | Generated command pages carry no examples; `CommandSpec` unchanged | adds AC-3-5/AC-3-6 guide-link requirement to T-AC-3-1 |
| **D3** | `astro-d2`, build-time SVG, `d2` as a mise tool | adds **T-AC-10-2** to wave 3 |
| **D4** | axe **and** Lighthouse are blocking | promotes **T-AC-9-2** to a real blocking task; re-derives the `allowBuilds` inventory in wave 1 |
| **D5** | No second formatter; Biome's scope unchanged | as planned |

### What D4 costs, stated plainly

Choosing blocking budgets over scheduled ones buys a real guarantee — the WCAG 2.2 AA claim in
AC-10-3 becomes enforced rather than asserted once — and it charges three things: a browser driver in
CI, a new `allowBuilds` answer, and a gate whose failure mode is sometimes the runner rather than the
commit. The category-floor constraint in AC-9-6 is what keeps the third from becoming routine. If it
becomes routine anyway, demote the perf gate to scheduled and record that; do not quietly lower the
floor until it passes, which converts a gate into decoration.

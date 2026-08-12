# 006 — the public documentation site

EARS specification. Session `session-046ecf`, 2026-08-12.

The system under specification is `apps/docs`: an Astro Starlight static site published to GitHub
Pages, serving the memhtml documentation to two audiences — a developer evaluating or operating the
system, and an AI agent reading it programmatically.

Every requirement names its verification method. `[P]` marks an AC that is parallel-safe against its
wave-mates; otherwise `Dependencies:` names what must land first. Numeric fields carry their
coordinate space per the metarepo naming rule.

## Terms

- **docs app** — the `@memhtml/docs` workspace package at `apps/docs`.
- **generated page** — a documentation page whose content is derived from a source of truth in the
  repo (`COMMANDS`, `ERROR_CODES`, `SLEEP_PHASES`, …) rather than authored as a file.
- **virtual page** — a generated page injected into Astro's `docs` content collection by a
  content-layer loader, with no corresponding file on disk.
- **raw route** — the URL at which a page's underlying Markdown is served as `text/markdown`.
- **page action** — a control in the page header that copies or forwards the page's Markdown.
- **base segment** — the URL path prefix the site is mounted under (`/memhtml` on a project site,
  `/` on a custom domain or org site).

---

## AC-1 — the workspace package

**AC-1-1 [P]** (Ubiquitous) The docs app shall be a workspace package named `@memhtml/docs` at
`apps/docs`, `private: true`, `type: module`, discovered by the existing `apps/*` glob without any
edit to `pnpm-workspace.yaml` `packages`.
*Verification:* test — `pnpm ls --depth -1` lists `@memhtml/docs`.

**AC-1-2 [P]** (Ubiquitous) The docs app shall declare `astro` and `@astrojs/starlight` as caret
ranges, never exact pins.
*Rationale:* setting `minimumReleaseAge` turns on `minimumReleaseAgeStrict`, under which an exact pin
on a too-young version **fails resolution** rather than falling back to the previous release.
*Verification:* inspection + test — `grep -E '"(astro|@astrojs/starlight)": "\^' apps/docs/package.json`.

**AC-1-3** (Event-driven) When `pnpm install --frozen-lockfile` runs, the install shall complete with
exit 0 and shall not print an undecided-build prompt.
*Implementation:* `pnpm-workspace.yaml` `allowBuilds` gains exactly one new entry, `esbuild: false`,
with a comment recording that esbuild's postinstall only swaps the JS launcher for the native binary
while the JS API resolves `@esbuild/<platform>-<arch>` itself at call time — the path Astro and Vite
take. Measured 2026-08-12: denied, `esbuild.transform()` works and `astro build` exits 0.
*Verification:* test — a clean `--frozen-lockfile` install in CI.
*Dependencies:* AC-1-1.

**AC-1-4** (Unwanted behavior) If a dependency added later carries an install-time build script, then
`pnpm-workspace.yaml` shall answer it explicitly rather than leaving it undecided.
*Rationale:* pnpm refuses to install while any build-scripted package is unanswered, and it rewrites
the YAML with a placeholder when it hits one.
*Verification:* test — the CI install step is the standing check.

**AC-1-5** (Ubiquitous) The docs app's TypeScript configuration shall extend Astro's own strict base
and shall not extend `tsconfig.base.json`, shall not set `composite`, and shall not be added to any
package's `references` array.
*Rationale:* `tsconfig.base.json` sets `moduleResolution: NodeNext`, `verbatimModuleSyntax`,
`composite`, `lib: ["ES2023"]` with no DOM and no `jsx` — all wrong for an Astro app; joining the
project-reference graph produces a TS2883 flood.
*Verification:* test — `astro check` exit 0; `grep -L composite apps/docs/tsconfig.json`.
*Dependencies:* AC-1-1.

**AC-1-6** (Ubiquitous) The docs app shall pin `typescript@6.0.3` as its own devDependency while the
rest of the repo stays on `7.0.2`.
*Rationale:* `typescript@7.0.2`'s exports map resolves `"."` to `./lib/version.cjs`, whose entire
content is `{version, versionMajorMinor}` — no `createProgram`, no `ts.sys`, no `tsserver`, no
`lib.*.d.ts`. `astro check` detects this and exits 1 through a purpose-built guard. Microsoft's TS 7.0
release notes state it directly: *"Projects using Vue, MDX, Astro, Svelte, and others will need to
continue using TypeScript 6.0 for now."* The fix is TS 7.1 (`contentMappers`), unmerged, undated.
Measured 2026-08-12: with this pin, `astro check` exits 0 and `pnpm peers check` goes from one
violation to zero. pnpm's isolated `node_modules` makes the split structurally safe.
*Verification:* test — `astro check` exit 0 and `pnpm peers check` reports zero violations.
*Dependencies:* AC-1-1.

**AC-1-7** (Ubiquitous) The docs app's `typecheck` script shall be `astro check`, not `tsc --noEmit`.
*Rationale:* mutation-verified 2026-08-12 — against a deliberately broken component override,
`astro check` exits 1 while `astro build` **and** `tsc --noEmit` both exit 0, and `--listFiles` shows
`tsc` loading only the two `.ts` files. A `tsc`-based typecheck task would be a vacuous gate.
*Verification:* test — the mutation is re-run as a regression lock: break an override, assert
`astro check` exits non-zero.
*Dependencies:* AC-1-5, AC-1-6.

**AC-1-8** (Ubiquitous) The docs app shall select Astro's passthrough image service explicitly.
*Rationale:* the default sharp service exits 1 with `MissingSharp` even when sharp is present in the
tree, because pnpm's isolation blocks resolution from the app root. The failure is latent — it does
not appear until the first raster image.
*Verification:* test — a build containing one raster image exits 0.
*Dependencies:* AC-1-1.

**AC-1-9 [P]** (Ubiquitous) `.gitignore` shall ignore `.astro/`.
*Verification:* inspection — `git status` is clean after a build.

**AC-1-11** (Unwanted behavior) If a dependency transforms Markdown, then it shall be verified to
operate under Astro 7's default processor before it is relied upon, and a declared peer range shall
not be accepted as that evidence.
*Rationale:* Astro 7 makes **Sätteri** the default Markdown processor and no longer installs
`@astrojs/markdown-remark`. A remark-only plugin is therefore silently inert or hard-fails, and
neither outcome is visible in its peer ranges — a plugin can advertise `astro ^7` and do nothing.
Verified 2026-08-12 by grepping candidate tarballs for `isSatteriProcessor` / `mdastPlugins`.
*Corollary:* `starlight-markdown-blocks@0.1.1` throws under Sätteri by deliberate design (per its own
CHANGELOG), and `astro-mermaid@2.1.0` is inert under Astro 7 (its issue #71).
*Verification:* test — for each Markdown-transforming dependency, an assertion that its transform
actually fired, not merely that the build succeeded. A build that succeeds because a plugin did
nothing is the failure this AC exists to catch.
*Dependencies:* AC-1-1.

**AC-1-12** (Ubiquitous) The docs app shall declare `@memhtml/cli` as a `workspace:*` dependency.
*Rationale:* `@memhtml/*` exports resolve only to `./dist`, and the generated reference reads the
CLI's contract. Declaring the dependency is what gives `turbo`'s `build.dependsOn: ["^build"]` an
edge to order the CLI's build first; without it the docs build silently documents a stale surface.
*Verification:* test — a clean checkout runs `mise run docs:build` successfully with no prior build
step, and a census probe confirms the command count matches the CLI's current `COMMANDS` length.
*Dependencies:* AC-1-1.

**AC-1-10 [P]** (Ubiquitous) `turbo.json` shall not declare `.astro/**` as an output of any task.
*Rationale:* `.astro/` holds `dev.json`, which carries a live PID. Measured 2026-08-12: caching and
restoring it made `astro dev` refuse to start against a dead PID. `dist/**` alone is correct, and
`astro check` regenerates the types itself.
*Verification:* inspection of `turbo.json`; the docs app inherits `build`'s `outputs: ["dist/**"]`.

---

## AC-2 — information architecture and content migration

**AC-2-1** (Ubiquitous) The site's navigation shall be organized on Diátaxis lines into three
top-level topics — **Learn** (tutorial + how-to), **Reference**, and **Internals** (explanation) —
totalling roughly 55 pages.
*Verification:* inspection against the sidebar config.

**AC-2-2** (Ubiquitous) Each of the thirteen chapters of `docs/design.md` shall become one Internals
page, preserving its source citations.
*Verification:* test — a census probe asserts thirteen Internals pages exist and that each cites at
least one `file:line`, comparing against a count derived independently from `docs/design.md`'s `##`
headings rather than a literal copied from output.
*Dependencies:* AC-2-1.

**AC-2-3** (Ubiquitous) Each of the twelve numbered sections of `RUNBOOK.md` shall become one
Operations how-to page under Learn.
*Verification:* test — census probe, count derived from `RUNBOOK.md`.
*Dependencies:* AC-2-1.

**AC-2-4** (Unwanted behavior) If a page's source text references the private sibling repository
`memhtml-evals`, the internal benchmark handoff notes, internal task identifiers, `.erpaval/`, or
`.sarif/`, then that reference shall be removed or rewritten before the page is published.
*Known instances:* `ROADMAP.md:4, 52, 75, 273-274, 355-357`; `docs/format.md:136`;
`docs/bugs/2026-08-03-*.md:105-106`; `CLAUDE.md:183`; `ROADMAP.md:586`; all of `docs/backlog.md`.
*Verification:* test — a build-time content scan fails the build on a denylist of these tokens. The
scan is the durable gate; the one-time edit is not.
*Dependencies:* AC-2-1.

**AC-2-5** (State-driven) While the measured benchmark table is published, the judge caveat shall
appear adjacent to it on the same page.
*Rationale:* the numbers are self-run, unpublished, and cross-judge (verbatim prompt ports on
haiku-4.5 where the papers used gpt-4o / gpt-4.1-mini). A bare comparison table misrepresents them.
*Verification:* test — the page containing the table also contains the caveat text.
*Dependencies:* AC-2-1.

**AC-2-6** (Ubiquitous) `docs/backlog.md` shall not be published.
*Verification:* test — the AC-2-4 scan plus an explicit absence assertion.

**AC-2-7 [P]** (Ubiquitous) The site shall carry a glossary of the project's domain terms, each with
a one-line definition and a link to the page that develops it.
*Source:* 22 candidates already inventoried with `file:line` provenance.
*Verification:* inspection.

**AC-2-8 [P]** (Ubiquitous) The site shall state its installation path honestly as clone-and-build.
*Rationale:* probed 2026-08-12 — `npm view memhtml` and `npm view @memhtml/cli` both 404, zero
GitHub releases, zero tags, every workspace package `private: true`.
*Verification:* inspection.

**AC-2-9 [P]** (Ubiquitous) Every architecture claim on the site shall describe the shipped system.
*Two claims to get right, both taken from marketing copy that is wrong:*
- The index and state planes are **SQLite**, accessed through `node:sqlite`. Turso is not a
  dependency and not an intent (confirmed 2026-08-12). `packages/domain/tests/layering.test.ts`
  asserts the driver identity by grepping the emitted JS, so it is a tested invariant.
- Retrieval has **four** RRF arms — FTS, vector, recency, and salience
  (`packages/index/src/retrieval-sql.ts:243` `RANK_ARMS`) — not two.
*Verification:* test — the content scan of AC-2-4 also fails the build on the token `Turso`, and a
census probe asserts the retrieval page names a number of arms equal to `RANK_ARMS.length` read from
source.

---

## AC-3 — generated reference

**AC-3-1** (Ubiquitous) Every reference page whose content exists as a source of truth in the repo
shall be a **virtual page** injected into the `docs` collection by a content-layer loader, with no
generated file committed to disk.
*Rationale:* verified 2026-08-12 — an injected entry builds a real page that Pagefind indexes and
`autogenerate` sees, and `filePath` is mandatory or the loader throws a `TypeError`. A page with no
on-disk artifact cannot drift from its source, which removes the need for a drift gate on it.
*Covers:* 36 CLI commands, 3 global flags, 6 guide topics, 32 response types, 15 error codes, 7
config vars, 14 MCP tools, 2 MCP resources, 61 symspec requirements, 11 migrations, 15 sleep phases,
4 RRF arms, 10 memory types, 14 edge rels, 12 package descriptions.
*Verification:* test — a census probe asserts the page count per registry equals the length of the
registry read from source, not a literal.
*Dependencies:* AC-2-1.

**AC-3-2** (Ubiquitous) The CLI reference loader shall read the CLI's machine-readable contract and
shall not construct the application layer.
*Rationale:* `agents-doc` is special-cased ahead of layer construction in `apps/cli/src/run.ts:836-846`
because building the layer opens a database. A docs build must not open one.
*Verification:* test — the build runs with no database present.
*Dependencies:* AC-3-1.

**AC-3-3** (Ubiquitous) `AGENTS.md` shall remain a committed, generated file with its existing
byte-compare drift test unchanged.
*Rationale:* it is the agent-facing contract at the repo root and is consumed independently of the
site. The site does not replace it.
*Verification:* the existing `apps/cli/tests/agents-doc.test.ts` continues to pass.

**AC-3-4** (Unwanted behavior) If a registry gains a member, then the corresponding reference pages
shall reflect it with no edit to the docs app.
*Verification:* test — append a synthetic member to a registry in a fixture and assert the rendered
page count increments. This is the mutation-verified form of AC-3-1; a test that passes without it is
vacuous.
*Dependencies:* AC-3-1.

**AC-3-5** (Ubiquitous) A generated command page shall not carry a worked example, and shall instead
link to the guide that develops that command in context.
*Decided 2026-08-12 (D2).* `CommandSpec` carries `name`, `summary`, `args`, `flags`, and
`responseTypes` — no `examples` field — and `apps/cli/src/commands.ts` is the single source of
parsing, `manifest`, and `AGENTS.md`. Adding a field there to serve the docs site would make the
parser's contract answer to a presentation need. Examples stay in the hand-written guides, where they
have narrative context.
*Verification:* test — every generated command page contains a link to at least one guide page, and
the link resolves.
*Dependencies:* AC-3-1, AC-2-1.

**AC-3-6** (Unwanted behavior) If a command has no guide covering it, then the generated page shall
link to the topic index rather than emit a broken or absent link.
*Rationale:* 36 commands and far fewer guides — a per-command guide link cannot be assumed to exist,
and a build that silently omits it produces a reference tier that reads as complete while being thin.
*Verification:* test — a census probe reports how many commands resolve to a specific guide versus the
index, and asserts that total equals 36. The count is derived, not reported.
*Dependencies:* AC-3-5.

---

## AC-4 — search

**AC-4-1** (Ubiquitous) The site shall provide full-text search over its own pages using Starlight's
built-in Pagefind index, with no external service and no credential.
*Rationale:* measured on a 60-page corpus — 168 ms of a 3.0 s build, ~250 KB fetched lazily on first
search, 0 bytes on page load. DocSearch builds cleanly on this stack but requires Algolia program
access plus two CI secrets, and it sets `pagefind: false`, in a repo whose gate is credential-free by
construction. Revisit past ~500 pages.
*Verification:* test — `dist/pagefind/` exists after a build and a known term returns its page.

**AC-4-2** (Ubiquitous) Search shall function when the site is served under a non-root base segment.
*Verification:* test — probe the built output under the base segment.
*Dependencies:* AC-4-1, AC-8-2.

**AC-4-3** (Ubiquitous) Generated virtual pages shall be searchable.
*Verification:* test — a term unique to a generated page returns that page.
*Dependencies:* AC-3-1, AC-4-1.

---

## AC-5 — llms.txt

**AC-5-1** (Ubiquitous) The site shall serve `llms.txt` and `llms-full.txt` under its base segment.
*Note:* llmstxt.org sanctions a non-root location — *"The file can be placed at the site root, or at
any path within it, covering the pages under that path."* Verified live 2026-08-12: a subpath
`llms.txt` on GitHub Pages returns 200 `text/plain` with real content.
*Verification:* test — both routes exist in `dist/` and are non-empty.

**AC-5-2** (Ubiquitous) `llms.txt` shall be linked from every page's `<head>` so it is reachable
without relying on root-path convention.
*Rationale:* the base segment prevents origin-root discovery; an explicit link is the remedy.
*Verification:* test — the link element is present in built HTML.
*Dependencies:* AC-5-1.

**AC-5-3** (Unwanted behavior) If `llms-full.txt` would exceed 1 MB, then it shall be split or
narrowed rather than shipped whole.
*Rationale:* an unusable single bundle is a real outcome — one published `llms-full.txt` in the wild
is 57 MB. Our corpus is ~40,000 words, so this is a ceiling, not a present problem.
*Verification:* test — assert the byte size is under the ceiling.
*Dependencies:* AC-5-1.

**AC-5-4** (Ubiquitous) Content excluded from publication under AC-2-4 shall be absent from every
llms bundle.
*Rationale:* the plugin's `exclude` option affects only `llms-small.txt` (upstream issue open), so
exclusion cannot be delegated to plugin config.
*Verification:* test — the AC-2-4 denylist scan runs against the generated bundles, not only the HTML.
*Dependencies:* AC-2-4, AC-5-1.

**AC-5-6** (Ubiquitous) The site shall emit a sitemap covering every rendered page.
*Note:* Starlight auto-applies `@astrojs/sitemap` — verified 2026-08-12, `sitemap-index.xml` is emitted
without declaring the integration. What must be settled deliberately is whether the raw `.md` routes
and the llms bundles belong in it, and how a crawler discovers the sitemap at all when `robots.txt` is
unreachable on a project site (AC-5-5). The `<head>` link is the remedy, as it is for `llms.txt`.
*Verification:* test — the sitemap exists, its URLs carry the base segment, and its entry count is
derived from the collection rather than a literal.

**AC-5-7** (Ubiquitous) Every page's `<head>` shall point a machine reader at that page's raw route
and at the site's machine index.
*Constraint:* each line of the emitted block shall be marked in a comment as either convention-following
or a local invention, so a later reader knows which parts have external warrant.
*Rationale:* `rel="describedby"` is shipped by none of fourteen surveyed sites, including llmstxt.org
itself, so this area is thin on real convention and honesty about that matters more than the appearance
of standards compliance. GitHub Pages gives no control over HTTP response headers, so a `Link:` header
is not available — nothing may be planned around one.
*Verification:* test — the block is present on every page and each `href` resolves.
*Dependencies:* AC-6-1, AC-5-1.

**AC-5-5** (Ubiquitous) `robots.txt` and `.well-known/` shall not be attempted, and the reason shall
be recorded in the repo.
*Rationale:* RFC 9309 §2.3 requires robots.txt at the origin top-level path, and RFC 8615 §3 anchors
`.well-known/` at the root — neither is reachable under a base segment. Independently,
`upload-pages-artifact@v5`'s default tar excludes `.[^/]*`, which drops `.well-known/` entirely.
Probed 2026-08-12: there is no platform-default `robots.txt` at a `*.github.io` apex — nine orgs
probed return 404.
*Verification:* inspection — an ADR or a comment carrying this reasoning.

---

## AC-6 — raw Markdown routes

**AC-6-1** (Ubiquitous) Every documentation page shall have a raw route at its own path with a `.md`
suffix.
*Rationale:* `<path>.md` is the majority convention (Vercel, Stripe, Mintlify, Anthropic, GitHub
docs). Cloudflare's `/index.md` shape is edge-rewritten and not reproducible on static hosting.
*Implementation:* `starlight-md-txt`, which injects the route via `injectRoute` — so Astro prefixes
the base segment by construction — and unwraps MDX components through a real remark-mdx **AST**
transform rather than a regex. The AST path is the reason to prefer it over a hand-rolled endpoint:
generically unwrapping unknown components is the hard part, and a regex cleaner leaks JSX.
*Risk accepted:* the package has two releases. Its surface is ~220 lines, so vendoring it is the
fallback if it goes unmaintained, and the AC-6 tests are written against behavior rather than the
plugin, so a swap does not rewrite them.
*Verification:* test — for every page in the built output there is a corresponding `.md` artifact;
the count is derived from the collection, not a literal.
*Dependencies:* AC-2-1.

**AC-6-6** (Unwanted behavior) If two dependencies would each emit a `<path>.md` route or an llms
bundle, then only one shall be enabled for that output.
*Known collisions:* `starlight-page-context-action` copies `<path>.md` via `viteStaticCopy`, which
collides with `starlight-md-txt`; its `llmsTxt` option collides with `starlight-llms-txt` and must
stay `false`.
*Verification:* test — exactly one artifact exists per raw route, and the llms bundles have a single
producer.
*Dependencies:* AC-6-1, AC-5-1.

**AC-6-2** (Ubiquitous) A raw route shall be served as `text/markdown` and shall render inline in the
browser rather than downloading.
*Rationale:* measured 2026-08-12 against a positive control — GitHub Pages serves `.md` as
`text/markdown; charset=utf-8` and current browsers render it inline. A `.txt` suffix buys nothing.
*Verification:* test — assert the built artifact's extension; probe content-type post-deploy.
*Dependencies:* AC-6-1.

**AC-6-3** (Ubiquitous) A raw route shall carry a canonical backlink to its rendered page.
*Verification:* test — the emitted Markdown contains the page's absolute URL.
*Dependencies:* AC-6-1.

**AC-6-4** (Unwanted behavior) If a page is authored as `.mdx`, then its raw route shall still carry
that page's headings and body.
*Rationale:* `entry.rendered` is `undefined` for `.mdx` and populated for `.md`, so
`rendered.metadata.headings` is empty for every MDX page — a wrong count that reads as a defect in
the content rather than in the probe. `render(entry)` is the correct accessor.
*Verification:* test — a fixture `.mdx` page's raw route is non-empty and its heading count matches
an independently derived total.
*Dependencies:* AC-6-1.

**AC-6-5** (Ubiquitous) Raw routes shall be generated for virtual pages as well as file-backed ones.
*Verification:* test — a generated command page has a working raw route.
*Dependencies:* AC-3-1, AC-6-1.

---

## AC-7 — page actions

**AC-7-1** (Ubiquitous) Every page shall offer a control that copies that page's Markdown to the
clipboard.
*Verification:* test — the control is present in built HTML; a browser-driven assertion that the
clipboard receives the page's Markdown.
*Dependencies:* AC-6-1.

**AC-7-2** (Ubiquitous) Every page shall offer a control that opens its raw route.
*Verification:* test — the control's href equals the page's raw route, base segment included.
*Dependencies:* AC-6-1.

**AC-7-3** (Ubiquitous) Every page shall offer controls that forward the page to an external assistant
by deep link, and each shipped target shall be one whose URL format is verified.
*Verified 2026-08-12.* Documented by the vendor: `cursor.com/link/prompt?text=` (max 8,000);
`claude.ai/code?prompt=&repositories=` (with `prompt_url=` for long prompts); `codex://new?prompt=`
(desktop scheme); `claude-cli://open?q=` (max 5,000). Works but undocumented:
`chatgpt.com/?q=`; `claude.ai/new?q=`. **Confirmed absent:** any Codex *web* prompt parameter — so a
Codex control is a desktop-scheme link or it is not shipped.
*Verification:* test — a table-driven assertion that each control's href matches its verified format
and carries a non-empty payload. This is the dead-button lock.
*Dependencies:* AC-6-1.

**AC-7-4** (Unwanted behavior) If a deep-link payload would exceed 7,500 characters, then it shall be
truncated or replaced by a URL reference rather than emitted whole.
*Rationale:* failures above ~8 KB are silent — the HTTP/2 `:path` pseudo-header shares its HPACK
budget with cookies. Cursor documents 8,000 and the Claude CLI scheme 5,000.
*Verification:* test — a long page's emitted href is within budget.
*Dependencies:* AC-7-3.

**AC-7-5** (Ubiquitous) Deep-link controls shall be labelled as opening the target, never as asking
it a question.
*Rationale:* every one of these links is prefill-only by deliberate design — ChatGPT gates
auto-submission on `sec-fetch-site`. A label promising an answer describes behavior the link does not
have.
*Verification:* inspection.

**AC-7-6** (Unwanted behavior) If a third-party page-actions plugin emits a deep link that does not
match its target's documented format, or discards the base segment, then that plugin's control shall
not be shipped in that form.
*Known instance:* `starlight-page-actions@0.7.0` emits `cursor.com/link/prompt?${prompt}` with no
`text=` key — a dead button against Cursor's own documentation — and its `normalizeUrl` returns
`urlObj.origin`, discarding `/memhtml`. Both defects re-verified 2026-08-12 by reading the source.
*Verification:* the AC-7-3 table-driven test is the standing gate.
*Dependencies:* AC-7-3.

**AC-7-7** (Ubiquitous) The page-action controls shall be a local component override rather than a
plugin.
*Rationale:* `starlight-page-context-action@0.4.3` was re-examined at source and is better than its
competitor — it emits well-formed `chatgpt.com/?q=`, `claude.ai/new?q=`, and `t3.chat/new?q=`, ships
no Cursor link at all, and handles a non-root base correctly via `BASE_URL`. It is still declined on
three grounds: its MDX cleaner is regex-based and leaks unknown JSX, it copies `<path>.md` and so
collides with AC-6-1's producer, and its `llmsTxt` collides with AC-5-1's. The controls themselves are
roughly twenty lines. A dependency that must be half-disabled to avoid two collisions costs more than
the code it saves.
*Verification:* the AC-7-3 table-driven test covers the hand-rolled controls identically.
*Dependencies:* AC-7-3, AC-6-1.

---

## AC-8 — publication

**AC-8-1** (Event-driven) When a commit lands on `main`, the site shall be built and deployed to
GitHub Pages through the Actions path.
*Verification:* test — a successful workflow run.

**AC-8-2** (Ubiquitous) The site's origin and base segment shall be configuration, with the
production values as defaults, so a local build equals what Pages serves.
*Rationale:* two silent base-segment bugs exist upstream — `hero.actions[].link` emits an unprefixed
href (a 404 on a project site) while sidebar links are prefixed, and `Astro.site` excludes the base,
so `new URL(x, Astro.site)` drops it. `import.meta.env.BASE_URL` is the correct accessor. Making the
base a variable also makes a later move to a custom domain a config change.
*Verification:* test — a build under a non-root base emits no unprefixed internal href.
*Implementation aid:* `starlight-base-path` auto-prefixes the base onto content links and is
Sätteri-aware. It reduces the surface of this class of bug but does not close it — `hero.actions[].link`
and any hand-built `new URL(x, Astro.site)` remain the author's responsibility, so the test stands
regardless of the plugin.
*Dependencies:* AC-8-1.

**AC-8-3** (Ubiquitous) The deployment workflow shall obtain node and pnpm from mise, matching the two
existing workflows, and shall not use `actions/setup-node` or corepack.
*Rationale:* the repo declares node once (`mise.toml`) and gates the pnpm pin through
`mise run tools:verify`; a second declaration escapes that gate.
*Verification:* inspection.
*Dependencies:* AC-8-1.

**AC-8-4** (Ubiquitous) The workflow shall grant `pages: write` and `id-token: write` only to the
deploy job, keep `contents: read` at the top level, and serialize with
`concurrency: {group: pages, cancel-in-progress: false}`.
*Verification:* inspection.
*Dependencies:* AC-8-1.

**AC-8-5** (Ubiquitous) The uploaded artifact path shall be `apps/docs/dist`, repo-root-relative.
*Rationale:* a bare `dist` produces `No files were found with the provided path`.
*Verification:* test — the workflow run uploads a non-empty artifact.
*Dependencies:* AC-8-1.

**AC-8-6** (Ubiquitous) No `.nojekyll` file shall be added.
*Rationale:* Jekyll runs only on the branch-publishing path — GitHub's own docs condition it on
"if you publish your site from a source branch", and `grep -rin jekyll` across `actions/deploy-pages@v5`
returns zero matches. Probed 2026-08-12: five real Actions-path Astro sites with no `.nojekyll` in
any of their repos serve their `_astro/` assets 200. The file would not even ship —
`upload-pages-artifact@v5` tars with `--exclude=.[^/]*` unless `include-hidden-files: true`.
*Flipping condition:* switching to "Deploy from a branch" reverses this.
*Verification:* inspection; the deployed site's `_astro/` asset returning 200 is the live check.
*Dependencies:* AC-8-1.

**AC-8-7** (Ubiquitous) `withastro/action` shall not be used.
*Rationale:* verified against `action.yml` v6.1.2 (2026-07-10). With `path: apps/docs` its detection
runs `find "." -maxdepth 1 -name "pnpm-lock.yaml"` inside the docs directory, misses the root
lockfile, and falls through to `exit 1`. Forcing `package-manager:` never sets `LOCKFILE`, yielding
`cache-dependency-path: "apps/docs/"`, which `@actions/glob` skips as a directory and
`setup-node` then throws on. Worse, that branch sets `VERSION="latest"` unconditionally, so CI would
install pnpm latest rather than the pinned `11.21.0`, silently defeating `tools:verify`. The action
*can* work with `path: "."`; we decline it for turbo ordering and cache control.
*Verification:* inspection.
*Dependencies:* AC-8-1.

**AC-8-8** (Ubiquitous) The pull-request gate shall build the docs app without a second workflow.
*Rationale:* `apps/docs` matches `apps/*` and `typecheck.dependsOn: ["build","^build"]`, so the
existing `mise run check` already builds it.
*Verification:* test — a PR run shows the docs build executing.
*Dependencies:* AC-1-1.

---

## AC-9 — quality gates

**AC-9-1** (Ubiquitous) A broken internal link shall fail the build.
*Verification:* test — introduce a broken link and assert the build exits non-zero.
*Dependencies:* AC-2-1.

**AC-9-2** (Ubiquitous) The docs app's `lint` and `typecheck` scripts shall participate in
`mise run check` and shall not require a second formatter or a widened Biome scope.
*Rationale:* Biome's `files.includes` is an allowlist of `**/*.ts` and `**/*.json`; widening it makes
Biome flag `.astro` frontmatter variables that the template uses as unused, and Biome's own fix
disables `noUnusedVariables`, `noUnusedImports`, and `useConst` — three rules this repo sets to
`error`. `.md` and `.mdx` are no-ops for Biome regardless.
*Verification:* test — `mise run check` exits 0 with the docs app present.
*Dependencies:* AC-1-7.

**AC-9-3** (Ubiquitous) A spell check shall run over authored prose with a project dictionary
covering the domain vocabulary.
*Verification:* test — the check exits 0 on the committed corpus and non-zero on an introduced typo.
*Dependencies:* AC-2-1.

**AC-9-4** (Ubiquitous) An automated accessibility pass shall run against the built output and shall
fail the build on a WCAG 2.2 AA violation.
*Implementation:* `@axe-core/playwright` over a representative page set — one landing page, one
authored prose page, one generated virtual page, one raw-route consumer — rather than every page, so
the gate's cost stays bounded as the corpus grows.
*Note:* the two criteria most likely to bite a customized Starlight are 2.4.11 (focus not obscured)
and 2.5.8 (target size).
*Verification:* test — mutation-verified by introducing a contrast or focus violation and watching the
gate fail.
*Dependencies:* AC-10-1, AC-10-3.

**AC-9-6** (Ubiquitous) A performance budget shall be enforced against the built output.
*Implementation:* `@lhci/cli` against `staticDistDir`, so no network or server is involved.
*Constraint:* the budget shall assert **category floors**, not absolute millisecond timings.
*Rationale:* a wall-clock assertion on a shared CI runner fails for reasons that have nothing to do
with the commit, which is the standing objection to this gate. A category floor over a static
directory is reproducible.
*Verification:* test — mutation-verified by shipping a deliberately oversized asset and watching the
gate fail.
*Dependencies:* AC-10-1.

**AC-9-7** (Unwanted behavior) If the accessibility or performance gate requires a browser binary,
then that binary's acquisition shall be answered in `pnpm-workspace.yaml` `allowBuilds` and shall be
cached in CI rather than downloaded per run.
*Rationale:* pnpm refuses to install while a build-scripted package is undecided, and a per-run
browser download is a slow, network-dependent step in a gate that is otherwise hermetic. The
single-entry `esbuild: false` finding was measured **without** these packages present, so the
inventory must be re-derived once they are added.
*Verification:* test — a clean `--frozen-lockfile` install exits 0 with no undecided-build prompt.
*Dependencies:* AC-1-3.

**AC-9-5** (Ubiquitous) External-link checking shall run on a schedule and shall not fail the build.
*Rationale:* an external 404 is not a defect in the commit that happens to be pushed when it appears.
*Verification:* inspection of the workflow trigger.

---

## AC-10 — visual identity

**AC-10-1** (Ubiquitous) The site's accent ramp shall derive from the semantic palette already used
in the repo's diagrams rather than from an invented one.
*Source:* the four `classDef` fills in `README.md` are the only colors in the repository and they are
used consistently across two diagrams — `#FFE4B5`/`#FF8C00` = a write door, `#90EE90` = system of
record and human, `#87CEEB`/`#4682B4` = derived projection and agent, `#E6E6FA`/`#8A2BE2` = state
plane and sleep.
*Verification:* inspection.

**AC-10-2** (Ubiquitous) The site shall ship a favicon, a social preview image per page, and a
landing page that is not the default Starlight splash.
*Note:* the repository contains zero image assets today — no logo, no favicon, no OG image — so all
of this is new work.
*Verification:* inspection; test that an OG image artifact exists per page.
*Dependencies:* AC-2-1.

**AC-10-3** (Ubiquitous) The site shall meet WCAG 2.2 AA, and any customization shall not regress a
Starlight default that already satisfies it.
*Verification:* test — an automated accessibility pass over the built output.
*Dependencies:* AC-10-1.

**AC-10-4** (Ubiquitous) Every published diagram shall be rendered at build time to a static asset,
and the built output shall contain no client-side diagram runtime.
*Implementation:* `astro-d2`, with the `d2` binary supplied as a mise tool so it is pinned by
`mise.lock` like every other tool this repo depends on. The four `README.md` Mermaid diagrams are
rewritten in D2; `docs/design.md` is text-only across all thirteen chapters and is where 5–8 new
diagrams land.
*Constraint:* diagram styling shall use the AC-10-1 palette, so a diagram's colors carry the same
meaning as the prose around it.
*Verification:* test — a build emits static SVG and no diagram JS bundle appears in `dist/`.
*Dependencies:* AC-10-1.

**AC-10-5** (Ubiquitous) `README.md` shall remain readable on GitHub after its diagrams are rewritten.
*Rationale:* GitHub renders Mermaid in Markdown natively and does not render D2. Moving the four
diagrams to D2 for the site must not leave the repo's front door showing raw diagram source to a
first-time visitor.
*Verification:* inspection — the README either keeps its Mermaid blocks (with D2 sources maintained
for the site) or substitutes committed SVG.

## AC-11 — the agent-addressed surface

This group is **non-droppable scope**. If the work compresses, visual refinement yields to it, not the
other way round.

**AC-11-1** (Ubiquitous) The site shall carry a page whose reader is explicitly assumed to be an AI
agent, reachable from the site's primary navigation and from `llms.txt`.
*Content, drawn from material that already exists rather than invented:* the shortest path to a working
integration; how an agent determines which door it is behind (CLI or MCP); the ordered reading list
with each entry's **raw `.md` URL** so the agent fetches rather than scrapes; a pointer to `llms.txt`,
`llms-full.txt`, and the `.md` route convention; and what not to do.
*Verification:* test — every URL on the page returns 200, and the reading-list count is derived from
the underlying source rather than hand-maintained.
*Dependencies:* AC-2-1, AC-6-1.

**AC-11-2** (Ubiquitous) The agent page shall lead with the assumptions an agent must unlearn.
*Rationale:* this is the highest-value section in the prior art, and for this system the traps are
specific and already documented: branch on `code`, never on the human `error` prose, which changes
freely as wording improves; absence means archived, not deleted, because eviction is a `git mv` into
`archive/<YYYY>/`; the git tree is the system of record and `index.db` is a disposable projection; one
memory holds one fact; and `memhtml manifest` is the self-describing entry point, so flags are read
rather than guessed.
*Verification:* test — each stated trap cites the source of truth that establishes it, and the citation
resolves.
*Dependencies:* AC-11-1.

**AC-11-3** (Ubiquitous) The page shall be legible to the humans who will also read it.
*Rationale:* a page addressed to a machine is read by every developer evaluating the project, and a
gimmick costs more credibility than the affordance earns. The address to a non-human reader carries its
weight only if the content underneath is the genuinely fastest path.
*Verification:* inspection.
*Dependencies:* AC-11-1.

**AC-11-4** (Ubiquitous) Where a page states behavior that differs for an agent, it shall carry an
inline agent-directed note, and that note shall survive into the raw `.md` route and the llms bundles.
*Rationale:* a note that renders in HTML and vanishes from the Markdown is worse than no note, because
the agent-facing surface then contradicts the human-facing one on exactly the point the note exists to
make. The note must also carry its meaning without relying on color (SC 1.4.1).
*Verification:* test — a page with an agent note has that note present in its `.md` twin and in
`llms-full.txt`.
*Dependencies:* AC-6-1, AC-5-1.

**AC-11-5** (Ubiquitous) The four agent-facing surfaces shall have one declared canonical source each,
and no contract shall be described independently in more than one of them.
*The four:* `AGENTS.md` at the repo root (generated, byte-compare tested), the site's agent page,
`llms.txt` / `llms-full.txt`, and the 36 generated command pages.
*Rationale:* four descriptions of one contract is three opportunities to diverge, and divergence here
misinforms the reader least able to notice it.
*Verification:* test — a divergence check across the surfaces, asserting the shared facts are equal
rather than merely present.
*Dependencies:* AC-3-1, AC-5-1, AC-11-1.

**AC-11-6** (Unwanted behavior) If an agent-facing artifact would report a count, that count shall be
derived from its source at build time.
*Rationale:* the standing lesson in this repo is that a wrong count reads as a finding. An agent page
claiming "36 commands" as a literal becomes a lie the first time a command is added, and it is a lie
told specifically to the reader that trusts it most.
*Verification:* test — census probes over each stated quantity.
*Dependencies:* AC-11-1.

## Settled decisions

Recorded 2026-08-12. Each was an open choice at plan time; the reasoning is kept so a later reader
does not re-derive it.

- **D1 — the site is a project site** at `https://memhtml.github.io/memhtml/`, `base: '/memhtml'`,
  with origin and base as configuration. Docs ship in the same commit as the code they describe. Root
  `robots.txt` and `.well-known/` are given up knowingly (AC-5-5); a subpath `llms.txt` is verified
  working and spec-sanctioned, so no custom domain is required. `memhtml/memhtml.github.io` is
  available should root serving ever be wanted.
- **D2 — generated command pages carry no examples** (AC-3-5). `CommandSpec` is unchanged.
- **D3 — diagrams render through `astro-d2`** at build time, `d2` supplied by mise (AC-10-4).
- **D4 — accessibility and performance budgets are blocking gates** (AC-9-4, AC-9-6), against a
  bounded page set and with category floors rather than wall-clock assertions, plus the install-time
  consequence in AC-9-7.
- **D5 — no second formatter.** Biome's scope is unchanged; `.astro`, `.mdx`, and `.css` in the docs
  app are unformatted by tooling. Widening Biome makes it flag `.astro` frontmatter that the template
  uses, and its own fix disables `noUnusedVariables`, `noUnusedImports`, and `useConst` — three rules
  this repo sets to `error`.

## Deferred, with the reason

- **API reference from TypeScript sources.** TypeDoc 0.28.20 caps at TypeScript 6 and crashes at
  module load under TS 7 (`typedoc#3098`, open, no timeline). Reproducible only behind a docs-local
  TS 6 pin. Deferred on audience grounds as well: every package is `private: true` and unpublished,
  so there is no library consumer to serve yet. Revisit on first publish.
- **Docs-as-MCP.** No static-hosting path exists: MCP needs POST, `.well-known/mcp.json` on static
  hosting is unreachable under a base segment and stripped by the artifact tar, Server Cards remain a
  working-group draft, and `rel="describedby"` is shipped by none of fourteen surveyed sites —
  including llmstxt.org itself. `llms.txt` plus raw routes is the realistic ceiling.

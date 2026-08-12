import { satteri } from "@astrojs/markdown-satteri"
import starlight from "@astrojs/starlight"
import { pluginCollapsibleSections } from "@expressive-code/plugin-collapsible-sections"
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers"
import { defineConfig, passthroughImageService } from "astro/config"
import astroD2 from "astro-d2"
import { starlightBasePath } from "starlight-base-path"
import starlightHeadingBadges from "starlight-heading-badges"
import starlightLinksValidator from "starlight-links-validator"
import starlightLlmsTxt from "starlight-llms-txt"
import starlightMdTxt from "starlight-md-txt"
import starlightScrollToTop from "starlight-scroll-to-top"

import { agentNotePlugin } from "./src/lib/agent-note.js"
import { siteUrl } from "./src/lib/agent-surface.js"
import { baseRawLinks } from "./src/lib/base-raw-links.js"
import { focusableScrollers } from "./src/lib/focusable-scrollers.js"

/**
 * The origin and the base segment are configuration carrying the production values as defaults, so a
 * local build equals what GitHub Pages serves.
 *
 * The base is the origin root: the site is published by `memhtml/memhtml.github.io`, which is an ORG
 * site, and an org site serves from `/`. The source lives here, in the project repository, and that
 * publisher builds it — so the docs still ship in the same commit as the code they describe while the
 * URL carries no path segment.
 *
 * The base stays a variable rather than becoming a constant, and the machinery that consumes it stays
 * in place, because a root base makes each consumer a no-op rather than removing the need for it: a
 * move to a project path or a subdirectory would restore every one of them at once.
 *
 * Astro prefixes the base onto its own routing and asset URLs, but not onto hrefs written by hand or
 * onto `new URL(x, Astro.site)` — `Astro.site` excludes the base. `import.meta.env.BASE_URL` is the
 * accessor that includes it.
 */
const origin = process.env.DOCS_ORIGIN ?? "https://memhtml.github.io"
const base = process.env.DOCS_BASE ?? "/"

/**
 * The agent page's raw-Markdown URL, for the one link that has to be written outside a component.
 *
 * Built through `siteUrl` rather than by joining `origin` and `base`, because that join is what
 * produces `//runtime/index.md` — a protocol-relative URL naming a *host* called `runtime`.
 */
const agentPageMarkdown = siteUrl("agents.md", { site: new URL(origin), base }).href

/**
 * Every link into the Reference tier, as the link validator sees it once the base is prefixed on.
 *
 * The validator cannot check these and it is not a bug in the validator: it accepts a link only when
 * the target page is BOTH a built page and one whose headings it collected through its own remark
 * plugin. A Reference page's Markdown is rendered by the loader through `renderMarkdown`, which never
 * enters that pipeline, so all 57 of them are built pages with no headings on record and every link
 * to one is reported invalid.
 *
 * Excluding them here would leave a typo in an authored Reference link unnoticed, so
 * `tests/authored-links.test.ts` resolves every authored internal link against the registry that
 * generates those pages. That check is stronger than the one being skipped — it runs without a build.
 */
const referenceLinks = ((prefix: string) => [`${prefix}/reference/`, `${prefix}/reference/**`])(
  base.replace(/\/$/, "")
)

export default defineConfig({
  site: origin,
  base,
  trailingSlash: "always",
  /*
   * Astro 7's default Markdown engine is Sätteri, and Starlight additively mutates whatever
   * processor is supplied here — it sets `features.directive` itself for its asides and PUSHES its
   * own mdast and hast plugins after these. So this declares only the delta, and the push order is
   * what lets `agentNotePlugin` claim `:::agent` before Starlight's directive-restoration pass turns
   * an unclaimed directive into an unstyled bare `<div>`.
   *
   * Section numbers are authored into the heading TEXT so that every surface agrees — the rendered
   * page, the table of contents, Pagefind, llms.txt, and the raw Markdown this site serves to agents.
   * An anchor therefore reads `#32-edge-encoding` and churns when a section is inserted, which is a
   * cost accepted rather than solved: the `{ #anchor }` syntax that `headingAttributes` enables would
   * fix it, and it carries a brace into the raw Markdown, where `remark-mdx` reads a brace as a JSX
   * expression and one occurrence fails the whole raw route. So no page may use it —
   * `apps/docs/tests/census.test.ts` asserts the braces stay absent, and
   * `starlight-links-validator` catches an internal link that a renumbering breaks.
   */
  markdown: {
    processor: satteri({
      features: { headingAttributes: true },
      mdastPlugins: [agentNotePlugin()],
      /*
       * Starlight PUSHES its own hast plugins after these, so this runs first and its `tabindex`
       * survives whatever Starlight adds afterwards.
       */
      hastPlugins: [focusableScrollers()]
    })
  },
  // pnpm's isolated node_modules puts sharp out of reach of a resolve from this app's root, so
  // Astro's default image service exits 1 with MissingSharp on the first raster image — a latent
  // failure that a build with no images does not reveal. This site optimises no images.
  image: { service: passthroughImageService() },
  /*
   * `canvaskit-wasm` stays out of the SSR bundle, and it is a DIRECT dependency of this package for
   * the same reason. It ships as UMD and reads `__dirname`, which is not defined in the ESM chunk
   * Vite would otherwise inline it into — the social-card route then fails at render with a
   * `ReferenceError` that names neither the package nor the cause. Left external it is required at
   * run time as CommonJS, where `__dirname` exists, and its own `createRequire` locates the wasm
   * binary beside it.
   */
  vite: { ssr: { external: ["canvaskit-wasm"] } },
  integrations: [
    /*
     * Figures render to static SVG at build time through the pinned `d2` binary, so no diagram
     * runtime reaches the browser. Theme 301 is Terminal Grayscale — monochrome with square
     * corners, which is the line-art register of a specification rather than a diagram tool's
     * default. Both ids are strings; the schema rejects the numbers D2's own documentation prints.
     *
     * `dark: false` disables the dark variant outright so every figure renders identically. That is
     * the point rather than an omission: D2 emits a dark-mode media block inside the SVG which
     * would otherwise reassert its own palette over the monochrome, and having one drawing per
     * diagram is simpler than overriding a second.
     */
    astroD2({ theme: { default: "301", dark: false } }),
    /*
     * Runs on `astro:build:done`, after the raw `.md` routes are emitted. The base segment has to
     * be prefixed there separately because those routes are built from each page's Markdown source
     * while `starlight-base-path` rewrites the rendered tree — so a link is correct on whichever
     * surface its producer touched, and 450 links were wrong on the one agents read.
     */
    baseRawLinks(base),
    starlight({
      title: "memhtml",
      description: "Memory for agents, in HTML.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/memhtml/memhtml" }],
      editLink: { baseUrl: "https://github.com/memhtml/memhtml/edit/main/apps/docs/" },
      lastUpdated: true,
      customCss: ["./src/styles/rfc.css"],
      /*
       * Two local overrides, both of which render the default and add to it rather than replacing it.
       * `PageTitle` gains the page-action controls; `Head` gains the icons, this page's social card,
       * and the machine-reader discovery block. Neither is a plugin: see the note in each component
       * for why the candidate plugin was declined.
       */
      components: {
        Head: "./src/components/Head.astro",
        PageTitle: "./src/components/PageTitle.astro"
      },
      /*
       * A code block is the one place on this site where a second typeface appears, so it is framed
       * rather than tinted: square corners and a hairline rule in the same value the tables and the
       * masthead use, which is what keeps it reading as a figure inside a specification instead of a
       * widget dropped onto the page. Expressive Code's defaults are a 0.3rem radius and a drop
       * shadow, and both are wrong against Times.
       *
       * `codeFontSize` is 0.85em rather than 1em because the mono stack's x-height runs ahead of
       * Times' at equal size; the two only look like one document at this ratio.
       */
      expressiveCode: {
        plugins: [pluginLineNumbers(), pluginCollapsibleSections()],
        /*
         * A ```d2 fence is a figure source, not a code sample: `astro-d2` renders it to an SVG and
         * replaces the block. Expressive Code still sees the fence first, finds no highlighter for
         * `d2`, and warns once per figure. Eight chapters carry figures, so the warning drowned
         * `astro check`'s output and broke a test that searches that output for a filename.
         *
         * Aliasing it to plain text says what is true: nothing here needs highlighting.
         */
        shiki: { langAlias: { cron: "txt", d2: "txt" } },
        styleOverrides: {
          borderRadius: "0",
          borderColor: "var(--memhtml-rule)",
          borderWidth: "1px",
          // The same tint an inline code span already sits on, so a block and a span are one material.
          // The bundled themes ship a violet-cast ground that belongs to no value in this palette.
          codeBackground: "var(--sl-color-bg-inline-code)",
          codeFontFamily: "var(--sl-font-mono)",
          codeFontSize: "0.85em",
          /*
           * The gutter's own foreground, darkened from Expressive Code's light-theme default.
           * Measured: #788b94 on the block's #f6f7f9 is 3.3:1, and a line number is body-size text, so
           * SC 1.4.3 wants 4.5:1. #4a5560 measures 7.0:1 on that ground. Fifty nodes on one tutorial
           * page came from this single value.
           */
          lineNumbers: { foreground: "#4a5560" },
          frames: {
            shadowColor: "transparent",
            editorTabBorderRadius: "0",
            frameBoxShadowCssValue: "none"
          }
        }
      },
      plugins: [
        /*
         * Serves each page's Markdown source at its own path. `injectRoute` is what makes it
         * base-correct by construction, and it unwraps MDX through a real AST transform rather
         * than a regex — which matters because this site's install snippets are component-driven
         * tabs, and a regex extractor drops the tab labels that distinguish pnpm from npm.
         *
         * Exactly one dependency may own this route. Nothing else here emits `<path>.md`.
         */
        starlightMdTxt(),
        /*
         * `llms.txt`'s own body is the only place the agent page can be listed FIRST. The plugin's
         * `optionalLinks` renders an `## Optional` section at the END of the file and `customSets`
         * renders inside `## Documentation Sets` after both bundles, so neither can place an entry
         * ahead of them — read from the plugin's `llms.txt.ts` rather than assumed. `details` is
         * emitted immediately after the description and before every section, and llmstxt.org
         * sanctions exactly this content there: "markdown sections of any type except headings".
         *
         * Placement is a deliverable and not a nicety. The measured finding it answers is that agents
         * do not wander: guidance absent from the loaded context did not happen.
         *
         * `promote` is a separate lever on a separate file — it orders page bodies inside
         * `llms-full.txt`, where the default is `['index*']` alone. Listing `agents` after it keeps
         * the landing page first and puts the agent page immediately behind it.
         */
        starlightLlmsTxt({
          details: [
            "Start here:",
            "",
            `- [For agents](${agentPageMarkdown}): the assumptions to unlearn, which door you are behind (CLI or MCP), and the shortest path to a working integration.`,
            "",
            "Every page on this site is also served as Markdown at its own path with `.md` appended.",
            "Prefer that over scraping the HTML."
          ].join("\n"),
          promote: ["index*", "agents"]
        }),
        /*
         * Prefixes `base` onto authored content links, so a page can write `/internals/x/` and be
         * correct under `/memhtml/`. It narrows this class of bug without closing it — a
         * hand-built `new URL(x, Astro.site)` still drops the base, because `Astro.site` excludes
         * it — so the test asserting no unprefixed internal href stays regardless.
         */
        starlightBasePath(),
        /*
         * Fails the build on a broken internal link. Pinned ^0.25.2 deliberately: 0.25.3 shipped
         * 2026-08-12, and under `minimumReleaseAge` + `minimumReleaseAgeStrict` a ^0.25.3 range has
         * no satisfying version and the install fails outright rather than falling back.
         *
         * The Reference tier is excluded, and only it. Measured in the plugin's `validation.ts`: a
         * link is valid when the target is in Astro's built page list AND the validator recorded that
         * target's headings during its own remark pass. The Reference tier exists only as loader-
         * injected collection entries with no file for that pass to see, so its pages have no
         * recorded headings and every link into them reports `InvalidLink` — while the pages
         * themselves are built and served. Excluding a target the plugin structurally cannot judge is
         * the option its own error hint points at.
         *
         * The exclusion is covered by a stricter gate rather than by trust:
         * `tests/agent-surface.test.ts` resolves every internal link on the agent page against the
         * files actually present in `dist/`, and `tests/census.test.ts` derives the tier's contents
         * from the registries. Both check the built output; the validator checks a side table.
         */
        starlightLinksValidator({ exclude: referenceLinks }),
        starlightHeadingBadges(),
        starlightScrollToTop()
      ],
      /*
       * Diátaxis, three tiers: Learn is task-shaped, Reference is derived from the registries, and
       * Internals is the reasoning. An `autogenerate` entry has to sit inside `items` — a group
       * carrying it directly is rejected — and `collapsed` no longer cascades, so each group states
       * its own.
       *
       * Reference is autogenerated over 57 pages that exist only as injected collection entries with
       * no files on disk; Starlight's tree builder keys on each entry's `filePath`, which is why the
       * loader shapes those to look like `src/content/docs/reference/…`.
       */
      sidebar: [
        // First, and above Learn: an agent arriving at the site should not have to find this.
        { label: "For agents", link: "/agents/" },
        { label: "Learn", collapsed: false, items: [{ autogenerate: { directory: "learn" } }] },
        {
          label: "Reference",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }]
        },
        {
          label: "Internals",
          collapsed: true,
          items: [{ autogenerate: { directory: "internals" } }]
        },
        { label: "Glossary", link: "/glossary/" }
      ]
    })
  ]
})

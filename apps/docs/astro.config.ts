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

/**
 * The origin and the base segment are configuration carrying the production values as defaults, so a
 * local build equals what GitHub Pages serves. `memhtml/memhtml` is a project repository, so its site
 * is mounted under a path segment; a custom domain would set the base to "/" and change nothing else.
 *
 * Astro prefixes the base onto its own routing and asset URLs, but not onto hrefs written by hand or
 * onto `new URL(x, Astro.site)` — `Astro.site` excludes the base. `import.meta.env.BASE_URL` is the
 * accessor that includes it.
 */
const origin = process.env.DOCS_ORIGIN ?? "https://memhtml.github.io"
const base = process.env.DOCS_BASE ?? "/memhtml"

/**
 * The agent page's raw-Markdown URL, for the one link that has to be written outside a component.
 *
 * Built through `siteUrl` rather than by joining `origin` and `base`, because that join is what
 * produces `//runtime/index.md` — a protocol-relative URL naming a *host* called `runtime`.
 */
const agentPageMarkdown = siteUrl("agents.md", { site: new URL(origin), base }).href

/**
 * The Reference tier's path, base segment included.
 *
 * `starlight-links-validator` matches its `exclude` patterns against the link as authored, and
 * `starlight-base-path` has already prefixed the base by then — so the pattern carries the base too,
 * and derives it rather than repeating it.
 */
const referenceTierPath = siteUrl("reference/", { site: new URL(origin), base }).pathname

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
      mdastPlugins: [agentNotePlugin()]
    })
  },
  // pnpm's isolated node_modules puts sharp out of reach of a resolve from this app's root, so
  // Astro's default image service exits 1 with MissingSharp on the first raster image — a latent
  // failure that a build with no images does not reveal. This site optimises no images.
  image: { service: passthroughImageService() },
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
    starlight({
      title: "memhtml",
      description: "Memory for agents, in HTML.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/memhtml/memhtml" }],
      editLink: { baseUrl: "https://github.com/memhtml/memhtml/edit/main/apps/docs/" },
      lastUpdated: true,
      customCss: ["./src/styles/rfc.css"],
      expressiveCode: { plugins: [pluginLineNumbers(), pluginCollapsibleSections()] },
      /*
       * Two local overrides, both of which render the default and add to it rather than replacing it.
       * `PageTitle` gains the page-action controls; `Head` gains the machine-reader discovery block.
       * Neither is a plugin: see the note in each component for why the candidate plugin was declined.
       */
      components: {
        Head: "./src/components/Head.astro",
        PageTitle: "./src/components/PageTitle.astro"
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
        starlightLinksValidator({
          // Glob patterns, not URLs: the `**` suffix is a picomatch wildcard joined onto a path that
          // `new URL()` already resolved.
          exclude: [referenceTierPath, `${referenceTierPath}**`]
        }),
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

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

export default defineConfig({
  site: origin,
  base,
  trailingSlash: "always",
  /*
   * Astro 7's default Markdown engine is Sätteri, and Starlight additively mutates whatever
   * processor is supplied here — it sets `features.directive` itself for its asides and pushes its
   * own mdast and hast plugins. So this declares only the delta.
   *
   * `headingAttributes` is off by default and is required: section numbers are authored into the
   * heading text so that every surface agrees — the rendered page, the table of contents, Pagefind,
   * llms.txt, and the raw Markdown this site serves to agents. Numbering the text alone would make
   * anchors read `#32-edge-encoding` and churn every inbound link whenever a section is inserted,
   * so each heading carries an explicit unnumbered anchor: `## 3.2. Edge encoding { #edge-encoding }`.
   */
  markdown: {
    processor: satteri({ features: { headingAttributes: true } })
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
        starlightLlmsTxt(),
        /*
         * Prefixes `base` onto authored content links, so a page can write `/internals/x/` and be
         * correct under `/memhtml/`. It narrows this class of bug without closing it — a
         * hand-built `new URL(x, Astro.site)` still drops the base, because `Astro.site` excludes
         * it — so the test asserting no unprefixed internal href stays regardless.
         */
        starlightBasePath(),
        // Fails the build on a broken internal link. Pinned ^0.25.2 deliberately: 0.25.3 shipped
        // 2026-08-12, and under `minimumReleaseAge` + `minimumReleaseAgeStrict` a ^0.25.3 range has
        // no satisfying version and the install fails outright rather than falling back.
        starlightLinksValidator(),
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

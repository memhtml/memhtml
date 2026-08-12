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

/**
 * Every link into the Reference tier, as the link validator sees it after the base is prefixed on.
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
    starlight({
      title: "memhtml",
      description: "Memory for agents, in HTML.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/memhtml/memhtml" }],
      editLink: { baseUrl: "https://github.com/memhtml/memhtml/edit/main/apps/docs/" },
      lastUpdated: true,
      customCss: ["./src/styles/rfc.css"],
      /*
       * The only component override. It adds this page's social card and the raster icons, and it
       * renders Starlight's own head rather than replacing it — so a Starlight release that adds a
       * head tag still ships that tag here.
       */
      components: { Head: "./src/components/Head.astro" },
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
        styleOverrides: {
          borderRadius: "0",
          borderColor: "var(--memhtml-rule)",
          borderWidth: "1px",
          // The same tint an inline code span already sits on, so a block and a span are one material.
          // The bundled themes ship a violet-cast ground that belongs to no value in this palette.
          codeBackground: "var(--sl-color-bg-inline-code)",
          codeFontFamily: "var(--sl-font-mono)",
          codeFontSize: "0.85em",
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

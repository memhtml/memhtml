import { satteri } from "@astrojs/markdown-satteri"
import starlight from "@astrojs/starlight"
import { defineConfig, passthroughImageService } from "astro/config"

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
    starlight({
      title: "memhtml",
      description: "Memory for agents, in HTML.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/memhtml/memhtml" }],
      editLink: { baseUrl: "https://github.com/memhtml/memhtml/edit/main/apps/docs/" },
      lastUpdated: true,
      customCss: ["./src/styles/rfc.css"],
      sidebar: [{ label: "Start here", items: [{ label: "Introduction", slug: "index" }] }]
    })
  ]
})

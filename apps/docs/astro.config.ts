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
      sidebar: [{ label: "Start here", items: [{ label: "Introduction", slug: "index" }] }]
    })
  ]
})

import { getCollection } from "astro:content"
import { createRequire } from "node:module"
import { OGImageRoute } from "astro-og-canvas"

import { OG_SLUG_ROOT, ogCard } from "../../branding/og-card.ts"

/**
 * One social card per docs page, rendered to PNG at build time.
 *
 * The route covers every entry of the `docs` collection, which includes the 57 Reference pages that
 * exist only as injected collection entries — they have no file on disk, so nothing else would give
 * them a card.
 *
 * The `.png` belongs to the FILE NAME and not to the slug, which is forced by `trailingSlash:
 * "always"`: a route pattern of `/og/[...slug]` is a page path as far as Astro is concerned, so it
 * gets a trailing slash appended and the card is served from `/og/x.png/` — a directory whose name
 * ends in `.png`. Putting the extension in the pattern makes the route a file, and `getSlug` returns
 * the bare id so the two halves compose to exactly `ogSlug`'s answer.
 *
 * The two faces are resolved from `node_modules` rather than fetched. `astro-og-canvas` defaults to
 * downloading Noto Sans from a CDN on first render, which would make a card's typography depend on
 * a network round-trip during the build and put a face on the card that appears nowhere on the site.
 * Tinos is metric-compatible with Times New Roman to four decimal places, so the card is set in the
 * same face `--sl-font` asks for first.
 */

const require = createRequire(import.meta.url)

const FONTS = [
  require.resolve("@expo-google-fonts/tinos/400Regular/Tinos_400Regular.ttf"),
  require.resolve("@expo-google-fonts/tinos/700Bold/Tinos_700Bold.ttf")
]

const entries = await getCollection("docs")

/**
 * The root page's collection id is the empty string, which would slug to a bare `.png`. It is named
 * here, once, and `Head.astro` reads the same constant so the tag and the file agree.
 */
const pages = Object.fromEntries(
  entries.map((entry) => [entry.id === "" ? OG_SLUG_ROOT : entry.id, entry.data])
)

export const { getStaticPaths, GET } = await OGImageRoute({
  pages,
  getSlug: (path) => path,
  getImageOptions: (path, page) => ({
    ...ogCard({ id: path, title: page.title, description: page.description }),
    fonts: FONTS
  })
})

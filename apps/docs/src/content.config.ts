import { defineCollection } from "astro:content"
import { docsLoader } from "@astrojs/starlight/loaders"
import { docsSchema } from "@astrojs/starlight/schema"

/**
 * The `docs` collection is Starlight's own. Generated reference pages join it through an additional
 * loader rather than as files on disk, so a page derived from a registry cannot drift from it.
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() })
}

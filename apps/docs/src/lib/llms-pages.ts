import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AstroIntegration } from "astro"

import { rawMarkdownUrl, type SiteContext } from "./agent-surface.js"

/**
 * Appends a `## Pages` section to `llms.txt`: every page of the site, as an absolute link to its raw
 * Markdown route, with its title and description.
 *
 * `starlight-llms-txt` writes the file's two documentation sets (the full and the abridged bundle) and
 * stops. An agent that opens `llms.txt` then has two choices: load 800 KB, or guess URLs. The spike
 * of an alternative renderer (see the `spike/fumapress-static-docs` branch) listed every page, and
 * that is the one piece of its `llms.txt` worth keeping: an index an agent can navigate one page at
 * a time, where each entry is the URL it should fetch rather than the HTML it should not.
 *
 * Runs on `astro:build:done`, after the plugin has written the file and after `starlight-md-txt` has
 * emitted every `.md` twin, which is where each page's title and description are read from — the
 * same front matter an agent sees when it follows the link. Order: the landing page, then the agent
 * page, then the tiers in the sidebar's order, alphabetical within each. `agent-surface.test.ts`
 * asserts the agent page is still the FIRST link in the file: `Start here` precedes this section.
 */

/** The tiers in sidebar order; a page outside them (the glossary) sorts last. */
const TIERS = ["learn", "reference", "internals"]

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/

const frontMatterField = (twin: string, field: string): string | undefined => {
  const block = FRONT_MATTER.exec(twin)?.[1] ?? ""
  const line = block.split("\n").find((candidate) => candidate.startsWith(`${field}:`))
  if (line === undefined) return undefined
  const value = line.slice(field.length + 1).trim()
  return value.startsWith('"') ? JSON.parse(value) : value
}

/** The entry id of a built page: `/learn/tutorial/install/` → `learn/tutorial/install`, `/` → `index`. */
export const entryIdOf = (pathname: string, base: string): string => {
  const segment = base.endsWith("/") ? base : `${base}/`
  const id = pathname.startsWith(segment) ? pathname.slice(segment.length) : pathname
  const trimmed = id.replace(/^\/+|\/+$/g, "")
  return trimmed === "" ? "index" : trimmed
}

const rank = (id: string): number => {
  if (id === "index") return -2
  if (id === "agents") return -1
  const tier = TIERS.indexOf(id.split("/")[0] ?? "")
  return tier === -1 ? TIERS.length : tier
}

/** The `## Pages` section, given each page's id, title, and description. */
export const pagesSection = (
  entries: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description: string | undefined
  }>,
  context: SiteContext
): string =>
  [
    "## Pages",
    "",
    "Every page, as the Markdown an agent should fetch. The landing page and the agent page first,",
    "then each tier in the order the site's navigation uses.",
    "",
    ...[...entries]
      .sort((left, right) => rank(left.id) - rank(right.id) || left.id.localeCompare(right.id))
      .map(
        (entry) =>
          `- [${entry.title}](${rawMarkdownUrl(entry.id, context).href})${entry.description ? `: ${entry.description}` : ""}`
      ),
    ""
  ].join("\n")

export const llmsPages = (context: SiteContext): AstroIntegration => ({
  name: "memhtml:llms-pages",
  hooks: {
    "astro:build:done": async ({ dir, pages, logger }) => {
      const root = dir.pathname
      const entries = []
      for (const page of pages) {
        const id = entryIdOf(`/${page.pathname}`, context.base)
        // The 404 page is not a page of the corpus, and an agent that fetched it followed a broken link.
        if (id === "404") continue
        const twinPath = join(root, id === "index" ? ".md" : `${id}.md`)
        const twin = await readFile(twinPath, "utf8").catch(() => undefined)
        if (twin === undefined) throw new Error(`${id} has no raw Markdown twin at ${twinPath}`)
        const title = frontMatterField(twin, "title")
        if (title === undefined) throw new Error(`${twinPath} has no title in its front matter`)
        entries.push({ id, title, description: frontMatterField(twin, "description") })
      }
      const file = join(root, "llms.txt")
      const current = await readFile(file, "utf8")
      await writeFile(file, `${current.trimEnd()}\n\n${pagesSection(entries, context)}`)
      logger.info(`listed ${entries.length} pages in llms.txt`)
    }
  }
})

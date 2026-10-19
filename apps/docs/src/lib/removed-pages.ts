import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AstroIntegration } from "astro"

/**
 * Pages this site published and later removed, each with the page that replaced it.
 *
 * A removed page keeps its URL. People and agents link to published pages from outside the site, and
 * `llms.txt` listed every page's raw `.md` route, so a URL that starts answering 404 breaks links this
 * repository can't see. Each entry here keeps two things at the old address:
 *
 * - the HTML route, as an Astro redirect. Astro writes it as a small document with a meta refresh and
 *   a canonical link to the new page. It has no `<main>`, no `<h1>`, and no discovery block, so the
 *   page walkers in `tests/` leave these routes out through {@link isRemovedPage}.
 * - the raw `.md` route, as a short Markdown note naming the replacement, written by
 *   {@link removedPageTwins}. A meta refresh means nothing to an agent reading Markdown.
 *
 * `from` and `to` are entry ids without the base segment and with the trailing slash the site's
 * `trailingSlash: "always"` requires. `tests/removed-pages.test.ts` checks that every `to` is a built
 * page, that no `from` is one, and that both stubs exist.
 */
export const REMOVED_PAGES: ReadonlyArray<{
  readonly from: string
  readonly title: string
  readonly to: string
  readonly removedIn: string
}> = [
  {
    from: "internals/the-sleep-pipeline/",
    title: "The sleep pipeline",
    to: "learn/operations/migrate-to-0-16/",
    removedIn: "0.16"
  },
  {
    from: "internals/the-consolidator/",
    title: "The consolidator",
    to: "learn/operations/migrate-to-0-16/",
    removedIn: "0.16"
  },
  {
    from: "learn/operations/run-and-review-a-sleep-cycle/",
    title: "Run and review a sleep cycle",
    to: "learn/operations/curate-the-corpus/",
    removedIn: "0.16"
  },
  {
    from: "reference/sleep-phases/",
    title: "Sleep phases",
    to: "learn/operations/migrate-to-0-16/",
    removedIn: "0.16"
  },
  {
    from: "reference/commands/sleep-run/",
    title: "memhtml sleep run",
    to: "reference/commands/curate-run/",
    removedIn: "0.16"
  },
  {
    from: "reference/commands/sleep-resume/",
    title: "memhtml sleep resume",
    to: "reference/commands/curate-run/",
    removedIn: "0.16"
  },
  {
    from: "reference/commands/sleep-plan/",
    title: "memhtml sleep plan",
    to: "reference/commands/curate-run/",
    removedIn: "0.16"
  },
  {
    from: "reference/commands/sleep-review/",
    title: "memhtml sleep review",
    to: "learn/operations/curate-the-corpus/",
    removedIn: "0.16"
  },
  {
    from: "reference/commands/sleep-merge/",
    title: "memhtml sleep merge",
    to: "reference/commands/curate-merge/",
    removedIn: "0.16"
  },
  {
    from: "reference/commands/sleep-status/",
    title: "memhtml sleep status",
    to: "learn/operations/migrate-to-0-16/",
    removedIn: "0.16"
  }
]

const segmentOf = (base: string): string => (base.endsWith("/") ? base : `${base}/`)

/** `path` without its leading and trailing slashes. A loop rather than a pattern, so it stays linear. */
const trimSlashes = (path: string): string => {
  let start = 0
  let end = path.length
  while (start < end && path[start] === "/") start += 1
  while (end > start && path[end - 1] === "/") end -= 1
  return path.slice(start, end)
}

/**
 * True for a site-absolute path, or an entry id, that names a removed page's stub.
 *
 * Accepts both shapes the tests hold: `/internals/the-sleep-pipeline/` from a dist walk and
 * `internals/the-sleep-pipeline` from an entry id.
 */
export const isRemovedPage = (path: string, base: string): boolean => {
  const segment = segmentOf(base)
  const id = trimSlashes(path.startsWith(segment) ? path.slice(segment.length) : path)
  return REMOVED_PAGES.some((page) => trimSlashes(page.from) === id)
}

/**
 * The `redirects` map for `astro.config.ts`.
 *
 * A key is a route, which Astro matches below the base. A destination is written into the stub as it
 * stands, so it carries the base segment here: Astro only adds the base when the destination names a
 * route of its own, and every page of this site is one Starlight catch-all route.
 */
export const removedPageRedirects = (base: string): Record<string, string> =>
  Object.fromEntries(REMOVED_PAGES.map((page) => [`/${page.from}`, `${segmentOf(base)}${page.to}`]))

/** The raw `.md` note at a removed page's old address. */
export const removedPageTwin = (page: (typeof REMOVED_PAGES)[number], base: string): string =>
  [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(`Removed in memhtml ${page.removedIn}.`)}`,
    "---",
    "",
    `memhtml ${page.removedIn} removed this page. [Its replacement](${segmentOf(base)}${trimSlashes(page.to)}.md) covers what took its place.`,
    ""
  ].join("\n")

/**
 * Writes each removed page's raw `.md` note on `astro:build:done`, beside the twins `starlight-md-txt`
 * emits for the pages that still exist.
 */
export const removedPageTwins = (base: string): AstroIntegration => ({
  name: "memhtml:removed-page-twins",
  hooks: {
    "astro:build:done": async ({ dir, logger }) => {
      for (const page of REMOVED_PAGES) {
        const file = join(dir.pathname, `${trimSlashes(page.from)}.md`)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, removedPageTwin(page, base))
      }
      logger.info(`wrote ${REMOVED_PAGES.length} removed-page notes`)
    }
  }
})

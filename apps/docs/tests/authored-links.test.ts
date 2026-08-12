import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { referencePages } from "../src/loaders/pages.js"
import { collectRegistry } from "../src/loaders/registry.js"

/**
 * Every internal link an author wrote, resolved against the pages that actually exist.
 *
 * This exists because `starlight-links-validator` structurally cannot check a link into the Reference
 * tier: it accepts a link only when the target is both a built page and one whose headings it gathered
 * through its own remark plugin, and a Reference page's Markdown is rendered by the loader instead. So
 * all 57 of them are excluded in `astro.config.ts`, and this is what replaces that check — against the
 * same registry the pages are generated from, so the two cannot disagree, and with no build needed.
 *
 * It is deliberately wider than the exclusion: it resolves EVERY authored internal link, Reference or
 * not, and it also refuses a hand-built base prefix. A link written as `/memhtml/learn/` would be
 * correct today and wrong the moment the site moves to a custom domain, because `starlight-base-path`
 * would prefix the base onto it a second time.
 */

const docs = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "content", "docs")

const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.mdx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : []
  )

const files = walk(docs)

/** The route a file serves, as a leading-and-trailing-slashed path: `learn/index.md` is `/learn/`. */
const routeOf = (file: string): string => {
  const id = relative(docs, file)
    .replace(/\.mdx?$/, "")
    .replace(/\\/g, "/")
  const withoutIndex = id === "index" ? "" : id.replace(/\/index$/, "")
  return `/${withoutIndex}${withoutIndex === "" ? "" : "/"}`
}

const authoredRoutes = new Set(files.map(routeOf))
const generatedRoutes = new Set(
  referencePages(collectRegistry(), { base: "/" }).map((page) => `/${page.id}/`)
)
const routes = new Set([...authoredRoutes, ...generatedRoutes])

/**
 * Markdown links only — `[label](target)`.
 *
 * An href written inside raw HTML would need `import.meta.env.BASE_URL` to be base-correct and would
 * leave a JSX expression in the Markdown these pages also serve, so the next case asserts there are
 * none rather than trying to resolve them.
 */
const linksIn = (body: string): ReadonlyArray<string> =>
  [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "")

const internal = (link: string): boolean => link.startsWith("/")

/**
 * The machine surfaces `starlight-llms-txt` emits at the site root. They are files rather than pages,
 * so no page route resolves them, and the agent page links them on purpose.
 */
const MACHINE_SURFACES: ReadonlySet<string> = new Set([
  "/llms.txt",
  "/llms-full.txt",
  "/llms-small.txt"
])

/**
 * A link to a page's raw Markdown route, which `starlight-md-txt` serves at the page's own path with a
 * `.md` suffix. `/reference/guide/first-call.md` is the raw route of the page at
 * `/reference/guide/first-call/`, so it resolves exactly when that page does.
 *
 * The agent page links these deliberately: its reading list carries fetchable Markdown URLs so an agent
 * reads the document instead of scraping the page. A resolver that only knows page slugs reports every
 * one of them broken, which is a defect in the resolver.
 */
const rawRouteTarget = (link: string): string | undefined =>
  link.endsWith(".md") ? `${link.slice(0, -".md".length)}/`.replace(/\/+$/, "/") : undefined

describe("every authored internal link", () => {
  it("finds files to check, and links inside them", () => {
    expect(files.length).toBeGreaterThan(20)
    expect(generatedRoutes.size).toBeGreaterThan(50)
    const total = files.reduce(
      (count, file) => count + linksIn(readFileSync(file, "utf8")).filter(internal).length,
      0
    )
    expect(total).toBeGreaterThan(50)
  })

  it("resolves to a page that exists", () => {
    const broken: Array<string> = []
    for (const file of files) {
      for (const link of linksIn(readFileSync(file, "utf8")).filter(internal)) {
        const target = link.split("#")[0] ?? link
        if (MACHINE_SURFACES.has(target)) continue
        const asRawRoute = rawRouteTarget(target)
        if (asRawRoute !== undefined) {
          // `/reference.md` is the raw route of the tier index, whose page route is `/reference/`.
          if (routes.has(asRawRoute)) continue
          broken.push(`${relative(docs, file)} → ${link}`)
          continue
        }
        if (!routes.has(target)) broken.push(`${relative(docs, file)} → ${link}`)
      }
    }
    expect(broken).toEqual([])
  })

  it("is written without the site base, which the base-path plugin prefixes", () => {
    const prefixed: Array<string> = []
    for (const file of files) {
      for (const link of linksIn(readFileSync(file, "utf8")).filter(internal)) {
        if (link.startsWith("/memhtml/")) prefixed.push(`${relative(docs, file)} → ${link}`)
      }
    }
    expect(prefixed).toEqual([])
  })

  /*
   * A `<a href>` in raw HTML bypasses `starlight-base-path`, so it would 404 under the site base. The
   * check is on authored files only; the components under `src/` build their URLs with `new URL()`
   * over `import.meta.env.BASE_URL`, which is the accessor that includes the base.
   */
  it("is never a hand-written href in raw HTML", () => {
    for (const file of files) {
      expect(readFileSync(file, "utf8"), relative(docs, file)).not.toMatch(/<a\s[^>]*href=/i)
    }
  })
})

import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BASE, BASE_SEGMENT, DIST_DIR } from "../src/gates.js"
import { type StaticSite, serveStatic } from "./static-server.js"

/**
 * The renderer-independent invariant: every page is complete as plain HTTP, with no JavaScript run.
 *
 * A documentation site can pass every other gate here and still be an application shell — a
 * `<div id="root">` that a crawler, a `curl`, or an agent without a browser receives empty. This
 * suite fetches every built page the way those readers do and asserts the document already carries
 * its landmark, its heading, and its prose. Representative pages are also asserted for content only
 * that page has, so a build that served one page's body under every route would fail too.
 *
 * Written during the Fumapress spike (see the `spike/fumapress-static-docs` branch), where it was the
 * one gate that held whichever renderer produced `dist/`. It stays because a renderer migration is
 * exactly when a site turns into a shell without anyone noticing.
 *
 * Served from disk over loopback rather than read as files, so the status code and the content type
 * a host would send are part of what is checked.
 */

const dist = join(fileURLToPath(new URL("..", import.meta.url)), DIST_DIR)

/** Directories under the output that hold no page: bundles, the search index, the cards, the figures. */
const NOT_PAGES: ReadonlySet<string> = new Set(["_astro", "pagefind", "og", "d2"])

/** Every page route, derived from the `index.html` files the build wrote. */
const routes = (): ReadonlyArray<string> => {
  const walk = (directory: string, prefix: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (prefix === BASE_SEGMENT && NOT_PAGES.has(entry.name)) return []
      if (entry.isDirectory()) return walk(join(directory, entry.name), `${prefix}${entry.name}/`)
      return entry.name === "index.html" ? [prefix] : []
    })
  return walk(dist, BASE_SEGMENT)
}

/**
 * The visible text of a document, roughly: tags, scripts and styles removed, whitespace folded.
 *
 * A tag may carry anything up to its `>`, whitespace and stray attributes included, so both the
 * opening and the closing patterns accept `[^>]*` there (CodeQL's `js/bad-tag-filter` names
 * `</script\t\n bar>` as the shape a stricter pattern misses). A stripper that stopped at
 * `</script>` alone would count the rest of a script as prose.
 */
const visibleText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Content only that page carries, one sample per template: the landing page, the agent page, an
 * authored Learn page, a generated Reference page, an Internals page with a figure, the glossary.
 */
const SAMPLES: ReadonlyArray<{ readonly route: string; readonly carries: ReadonlyArray<string> }> =
  [
    { route: "", carries: ["Memory for Agents, in HTML", "Where to start"] },
    { route: "agents/", carries: ["The manifest outranks this page", "For an agent."] },
    { route: "learn/tutorial/install/", carries: ["memhtml manifest", "Or build it from a clone"] },
    { route: "reference/mcp-tools/", carries: ["The toolkit", "memory_search", "Provenance"] },
    {
      route: "internals/the-write-path/",
      carries: ["Figure 1", "d2/docs/internals/the-write-path-0.svg"]
    },
    { route: "glossary/", carries: ["Glossary"] }
  ]

let site: StaticSite
const fetched = new Map<string, { status: number; type: string; html: string }>()

beforeAll(async () => {
  site = await serveStatic(dist, BASE)
  for (const route of routes()) {
    const response = await fetch(`${site.origin}${route}`)
    fetched.set(route, {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      html: await response.text()
    })
  }
}, 120_000)

afterAll(async () => {
  await site?.close()
})

describe("every page is complete over plain HTTP", () => {
  it("finds the corpus, so nothing below is vacuous", () => {
    expect(fetched.size).toBeGreaterThan(50)
  })

  it("answers 200 with an HTML content type", () => {
    for (const [route, page] of fetched) {
      expect(page.status, route).toBe(200)
      expect(page.type, route).toContain("text/html")
    }
  })

  it("carries a main landmark, exactly one h1, and a title, before any script runs", () => {
    for (const [route, page] of fetched) {
      expect(page.html, `${route} has no <main>`).toMatch(/<main\b/)
      expect(page.html.match(/<h1\b/g) ?? [], `${route} h1 count`).toHaveLength(1)
      expect(page.html, `${route} has no <title>`).toMatch(/<title>[^<]+<\/title>/)
    }
  })

  it("carries substantive visible text, not an application shell", () => {
    for (const [route, page] of fetched) {
      const text = visibleText(page.html.slice(page.html.indexOf("<main")))
      // Long enough that a heading and a navigation alone cannot reach it; the shortest real page is
      // several sentences.
      expect(
        text.length,
        `${route} renders ${text.length} characters of visible text`
      ).toBeGreaterThan(300)
    }
  })

  it.each(SAMPLES)("serves $route with content only that page has", ({ route, carries }) => {
    const page = fetched.get(`${BASE_SEGMENT}${route}`)
    expect(page, `${route} was not built`).toBeDefined()
    for (const needle of carries) expect(page?.html, `${route} lacks ${needle}`).toContain(needle)
  })

  it("serves the Markdown twin of a sampled page as text/markdown", async () => {
    const response = await fetch(`${site.origin}${BASE_SEGMENT}reference/mcp-tools.md`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/markdown")
    expect(await response.text()).toContain("## 1. The toolkit")
  })
})

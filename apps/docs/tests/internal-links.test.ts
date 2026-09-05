import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { BASE_SEGMENT, DIST_DIR } from "../src/gates.js"

/**
 * Every internal link on every built page resolves to a built file, and every fragment to an id on
 * the target page.
 *
 * `starlight-links-validator` cannot judge a link into the Reference tier: it accepts a link only
 * when the target's headings passed through its own remark plugin, and a loader-injected page has no
 * file for that pass, so the whole tier is excluded in `astro.config.ts`. Until now the exclusion
 * was covered for the agent page alone (`agent-surface.test.ts`) and for the raw `.md` routes
 * (`raw-route-links.test.ts`). This is the general case: the rendered HTML of every page, links and
 * fragments both, resolved against the bytes in `dist/`. The Fumapress spike's link validator worked
 * this way — follow what was rendered, against what was built — and it is the shape that does not
 * depend on which renderer produced the pages.
 *
 * Fragments matter here more than most sites: section numbers live in heading text, so an anchor is
 * `#32-edge-encoding` and moves when a section is inserted. A stale one is invisible in a browser
 * (the page still loads) and this is the gate that names it.
 */

const dist = join(fileURLToPath(new URL("..", import.meta.url)), DIST_DIR)

const walk = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "pagefind" || entry.name === "_astro" ? [] : walk(path)
    return entry.name.endsWith(".html") ? [path] : []
  })

const pages = walk(dist).map((file) => ({ file, html: readFileSync(file, "utf8") }))

/** Every `href` in the document body; the head's icons and machine relations are covered elsewhere. */
const bodyHrefs = (html: string): ReadonlyArray<string> =>
  [...html.slice(html.indexOf("<body")).matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "")

/** Every element id on a page, as a set. */
const idsOf = (html: string): ReadonlySet<string> =>
  new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""))

const ids = new Map<string, ReadonlySet<string>>()
const idsAt = (file: string): ReadonlySet<string> => {
  const cached = ids.get(file)
  if (cached) return cached
  const found = idsOf(readFileSync(file, "utf8"))
  ids.set(file, found)
  return found
}

/** The built file a site-absolute path serves, or `undefined`. */
const fileFor = (path: string): string | undefined => {
  const within = path.slice(BASE_SEGMENT.length)
  const candidate = join(dist, within)
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  const asDirectory = join(candidate, "index.html")
  return existsSync(asDirectory) ? asDirectory : undefined
}

describe("every internal link on every built page", () => {
  const internal = pages.flatMap(({ file, html }) =>
    bodyHrefs(html)
      .filter((href) => href.startsWith(BASE_SEGMENT) || href.startsWith("#"))
      .map((href) => ({ page: relative(dist, file), href }))
  )

  it("finds pages and links, so nothing below is vacuous", () => {
    expect(pages.length).toBeGreaterThan(50)
    expect(internal.length).toBeGreaterThan(1000)
    expect(internal.filter(({ href }) => href.includes("#")).length).toBeGreaterThan(100)
  })

  it("resolves to a file the build wrote", () => {
    const broken = internal
      .filter(({ href }) => !href.startsWith("#"))
      .filter(({ href }) => fileFor(href.split("#")[0] ?? href) === undefined)
      .map(({ page, href }) => `${page} → ${href}`)
    expect(broken).toEqual([])
  })

  it("resolves every fragment to an id on the target page", () => {
    const missing = internal
      .filter(({ href }) => href.includes("#"))
      .flatMap(({ page, href }) => {
        const [path, fragment] = href.split("#") as [string, string]
        if (fragment === "" || fragment === "_top") return []
        const target = path === "" ? join(dist, page) : fileFor(path)
        if (target === undefined) return [] // reported by the case above
        return idsAt(target).has(decodeURIComponent(fragment)) ? [] : [`${page} → ${href}`]
      })
    expect(missing).toEqual([])
  })

  it("emits no protocol-relative href, which names a host rather than a path", () => {
    for (const { file, html } of pages) {
      for (const href of bodyHrefs(html)) {
        expect(href.startsWith("//"), `${relative(dist, file)} → ${href}`).toBe(false)
      }
    }
  })
})

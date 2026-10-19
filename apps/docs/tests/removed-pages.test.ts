import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { BASE_SEGMENT, DIST_DIR } from "../src/gates.js"
import { REMOVED_PAGES } from "../src/lib/removed-pages.js"
import { referencePages } from "../src/loaders/pages.js"
import { collectRegistry } from "../src/loaders/registry.js"

/**
 * The redirect stubs at removed pages' old addresses, read from `dist/`.
 *
 * The other page walkers leave these routes out, so this file is where they're held to something: each
 * stub refreshes to its replacement, the replacement is a real page, the raw `.md` route carries a
 * note naming it, and no stub sits where a live page should be.
 */

const root = fileURLToPath(new URL("..", import.meta.url))
const dist = join(root, DIST_DIR)
const content = join(root, "src", "content", "docs")

const readDist = (path: string): string => {
  const file = join(dist, path)
  if (!existsSync(file)) throw new Error(`\`dist/${path}\` is absent — build the site first`)
  return readFileSync(file, "utf8")
}

const withoutSlash = (id: string): string => id.slice(0, id.length - (id.endsWith("/") ? 1 : 0))

/** Every `index.html` in the output that is a meta-refresh stub, as an entry id with a slash. */
const builtStubs = (): ReadonlyArray<string> => {
  const walk = (directory: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return entry.name === "_astro" ? [] : walk(path)
      if (entry.name !== "index.html") return []
      return readFileSync(path, "utf8").includes('http-equiv="refresh"')
        ? [`${relative(dist, directory)}/`]
        : []
    })
  return walk(dist)
}

/** Every authored entry id, from the content directory's file names. */
const authoredIds = (): ReadonlySet<string> => {
  const walk = (directory: string, prefix: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return walk(join(directory, entry.name), `${prefix}${entry.name}/`)
      return /\.mdx?$/.test(entry.name) ? [`${prefix}${entry.name.replace(/\.mdx?$/, "")}`] : []
    })
  return new Set(walk(content, ""))
}

describe("a removed page keeps its URL", () => {
  it("lists each old address once, in the trailing-slash form the site builds", () => {
    const from = REMOVED_PAGES.map((page) => page.from)
    expect(new Set(from).size).toBe(from.length)
    for (const page of REMOVED_PAGES) {
      expect(page.from.endsWith("/"), page.from).toBe(true)
      expect(page.to.endsWith("/"), page.to).toBe(true)
      expect(page.from.startsWith("/"), page.from).toBe(false)
    }
  })

  it("builds exactly the stubs the list declares, and no others", () => {
    expect([...builtStubs()].sort()).toEqual(REMOVED_PAGES.map((page) => page.from).sort())
  })

  it.each(REMOVED_PAGES)("refreshes $from to $to, which is a page", ({ from, to }) => {
    const stub = readDist(join(from, "index.html"))
    expect(stub).toContain(`<meta http-equiv="refresh" content="0;url=${BASE_SEGMENT}${to}">`)
    const target = readDist(join(to, "index.html"))
    expect(target, `${to} is not a page`).toMatch(/<main\b/)
    expect(target).not.toContain('http-equiv="refresh"')
  })

  it.each(REMOVED_PAGES)("keeps a Markdown note at $from's raw route", ({ from, to }) => {
    const note = readDist(`${withoutSlash(from)}.md`)
    expect(note).toMatch(/^---\ntitle: /)
    expect(note).toContain(`](${BASE_SEGMENT}${withoutSlash(to)}.md)`)
    readDist(`${withoutSlash(to)}.md`)
  })

  it("never puts a stub where an authored or generated page lives", () => {
    const authored = authoredIds()
    const generated = new Set(
      referencePages(collectRegistry(), { base: "/" }).map((page) => page.id)
    )
    for (const { from } of REMOVED_PAGES) {
      expect(authored.has(withoutSlash(from)), `${from} is an authored page`).toBe(false)
      expect(generated.has(withoutSlash(from)), `${from} is a generated page`).toBe(false)
    }
  })

  it("leaves every stub out of llms.txt", () => {
    const index = readDist("llms.txt")
    for (const { from } of REMOVED_PAGES) expect(index).not.toContain(`/${withoutSlash(from)}.md`)
  })
})

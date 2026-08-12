import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import lighthouserc from "../lighthouserc.json" with { type: "json" }
import { AUDITED_PAGES, BASE_SEGMENT, DENYLIST, DIST_DIR } from "../src/gates.js"

/**
 * Gates over the BUILT site. Every case here reads `dist/`, which turbo guarantees is current:
 * `@memhtml/docs#test` declares `dependsOn: ["build", "typecheck"]`. Calling vitest directly (as
 * `mise run test-pkg docs` does) skips that, so `distFiles` fails loudly on an absent `dist/`
 * rather than reporting a clean scan of nothing.
 *
 * The scan targets the three surfaces a reader or an agent can fetch — rendered HTML, the raw `.md`
 * route of every page, and the llms bundles. The `_astro/` chunks are excluded: they are compiled
 * vendor JavaScript, no prose of ours survives in them, and minified identifiers are a false-
 * positive farm.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const dist = join(packageRoot, DIST_DIR)

const walk = (directory: string): ReadonlyArray<string> => {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

const distFiles = (): ReadonlyArray<string> => {
  try {
    statSync(dist)
  } catch {
    throw new Error(
      `no ${DIST_DIR}/ under ${packageRoot} — build the site first (\`mise run docs:build\`). ` +
        "These gates read the built output, and a missing directory is not an empty one."
    )
  }
  return walk(dist)
}

/** The three fetchable surfaces, as {path, text} pairs read once and shared by every case. */
const surfaces = (() => {
  const wanted = (file: string): boolean => {
    const name = relative(dist, file)
    if (name.startsWith("_astro/") || name.startsWith("pagefind/")) return false
    return name.endsWith(".html") || name.endsWith(".md") || /^llms.*\.txt$/.test(name)
  }
  return distFiles()
    .filter(wanted)
    .map((file) => ({ path: relative(dist, file), text: readFileSync(file, "utf8") }))
})()

const htmlPages = surfaces.filter((one) => one.path.endsWith(".html"))

describe("no denylisted token reaches a public page", () => {
  /*
   * One case per term rather than one case for the list: the report then names the term that leaked,
   * and a second leak does not hide behind the first.
   *
   * `starlight-llms-txt` has its own `exclude` option and it is NOT a substitute for this — that
   * option filters `llms-small.txt` alone, leaving `llms.txt`, `llms-full.txt`, and every `.md`
   * route untouched. Exclusion cannot be delegated to plugin config, so it is asserted over the
   * whole output instead.
   */
  for (const { pattern, why } of DENYLIST) {
    it(`refuses ${pattern.source}`, () => {
      const hits = surfaces
        .filter((one) => pattern.test(one.text))
        .map((one) => {
          const line = one.text.split("\n").findIndex((text) => pattern.test(text)) + 1
          return `${one.path}:${line}`
        })
      expect(hits, `${pattern.source} must not reach a public page — ${why}`).toEqual([])
    })
  }

  it("scans every page of the site, on all three surfaces", () => {
    // Independently derived: Starlight writes one `index.html` per route plus `404.html`, and
    // `starlight-md-txt` writes one `.md` per route. Equal counts is the invariant; a plugin that
    // stopped emitting `.md` would otherwise shrink the scan silently.
    const md = surfaces.filter((one) => one.path.endsWith(".md"))
    expect(htmlPages.length).toBeGreaterThan(50)
    expect(md).toHaveLength(htmlPages.length)
    expect(
      surfaces
        .filter((one) => one.path.startsWith("llms"))
        .map((one) => one.path)
        .sort()
    ).toEqual(["llms-full.txt", "llms-small.txt", "llms.txt"])
  })
})

describe("what axe cannot see", () => {
  /*
   * axe-core passes `alt="Diagram"`: `image-alt` asks whether an accessible name exists, never
   * whether it says anything. This is the census that does, over every page rather than the four the
   * browser tier audits, because a placeholder alt can be authored anywhere.
   *
   * astro-d2 emits its figures as `<img>` with the fence's own title as the alt text, so this is
   * also the gate on a figure shipped without a caption.
   */
  const PLACEHOLDER_ALT =
    /^(image|img|picture|photo|screenshot|diagram|figure|chart|graph|illustration|graphic|icon)s?$/i

  it("gives every image an alt that says something", () => {
    const offences: string[] = []
    for (const page of htmlPages) {
      for (const tag of page.text.match(/<img\b[^>]*>/g) ?? []) {
        const alt = /\balt\s*=\s*"([^"]*)"/.exec(tag)
        if (!alt) offences.push(`${page.path}: no alt — ${tag.slice(0, 90)}`)
        else if (alt[1] !== undefined && PLACEHOLDER_ALT.test(alt[1].trim()))
          offences.push(`${page.path}: placeholder alt "${alt[1]}"`)
      }
    }
    expect(offences).toEqual([])
  })

  /*
   * axe ignores an inline `<svg>` that carries no `role="img"`, and inline SVG is exactly how this
   * site draws every icon. `tests/a11y.test.ts` decides each one in a real DOM, where an
   * `aria-hidden` ancestor is visible — Starlight wraps the heading-anchor icon in
   * `<span aria-hidden="true">`, so a check that could only read the `<svg>` tag itself would report
   * a violation that does not exist.
   *
   * A four-page sample could still under-report, and this closes that: every distinct `<svg>`
   * opening tag the whole site emits also appears on one of the audited pages. The tags are
   * component output, so the distinct set is small and stable, and a new icon shape that lands only
   * on an unaudited page fails here instead of going unexamined.
   */
  it("emits no inline SVG shape the browser tier never sees", () => {
    const openings = (text: string): ReadonlyArray<string> =>
      (text.match(/<svg\b[^>]*>/g) ?? []).map((tag) => tag.replace(/\s+style="[^"]*"/g, ""))

    const auditedPaths = new Set(
      AUDITED_PAGES.map((url) => `${url.slice(BASE_SEGMENT.length)}index.html`)
    )
    const audited = new Set(
      htmlPages.filter((page) => auditedPaths.has(page.path)).flatMap((page) => openings(page.text))
    )
    expect(auditedPaths.size, "every audited page must be a page of this site").toBe(
      htmlPages.filter((page) => auditedPaths.has(page.path)).length
    )
    expect(audited.size).toBeGreaterThan(0)

    const unseen = new Map<string, string>()
    for (const page of htmlPages)
      for (const tag of openings(page.text)) if (!audited.has(tag)) unseen.set(tag, page.path)
    expect(
      [...unseen].map(([tag, page]) => `${page}: ${tag.slice(0, 120)}`),
      "add the page carrying this icon to AUDITED_PAGES, or audit the icon where it already appears"
    ).toEqual([])
  })

  /*
   * The third blind spot, SC 1.4.12 text spacing, axe does not test at all — it needs the page
   * re-laid-out under the WCAG spacing overrides, which only a browser can do.
   * `tests/a11y.test.ts` does it there; nothing about it is checkable from the bytes, so this case
   * asserts only that the probe still exists rather than pretending to cover the criterion.
   */
  it("keeps a text-spacing probe in the browser tier, since nothing here can cover SC 1.4.12", () => {
    const suite = readFileSync(join(packageRoot, "tests/a11y.test.ts"), "utf8")
    expect(suite).toContain("letter-spacing: 0.12em")
    expect(suite).toContain("word-spacing: 0.16em")
    expect(suite).toContain("line-height: 1.5")
  })
})

describe("the two gate configurations name the same pages", () => {
  /*
   * `lighthouserc.json` is JSON and cannot import `src/gates.ts`, so the page set is written twice.
   * This is the drift gate that makes the duplication safe — the same shape as the `AGENTS.md`
   * check, and for the same reason: two files that must agree, and no mechanism forcing them to.
   */
  it("audits the same URLs for accessibility and for the performance budget", () => {
    expect(lighthouserc.ci.collect.url).toEqual([...AUDITED_PAGES])
  })

  it("keeps every audited URL under the base segment the site is built with", () => {
    for (const url of AUDITED_PAGES) expect(url.startsWith(BASE_SEGMENT)).toBe(true)
  })
})

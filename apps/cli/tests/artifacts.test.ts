import { describe, expect, it } from "vitest"

import { generateArtifacts, generateIndexes, generateSitemap } from "../src/artifacts.js"

/**
 * The generated listings and sitemap behind `memhtml publish`: deterministic to the byte, complete over
 * every directory and ancestor, and escaped so a memory cannot inject markup into its own listing.
 */
describe("the generated artifacts", () => {
  const rows = [
    {
      path: "areas/oncall/a.html",
      title: "A",
      gist: "The A claim",
      memory_type: "procedural",
      updated_at: "2026-08-01T00:00:00Z"
    },
    {
      path: "projects/web/b.html",
      title: "B & C",
      gist: "The B claim <with markup>",
      memory_type: "semantic",
      updated_at: "2026-08-02T00:00:00Z"
    }
  ]

  it("is byte-identical across two runs over the same rows", () => {
    /**
     * Determinism is what makes `merge=ours` plus a regeneration pass a real conflict resolution: a
     * generator carrying a timestamp of generation would make every run conflict with itself.
     */
    expect(generateArtifacts(rows)).toEqual(generateArtifacts(rows))
    expect(generateArtifacts([...rows].reverse())).toEqual(generateArtifacts(rows))
  })

  it("writes one listing per directory plus every ancestor, so the tree browses with no server", () => {
    const paths = generateIndexes(rows).map((file) => file.path)
    expect(paths).toContain("index.html")
    expect(paths).toContain("areas/index.html")
    expect(paths).toContain("areas/oncall/index.html")
    expect(paths).toContain("projects/index.html")
    expect(paths).toContain("projects/web/index.html")
    // An ancestor's listing links its children, which is what makes the walk possible.
    const areas = generateIndexes(rows).find((file) => file.path === "areas/index.html")
    expect(areas?.html).toContain('href="/areas/oncall/index.html"')
  })

  it("escapes titles and gists, so a memory cannot inject markup into a listing", () => {
    const web = generateIndexes(rows).find((file) => file.path === "projects/web/index.html")
    expect(web?.html).toContain("B &amp; C")
    expect(web?.html).toContain("&lt;with markup&gt;")
    expect(web?.html).not.toContain("<with markup>")
  })

  it("writes a path-ordered sitemap with memhtml-updated as lastmod and no invented origin", () => {
    const sitemap = generateSitemap(rows)
    expect(sitemap.path).toBe("sitemap.xml")
    expect(sitemap.html.indexOf("/areas/oncall/a.html")).toBeLessThan(
      sitemap.html.indexOf("/projects/web/b.html")
    )
    expect(sitemap.html).toContain("<lastmod>2026-08-01T00:00:00Z</lastmod>")
    /**
     * Every `<loc>` is repo-root-relative. The repo has no canonical origin — it is browsed from a
     * filesystem, from a clone on another machine, and occasionally from a static server — so an
     * absolute origin would be a value the generator invents and every consumer ignores. (The sitemap
     * NAMESPACE is a URL, and that is the schema identifier, not a location.)
     */
    for (const loc of sitemap.html.matchAll(/<loc>([^<]*)<\/loc>/g)) {
      expect(loc[1]?.startsWith("/")).toBe(true)
      expect(loc[1]).not.toContain("://")
    }
  })
})

import { describe, expect, it } from "vitest"

import {
  generateArtifacts,
  generateIndexes,
  generateSitemap,
  staleListings
} from "../src/artifacts.js"

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

describe("the stale listings publish removes", () => {
  const rows = [
    {
      path: "resources/acme-widget/a.html",
      title: "A",
      gist: "The A claim",
      memory_type: "semantic",
      updated_at: "2031-01-01T00:00:00Z"
    }
  ]
  const generated = generateArtifacts(rows)
  const generatedPaths = generated.map((file) => file.path)

  it("is every tracked bucket listing the generator no longer produces", () => {
    const tracked = [...generatedPaths, "resources/old/index.html", "archive/2031/index.html"]
    expect(staleListings(tracked, generated)).toEqual([
      "archive/2031/index.html",
      "resources/old/index.html"
    ])
  })

  it("never names a generated artifact, so a current listing is never removed", () => {
    expect(staleListings(generatedPaths, generated)).toEqual([])
  })

  it("never names the root listing, the sitemap, or a file outside the four buckets", () => {
    /**
     * Over a store with no record the generator produces the sitemap alone, so every tracked path
     * below is absent from its output. Only the two under a bucket are listings it owns.
     */
    const tracked = [
      "index.html",
      "sitemap.xml",
      "notes/index.html",
      "resourcesx/old/index.html",
      ".memhtml/state/index.html",
      "areas/index.html",
      "areas/inbox/index.html"
    ]
    expect(staleListings(tracked, generateArtifacts([]))).toEqual([
      "areas/inbox/index.html",
      "areas/index.html"
    ])
  })

  it("names only files called index.html, never a record or a near name", () => {
    const tracked = [
      "resources/old/a.html",
      "resources/old/notindex.html",
      "resources/old/index.html.bak",
      "resources/old/Index.html"
    ]
    expect(staleListings(tracked, generated)).toEqual([])
  })

  it("keeps a listing whose directory holds a tracked record the rows do not list", () => {
    /**
     * The rows can be behind the tree: a pull the index has not caught up with, an interrupted
     * rebuild, or a record that no longer parses. A tracked record keeps its directory's listing and
     * every ancestor's, whatever the rows say.
     */
    const tracked = [
      ...generatedPaths,
      "resources/new-area/index.html",
      "resources/new-area/b.html",
      "projects/index.html",
      "projects/acme-widget/index.html",
      "projects/acme-widget/tasks/index.html",
      "projects/acme-widget/tasks/c.html"
    ]
    expect(staleListings(tracked, generated)).toEqual([])
  })

  it("counts only a path the indexer would read as a record", () => {
    // A placeholder, a note, and another listing are tracked files, and none of them is a record.
    const tracked = [
      "resources/old/index.html",
      "resources/old/.gitkeep",
      "resources/old/notes.txt",
      "resources/old/deep/index.html"
    ]
    expect(staleListings(tracked, generated)).toEqual([
      "resources/old/deep/index.html",
      "resources/old/index.html"
    ])
  })

  it("names each path once, in path order", () => {
    // `git ls-files` repeats an unmerged path once per stage.
    const tracked = ["resources/b/index.html", "resources/a/index.html", "resources/b/index.html"]
    expect(staleListings(tracked, generated)).toEqual([
      "resources/a/index.html",
      "resources/b/index.html"
    ])
  })
})

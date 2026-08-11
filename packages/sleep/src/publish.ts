import { escapeAttribute, escapeText } from "@memhtml/html"

import type { PublishRow } from "./sql.js"

/**
 * The generated artifacts: one `index.html` per directory and a root `sitemap.xml`.
 *
 * **This lives in `@memhtml/sleep` rather than `@memhtml/store`, and T10's `memhtml publish` imports it.** The
 * generator needs the index — a listing shows each memory's title, gist, type, and updated stamp, all
 * of which are projections — and `@memhtml/store` is SQL-free by design. Sleep's integrity phase is the
 * only automatic regenerator, so the generator lives beside its one caller and the CLI command binds
 * to the same functions rather than re-deriving the format. Two generators would produce two byte
 * sequences for one tree, and these files are `merge=ours`: a conflict is resolved by regenerating,
 * which only works if regeneration is unambiguous.
 *
 * Deterministic by construction. The row set arrives path-ordered from SQL, every string is escaped,
 * and no timestamp of generation appears anywhere — so two runs over an unchanged corpus produce
 * byte-identical files, nothing is staged, and the integrity phase's commit stays empty.
 */

/** The generated per-directory listing filename. */
export const INDEX_FILENAME = "index.html"

/** The generated root sitemap filename. */
export const SITEMAP_FILENAME = "sitemap.xml"

/** One generated file: its repo-root-relative path and its whole contents. */
export interface GeneratedFile {
  readonly path: string
  readonly html: string
}

/** The directory part of a repo-root-relative path, or `""` for a root-level file. */
const directoryOf = (path: string): string => {
  const at = path.lastIndexOf("/")
  return at <= 0 ? "" : path.slice(0, at)
}

/**
 * A per-directory `index.html` for every directory holding memories, plus one for each ancestor so
 * the tree browses from the root down.
 *
 * Ancestors are included because a browser following `/projects/` with no listing there gets a 404 or
 * a server's directory index — and the repo's stated property is that it browses with no server at
 * all. An ancestor's listing shows its child directories, which is what makes the walk possible.
 */
export const generateIndexes = (rows: ReadonlyArray<PublishRow>): ReadonlyArray<GeneratedFile> => {
  const byDirectory = new Map<string, Array<PublishRow>>()
  const childDirectories = new Map<string, Set<string>>()

  const ensure = (directory: string): void => {
    if (!byDirectory.has(directory)) byDirectory.set(directory, [])
    if (!childDirectories.has(directory)) childDirectories.set(directory, new Set())
  }

  for (const row of rows) {
    const directory = directoryOf(row.path)
    ensure(directory)
    byDirectory.get(directory)?.push(row)

    // Register every ancestor, and record this directory as its parent's child.
    let current = directory
    while (current !== "") {
      const parent = directoryOf(current)
      ensure(parent)
      childDirectories.get(parent)?.add(current)
      if (parent === "") break
      current = parent
    }
  }

  return [...byDirectory.keys()].sort().map((directory) => ({
    path: directory === "" ? INDEX_FILENAME : `${directory}/${INDEX_FILENAME}`,
    html: renderIndex(
      directory,
      (byDirectory.get(directory) ?? []).sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      ),
      [...(childDirectories.get(directory) ?? [])].sort()
    )
  }))
}

/**
 * One directory listing.
 *
 * Written as a memory-shaped document — `<article>` with a `<mark>` — so the generated pages obey the
 * same closed vocabulary the corpus does and a browser renders them identically. The indexer refuses
 * them by NAME (`GENERATED_NAMES`), so a listing whose body is the titles of other memories can never
 * enter retrieval and rank the corpus's own table of contents above its content.
 */
const renderIndex = (
  directory: string,
  rows: ReadonlyArray<PublishRow>,
  children: ReadonlyArray<string>
): string => {
  const label = directory === "" ? "Memory" : directory
  const entries = rows
    .map((row) => {
      const name = row.path.slice(row.path.lastIndexOf("/") + 1)
      return (
        `<li><a href="${escapeAttribute(`/${row.path}`)}">${escapeText(row.title)}</a> ` +
        `<code>${escapeText(row.memory_type)}</code> ` +
        `<time datetime="${escapeAttribute(row.updated_at)}">${escapeText(row.updated_at)}</time>` +
        `<br><code>${escapeText(name)}</code> — ${escapeText(row.gist)}</li>`
      )
    })
    .join("\n")
  const subdirectories = children
    .map(
      (child) =>
        `<li><a href="${escapeAttribute(`/${child}/${INDEX_FILENAME}`)}">${escapeText(child)}/</a></li>`
    )
    .join("\n")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeText(label)}</title>
</head>
<body>
<article>
<p><mark>${escapeText(label)} holds ${rows.length} ${rows.length === 1 ? "memory" : "memories"}.</mark>
This listing is generated from the tree; it is not itself a memory.</p>
${subdirectories === "" ? "" : `<ul>\n${subdirectories}\n</ul>\n`}${entries === "" ? "" : `<ul>\n${entries}\n</ul>\n`}</article>
</body>
</html>
`
}

/**
 * The root `sitemap.xml`, one `<url>` per memory with `memhtml-updated` as its `<lastmod>`.
 *
 * `loc` values are repo-root-relative rather than absolute URLs. The repo has no canonical origin —
 * it is browsed from a filesystem, from a clone on another machine, and occasionally from a static
 * server — so an absolute origin would be a value the generator has to invent and every consumer has
 * to ignore.
 */
export const generateSitemap = (rows: ReadonlyArray<PublishRow>): GeneratedFile => {
  const urls = [...rows]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(
      (row) =>
        `  <url>\n    <loc>/${escapeXml(row.path)}</loc>\n    <lastmod>${escapeXml(row.updated_at)}</lastmod>\n  </url>`
    )
    .join("\n")
  return {
    path: SITEMAP_FILENAME,
    html: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
  }
}

/** Every generated artifact for a corpus. Path-ordered, so the write order is stable too. */
export const generateArtifacts = (rows: ReadonlyArray<PublishRow>): ReadonlyArray<GeneratedFile> =>
  [...generateIndexes(rows), generateSitemap(rows)].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )

/** XML text escaping. The sitemap is XML, not HTML, so it has its own five-character rule. */
const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The figures: their sources, the pages that mount them, and the SVGs the build emitted.
 *
 * Every total here is DERIVED — from the `.d2` files on disk and from the fences in the Markdown — and
 * then compared against the built output. A probe asserting `10` would pass forever after the eleventh
 * figure silently stopped rendering.
 *
 * The emitted-SVG assertions read `dist/` rather than re-running `d2`, so what they check is the
 * artifact a browser receives under exactly the flags `astro.config.ts` passes. Re-rendering here would
 * restate those flags and could agree with itself while disagreeing with the site. `@memhtml/docs#test`
 * declares a dependency on `build` in `turbo.json`, so `dist/` is present; a missing figure is a failure
 * below and never a skip.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const figureDir = join(root, "src", "content", "docs", "internals", "_figures")
const pageDir = join(root, "src", "content", "docs", "internals")
const distDir = join(root, "dist")
const repoRoot = dirname(dirname(root))

/** Every figure source, excluding the `_`-prefixed register the others import. */
const sources = readdirSync(figureDir)
  .filter((name) => name.endsWith(".d2") && !name.startsWith("_"))
  .sort()

interface Fence {
  /** The page file the fence sits in, e.g. `the-index.md`. */
  readonly page: string
  /** The `src=` value, relative to the page. */
  readonly src: string
  /** The `title=` value, which astro-d2 emits as the img's `alt`. */
  readonly title: string
  /** 0-based position among the d2 fences on its own page — what names the emitted SVG. */
  readonly offset: number
}

/**
 * Every d2 fence on every internals page, read out of the Markdown source.
 *
 * Deliberately independent of astro-d2's own parser: this is the reading a human does, so a fence the
 * integration would silently treat as untitled fails here.
 */
const fences: ReadonlyArray<Fence> = readdirSync(pageDir)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .flatMap((page) => {
    const body = readFileSync(join(pageDir, page), "utf8")
    const found: Array<Fence> = []
    for (const line of body.split("\n")) {
      if (!line.startsWith("```d2")) continue
      const src = /src="([^"]+)"/.exec(line)?.[1] ?? ""
      const title = /title="([^"]+)"/.exec(line)?.[1] ?? ""
      found.push({ page, src, title, offset: found.length })
    }
    return found
  })

/** The page's slug: `the-index.md` → `the-index`, and `index.md` → the directory itself. */
const slugOf = (fence: Fence) => basename(fence.page, ".md")

/** Where astro-d2 writes a fence's SVG: `<output>/docs/<page without extension>-<offset>.svg`. */
const svgPathFor = (fence: Fence) =>
  join(distDir, "d2", "docs", "internals", `${slugOf(fence)}-${fence.offset}.svg`)

/** Where Astro writes the page, under `trailingSlash: "always"`. */
const htmlPathFor = (fence: Fence) =>
  slugOf(fence) === "index"
    ? join(distDir, "internals", "index.html")
    : join(distDir, "internals", slugOf(fence), "index.html")

const CHANNELS = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\b/gi

/**
 * Every colour a rendered ELEMENT paints, achromatic or not.
 *
 * Scoped to paint attributes rather than to the whole file on purpose. D2 emits a static CSS preamble in
 * every theme carrying `--color-*` custom properties for its Markdown and code blocks, and unreferenced
 * `.sketch-overlay-*` rules — dead declarations that no element here uses. What matters is what the
 * drawing paints, so this reads `fill=`, `stroke=`, and the `fill:`/`stroke:` inside a `style=`.
 */
const paints = (svg: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const match of svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)) found.push(match[1] ?? "")
  for (const match of svg.matchAll(/style="([^"]*)"/g)) {
    for (const inner of (match[1] ?? "").matchAll(/(?:fill|stroke):\s*([^;"]+)/g)) {
      found.push((inner[1] ?? "").trim())
    }
  }
  return found
}

const nonAchromatic = (svg: string): ReadonlyArray<string> =>
  [...new Set(paints(svg))].filter((value) => {
    const channels = [...value.matchAll(CHANNELS)]
    return channels.some(([, r, g, b]) => !(r === g && g === b))
  })

describe("every figure source reaches exactly one page", () => {
  it("mounts each `.d2` file in exactly one fence", () => {
    const mounted = fences.map((fence) => basename(fence.src)).sort()
    expect(mounted).toEqual(sources)
  })

  it("resolves every fence's `src` to a file that exists", () => {
    for (const fence of fences) {
      expect(existsSync(join(pageDir, fence.src)), `${fence.page} → ${fence.src}`).toBe(true)
    }
  })

  it("imports the shared register in every source, so no figure invents its own palette", () => {
    for (const name of sources) {
      expect(readFileSync(join(figureDir, name), "utf8"), name).toContain("...@_register")
    }
  })
})

describe("every figure carries a real text alternative", () => {
  /*
   * astro-d2 defaults `title` to the literal string "Diagram" and emits it as the `alt`. axe accepts
   * that — a non-empty alt satisfies image-alt — so no automated audit catches it, and a blind reader
   * gets the word "Diagram". These two cases are what refuse it.
   */
  it("never falls back to astro-d2's default title", () => {
    for (const fence of fences) {
      expect(fence.title, `${fence.page}#${fence.offset}`).not.toBe("")
      expect(fence.title, `${fence.page}#${fence.offset}`).not.toBe("Diagram")
    }
  })

  it("describes the figure in sentences rather than naming it", () => {
    for (const fence of fences) {
      const where = `${fence.page}#${fence.offset}`
      // Long enough to state what is drawn and how the parts connect, which a label cannot do.
      expect(fence.title.length, where).toBeGreaterThan(120)
      expect(fence.title, where).toMatch(/[.!?]$/)
    }
  })

  it("gives every figure a numbered caption, contiguous from one within its page", () => {
    for (const page of new Set(fences.map((fence) => fence.page))) {
      const body = readFileSync(join(pageDir, page), "utf8")
      const captions = [...body.matchAll(/^\*\*Figure (\d+): /gm)].map((match) => match[1])
      const onPage = fences.filter((fence) => fence.page === page)
      expect(captions, `captions on ${page}`).toEqual(onPage.map((_, at) => `${at + 1}`))
    }
  })

  it("references every figure from the prose, not only from its own caption", () => {
    for (const page of new Set(fences.map((fence) => fence.page))) {
      const body = readFileSync(join(pageDir, page), "utf8")
      const onPage = fences.filter((fence) => fence.page === page)
      for (let at = 0; at < onPage.length; at += 1) {
        const mentions = body
          .split("\n")
          .filter((line) => line.includes(`Figure ${at + 1}`) && !line.startsWith("**Figure "))
        expect(mentions.length, `prose reference to Figure ${at + 1} on ${page}`).toBeGreaterThan(0)
      }
    }
  })
})

describe("no page writes a brace anchor, which would break the raw Markdown route", () => {
  /*
   * The generated Reference pages have their own version of this in `census.test.ts`. Authored content
   * is served through the same `starlight-md-txt` route and had no cover, so this closes it: one
   * `{ #anchor }` anywhere fails the whole raw-Markdown build, and `remark-mdx` reads the brace as a JSX
   * expression rather than as text.
   */
  it("holds for every authored page under src/content/docs", () => {
    const walk = (directory: string): ReadonlyArray<string> =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(directory, entry.name))
          : /\.mdx?$/.test(entry.name)
            ? [join(directory, entry.name)]
            : []
      )
    const pages = walk(join(root, "src", "content", "docs"))
    expect(pages.length).toBeGreaterThan(20)
    for (const page of pages) {
      expect(readFileSync(page, "utf8"), page).not.toMatch(/\{\s*#[a-z0-9-]+\s*\}/)
    }
  })
})

describe("the built figures are static monochrome SVG", () => {
  it("emits one SVG per fence", () => {
    for (const fence of fences) {
      const svg = svgPathFor(fence)
      expect(existsSync(svg), `${svg} — run \`mise run docs:build\``).toBe(true)
    }
    // Independently derived: the emitted count is the fence count, so a stale extra fails too.
    const emitted = readdirSync(join(distDir, "d2", "docs", "internals")).filter((name) =>
      name.endsWith(".svg")
    )
    expect(emitted).toHaveLength(fences.length)
  })

  it("paints no channel-unequal colour", () => {
    for (const fence of fences) {
      const svg = readFileSync(svgPathFor(fence), "utf8")
      expect(nonAchromatic(svg), `${fence.page}#${fence.offset}`).toEqual([])
    }
  })

  /*
   * Scoped to `<rect>`, where `rx` is a CORNER radius. On an `<ellipse>` the same attribute is the
   * radius itself, so an oval legitimately carries a large one — reading every `rx` in the file would
   * fail on the terminal shapes and say nothing about corners.
   */
  it("squares every rectangle's corners", () => {
    for (const fence of fences) {
      const svg = readFileSync(svgPathFor(fence), "utf8")
      const rects = [...svg.matchAll(/<rect\b[^>]*>/g)].map((match) => match[0])
      expect(rects.length, `${fence.page}#${fence.offset} rect count`).toBeGreaterThan(0)
      for (const rect of rects) {
        const radius = /\brx="([0-9.]+)"/.exec(rect)?.[1] ?? "0"
        expect(Number(radius), `${fence.page}#${fence.offset} ${rect.slice(0, 60)}`).toBe(0)
      }
    }
  })

  it("ships no script and no remote reference inside a figure", () => {
    for (const fence of fences) {
      const where = `${fence.page}#${fence.offset}`
      const svg = readFileSync(svgPathFor(fence), "utf8")
      expect(svg, where).not.toMatch(/<script/i)
      expect(svg, where).not.toMatch(/\son\w+=/i)
      // A remote RESOURCE, not the SVG namespace declaration, which is an http URI by specification.
      expect(svg, where).not.toMatch(/(?:href|src)="\s*https?:/i)
      expect(svg, where).not.toMatch(/url\(\s*['"]?https?:/i)
      expect(svg, where).not.toMatch(/<(?:image|foreignObject|iframe)\b/i)
    }
  })

  /*
   * `inline: false` is astro-d2's default and this is what keeps it. An INLINE svg would put the
   * drawing in the page's own DOM, where axe ignores it outright — an inline `<svg>` with no
   * `role="img"` is not an image to the audit, so the text alternative above would stop being checked
   * by anything at all.
   */
  it("mounts each figure as an img carrying the title as its alt", () => {
    for (const fence of fences) {
      const html = readFileSync(htmlPathFor(fence), "utf8")
      expect(html, `${fence.page} img`).toContain(`alt="${fence.title}"`)
      expect(html, `${fence.page} src`).toContain(
        `src="/memhtml/d2/docs/internals/${slugOf(fence)}-${fence.offset}.svg"`
      )
    }
  })

  it("loads no diagram runtime into the browser", () => {
    const scripts = readdirSync(join(distDir, "_astro")).filter((name) => name.endsWith(".js"))
    for (const name of scripts) {
      const source = readFileSync(join(distDir, "_astro", name), "utf8")
      for (const runtime of ["mermaid", "d2lang", "@terrastruct"]) {
        expect(source, `${name} names ${runtime}`).not.toContain(runtime)
      }
    }
  })
})

describe("the README's figures come from the same sources", () => {
  /*
   * GitHub renders Mermaid natively and D2 not at all, so the README carries the ASCII rendering of four
   * of these sources rather than a second drawing of them. The script is the single renderer; this runs
   * it in `--check` mode, which is the same posture AGENTS.md has — generated, committed, gated by a
   * test rather than by a pipeline step.
   */
  it("is in sync with the committed fenced blocks", () => {
    const run = spawnSync("node", ["scripts/readme-figures.mjs", "--check"], {
      cwd: repoRoot,
      encoding: "utf8"
    })
    expect(`${run.stdout}${run.stderr}`).not.toContain("STALE")
    expect(run.status).toBe(0)
  }, 60_000)

  it("shows a fenced figure rather than raw D2 source", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
    // The whole point: nothing GitHub cannot render.
    expect(readme).not.toContain("```d2")
    expect(readme).not.toContain("```mermaid")
    const blocks = [...readme.matchAll(/<!-- figure:([a-z-]+) -->\n```text\n/g)].map(
      (match) => match[1]
    )
    expect(blocks).toEqual(["system-topology", "three-actors", "memory-lifecycle", "sleep-branch"])
    for (const name of blocks) {
      expect(sources, `README figure ${name}`).toContain(`${name}.d2`)
    }
  })

  it("gives every README figure a caption, since an ASCII figure is opaque to a screen reader", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
    const captions = [...readme.matchAll(/^\*\*Figure (\d+): (.+)$/gm)]
    expect(captions.map((match) => match[1])).toEqual(["1", "2", "3", "4"])
    for (const [, number, text] of captions) {
      expect((text ?? "").length, `Figure ${number} caption`).toBeGreaterThan(40)
    }
  })

  /*
   * A caption AFTER the art is the RFC idiom and, on its own, the wrong reading order for a screen
   * reader: it reaches the box characters first and sounds them out. So each figure is also announced
   * before its fence, naming itself and pointing at the paragraph that carries it in words. An `<img>`
   * needs no such thing — its `alt` arrives in place — which is why this case is the README's alone.
   */
  it("announces every README figure before the art, not only after it", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
    const lines = readme.split("\n")
    const markers = lines
      .map((line, at) => ({ line, at }))
      .filter(({ line }) => /^<!-- figure:[a-z-]+ -->$/.test(line))
    expect(markers).toHaveLength(4)
    markers.forEach(({ at }, index) => {
      const before = lines.slice(Math.max(0, at - 4), at).join(" ")
      expect(before, `lead-in above figure ${index + 1}`).toContain(`Figure ${index + 1}`)
      expect(before, `screen-reader pointer above figure ${index + 1}`).toMatch(/screen reader/)
    })
  })
})

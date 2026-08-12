import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { AGENT_NOTE_CLASS, AGENT_NOTE_LABEL } from "../src/lib/agent-note.js"
import {
  DEEP_LINK_BUDGET,
  DEEP_LINK_TARGETS,
  deepLink,
  deepLinks,
  discoveryLinks,
  rawMarkdownUrl,
  referencePrompt,
  siteUrl
} from "../src/lib/agent-surface.js"

/**
 * The dead-button lock, and the checks over the built agent surface.
 *
 * The verified URL formats below are written as literals ON PURPOSE, and they are the only literals in
 * this file that are not derived from a source. They are facts about systems this repo does not
 * control, established by probing them, so a literal is the honest form — the failure they prevent is
 * a control whose href silently no longer matches its target's documented shape. Every quantity, by
 * contrast, is derived: an assertion that four controls ship is an assertion that stops being true the
 * day a fifth is added, which would report as a defect in the change rather than in the test.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, "dist")

/*
 * Several cases below read `dist/`. `turbo.json` gives `@memhtml/docs#test` a dependency on this
 * package's `build`, so the directory is present in every ordered run. Reading it is deliberate: the
 * subject of these assertions is what a browser and an agent actually receive, and a check against the
 * component's inputs would pass while the emitted href was wrong.
 */
const readDist = (relative: string): string => {
  const path = join(dist, relative)
  if (!existsSync(path)) {
    throw new Error(
      `\`dist/${relative}\` is absent — run \`pnpm --filter @memhtml/docs build\` first`
    )
  }
  return readFileSync(path, "utf8")
}

/**
 * The base segment the built site was produced with, following `astro.config.ts`'s own default.
 *
 * A fixture elsewhere in this file deliberately uses a NON-root base: base handling asserted at `/` is
 * vacuous, because every consumer of the base is a no-op there. This constant is only for reading the
 * output that was actually built.
 */
const BUILT_BASE = ((base: string) => (base.endsWith("/") ? base : `${base}/`))(
  process.env.DOCS_BASE ?? "/"
)

const CONTEXT = { site: new URL("https://memhtml.github.io"), base: "/memhtml" }

/** Every page directory Astro emitted, as the site-absolute paths a browser would request. */
const builtPages = (): ReadonlyArray<string> => {
  const walk = (directory: string, prefix: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith("_") || entry.name === "pagefind") return []
      if (entry.isDirectory()) return walk(join(directory, entry.name), `${prefix}${entry.name}/`)
      return entry.name === "index.html" ? [prefix] : []
    })
  return walk(dist, BUILT_BASE)
}

/** Every `href` in a built HTML document. */
const hrefs = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "")

describe("the deep-link format lock", () => {
  /**
   * The verified formats, probed 2026-08-12. Codex has no web prompt parameter — confirmed absent
   * rather than merely undocumented — so the absence of a Codex row is an assertion, not an omission.
   */
  const VERIFIED = new Map<string, string>([
    ["chatgpt", "https://chatgpt.com/?q="],
    ["claude", "https://claude.ai/new?q="],
    ["claude-code", "https://claude.ai/code?prompt="],
    ["cursor", "https://cursor.com/link/prompt?text="]
  ])

  const page = {
    title: "For agents",
    pageUrl: "https://memhtml.github.io/memhtml/agents/",
    markdownUrl: "https://memhtml.github.io/memhtml/agents.md"
  }

  it("ships a control for every verified target and for no other", () => {
    expect(DEEP_LINK_TARGETS.map((target) => target.id).sort()).toEqual([...VERIFIED.keys()].sort())
  })

  it("ships no Codex web control, because Codex has no web prompt parameter", () => {
    for (const target of DEEP_LINK_TARGETS) {
      expect(target.endpoint).not.toContain("codex")
      expect(target.endpoint.startsWith("https://")).toBe(true)
    }
  })

  it.each([...VERIFIED])("builds %s's href in its verified format", (id, format) => {
    const target = DEEP_LINK_TARGETS.find((candidate) => candidate.id === id)
    if (target === undefined) throw new Error(`no target \`${id}\``)
    for (const body of ["", "a short body", "x".repeat(50_000)]) {
      const link = deepLink(target, page, body)
      expect(link.href.startsWith(format)).toBe(true)
      // A format prefix with an empty payload behind it is the dead button in its purest form.
      expect(link.href.length).toBeGreaterThan(format.length)
      expect(link.href.length).toBeLessThanOrEqual(DEEP_LINK_BUDGET)
    }
  })

  it("labels every control as opening the target, never as asking it", () => {
    for (const target of DEEP_LINK_TARGETS) {
      expect(target.label.startsWith("Open in ")).toBe(true)
      expect(target.label.toLowerCase()).not.toContain("ask")
    }
  })

  it("respects a vendor ceiling that is stricter than ours", () => {
    const strict = { ...DEEP_LINK_TARGETS[0], id: "probe", vendorLimit: 400 }
    if (strict.endpoint === undefined) throw new Error("the target table is empty")
    const link = deepLink(strict as (typeof DEEP_LINK_TARGETS)[number], page, "y".repeat(5_000))
    expect(link.href.length).toBeLessThanOrEqual(400)
    expect(link.carriesContent).toBe(false)
  })

  it("carries the page's Markdown when it fits and its URL when it does not", () => {
    /*
     * Read back through `searchParams` rather than `decodeURIComponent`: a query string encodes a
     * space as `+`, which `decodeURIComponent` leaves alone, so decoding by hand would compare the
     * payload against a string it can never equal.
     */
    const payload = (link: (typeof short)[number]): string =>
      new URL(link.href).searchParams.get(link.target.parameter) ?? ""

    const short = deepLinks(page, "one small claim")
    expect(short.every((link) => link.carriesContent)).toBe(true)
    for (const link of short) expect(payload(link)).toContain("one small claim")

    const long = deepLinks(page, "z".repeat(50_000))
    expect(long.every((link) => link.carriesContent)).toBe(false)
    // The fallback is a redirection rather than a truncation: the page is still named.
    for (const link of long) {
      expect(payload(link)).toContain(page.markdownUrl)
      expect(payload(link)).not.toContain("zzzz")
    }
  })

  it("refuses to ship a truncated prompt when even the reference form overflows", () => {
    const cramped = { ...DEEP_LINK_TARGETS[0], vendorLimit: 40 }
    expect(() => deepLink(cramped as (typeof DEEP_LINK_TARGETS)[number], page, "body")).toThrow(
      /over the 40 ceiling/
    )
  })

  it("names the page in every prompt, so a prefill is never contextless", () => {
    const prompt = referencePrompt(page)
    expect(prompt).toContain(page.title)
    expect(prompt).toContain(page.markdownUrl)
    expect(prompt).toContain(page.pageUrl)
  })
})

describe("every shipped href in dist", () => {
  const targetPrefixes = DEEP_LINK_TARGETS.map(
    (target) => `${target.endpoint}${target.endpoint.includes("?") ? "&" : "?"}${target.parameter}=`
  )

  const shipped = (): ReadonlyArray<{ page: string; href: string }> =>
    builtPages().flatMap((path) =>
      hrefs(readDist(join(path.replace("/memhtml/", ""), "index.html")))
        .filter((href) => targetPrefixes.some((prefix) => href.startsWith(prefix)))
        .map((href) => ({ page: path, href }))
    )

  it("gives every built page one control per target", () => {
    const pages = builtPages()
    expect(pages.length).toBeGreaterThan(0)
    expect(shipped()).toHaveLength(pages.length * DEEP_LINK_TARGETS.length)
  })

  it("keeps every shipped href inside the budget", () => {
    for (const { page, href } of shipped()) {
      expect(href.length, `${page} exceeds the budget`).toBeLessThanOrEqual(DEEP_LINK_BUDGET)
    }
  })

  it("carries a payload behind every shipped href", () => {
    for (const { page, href } of shipped()) {
      const prefix = targetPrefixes.find((candidate) => href.startsWith(candidate)) ?? ""
      expect(href.length, `${page} has a control with an empty payload`).toBeGreaterThan(
        prefix.length
      )
    }
  })

  it("emits no protocol-relative href anywhere", () => {
    for (const path of builtPages()) {
      const document = readDist(join(path.replace(BUILT_BASE, ""), "index.html"))
      for (const href of hrefs(document)) {
        expect(href.startsWith("//"), `${path} emits a protocol-relative href`).toBe(false)
      }
    }
  })
})

describe("the head discovery block", () => {
  it("points at this page's raw route, and at both machine surfaces", () => {
    const links = discoveryLinks("learn/tutorial/install", CONTEXT)
    expect(links.map((link) => link.rel)).toEqual(["alternate", "index", "llms-full-txt"])
    for (const link of links) {
      expect(link.type).toBe("text/markdown")
      expect(new URL(link.href).origin).toBe(CONTEXT.site.origin)
      expect(link.href.startsWith("https://memhtml.github.io/memhtml/")).toBe(true)
    }
  })

  it("declares which relations are conventions and which one is ours", () => {
    const links = discoveryLinks("glossary", CONTEXT)
    const invented = links.filter((link) => link.warrant === "invention")
    expect(invented.map((link) => link.rel)).toEqual(["llms-full-txt"])
  })

  it("adds no relation that has no adopters", () => {
    const rels = discoveryLinks("glossary", CONTEXT).map((link) => link.rel)
    expect(rels).not.toContain("describedby")
  })

  it("is present on every built page, with a resolving target", () => {
    for (const path of builtPages()) {
      const document = readDist(join(path.replace(BUILT_BASE, ""), "index.html"))
      for (const rel of ["alternate", "index", "llms-full-txt"]) {
        const match = new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`).exec(document)
        expect(match, `${path} has no rel="${rel}"`).not.toBeNull()
        const href = match?.[1] ?? ""
        expect(href.startsWith("//")).toBe(false)
        const served = new URL(href).pathname.replace("/memhtml/", "")
        expect(existsSync(join(dist, served)), `${path}: ${href} resolves to nothing`).toBe(true)
      }
    }
  })
})

describe("the raw-Markdown route", () => {
  it("maps the site root to the route `starlight-md-txt` actually injects", () => {
    expect(rawMarkdownUrl("", CONTEXT).pathname).toBe("/memhtml/.md")
    expect(rawMarkdownUrl("index", CONTEXT).pathname).toBe("/memhtml/.md")
    expect(rawMarkdownUrl("reference/mcp-tools", CONTEXT).pathname).toBe(
      "/memhtml/reference/mcp-tools.md"
    )
  })

  it("keeps the base segment out of the origin, however the base is written", () => {
    for (const base of ["/memhtml", "/memhtml/"]) {
      const url = siteUrl("llms.txt", { site: CONTEXT.site, base })
      expect(url.href).toBe("https://memhtml.github.io/memhtml/llms.txt")
      // The bug this forbids: a host called `runtime`, from a base joined by concatenation.
      expect(url.href.startsWith("//")).toBe(false)
    }
  })

  it("has a twin on disk for every built page", () => {
    for (const path of builtPages()) {
      const id = path.replace("/memhtml/", "").replace(/\/$/, "")
      const twin = rawMarkdownUrl(id, CONTEXT).pathname.replace("/memhtml/", "")
      expect(existsSync(join(dist, twin)), `${path} has no \`.md\` twin at ${twin}`).toBe(true)
    }
  })
})

describe("the agent note survives into every surface", () => {
  /** Every authored page carrying a `:::agent` block, found rather than listed. */
  const authored = (): ReadonlyArray<string> => {
    const content = join(root, "src", "content", "docs")
    const walk = (directory: string, prefix: string): ReadonlyArray<string> =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) return walk(join(directory, entry.name), `${prefix}${entry.name}/`)
        if (!/\.mdx?$/.test(entry.name)) return []
        const body = readFileSync(join(directory, entry.name), "utf8")
        if (!body.includes(":::agent")) return []
        return [`${prefix}${entry.name.replace(/\.mdx?$/, "")}`]
      })
    return walk(content, "")
  }

  it("is used on the agent page and on pages where behavior genuinely differs", () => {
    const pages = authored()
    expect(pages).toContain("agents")
    // The agent page plus at least three others: a convention used once is not a convention.
    expect(pages.length).toBeGreaterThanOrEqual(4)
  })

  it("opens every block with the label, since only visible text survives the bundle", () => {
    for (const page of authored()) {
      const source = readFileSync(
        join(
          root,
          "src",
          "content",
          "docs",
          existsSync(join(root, "src", "content", "docs", `${page}.md`))
            ? `${page}.md`
            : `${page}.mdx`
        ),
        "utf8"
      )
      const blocks = source.split(":::agent").slice(1)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(block.trimStart().startsWith(`**${AGENT_NOTE_LABEL}.**`), `${page}`).toBe(true)
      }
      // A directive label would be escaped into `:::agent\[…]` on the raw route.
      expect(source).not.toMatch(/:::agent\[/)
    }
  })

  it("renders as a marked block in the HTML, not as a bare div", () => {
    for (const page of authored()) {
      const document = readDist(join(page === "index" ? "" : page, "index.html"))
      const notes = document.split(`class="${AGENT_NOTE_CLASS}"`).length - 1
      expect(notes, `${page} lost its note in the HTML`).toBeGreaterThan(0)
      expect(document).toContain(AGENT_NOTE_LABEL)
    }
  })

  it("passes verbatim into the page's `.md` twin, directive and label both", () => {
    for (const page of authored()) {
      const twin = readDist(`${page === "index" ? "" : page}.md`)
      expect(twin, `${page}.md lost the directive`).toContain(":::agent")
      expect(twin, `${page}.md lost the label`).toContain(`**${AGENT_NOTE_LABEL}.**`)
      expect(twin).not.toContain(":::agent\\[")
    }
  })

  it("reaches `llms-full.txt` with the label intact, once per authored note", () => {
    const bundle = readDist("llms-full.txt")
    const expected = authored().reduce((total, page) => {
      const source = readFileSync(
        join(
          root,
          "src",
          "content",
          "docs",
          existsSync(join(root, "src", "content", "docs", `${page}.md`))
            ? `${page}.md`
            : `${page}.mdx`
        ),
        "utf8"
      )
      return total + source.split(":::agent").length - 1
    }, 0)
    expect(expected).toBeGreaterThan(0)
    expect(bundle.split(`**${AGENT_NOTE_LABEL}.**`).length - 1).toBe(expected)
  })
})

describe("the agent page's own entry points", () => {
  it("is the first entry `llms.txt` lists", () => {
    const listed = [...readDist("llms.txt").matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map(
      (match) => match[1] ?? ""
    )
    expect(listed.length).toBeGreaterThan(1)
    expect(listed[0]).toBe(`https://memhtml.github.io${BUILT_BASE}agents.md`)
  })

  it("is reachable from the site navigation on every page", () => {
    for (const path of builtPages()) {
      const document = readDist(join(path.replace(BUILT_BASE, ""), "index.html"))
      expect(hrefs(document), `${path} cannot reach the agent page`).toContain(
        `${BUILT_BASE}agents/`
      )
    }
  })

  it("resolves every internal link it carries to a real file in dist", () => {
    /*
     * This is what makes the Reference-tier exclusion in `starlightLinksValidator` safe. The plugin
     * cannot judge a loader-injected page — it has no source file for the plugin's remark pass, so it
     * records no headings and every link into it reports invalid. This check is stricter: it resolves
     * against the bytes on disk.
     */
    const document = readDist(join("agents", "index.html"))
    /*
     * Scoped to the body: a link a reader or an agent can follow. The `<head>` carries icons and
     * machine-surface relations, which other tests in this file cover on their own terms.
     */
    const body = document.slice(document.indexOf("<body"))
    const internal = hrefs(body).filter(
      (href) => href.startsWith(BUILT_BASE) && !href.startsWith("//")
    )
    expect(internal.length).toBeGreaterThan(10)
    for (const href of internal) {
      const served = href.slice(BUILT_BASE.length).split("#")[0] ?? ""
      const candidates = [served, join(served, "index.html")]
      expect(
        candidates.some((candidate) => existsSync(join(dist, candidate))),
        `${href} resolves to nothing in dist`
      ).toBe(true)
    }
  })

  it("states no count, because a hand-written count is a lie told to the reader that trusts it", () => {
    const source = readFileSync(join(root, "src", "content", "docs", "agents.md"), "utf8")
    // A digit-led quantity in front of a noun the registries own is the failure mode.
    expect(source).not.toMatch(/\b\d+\s+(commands?|tools?|error codes?|response types?|topics?)\b/i)
  })

  it("writes no brace anchor, which would break its own raw route", () => {
    const source = readFileSync(join(root, "src", "content", "docs", "agents.md"), "utf8")
    expect(source).not.toMatch(/\{\s*#[a-z0-9-]+\s*\}/)
  })

  it("numbers its sections from one, contiguously, in the heading text", () => {
    const source = readFileSync(join(root, "src", "content", "docs", "agents.md"), "utf8")
    const headings = source.split("\n").filter((line) => line.startsWith("## "))
    expect(headings.length).toBeGreaterThan(1)
    expect(headings.map((heading) => heading.split(" ")[1])).toEqual(
      headings.map((_, at) => `${at + 1}.`)
    )
  })
})

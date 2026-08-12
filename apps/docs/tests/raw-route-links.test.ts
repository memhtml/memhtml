import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The raw `.md` routes are this site's agent surface, and their links have to resolve there rather
 * than only in the HTML twin.
 *
 * The defect these lock out was live and invisible: 450 links across the raw routes pointed at
 * `/internals/…` instead of `/memhtml/internals/…`, every one a 404 for the agent following it, while
 * the HTML was correct throughout. The two surfaces are built from different things —
 * `starlight-base-path` rewrites the rendered tree, `starlight-md-txt` builds each raw route from the
 * page's Markdown source — so a link comes out correct on whichever surface its producer touched.
 * Nothing failed. The build reported every internal link valid.
 *
 * Before that, the same seam ran the other way: the Reference loader prefixed the base into its own
 * bodies, so its raw routes were right and its HTML was `/memhtml/memhtml/reference/…` across 88
 * pages. That one was hidden by the `starlight-links-validator` exclusion the Reference tier needs for
 * an unrelated structural reason — the validator can only check a target whose headings it recorded in
 * its own remark pass, and an injected page has no file for that pass.
 *
 * So: a passing link validator is not evidence about this surface, and these assertions read the built
 * output directly.
 */

const distDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist")
const BASE = process.env.DOCS_BASE ?? "/"
const segment = BASE.endsWith("/") ? BASE : `${BASE}/`

const rawRoutes = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return rawRoutes(path)
    return entry.name.endsWith(".md") ? [path] : []
  })

const rootRelativeTargets = (body: string): ReadonlyArray<string> =>
  [...body.matchAll(/\]\((\/(?!\/)[^)]*)\)/g)].map(([, target]) => target as string)

describe("the raw Markdown routes", () => {
  const routes = rawRoutes(distDir)

  it("exist, so the rest of this file is not vacuously true", () => {
    expect(routes.length).toBeGreaterThan(80)
  })

  it("carries the base segment on every root-relative link", () => {
    const offenders = routes.flatMap((file) =>
      rootRelativeTargets(readFileSync(file, "utf8"))
        .filter((target) => !target.startsWith(segment))
        .map((target) => `${file.slice(distDir.length)} → ${target}`)
    )
    expect(offenders).toEqual([])
  })

  /*
   * At a non-root base the failure is a doubled segment — `/memhtml/memhtml/…`, which this site shipped
   * across 88 pages once. At the root base there is no segment to double, and the analogous defect is a
   * protocol-relative `//path`: a URL naming a HOST rather than a path, which is exactly what
   * concatenating an empty base onto a leading slash produces. Deno's docs ship that bug today as
   * `href="//runtime/index.md"`.
   *
   * So the assertion changes shape with the base rather than going vacuous at one of them.
   */
  it("carries it exactly once, and never as a host", () => {
    const doubled = routes.flatMap((file) => {
      const body = readFileSync(file, "utf8")
      const offenders =
        segment === "/"
          ? [...body.matchAll(/\]\((\/\/[^)]*)\)/g)].map(([, target]) => target as string)
          : rootRelativeTargets(body).filter((target) =>
              target.startsWith(`${segment}${segment.slice(1)}`)
            )
      return offenders.map((target) => `${file.slice(distDir.length)} → ${target}`)
    })
    expect(doubled).toEqual([])
  })

  it("points every internal link at something that was actually built", () => {
    const missing = routes.flatMap((file) =>
      rootRelativeTargets(readFileSync(file, "utf8"))
        .filter((target) => target.startsWith(segment) && !target.includes("#"))
        .map((target) => target.slice(segment.length))
        .filter((path) => {
          const candidate = join(distDir, path)
          const exists = (at: string) => {
            try {
              return statSync(at).isFile()
            } catch {
              return false
            }
          }
          return !(exists(candidate) || exists(join(candidate, "index.html")))
        })
        .map((path) => `${file.slice(distDir.length)} → ${segment}${path}`)
    )
    expect(missing).toEqual([])
  })
})

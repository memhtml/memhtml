import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join, resolve, sep } from "node:path"

/**
 * The built site, served from disk at the base segment it was built with.
 *
 * A browser gate needs an origin rather than a directory: `astro build` writes site-absolute URLs
 * (`/memhtml/_astro/…`), so `file://` resolves every stylesheet against the filesystem root and the
 * page renders unstyled — which would make a contrast gate measure a page nobody will ever see.
 *
 * Serving from disk rather than from `astro preview` is deliberate: the bytes under test are then
 * exactly the bytes the Pages artifact contains, and the gate needs no dev server and no network.
 */

const TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pagefind": "application/octet-stream",
  ".pf_fragment": "application/octet-stream",
  ".pf_index": "application/octet-stream",
  ".pf_meta": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".xml": "application/xml"
}

export type StaticSite = {
  readonly origin: string
  readonly close: () => Promise<void>
}

/**
 * @param root absolute path to the built output
 * @param base the site's base segment: `/` at the origin root, or `/memhtml` under a path.
 */
export const serveStatic = async (root: string, base: string): Promise<StaticSite> => {
  const distRoot = resolve(root)

  /*
   * The base with any trailing slash removed, so the root base becomes the empty string.
   *
   * Comparing against the base as written breaks at the root: `${base}/` is `//` there, which no
   * request path starts with, so every page 404s and a11y audits a 404 instead of the page. The
   * suite's own status assertion caught that rather than reporting phantom violations, which is the
   * only reason it was cheap to find.
   */
  const prefix = base.replace(/\/+$/, "")

  const locate = (rawPath: string): string | undefined => {
    if (prefix !== "" && !rawPath.startsWith(`${prefix}/`) && rawPath !== prefix) return undefined
    const withinSite = rawPath.slice(prefix.length) || "/"
    const decoded = decodeURIComponent(withinSite)
    const candidate = resolve(
      distRoot,
      `.${decoded.endsWith("/") ? `${decoded}index.html` : decoded}`
    )
    // Refuse anything that escaped the output directory rather than serving it: the gate must not
    // be able to read a file the deployed site could not.
    if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) return undefined
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    const asDirectory = join(candidate, "index.html")
    if (existsSync(asDirectory) && statSync(asDirectory).isFile()) return asDirectory
    return undefined
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const file = locate(url.pathname)
    if (file === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end(`not in the built site: ${url.pathname}\n`)
      return
    }
    const extension = file.slice(file.lastIndexOf("."))
    response.writeHead(200, { "content-type": TYPES[extension] ?? "application/octet-stream" })
    createReadStream(file).pipe(response)
  })

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("server has no port")

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done())))
  }
}

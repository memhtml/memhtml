/**
 * The code-mode helper, as it runs INSIDE the `memhtml exec` sandbox.
 *
 * Not TypeScript and not built: this file is read as BYTES by `apps/cli/src/exec.ts` and written into
 * the guest filesystem verbatim, where `js-exec` loads it under QuickJS. A `.ts` source would have to
 * survive `tsc`'s emit and land in `dist/` in a shape the guest's loader accepts, which buys nothing
 * — nothing on the host ever imports this module — and costs the one property that matters: what a
 * reader sees here is exactly what the guest executes.
 *
 * `docs/code-mode.md` is the cookbook whose recipes this serves, and the field set below is that
 * document's `Memhtml` interface. Its parser is cheerio because its runtime is bun; here the runtime is
 * QuickJS and the parser is `node-html-parser` (see {@link module:parse}), so the LIBRARY differs
 * while every selector carries over — the contract is the closed vocabulary, not the library.
 *
 * Three facts about this guest, each measured against just-bash 3.2.0 on 2026-08-09 rather than
 * assumed from Node's semantics:
 *
 * 1. **`statSync(...).isDirectory` is a boolean PROPERTY here, not a method.** Node-shaped code
 *    calling `.isDirectory()` throws "not a function". {@link isDirectory} handles both shapes, so
 *    this file also runs unchanged under Node — which is what lets a test parse the same corpus twice
 *    and compare.
 * 2. **Edge `href`s are root-absolute** (`/areas/x.html`) while a directory walk yields paths under
 *    the mount. {@link corpus} keys by the href convention for exactly this reason: the spike's first
 *    traversal reported `0/410 edges resolved`, which reads as a finding about the corpus and was
 *    entirely a normalization bug on the reading side.
 * 3. **`atob` does not exist.** QuickJS ships no base64 builtins and `node-html-parser` decodes a
 *    base64 entity table at load, so the host installs a shim through `javascript.bootstrap` before
 *    this module is ever imported. Probed: without it the parser fails at load with
 *    "'atob' is not defined".
 */

import * as fs from "node:fs"
import { parse } from "/workspace/lib/nhp.mjs"

/** Where `memhtml exec` mounts the corpus. Matches `CORPUS_MOUNT` in `apps/cli/src/exec.ts`. */
export const ROOT = "/mnt/memhtml"

/**
 * True when `path` is a directory, under either `statSync` shape.
 *
 * The QuickJS `node:fs` shim returns `isDirectory` as a boolean property while Node returns a method.
 * Both are handled so this file is one implementation rather than a guest fork of a host helper.
 */
const isDirectory = (path) => {
  const stats = fs.statSync(path)
  return typeof stats.isDirectory === "function" ? stats.isDirectory() : stats.isDirectory === true
}

/**
 * Every `.html` file under `dir`, recursively, in `readdirSync` order.
 *
 * `index.html` is skipped because it is GENERATED — `memhtml publish` writes one per directory as a
 * listing (`packages/store/src/layout.ts`), and counting them as memories inflates every census by
 * the directory count and pollutes an entity tally with link text. The fixture corpus happens to
 * contain none, so a test built only on the fixture would not catch a regression here; a real
 * `$MEMHTML_ROOT` has one per directory.
 */
export const walk = (dir = ROOT, found = []) => {
  for (const entry of fs.readdirSync(dir)) {
    const path = `${dir}/${entry}`
    if (isDirectory(path)) walk(path, found)
    else if (path.endsWith(".html") && entry !== "index.html") found.push(path)
  }
  return found
}

/** The href convention: root-absolute, so a parsed path and an edge target are the same string. */
const idFor = (path, root) => (path.startsWith(`${root}/`) ? path.slice(root.length) : path)

/** Every `content` of a repeated `meta[name=…]`, blanks dropped. */
const metaValues = (document, name) =>
  document
    .querySelectorAll(`meta[name="${name}"]`)
    .map((element) => element.getAttribute("content") ?? "")
    .filter((value) => value !== "")

/**
 * One memory, read to the planes the closed vocabulary guarantees.
 *
 * `claim` uses `article mark`, a DESCENDANT selector. The markup is `<article><p><mark>`
 * (`docs/code-mode.md`), so `article > mark` matches NOTHING — a helper written from ROADMAP item 7's
 * prose, which says `article > mark`, silently reports zero claims on every file. Measured on the
 * 305-file fixture: `article mark` finds 305, `article > mark` finds 0.
 *
 * `document` is returned as an escape hatch. Every field here is a projection the cookbook's recipes
 * needed, and a question none of them covers is answerable with the same parser rather than by
 * editing this file — which is the whole reason code-mode exists instead of a fixed tool per question.
 */
export const memoryAt = (path, root = ROOT) => {
  const document = parse(fs.readFileSync(path, "utf8"))
  const facets = {}
  for (const term of document.querySelectorAll("article dl dt")) {
    const key = term.text.trim()
    const definition = term.nextElementSibling
    if (key !== "" && definition !== null && definition.rawTagName === "dd") {
      facets[key] = definition.text.trim()
    }
  }
  return {
    /** Root-absolute, the id an edge `href` names. */
    path: idFor(path, root),
    /** Where the file is in the guest, for a re-read that bypasses these fields. */
    file: path,
    title: document.querySelector("title")?.text.trim() ?? "",
    memoryType: metaValues(document, "memhtml-type")[0] ?? "",
    status: metaValues(document, "memhtml-status")[0] ?? "",
    claim: document.querySelector("article mark")?.text.trim() ?? "",
    tags: metaValues(document, "memhtml-tag"),
    entities: metaValues(document, "memhtml-entity"),
    links: document.querySelectorAll('link[rel^="memhtml-"]').map((element) => ({
      rel: element.getAttribute("rel") ?? "",
      href: element.getAttribute("href") ?? ""
    })),
    facets,
    citations: document.querySelectorAll("article cite").map((element) => element.text.trim()),
    eventAt: document.querySelector("article time[datetime]")?.getAttribute("datetime") ?? null,
    document
  }
}

/** Every memory under `root`, keyed by the root-absolute path an edge `href` names. */
export const corpus = (root = ROOT) => {
  const byPath = new Map()
  for (const path of walk(root)) {
    const memory = memoryAt(path, root)
    byPath.set(memory.path, memory)
  }
  return byPath
}

/** The authored edge set reversed: for each target path, who points at it and with which rel. */
export const backlinks = (memories) => {
  const incoming = new Map()
  for (const memory of memories.values()) {
    for (const link of memory.links) {
      const existing = incoming.get(link.href)
      if (existing === undefined) incoming.set(link.href, [{ from: memory.path, rel: link.rel }])
      else existing.push({ from: memory.path, rel: link.rel })
    }
  }
  return incoming
}

/**
 * Follow one rel from `start` to exhaustion: a supersedence chain, a part-of ancestry.
 *
 * The cycle guard is a membership test on the path travelled, not a hop cap: an authored edge set can
 * be cyclic (nothing in the format forbids `A memhtml-supersedes B memhtml-supersedes A`) and a capped walk
 * would return a truncated chain that looks like a real one. The returned array always starts at
 * `start`, including when `start` is absent from `memories` — a caller comparing lengths needs the
 * one-element case to mean "no chain" rather than "unknown".
 */
export const chain = (memories, start, rel) => {
  const travelled = []
  let at = start
  while (at !== undefined && at !== null && !travelled.includes(at)) {
    travelled.push(at)
    at = memories.get(at)?.links.find((link) => link.rel === rel)?.href
  }
  return travelled
}

/**
 * Every edge, split by whether its target is a file in this corpus.
 *
 * Present as a helper rather than left to each script because the resolution RATE is the number that
 * catches a normalization bug: `dangling` counting every edge reads as "the corpus has no valid
 * edges", which is a plausible-looking finding and was in fact a bug in the reader. A script that
 * reports `resolved` beside a total it derived independently cannot make that mistake quietly.
 */
export const edges = (memories) => {
  const resolved = []
  const dangling = []
  for (const memory of memories.values()) {
    for (const link of memory.links) {
      const edge = { from: memory.path, rel: link.rel, href: link.href }
      if (memories.has(link.href)) resolved.push(edge)
      else dangling.push(edge)
    }
  }
  return { resolved, dangling }
}

/**
 * What the built site is allowed to contain, and which pages the browser gates audit.
 *
 * Both lists are declared here and nowhere else. `tests/built-site.test.ts` reads them against
 * `dist/`, `tests/a11y.test.ts` drives a browser over them, and a case in the first asserts that
 * `lighthouserc.json` — which is JSON and cannot import this file — names the same pages.
 */

/**
 * Tokens that must never reach a public page. This repository is public and this site's prose was
 * migrated from prose that was not, so the failure mode is a private name surviving an edit that
 * looked cosmetic.
 *
 * `pattern` is matched case-insensitively against the raw bytes of every built artifact. Adding a
 * term is one entry; `why` is printed with the failure so whoever hits it knows what leaked rather
 * than only that something did.
 */
export const DENYLIST: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  {
    pattern: /memhtml-evals/i,
    why: "a private sibling repository — naming it publishes its existence and its URL"
  },
  {
    pattern: /\.erpaval/i,
    why: "the prior-session lessons directory: internal methodology, not documentation"
  },
  {
    pattern: /docs\/backlog\.md/i,
    why: "the internal fine-grained ledger; the public roadmap is ROADMAP.md"
  },
  {
    pattern: /\bT-AC-\d+-\d+\b/i,
    why: "an internal task id — meaningless to a reader and a pointer into a private tracker"
  },
  {
    pattern: /\.sarif\b/i,
    why: "scanner output; the findings are private even when the scanner is not"
  },
  {
    pattern: /\bTurso\b/i,
    why: "wrong on its face: the index is SQLite through node:sqlite, with no hosted service"
  }
]

/**
 * `BASE` with a guaranteed trailing slash.
 *
 * Exported because every consumer that treats the base as a prefix needs it. Joining or slicing with
 * the bare `BASE` is correct under `/memhtml` and wrong at the root, where `${BASE}/` is `//` and
 * `BASE.length + 1` eats the first character of the path — three separate places in this repo shipped
 * that bug, each looking right against the base it was written for.
 */
export const BASE_SEGMENT = (process.env.DOCS_BASE ?? "/").replace(/\/*$/, "/")

/**
 * The pages the browser gates audit, as site-absolute paths including the base segment.
 *
 * Four, on purpose. The corpus is 93 pages and grows with every commit, so a gate that walked it
 * would get slower for the rest of the project's life and be deleted the first time it cost someone
 * ten minutes. These four are the distinct *templates* — every other page is one of them with
 * different prose:
 *
 * - `/` is the landing page, the only one built from MDX and the only one with a hero.
 * - the tutorial page is authored Markdown: prose, an aside, and package-manager tabs.
 * - the RRF-arms page is a generated virtual page — no file on disk, assembled by a loader.
 * - the memory-file-format page is the heaviest body: long code blocks with line numbers and
 *   collapsible sections, which is where a contrast or focus regression in the code theme shows up.
 *
 * `tests/built-site.test.ts` proves the sample is representative for the one property where a
 * four-page sample could silently under-report: every distinct inline `<svg>` the whole site emits
 * appears on one of these four.
 */
export const AUDITED_PAGES: ReadonlyArray<string> = [
  `${BASE_SEGMENT}`,
  `${BASE_SEGMENT}learn/tutorial/first-memory/`,
  `${BASE_SEGMENT}reference/rrf-arms/`,
  `${BASE_SEGMENT}internals/the-memory-file-format/`
]

/**
 * WCAG 2.2 AA violations this site ships today, each one owned somewhere this gate cannot reach.
 *
 * A baseline is a ratchet, not an exemption, and `tests/a11y.test.ts` enforces it in both
 * directions: a violation outside this list fails, and an entry here that no longer fires fails too,
 * so a fix cannot leave a suppression behind to hide the next defect.
 *
 * `signature` is what keeps an entry from widening into a licence for its whole rule. It is matched
 * against each violating node's markup followed by the failure summary, and every node has to be
 * claimed by some entry, so a third contrast defect in a third colour — or a scrollable `<div>`
 * rather than the two element types recorded here — is a failure even though the rule id is listed.
 * A rule may therefore appear more than once: two independent contrast defects with two owners are
 * two entries, and the ratchet holds each of them separately.
 */
export const KNOWN_A11Y_FAILURES: ReadonlyArray<{
  readonly rule: string
  readonly criterion: string
  readonly signature: RegExp
  readonly owner: string
  readonly why: string
}> = [
  {
    rule: "label-content-name-mismatch",
    criterion: "SC 2.5.3 Label in Name",
    signature: /data-open-modal/,
    owner: "@astrojs/starlight",
    why:
      "Starlight's search button renders `Search` beside a `Ctrl` `K` shortcut hint but names " +
      "itself `Search`, so its accessible name does not contain its visible text. The markup is " +
      "the theme's own component, so fixing it means shadowing that component rather than editing " +
      "content or a token — the only entry here whose owner is genuinely upstream."
  }
]

/** Where `astro build` writes, relative to the package root. */
export const DIST_DIR = "dist"

/**
 * The Cumulative Layout Shift a page may not reach, in CLS units (unitless, per-page, 0 is perfect).
 *
 * 0.1 is the Core Web Vitals "good" boundary rather than a number chosen to fit this site: every
 * audited page measures 0 today (`tests/layout-stability.test.ts`), so the headroom is not budget
 * anyone is spending. It lives here, beside the page list, because the probe that enforces it and
 * the case in `tests/built-site.test.ts` that keeps `lighthouserc.json` honest both need the same
 * number, and Lighthouse's own CLS reading is the one this repo does NOT gate on — see that probe's
 * header for the measurement that decided it.
 */
export const LAYOUT_SHIFT_CEILING = 0.1

/**
 * The one layout shift this site ships today, declared so every OTHER shift still fails.
 *
 * Starlight emits the right sidebar BEFORE `<main>` and moves it into place with `order: 2`, so a
 * host slow enough to paint before `<main>` is parsed paints the aside as the row's only flex item.
 * Measured on a 4-vCPU CI runner and reproduced locally under an 8x CPU throttle, identically both
 * times: `div.right-sidebar` at `300,0 1050x940` becoming `1050,0 300x940` at ~230-330ms, CLS 0.432.
 * It is invisible on a fast machine, which is exactly why it needs to be written down rather than
 * remembered.
 *
 * **This entry is a bound, not a licence.** `node` has to match the shift's own source element and
 * `most` caps how far it may move, so the same element shifting further fails, and any other element
 * shifting at all fails. What it deliberately does NOT do is assert that the shift still fires — that
 * half of the `KNOWN_A11Y_FAILURES` ratchet cannot hold here, because whether the race is lost
 * depends on the host: the shift fires on CI and not on a developer's laptop. Deleting the entry is
 * therefore how it retires, and `docs/backlog.md` carries the fix that would let it go: give the
 * sidebar column a reserved track so the incomplete-DOM paint puts it where the finished one does.
 */
export const KNOWN_LAYOUT_SHIFTS: ReadonlyArray<{
  readonly node: string
  readonly most: number
  readonly why: string
}> = [
  {
    node: "div.right-sidebar",
    most: 0.5,
    why:
      "Starlight paints its table-of-contents aside before `<main>` exists on a slow host, then " +
      "moves it into place — source order plus `order: 2`, owned upstream"
  }
]

/**
 * The base segment `astro.config.ts` builds under, following its own default. Every asset URL in the
 * output is prefixed with it, so anything serving `dist/` has to mount it here rather than elsewhere —
 * a site served one segment too high loads its HTML and none of its CSS, which reads as a catastrophic
 * regression in every gate at once rather than as a misconfigured harness.
 */
export const BASE = process.env.DOCS_BASE ?? "/"

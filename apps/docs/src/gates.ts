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
  "/memhtml/",
  "/memhtml/learn/tutorial/first-memory/",
  "/memhtml/reference/rrf-arms/",
  "/memhtml/internals/the-memory-file-format/"
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
    rule: "color-contrast",
    criterion: "SC 1.4.3 Contrast (Minimum)",
    signature: /#8da9ff/i,
    owner: "src/styles/rfc.css",
    why:
      'the light theme paints links with the dark theme\'s accent. `:root[data-theme="light"]` ' +
      "sets `--sl-color-text-accent: var(--memhtml-link)`, and the block selected by " +
      '`:root, :root[data-theme="dark"]` redefines `--memhtml-link: #8da9ff` at the same ' +
      "specificity but later in the file, so the indirection resolves to the dark value on warm " +
      "paper: 2.19:1 against a required 4.5:1. Restating the three `--memhtml-*` primitives inside " +
      "the light block fixes every reported node at once."
  },
  {
    rule: "color-contrast",
    criterion: "SC 1.4.3 Contrast (Minimum)",
    signature: /#788b94/i,
    owner: "@expressive-code/plugin-line-numbers",
    why:
      "the line-number gutter draws #788b94 on the code block's #f6f7f9 — 3.3:1 where 4.5:1 is " +
      "required. Both colours come from Expressive Code's own light theme rather than from this " +
      "site, so the fix is a darker gutter colour in the `expressiveCode` styleOverrides."
  },
  {
    rule: "label-content-name-mismatch",
    criterion: "SC 2.5.3 Label in Name",
    signature: /data-open-modal/,
    owner: "@astrojs/starlight",
    why:
      "Starlight's search button renders `Search` beside a `Ctrl` `K` shortcut hint but names " +
      "itself `Search`, so its accessible name does not contain its visible text. The markup is " +
      "the theme's own component; changing it means overriding the component, not editing content."
  },
  {
    rule: "scrollable-region-focusable",
    criterion: "SC 2.1.1 Keyboard",
    signature: /^<(pre|table)[\s>]/,
    owner: "@expressive-code and @astrojs/starlight",
    why:
      "a code block and a wide table both scroll horizontally and neither is keyboard focusable, so " +
      "the overflowing half is reachable with a pointer and unreachable with a keyboard. Both " +
      "elements are rendered by their plugin — Expressive Code owns the `<pre>`, Starlight's " +
      'Markdown renderer owns the `<table>` — so the fix is `tabindex="0"` in those renderers.'
  }
]

/** Where `astro build` writes, relative to the package root. */
export const DIST_DIR = "dist"

/**
 * The base segment `astro.config.ts` builds under. Every asset URL in the output is prefixed with
 * it, so anything serving `dist/` has to mount it here rather than at the root — a site served one
 * segment too high loads its HTML and none of its CSS, which reads as a catastrophic regression in
 * every gate at once.
 */
export const BASE = "/memhtml"

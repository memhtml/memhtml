/**
 * What the built site is allowed to contain, and which pages the browser gates audit.
 *
 * Both lists are declared here and nowhere else. `tests/built-site.test.ts` reads them against
 * `dist/`, and `tests/a11y.test.ts` and `tests/layout-stability.test.ts` drive a browser over them.
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
    pattern: /external-evals/i,
    why: "a private sibling repository — naming it publishes its existence and its URL"
  },
  {
    pattern: /\.lessons/i,
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
 * Terms that must never reach a public page and must not be written into this repository either:
 * people's names, and the names of private systems, repositories, and directories.
 *
 * {@link DENYLIST} names what it guards, which is fine for a scanner's file suffix and wrong for a
 * person's name, because the gate's own source is public. So each term here is held as the SHA-256 of
 * its normalized form: lowercased, with everything but ASCII letters and digits removed. A digest
 * keeps the term out of the tree's text and out of a search over it. It doesn't make the term secret,
 * since a short name is easy to guess and check, and it isn't meant to.
 *
 * `tests/built-site.test.ts` splits every built surface into lowercase runs of letters and digits and
 * hashes each run, and each pair of runs joined by one `-`, `_`, or space with that separator
 * removed. A term therefore matches as a whole word in any case and in `kebab-case`, `snake_case`, or
 * as two words, and never as part of a longer word. A failure prints the file and line, never the
 * term.
 *
 * To add a term, append its digest with a `why` that says what kind of thing it is without naming it:
 *
 * ```sh
 * printf %s 'The Term' | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]' | sha256sum
 * ```
 *
 * `tests/denied-terms.test.ts` checks the matcher against a placeholder term, and that every entry
 * here is a well-formed digest listed once.
 */
export const DENIED_TERMS: ReadonlyArray<{ readonly digest: string; readonly why: string }> = [
  {
    digest: "06c20e3fb0d261208540c9ded490d91c9e8e070e701f0f706dd70e94bad55cda",
    why: "a person's name"
  },
  {
    digest: "271e94cfcd262c77c7a40c49e0ff132acfa7d8de088ac0077fcdac5d60ada9c2",
    why: "a person's login, which also names their home directory"
  },
  {
    digest: "3431f67b1c3a2caa558fd24fc37b02659abcccb614370bbb0cd9e93a64e4c0f1",
    why: "a person's name"
  },
  {
    digest: "21749f1628aa21d31e1b225048909f410a3335192abf7c1558836fbbb6310328",
    why: "a private agent fleet, and the directories named after it"
  },
  {
    digest: "9ac4bde162a7672fd4ab2d0065287baa69607c782892a53d8e6bd2328da3e5da",
    why: "a private agent runtime"
  },
  {
    digest: "c2fe160fcb644b2f7f3dd68522a5a2516e2356143ea77f0a45617791f3ac10fb",
    why: "a private project"
  },
  {
    digest: "155fc49c04765c9f2b82f27d20c343d2e1bc615b04df50bc17e5d2e64176b57b",
    why: "a private model-routing service"
  },
  {
    digest: "56e57ada05a8887e0a051408ae8950a8e1c9b1674dee493591de94bf4d3e2dde",
    why: "a private gateway a reader can't reach"
  },
  {
    digest: "8758607d0bcaa8a6efc8f92aa63bf367a6f088001d8fd2f16d1583c356a1a23f",
    why: "an internal account system"
  },
  {
    digest: "2a0abe451aede7f7139e3b7be00c2adff97b5ef4a50c6b5f4a2165125b55cc15",
    why: "an internal sign-on system"
  },
  {
    digest: "9344cf2501b9a9bc0bb18ad4d09afd7873b2eea038f691e9a4669c54f2f37325",
    why: "the private sibling repository whose placeholder DENYLIST guards"
  },
  {
    digest: "ea7f0f5d622fee8408f61974dc51225c40ab9830eafff1e2acf86d48b519b2a3",
    why: "the prior-session lessons directory whose placeholder DENYLIST guards"
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
 * `signature` is what keeps an entry from widening into a license for its whole rule. It is matched
 * against each violating node's markup followed by the failure summary, and every node has to be
 * claimed by some entry, so a third contrast defect in a third color — or a scrollable `<div>`
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
 * anyone is spending. It lives here, beside the page list the probe walks, so the pages and the
 * ceiling they are held to are declared in one place; see that probe's header for the measurement
 * that decided to gate layout stability with a fixed viewport rather than a Lighthouse reading.
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
 * **This entry is a bound, not a license.** `node` has to match the shift's own source element and
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

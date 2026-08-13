/**
 * Fence language auto-detection: a PORT of the measured detector, not a fresh design.
 *
 * An unlabeled fence carries no language, so `data-lang` is absent and the snippet reaches no
 * `lang:` entity. A detector can propose one, and wrong metadata costs more than none, so what
 * ships here is exactly the implementation an eval measured, at a threshold that eval chose.
 *
 * PROVENANCE. `memhtml-evals` (`results/detector-eval-2026-08-04.json`) swept two candidates,
 * `flourite` and highlight.js `highlightAuto`, over a 332-snippet corpus of real fences and file
 * slices, and picked the operating point where MEASURED precision first reaches the 95% floor:
 *
 *     winner    highlight.js
 *     threshold 0.28685957116771854   precision 95.18%   coverage 25.0%
 *
 * flourite reached 100% precision at only 3.0% coverage, abstaining where this one stamps.
 * {@link DEPLOY_THRESHOLD} is 0.30, a conservative rounding UP of the measured point. Confidence
 * is monotone in evidence, so raising the threshold only drops marginal stamps and adds none.
 * Re-measured at 0.30 on the same corpus: 81 stamped, 77 correct, precision 95.06%, coverage
 * 24.4%. Both numbers are recorded because the measured one is the evidence and the deployed one
 * is the decision.
 *
 * DETERMINISM. highlight.js is pinned EXACTLY (`11.11.1`, no caret) in this package's
 * `package.json`, because relevance scores are grammar-dependent: a version bump silently moves
 * every confidence, and therefore which fences get stamped. The contract is "same input + same
 * pinned version → same stamp". A bump is a deliberate decision that RE-RUNS the eval and
 * re-derives the threshold, not a routine dependency refresh.
 *
 * WRITE TIME ONLY. Detection runs on the write path and the result is stamped into the file, which
 * is the system of record. Index rebuild reads `data-lang` back (`parse.ts`) and never re-detects,
 * so `rm index.db && rebuild` is a pure function of the tree. A detector at index time would make
 * rebuild output depend on the installed hljs version, breaking rebuildability. The indexer package
 * reaches this module not at all, and a grep lock in `tests/detect.test.ts` keeps it that way.
 *
 * AUTHOR STRINGS ARE UNTOUCHED. This vocabulary gates DETECTOR output only. A fence whose info
 * string names a language keeps that author's token verbatim through the existing `LANG_TOKEN`
 * grammar (`fences.ts`), canonical or not, so `js`, `c++`, and `objective-c` all
 * still reach `data-lang`. The author knows the language; the detector only guesses at it.
 */
import { createRequire } from "node:module"

import type { HLJSApi } from "highlight.js"

/**
 * highlight.js loads lazily on the FIRST detection, not at module load. Eagerly imported, its 192
 * grammars cost ~100ms and ~12MB in every process that touches the format layer, including the
 * read path (indexer, retrieval), which detects nothing (quality review 2026-08-07).
 * `createRequire` keeps `detect` synchronous where a dynamic `import()` would force async through
 * `articleHtmlFor`. The pinned-version determinism contract is unchanged: same input, same build,
 * same stamp. Only WHEN the module loads moves.
 */
const requireModule = createRequire(import.meta.url)
let hljsInstance: HLJSApi | undefined
const hljsLazy = (): HLJSApi => {
  if (hljsInstance === undefined) {
    // hljs ships CJS: require() hands back the API object itself (probed on the pinned build;
    // `default` also exists and points at the same object, so take the direct shape).
    hljsInstance = requireModule("highlight.js") as HLJSApi
  }
  return hljsInstance
}

/**
 * The languages a DETECTION may name. One canonical lowercase token each, because `data-lang`
 * promotes to a `lang:` entity by exact string match, so two spellings of TypeScript would be
 * two entities. Anything outside this list is "do not stamp".
 */
export const CANONICAL_LANGS = [
  "typescript",
  "javascript",
  "python",
  "bash",
  "json",
  "sql",
  "yaml",
  "html",
  "toml",
  "css",
  "go",
  "rust"
] as const

export type CanonicalLang = (typeof CANONICAL_LANGS)[number]

/**
 * Aliases seen in detector output, real info strings, and file extensions.
 *
 * `xml -> html` because highlight.js names its HTML grammar "xml", and `ini -> toml` because it
 * ships no TOML grammar and documents its ini grammar as "TOML, also INI". SQL dialects collapse
 * because a dialect distinction is noise at `lang:` entity granularity, and collapsing them is
 * also what makes the runner-up rule below work: `pgsql` beating `n1ql` is not disagreement.
 */
const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  shellsession: "bash",
  console: "bash",
  yml: "yaml",
  pgsql: "sql",
  plpgsql: "sql",
  mysql: "sql",
  sqlite: "sql",
  tsql: "sql",
  n1ql: "sql",
  xml: "html",
  xhtml: "html",
  ini: "toml",
  golang: "go",
  rs: "rust"
}

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_LANGS)

/** Canonical token for a raw language name, or `undefined` when it is outside the vocabulary. */
export const normalizeLang = (raw: string): CanonicalLang | undefined => {
  const lower = raw.trim().toLowerCase()
  const mapped = ALIASES[lower] ?? lower
  return CANONICAL_SET.has(mapped) ? (mapped as CanonicalLang) : undefined
}

/**
 * The confidence at or above which a detection is stamped: 0.30.
 *
 * See the module header for provenance. This is the measured 0.28685957116771854 rounded in the
 * safe direction, not a guess and not a round number chosen for looking tidy.
 */
export const DEPLOY_THRESHOLD = 0.3

/**
 * Fences longer than this abstain without running hljs: 4096 characters.
 *
 * `highlightAuto` runs all 192 grammars synchronously and its cost is super-linear in input
 * size. Measured on the pinned build: 5KB ≈ 450ms, 10KB ≈ 1.4s, 40KB ≈ 20s, 100KB ≈ 122s of
 * blocking CPU. The MCP server is one single-threaded process and the body param is unbounded,
 * so an uncapped detector lets one large unlabeled fence wedge every other request
 * (security review 2026-08-07). Abstention is the same fail-closed value as an out-of-vocabulary
 * detection, costs no eval re-derivation (unlike a prefix slice, which changes the per-line
 * normalization the threshold was measured against), and loses nothing the eval valued: the
 * measured corpus tops out far below this ceiling. At 4096 chars the worst-case detector cost
 * is well under a second.
 */
export const DETECT_MAX_CHARS = 4096

/** What the detector concluded, threshold not yet applied. Exported for tests and for the sweep. */
export interface Detection {
  /** Canonical language, or `undefined` when hljs abstained or named a language outside the vocabulary. */
  readonly lang: CanonicalLang | undefined
  /** Monotone evidence score in [0, 1). NOT a calibrated probability, and meaningful only against {@link DEPLOY_THRESHOLD}. */
  readonly confidence: number
}

/** Saturating map from a per-line margin in [0, ∞) to [0, 1). Monotone, with no clipping. */
const saturate = (marginPerLine: number): number => 1 - Math.exp(-Math.max(0, marginPerLine))

/**
 * hljs's own evidence, squeezed into the sweepable scalar the eval calibrated.
 *
 * `confidence = 1 - exp(-(top - runnerUp) / lines)`, the per-line evidence MARGIN between the
 * best language and its closest REAL competitor. Two refinements carry their weight, and a grid
 * search over the alternatives (relative margin, top score alone, saturating absolute margin) put
 * all of them at ≤9% coverage against this shape's 25%:
 *
 *  - Canonical-aware runner-up: when the runner-up normalizes to the SAME token as the winner
 *    (`pgsql` vs `n1ql`, `xml` vs `xhtml`), the margin is the FULL top score. A dialect duel is
 *    not disagreement about what to stamp, and charging it as one would abstain on the cases the
 *    detector is most right about.
 *  - Per-line normalization: absolute relevance grows with snippet length, so a raw margin
 *    conflates "confident" with "long". Margin per line does not.
 *
 * hljs runs its FULL grammar set deliberately. Restricting `highlightAuto` to the 12-name
 * vocabulary measured 0.9% coverage against 25% at the precision floor: with the true language's
 * grammar absent, a runner-up wins unopposed and wins CONFIDENTLY, so the false positives land
 * exactly where the threshold cannot see them.
 */
export const detect = (code: string): Detection => {
  if (code.length > DETECT_MAX_CHARS) return { lang: undefined, confidence: 0 }
  const result = hljsLazy().highlightAuto(code)
  if (result.language === undefined || result.relevance <= 0) {
    return { lang: undefined, confidence: 0 }
  }
  const lang = normalizeLang(result.language)
  const secondLang = result.secondBest?.language
  const sameCanonical =
    lang !== undefined && secondLang !== undefined && normalizeLang(secondLang) === lang
  const second = sameCanonical ? 0 : (result.secondBest?.relevance ?? 0)
  const lines = code.split("\n").length
  return { lang, confidence: saturate((result.relevance - second) / Math.max(1, lines)) }
}

/**
 * The canonical language to stamp on an unlabeled fence, or `undefined` to stamp nothing.
 *
 * Both gates are independent and both must pass: the detection must be IN the vocabulary, and its
 * confidence must reach {@link DEPLOY_THRESHOLD}. A confident detection of a language outside the
 * vocabulary is still `undefined`. Measured on the corpus, hljs names `smali` at confidence 0.86
 * and `autohotkey` at 0.55 for snippets that are really bash and TypeScript. Confidence says only
 * "this grammar won by a wide margin", never "this grammar is one we stamp".
 *
 * Pure and synchronous: hljs is synchronous, so the write path calls this inline with no Effect.
 */
export const detectLang = (code: string): CanonicalLang | undefined => {
  const { lang, confidence } = detect(code)
  return lang !== undefined && confidence >= DEPLOY_THRESHOLD ? lang : undefined
}

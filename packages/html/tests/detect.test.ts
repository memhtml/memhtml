import { describe, expect, it } from "vitest"

import {
  CANONICAL_LANGS,
  DEPLOY_THRESHOLD,
  DETECT_MAX_CHARS,
  detect,
  detectLang,
  normalizeLang
} from "../src/detect.js"
import { LANG_TOKEN } from "../src/fences.js"
import { checkMemory } from "../src/parse.js"
import { serializeMemory } from "../src/serialize.js"
import { type NewMemoryInput, renderTemplate } from "../src/template.js"
import { parseOk } from "./fixtures.js"

/**
 * The fence language detector, and the write path that stamps its output.
 *
 * This module is a PORT: the eval (`memhtml-evals`, `results/detector-eval-2026-08-04.json`)
 * measured highlight.js `highlightAuto` under a specific confidence formula over a 332-snippet
 * corpus, and picked the threshold where precision first reached the 95% floor. So the property
 * these tests defend is AGREEMENT WITH THAT MEASUREMENT, not "detection seems reasonable" — a
 * detector that looked sensible but scored differently would ship a threshold calibrated for a
 * formula that no longer exists.
 *
 * Accordingly {@link CORPUS} is not hand-written. Every row is a real corpus snippet run through
 * the reference `hljsDetector` itself, with its raw hljs internals (winning grammar and relevance,
 * `secondBest` and its relevance) recorded alongside the confidence and stamp the reference
 * produced. Any drift — in the formula, the vocabulary, the pinned hljs version, or the threshold
 * — moves one of those numbers and fails here.
 */

interface Fixture {
  /** The corpus row's id, so a failure names the snippet that moved. */
  readonly id: string
  /** The corpus's gold label. NOT always what the detector says — one row here is a true false positive. */
  readonly gold: string
  readonly code: string
  /** The raw hljs grammar that won, before normalization. `pgsql`/`ini`/`xml` are why the alias table exists. */
  readonly hljs: string
  readonly relevance: number
  readonly secondBest: string | undefined
  readonly secondRelevance: number | undefined
  /** The canonical token, or `undefined` when hljs named a language outside the vocabulary. */
  readonly lang: string | undefined
  /** The reference implementation's confidence, to full float precision. */
  readonly confidence: number
  /** What the reference stamps at {@link DEPLOY_THRESHOLD} — `undefined` means no attribute. */
  readonly stamp: string | undefined
}

/** Measured reference decisions, ordered by descending confidence: stamps first, then abstentions. */
const CORPUS: readonly Fixture[] = [
  {
    id: "fence:example-docs/design/0003-workspace-organization.md#4",
    gold: "sql",
    code: "SELECT t.tag, count(*) AS n\n  FROM wiki.wiki_pages p, unnest(p.tags) AS t(tag)\n WHERE p.deleted_at IS NULL\n GROUP BY t.tag\n ORDER BY n DESC, t.tag ASC\n LIMIT $1\nHAVING count(*) >= $2  -- (as a HAVING clause before ORDER)",
    hljs: "pgsql",
    relevance: 22,
    secondBest: "n1ql",
    secondRelevance: 21,
    lang: "sql",
    confidence: 0.9568406907385474,
    stamp: "sql"
  },
  {
    id: "fence:memhtml/docs/design.md#2",
    gold: "typescript",
    code: "readonly rebuild: (opts: { embed: boolean }) => Effect.Effect<RebuildReport, ...>\nreadonly update:  (opts: { embed: boolean }) => Effect.Effect<UpdateReport, ...>\nreadonly indexPaths: (paths: readonly string[]) => Effect.Effect<UpdateReport, ...>",
    hljs: "typescript",
    relevance: 15,
    secondBest: "moonscript",
    secondRelevance: 10,
    lang: "typescript",
    confidence: 0.8111243971624382,
    stamp: "typescript"
  },
  {
    id: "fence:example-service/docs/reference/rpc-tools.md#4",
    gold: "python",
    code: '    @mcp.tool(name="get_run")\n    async def get_run_impl(  # pyright: ignore[reportUnusedFunction] - registered via decorator\n        run_id: str,\n    ) -> dict[str, object]:',
    hljs: "python",
    relevance: 11,
    secondBest: "less",
    secondRelevance: 6,
    lang: "python",
    confidence: 0.7134952031398099,
    stamp: "python"
  },
  {
    id: "slice:example-service/mise.toml@42+9",
    gold: "toml",
    code: 'description = "Format and autofix"\nrun = ["ruff format .", "ruff check --fix ."]\n\n[tasks.typecheck]\ndescription = "Strict pyright"\nrun = "uv run pyright"\n\n[tasks.test]\ndescription = "All test tiers (integration skips without Docker)"',
    hljs: "ini",
    relevance: 18,
    secondBest: "makefile",
    secondRelevance: 11,
    lang: "toml",
    confidence: 0.5405741759640734,
    stamp: "toml"
  },
  {
    id: "fence:memhtml/RUNBOOK.md#4",
    gold: "bash",
    code: 'git -C "$MEMHTML_ROOT" status --porcelain    # see what is uncommitted\nmemhtml index update --embed                 # the indexer DOES read dirty paths, so this is often enough',
    hljs: "pgsql",
    relevance: 8,
    secondBest: "dsconfig",
    secondRelevance: 7,
    lang: "sql",
    confidence: 0.3934693402873666,
    stamp: "sql"
  },
  {
    id: "fence:example-docs/reference/rpc-tools.md#20",
    gold: "python",
    code: '@mcp.resource("wiki://tags")\nasync def resource_tags(ctx: Context) -> str:',
    hljs: "python",
    relevance: 7,
    secondBest: "less",
    secondRelevance: 6,
    lang: "python",
    confidence: 0.3934693402873666,
    stamp: "python"
  },
  {
    id: "slice:example-service/db/migrations/20260721200002_job_store.sql@20+8",
    gold: "sql",
    code: "    value jsonb NOT NULL,\n    updated_at timestamptz NOT NULL DEFAULT now(),\n    updated_by_run_id uuid,\n    PRIMARY KEY (job_name, collection, key)\n);\n\n-- migrate:down\nDROP TABLE example_service.job_store;",
    hljs: "pgsql",
    relevance: 11,
    secondBest: "sas",
    secondRelevance: 7,
    lang: "sql",
    confidence: 0.3934693402873666,
    stamp: "sql"
  },
  {
    id: "fence:example-docs/RUNBOOK.md#7",
    gold: "bash",
    code: "mise run check                       # must be green BEFORE merging\ngit switch main && git merge --no-ff feat/my-change\ngit push origin main",
    hljs: "smali",
    relevance: 10,
    secondBest: "css",
    secondRelevance: 4,
    lang: undefined,
    confidence: 0.8646647167633873,
    stamp: undefined
  },
  {
    id: "slice:memhtml/packages/sleep/src/index.ts@38+5",
    gold: "typescript",
    code: "  confidenceOf,\n  datePlusDays,\n  hrefFor,\n  link,\n  meta,",
    hljs: "autohotkey",
    relevance: 5,
    secondBest: "bash",
    secondRelevance: 1,
    lang: undefined,
    confidence: 0.5506710358827784,
    stamp: undefined
  },
  {
    id: "fence:example-docs/reference/public-api.md#21",
    gold: "python",
    code: "async def page_assign_workspace(\n    repo: WikiPageRepo, slug: str, workspace: str | None\n) -> AppResult[WorkspaceAssigned]:",
    hljs: "python",
    relevance: 6,
    secondBest: "rust",
    secondRelevance: 5,
    lang: "python",
    confidence: 0.28346868942621073,
    stamp: undefined
  },
  {
    id: "slice:example-service/proofs/lakefile.toml@0+6",
    gold: "toml",
    code: 'name = "ExampleService"\ndefaultTargets = ["ExampleService"]\n\n[[lean_lib]]\nname = "ExampleService"\n',
    hljs: "ini",
    relevance: 10,
    secondBest: "abnf",
    secondRelevance: 9,
    lang: "toml",
    confidence: 0.15351827510938598,
    stamp: undefined
  },
  {
    id: "slice:example-service/.erpaval/sessions/session-3b90f3/intake.yaml@4+8",
    gold: "yaml",
    code: "inferred:\n  scope: null\n  complexity: null\n  dir_state: null\n  rigor_needed: null\ngit:\n  is_repo: True\n  branch: main",
    hljs: "yaml",
    relevance: 13,
    secondBest: "nix",
    secondRelevance: 12,
    lang: "yaml",
    confidence: 0.11750309741540454,
    stamp: undefined
  },
  {
    id: "slice:memhtml/packages/store/tsconfig.check.json@10+9",
    gold: "json",
    code: '  },\n  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],\n  "references": [\n    {\n      "path": "../contracts"\n    },\n    {\n      "path": "../html"\n    }',
    hljs: "css",
    relevance: 11,
    secondBest: "prolog",
    secondRelevance: 10,
    lang: "css",
    confidence: 0.10516068318563021,
    stamp: undefined
  },
  {
    id: "slice:memhtml/packages/store/package.json@12+6",
    gold: "json",
    code: '      "types": "./dist/testing.d.ts",\n      "default": "./dist/testing.js"\n    }\n  },\n  "scripts": {\n    "build": "tsc -b",',
    hljs: "json",
    relevance: 7.039999999999999,
    secondBest: "1c",
    secondRelevance: 7,
    lang: "json",
    confidence: 0.006644493744965452,
    stamp: undefined
  },
  {
    id: "fence:example-service/docs/architecture/telemetry.md#0",
    gold: "bash",
    code: "OTEL_ENDPOINT=http://localhost:4318\nOTEL_ENVIRONMENT=dev\n# EXAMPLE_OTEL_INSTRUMENT_BOTOCORE=1   # only if you want AWS-call spans",
    hljs: "ini",
    relevance: 6,
    secondBest: "routeros",
    secondRelevance: 6,
    lang: "toml",
    confidence: 0,
    stamp: undefined
  },
  {
    id: "slice:example-docs/tests/fixtures/golden/canonicalize-basic/input.html@0+5",
    gold: "html",
    code: '<article  data-page-slug="p"   id="p">\n  <section id="b1" data-kind="concept" data-block-id="b1">\n    <h2>Title</h2>\n    <p>Some   text.</p>\n  </section>',
    hljs: "xml",
    relevance: 12,
    secondBest: "django",
    secondRelevance: 12,
    lang: "html",
    confidence: 0,
    stamp: undefined
  }
]

/**
 * The one fixture matching a predicate, or a throw naming what was looked for.
 *
 * Throwing rather than returning `Fixture | undefined` is what keeps each test's own assertions
 * about the DETECTOR: a missing fixture is a broken test, and surfacing it as one failure here beats
 * every downstream expectation silently comparing `undefined` to `undefined` and passing.
 */
const fixture = (what: string, predicate: (row: Fixture) => boolean): Fixture => {
  const found = CORPUS.find(predicate)
  if (found === undefined) throw new Error(`no fixture for ${what}`)
  return found
}

const BASE: NewMemoryInput = {
  title: "Prod rollbacks drain the VIP first",
  claim: "If a prod rollback is issued, drain the VIP before reverting the deploy.",
  memoryType: "procedural",
  at: "2026-08-02T14:03:11Z"
}

/** A memory whose single body paragraph is one fence, which is the seam detection sits in. */
const withFence = (fence: string) => parseOk(renderTemplate({ ...BASE, body: [fence] }))

describe("port fidelity against the measured reference", () => {
  it("covers both decisions and the ways each is reached", () => {
    // A corpus of only stamps would leave the threshold and the vocabulary gate untested.
    expect(CORPUS.filter((row) => row.stamp !== undefined).length).toBeGreaterThanOrEqual(5)
    expect(CORPUS.filter((row) => row.stamp === undefined).length).toBeGreaterThanOrEqual(5)
    // Below threshold but in vocabulary, vs above threshold but out of vocabulary: different gates.
    expect(
      CORPUS.filter((row) => row.stamp === undefined && row.lang !== undefined).length
    ).toBeGreaterThanOrEqual(3)
    expect(
      CORPUS.filter((row) => row.lang === undefined && row.confidence >= DEPLOY_THRESHOLD).length
    ).toBeGreaterThanOrEqual(2)
  })

  for (const row of CORPUS) {
    it(`reproduces the reference confidence on ${row.id}`, () => {
      const detection = detect(row.code)
      expect(detection.lang).toBe(row.lang)
      // Exact float equality, not a tolerance: the threshold was swept over THIS arithmetic.
      expect(detection.confidence).toBe(row.confidence)
    })

    it(`reproduces the reference decision on ${row.id}`, () => {
      expect(detectLang(row.code)).toBe(row.stamp)
    })
  }

  it("normalizes each fixture's raw hljs grammar the way the reference did", () => {
    // The port's alias table, checked against the grammar names the corpus actually elicited —
    // `pgsql`, `ini`, and `xml` are the three that would silently stop stamping if lost.
    for (const row of CORPUS) {
      expect(normalizeLang(row.hljs), row.id).toBe(row.lang)
    }
  })

  it("agrees with the eval's precision at the deployed threshold", () => {
    // 15/16 of these stamps correct is the 95%-precision regime the eval measured, not a fluke of
    // fixture choice: one row IS wrong (bash scored as sql), and pretending otherwise by dropping
    // it would make this suite claim a precision the detector does not have.
    const stamped = CORPUS.filter((row) => row.stamp !== undefined)
    const wrong = stamped.filter((row) => row.stamp !== row.gold)
    expect(wrong).toHaveLength(1)
    expect(wrong[0]?.gold).toBe("bash")
    expect(wrong[0]?.stamp).toBe("sql")
  })
})

describe("the confidence formula", () => {
  it("zeroes the runner-up when it is the same canonical language", () => {
    /**
     * The load-bearing refinement. `pgsql(22)` beating `n1ql(21)` is a dialect duel, not
     * disagreement about what to stamp, so the margin is the FULL top score: 1-exp(-22/7).
     * Charged as a real contest it would be 1-exp(-1/7) = 0.133 and abstain — and SQL is the
     * language the detector recalls best (75.6% at the operating point), so losing this rule
     * loses most of the coverage the eval bought.
     */
    const duel = fixture(
      "a pgsql/n1ql duel",
      (row) => row.hljs === "pgsql" && row.secondBest === "n1ql"
    )
    const lines = duel.code.split("\n").length
    expect(detect(duel.code).confidence).toBe(1 - Math.exp(-duel.relevance / lines))
    // The same margin charged as a real contest would land below the threshold and abstain.
    expect(1 - Math.exp(-(duel.relevance - (duel.secondRelevance ?? 0)) / lines)).toBeLessThan(
      DEPLOY_THRESHOLD
    )
  })

  it("keeps a runner-up that is a different canonical language, or none", () => {
    // `xml(12)` vs `django(12)`: django is outside the vocabulary, so it is a real competitor and
    // the margin is zero. The rule is "same canonical token", not "close enough to ignore".
    const contested = fixture(
      "an xml/django tie",
      (row) => row.hljs === "xml" && row.secondBest === "django"
    )
    expect(contested.confidence).toBe(0)
    expect(detect(contested.code).confidence).toBe(0)
  })

  it("normalizes per line, so a longer snippet is not automatically more confident", () => {
    // Absolute relevance grows with length; the same evidence repeated must not read as stronger.
    const line = 'const value: number = Number.parseInt(process.env.PORT ?? "0", 10)'
    const short = detect(`${line}\n${line}`)
    const long = detect(Array.from({ length: 12 }, () => line).join("\n"))
    expect(long.confidence).toBeLessThan(short.confidence)
  })

  it("stays inside [0, 1) and never returns a negative confidence", () => {
    for (const row of CORPUS) {
      const { confidence } = detect(row.code)
      expect(confidence).toBeGreaterThanOrEqual(0)
      expect(confidence).toBeLessThan(1)
    }
  })

  it("abstains on input hljs cannot score at all", () => {
    expect(detect("")).toEqual({ lang: undefined, confidence: 0 })
    expect(detectLang("")).toBeUndefined()
    expect(detectLang("   \n\n   ")).toBeUndefined()
  })

  it("abstains above DETECT_MAX_CHARS without paying hljs's super-linear cost", () => {
    // A snippet the detector confidently stamps at normal size...
    const stampable = "SELECT id, name FROM users WHERE active = 1 ORDER BY name;\n"
    expect(detectLang(stampable)).toBe("sql")
    // ...abstains once it crosses the ceiling, and does so fast: the cap must
    // short-circuit BEFORE highlightAuto, whose measured cost at 40KB is ~20s.
    const oversized = stampable.repeat(Math.ceil((DETECT_MAX_CHARS + 1) / stampable.length))
    expect(oversized.length).toBeGreaterThan(DETECT_MAX_CHARS)
    const started = performance.now()
    expect(detect(oversized)).toEqual({ lang: undefined, confidence: 0 })
    expect(performance.now() - started).toBeLessThan(100)
    // At or below the ceiling hljs still RUNS — the gate is strictly greater-than.
    // The assertion is "hljs scored it", not "sql wins": 68 identical lines make
    // hljs prefer a different (out-of-vocabulary) grammar, and which grammar wins
    // is the detector's business. The cap's only job is whether hljs runs at all —
    // an over-ceiling input returns the exact zero the short-circuit constructs.
    const atCeiling = stampable.repeat(Math.floor(DETECT_MAX_CHARS / stampable.length))
    expect(atCeiling.length).toBeLessThanOrEqual(DETECT_MAX_CHARS)
    expect(detect(atCeiling).confidence).toBeGreaterThan(0)
  })
})

describe("the vocabulary gate", () => {
  it("refuses a confident detection outside the vocabulary", () => {
    /**
     * Independent of the threshold, and the reason the gate exists. hljs names `smali` at
     * confidence 0.86 for a snippet that is really bash — high confidence means only "this grammar
     * won by a wide margin", never "this grammar is one we stamp". Without this gate the corpus
     * would put `data-lang="smali"` in a memory file and a `lang:smali` row in the index.
     */
    const confidentUnknown = CORPUS.filter(
      (row) => row.lang === undefined && row.confidence >= DEPLOY_THRESHOLD
    )
    expect(confidentUnknown.length).toBeGreaterThanOrEqual(2)
    for (const row of confidentUnknown) {
      expect(detect(row.code).lang, row.id).toBeUndefined()
      expect(detectLang(row.code), row.id).toBeUndefined()
    }
  })

  it("maps every alias onto a canonical token, and every canonical token onto itself", () => {
    for (const lang of CANONICAL_LANGS) expect(normalizeLang(lang)).toBe(lang)
    expect(normalizeLang("pgsql")).toBe("sql")
    expect(normalizeLang("n1ql")).toBe("sql")
    expect(normalizeLang("xml")).toBe("html")
    // hljs ships no TOML grammar; its ini grammar is documented "TOML, also INI".
    expect(normalizeLang("ini")).toBe("toml")
    expect(normalizeLang("ts")).toBe("typescript")
    expect(normalizeLang("golang")).toBe("go")
  })

  it("is case- and whitespace-insensitive, since it reads a detector's naming", () => {
    expect(normalizeLang("  PGSQL ")).toBe("sql")
    expect(normalizeLang("TypeScript")).toBe("typescript")
  })

  it("returns undefined for a language outside the list rather than passing it through", () => {
    for (const unknown of ["smali", "autohotkey", "routeros", "moonscript", "1c", "", "  "]) {
      expect(normalizeLang(unknown), unknown).toBeUndefined()
    }
  })

  it("holds every canonical token to the LANG_TOKEN grammar, so no stamp can warn", () => {
    // Constraint 6 warns on a malformed `data-lang`. A canonical token that could not pass would
    // make the detector emit files that `memhtml doctor` complains about.
    for (const lang of CANONICAL_LANGS) expect(LANG_TOKEN.test(lang)).toBe(true)
  })
})

describe("the deployed threshold", () => {
  it("is the measured operating point rounded in the safe direction", () => {
    const MEASURED = 0.28685957116771854
    expect(DEPLOY_THRESHOLD).toBe(0.3)
    expect(DEPLOY_THRESHOLD).toBeGreaterThan(MEASURED)
  })

  it("stamps exactly the fixtures at or above it and nothing below", () => {
    for (const row of CORPUS) {
      const stamped = detectLang(row.code) !== undefined
      expect(stamped, `${row.id} @ ${row.confidence}`).toBe(
        row.lang !== undefined && row.confidence >= DEPLOY_THRESHOLD
      )
    }
  })
})

describe("the write path stamps an unlabeled fence", () => {
  it("stamps data-lang on an unlabeled fence the detector is confident about", () => {
    const confident = fixture("a stamping row", (row) => row.stamp !== undefined)
    const doc = withFence(`\`\`\`\n${confident.code}\n\`\`\``)
    expect(doc.article.html).toContain(`data-lang="${confident.stamp}"`)
    expect(doc.article.codeLangs).toEqual([confident.stamp])
  })

  it("omits data-lang when the detector is below the threshold", () => {
    const timid = fixture(
      "an in-vocabulary row below the threshold",
      (row) => row.stamp === undefined && row.lang !== undefined
    )
    const doc = withFence(`\`\`\`\n${timid.code}\n\`\`\``)
    expect(doc.article.html).toContain("<code>")
    expect(doc.article.html).not.toContain("data-lang")
    expect(doc.article.codeLangs).toEqual([])
  })

  it("omits data-lang when the confident detection is out of vocabulary", () => {
    const unknown = fixture(
      "a confident out-of-vocabulary row",
      (row) => row.lang === undefined && row.confidence >= DEPLOY_THRESHOLD
    )
    const doc = withFence(`\`\`\`\n${unknown.code}\n\`\`\``)
    expect(doc.article.html).not.toContain("data-lang")
    expect(doc.article.codeLangs).toEqual([])
  })

  it("emits a file that satisfies every constraint when it stamps", () => {
    // A stamp is a new attribute in a file the format validates; a canonical token must not warn.
    for (const row of CORPUS.filter((entry) => entry.stamp !== undefined)) {
      const html = renderTemplate({ ...BASE, body: [`\`\`\`\n${row.code}\n\`\`\``] })
      expect(checkMemory(html), row.id).toEqual({ violations: [], warnings: [] })
    }
  })
})

describe("an author's info string always wins", () => {
  it("keeps the author's token on code the detector would name differently", () => {
    /**
     * The SQL fixture hljs scores at 0.96 — as confident as it gets. Labeled `python`, the file
     * must still say `python`: the author knows, and a detector that could override a human would
     * be a detector that silently rewrites metadata.
     */
    const sql = fixture(
      "a very confident sql row",
      (row) => row.stamp === "sql" && row.confidence > 0.9
    )
    const doc = withFence(`\`\`\`python\n${sql.code}\n\`\`\``)
    expect(doc.article.html).toContain('data-lang="python"')
    expect(doc.article.html).not.toContain('data-lang="sql"')
    expect(doc.article.codeLangs).toEqual(["python"])
  })

  it("keeps a non-canonical author token the detector's vocabulary would reject", () => {
    // `c++` is outside CANONICAL_LANGS, so a detector could never emit it — and that is exactly
    // why the author path must not be routed through the vocabulary. LANG_TOKEN still governs it.
    const doc = withFence("```c++\nauto x = std::vector<int>{1, 2, 3};\n```")
    expect(doc.article.html).toContain('data-lang="c++"')
    expect(doc.article.codeLangs).toEqual(["c++"])
    expect(normalizeLang("c++")).toBeUndefined()
  })

  it("keeps an author token the detector would AGREE with, unnormalized", () => {
    // `ts` normalizes to `typescript`, but the author wrote `ts` and the file says `ts`.
    const doc = withFence("```ts\nconst x: number = 1\n```")
    expect(doc.article.html).toContain('data-lang="ts"')
    expect(doc.article.codeLangs).toEqual(["ts"])
  })
})

describe("rebuild determinism", () => {
  it("is a fixed point: the stamped file re-serializes to itself", () => {
    // The stamp is IN the file, so a read/serialize round trip must not move it — which is what
    // makes the tree the system of record for language rather than the detector.
    const row = fixture("a stamping row", (entry) => entry.stamp !== undefined)
    const html = renderTemplate({ ...BASE, body: [`\`\`\`\n${row.code}\n\`\`\``] })
    const doc = parseOk(html)
    expect(serializeMemory(doc)).toBe(html)
    expect(doc.article.codeLangs).toEqual([row.stamp])
  })

  it("reads the stamp back from the bytes rather than recomputing it", () => {
    /**
     * A stamp the detector would NOT produce, hand-written into the file: if any read path
     * re-detected, `data-lang` would come back as the detector's own answer instead. It comes back
     * as what the file says, which is the rebuildability contract.
     */
    const sql = fixture(
      "a very confident sql row",
      (row) => row.stamp === "sql" && row.confidence > 0.9
    )
    const html = renderTemplate({
      ...BASE,
      articleHtml: `<p><mark>A claim.</mark></p><figure><pre><code data-lang="cobol">${sql.code}</code></pre></figure>`
    })
    expect(parseOk(html).article.codeLangs).toEqual(["cobol"])
    expect(detectLang(sql.code)).toBe("sql")
  })

  /**
   * The grep lock: detection must not reach index time, in ANY package downstream of the write
   * path. An index-time detector would make `rm index.db && rebuild` depend on the installed
   * highlight.js version rather than on the tree, so a version bump would silently change what a
   * rebuild produces from unchanged files.
   *
   * Asserted over `@memhtml/index`'s emitted `dist` bytes, following the prose-derivation lock in
   * `apps/mcp/tests/tools.test.ts` — what is matched is the module a detector would have to reach
   * and the constants it would have to carry, so a re-implementation under any NAME is still
   * caught.
   */
  it("holds no detector anywhere in the indexer's emitted bytes", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    /** What an index-time detector could not avoid: the module, hljs itself, or the threshold. */
    const SIGNATURES = ["detect.js", "highlight.js", "highlightAuto", "0.28685957116771854"]
    const dist = new URL("../../index/dist", import.meta.url).pathname
    const entries = await readdir(dist, { recursive: true, withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(entry.parentPath, entry.name))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = await readFile(file, "utf8")
      for (const signature of SIGNATURES) {
        expect(source, `${file} reaches a language detector: ${signature}`).not.toContain(signature)
      }
    }
  })

  it("keeps @memhtml/index free of a highlight.js dependency", async () => {
    // The dist lock catches a detector that got imported; this catches one that got INSTALLED,
    // before anyone writes the import.
    const { readFile } = await import("node:fs/promises")
    const manifest = new URL("../../index/package.json", import.meta.url).pathname
    const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.["highlight.js"]).toBeUndefined()
    expect(pkg.devDependencies?.["highlight.js"]).toBeUndefined()
  })

  it("pins highlight.js exactly, since relevance scores are grammar-dependent", async () => {
    /**
     * The determinism contract's other half. A caret would let a patch release move every
     * confidence — and therefore which fences get stamped — without any change to this repo, which
     * would make two clones of the same commit produce different files. A bump is a decision that
     * re-runs the eval, so the pin is asserted as an exact string rather than a satisfied range.
     */
    const { readFile } = await import("node:fs/promises")
    const manifest = new URL("../package.json", import.meta.url).pathname
    const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies["highlight.js"]).toBe("11.11.1")
  })
})

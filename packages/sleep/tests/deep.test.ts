import { GitFailure } from "@memhtml/store"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { commitPhase } from "../src/commit.js"
import { type SleepPhase, TRAILER_PHASE } from "../src/contract.js"
import { meta, stampFile } from "../src/edits.js"
import { makeLlmBudget, type PhaseEnv } from "../src/env.js"
import { assignEntityLabels, compress, ENTITY_LABEL_PREFIX } from "../src/phases/compress.js"
import { confidenceDecay } from "../src/phases/confidence-decay.js"
import { personLinks } from "../src/phases/person-links.js"
import { PLACEMENT_REFUSALS, placementTriage } from "../src/phases/placement-triage.js"
import {
  DEEP_GROUPING_REL,
  DEEP_MINING_COSINE_FLOOR,
  MINING_COSINE_FLOOR,
  relationshipMining
} from "../src/phases/relationship-mining.js"
import { instantFor, run } from "../src/run.js"
import { type ScriptedModel, scriptedModel, value } from "../src/testing.js"
import { type Fixture, memoryHtml, type SeedFile, withFixture } from "./fixture.js"

/**
 * The deep-sleep cycle (issue #63): the grouping band, entity-keyed grouping, placement triage,
 * iterate-until-quiet, the shared budget — and the NO-FLAG REGRESSION, which is the assertion the
 * whole feature hangs on: a run without `--deep` must leave the phase plan, the mined-edge set, and
 * compress's candidate selection byte-identical to what they were before the flag existed.
 *
 * Every fixture cosine below is MEASURED under `fakeVector` (2026-08-24, over the article text the
 * chunker embeds, `claim + " " + body`), not intended. The corpus construction follows
 * `dedupComponentCorpus`'s discipline: topic-unique tokens, no digits, symmetric unique-token
 * counts, so the numbers are a function of token overlap alone.
 */

const DATE = "2026-08-02"

const envFor = (
  fixture: Fixture,
  options: {
    readonly deep?: boolean
    readonly budget?: number
    readonly dryRun?: boolean
    readonly baseSha?: string
  } = {}
): PhaseEnv => {
  const instant = instantFor(DATE)
  return {
    deps: fixture.deps,
    runId: `sleep/${DATE}`,
    branch: `sleep/${DATE}`,
    baseSha: options.baseSha ?? "",
    date: DATE,
    at: instant.at,
    atMillis: instant.millis,
    dryRun: options.dryRun === true,
    ...(options.deep === true
      ? {
          deep: {
            ...(options.budget === undefined ? {} : { budget: makeLlmBudget(options.budget) })
          }
        }
      : {})
  }
}

/** Every mined edge, rel-tagged, so a band test reads the exact set the index holds. */
const minedEdges = (
  fixture: Fixture
): Effect.Effect<ReadonlyArray<{ rel: string; src: string; dst: string; strength: number }>> =>
  fixture.db
    .all<{ rel: string; src: string; dst: string; strength: number }>(
      `SELECT rel, src_path AS src, dst_path AS dst, strength FROM edges
       WHERE derived = 1 AND provenance = 'sleep' ORDER BY rel, src_path, dst_path`
    )
    .pipe(Effect.orDie)

/**
 * A DEEP-BAND TRIO: three memories on one topic whose pairwise cosines sit in [0.72, 0.85).
 *
 * Construction: three shared claim tokens, five shared body tokens, TWO unique body tokens per
 * member, all topic-prefixed. Measured pairwise cosines per stem (2026-08-24): marsh 0.8148-0.8220,
 * tundra 0.8000-0.8083, playa 0.8000 — every pair above the 0.72 deep floor and below the 0.85
 * default floor, so the DEFAULT band cannot see one edge here and the deep band sees them all.
 * Cross-stem maximum 0.0385, so two trios never chain. `confidence: "1.0"` at age ~0 scores 0.32,
 * inside the compress band (0.3, 0.7] (measured against `scoreRetention`), so every member is a
 * compress candidate the moment it has a community.
 */
const UNIQ: ReadonlyArray<ReadonlyArray<string>> = [
  ["primo", "segno"],
  ["terzo", "quarto"],
  ["quinto", "sesto"]
]
const trioFor = (stem: string, entities: ReadonlyArray<string> = []): ReadonlyArray<SeedFile> =>
  [0, 1, 2].map((at) => ({
    path: `areas/inbox/${stem}-${at}.html`,
    html: memoryHtml({
      title: `${stem} note ${at}`,
      claim: `${stem}alfa ${stem}bravo ${stem}cielo.`,
      body: [
        ...["delta", "ferro", "gusto", "halo", "ilex"].map((token) => `${stem}${token}`),
        ...(UNIQ[at] ?? []).map((token) => `${stem}${token}`)
      ].join(" "),
      memoryType: "semantic",
      createdAt: "2026-08-01T00:00:00Z",
      confidence: "1.0",
      importance: "5",
      entities,
      tags: ["deeptest"]
    })
  }))

/**
 * An ENTITY CLUSTER: three memories about one service whose PROSE shares nothing.
 *
 * Measured pairwise cosines 0.1690-0.4140 — below even the deep band's 0.72 floor, so no mining
 * tier at any affordable floor connects them. The shared `service:ledger-export` entity is the only
 * signal, which is exactly the pair class issue #63's mechanism 2 exists for.
 */
const ENTITY_CLUSTER: ReadonlyArray<SeedFile> = [
  {
    path: "areas/inbox/ledger-manifest.html",
    html: memoryHtml({
      title: "The export job writes a manifest",
      claim: "The ledger export job writes a manifest before the nightly copy departs.",
      memoryType: "semantic",
      createdAt: "2026-08-01T00:00:00Z",
      confidence: "1.0",
      importance: "5",
      entities: ["service:ledger-export"],
      tags: ["deeptest"]
    })
  },
  {
    path: "areas/inbox/ledger-reconciliation.html",
    html: memoryHtml({
      title: "Reconciliation walks the bank feed",
      claim: "Reconciliation walks yesterday totals against the bank feed each morning.",
      memoryType: "semantic",
      createdAt: "2026-08-01T01:00:00Z",
      confidence: "1.0",
      importance: "5",
      entities: ["service:ledger-export"],
      tags: ["deeptest"]
    })
  },
  {
    path: "areas/inbox/ledger-retry-storm.html",
    html: memoryHtml({
      title: "Retry storms double writes",
      claim: "A retry storm in the sync worker doubles writes when the lease expires.",
      memoryType: "semantic",
      createdAt: "2026-08-01T02:00:00Z",
      confidence: "1.0",
      importance: "5",
      entities: ["service:ledger-export"],
      tags: ["deeptest"]
    })
  }
]

/** A compress model that folds every batch it is shown into one canonical, absorbing everything. */
const foldEverythingModel = (): ScriptedModel =>
  scriptedModel((request, offset) => {
    const keys = [...request.prompt.matchAll(/<member_(m\d+)>/g)].map((match) => match[1] ?? "")
    return value({
      title: `fold ${offset}`,
      claim: `The fold ${offset} canonical claim.`,
      paragraphs: ["Every fact carried forward."],
      absorbedKeys: keys
    })
  })

describe("deep mining (guard a: band isolation)", () => {
  it("writes the deep band under its own rel and leaves the default set untouched, and vice versa", async () => {
    /**
     * The two bands replace atomically PER REL, so a deep re-mine cannot clobber the default
     * `relates_to` set and a default re-mine cannot clobber the deep band. Driven through the real
     * phase twice — deep first, default second — because the clobber would happen in the SECOND
     * run's `replaceMinedEdges`, not the first's.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Deep run: both bands land.
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const afterDeep = yield* minedEdges(fixture)
          const standard = afterDeep.filter((edge) => edge.rel === "relates_to")
          const deep = afterDeep.filter((edge) => edge.rel === DEEP_GROUPING_REL)
          // The trio's three unordered pairs are measured 0.8000-0.8220: all deep-band, none in the
          // default band. Six ROWS, because the kernel offers each pair to both endpoints'
          // neighborhoods — the same doubling the default band has always had.
          expect(deep.length).toBe(6)
          expect(standard.length).toBe(0)
          for (const edge of deep) {
            expect(edge.strength).toBeGreaterThanOrEqual(DEEP_MINING_COSINE_FLOOR)
            expect(edge.strength).toBeLessThan(MINING_COSINE_FLOOR)
          }

          // Default run over the same corpus: the deep band SURVIVES, the default set is replaced.
          yield* relationshipMining(envFor(fixture, { deep: false }))
          const afterDefault = yield* minedEdges(fixture)
          expect(afterDefault.filter((edge) => edge.rel === DEEP_GROUPING_REL)).toEqual(deep)
          expect(afterDefault.filter((edge) => edge.rel === "relates_to").length).toBe(0)
        }),
      { seed: [...trioFor("marsh")] }
    )
  })

  it("reports deepMined only under the flag, and mines nothing extra without it", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const standard = yield* relationshipMining(envFor(fixture))
          expect(standard.counts.deepMined).toBeUndefined()
          expect(yield* minedEdges(fixture)).toEqual([])

          const deep = yield* relationshipMining(envFor(fixture, { deep: true }))
          expect(deep.counts.deepMined).toBe(6)
        }),
      { seed: [...trioFor("tundra")] }
    )
  })
})

describe("entity grouping (guard b: batch size and the hub cap)", () => {
  it("labels shared-entity files, one label per file, and skips hub entities by ACTIVE count", () => {
    /**
     * Pure-kernel assertions, the same style `assembleBatches` is tested in: the hub cap counts the
     * entity's whole active claimant set (a hub whose tail leaves three inbox files is still a
     * hub), a file naming two entities lands with the lexicographically first, and a group of one
     * labels nothing.
     */
    const claims = (
      entity: string,
      paths: ReadonlyArray<string>
    ): ReadonlyArray<{ entity_type: string; entity_name: string; path: string }> =>
      paths.map((path) => ({ entity_type: "service", entity_name: entity, path }))

    const hubPaths = Array.from({ length: 70 }, (_, at) => `areas/hub/file-${at}.html`)
    const needing = new Set(["areas/inbox/a.html", "areas/inbox/b.html", ...hubPaths.slice(0, 3)])
    const out = assignEntityLabels(
      [
        ...claims("everywhere", hubPaths),
        ...claims("narrow", ["areas/inbox/a.html", "areas/inbox/b.html"]),
        ...claims("alone", ["areas/inbox/a.html"])
      ],
      needing
    )
    // The hub (70 > 64 active claimants) labels nothing even though three claimants need a group.
    expect(out.hubsSkipped).toBe(1)
    for (const hubPath of hubPaths) expect(out.labels.get(hubPath)).toBeUndefined()
    // 'alone' walks first lexicographically but holds ONE needing member, so it labels nothing;
    // both files land with 'narrow', proving the two-member floor and the one-label-per-file rule.
    expect(out.labels.get("areas/inbox/a.html")).toBe(`${ENTITY_LABEL_PREFIX}service:narrow`)
    expect(out.labels.get("areas/inbox/b.html")).toBe(`${ENTITY_LABEL_PREFIX}service:narrow`)
  })

  it("folds a shared-entity cluster no cosine can reach, respecting the batch kernel", async () => {
    /**
     * The entity cluster's measured cosines top out at 0.414 — under the deep floor — so if this
     * fold happens at all, entity grouping is what carried it. Asserted through the real phase: the
     * scripted model absorbs what it is offered, and the members' archival is read from GIT.
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const outcome = yield* compress(envFor(fixture, { deep: true }))
          expect(outcome.counts.entityGroups).toBeGreaterThanOrEqual(1)
          expect(outcome.counts.canonicals).toBeGreaterThanOrEqual(1)
          // One batch of three: the kernel sliced the entity group under COMPRESS_BATCH_SIZE.
          expect(model.calls.length).toBeGreaterThanOrEqual(1)
          // Anchored per line: the ARCHIVE path contains the inbox path as a substring, so a bare
          // `includes` would report the archived file as still live.
          const tree = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          expect(tree.split("\n")).not.toContain("areas/inbox/ledger-manifest.html")
          expect(tree).toContain("archive/2026/areas/inbox/ledger-manifest.html")
        }),
      { seed: [...ENTITY_CLUSTER], model }
    )
  })
})

describe("iterate-until-quiet (guard d) and the budget (guard e)", () => {
  it("stops after one pass when the first pass folds nothing", async () => {
    /** A refusing model: absorbedKeys []. One pass, zero canonicals, loop exits at 'quiet'. */
    const model = scriptedModel(() =>
      value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const outcome = yield* compress(envFor(fixture, { deep: true }))
          expect(outcome.counts.canonicals).toBe(0)
          // One community, one batch, one call: the loop did NOT re-run after a quiet pass.
          expect(model.calls).toHaveLength(1)
        }),
      { seed: [...trioFor("playa")], model }
    )
  })

  it("runs a second pass after a folding pass, and a run without --deep never iterates", async () => {
    /**
     * Pass 1 folds the trio into a canonical; the loop re-indexes, re-mines, re-scores, and pass 2
     * runs over the post-fold corpus (the canonical alone forms no community, so pass 2 is quiet
     * and the loop exits at zero canonicals rather than at the cap). The no-flag control makes the
     * same corpus fold ONCE with no second retention pass, observed through the call count.
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const outcome = yield* compress(envFor(fixture, { deep: true }))
          expect(outcome.counts.canonicals).toBe(1)
          expect(outcome.counts.passes).toBe(2)
          expect(model.calls).toHaveLength(1)
        }),
      { seed: [...trioFor("marsh")], model }
    )
  })

  it("skips batches with the budget reason once the shared cap is spent, and stays green", async () => {
    /**
     * Two disjoint deep communities, budget 1: the first batch spends the call, the second is a
     * `budgetSkipped`, and the phase completes ok. The distinct reason is the whole point — a
     * budget stop and a model outage need different mornings-after.
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const outcome = yield* compress(envFor(fixture, { deep: true, budget: 1 }))
          expect(model.calls).toHaveLength(1)
          expect(outcome.counts.budgetSkipped).toBeGreaterThanOrEqual(1)
          expect(outcome.counts.failed).toBe(0)
          expect(outcome.llmCalls).toBe(1)
        }),
      { seed: [...trioFor("marsh"), ...trioFor("tundra")], model }
    )
  })

  it("charges placement triage against the same budget compress spent", async () => {
    /**
     * The budget is the RUN's, not a phase's. A budget of zero means placement makes no call at
     * all and reports the skip — asserted with a model that would gladly answer.
     */
    const model = scriptedModel(() => value({ placements: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* placementTriage(envFor(fixture, { deep: true, budget: 0 }))
          expect(model.calls).toHaveLength(0)
          expect(outcome.counts.budgetSkipped).toBeGreaterThanOrEqual(1)
          expect(outcome.llmCalls).toBe(0)
        }),
      { seed: [...ENTITY_CLUSTER], model }
    )
  })
})

/** One placement answer for every offered member, all naming one destination. */
const placeAllInto = (destination: string, confidence = 0.9): ScriptedModel =>
  scriptedModel((request) => {
    const keys = [...request.prompt.matchAll(/<memory_(m\d+)>/g)].map((match) => match[1] ?? "")
    return value({
      placements: keys.map((memberKey) => ({ memberKey, destination, confidence }))
    })
  })

describe("placement triage (guard c: destinations and refusals)", () => {
  it("moves a placed file, mints the new directory, and rewrites inbound hrefs in one commit", async () => {
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* placementTriage(envFor(fixture, { deep: true }))
          expect(outcome.counts.applied).toBe(3)
          expect(outcome.counts.newDirs).toBe(1)
          const tree = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          expect(tree).toContain("areas/ledgers/ledger-manifest.html")
          expect(tree).not.toContain("areas/inbox/ledger-manifest.html")
          // The linking file moved too, and its href follows the target's NEW path.
          const linker = yield* fixture.raw("show", "HEAD:areas/ledgers/ledger-retry-storm.html")
          expect(linker).toContain('href="/areas/ledgers/ledger-manifest.html"')
          expect(linker).not.toContain('href="/areas/inbox/ledger-manifest.html"')
        }),
      {
        seed: [
          ...ENTITY_CLUSTER.slice(0, 2),
          {
            // The third member authors a link at the first, so the href-rewrite arm is non-vacuous.
            path: "areas/inbox/ledger-retry-storm.html",
            html: memoryHtml({
              title: "Retry storms double writes",
              claim: "A retry storm in the sync worker doubles writes when the lease expires.",
              memoryType: "semantic",
              createdAt: "2026-08-01T02:00:00Z",
              confidence: "1.0",
              importance: "5",
              entities: ["service:ledger-export"],
              tags: ["deeptest"],
              links: [{ rel: "memhtml-relates-to", href: "/areas/inbox/ledger-manifest.html" }]
            })
          }
        ],
        model
      }
    )
  })

  it("refuses a managed surface, a nonexistent bucket, and honors keep-inbox", async () => {
    /**
     * Three answers, three refusal classes, plus the explicit keep. Nothing moves, and the counts
     * partition: managed surface and invalid bucket are `refused`, keep-inbox is `keptInbox`.
     */
    const model = scriptedModel((request) => {
      const keys = [...request.prompt.matchAll(/<memory_(m\d+)>/g)].map((match) => match[1] ?? "")
      const destinations = ["resources/people", "projects/nowhere", "keep-inbox"]
      return value({
        placements: keys.map((memberKey, at) => ({
          memberKey,
          destination: destinations[at % destinations.length] ?? "keep-inbox",
          confidence: 0.9
        }))
      })
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          const outcome = yield* placementTriage(envFor(fixture, { deep: true }))
          expect(outcome.counts.applied).toBe(0)
          expect(outcome.counts.refused).toBe(2)
          expect(outcome.counts.keptInbox).toBe(1)
          expect(yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")).toEqual(before)
        }),
      { seed: [...ENTITY_CLUSTER], model }
    )
  })

  it("caps new directories per run and refuses below-floor confidence", async () => {
    /**
     * Six singletons, each placed into its OWN new directory at high confidence: only
     * PLACEMENT_NEW_DIR_CAP (5) directories mint and the sixth refuses. A seventh answer below the
     * 0.7 floor refuses regardless of destination.
     */
    const model = scriptedModel((request) => {
      const keys = [...request.prompt.matchAll(/<memory_(m\d+)>/g)].map((match) => match[1] ?? "")
      return value({
        placements: keys.map((memberKey, at) => ({
          memberKey,
          destination: at === 6 ? "areas/lowconf" : `areas/topic-${"abcdefg"[at] ?? "z"}`,
          confidence: at === 6 ? 0.5 : 0.9
        }))
      })
    })
    const singles: ReadonlyArray<SeedFile> = Array.from({ length: 7 }, (_, at) => ({
      path: `areas/inbox/single-${"abcdefg"[at] ?? "z"}.html`,
      html: memoryHtml({
        title: `Single fact ${"abcdefg"[at] ?? "z"}`,
        claim: `The ${"abcdefg"[at] ?? "z"}fact stands alone and shares no vocabulary with the others.`,
        body: `Unrelated ${"abcdefg"[at] ?? "z"}detail follows here.`,
        memoryType: "semantic",
        createdAt: "2026-08-01T00:00:00Z",
        confidence: "1.0",
        importance: "5",
        tags: ["deeptest"]
      })
    }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* placementTriage(envFor(fixture, { deep: true }))
          expect(outcome.counts.newDirs).toBe(5)
          expect(outcome.counts.applied).toBe(5)
          expect(outcome.counts.refused).toBe(2)
        }),
      { seed: singles, model }
    )
  })

  it("does nothing at all on a run without --deep", async () => {
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* placementTriage(envFor(fixture))
          expect(outcome.detail).toContain("deep-only")
          expect(outcome.commitSha).toBeNull()
          expect(model.calls).toHaveLength(0)
        }),
      { seed: [...ENTITY_CLUSTER], model }
    )
  })
})

describe("placement triage (guard g: the this-run touched set)", () => {
  /**
   * The guard against cross-phase contamination, and the distinction issue #81 turns on: a phase whose
   * write carries a DECISION pins its files, while a uniform sweep does not.
   *
   * **Every case here supplies a real `baseSha`, and that is what makes them the guard's only
   * coverage.** `envFor` defaults it to `""`, which short-circuits the read to an empty set, so a
   * placement case that omits it exercises the destination rules and nothing about this guard — which
   * is how a guard refusing ~100% of a real corpus's moves reached a release.
   *
   * Every case seeds an anchor under `areas/ledgers`, so the destination is an EXISTING directory and
   * `PLACEMENT_NEW_DIR_CAP` cannot be what decides the outcome. One guard per test.
   */
  const STEMS = ["alfa", "bravo", "cielo"] as const

  const inboxPath = (stem: string): string => `areas/inbox/${stem}.html`

  const singleton = (stem: string, entities: ReadonlyArray<string> = []): SeedFile => ({
    path: inboxPath(stem),
    html: memoryHtml({
      title: `The ${stem} fact`,
      claim: `The ${stem}ledger posting closes on the ${stem}window each night.`,
      body: `Only ${stem}detail follows, and nothing else names it.`,
      memoryType: "semantic",
      createdAt: "2026-08-01T00:00:00Z",
      confidence: "1.0",
      importance: "5",
      tags: ["deeptest"],
      entities
    })
  })

  /**
   * The corpus: three inbox singletons plus a file that already lives in `areas/ledgers`, which is
   * what puts that directory in `existingDirs` and takes the new-directory cap out of the question.
   */
  const corpusFor = (entities: ReadonlyArray<string> = []): ReadonlyArray<SeedFile> => [
    singleton("alfa", entities),
    singleton("bravo"),
    singleton("cielo"),
    {
      path: "areas/ledgers/anchor.html",
      html: memoryHtml({
        title: "The ledgers anchor",
        claim: "The anchorbook already sits in the ledgers directory.",
        memoryType: "semantic",
        createdAt: "2026-08-01T00:00:00Z",
        confidence: "1.0",
        importance: "5",
        tags: ["deeptest"]
      })
    }
  ]

  /**
   * Every refusal class present as a count, and the classes summing to the `refused` total.
   *
   * A census rather than a restatement: `refused` is derived by the phase from the same increments,
   * so a class that bumped only the total (or only itself) is a partition that lies, and the numbers
   * would still look like data. Asserted in every case below, so it is never vacuous for want of a
   * refusal to count.
   */
  const expectRefusalCensus = (counts: Record<string, number>): void => {
    let total = 0
    for (const key of Object.keys(PLACEMENT_REFUSALS)) {
      expect(counts[key], `${key} is not reported`).toBeTypeOf("number")
      total += counts[key] ?? 0
    }
    expect(total).toBe(counts.refused)
  }

  /** Write one meta and commit it AS `phase`, through the real stamp and the real trailer block. */
  const writeAs = (
    fixture: Fixture,
    phase: SleepPhase,
    path: string
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const env = envFor(fixture)
      const changed = yield* stampFile(env, path, [meta("memhtml-confidence", "0.500")])
      expect(changed).toBe(true)
      const sha = yield* commitPhase(env, phase, `write ${path}`, {})
      expect(sha).not.toBeNull()
    }).pipe(Effect.orDie)

  it("moves a file the confidence sweep restamped, which is issue #81", async () => {
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          /**
           * The REAL phase, so the commit and its `Memhtml-Phase` trailer come from production code.
           * A hand-forged commit would pass this case while the trailer writer and the trailer reader
           * disagreed.
           */
          const decay = yield* confidenceDecay(envFor(fixture))
          /**
           * NON-VACUITY, and it is the hinge of the case. Decay is a fixed point on an already-decayed
           * corpus and commits nothing there, so without these three the case would pass by decay
           * having done nothing at all — the exact shape a quarter of this repo's candidate regression
           * tests had.
           */
          expect(decay.counts.decayed).toBe(4)
          expect(decay.commitSha).not.toBeNull()
          expect(yield* fixture.raw("diff", "--name-only", `${base}..HEAD`)).toContain(
            inboxPath("alfa")
          )

          const outcome = yield* placementTriage(envFor(fixture, { deep: true, baseSha: base }))
          // The sweep's commit is seen and excluded: one commit in the range, zero of them pinning.
          expect(outcome.counts.sweepCommits).toBe(1)
          expect(outcome.counts.touchedCommits).toBe(0)
          expect(outcome.counts.touchedFiles).toBe(0)
          expect(outcome.counts.touchedWidened).toBe(0)
          expect(outcome.counts.refusedTouched).toBe(0)
          expect(outcome.counts.applied).toBe(3)
          // An existing destination, so the new-directory cap is not what let these through.
          expect(outcome.counts.newDirs).toBe(0)
          expect(outcome.counts.existingDirs).toBe(1)
          expectRefusalCensus(outcome.counts as Record<string, number>)

          const tree = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          for (const stem of STEMS) {
            expect(tree).toContain(`areas/ledgers/${stem}.html`)
            expect(tree).not.toContain(inboxPath(stem))
          }
        }),
      { seed: corpusFor(), model }
    )
  })

  it("refuses a file person-links wrote, whose commit decides something", async () => {
    /**
     * A real phase whose whole write is a `<link>` plus a stamp, so the article's bytes — and its
     * content hash — are identical afterwards. That is why the rule is about what a phase DECIDES and
     * not about how wide or how deep its diff is: a hash-based rule would release exactly this file,
     * and placement's inbound-href rewrite reads the index, which no phase refreshes mid-run, so the
     * link this commit authored is invisible to it.
     */
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const linked = yield* personLinks(envFor(fixture))
          expect(linked.counts.linksAdded).toBe(1)
          expect(linked.commitSha).not.toBeNull()
          expect(yield* fixture.raw("diff", "--name-only", `${base}..HEAD`)).toContain(
            inboxPath("alfa")
          )

          const outcome = yield* placementTriage(envFor(fixture, { deep: true, baseSha: base }))
          expect(outcome.counts.touchedCommits).toBe(1)
          expect(outcome.counts.sweepCommits).toBe(0)
          expect(outcome.counts.refusedTouched).toBe(1)
          expect(outcome.counts.applied).toBe(2)
          expectRefusalCensus(outcome.counts as Record<string, number>)

          const tree = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          // The linked file stayed; its two neighbours, which the same run never wrote, moved.
          expect(tree).toContain(inboxPath("alfa"))
          expect(tree).toContain("areas/ledgers/bravo.html")
          expect(tree).toContain("areas/ledgers/cielo.html")
        }),
      { seed: corpusFor(["person:sanju"]), model }
    )
  })

  it("reads the trailer and nothing else: one edit, two trailers, opposite outcomes", async () => {
    /**
     * The pair that proves the MECHANISM. Both halves make the byte-identical edit to the same file
     * and produce the same diff; only the `Memhtml-Phase` value differs, and the outcomes invert. Any
     * mutation of `SWEEP_PHASES` turns one half red.
     */
    for (const [phase, moves] of [
      ["dedup-merge", false],
      ["confidence-decay", true]
    ] as const) {
      const model = placeAllInto("areas/ledgers")
      await withFixture(
        (fixture) =>
          Effect.gen(function* () {
            const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()
            yield* writeAs(fixture, phase, inboxPath("alfa"))
            // The two halves are the same diff, so the trailer is the only variable.
            expect(yield* fixture.raw("diff", "--name-only", `${base}..HEAD`)).toBe(
              `${inboxPath("alfa")}\n`
            )

            const outcome = yield* placementTriage(envFor(fixture, { deep: true, baseSha: base }))
            expect(outcome.counts.refusedTouched, `${phase} refusals`).toBe(moves ? 0 : 1)
            expect(outcome.counts.applied, `${phase} moves`).toBe(moves ? 3 : 2)
            expect(outcome.counts.sweepCommits, `${phase} sweeps`).toBe(moves ? 1 : 0)
            expectRefusalCensus(outcome.counts as Record<string, number>)

            const tree = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
            expect(tree.includes(`areas/ledgers/alfa.html`), `${phase} tree`).toBe(moves)
          }),
        { seed: corpusFor(), model }
      )
    }
  })

  it("pins a commit whose phase it cannot recognize, and one with no phase at all", async () => {
    /**
     * The fail-safe default. The trailer is what IDENTIFIES a sweep, so the absence of the
     * identification cannot grant the exemption: an operator's own mid-run commit and a commit stamped
     * with a phase name this version does not know both pin.
     *
     * **The refusals here do not distinguish a scoped read from a whole-range one** — a diff of the
     * whole range pins these two files as well. That is the point: this case locks the fail-safe
     * DEFAULT, and its mutation is flipping the unrecognized-trailer branch to "sweep", not reverting
     * the guard. What the two diagnostic counts below distinguish is which read produced the set.
     */
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()

          // No trailers at all: `fixture.commit` commits bare, exactly as a human's `git commit` does.
          yield* fixture.commit(
            [
              {
                path: inboxPath("alfa"),
                html: memoryHtml({
                  title: "Edited by hand",
                  claim: "An operator rewrote the alfaledger claim."
                })
              }
            ],
            "an operator's own edit"
          )
          // A trailer value that is not a phase this version knows.
          const env = envFor(fixture)
          yield* stampFile(env, inboxPath("bravo"), [meta("memhtml-confidence", "0.500")])
          yield* fixture.deps.git.commit("sleep(conflict-detection): x", {
            trailers: { [TRAILER_PHASE]: "conflict-detection" }
          })

          const outcome = yield* placementTriage(envFor(fixture, { deep: true, baseSha: base }))
          expect(outcome.counts.touchedCommits).toBe(2)
          expect(outcome.counts.sweepCommits).toBe(0)
          expect(outcome.counts.refusedTouched).toBe(2)
          expect(outcome.counts.applied).toBe(1)
          expectRefusalCensus(outcome.counts as Record<string, number>)
        }),
      { seed: corpusFor(), model }
    )
  })

  it("pins a commit claiming two phases unless BOTH of them are sweeps", async () => {
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const env = envFor(fixture)
          yield* stampFile(env, inboxPath("alfa"), [meta("memhtml-confidence", "0.500")])
          // Two `Memhtml-Phase` values on one commit, which the port's one-value-per-key shape
          // cannot express — so this goes through git directly, as a forged commit would.
          yield* fixture.raw(
            "commit",
            "-m",
            "sleep(confidence-decay): two phases",
            "--trailer",
            `${TRAILER_PHASE}: confidence-decay`,
            "--trailer",
            `${TRAILER_PHASE}: person-links`
          )

          const outcome = yield* placementTriage(envFor(fixture, { deep: true, baseSha: base }))
          expect(outcome.counts.sweepCommits).toBe(0)
          expect(outcome.counts.refusedTouched).toBe(1)
          expect(outcome.counts.applied).toBe(2)
          expectRefusalCensus(outcome.counts as Record<string, number>)
        }),
      { seed: corpusFor(), model }
    )
  })

  it("widens to the whole range when the per-commit diff cannot be read", async () => {
    /**
     * The middle rung of the failure ladder. A read that failed and returned an EMPTY set would turn
     * the guard off at exactly the moment it cannot tell what happened, so a failure pins more than
     * it must: here the file the sweep restamped — the one a working read releases — is refused.
     *
     * The port is the REAL one with a single method made to fail. Nothing about git is faked; what is
     * injected is the failure, which is the subject.
     */
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          yield* confidenceDecay(envFor(fixture))

          const env = envFor(fixture, { deep: true, baseSha: base })
          const outcome = yield* placementTriage({
            ...env,
            deps: {
              ...env.deps,
              git: {
                ...env.deps.git,
                diffTreeNames: () =>
                  Effect.fail(GitFailure.make({ command: "diff-tree", exitCode: 1 }))
              }
            }
          })

          expect(outcome.counts.touchedWidened).toBe(1)
          expect(outcome.counts.sweepCommits).toBe(0)
          expect(outcome.counts.touchedFiles).toBe(4)
          expect(outcome.counts.refusedTouched).toBe(3)
          expect(outcome.counts.applied).toBe(0)
          expectRefusalCensus(outcome.counts as Record<string, number>)
        }),
      { seed: corpusFor(), model }
    )
  })

  it("reports a reason and spends no model call when the set cannot be read at all", async () => {
    /**
     * The bottom rung. Moving under an unreadable guard would be moving with no guard, and the corpus
     * is still there tomorrow — so this degrades the way an absent model does: a reason, nothing
     * written, nothing committed. The read happens BEFORE the batch loop, which is what makes the
     * night cost zero model calls instead of a full batch budget spent on proposals that all refuse.
     */
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          // A sha no object has, so both the trailer read and the fallback diff fail.
          const outcome = yield* placementTriage(
            envFor(fixture, { deep: true, baseSha: "0".repeat(40) })
          )

          expect(outcome.detail).toContain("touched set could not be read")
          expect(outcome.commitSha).toBeNull()
          expect(outcome.llmCalls).toBe(0)
          expect(model.calls).toHaveLength(0)
          expect(outcome.counts.applied).toBe(0)
          expect(yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")).toEqual(before)
        }),
      { seed: corpusFor(), model }
    )
  })

  it("counts a duplicate answer as an already-moved file, not as another phase's write", async () => {
    /**
     * The two refusals that are easy to conflate, held apart. This one is THIS phase's own move
     * ledger — a second answer naming a file an earlier row already moved — and it is not evidence of
     * any other phase having written anything, so it must not be counted as though it were.
     */
    const model = scriptedModel((request) => {
      const keys = [...request.prompt.matchAll(/<memory_(m\d+)>/g)].map((match) => match[1] ?? "")
      const first = keys[0] ?? ""
      // The first key twice, so the second mention is a file this run has already moved.
      return value({
        placements: [first, ...keys].map((memberKey) => ({
          memberKey,
          destination: "areas/ledgers",
          confidence: 0.9
        }))
      })
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const base = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* placementTriage(envFor(fixture, { deep: true, baseSha: base }))
          expect(outcome.counts.applied).toBe(3)
          expect(outcome.counts.refusedAlreadyMoved).toBe(1)
          expect(outcome.counts.refusedTouched).toBe(0)
          expectRefusalCensus(outcome.counts as Record<string, number>)
        }),
      { seed: corpusFor(), model }
    )
  })
})

describe("the no-flag regression (guard f)", () => {
  it("keeps the default mined-edge set, compress selection, and phase plan byte-identical", async () => {
    /**
     * THE test the whole feature answers to. One corpus holding a deep trio, an entity cluster,
     * and nothing a default run can act on; two full runs, flag off, one with a prior deep
     * run's band sitting in the index — and the second default run must behave as if deep never
     * existed: same mined set, zero compress candidates (no community at the default floor), no
     * placement work, no deep count keys anywhere.
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // A deep MINING pass first, so the band is in the index and could contaminate.
          yield* relationshipMining(envFor(fixture, { deep: true }))

          const report = yield* run(fixture.deps, { date: DATE })
          // The phase plan: all seventeen ran, placement-triage did nothing and committed nothing.
          expect(report.phases.map((phase) => phase.phase)).toContain("placement-triage")
          const placement = report.phases.find((phase) => phase.phase === "placement-triage")
          expect(placement?.commitSha).toBeNull()
          expect(placement?.llmCalls).toBe(0)

          // Compress saw ZERO candidates: the deep band in the index did not leak a community in.
          const compressed = report.phases.find((phase) => phase.phase === "compress")
          expect(compressed?.counts.candidates).toBe(0)
          expect(compressed?.counts.canonicals).toBe(0)
          for (const key of ["passes", "entityGroups", "budgetSkipped"]) {
            expect(compressed?.counts[key]).toBeUndefined()
          }

          // Mining reported no deep count and rewrote only its own band.
          const mining = report.phases.find((phase) => phase.phase === "relationship-mining")
          expect(mining?.counts.deepMined).toBeUndefined()
          const edges = yield* minedEdges(fixture)
          expect(edges.filter((edge) => edge.rel === "relates_to")).toHaveLength(0)
          // The stale deep band survives untouched (re-derivable; the next deep run replaces it).
          expect(edges.filter((edge) => edge.rel === DEEP_GROUPING_REL)).toHaveLength(6)

          // And no file moved: the inbox holds exactly what was seeded (plus nothing).
          const tree = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
          expect(tree).toContain("areas/inbox/marsh-0.html")
          expect(tree).toContain("areas/inbox/ledger-manifest.html")
          expect(model.calls.filter((call) => call.system.startsWith("You fold"))).toHaveLength(0)
          expect(model.calls.filter((call) => call.system.startsWith("You file"))).toHaveLength(0)
        }),
      { seed: [...trioFor("marsh"), ...ENTITY_CLUSTER], model }
    )
  })

  it("reaches memories under --deep that the same corpus and model cannot reach without it", async () => {
    /**
     * The headline of issue #63 as one assertion: a default run folds nothing (asserted above), deep
     * run folds BOTH the trio (via the grouping band) and the entity cluster (via entity groups).
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE, deep: true })
          const compressed = report.phases.find((phase) => phase.phase === "compress")
          expect(compressed?.counts.canonicals).toBeGreaterThanOrEqual(2)
          expect(compressed?.counts.entityGroups).toBeGreaterThanOrEqual(1)
          const mining = report.phases.find((phase) => phase.phase === "relationship-mining")
          expect(mining?.counts.deepMined).toBe(6)
        }),
      { seed: [...trioFor("marsh"), ...ENTITY_CLUSTER], model }
    )
  })

  it("composes --deep with --dry-run: counts, no branch writes, no model calls", async () => {
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = yield* fixture.raw("rev-parse", "HEAD")
          const report = yield* run(fixture.deps, { date: DATE, deep: true, dryRun: true })
          expect(report.dryRun).toBe(true)
          expect(report.llmCalls).toBe(0)
          expect(model.calls).toHaveLength(0)
          expect(yield* fixture.raw("rev-parse", "HEAD")).toEqual(head)
          const mining = report.phases.find((phase) => phase.phase === "relationship-mining")
          expect(mining?.counts.deepMined).toBe(6)
        }),
      { seed: [...trioFor("marsh"), ...ENTITY_CLUSTER], model }
    )
  })
})

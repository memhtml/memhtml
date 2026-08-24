import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeLlmBudget, type PhaseEnv } from "../src/env.js"
import { assignEntityLabels, compress, ENTITY_LABEL_PREFIX } from "../src/phases/compress.js"
import { placementTriage } from "../src/phases/placement-triage.js"
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
 * nightly floor, so the NIGHTLY band cannot see one edge here and the deep band sees them all.
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
  it("writes the deep band under its own rel and leaves the nightly set untouched, and vice versa", async () => {
    /**
     * The two bands replace atomically PER REL, so a deep re-mine cannot clobber the nightly
     * `relates_to` set and a nightly re-mine cannot clobber the deep band. Driven through the real
     * phase twice — deep first, nightly second — because the clobber would happen in the SECOND
     * run's `replaceMinedEdges`, not the first's.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Deep run: both bands land.
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const afterDeep = yield* minedEdges(fixture)
          const nightly = afterDeep.filter((edge) => edge.rel === "relates_to")
          const deep = afterDeep.filter((edge) => edge.rel === DEEP_GROUPING_REL)
          // The trio's three unordered pairs are measured 0.8000-0.8220: all deep-band, none
          // nightly. Six ROWS, because the kernel offers each pair to both endpoints'
          // neighborhoods — the same doubling the nightly band has always had.
          expect(deep.length).toBe(6)
          expect(nightly.length).toBe(0)
          for (const edge of deep) {
            expect(edge.strength).toBeGreaterThanOrEqual(DEEP_MINING_COSINE_FLOOR)
            expect(edge.strength).toBeLessThan(MINING_COSINE_FLOOR)
          }

          // Nightly run over the same corpus: the deep band SURVIVES, the nightly set is replaced.
          yield* relationshipMining(envFor(fixture, { deep: false }))
          const afterNightly = yield* minedEdges(fixture)
          expect(afterNightly.filter((edge) => edge.rel === DEEP_GROUPING_REL)).toEqual(deep)
          expect(afterNightly.filter((edge) => edge.rel === "relates_to").length).toBe(0)
        }),
      { seed: [...trioFor("marsh")] }
    )
  })

  it("reports deepMined only under the flag, and mines nothing extra without it", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const nightly = yield* relationshipMining(envFor(fixture))
          expect(nightly.counts["deepMined"]).toBeUndefined()
          expect(yield* minedEdges(fixture)).toEqual([])

          const deep = yield* relationshipMining(envFor(fixture, { deep: true }))
          expect(deep.counts["deepMined"]).toBe(6)
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
          expect(outcome.counts["entityGroups"]).toBeGreaterThanOrEqual(1)
          expect(outcome.counts["canonicals"]).toBeGreaterThanOrEqual(1)
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
          expect(outcome.counts["canonicals"]).toBe(0)
          // One community, one batch, one call: the loop did NOT re-run after a quiet pass.
          expect(model.calls).toHaveLength(1)
        }),
      { seed: [...trioFor("playa")], model }
    )
  })

  it("runs a second pass after a folding pass, and the nightly phase never iterates", async () => {
    /**
     * Pass 1 folds the trio into a canonical; the loop re-indexes, re-mines, re-scores, and pass 2
     * runs over the post-fold corpus (the canonical alone forms no community, so pass 2 is quiet
     * and the loop exits at zero canonicals rather than at the cap). The nightly control makes the
     * same corpus fold ONCE with no second retention pass, observed through the call count.
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* relationshipMining(envFor(fixture, { deep: true }))
          const outcome = yield* compress(envFor(fixture, { deep: true }))
          expect(outcome.counts["canonicals"]).toBe(1)
          expect(outcome.counts["passes"]).toBe(2)
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
          expect(outcome.counts["budgetSkipped"]).toBeGreaterThanOrEqual(1)
          expect(outcome.counts["failed"]).toBe(0)
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
          expect(outcome.counts["budgetSkipped"]).toBeGreaterThanOrEqual(1)
          expect(outcome.llmCalls).toBe(0)
        }),
      { seed: [...ENTITY_CLUSTER], model }
    )
  })
})

describe("placement triage (guard c: destinations and refusals)", () => {
  /** One placement answer for every offered member, all naming one destination. */
  const placeAllInto = (destination: string, confidence = 0.9): ScriptedModel =>
    scriptedModel((request) => {
      const keys = [...request.prompt.matchAll(/<memory_(m\d+)>/g)].map((match) => match[1] ?? "")
      return value({
        placements: keys.map((memberKey) => ({ memberKey, destination, confidence }))
      })
    })

  it("moves a placed file, mints the new directory, and rewrites inbound hrefs in one commit", async () => {
    const model = placeAllInto("areas/ledgers")
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* placementTriage(envFor(fixture, { deep: true }))
          expect(outcome.counts["applied"]).toBe(3)
          expect(outcome.counts["newDirs"]).toBe(1)
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
          expect(outcome.counts["applied"]).toBe(0)
          expect(outcome.counts["refused"]).toBe(2)
          expect(outcome.counts["keptInbox"]).toBe(1)
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
          expect(outcome.counts["newDirs"]).toBe(5)
          expect(outcome.counts["applied"]).toBe(5)
          expect(outcome.counts["refused"]).toBe(2)
        }),
      { seed: singles, model }
    )
  })

  it("does nothing at all on a nightly run", async () => {
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

describe("the no-flag regression (guard f)", () => {
  it("keeps the nightly mined-edge set, compress selection, and phase plan byte-identical", async () => {
    /**
     * THE test the whole feature answers to. One corpus holding a deep trio, an entity cluster,
     * and nothing the nightly cycle can act on; two full runs, flag off, one with a prior deep
     * run's band sitting in the index — and the second nightly run must behave as if deep never
     * existed: same mined set, zero compress candidates (no community at the nightly floor), no
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
          expect(compressed?.counts["candidates"]).toBe(0)
          expect(compressed?.counts["canonicals"]).toBe(0)
          for (const key of ["passes", "entityGroups", "budgetSkipped"]) {
            expect(compressed?.counts[key]).toBeUndefined()
          }

          // Mining reported no deep count and rewrote only its own band.
          const mining = report.phases.find((phase) => phase.phase === "relationship-mining")
          expect(mining?.counts["deepMined"]).toBeUndefined()
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
     * The headline of issue #63 as one assertion: nightly run folds nothing (asserted above), deep
     * run folds BOTH the trio (via the grouping band) and the entity cluster (via entity groups).
     */
    const model = foldEverythingModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const report = yield* run(fixture.deps, { date: DATE, deep: true })
          const compressed = report.phases.find((phase) => phase.phase === "compress")
          expect(compressed?.counts["canonicals"]).toBeGreaterThanOrEqual(2)
          expect(compressed?.counts["entityGroups"]).toBeGreaterThanOrEqual(1)
          const mining = report.phases.find((phase) => phase.phase === "relationship-mining")
          expect(mining?.counts["deepMined"]).toBe(6)
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
          expect(mining?.counts["deepMined"]).toBe(6)
        }),
      { seed: [...trioFor("marsh"), ...ENTITY_CLUSTER], model }
    )
  })
})

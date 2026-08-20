import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { DETECTED_TAG, findingKeyOf, MINT_AUTHOR } from "../src/mint.js"
import {
  confirmFingerprint,
  ENTITY_CONFIDENCE_FLOOR,
  ENTITY_DETECTOR,
  entityResolution,
  REVIEW_THRESHOLD
} from "../src/phases/entity-resolution.js"
import { instantFor } from "../src/run.js"
import { scriptedModel, value, violation } from "../src/testing.js"
import {
  ENTITY_CORPUS,
  type Fixture,
  memoryHtml,
  PERSON_ALIAS,
  PERSON_CANONICAL,
  type SeedFile,
  withFixture
} from "./fixture.js"

/**
 * Entity resolution's TASK-MINTING arm: the pairs it will not decide become `confirm:` task files,
 * and it closes one only under an attestation that it actually looked.
 *
 * Its own file rather than an addition to `llm-phases.test.ts`, which is about the phase's MERGE
 * decisions. Everything here is about what the phase does with the pairs it explicitly refuses to
 * merge, and the two sets of assertions share a corpus but nothing else.
 *
 * Every case asserts on the FILES — a task at a placed path, an archive move, bytes unchanged —
 * rather than on counts alone. The counts here are the report's aggregate and the tasks are the
 * durable artifact, so a test satisfied by the counts would pass against a phase that minted nothing.
 */

const DATE = "2026-08-02"

const envFor = (fixture: Fixture, dryRun = false, date: string = DATE): PhaseEnv => {
  const instant = instantFor(date)
  return {
    deps: fixture.deps,
    runId: `sleep/${date}`,
    branch: `sleep/${date}`,
    baseSha: "",
    date,
    at: instant.at,
    atMillis: instant.millis,
    dryRun
  }
}

const atHead = (fixture: Fixture, path: string): Effect.Effect<string | undefined> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(
    Effect.map((text) => text as string | undefined),
    Effect.orElseSucceed(() => undefined)
  )

/** Every task file committed under a `tasks/` directory, path-sorted. What a mint pass produced. */
const taskPaths = (fixture: Fixture): Effect.Effect<ReadonlyArray<string>> =>
  fixture.raw("ls-tree", "-r", "--name-only", "HEAD").pipe(
    Effect.map((listing) =>
      listing
        .trim()
        .split("\n")
        .filter((path) => path.includes("/tasks/") && path.endsWith(".html"))
        .sort()
    )
  )

/** One committed task's parsed head and article, for asserting on what a human will read. */
const taskAt = (fixture: Fixture, path: string) =>
  Effect.gen(function* () {
    const html = yield* atHead(fixture, path)
    expect(html, `${path} is committed`).toBeDefined()
    return yield* parseMemory(html ?? "").pipe(Effect.orDie)
  })

/**
 * A previously-minted open `confirm:` task for one pair, exactly as a night before would have left it.
 *
 * The finding key comes from the PHASE's own `confirmFingerprint`, never from a literal. A test that
 * hard-coded a digest would still pass if the phase started keying its findings differently, which is
 * the one failure that silently re-files every task every night.
 */
const openConfirmTask = (input: {
  readonly entityType: string
  readonly alias: string
  readonly canonical: string
  readonly taskStatus?: string | undefined
}): SeedFile => ({
  path: `areas/inbox/tasks/t-${input.alias.replace(/\W+/g, "-")}-${input.canonical.replace(/\W+/g, "-")}.html`,
  html: memoryHtml({
    title: `confirm: are «${input.alias}» and «${input.canonical}» the same ${input.entityType}?`,
    claim: `confirm: are «${input.alias}» and «${input.canonical}» the same ${input.entityType}?`,
    memoryType: "task",
    taskStatus: input.taskStatus ?? "todo",
    findingKey: findingKeyOf(
      ENTITY_DETECTOR,
      confirmFingerprint(input.entityType, input.alias, input.canonical)
    ),
    createdAt: "2026-08-01T00:00:00Z",
    tags: [DETECTED_TAG]
  })
})

/**
 * A model that clusters exactly the NAMED members, at a chosen confidence.
 *
 * Member keys are resolved from the prompt rather than hard-coded, matching the existing phase
 * tests: `m1`..`mN` follow the batch's own sorted-name order, so a literal key would silently name a
 * different member the day the corpus grew. A batch offering none of the named members answers with
 * a refusal, which is how one fake drives a corpus holding two entity types without the service call
 * contributing findings a person-arm assertion would then be counting.
 *
 * The names are stated rather than "everything offered" for the same reason: `ENTITY_CORPUS` seeds a
 * THIRD person as its negative control, and a fake that clustered every offered name would fold that
 * control into the cluster and make the pair count describe the fake instead of the phase.
 *
 * The canonical is whichever member the phase's own file-count rule picks — the fake states A
 * canonical because the schema requires one, and `decomposeCluster` re-derives the orientation.
 */
const clusterOf = (options: {
  readonly names: ReadonlyArray<string>
  readonly confidence: number
  readonly evidence?: string | undefined
}) =>
  scriptedModel((request) => {
    if (!request.system.startsWith("You group entity names")) return value({ clusters: [] })
    const offered = [...request.prompt.matchAll(/<entity_(m\d+)>\s*\nname: ([^\n]+)/g)].map(
      (match) => ({ key: match[1] ?? "", name: (match[2] ?? "").trim() })
    )
    const keys = options.names.flatMap((name) => {
      const member = offered.find((one) => one.name === name)
      return member === undefined ? [] : [member.key]
    })
    if (keys.length !== options.names.length) return value({ clusters: [] })
    return value({
      clusters: [
        {
          canonicalKey: keys[0] ?? "",
          memberKeys: keys,
          confidence: options.confidence,
          evidence: options.evidence ?? "the same sign-off cadence appears under every name"
        }
      ]
    })
  })

/** Just below the floor, which is where a cluster is deferred to a human rather than corroborated. */
const BELOW_FLOOR = ENTITY_CONFIDENCE_FLOOR - 0.01

describe("a below-floor cluster mints one task per PAIR", () => {
  /**
   * A THIRD spelling of the one person, which is what separates a pair fingerprint from a cluster one.
   *
   * `saadoon`, `laith`, and `laith al-saadoon` are one subject as far as the model is concerned, and
   * the phase must file TWO questions — `saadoon`→canonical and `laith`→canonical — because that is
   * what a human answers one at a time. A cluster-keyed finding would file ONE task tonight and a
   * DIFFERENT one the night a fourth spelling arrived, leaving that night's closure pass to archive a
   * question nobody answered. (The Gate-1 critic's finding: the pair is the stable unit.)
   *
   * **Every deterministic route to these two pairs is closed**, so the model is the only thing that
   * can produce them. Measured character overlap: `saadoon` against `laith` 0.167 and against the
   * full form 0.609, `laith` against the full form 0.476 — all three below the 0.75 review band, so
   * the character pass neither merges nor counts any of them and `reviewCandidates` here is the
   * below-floor arm's own number. No person file is seeded, so the alias oracle contributes nothing.
   */
  const SURNAME_ONLY: SeedFile = {
    path: "areas/team/saadoon-reviews-the-cadence.html",
    html: memoryHtml({
      title: "Saadoon reviews the cadence before the train",
      claim: "Saadoon reviews the rollout cadence before the release train departs.",
      body: "The sign off is recorded under the surname alone.",
      memoryType: "semantic",
      createdAt: "2026-04-08T00:00:00Z",
      entities: ["person:saadoon"],
      tags: ["team"]
    })
  }

  it("files two pair tasks with the pinned claim, and merges nothing", async () => {
    const model = clusterOf({
      names: [PERSON_CANONICAL, PERSON_ALIAS, "saadoon"],
      confidence: BELOW_FLOOR
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const shortBefore = yield* atHead(fixture, "areas/team/monday-signoff.html")
          const outcome = yield* entityResolution(envFor(fixture))

          /**
           * TWO tasks, both keyed to a PAIR. The paths are read off the tree rather than predicted,
           * and then checked against the fingerprints the phase's own function produces — so this
           * fails both when the phase mints one cluster task and when it mints two tasks keyed to
           * something other than the pair.
           */
          expect(outcome.counts.taskMinted).toBe(2)
          const paths = yield* taskPaths(fixture)
          expect(paths).toHaveLength(2)

          const keys = new Set<string>()
          const claims = new Set<string>()
          for (const path of paths) {
            const doc = yield* taskAt(fixture, path)
            expect(doc.warnings).toEqual([])
            expect(doc.metas.memoryType).toBe("task")
            expect(doc.metas.taskStatus).toBe("todo")
            expect(doc.metas.author).toBe(MINT_AUTHOR)
            expect(doc.tags).toEqual([DETECTED_TAG])
            keys.add(doc.metas.findingKey ?? "")
            claims.add(doc.article.gist)
          }

          /** The two pairs of the cluster, oriented onto the three-memory full form. */
          expect(keys).toEqual(
            new Set([
              findingKeyOf(
                ENTITY_DETECTOR,
                confirmFingerprint("person", "saadoon", PERSON_CANONICAL)
              ),
              findingKeyOf(
                ENTITY_DETECTOR,
                confirmFingerprint("person", PERSON_ALIAS, PERSON_CANONICAL)
              )
            ])
          )
          /** The pinned template, verbatim, per pair. */
          expect(claims).toEqual(
            new Set([
              `confirm: are «saadoon» and «${PERSON_CANONICAL}» the same person?`,
              `confirm: are «${PERSON_ALIAS}» and «${PERSON_CANONICAL}» the same person?`
            ])
          )

          /**
           * And NOTHING merged: a below-floor cluster must not start a corroboration count either, so
           * the short form's own bytes are the assertion rather than the counts.
           */
          expect(outcome.counts.llmMerges).toBe(0)
          expect(outcome.counts.pendingCorroboration).toBe(0)
          expect(yield* atHead(fixture, "areas/team/monday-signoff.html")).toBe(shortBefore)
          /** The count STAYS beside the tasks: the report's aggregate is not replaced by them. */
          expect(outcome.counts.reviewCandidates).toBe(2)
        }),
      { seed: [...ENTITY_CORPUS, SURNAME_ONLY], model }
    )
  })

  it("carries the pair's evidence in prose: similarity, file counts, cosine, and the model's sentence", async () => {
    /**
     * The body is what makes the task answerable, and each of the four parts is invisible in a count.
     *
     * The model's sentence is the one that matters most: it is UNTRUSTED text about a corpus that
     * stores instructions, so it has to land in escaped PROSE and never in markup. The scripted
     * evidence therefore carries markup and an attribute-breaking quote, and the assertion is that
     * the parsed article holds it as TEXT with no warning and no citation.
     */
    const EVIDENCE =
      'both names sign off <script>alert(1)</script> on the "release train" cadence & the same reviews'
    const model = clusterOf({
      names: [PERSON_CANONICAL, PERSON_ALIAS, "saadoon"],
      confidence: BELOW_FLOOR,
      evidence: EVIDENCE
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* entityResolution(envFor(fixture))
          const wanted = findingKeyOf(
            ENTITY_DETECTOR,
            confirmFingerprint("person", PERSON_ALIAS, PERSON_CANONICAL)
          )
          const docs = yield* Effect.all(
            (yield* taskPaths(fixture)).map((path) => taskAt(fixture, path))
          )
          const doc = docs.find((one) => one.metas.findingKey === wanted)
          expect(doc, "the laith/laith al-saadoon pair's task is on the tree").toBeDefined()
          if (doc === undefined) return

          const text = doc.article.bodyText
          /** nameSimilarity, at the measured 0.476 for these two forms. */
          expect(text).toContain("0.476")
          /** Per-name active-file counts: the short form has one memory, the full form three. */
          expect(text).toContain(`«${PERSON_ALIAS}» is claimed by 1 active file(s)`)
          expect(text).toContain(`«${PERSON_CANONICAL}» by 3`)
          /** The centroid cosine, computable here because the model arm gathered the vectors. */
          expect(text).toMatch(/memory centroids sit at 0\.\d{3} cosine/)
          /** The model's sentence, as prose and attributed as unverified. */
          expect(text).toContain("The model's stated reason, unverified:")
          expect(text).toContain('on the "release train" cadence & the same reviews')

          /**
           * And it is TEXT, not markup: no script element survived into the article, the parse carries
           * no warning about an unknown element, and the sentence produced no citation. A phase that
           * put the model's sentence in `bodyHtml` or in an attribute would fail here.
           */
          expect(doc.article.html).not.toContain("<script")
          expect(doc.warnings).toEqual([])
          expect(doc.article.citations).toEqual([])
        }),
      { seed: [...ENTITY_CORPUS, SURNAME_ONLY], model }
    )
  })
})

describe("an undecided review-band pair", () => {
  /**
   * Two names inside the character band that no later stage settles.
   *
   * `metrics-api` against `metrics-cli` scores 0.818 — inside `REVIEW_THRESHOLD` 0.75 and below
   * `AUTO_MERGE_THRESHOLD` 0.85 — so the character pass counts it and refuses to merge it, and a
   * model that declines leaves it undecided. This is the deferral spot that does NOT need a model,
   * which is why the corpus is two files and the scripted model is a refusal.
   */
  const BAND_CORPUS: ReadonlyArray<SeedFile> = [
    {
      path: "areas/services/metrics-api-scrape.html",
      html: memoryHtml({
        title: "The metrics API serves the scrape endpoint",
        claim: "The metrics api serves the scrape endpoint on each host.",
        memoryType: "semantic",
        createdAt: "2026-04-01T00:00:00Z",
        entities: ["service:metrics-api"]
      })
    },
    {
      path: "areas/services/metrics-cli-scrape.html",
      html: memoryHtml({
        title: "The metrics CLI reads the scrape endpoint",
        claim: "The metrics cli reads the scrape endpoint on each host.",
        memoryType: "semantic",
        createdAt: "2026-04-02T00:00:00Z",
        entities: ["service:metrics-cli"]
      })
    }
  ]

  const declines = () => scriptedModel(() => value({ clusters: [] }))

  it("mints once, and recognizes its own task the next night instead of re-filing it", async () => {
    /**
     * Idempotency across two REAL nights in one fixture, which is the property a to-do list cannot
     * survive without: the same undecided pair every night forever would be one new file per night.
     *
     * Night one mints. The mint is then committed and re-indexed — the state a second night actually
     * starts from, since `openDetectedTasks` reads the index — and night two must recognize the key.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const first = yield* entityResolution(envFor(fixture))
          expect(first.counts.reviewCandidates).toBe(1)
          expect(first.counts.taskMinted).toBe(1)
          expect(first.commitSha).not.toBeNull()

          const paths = yield* taskPaths(fixture)
          expect(paths).toHaveLength(1)
          const doc = yield* taskAt(fixture, paths[0] ?? "")
          /** Oriented by the phase's file-count rule, not alphabetically by the character pass. */
          expect(doc.article.gist).toBe(
            "confirm: are «metrics-cli» and «metrics-api» the same service?"
          )
          expect(doc.metas.findingKey).toBe(
            findingKeyOf(
              ENTITY_DETECTOR,
              confirmFingerprint("service", "metrics-api", "metrics-cli")
            )
          )

          /** The index has to see night one's task, or night two's dedup arm has nothing to read. */
          yield* fixture.reindex()

          const second = yield* entityResolution(envFor(fixture, false, "2026-08-03"))
          expect(second.counts.taskAlreadyOpen).toBe(1)
          expect(second.counts.taskMinted).toBeUndefined()
          /** The count is still reported — the pair IS still awaiting a human. */
          expect(second.counts.reviewCandidates).toBe(1)
          /** And no second file: one path, and it is the same one. */
          expect(yield* taskPaths(fixture)).toEqual(paths)
        }),
      { seed: BAND_CORPUS, model: declines() }
    )
  })

  it("orients the pair the way a merge would, whichever name the band pass listed first", async () => {
    /**
     * The band pass walks its names in SORTED order, so its pair is `[metrics-api, metrics-cli]` and
     * the alphabetically-first name is not the one that survives. The corpus makes `metrics-api` the
     * heavier name by seeding it a second memory, so a phase that showed the pair as given would ask
     * the human to merge the wrong way round — and the guillemets in the claim are what make the
     * direction visible at all.
     */
    const EXTRA: SeedFile = {
      path: "areas/services/metrics-api-histogram.html",
      html: memoryHtml({
        title: "The metrics API exposes histograms",
        claim: "The metrics api exposes histogram buckets to the scrape endpoint.",
        memoryType: "semantic",
        createdAt: "2026-04-03T00:00:00Z",
        entities: ["service:metrics-api"]
      })
    }
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* entityResolution(envFor(fixture))
          const paths = yield* taskPaths(fixture)
          const doc = yield* taskAt(fixture, paths[0] ?? "")
          expect(doc.article.gist).toBe(
            "confirm: are «metrics-cli» and «metrics-api» the same service?"
          )
          /** 2 files against 1, which is the rule that decided the direction. */
          expect(doc.article.bodyText).toContain("«metrics-api» by 2")
          expect(doc.article.bodyText).toContain("«metrics-cli» is claimed by 1 active file(s)")
        }),
      { seed: [...BAND_CORPUS, EXTRA], model: declines() }
    )
  })

  it("states the similarity it has and omits the cosine when no model gathered vectors", async () => {
    /**
     * A credential-free night still MINTS, because the character pass is a real detector — but the
     * centroids are the model core's evidence and are not gathered, so the body has no cosine to
     * state. Omitting the line is the honest shape; inventing a zero would read as "these two names
     * are written about in completely different terms", which is the opposite of unknown.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.taskMinted).toBe(1)

          const doc = yield* taskAt(fixture, (yield* taskPaths(fixture))[0] ?? "")
          const text = doc.article.bodyText
          expect(text).toContain("0.818")
          expect(text).toContain(`${REVIEW_THRESHOLD} review floor`)
          expect(text).not.toContain("cosine")
          expect(text).not.toContain("The model's stated reason")
        }),
      { seed: BAND_CORPUS }
    )
  })
})

describe("closure under the universeComplete attestation", () => {
  /**
   * A pair whose task was minted by a night before and which TONIGHT nothing defers.
   *
   * The corpus is the band corpus with only ONE name, so no pair exists at all: `metrics-api` stands
   * alone. The seeded task therefore names a pair the phase cannot re-detect, which is exactly the
   * "the finding is gone" case — the pair merged, or one name left the corpus.
   */
  const LONE: ReadonlyArray<SeedFile> = [
    {
      path: "areas/services/metrics-api-scrape.html",
      html: memoryHtml({
        title: "The metrics API serves the scrape endpoint",
        claim: "The metrics api serves the scrape endpoint on each host.",
        memoryType: "semantic",
        createdAt: "2026-04-01T00:00:00Z",
        entities: ["service:metrics-api"]
      })
    },
    {
      path: "areas/services/queue-worker-depth.html",
      html: memoryHtml({
        title: "The queue worker scales on depth",
        claim: "The queue worker scales out on queue depth rather than on CPU.",
        memoryType: "semantic",
        createdAt: "2026-04-02T00:00:00Z",
        entities: ["service:queue-worker"]
      })
    }
  ]

  const GONE = openConfirmTask({
    entityType: "service",
    alias: "metrics-cli",
    canonical: "metrics-api"
  })
  const PICKED_UP = openConfirmTask({
    entityType: "service",
    alias: "payments-gateway",
    canonical: "payments-api",
    taskStatus: "doing"
  })

  it("closes an absent TODO task on a clean full pass and leaves a DOING one alone", async () => {
    /**
     * Both arms in one case, because the corpus is what makes each non-vacuous: without the `doing`
     * task the todo-only guard has nothing to refuse, and without the closure "closed nothing" would
     * pass trivially.
     *
     * The pass is clean by construction: a model IS bound and answers (so the core ran), the answer
     * decodes (no isolated failure), and both names of the one type fit one shard (no truncation).
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBeGreaterThan(0)
          expect(outcome.counts.taskClosed).toBe(1)
          expect(outcome.counts.closureSkipped).toBe(1)

          /** The absent task MOVED, and the move carries the `done` stamp with it. */
          expect(yield* atHead(fixture, GONE.path)).toBeUndefined()
          const archived = yield* taskAt(fixture, `archive/2026/${GONE.path}`)
          expect(archived.metas.taskStatus).toBe("done")
          expect(archived.metas.status).toBe("archived")

          /** The picked-up one is byte-identical: a human owns it, and a quiet detector is not a veto. */
          expect(yield* atHead(fixture, PICKED_UP.path)).toBe(PICKED_UP.html)

          /** The reason lives in the commit, which is where a reviewer asking "why" is reading. */
          const subject = yield* fixture.raw("log", "-1", "--format=%B", "HEAD")
          expect(subject).toContain("Closed 1 confirm task(s)")
        }),
      {
        seed: [...LONE, GONE, PICKED_UP],
        // Two names of one type, no cluster proposed: nothing is deferred, so both tasks are absent.
        model: scriptedModel(() => value({ clusters: [] }))
      }
    )
  })

  it("still closes on a corpus holding a SINGLETON entity type", async () => {
    /**
     * The coverage attestation is stated over PAIRS, and this is the case that makes the difference
     * observable. `assembleBatches` is given `minMembers: 2`, so an entity type holding ONE name has
     * its shard dropped and no call is made for it — correctly, because a lone name has no other name
     * to be the same subject as.
     *
     * If the shortfall were measured in NAMES, that dropped shard would read as one name the phase
     * failed to examine, `universeComplete` would be false, and closure would be withheld forever on
     * any corpus with a singleton type — which is nearly every corpus. Measured in pairs the dropped
     * shard costs nothing, because there was no pair to ask about.
     *
     * (Mutation, measured: restating the shortfall as
     * `counts.size - Σ shard.length` leaves the whole rest of this file green and fails only here,
     * with `closureSkipped: 1` in place of `taskClosed: 1`.)
     */
    const SINGLETON: SeedFile = {
      path: "areas/team/priya-owns-the-runbook.html",
      html: memoryHtml({
        title: "Priya owns the deploy runbook",
        claim: "Priya owns the deploy runbook and reviews every rollback step.",
        memoryType: "semantic",
        createdAt: "2026-04-04T00:00:00Z",
        entities: ["person:priya"]
      })
    }
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * Non-vacuous in both directions: the `person` type really does hold exactly one name (so
           * the dropped shard exists), and the `service` type really was called (so "complete" is not
           * standing on a night that asked nothing at all).
           */
          const names = yield* fixture.db
            .all<{ entity_type: string; entity_name: string }>(
              "SELECT DISTINCT entity_type, entity_name FROM file_entities ORDER BY entity_type, entity_name"
            )
            .pipe(Effect.orDie)
          expect(names.filter((one) => one.entity_type === "person")).toHaveLength(1)

          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBe(1)
          expect(outcome.counts.taskClosed).toBe(1)
          expect(yield* atHead(fixture, GONE.path)).toBeUndefined()
        }),
      {
        seed: [...LONE, SINGLETON, GONE],
        model: scriptedModel(() => value({ clusters: [] }))
      }
    )
  })

  it("closes NOTHING when a batch's model call failed", async () => {
    /**
     * The attestation's isolated-failure clause, and the failure mode it prevents is total: a batch
     * that answers nothing defers nothing, so every open task looks absent and one bad night would
     * archive the whole detected backlog.
     *
     * (Mutation to run: drop `isolatedFailures === 0` from the `universeComplete` conjunction. This
     * case then closes the todo task and `closureSkipped` becomes `taskClosed`.)
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBeGreaterThan(0)
          expect(outcome.counts.taskClosed).toBeUndefined()
          /** Both open tasks withheld, which is what `closureSkipped` means on an incomplete night. */
          expect(outcome.counts.closureSkipped).toBe(2)

          /** Both survive, on disk, unchanged. */
          expect(yield* atHead(fixture, GONE.path)).toBe(GONE.html)
          expect(yield* atHead(fixture, PICKED_UP.path)).toBe(PICKED_UP.html)
        }),
      {
        seed: [...LONE, GONE, PICKED_UP],
        model: scriptedModel(() => violation("scripted off-schema clusters"))
      }
    )
  })

  it("closes NOTHING on a night with no model bound at all", async () => {
    /**
     * A credential-free night runs the deterministic passes and mints from them, but it examined no
     * pair the MODEL would have judged — so a task minted from a below-floor cluster cannot be
     * re-detected and its silence is not evidence. The deterministic arms being complete is not the
     * universe being complete.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.taskClosed).toBeUndefined()
          expect(outcome.counts.closureSkipped).toBe(2)
          expect(yield* atHead(fixture, GONE.path)).toBe(GONE.html)
        }),
      { seed: [...LONE, GONE, PICKED_UP] }
    )
  })

  it("leaves a still-deferred pair's task open rather than closing and re-minting it", async () => {
    /**
     * The other half of closure, and it is what keeps the case above from passing against a phase
     * that closes everything and re-files it: on a CLEAN pass where the pair is still undecided, the
     * task neither closes nor duplicates. `taskAlreadyOpen` with no `taskClosed` is the shape.
     */
    const BAND: ReadonlyArray<SeedFile> = [
      ...LONE,
      {
        path: "areas/services/metrics-cli-scrape.html",
        html: memoryHtml({
          title: "The metrics CLI reads the scrape endpoint",
          claim: "The metrics cli reads the scrape endpoint on each host.",
          memoryType: "semantic",
          createdAt: "2026-04-03T00:00:00Z",
          entities: ["service:metrics-cli"]
        })
      }
    ]
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, GONE.path)
          const outcome = yield* entityResolution(envFor(fixture))

          expect(outcome.counts.taskAlreadyOpen).toBe(1)
          expect(outcome.counts.taskMinted).toBeUndefined()
          expect(outcome.counts.taskClosed).toBeUndefined()
          /** The `doing` task is still absent-and-refused, so the guard is exercised here too. */
          expect(outcome.counts.closureSkipped).toBe(1)
          /** And the still-deferred task is untouched, byte for byte. */
          expect(yield* atHead(fixture, GONE.path)).toBe(before)
          expect(yield* taskPaths(fixture)).toEqual([GONE.path, PICKED_UP.path].sort())
        }),
      {
        seed: [...BAND, GONE, PICKED_UP],
        model: scriptedModel(() => value({ clusters: [] }))
      }
    )
  })
})

describe("a dry run", () => {
  it("mints nothing, closes nothing, and leaves the tree byte-identical", async () => {
    /**
     * The phase skips the model entirely on a dry run, so `universeComplete` is false there and the
     * kernel no-ops its writes as well — two independent reasons nothing may reach the tree. Asserted
     * on HEAD and on the staging area, because the kernel STAGES and a leak would be invisible in a
     * commit-only check.
     *
     * **The corpus is one a real night WOULD write to**, which is what keeps this from passing
     * vacuously: the band pair at 0.818 is a deterministic deferral the character pass finds with no
     * model at all (the case above mints exactly this), and the seeded task names a pair that is NOT
     * in tonight's set, so a real complete night has both a mint and a closure to perform. Everything
     * here is therefore withheld rather than merely absent.
     */
    const BAND: ReadonlyArray<SeedFile> = [
      {
        path: "areas/services/metrics-api-scrape.html",
        html: memoryHtml({
          title: "The metrics API serves the scrape endpoint",
          claim: "The metrics api serves the scrape endpoint on each host.",
          memoryType: "semantic",
          createdAt: "2026-04-01T00:00:00Z",
          entities: ["service:metrics-api"]
        })
      },
      {
        path: "areas/services/metrics-cli-scrape.html",
        html: memoryHtml({
          title: "The metrics CLI reads the scrape endpoint",
          claim: "The metrics cli reads the scrape endpoint on each host.",
          memoryType: "semantic",
          createdAt: "2026-04-02T00:00:00Z",
          entities: ["service:metrics-cli"]
        })
      }
    ]
    const STALE = openConfirmTask({
      entityType: "service",
      alias: "queue-workers",
      canonical: "queue-worker"
    })
    const model = clusterOf({ names: ["metrics-api", "metrics-cli"], confidence: BELOW_FLOOR })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const before = yield* taskPaths(fixture)
          expect(before).toEqual([STALE.path])

          const outcome = yield* entityResolution(envFor(fixture, true))

          /** No model call at all, so the dry run costs nothing and manufactures no evidence. */
          expect(model.calls).toEqual([])
          expect(outcome.commitSha).toBeNull()

          /**
           * `taskMinted: 1` on a dry run is the PREVIEW and not a leak, which is the kernel's stated
           * asymmetry (`mint.ts` at the `env.dryRun` early return): everything above the two write
           * lines runs, so an operator sizing the night gets the real count and the real placed path.
           * The band pair is the same one the character-pass case above writes a task for, so this
           * number also says the deferral was genuinely detected — a dry run reporting nothing here
           * would be indistinguishable from a corpus with no work in it.
           */
          expect(outcome.counts.taskMinted).toBe(1)
          expect(outcome.counts.reviewCandidates).toBe(1)
          /**
           * And `closureSkipped` rather than `taskClosed`, from the OTHER direction: a dry run skips
           * the model, so `universeComplete` is false and the stale task is withheld by the
           * attestation before the kernel's own dry-run guard is even reached.
           */
          expect(outcome.counts.taskClosed).toBeUndefined()
          expect(outcome.counts.closureSkipped).toBe(1)

          /** Nothing committed and nothing staged, and the stale task is still exactly where it was. */
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
          expect(yield* taskPaths(fixture)).toEqual(before)
          expect(yield* atHead(fixture, STALE.path)).toBe(STALE.html)
        }),
      { seed: [...BAND, STALE], model }
    )
  })
})

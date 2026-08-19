import { archivePathFor } from "@memhtml/contracts/paths"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { ENTITY_CLUSTER_SYSTEM } from "../src/llm.js"
import { arcSynthesis } from "../src/phases/arc-synthesis.js"
import { COMPRESS_MEMBER_CHARS, compress } from "../src/phases/compress.js"
import {
  CONFLICT_COSINE_FLOOR,
  conflictDetection,
  PROMOTION_DETECTIONS
} from "../src/phases/conflict-detection.js"
import { ENTITY_CONFIDENCE_FLOOR, entityResolution } from "../src/phases/entity-resolution.js"
import { instantFor } from "../src/run.js"
import { conflictCandidates } from "../src/sql.js"
import { type ScriptedReply, scriptedModel, unavailable, value, violation } from "../src/testing.js"
import {
  DEDUP_CORPUS,
  ENTITY_CORPUS,
  entityCorroborations,
  type Fixture,
  memoryHtml,
  PERSON_ALIAS,
  PERSON_CANONICAL,
  personFile,
  type SeedFile,
  seedCorroboration,
  withFixture
} from "./fixture.js"

/**
 * The three model-driven phases.
 *
 * Each is exercised through the SCRIPTED CLIENT rather than a stubbed phase, so every scripted answer
 * is decoded by the production decoder — `onExcessProperty: "error"` included. A fixture that drifts
 * from a phase's schema fails here rather than proving the phase works against a shape the real model
 * could never produce.
 */

const DATE = "2026-08-02"

/**
 * One phase environment. `date` is a parameter so a test can drive a genuinely LATER NIGHT, which is
 * what a two-night corroboration gate needs: `at` derives from the date, and the same date is what a
 * resume of one run reuses.
 */
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

const SAFE = "areas/deploy/blue-green-is-safe.html"
const NOT_SAFE = "areas/deploy/blue-green-is-not-safe.html"

describe("conflict-detection", () => {
  it("promotes into BOTH files only once detections reach the corroboration gate", async () => {
    /**
     * The state plane is seeded one detection short, so THIS run's detection is the second — the exact
     * boundary. A phase that promoted on the first detection would let one machine suspicion reach a
     * file, which is the one-way door the corroboration gate exists to hold.
     */
    const model = scriptedModel(() =>
      value({ verdict: "contradicts", confidence: 0.95, rationale: "one says safe, one says not" })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * The seeded row's orientation is READ from the scan rather than assumed. `conflictCandidates`
           * emits each unordered pair once as `dst < src`, so hard-coding the two paths would silently
           * seed the mirror row and the promotion would never fire — a test that passed for the wrong
           * reason on the day the scan's ordering changed.
           */
          const candidates = yield* conflictCandidates(fixture.db, {
            floor: CONFLICT_COSINE_FLOOR,
            perSourceK: 5,
            limit: 200
          }).pipe(Effect.orDie)
          const pair = candidates.find(
            (one) =>
              (one.src === SAFE && one.dst === NOT_SAFE) ||
              (one.src === NOT_SAFE && one.dst === SAFE)
          )
          expect(pair).toBeDefined()
          yield* seedCorroboration(fixture.db, {
            srcPath: pair?.src ?? "",
            dstPath: pair?.dst ?? "",
            detections: PROMOTION_DETECTIONS - 1
          })

          const outcome = yield* conflictDetection(envFor(fixture))

          expect(outcome.counts.judged).toBeGreaterThan(0)
          expect(outcome.counts.contradictions).toBeGreaterThan(0)
          expect(outcome.counts.promoted).toBe(1)
          expect(outcome.commitSha).not.toBeNull()
          expect(outcome.llmCalls).toBe(outcome.counts.judged)

          /**
           * BOTH files carry the link. A contradiction is symmetric, and a reader arriving at either
           * file must see it — a one-sided promotion would make the fact invisible from one direction.
           */
          const safe = yield* atHead(fixture, SAFE)
          const notSafe = yield* atHead(fixture, NOT_SAFE)
          expect(safe).toContain(`<link rel="memhtml-contradicts" href="/${NOT_SAFE}">`)
          expect(notSafe).toContain(`<link rel="memhtml-contradicts" href="/${SAFE}">`)

          // The edge is now FILE-BORNE, which is what makes it survive `rm index.db`.
          const doc = yield* parseMemory(safe ?? "")
          expect(doc.links.some((one) => one.rel === "contradicts")).toBe(true)

          // Detection ONLY: neither side was superseded, archived, or expired.
          expect(doc.metas.status).toBe("active")
          expect(safe).not.toContain("memhtml-superseded-by")
          expect(yield* atHead(fixture, archivePathFor(SAFE, 2026))).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("counts a detection without promoting when it is the first one", async () => {
    const model = scriptedModel(() =>
      value({ verdict: "contradicts", confidence: 0.95, rationale: "conflicting claims" })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* conflictDetection(envFor(fixture))
          expect(outcome.counts.contradictions).toBeGreaterThan(0)
          expect(outcome.counts.promoted).toBe(0)
          // No promotion means no commit at all — the counter lives in the state plane.
          expect(outcome.commitSha).toBeNull()
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("asserts nothing on a below-floor confidence, however certain the verdict reads", async () => {
    const model = scriptedModel(() =>
      value({ verdict: "contradicts", confidence: 0.5, rationale: "possibly conflicting" })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Every candidate is seeded one detection short, so ONLY the confidence floor can refuse.
          const candidates = yield* conflictCandidates(fixture.db, {
            floor: CONFLICT_COSINE_FLOOR,
            perSourceK: 5,
            limit: 200
          }).pipe(Effect.orDie)
          for (const candidate of candidates) {
            yield* seedCorroboration(fixture.db, {
              srcPath: candidate.src,
              dstPath: candidate.dst,
              detections: PROMOTION_DETECTIONS - 1
            })
          }
          const outcome = yield* conflictDetection(envFor(fixture))
          expect(outcome.counts.judged).toBeGreaterThan(0)
          expect(outcome.counts.contradictions).toBe(0)
          expect(outcome.counts.promoted).toBe(0)
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("skips a bad response per item and keeps judging the rest", async () => {
    /**
     * The first call fails and the second succeeds. Per-item isolation means the phase reports one skip
     * and one judgement — a night that judged 199 pairs and lost the 200th has done 199 pairs of work.
     */
    const model = scriptedModel(
      (_request, offset): ScriptedReply =>
        offset === 0
          ? violation("off-schema")
          : value({ verdict: "neutral", confidence: 0.9, rationale: "compatible" })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* conflictDetection(envFor(fixture))
          expect(outcome.counts.skipped).toBe(1)
          expect(outcome.counts.judged).toBeGreaterThan(0)
          expect(outcome.llmCalls).toBe(
            (outcome.counts.skipped ?? 0) + (outcome.counts.judged ?? 0)
          )
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("is skipped with a reason, not failed, when no model is bound", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* conflictDetection(envFor(fixture))
          expect(outcome.detail).toBe("no model bound")
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.commitSha).toBeNull()
        }),
      { seed: DEDUP_CORPUS }
    )
  })
})

describe("arc-synthesis", () => {
  it("makes one triage call, one execute call per actionable arc, and ONE COMMIT PER ARC", async () => {
    const model = scriptedModel(
      (request): ScriptedReply =>
        request.system.startsWith("You triage")
          ? value({
              entries: [
                {
                  slug: "",
                  title: "Drain before reverting",
                  action: "create",
                  rationale: "Two memories describe the same rollback discipline.",
                  evidenceKeys: ["e1", "e2"]
                }
              ]
            })
          : value({
              title: "Drain before reverting",
              claim: "Drain a load balancer before reverting the change behind it.",
              paragraphs: [
                "If a rollback touches a service behind a VIP, drain the VIP first and revert second.",
                "The reverse order leaves connections pinned to a fleet that is going away."
              ]
            })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = Number((yield* fixture.raw("rev-list", "--count", "HEAD")).trim())
          const outcome = yield* arcSynthesis(envFor(fixture))

          expect(outcome.counts.written).toBe(1)
          // One triage + one execute.
          expect(outcome.llmCalls).toBe(2)
          expect(outcome.commitSha).not.toBeNull()
          // ONE commit for the one arc.
          expect(Number((yield* fixture.raw("rev-list", "--count", "HEAD")).trim())).toBe(
            before + 1
          )

          // The arc landed under areas/arcs/ with a slug the PHASE minted, not the model.
          const arcPath = "areas/arcs/drain-before-reverting.html"
          const arc = yield* atHead(fixture, arcPath)
          expect(arc).toBeDefined()
          const doc = yield* parseMemory(arc ?? "")
          expect(doc.metas.memoryType).toBe("arc")
          expect(doc.article.gist).toContain("Drain a load balancer")
          expect(doc.metas.author).toBe("agent:sleep")

          /**
           * Each supporting memory gained `memhtml-part-of` toward the arc. Without the inbound links the
           * synthesis would be unattributable after a rebuild — the arc's own file names no paths.
           */
          const supporters = yield* Effect.forEach(
            DEDUP_CORPUS.map((file) => file.path),
            (path) => atHead(fixture, path)
          )
          const linked = supporters.filter((html) =>
            (html ?? "").includes(`<link rel="memhtml-part-of" href="/${arcPath}">`)
          )
          expect(linked.length).toBeGreaterThan(0)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("refuses an update naming an arc it was not offered", async () => {
    /**
     * A model-supplied slug is a model-supplied FILE PATH. The evidence and arc handles are opaque
     * ordinals the phase controls, so an `update` naming anything else is a model error rather than an
     * instruction — and must not become a write.
     */
    const model = scriptedModel(
      (request): ScriptedReply =>
        request.system.startsWith("You triage")
          ? value({
              entries: [
                {
                  slug: "../../etc/passwd",
                  title: "Not a real arc",
                  action: "update",
                  rationale: "invented",
                  evidenceKeys: []
                }
              ]
            })
          : value({ title: "x", claim: "y", paragraphs: ["z"] })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* arcSynthesis(envFor(fixture))
          expect(outcome.counts.written).toBe(0)
          expect(outcome.counts.skipped).toBe(1)
          // Only the triage call was made: nothing was worth executing.
          expect(outcome.llmCalls).toBe(1)
          expect(outcome.commitSha).toBeNull()
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("commits the arcs it wrote before a later arc's call fails", async () => {
    /**
     * Per-item isolation reaching the GIT HISTORY, not only the counters: two arcs planned, the second
     * execute call fails, and the first arc's commit stands.
     */
    const model = scriptedModel((request, offset): ScriptedReply => {
      if (request.system.startsWith("You triage")) {
        return value({
          entries: [
            {
              slug: "",
              title: "First arc",
              action: "create",
              rationale: "r1",
              evidenceKeys: ["e1"]
            },
            {
              slug: "",
              title: "Second arc",
              action: "create",
              rationale: "r2",
              evidenceKeys: ["e2"]
            }
          ]
        })
      }
      return offset === 1
        ? value({ title: "First arc", claim: "The first principle.", paragraphs: ["Because."] })
        : unavailable("throttled on the second arc")
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* arcSynthesis(envFor(fixture))
          expect(outcome.counts.written).toBe(1)
          expect(outcome.counts.skipped).toBe(1)
          expect(outcome.llmCalls).toBe(3)
          // The first arc is committed and reachable; the second was never written.
          expect(yield* atHead(fixture, "areas/arcs/first-arc.html")).toBeDefined()
          expect(yield* atHead(fixture, "areas/arcs/second-arc.html")).toBeUndefined()
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })
})

describe("compress", () => {
  /**
   * A community of four memories that are pairwise near-neighbors AND authored-linked into one
   * community, all four in the COMPRESS band. Label propagation needs the edges: a similarity group is
   * not a community, and communities below the minimum size collapse to `undefined` and are skipped.
   */
  const COMMUNITY: ReadonlyArray<SeedFile> = [
    {
      path: "areas/cache/cache-one.html",
      html: memoryHtml({
        title: "Cache warmup one",
        claim: "The build cache warms from the shared volume on the first request.",
        body: "Warmup pulls the shared volume manifest and hydrates the local layer store slowly.",
        createdAt: "2026-05-10T00:00:00Z",
        confidence: "0.50",
        importance: "4",
        links: [
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-two.html" },
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-three.html" }
        ]
      })
    },
    {
      path: "areas/cache/cache-two.html",
      html: memoryHtml({
        title: "Cache warmup two",
        claim: "The build cache hydrates its local layer store from the shared volume manifest.",
        body: "Warmup pulls the shared volume manifest and hydrates the local layer store slowly.",
        createdAt: "2026-05-11T00:00:00Z",
        confidence: "0.50",
        importance: "4",
        links: [
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-one.html" },
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-three.html" }
        ]
      })
    },
    {
      path: "areas/cache/cache-three.html",
      html: memoryHtml({
        title: "Cache warmup three",
        claim: "Warmup of the build cache reads the manifest before hydrating the layer store.",
        body: "Warmup pulls the shared volume manifest and hydrates the local layer store slowly.",
        createdAt: "2026-05-12T00:00:00Z",
        confidence: "0.50",
        importance: "4",
        links: [
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-one.html" },
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-two.html" }
        ]
      })
    }
  ]

  /**
   * The same community with bodies far past {@link COMPRESS_MEMBER_CHARS}, so the per-member budget
   * actually bites. Every seeded body in the corpus above is a couple of hundred characters, which
   * would leave the budget's wiring unexercised: it could be dropped entirely and every test stay
   * green. The filler repeats one sentence, so the memories stay near-neighbors and still form one
   * community.
   */
  const WIDE_COMMUNITY: ReadonlyArray<SeedFile> = COMMUNITY.map((file) => ({
    path: file.path,
    html: file.html.replace(
      "layer store slowly.",
      `layer store slowly. ${"The warmup reads the shared volume manifest. ".repeat(80)}`
    )
  }))

  /**
   * A SECOND community, disjoint from the first in both vocabulary and edges, so label propagation
   * separates them and the phase has two communities to walk rather than one. Paths sort AFTER
   * `areas/cache/*`, which is what makes the walk order observable.
   */
  const SECOND_COMMUNITY: ReadonlyArray<SeedFile> = ["one", "two", "three"].map((name, offset) => ({
    path: `areas/queue/queue-${name}.html`,
    html: memoryHtml({
      title: `Queue drain ${name}`,
      claim: `The queue drain worker leases a visibility window before acknowledging (${name}).`,
      body: "Draining leases a visibility window per message and acknowledges after the handler returns.",
      createdAt: `2026-05-1${offset + 3}T00:00:00Z`,
      confidence: "0.50",
      importance: "4",
      links: ["one", "two", "three"]
        .filter((other) => other !== name)
        .map((other) => ({
          rel: "memhtml-relates-to",
          href: `/areas/queue/queue-${other}.html`
        }))
    })
  }))

  it("walks its communities lexicographically, so a night's call order is reproducible", async () => {
    /**
     * One commit per batch means community walk order is also commit order. The kernel preserves the
     * order it is handed and imposes none of its own, so this ordering is the phase's to state, and
     * this is the test that makes it observable: two communities whose paths sort in a known order,
     * asserted on which prompt went out first.
     */
    const model = scriptedModel(() =>
      value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* compress(envFor(fixture))
          expect(model.calls).toHaveLength(2)
          // `areas/cache` sorts before `areas/queue`, and the community labels follow the paths.
          expect(model.calls[0]?.prompt).toContain("Cache warmup")
          expect(model.calls[0]?.prompt).not.toContain("Queue drain")
          expect(model.calls[1]?.prompt).toContain("Queue drain")
        }),
      { seed: [...COMMUNITY, ...SECOND_COMMUNITY], model }
    )
  })

  it("cuts each member's text at the per-member budget, so one long memory cannot fill a batch", async () => {
    /**
     * The budget bounds what one batch costs. Without it, a single memory with a long body would crowd
     * out the other seven members' facts, and a fold that never saw those facts would archive them.
     * Asserted on the offered text rather than on a token count, because the slice is where the phase
     * can actually be wrong.
     */
    const model = scriptedModel(() =>
      value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* compress(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            const blocks = call.prompt.match(/<member_m\d+>\n([\s\S]*?)\n<\/member_m\d+>/g) ?? []
            expect(blocks.length).toBeGreaterThan(1)
            for (const block of blocks) {
              // The wrapper's own tags are outside the budgeted text, so the block is slightly wider.
              expect(block.length).toBeLessThan(COMPRESS_MEMBER_CHARS + 100)
            }
            // And the untruncated body really was longer, so the assertion above is not vacuous.
            expect(call.prompt).not.toContain(
              "The warmup reads the shared volume manifest. ".repeat(80)
            )
          }
        }),
      { seed: WIDE_COMMUNITY, model }
    )
  })

  it("archives only the members the model names, and never one it omits", async () => {
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim:
          "Build cache warmup reads the shared volume manifest, then hydrates the layer store.",
        paragraphs: [
          "Warmup is a two-step read: the manifest first, the layer store second.",
          "It is slow on the first request after a cold start and fast afterwards."
        ],
        // m3 is deliberately OMITTED: the canonical does not claim to carry it.
        absorbedKeys: ["m1", "m2"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))

          expect(outcome.counts.canonicals).toBe(1)
          expect(outcome.counts.archived).toBe(2)
          expect(outcome.commitSha).not.toBeNull()

          const canonical = "areas/cache/build-cache-warmup.html"
          const written = yield* atHead(fixture, canonical)
          expect(written).toBeDefined()
          const doc = yield* parseMemory(written ?? "")
          // Every distinct fact survived into the canonical.
          expect(doc.article.bodyText).toContain("manifest")
          expect(doc.article.bodyText).toContain("layer store")
          // The canonical supersedes exactly the two it absorbed, at their ARCHIVE paths.
          const supersedes = doc.links.filter((one) => one.rel === "supersedes")
          expect(supersedes).toHaveLength(2)
          expect(supersedes.every((one) => one.href.startsWith("/archive/2026/"))).toBe(true)

          /**
           * EXACTLY ONE MEMBER IS STILL LIVE, and it is the one the model omitted. Which path that is
           * follows from the batch's own key assignment (path-ordered `m1`, `m2`, `m3`), so the test
           * derives it from what actually moved rather than restating the ordering — the assertion is
           * that the omitted member survived, not which name it has.
           */
          const stillLive = yield* Effect.forEach(
            COMMUNITY.map((file) => file.path),
            (path) => atHead(fixture, path).pipe(Effect.map((html) => ({ path, html })))
          )
          const live = stillLive.filter((one) => one.html !== undefined)
          expect(live).toHaveLength(1)
          // And it was NOT archived under any name.
          expect(yield* atHead(fixture, archivePathFor(live[0]?.path ?? "", 2026))).toBeUndefined()
          // The two that moved are exactly the two the canonical supersedes.
          const archivedPaths = new Set(supersedes.map((one) => one.href.slice(1)))
          for (const one of stillLive.filter((candidate) => candidate.html === undefined)) {
            expect(archivedPaths.has(archivePathFor(one.path, 2026))).toBe(true)
          }
        }),
      { seed: COMMUNITY, model }
    )
  })

  it("asks for its system prompt to be cached, and repeats it byte-identically per batch", async () => {
    /**
     * The system prompt and the tool schema are the same bytes on every batch of a night, so they are
     * the cacheable prefix and only the member list is new. Asserted at the PHASE, because the flag
     * lives in the kernel's call helper: a phase that reached `generateObject` directly would compile,
     * pass every other test, and quietly re-bill its whole prefix on each batch.
     */
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim: "Build cache warmup reads the manifest, then hydrates the layer store.",
        paragraphs: ["A two-step read."],
        absorbedKeys: ["m1", "m2"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* compress(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            expect(call.cacheSystem).toBe(true)
            expect(call.system).toBe(model.calls[0]?.system)
          }
        }),
      { seed: COMMUNITY, model }
    )
  })

  it("assigns m1..mN by path order, so the same corpus resolves the same keys twice", async () => {
    /**
     * The determinism contract the kernel states and the phase owns: the kernel preserves the order it
     * is handed, and this phase hands over members sorted by `row.path`. So `m1` is `cache-one`, `m2`
     * is `cache-three`, and `m3` is `cache-two`, and absorbing `m1` and `m2` archives exactly those two.
     *
     * Asserted on the RESOLVED PATHS rather than on the prompt, because the keys are what a model's
     * answer is turned into a write through. Without this, the sort could reverse and every other
     * compress test would stay green while a night's key assignment moved from under the answer it is
     * paired with.
     */
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim: "Build cache warmup reads the shared volume manifest first.",
        paragraphs: ["A two-step read."],
        absorbedKeys: ["m1", "m2"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.archived).toBe(2)
          // Path order over the three seeded members is one, three, two.
          expect(yield* atHead(fixture, "areas/cache/cache-one.html")).toBeUndefined()
          expect(yield* atHead(fixture, "areas/cache/cache-three.html")).toBeUndefined()
          expect(yield* atHead(fixture, "areas/cache/cache-two.html")).toBeDefined()
        }),
      { seed: COMMUNITY, model }
    )
  })

  it("offers each member under an opaque key and never under its path", async () => {
    /**
     * `absorbedKeys` decides which files are archived, so a prompt that named a path would let the
     * model answer with a write target instead of choosing among the ones it was offered.
     */
    const model = scriptedModel(() =>
      value({ title: "x", claim: "y", paragraphs: [], absorbedKeys: [] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* compress(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            expect(call.prompt).toContain("<member_m1>")
            for (const file of COMMUNITY) {
              expect(call.prompt).not.toContain(file.path)
            }
          }
        }),
      { seed: COMMUNITY, model }
    )
  })

  it("archives nothing when the model names a key the batch never offered", async () => {
    /**
     * `m9` is not in a batch of three, and `areas/cache/cache-one.html` is a path rather than a key.
     * Both resolve to nothing, so the fold falls below its two-member floor and every member stays
     * live. A phase that treated an unresolvable key as a path would archive a file on a hallucination.
     */
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim: "Build cache warmup reads the manifest first.",
        paragraphs: ["A two-step read."],
        absorbedKeys: ["m9", "areas/cache/cache-one.html", "m1"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.canonicals).toBe(0)
          expect(outcome.counts.archived).toBe(0)
          expect(outcome.counts.skipped).toBeGreaterThan(0)
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          for (const file of COMMUNITY) {
            expect(yield* atHead(fixture, file.path)).toBeDefined()
          }
        }),
      { seed: COMMUNITY, model }
    )
  })

  it("archives nothing when the model refuses to fold", async () => {
    /**
     * `absorbedKeys: []` is a valid answer — "these do not describe one thing". A phase that folded
     * anyway would destroy three memories on a model's uncertainty.
     */
    const model = scriptedModel(() =>
      value({
        title: "Unrelated memories",
        claim: "These memories do not describe one thing.",
        paragraphs: ["No fold is warranted."],
        absorbedKeys: []
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.canonicals).toBe(0)
          expect(outcome.counts.skipped).toBeGreaterThan(0)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          for (const file of COMMUNITY) {
            expect(yield* atHead(fixture, file.path)).toBeDefined()
          }
        }),
      { seed: COMMUNITY, model }
    )
  })

  it("counts on a dry run and writes nothing", async () => {
    const model = scriptedModel(() =>
      value({ title: "x", claim: "y", paragraphs: ["z"], absorbedKeys: ["m1", "m2"] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* compress(envFor(fixture, true))
          expect(outcome.counts.batches).toBeGreaterThan(0)
          expect(outcome.counts.canonicals).toBe(0)
          expect(outcome.llmCalls).toBe(0)
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: COMMUNITY, model }
    )
  })
})

/**
 * Entity resolution's model core: one structured clustering call per entity type, then the
 * deterministic post-pass that decides whether the answer becomes a rewrite.
 *
 * The corpus is {@link ENTITY_CORPUS}, whose one person is recorded under a short and a full name at
 * 0.476 character overlap — below the review band, which is the live defect. Every case below either
 * writes the merge or proves it was held back, and the two are asserted on the FILES rather than on the
 * counts, because a count agreeing with a phase that wrote nothing is what a vacuous test looks like.
 */
describe("entity-resolution", () => {
  const SHORT_FORM = "areas/team/monday-signoff.html"
  const MIXED_CASE = "areas/team/release-train-owner.html"
  const SANJU = "areas/team/search-relevance-owner.html"
  const CHECKOUT = "areas/services/checkout-token-rejection.html"
  const PAYMENTS = "areas/services/payments-token-rejection.html"

  /** The `<meta>` line a `person:` entity holds, as the serializer writes it. */
  const personMeta = (name: string) => `<meta name="memhtml-entity" content="person:${name}">`

  /**
   * A model that clusters the two spellings of the one person and nothing else.
   *
   * The member KEYS are resolved from the prompt rather than hard-coded, because `m1`..`mN` follow the
   * batch's own sorted-name order and a hard-coded key would silently name a different member the day
   * the corpus grew — a test that passed for the wrong reason. `confidence` is a parameter so one fake
   * drives the above-floor and below-floor cases.
   */
  const clusterModel = (options: { readonly confidence?: number | undefined } = {}) =>
    scriptedModel((request) => {
      if (!request.system.startsWith("You group entity names")) return value({ clusters: [] })
      const keyOf = (name: string): string | undefined =>
        /** Each member is wrapped as `<entity_mN>` with `name: <the name>` on its first line. */
        [...request.prompt.matchAll(/<entity_(m\d+)>\s*\nname: ([^\n]+)/g)].find(
          (match) => match[2]?.trim() === name
        )?.[1]
      const canonicalKey = keyOf(PERSON_CANONICAL)
      const aliasKey = keyOf(PERSON_ALIAS)
      if (canonicalKey === undefined || aliasKey === undefined) return value({ clusters: [] })
      return value({
        clusters: [
          {
            canonicalKey,
            memberKeys: [canonicalKey, aliasKey],
            confidence: options.confidence ?? 0.9,
            evidence: "the same rollout cadence and release train sign off under both names"
          }
        ]
      })
    })

  /**
   * Every `person:` entity name any COMMITTED file claims, read out of the tree.
   *
   * Read from git rather than from `file_entities`, and that is not a convenience. Every phase reads its
   * candidates from an index refreshed once in preflight and not again, so the index still lists the
   * pre-merge names after the phase's own commit — a test asserting the merge against the index would
   * fail against a phase that had done the work correctly. The TREE is the system of record.
   */
  const personNames = (fixture: Fixture): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const listing = yield* fixture.raw("ls-tree", "-r", "--name-only", "HEAD")
      const names = new Set<string>()
      for (const path of listing.trim().split("\n")) {
        if (!path.endsWith(".html")) continue
        const html = yield* atHead(fixture, path)
        for (const match of (html ?? "").matchAll(
          /<meta name="memhtml-entity" content="person:([^"]+)">/g
        )) {
          if (match[1] !== undefined) names.add(match[1])
        }
      }
      return [...names].sort()
    })

  it("holds a model-only merge back on night one, counts it, and applies it on night two", async () => {
    /**
     * The corroboration gate, at the boundary that matters, across two real runs.
     *
     * A merge the model alone proposes rewrites every `memhtml-entity` meta naming the alias and fuses
     * two subjects' memories permanently — no later commit separates them. So the first night COUNTS and
     * the second night writes, and both halves are asserted: a phase that promoted on the first
     * detection would fail the first half, and a phase that never promoted would fail the second.
     *
     * The second run passes a LATER `at`, which is what makes it a different night. The same scripted
     * reply is used for both, so what changed between them is the corroboration state and nothing else.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, SHORT_FORM)
          expect(before).toContain(personMeta(PERSON_ALIAS))

          const first = yield* entityResolution(envFor(fixture))
          expect(first.llmCalls).toBeGreaterThan(0)
          expect(first.counts.pendingCorroboration).toBe(1)
          expect(first.counts.llmMerges).toBe(0)
          expect(first.counts.aliasMerges).toBe(0)

          /**
           * The short form is UNTOUCHED, which is the load-bearing half. The phase does commit on night
           * one — pass one normalizes the mixed-case meta — so a commit's presence proves nothing and
           * only the alias file's own bytes do.
           */
          expect(yield* atHead(fixture, SHORT_FORM)).toBe(before)
          expect(yield* personNames(fixture)).toContain(PERSON_ALIAS)

          const pending = yield* entityCorroborations(fixture)
          expect(pending).toEqual([
            {
              alias_name: PERSON_ALIAS,
              canonical_name: PERSON_CANONICAL,
              detections: 1,
              promoted: 0
            }
          ])

          /** Night two: a later instant, the same answer. */
          const second = yield* entityResolution(envFor(fixture, false, "2026-08-03"))
          expect(second.counts.llmMerges).toBe(1)
          expect(second.counts.pendingCorroboration).toBe(0)
          expect(second.commitSha).not.toBeNull()

          const after = yield* atHead(fixture, SHORT_FORM)
          expect(after).toContain(personMeta(PERSON_CANONICAL))
          expect(after).not.toContain(personMeta(PERSON_ALIAS))
          // The merge went toward the THREE-memory full form, which is the file-count rule and not the
          // model's choice — the fake names the same member as canonical, so this also holds when the
          // orientation is inverted, and the unit tier is where the inversion is caught.
          expect(yield* personNames(fixture)).not.toContain(PERSON_ALIAS)

          const promoted = yield* entityCorroborations(fixture)
          expect(promoted[0]?.promoted).toBe(1)
          expect(promoted[0]?.detections).toBe(2)
        }),
      { seed: ENTITY_CORPUS, model: clusterModel() }
    )
  })

  it("does not double-count a resume within ONE night", async () => {
    /**
     * The resume-idempotence semantics, which this phase needs more than conflict detection does. It
     * commits whenever it rewrites any file, and pass one's normalization is such a rewrite — so a night
     * that only bumped counters still commits, and `memhtml sleep resume` re-executes the phase on a
     * branch it already partly ran. Without the `updated_at` guard the second pass would be a second
     * night's independent evidence and would apply a merge on one night's worth.
     *
     * Both runs pass the SAME `at`, which is what a resume of one run does.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* entityResolution(envFor(fixture))
          const before = yield* atHead(fixture, SHORT_FORM)

          const again = yield* entityResolution(envFor(fixture))
          expect(again.counts.llmMerges).toBe(0)
          expect(again.counts.pendingCorroboration).toBe(1)

          expect(yield* entityCorroborations(fixture)).toEqual([
            {
              alias_name: PERSON_ALIAS,
              canonical_name: PERSON_CANONICAL,
              detections: 1,
              promoted: 0
            }
          ])
          expect(yield* atHead(fixture, SHORT_FORM)).toBe(before)
        }),
      { seed: ENTITY_CORPUS, model: clusterModel() }
    )
  })

  it("applies an ALIAS-BACKED merge on night one, with no corroboration at all", async () => {
    /**
     * The oracle: a person file declaring `laith` an alias is a human's (or an authoritative
     * directory's) assertion of identity, not a machine's suspicion, so it needs no second night. The
     * character distance is unchanged at 0.476 — the declaration is what moved, and nothing else.
     *
     * The contrast with the case above is the whole assertion: the same corpus, the same scripted
     * answer, one extra seeded file, and the merge lands a night earlier and leaves NO counter row.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.counts.aliasMerges).toBe(1)
          expect(outcome.counts.llmMerges).toBe(0)
          expect(outcome.counts.pendingCorroboration).toBe(0)

          const after = yield* atHead(fixture, SHORT_FORM)
          expect(after).toContain(personMeta(PERSON_CANONICAL))
          expect(after).not.toContain(personMeta(PERSON_ALIAS))
          // No counter: an alias-backed merge never enters the corroboration table, so a reader of that
          // table sees only the merges that are actually waiting on evidence.
          expect(yield* entityCorroborations(fixture)).toEqual([])
        }),
      {
        seed: [
          ...ENTITY_CORPUS,
          personFile({ canonical: PERSON_CANONICAL, aliases: [PERSON_ALIAS] })
        ],
        model: clusterModel()
      }
    )
  })

  it("counts a BELOW-FLOOR cluster for review and merges nothing", async () => {
    /**
     * The confidence floor, which is the guard that runs before the corroboration counter. A cluster the
     * model is unsure of must not even start accumulating nights, or two unsure nights would add up to a
     * merge neither night believed in.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, SHORT_FORM)
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.counts.reviewCandidates).toBeGreaterThan(0)
          expect(outcome.counts.llmMerges).toBe(0)
          expect(outcome.counts.pendingCorroboration).toBe(0)
          expect(yield* entityCorroborations(fixture)).toEqual([])
          expect(yield* atHead(fixture, SHORT_FORM)).toBe(before)
        }),
      { seed: ENTITY_CORPUS, model: clusterModel({ confidence: ENTITY_CONFIDENCE_FLOOR - 0.01 }) }
    )
  })

  it("drops a cluster naming a member key the batch never offered", async () => {
    /**
     * A key the batch did not mint is a member the model invented, and every merge here becomes a
     * rewrite — so an unresolvable key has to be a drop and not a write. Asserted through `m999` and
     * through a canonical key that resolves but sits OUTSIDE its own cluster, which is a
     * self-contradicting answer the caller cannot repair without guessing.
     */
    const model = scriptedModel((request) => {
      if (!request.system.startsWith("You group entity names")) return value({ clusters: [] })
      return value({
        clusters: [
          {
            canonicalKey: "m999",
            memberKeys: ["m1", "m999"],
            confidence: 0.99,
            evidence: "a member that was never offered"
          },
          {
            // Resolvable keys, but the stated canonical is not among the members.
            canonicalKey: "m2",
            memberKeys: ["m1", "m3"],
            confidence: 0.99,
            evidence: "a canonical outside its own cluster"
          }
        ]
      })
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* atHead(fixture, SHORT_FORM)
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.counts.llmMerges).toBe(0)
          expect(outcome.counts.aliasMerges).toBe(0)
          expect(outcome.counts.pendingCorroboration).toBe(0)
          expect(yield* entityCorroborations(fixture)).toEqual([])
          expect(yield* atHead(fixture, SHORT_FORM)).toBe(before)
        }),
      { seed: ENTITY_CORPUS, model }
    )
  })

  it("stops counting a REVIEW-BAND pair for review once the model has decided it", async () => {
    /**
     * `reviewCandidates` is what a human is asked to look at, so it must not report a pair the night
     * already settled. A band pair the model clustered was DECIDED — recorded either as a merge or, when
     * it is below the confidence floor, as one review candidate already — and adding the band's copy on
     * top would report one pair twice and inflate the number an operator triages against.
     *
     * The band pair is `metrics-api`/`metrics-cli` at 0.8182, which is inside 0.75-0.85 and therefore
     * neither auto-merged nor ignored. The model is scripted to cluster exactly that pair with an
     * ABOVE-floor confidence, so it takes the corroboration path and no review candidate is minted for
     * it anywhere — leaving the count at zero for that pair.
     *
     * (Verified by mutation: replacing the filter with `character.review.length` makes this case fail
     * with 1 while the whole rest of the suite stays green — which is exactly how quietly a
     * double-counted review number would ship.)
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
    const model = scriptedModel((request) => {
      if (!request.system.startsWith("You group entity names")) return value({ clusters: [] })
      const keyOf = (name: string): string | undefined =>
        [...request.prompt.matchAll(/<entity_(m\d+)>\s*\nname: ([^\n]+)/g)].find(
          (match) => match[2]?.trim() === name
        )?.[1]
      const api = keyOf("metrics-api")
      const cli = keyOf("metrics-cli")
      if (api === undefined || cli === undefined) return value({ clusters: [] })
      return value({
        clusters: [
          {
            canonicalKey: api,
            memberKeys: [api, cli],
            confidence: 0.95,
            evidence: "both are written about as the same scrape endpoint"
          }
        ]
      })
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          // Decided, not awaiting a human: it took the corroboration path instead.
          expect(outcome.counts.pendingCorroboration).toBe(1)
          expect(outcome.counts.reviewCandidates).toBe(0)
        }),
      { seed: BAND_CORPUS, model }
    )
  })

  it("does not corroborate a merge the character pass ALREADY made", async () => {
    /**
     * A model asked to partition one type's names sees the pairs the cheap pass already settled too, and
     * it will cluster them — they are the easy cases. Counting that as a night of corroboration would
     * accumulate evidence for a decision that is no longer waiting on any, so the table would fill with
     * rows for merges that have happened and an operator reading "pending" would be reading noise.
     *
     * `queue-worker` / `queue-workers` scores 0.96, above the 0.85 auto threshold, so the merge lands on
     * night one from the character pass alone. The scripted model clusters exactly that pair with an
     * above-floor confidence, so the only thing standing between the answer and a counter row is the
     * guard.
     *
     * (Verified by mutation: dropping the `>= AUTO_MERGE_THRESHOLD` skip makes this case fail with a
     * `pendingCorroboration` of 1 and a counter row, while the merge still lands — a defect entirely
     * invisible in the files.)
     */
    const PLURAL_CORPUS: ReadonlyArray<SeedFile> = [
      {
        path: "areas/services/queue-worker-drain.html",
        html: memoryHtml({
          title: "The queue worker drains before it exits",
          claim: "The queue worker drains its in-flight jobs before the process exits.",
          memoryType: "semantic",
          createdAt: "2026-04-01T00:00:00Z",
          entities: ["service:queue-worker"]
        })
      },
      {
        path: "areas/services/queue-workers-scale.html",
        html: memoryHtml({
          title: "The queue workers scale on depth",
          claim: "The queue workers scale out on queue depth rather than on CPU.",
          memoryType: "semantic",
          createdAt: "2026-04-02T00:00:00Z",
          entities: ["service:queue-workers"]
        })
      }
    ]
    const model = scriptedModel((request) => {
      if (!request.system.startsWith("You group entity names")) return value({ clusters: [] })
      const keys = [...request.prompt.matchAll(/<entity_(m\d+)>/g)].map((match) => match[1] ?? "")
      const [first, second] = keys
      if (first === undefined || second === undefined) return value({ clusters: [] })
      return value({
        clusters: [
          {
            canonicalKey: first,
            memberKeys: [first, second],
            confidence: 0.99,
            evidence: "one name is the other's plural"
          }
        ]
      })
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          // The character pass merged it on night one, with no corroboration involved.
          expect(outcome.counts.fuzzyMerges).toBe(1)
          expect(outcome.counts.pendingCorroboration).toBe(0)
          expect(outcome.counts.llmMerges).toBe(0)
          expect(yield* entityCorroborations(fixture)).toEqual([])
          // And the merge really landed, so the counts above are not describing an inert phase.
          expect(yield* atHead(fixture, "areas/services/queue-workers-scale.html")).toContain(
            '<meta name="memhtml-entity" content="service:queue-worker">'
          )
        }),
      { seed: PLURAL_CORPUS, model }
    )
  })

  it("keeps counting a band pair the model did NOT cluster", async () => {
    // The other half, and it is what keeps the case above from passing against a phase that simply
    // stopped counting the band. Same corpus, a model that declines, and the pair is still a human's call.
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
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.counts.reviewCandidates).toBe(1)
          expect(outcome.counts.pendingCorroboration).toBe(0)
        }),
      { seed: BAND_CORPUS, model: scriptedModel(() => value({ clusters: [] })) }
    )
  })

  it("keeps two services apart though their centroids are CLOSER than the one person's spellings", async () => {
    /**
     * The negative control, and the reason a centroid cosine is evidence rather than a threshold.
     * Measured under the deterministic embedder: `checkout-api` and `payments-api` sit at 0.9333 while
     * the two spellings of one person sit at 0.7788 — so any cosine floor that merged the person would
     * merge the two services first, and fusing two services' memories is permanent.
     *
     * The model declines here, which is the honest shape: the phase's job is to hand the number over and
     * to write nothing the model did not cluster. Both service files keep their own entity.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.counts.llmMerges).toBe(0)

          expect(yield* atHead(fixture, CHECKOUT)).toContain(
            '<meta name="memhtml-entity" content="service:checkout-api">'
          )
          expect(yield* atHead(fixture, PAYMENTS)).toContain(
            '<meta name="memhtml-entity" content="service:payments-api">'
          )
          // And the third person is untouched: a phase that fused every person into one would show here.
          expect(yield* atHead(fixture, SANJU)).toContain(personMeta("sanju kumar"))
        }),
      { seed: ENTITY_CORPUS, model: clusterModel() }
    )
  })

  it("shows the model the centroid neighbors and the declared aliases, and no path", async () => {
    /**
     * What actually goes over the wire, asserted on the recorded prompt. Three of the phase's
     * mechanisms are invisible in its counts and fully visible here: the neighbor list is what lets a
     * model see that two spellings are written about identically, the alias line is what makes the
     * oracle reachable at all, and the absence of a path is the prompt-injection and write-target
     * boundary — a model shown a path could name a file to rewrite.
     *
     * `cacheSystem` is recorded too. Every batch of a night repeats one system prompt and one tool
     * schema, so an unset flag re-bills the whole prefix per call and is invisible in the phase's counts
     * and in its written files.
     */
    const model = clusterModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* entityResolution(envFor(fixture))

          const person = model.calls.find((call) => call.prompt.includes(`name: ${PERSON_ALIAS}\n`))
          expect(person, "the person type reached a call").toBeDefined()
          expect(person?.cacheSystem).toBe(true)
          expect(person?.system).toBe(ENTITY_CLUSTER_SYSTEM)

          const prompt = person?.prompt ?? ""
          expect(prompt).toContain("nearest by memory centroid:")
          // The two spellings of one person are each other's neighbors, which is the evidence the name
          // string cannot carry.
          expect(prompt).toMatch(
            new RegExp(`nearest by memory centroid:\\n- ${PERSON_CANONICAL} \\(0\\.\\d\\d\\)`)
          )
          expect(prompt).toContain("declared aliases: laith al-saadoon")
          // Member text is wrapped as data, because this corpus stores instructions.
          expect(prompt).toContain("<entity_m1>")
          // No path anywhere: not a write target, and not a hint at one.
          expect(prompt).not.toContain(".html")
          // One call per TYPE, not one per pair: `person` and `service` are the two types here.
          expect(model.calls).toHaveLength(2)
        }),
      {
        seed: [
          ...ENTITY_CORPUS,
          personFile({ canonical: PERSON_CANONICAL, aliases: [PERSON_ALIAS] })
        ],
        model
      }
    )
  })

  it("degrades to the deterministic passes with no model bound, and still normalizes", async () => {
    /**
     * A credential-free run is not a broken run, and for THIS phase it is not an inert one either: the
     * normalization and character-overlap passes are the phase's pre-stage and they still write. What
     * degrades is the decision core, so the mixed-case meta folds and the short form stays.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const shortBefore = yield* atHead(fixture, SHORT_FORM)
          expect(yield* atHead(fixture, MIXED_CASE)).toContain("person:Laith Al-Saadoon")

          const outcome = yield* entityResolution(envFor(fixture))

          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.namesNormalized).toBeGreaterThan(0)
          expect(outcome.counts.llmMerges).toBe(0)
          expect(outcome.counts.aliasMerges).toBe(0)
          expect(outcome.counts.pendingCorroboration).toBe(0)
          expect(outcome.commitSha).not.toBeNull()

          // Pass one did its work.
          const mixed = yield* atHead(fixture, MIXED_CASE)
          expect(mixed).not.toContain("person:Laith Al-Saadoon")
          expect(mixed).toContain(personMeta(PERSON_CANONICAL))
          // And the model-only merge did not happen, because there was no model.
          expect(yield* atHead(fixture, SHORT_FORM)).toBe(shortBefore)
          expect(yield* entityCorroborations(fixture)).toEqual([])
        }),
      { seed: ENTITY_CORPUS }
    )
  })

  it("makes no model call and bumps no counter on a dry run", async () => {
    /**
     * A counter bumped by a run that wrote nothing would be a night of corroboration the corpus never
     * saw, so the next real night would promote on evidence a dry run manufactured. The dry run's own
     * counts are still real — that is what makes it useful — and only the writes are not.
     */
    const model = clusterModel()
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* entityResolution(envFor(fixture, true))

          expect(outcome.llmCalls).toBe(0)
          expect(model.calls).toEqual([])
          expect(outcome.counts.entities).toBeGreaterThan(0)
          expect(outcome.counts.namesNormalized).toBeGreaterThan(0)
          expect(outcome.commitSha).toBeNull()
          expect(yield* entityCorroborations(fixture)).toEqual([])
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: ENTITY_CORPUS, model }
    )
  })

  it("keeps running when a batch's model call fails, and merges nothing from it", async () => {
    // Per-item isolation: one malformed tool payload skips its batch and leaves the deterministic
    // passes' work in place, rather than failing a phase that had already normalized real files.
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBeGreaterThan(0)
          expect(outcome.counts.llmMerges).toBe(0)
          // Pass one still landed, so the phase did real work despite the model.
          expect(yield* atHead(fixture, MIXED_CASE)).toContain(personMeta(PERSON_CANONICAL))
        }),
      { seed: ENTITY_CORPUS, model: scriptedModel(() => violation("scripted off-schema clusters")) }
    )
  })
})

import { archivePathFor } from "@memhtml/contracts/paths"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { arcSynthesis } from "../src/phases/arc-synthesis.js"
import { COMPRESS_MEMBER_CHARS, compress } from "../src/phases/compress.js"
import {
  CONFLICT_COSINE_FLOOR,
  conflictDetection,
  PROMOTION_DETECTIONS
} from "../src/phases/conflict-detection.js"
import { instantFor } from "../src/run.js"
import { conflictCandidates } from "../src/sql.js"
import { type ScriptedReply, scriptedModel, unavailable, value, violation } from "../src/testing.js"
import {
  DEDUP_CORPUS,
  type Fixture,
  memoryHtml,
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

const envFor = (fixture: Fixture, dryRun = false): PhaseEnv => {
  const instant = instantFor(DATE)
  return {
    deps: fixture.deps,
    runId: `sleep/${DATE}`,
    branch: `sleep/${DATE}`,
    baseSha: "",
    date: DATE,
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

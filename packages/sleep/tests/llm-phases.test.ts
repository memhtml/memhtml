import { archivePathFor } from "@memhtml/contracts/paths"
import { parseMemory } from "@memhtml/html"
import { STATE_SCHEMA } from "@memhtml/index"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
import { ENTITY_CLUSTER_SYSTEM } from "../src/llm.js"
import { arcSynthesis } from "../src/phases/arc-synthesis.js"
import { COMPRESS_MEMBER_CHARS, compress } from "../src/phases/compress.js"
import {
  EDGE_COSINE_FLOOR,
  EDGE_PAIR_SIDE_CHARS,
  EDGE_PAIRS_PER_CALL,
  EDGE_PER_SOURCE_K,
  EDGE_PROMOTION_CAP,
  EDGE_TYPING_CANDIDATE_LIMIT,
  edgeTyping,
  edgeTypingCandidates,
  PROMOTION_DETECTIONS
} from "../src/phases/edge-typing.js"
import { ENTITY_CONFIDENCE_FLOOR, entityResolution } from "../src/phases/entity-resolution.js"
import { instantFor } from "../src/run.js"
import { minedPairs, sharedEntityPairs } from "../src/sql.js"
import { type ScriptedReply, scriptedModel, unavailable, value, violation } from "../src/testing.js"
import { pendingMarks } from "./abort-fixture.js"
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

/**
 * The flip pair's two files, pulled out of {@link DEDUP_CORPUS} rather than re-authored.
 *
 * A test that needs a shared-entity candidate WITHOUT the rest of the dedup corpus seeds these two,
 * and reusing the corpus's own bytes keeps the measured cosine (0.9907, documented in `fixture.ts`)
 * and the shared `service:payments-gateway` entity the shared-entity arm joins on.
 */
const fileAt = (path: string): SeedFile => {
  const found = DEDUP_CORPUS.find((file) => file.path === path)
  if (found === undefined) throw new Error(`the fixture corpus no longer holds ${path}`)
  return found
}
const SAFE_FILE = fileAt(SAFE)
const NOT_SAFE_FILE = fileAt(NOT_SAFE)

/**
 * The candidate set the phase will actually type, from the phase's OWN scan.
 *
 * Two arms are unioned and each orients its pairs its own way, so hard-coding `src` and `dst` would
 * seed the mirror of the row the phase writes, and a promotion test would pass for the wrong reason
 * the day either arm's ordering moved. Reading the phase's own function rather than rebuilding the
 * union here for the same reason the compress tests derive the archived member from what moved: a
 * second copy of the selection would be free to disagree with the one the phase runs.
 */
const candidatePairs = (fixture: Fixture) => edgeTypingCandidates(fixture.db).pipe(Effect.orDie)

/** The pair with these two endpoints, in whichever orientation the scans produced. */
const pairOf = (
  pairs: ReadonlyArray<{ readonly src: string; readonly dst: string }>,
  left: string,
  right: string
) =>
  pairs.find(
    (one) => (one.src === left && one.dst === right) || (one.src === right && one.dst === left)
  )

/** One verdict payload, with the fields a test is not varying filled in plausibly. */
const verdict = (input: {
  readonly pairKey: string
  readonly rel: string
  readonly direction?: "src_to_dst" | "dst_to_src"
  readonly confidence?: number
}) => ({
  pairKey: input.pairKey,
  rel: input.rel,
  direction: input.direction ?? "src_to_dst",
  confidence: input.confidence ?? 0.95,
  rationale: "scripted"
})

/** The keys a batch offered, read off the recorded prompt. `m1`..`mN` in the order they were sent. */
const offeredKeys = (prompt: string): ReadonlyArray<string> => [
  ...new Set([...prompt.matchAll(/<pair_(m\d+)>/g)].map((match) => match[1] as string))
]

/**
 * The keys of the offered pairs whose text contains `needle`.
 *
 * A scripted reply that answered `m1` would be answering about whichever pair the batch's sort put
 * first, so it would silently move onto another pair the day the ordering changed — and the tests that
 * assert WHICH file gained a link would then be asserting about the wrong pair while staying green.
 * Matching on the pair's own text is how a reply names the pair it means.
 */
const pairKeysWithText = (prompt: string, needle: string): ReadonlyArray<string> =>
  [...prompt.matchAll(/<pair_(m\d+)>\n([\s\S]*?)\n<\/pair_m\d+>/g)].flatMap((match) =>
    (match[2] ?? "").includes(needle) ? [match[1] as string] : []
  )

/**
 * A corpus with more candidate pairs than one batch holds and more than the promotion cap allows.
 *
 * Built as one wide near-duplicate family: every member shares the vocabulary and the entity, so the
 * mining scan and the shared-entity scan both enumerate the pairs, and per-source top-`k` keeps five
 * per source. That is what makes the multi-batch and cap assertions non-vacuous — a corpus of six
 * files could not exceed either bound, and both tests would pass against a phase with no cap and no
 * batch slicing at all.
 */
const WIDE_CORPUS: ReadonlyArray<SeedFile> = Array.from({ length: 26 }, (_, offset) => ({
  path: `areas/queue/queue-${String(offset).padStart(2, "0")}.html`,
  html: memoryHtml({
    title: `Queue drain note ${offset}`,
    claim: `The queue drain worker leases a visibility window before acknowledging, note ${offset}.`,
    body: `Draining leases a visibility window per message and acknowledges after the handler returns, variant ${offset}.`,
    createdAt: `2026-04-${String((offset % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    entities: ["service:queue-drain"],
    tags: ["queue"]
  })
}))

/** One sentence of filler, repeated to push a body far past the per-side budget. */
const LONG_FILLER = "The drain worker leases a visibility window per message. "

/**
 * Two long memories that are a candidate pair. Every seeded body elsewhere is a couple of hundred
 * characters, which would leave the per-side budget's wiring unexercised: it could be deleted and
 * every other test stay green.
 */
const LONG_CORPUS: ReadonlyArray<SeedFile> = ["one", "two"].map((name, offset) => ({
  path: `areas/queue/long-${name}.html`,
  html: memoryHtml({
    title: `Long queue note ${name}`,
    claim: `The queue drain worker leases a visibility window before acknowledging (${name}).`,
    body: LONG_FILLER.repeat(80),
    createdAt: `2026-04-0${offset + 1}T00:00:00Z`,
    entities: ["service:queue-drain"],
    tags: ["queue"]
  })
}))

describe("edge-typing", () => {
  it("unions both candidate arms, and neither one alone would find what the union does", async () => {
    /**
     * The recall claim, made falsifiable. The corpus is two disjoint pairs:
     *
     * - The flip pair (`blue-green-is-safe` / `is-not-safe`) shares `service:payments-gateway` and is
     *   above the typing cosine floor, so the SHARED-ENTITY arm finds it. It carries no mined edge.
     * - The tunnel pair names NO entity at all and is below the shared-entity arm's reach for want of
     *   an entity to join on, but a mined `relates_to` is seeded for it, so the MINED arm finds it.
     *
     * So each arm finds exactly one pair and the union finds both, which is what makes the second arm
     * a recall gain rather than a duplicate read. A phase running one arm would report one candidate.
     */
    const TUNNEL_A = "areas/net/tunnel-mtu.html"
    const TUNNEL_B = "areas/net/mtu-clamp.html"
    const NO_ENTITY: ReadonlyArray<SeedFile> = [
      {
        path: TUNNEL_A,
        html: memoryHtml({
          title: "The tunnel clamps MTU at 1400",
          claim: "The overlay tunnel clamps the MTU to 1400 bytes on egress.",
          body: "Packets above the clamp are fragmented before they leave the host.",
          createdAt: "2026-03-01T00:00:00Z"
        })
      },
      {
        path: TUNNEL_B,
        html: memoryHtml({
          title: "MTU clamping happens on egress",
          claim: "Egress from the overlay applies an MTU clamp of 1400 bytes.",
          body: "Anything larger than the clamp is fragmented on the way out of the host.",
          createdAt: "2026-03-02T00:00:00Z"
        })
      }
    ]

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.db
            .run(
              `INSERT INTO edges
                 (src_path, rel, dst_path, edge_class, derived, strength, provenance, created_at)
               VALUES (?, 'relates_to', ?, 'memory', 1, 0.97, 'sleep', '2026-08-01T00:00:00Z')`,
              [TUNNEL_A, TUNNEL_B]
            )
            .pipe(Effect.orDie)

          const mined = yield* minedPairs(fixture.db, {
            rel: "relates_to",
            excludeTypes: ["task"]
          }).pipe(Effect.orDie)
          const shared = yield* sharedEntityPairs(fixture.db, {
            floor: EDGE_COSINE_FLOOR,
            perSourceK: EDGE_PER_SOURCE_K,
            limit: EDGE_TYPING_CANDIDATE_LIMIT,
            excludeTypes: ["task"]
          }).pipe(Effect.orDie)

          // Each arm sees exactly one pair, and NOT the same one.
          expect(mined.map((one) => [one.src, one.dst])).toEqual([[TUNNEL_A, TUNNEL_B]])
          expect(shared.map((one) => [one.src, one.dst])).toEqual([[SAFE, NOT_SAFE]])

          // And the phase's own scan is both.
          const union = yield* candidatePairs(fixture)
          expect(
            union.map((one) => (one.src < one.dst ? [one.src, one.dst] : [one.dst, one.src])).sort()
          ).toEqual([[SAFE, NOT_SAFE].sort(), [TUNNEL_A, TUNNEL_B].sort()].sort())
        }),
      { seed: [...NO_ENTITY, SAFE_FILE, NOT_SAFE_FILE] }
    )
  })

  it("types a pair BOTH arms found exactly once, in one orientation", async () => {
    /**
     * The dedup is on the UNORDERED pair, and the two arms orient independently: the shared-entity
     * join emits `dst < src` and a mined edge carries whatever orientation mining wrote. So a pair in
     * both arms arrives twice, mirrored, and an ordered dedup key would let both copies through — two
     * verdicts about one pair in one night, free to disagree, and two `<link>` lines from one
     * relationship.
     *
     * The mined edge is seeded in the OPPOSITE orientation to the one the shared-entity arm reports,
     * which is what makes this test about the key's unorderedness rather than about deduplication in
     * general.
     */
    const model = scriptedModel((request) =>
      value({
        verdicts: offeredKeys(request.prompt).map((key) => verdict({ pairKey: key, rel: "none" }))
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const shared = yield* sharedEntityPairs(fixture.db, {
            floor: EDGE_COSINE_FLOOR,
            perSourceK: EDGE_PER_SOURCE_K,
            limit: EDGE_TYPING_CANDIDATE_LIMIT,
            excludeTypes: ["task"]
          }).pipe(Effect.orDie)
          const flip = pairOf(shared, SAFE, NOT_SAFE)
          expect(flip).toBeDefined()

          // Mirrored: `dst` as src, `src` as dst. Both arms now hold the same unordered pair.
          yield* fixture.db
            .run(
              `INSERT INTO edges
                 (src_path, rel, dst_path, edge_class, derived, strength, provenance, created_at)
               VALUES (?, 'relates_to', ?, 'memory', 1, 0.97, 'sleep', '2026-08-01T00:00:00Z')`,
              [flip?.dst ?? "", flip?.src ?? ""]
            )
            .pipe(Effect.orDie)

          const union = yield* candidatePairs(fixture)
          const flipCount = union.filter(
            (one) =>
              (one.src === SAFE && one.dst === NOT_SAFE) ||
              (one.src === NOT_SAFE && one.dst === SAFE)
          )
          expect(flipCount).toHaveLength(1)

          // And the offered batch holds it once, so the model is asked about it once.
          yield* edgeTyping(envFor(fixture))
          const prompt = model.calls[0]?.prompt ?? ""
          expect(pairKeysWithText(prompt, "is not safe")).toHaveLength(1)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("judges a whole batch of pairs in ONE call", async () => {
    /**
     * The defect this phase exists to fix: the per-pair phase made one `generateObject` per candidate,
     * which is O(pairs) calls a night. The fixture's candidates all fit one batch, so `llmCalls` is 1
     * and `judged` is the number of verdicts — a phase that reverted to per-pair judging would report
     * `llmCalls === judged` instead.
     */
    let keys: ReadonlyArray<string> = []
    const model = scriptedModel((request) => {
      keys = offeredKeys(request.prompt)
      return value({ verdicts: keys.map((key) => verdict({ pairKey: key, rel: "none" })) })
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pairs = yield* candidatePairs(fixture)
          expect(pairs.length).toBeGreaterThan(1)
          expect(pairs.length).toBeLessThanOrEqual(EDGE_PAIRS_PER_CALL)

          const outcome = yield* edgeTyping(envFor(fixture))
          expect(outcome.llmCalls).toBe(1)
          expect(model.calls).toHaveLength(1)
          // Every candidate reached the one call, and every one came back judged.
          expect(keys).toHaveLength(pairs.length)
          expect(outcome.counts.judged).toBe(pairs.length)
          expect(outcome.counts.candidates).toBe(pairs.length)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("offers every pair under an opaque key, with BOTH memories inline and no path", async () => {
    /**
     * A verdict names a pair, and the phase turns that name into a write, so the key space has to be
     * one the phase controls. Both sides inline is the other half: a model shown only `src` would be
     * answering about a pair it half saw.
     */
    const model = scriptedModel(() => value({ verdicts: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping(envFor(fixture))
          const call = model.calls[0]
          expect(call).toBeDefined()
          expect(call?.prompt).toContain("<pair_m1>")
          expect(call?.prompt).toContain("src:")
          expect(call?.prompt).toContain("dst:")
          for (const file of DEDUP_CORPUS) expect(call?.prompt).not.toContain(file.path)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("asks for its system prompt to be cached, and repeats it byte-identically per batch", async () => {
    /**
     * The system prompt and the tool schema are the same bytes on every batch of a night, so they are
     * the cacheable prefix and only the pair list is new. Asserted at the PHASE, because the flag lives
     * in the kernel's call helper: a phase that reached `generateObject` directly would compile, pass
     * every other test here, and quietly re-bill its whole prefix on each batch.
     */
    const model = scriptedModel(() => value({ verdicts: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            expect(call.cacheSystem).toBe(true)
            expect(call.system).toBe(model.calls[0]?.system)
          }
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("promotes a contradiction into BOTH files only once detections reach the corroboration gate", async () => {
    /**
     * The state plane is seeded one detection short, so THIS run's detection is the second — the exact
     * boundary. A phase that promoted on the first detection would let one machine suspicion reach a
     * file, which is the one-way door the corroboration gate exists to hold. Ported verbatim in
     * substance from the per-pair phase; only the scripted reply's SHAPE changed, from one judgment to
     * a verdict addressed to the pair's offered key.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pairs = yield* candidatePairs(fixture)
          const pair = pairOf(pairs, SAFE, NOT_SAFE)
          expect(pair).toBeDefined()
          yield* seedCorroboration(fixture.db, {
            srcPath: pair?.src ?? "",
            dstPath: pair?.dst ?? "",
            detections: PROMOTION_DETECTIONS - 1
          })

          /**
           * `contradicts` for the flip pair alone and `none` for every other candidate, matched on the
           * pair's own text rather than on a key ordinal. A reply keyed by position would silently move
           * onto another pair the day the batch order changed.
           */
          const model = scriptedModel((request) =>
            value({
              verdicts: pairKeysWithText(request.prompt, "is not safe").map((key) =>
                verdict({ pairKey: key, rel: "contradicts" })
              )
            })
          )
          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model }
          })

          expect(outcome.counts.judged).toBeGreaterThan(0)
          expect(outcome.counts.contradictions).toBe(1)
          expect(outcome.counts.promoted).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

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
      { seed: DEDUP_CORPUS }
    )
  })

  it("counts a contradiction without promoting when it is the first detection", async () => {
    const model = scriptedModel((request) =>
      value({
        verdicts: offeredKeys(request.prompt).map((key) =>
          verdict({ pairKey: key, rel: "contradicts" })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* edgeTyping(envFor(fixture))
          expect(outcome.counts.contradictions).toBeGreaterThan(0)
          expect(outcome.counts.promoted).toBe(0)
          expect(outcome.counts.typed).toBe(0)
          /**
           * No MEMORY FILE gained anything: the corroboration counter lives in state and the edge is
           * unwritten, which is the whole point of the gate.
           *
           * The phase DOES commit now, and that is issue #44's change rather than a regression here.
           * A first detection also opens a review task, so the commit carries the deferred decision
           * and nothing else — asserted below on the paths, because "no commit" was only ever a proxy
           * for "the files are untouched" and the two have come apart.
           */
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")
          // One task per contradicting pair the model named: this script answers for every pair.
          expect(outcome.counts.tasksMinted).toBe(outcome.counts.contradictions)
          const changed = yield* fixture.deps.git
            .run(["show", "--name-only", "--format=", outcome.commitSha as string])
            .pipe(
              Effect.map((text) =>
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "")
                  .sort()
              ),
              Effect.orDie
            )
          expect(changed.every((path) => path.startsWith("areas/inbox/tasks/det-"))).toBe(true)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("promotes a contradiction on the SECOND night, having only counted it on the first", async () => {
    /**
     * The gate end to end, without seeding the counter: two runs of the phase at two DIFFERENT
     * instants over the same corpus and the same verdict. Night one writes nothing; night two writes
     * both files. The seeded variant above pins the boundary; this pins that two real nights reach it,
     * which is what the `updated_at`-differs idempotence guard in `bumpCorroboration` decides.
     */
    const model = scriptedModel((request) =>
      value({
        verdicts: pairKeysWithText(request.prompt, "is not safe").map((key) =>
          verdict({ pairKey: key, rel: "contradicts" })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const nightOne = yield* edgeTyping(envFor(fixture))
          expect(nightOne.counts.contradictions).toBe(1)
          expect(nightOne.counts.promoted).toBe(0)
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")

          const later = instantFor("2026-08-03")
          const nightTwo = yield* edgeTyping({
            ...envFor(fixture),
            date: "2026-08-03",
            at: later.at,
            atMillis: later.millis
          })
          expect(nightTwo.counts.promoted).toBe(1)
          expect(yield* atHead(fixture, SAFE)).toContain(
            `<link rel="memhtml-contradicts" href="/${NOT_SAFE}">`
          )
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("promotes NOTHING when one endpoint's file is gone, and leaves the survivor undangled", async () => {
    /**
     * A `contradicts` is symmetric and the phase writes it into both files, so it is all-or-nothing —
     * and one endpoint being absent is ORDINARY here, not exceptional: every phase reads its candidates
     * from an index refreshed once in preflight, so a file an earlier phase archived is still listed
     * active at its old path when this phase runs. Reproduced exactly that way, by archiving one
     * endpoint's file in the TREE and leaving the index row where it was.
     *
     * Three things have to hold, and each fails against a different wrong implementation:
     *
     * - `promoted` is 0 and there is NO COMMIT. A phase that counted the half-write reports a promotion
     *   the corpus does not carry.
     * - `edge_corroboration.promoted` stays 0, so the pair is RE-ELIGIBLE. Marking it promoted on a
     *   one-sided write records a half-written edge as done, and no later night — with a refreshed index
     *   and both files present, or with the pair correctly out of both arms — ever finishes it.
     * - The SURVIVING file gains no `contradicts`. That is the assertion the naive fix misses: capturing
     *   both `stampFile` results and gating `markPromoted` on them still stamps `src` first, leaving a
     *   `<link>` pointing at a path the tree does not hold — a dangling href committed by the commit
     *   that created it.
     *
     * The counter is seeded one detection short, so the gate is genuinely reached and the phase really
     * does try to write. Without that the test would pass against any implementation, because the
     * corroboration gate would have refused first.
     */
    const model = scriptedModel((request) =>
      value({
        verdicts: pairKeysWithText(request.prompt, "is not safe").map((key) =>
          verdict({ pairKey: key, rel: "contradicts" })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pairs = yield* candidatePairs(fixture)
          const pair = pairOf(pairs, SAFE, NOT_SAFE)
          expect(pair).toBeDefined()
          yield* seedCorroboration(fixture.db, {
            srcPath: pair?.src ?? "",
            dstPath: pair?.dst ?? "",
            detections: PROMOTION_DETECTIONS - 1
          })

          /**
           * `NOT_SAFE` leaves the tree the way an earlier phase would have moved it — a `git mv` into
           * the archive plus a commit — and the index is NOT refreshed, which is the whole point.
           */
          const destination = archivePathFor(NOT_SAFE, 2026)
          yield* Effect.promise(async () => {
            const { mkdir, rename } = await import("node:fs/promises")
            const { dirname, join } = await import("node:path")
            await mkdir(dirname(join(fixture.root, destination)), { recursive: true })
            await rename(join(fixture.root, NOT_SAFE), join(fixture.root, destination))
          })
          yield* fixture.raw("add", "-A")
          yield* fixture.raw("commit", "-m", "archive one endpoint out from under the phase")
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          // Non-vacuous: the index still lists the pair while the tree no longer holds one side.
          expect(yield* atHead(fixture, NOT_SAFE)).toBeUndefined()
          expect(yield* candidatePairs(fixture).pipe(Effect.map((one) => one.length))).toBe(
            pairs.length
          )

          const outcome = yield* edgeTyping({
            ...envFor(fixture),
            deps: { ...fixture.deps, model }
          })

          // The verdict was reached and counted; the WRITE is what declined.
          expect(outcome.counts.contradictions).toBe(1)
          expect(outcome.counts.promoted).toBe(0)
          expect(outcome.counts.typed).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)

          // The survivor carries no edge toward the file that is not there.
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])

          // And the pair is still waiting, not recorded as done.
          const rows = yield* fixture.db
            .all<{ detections: number; promoted: number }>(
              `SELECT detections, promoted FROM ${STATE_SCHEMA}.edge_corroboration`
            )
            .pipe(Effect.orDie)
          expect(rows).toEqual([{ detections: PROMOTION_DETECTIONS, promoted: 0 }])
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("writes a directional rel into the SUBJECT's file, per the direction the model named", async () => {
    /**
     * The direction is the whole meaning of a directional rel: `caused_by` in the cause instead of the
     * effect says the opposite of the verdict. Both directions are driven over one pair, and each
     * asserts the link is in one file and NOT in the other — an assertion on presence alone would hold
     * against a phase that stamped both files.
     */
    const answer = (direction: "src_to_dst" | "dst_to_src") =>
      scriptedModel((request) =>
        value({
          verdicts: pairKeysWithText(request.prompt, "is not safe").map((key) =>
            verdict({ pairKey: key, rel: "caused_by", direction })
          )
        })
      )

    for (const direction of ["src_to_dst", "dst_to_src"] as const) {
      await withFixture(
        (fixture) =>
          Effect.gen(function* () {
            const pairs = yield* candidatePairs(fixture)
            const pair = pairOf(pairs, SAFE, NOT_SAFE)
            expect(pair).toBeDefined()
            const [subject, object] =
              direction === "src_to_dst"
                ? [pair?.src ?? "", pair?.dst ?? ""]
                : [pair?.dst ?? "", pair?.src ?? ""]

            const outcome = yield* edgeTyping({
              ...envFor(fixture),
              deps: { ...fixture.deps, model: answer(direction) }
            })
            expect(outcome.counts.typed).toBe(1)
            expect(outcome.counts.promoted).toBe(0)
            expect(outcome.commitSha).not.toBeNull()

            const written = yield* atHead(fixture, subject)
            expect(written).toContain(`<link rel="memhtml-caused-by" href="/${object}">`)
            // ONE file: the object gains nothing. A directional rel is not symmetric.
            expect(yield* atHead(fixture, object)).not.toContain("memhtml-caused-by")
          }),
        { seed: DEDUP_CORPUS }
      )
    }
  })

  it("writes nothing on a below-floor confidence, however certain the verdict reads", async () => {
    /**
     * Both kinds at once. Every candidate is seeded one detection short, so for `contradicts` ONLY the
     * confidence floor can refuse; the directional arm has no corroboration gate at all, so the floor
     * is the only thing standing between a 0.5-confidence guess and a `<link>` in a file.
     */
    const model = scriptedModel((request) =>
      value({
        verdicts: offeredKeys(request.prompt).map((key, offset) =>
          verdict({
            pairKey: key,
            rel: offset % 2 === 0 ? "contradicts" : "part_of",
            confidence: 0.5
          })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          for (const pair of yield* candidatePairs(fixture)) {
            yield* seedCorroboration(fixture.db, {
              srcPath: pair.src,
              dstPath: pair.dst,
              detections: PROMOTION_DETECTIONS - 1
            })
          }
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* edgeTyping(envFor(fixture))
          expect(outcome.counts.judged).toBeGreaterThan(0)
          expect(outcome.counts.contradictions).toBe(0)
          expect(outcome.counts.typed).toBe(0)
          expect(outcome.counts.promoted).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          for (const file of DEDUP_CORPUS) {
            const html = yield* atHead(fixture, file.path)
            expect(html).not.toContain("memhtml-contradicts")
            expect(html).not.toContain("memhtml-part-of")
          }
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("writes nothing on a `none` verdict, whatever its confidence", async () => {
    const model = scriptedModel((request) =>
      value({
        verdicts: offeredKeys(request.prompt).map((key) =>
          verdict({ pairKey: key, rel: "none", confidence: 1 })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* edgeTyping(envFor(fixture))
          expect(outcome.counts.judged).toBeGreaterThan(0)
          expect(outcome.counts.typed).toBe(0)
          expect(outcome.counts.promoted).toBe(0)
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("drops a verdict naming a key the batch never offered", async () => {
    /**
     * `m99` is not in a batch of three, and a PATH is not a key. Both resolve to nothing, so neither
     * becomes a write. A phase that treated an unresolvable key as a path would stamp a file on a
     * hallucination — and the path here is a real corpus file, so the write would succeed.
     */
    const model = scriptedModel(() =>
      value({
        verdicts: [
          verdict({ pairKey: "m99", rel: "contradicts" }),
          verdict({ pairKey: SAFE, rel: "caused_by" }),
          verdict({ pairKey: "", rel: "part_of" })
        ]
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* edgeTyping(envFor(fixture))
          // Nothing resolved, so nothing was judged and nothing was written.
          expect(outcome.counts.judged).toBe(0)
          expect(outcome.counts.typed).toBe(0)
          expect(outcome.counts.promoted).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-caused-by")
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("acts on the FIRST verdict for a pair key and drops a second one contradicting it", async () => {
    /**
     * Nothing in `EdgeTyping`'s schema stops a model from emitting two verdicts for one key, and the
     * two are free to disagree. Here they name the SAME directional rel in OPPOSITE directions, which
     * is the shape that makes the defect legible rather than merely double: acting on both writes
     * `caused_by` into BOTH files, so the corpus says each memory caused the other. That is not a
     * relationship a reader can interpret and not one a human asked for.
     *
     * The two files are seeded alone, so the batch holds exactly one pair and both verdicts name the
     * same key by construction rather than by luck. `judged` counts the pair ONCE — a pair judged twice
     * would report a night that asked more questions than it had pairs — and `duplicates` counts the
     * refusal, so a model doing this is visible rather than silently absorbed.
     */
    const model = scriptedModel((request) => {
      const [key] = offeredKeys(request.prompt)
      return value({
        verdicts: [
          verdict({ pairKey: key ?? "", rel: "caused_by", direction: "src_to_dst" }),
          verdict({ pairKey: key ?? "", rel: "caused_by", direction: "dst_to_src" })
        ]
      })
    })
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pairs = yield* candidatePairs(fixture)
          expect(pairs).toHaveLength(1)
          const pair = pairs[0]

          const outcome = yield* edgeTyping(envFor(fixture))
          expect(model.calls).toHaveLength(1)
          expect(outcome.counts.judged).toBe(1)
          expect(outcome.counts.typed).toBe(1)
          expect(outcome.counts.duplicates).toBe(1)

          /**
           * The FIRST verdict's write, and only it. `src_to_dst` makes `src` the subject, so the link
           * is in `src` alone — and the assertion on the OBJECT's file is the load-bearing half: it is
           * what fails if the second verdict was acted on too.
           */
          const src = yield* atHead(fixture, pair?.src ?? "")
          const dst = yield* atHead(fixture, pair?.dst ?? "")
          expect(src).toContain(`<link rel="memhtml-caused-by" href="/${pair?.dst}">`)
          expect(dst).not.toContain("memhtml-caused-by")
        }),
      { seed: [SAFE_FILE, NOT_SAFE_FILE], model }
    )
  })

  it("caps the authored edges one night can write", async () => {
    /**
     * A model answering `part_of` at confidence 1.0 for every pair it sees would otherwise add one
     * `<link>` per candidate in one commit, which is not a diff a human reviews. The cap is asserted
     * against a corpus wide enough to exceed it, and `capped` counts the refusals so hitting it is
     * visible rather than silent.
     */
    const model = scriptedModel((request) =>
      value({
        verdicts: offeredKeys(request.prompt).map((key) =>
          verdict({ pairKey: key, rel: "part_of" })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pairs = yield* candidatePairs(fixture)
          // Non-vacuous: there are genuinely more candidates than the cap allows writes.
          expect(pairs.length).toBeGreaterThan(EDGE_PROMOTION_CAP)
          const outcome = yield* edgeTyping(envFor(fixture))
          expect(outcome.counts.typed).toBe(EDGE_PROMOTION_CAP)
          expect(outcome.counts.capped).toBe(pairs.length - EDGE_PROMOTION_CAP)
        }),
      { seed: WIDE_CORPUS, model }
    )
  })

  it("skips only the failing batch and keeps typing the rest", async () => {
    /**
     * The first call fails and the second succeeds. Per-batch isolation means the phase reports the
     * failed batch's pairs as skipped and keeps going — a night that typed nine batches and lost the
     * tenth has done nine batches of work, and failing the phase would throw all of it away.
     */
    const model = scriptedModel(
      (request, offset): ScriptedReply =>
        offset === 0
          ? violation("off-schema")
          : value({
              verdicts: offeredKeys(request.prompt).map((key) =>
                verdict({ pairKey: key, rel: "none" })
              )
            })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const pairs = yield* candidatePairs(fixture)
          expect(pairs.length).toBeGreaterThan(EDGE_PAIRS_PER_CALL)
          const outcome = yield* edgeTyping(envFor(fixture))
          // More than one batch, and the first one's pairs are the only skips.
          expect(outcome.llmCalls).toBeGreaterThan(1)
          expect(outcome.counts.skipped).toBe(EDGE_PAIRS_PER_CALL)
          expect(outcome.counts.judged).toBe(pairs.length - EDGE_PAIRS_PER_CALL)
        }),
      { seed: WIDE_CORPUS, model }
    )
  })

  it("counts a verdict naming no offered pair as unresolved and holds the sweep back", async () => {
    /**
     * The drop is the safe outcome and stays; what this pins is its VISIBILITY and its effect on the
     * sweep. A verdict named by a key the batch cannot map is a pair that was never judged, so it
     * must be counted (`unresolved`), and the vanished-detection sweep must not run — closing a
     * held-back contradiction because the model misspelled a key would take a live review out of a
     * human's queue (issue #58). Two nights make the gate decide something: night one detects the
     * contradiction and mints its review task; night two's only verdict names `m99`, and the task
     * must survive it. MUTATION: drop `unresolved === 0` from the sweep gate — night two closes the
     * task and `tasksClosed` reads 1.
     */
    const model = scriptedModel((request, at) =>
      at === 0
        ? value({
            verdicts: offeredKeys(request.prompt).map((key) =>
              verdict({ pairKey: key, rel: "contradicts" })
            )
          })
        : value({ verdicts: [verdict({ pairKey: "m99", rel: "caused_by" })] })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const nightOne = yield* edgeTyping(envFor(fixture))
          expect(nightOne.counts.contradictions).toBe(1)
          expect(nightOne.counts.tasksMinted).toBe(1)

          const later = instantFor("2026-08-03")
          const nightTwo = yield* edgeTyping({
            ...envFor(fixture),
            date: "2026-08-03",
            at: later.at,
            atMillis: later.millis
          })
          expect(nightTwo.counts.unresolved, "the dropped verdict is counted").toBe(1)
          expect(nightTwo.counts.judged, "and it never became a judgment").toBe(0)
          expect(nightTwo.counts.skipped).toBe(0)
          expect(nightTwo.counts.tasksClosed, "no sweep: part of the answer was unmappable").toBe(0)
        }),
      { seed: [SAFE_FILE, NOT_SAFE_FILE], model }
    )
  })

  it("batches in a deterministic order, so a night's keys land on the same pairs twice", async () => {
    /**
     * The determinism contract the kernel states and the phase owns: the kernel preserves the order it
     * is handed, and this phase sorts by shared directory then by `src`/`dst`. Asserted on the PROMPT
     * BYTES of two runs over one corpus, because the keys are what a verdict is turned into a write
     * through. Without this the sort could reverse and every other test here would stay green while a
     * night's key assignment moved from under the answer it is paired with.
     */
    const model = scriptedModel(() => value({ verdicts: [] }))
    const prompts = await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping(envFor(fixture))
          yield* edgeTyping(envFor(fixture))
          return model.calls.map((call) => call.prompt)
        }),
      { seed: WIDE_CORPUS, model }
    )
    const half = prompts.length / 2
    expect(half).toBeGreaterThan(1)
    expect(prompts.slice(0, half)).toEqual(prompts.slice(half))
    // And the first batch is genuinely a prefix of the corpus's order, not the whole of it.
    expect(prompts[0]).not.toEqual(prompts[1])
  })

  it("is skipped with a reason, not failed, when no model is bound", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* edgeTyping(envFor(fixture))
          expect(outcome.detail).toBe("no model bound")
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.commitSha).toBeNull()
        }),
      { seed: DEDUP_CORPUS }
    )
  })

  it("counts on a dry run and writes nothing", async () => {
    const model = scriptedModel((request) =>
      value({
        verdicts: offeredKeys(request.prompt).map((key) =>
          verdict({ pairKey: key, rel: "contradicts" })
        )
      })
    )
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* edgeTyping(envFor(fixture, true))
          expect(outcome.counts.candidates).toBeGreaterThan(0)
          expect(outcome.counts.judged).toBe(0)
          expect(outcome.llmCalls).toBe(0)
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: DEDUP_CORPUS, model }
    )
  })

  it("cuts each SIDE of a pair at the per-side budget, so one long memory cannot hide the other", async () => {
    /**
     * The budget is per SIDE, not per pair, and that is the property. A single budget over the whole
     * `src` + `dst` block would truncate `dst` away entirely on a long `src`, and the model would
     * return a verdict about a pair whose second half it never saw. Asserted on the offered text: both
     * headings survive, and the untruncated filler does not.
     */
    const model = scriptedModel(() => value({ verdicts: [] }))
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          yield* edgeTyping(envFor(fixture))
          expect(model.calls.length).toBeGreaterThan(0)
          for (const call of model.calls) {
            const blocks = call.prompt.match(/<pair_m\d+>\n([\s\S]*?)\n<\/pair_m\d+>/g) ?? []
            expect(blocks.length).toBeGreaterThan(0)
            for (const block of blocks) {
              // Two sides plus the `src:`/`dst:` headings, so the block is slightly wider than 2x.
              expect(block.length).toBeLessThan(EDGE_PAIR_SIDE_CHARS * 2 + 200)
              expect(block).toContain("src:")
              expect(block).toContain("dst:")
            }
            // And the untruncated body really was longer, so the assertion above is not vacuous.
            expect(call.prompt).not.toContain(LONG_FILLER.repeat(40))
          }
        }),
      { seed: LONG_CORPUS, model }
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

  it("treats a create whose title slugs onto a live arc as an UPDATE of that arc", async () => {
    /**
     * An arc file is written whole, so a `create` landing on an existing arc's path would replace
     * weeks of synthesis with a version that never read it. A slug collision with an arc the triage
     * call was OFFERED means the model re-derived an arc it failed to recognize, so the entry folds
     * onto the existing path — and the execute call must receive the CURRENT content, which is the
     * observable difference between an update and a blind create.
     */
    const EXISTING_ARC = "areas/arcs/drain-before-reverting.html"
    const existingArcHtml = memoryHtml({
      title: "Drain before reverting",
      claim: "Drain a load balancer before reverting the change behind it.",
      body: "Weeks of accumulated nuance about VIP draining live in this paragraph.",
      memoryType: "arc",
      createdAt: "2026-06-01T00:00:00Z"
    })
    const prompts: Array<string> = []
    const model = scriptedModel((request): ScriptedReply => {
      if (request.system.startsWith("You triage")) {
        return value({
          entries: [
            {
              // A CREATE, not an update: the collision is the model's failure to recognize its own arc.
              slug: "",
              title: "Drain before reverting",
              action: "create",
              rationale: "Looks new to the model.",
              evidenceKeys: ["e1"]
            }
          ]
        })
      }
      prompts.push(request.prompt)
      return value({
        title: "Drain before reverting",
        claim: "Drain a load balancer before reverting the change behind it.",
        paragraphs: ["The updated synthesis, carrying the evidence forward."]
      })
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* arcSynthesis(envFor(fixture))
          expect(outcome.counts.written).toBe(1)

          // The execute call saw the existing arc's content: it was an update, not a blind create.
          expect(prompts[0]).toContain("existing_arc")
          expect(prompts[0]).toContain("Weeks of accumulated nuance")

          // ONE arc under that slug — no ordinal twin was minted beside it.
          const arc = yield* atHead(fixture, EXISTING_ARC)
          expect(arc).toBeDefined()
          expect(arc).toContain("The updated synthesis")
          expect(yield* atHead(fixture, "areas/arcs/drain-before-reverting-2.html")).toBeUndefined()
        }),
      { seed: [...DEDUP_CORPUS, { path: EXISTING_ARC, html: existingArcHtml }], model }
    )
  })

  it("never overwrites a non-arc occupant of the slug's path with a whole-file write", async () => {
    /**
     * The disk half of the same collision: the path holds a FILE the triage call was never offered
     * — a demoted arc, a hand-written note — so the "update, not create" fold does not apply and the
     * write must take an ordinal instead of replacing bytes the phase never read.
     */
    const SQUATTER = "areas/arcs/first-arc.html"
    const squatterHtml = memoryHtml({
      title: "A note squatting the arc slug",
      claim: "This file is not an arc and was never offered to the triage call.",
      createdAt: "2026-06-01T00:00:00Z"
    })
    const model = scriptedModel(
      (request): ScriptedReply =>
        request.system.startsWith("You triage")
          ? value({
              entries: [
                {
                  slug: "",
                  title: "First arc",
                  action: "create",
                  rationale: "r1",
                  evidenceKeys: ["e1"]
                }
              ]
            })
          : value({ title: "First arc", claim: "The first principle.", paragraphs: ["Because."] })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* arcSynthesis(envFor(fixture))
          expect(outcome.counts.written).toBe(1)

          /**
           * The squatter SURVIVED as itself: same title, same claim, still a semantic memory and not
           * the arc template. Not asserted byte-identical, because the squatter is also part of the
           * evidence corpus and legitimately gains a `memhtml-part-of` HEAD stamp toward the arc —
           * the head-editor rule keeps that stamp outside the article's bytes.
           */
          const squatter = yield* atHead(fixture, SQUATTER)
          expect(squatter).toContain("<title>A note squatting the arc slug</title>")
          expect(squatter).toContain("never offered to the triage call")
          expect(squatter).toContain('content="semantic"')
          expect(squatter).not.toContain("The first principle.")
          // The arc landed at the first free ordinal instead.
          const arc = yield* atHead(fixture, "areas/arcs/first-arc-2.html")
          expect(arc).toBeDefined()
          expect(arc).toContain("The first principle.")
        }),
      { seed: [...DEDUP_CORPUS, { path: SQUATTER, html: squatterHtml }], model }
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

  /**
   * Three daily journals: `episodic`, each carrying a `day` facet, each the only record of its day.
   * They cluster (shared vocabulary, mutual links) exactly as issue #130 describes, and the same
   * retention shape as `COMMUNITY` so the pass bands them for compress.
   */
  const JOURNALS: ReadonlyArray<SeedFile> = ["01", "02", "03"].map((day, at, all) => ({
    path: `areas/journal/2026-09-${day}.html`,
    html: memoryHtml({
      title: `Journal for 2026-09-${day}`,
      claim: `Day ${String(at + 1)}: moved the analyzer chain behind the streamfleet indexer.`,
      body: "The analyzer chain reads the interval list the streamfleet indexer emits and merges it.",
      memoryType: "episodic",
      // Ten days before the run: `episodic` decays on a 10-day half-life, so a May stamp would land in
      // the evict band and never reach compress. This lands in the compress band, like `COMMUNITY`.
      createdAt: `2026-07-2${day.slice(1)}T00:00:00Z`,
      confidence: "0.50",
      importance: "4",
      facets: [
        { name: "doc-type", value: "daily-journal" },
        { name: "day", value: `2026-09-${day}` }
      ],
      links: all
        .filter((other) => other !== day)
        .map((other) => ({
          rel: "memhtml-relates-to",
          href: `/areas/journal/2026-09-${other}.html`
        }))
    })
  }))

  it("summarizes dated episodic records without archiving them, and links them from the canonical", async () => {
    /**
     * Issue #130. Compress is lossy by design and that is right for near-duplicate semantic memories;
     * a journal is not a restatement of the day before. So the canonical is written as an ENTRY POINT:
     * every member stays active at its own path, the facet address `day=<date>` keeps resolving, and
     * the canonical links to the members it summarizes rather than superseding them.
     */
    const model = scriptedModel(() =>
      value({
        title: "Journals, days 1 to 3",
        claim: "Three days went to moving the analyzer chain behind the streamfleet indexer.",
        paragraphs: ["Day one started it, day two moved it, day three finished it."],
        absorbedKeys: ["m1", "m2", "m3"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))

          expect(outcome.counts.canonicals).toBe(1)
          expect(outcome.counts.archived).toBe(0)
          expect(outcome.counts.kept).toBe(3)
          expect(outcome.commitSha).not.toBeNull()

          const canonical = "areas/journal/journals-days-1-to-3.html"
          const doc = yield* parseMemory((yield* atHead(fixture, canonical)) ?? "")
          expect(doc.links.filter((one) => one.rel === "supersedes")).toHaveLength(0)
          const related = doc.links.filter((one) => one.rel === "relates_to").map((one) => one.href)
          expect(related.sort()).toEqual(JOURNALS.map((file) => `/${file.path}`).sort())

          // Every journal is still live at its own path, and none was archived under any name.
          for (const file of JOURNALS) {
            expect(yield* atHead(fixture, file.path)).toBeDefined()
            expect(yield* atHead(fixture, archivePathFor(file.path, 2026))).toBeUndefined()
          }
        }),
      { seed: JOURNALS, model }
    )
  })

  it("does not fold the same journals again on the next run: the part_of stamp is the mark", async () => {
    /**
     * Being kept changes none of a journal's retention inputs, so without a mark the next night's pass
     * would band the same three, spend a model call, and write `journals-days-1-to-3-2.html`. The
     * `part_of` edge each kept member carries to its active canonical is that mark, read back through
     * the index the next run's preflight rebuilds. The second run here reindexes, runs compress again,
     * and must make no model call and write nothing.
     */
    const model = scriptedModel(() =>
      value({
        title: "Journals, days 1 to 3",
        claim: "Three days went to moving the analyzer chain behind the streamfleet indexer.",
        paragraphs: ["Day one started it, day two moved it, day three finished it."],
        absorbedKeys: ["m1", "m2", "m3"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const first = yield* compress(envFor(fixture))
          expect(first.counts.canonicals).toBe(1)
          expect(first.counts.kept).toBe(3)
          const callsAfterFirst = model.calls.length
          expect(callsAfterFirst).toBeGreaterThan(0)

          // Each kept journal now carries the mark, at HEAD.
          for (const file of JOURNALS) {
            const doc = yield* parseMemory((yield* atHead(fixture, file.path)) ?? "")
            expect(doc.links.filter((one) => one.rel === "part_of").map((one) => one.href)).toEqual(
              ["/areas/journal/journals-days-1-to-3.html"]
            )
          }

          yield* fixture.reindex()
          const second = yield* compress(envFor(fixture, false, "2026-08-03"))
          expect(second.counts.canonicals).toBe(0)
          expect(second.counts.kept).toBe(0)
          // The canonical itself may band (it is semantic and in the community), but alone it is no
          // batch; the three journals are out of the band, so nothing reaches the model.
          expect(second.counts.batches).toBe(0)
          expect(model.calls.length).toBe(callsAfterFirst)
          expect(
            yield* atHead(fixture, "areas/journal/journals-days-1-to-3-2.html")
          ).toBeUndefined()
        }),
      { seed: JOURNALS, model }
    )
  })

  it("archives the semantic members of a mixed batch and keeps its dated episodic one", async () => {
    const journal: SeedFile = {
      path: "areas/cache/2026-09-01.html",
      html: memoryHtml({
        title: "Journal for 2026-09-01",
        claim: "Day 1: watched the build cache warm from the shared volume on the first request.",
        body: "Warmup pulls the shared volume manifest and hydrates the local layer store slowly.",
        memoryType: "episodic",
        createdAt: "2026-07-23T00:00:00Z",
        confidence: "0.50",
        importance: "4",
        facets: [{ name: "day", value: "2026-09-01" }],
        links: [
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-one.html" },
          { rel: "memhtml-relates-to", href: "/areas/cache/cache-two.html" }
        ]
      })
    }
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim:
          "Build cache warmup reads the shared volume manifest, then hydrates the layer store.",
        paragraphs: ["Warmup is a two-step read: the manifest first, the layer store second."],
        // Keys follow path order: the journal sorts FIRST under areas/cache.
        absorbedKeys: ["m1", "m2", "m3", "m4"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))

          expect(outcome.counts.canonicals).toBe(1)
          expect(outcome.counts.archived).toBe(3)
          expect(outcome.counts.kept).toBe(1)

          const doc = yield* parseMemory(
            (yield* atHead(fixture, "areas/cache/build-cache-warmup.html")) ?? ""
          )
          expect(doc.links.filter((one) => one.rel === "supersedes")).toHaveLength(3)
          expect(
            doc.links.filter((one) => one.rel === "relates_to").map((one) => one.href)
          ).toEqual([`/${journal.path}`])
          expect(yield* atHead(fixture, journal.path)).toBeDefined()
          expect(yield* atHead(fixture, "areas/cache/cache-one.html")).toBeUndefined()
        }),
      { seed: [...COMMUNITY, journal], model }
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

  it("folds when the model answers the label-prefixed spelling the prompt displays", async () => {
    /**
     * The prompt shows each key only as `<member_m1>` wrapper tags, and a model that echoes that
     * spelling into `absorbedKeys` is answering the members it was offered. Before the resolver
     * canonicalized the spelling, every such answer resolved to zero members and the whole batch
     * skipped — 47 of 47 on a real corpus the night compress moved to a model that echoes the
     * wrapper name consistently.
     */
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim: "Build cache warmup reads the shared volume manifest first.",
        paragraphs: ["A two-step read."],
        absorbedKeys: ["member_m1", "member_m2", "member_m3"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.canonicals).toBe(1)
          expect(outcome.counts.skipped).toBe(0)
          // Path order over the three seeded members is one, three, two; the canonical's slug
          // matches none of them, so all three archive.
          expect(outcome.counts.archived).toBe(3)
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

  it("partitions skipped into failed and refused, so a night's report can say which it had", async () => {
    /**
     * A failed call and a refused answer are different diagnoses with different fixes — the wire
     * versus the answer — and a `skipped` that conflates them once read 47 refusals as flaky calls.
     * Two communities, one of each outcome: the sum stays `skipped`, and the parts name the split.
     */
    let call = 0
    const model = scriptedModel(() => {
      call += 1
      return call === 1
        ? violation("scripted: malformed tool payload")
        : value({
            title: "Unrelated memories",
            claim: "These memories do not describe one thing.",
            paragraphs: ["No fold is warranted."],
            absorbedKeys: []
          })
    })

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.skipped).toBe(2)
          expect(outcome.counts.failed).toBe(1)
          expect(outcome.counts.refused).toBe(1)
          expect(outcome.counts.canonicals).toBe(0)
        }),
      { seed: [...COMMUNITY, ...SECOND_COMMUNITY], model }
    )
  })

  it("never overwrites an on-disk file the synthesized title slugs onto", async () => {
    /**
     * The slug is a pure function of the model's title, so a fold can land on a path already
     * holding a file OUTSIDE the batch — a memory a human hand-corrected is the live case. Before
     * the probe, the canonical write silently replaced it as a MODIFY no report line mentioned.
     * The squatter here shares no links and no vocabulary with the community, so it is not a
     * member of the fold; only its PATH collides.
     */
    const SQUATTER = "areas/cache/build-cache-warmup.html"
    const squatterHtml = memoryHtml({
      title: "A hand-corrected note that happens to hold this path",
      claim: "The bastion host rotates its keypair every ninety days.",
      body: "Rotation is manual and the runbook names the operator on call.",
      createdAt: "2026-05-01T00:00:00Z"
    })
    const model = scriptedModel(() =>
      value({
        title: "Build cache warmup",
        claim: "Build cache warmup reads the shared volume manifest first.",
        paragraphs: ["A two-step read."],
        absorbedKeys: ["m1", "m2", "m3"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.canonicals).toBe(1)
          expect(outcome.counts.archived).toBe(3)

          // The squatter's bytes survived, byte-identically.
          expect(yield* atHead(fixture, SQUATTER)).toBe(squatterHtml)
          // And it was not archived under any name: only the three members moved.
          expect(yield* atHead(fixture, archivePathFor(SQUATTER, 2026))).toBeUndefined()

          // The canonical took the first free ordinal instead.
          const canonical = yield* atHead(fixture, "areas/cache/build-cache-warmup-2.html")
          expect(canonical).toBeDefined()
          const doc = yield* parseMemory(canonical ?? "")
          expect(doc.links.filter((one) => one.rel === "supersedes")).toHaveLength(3)
        }),
      { seed: [...COMMUNITY, { path: SQUATTER, html: squatterHtml }], model }
    )
  })

  it("gives two batches whose canonicals share a title two paths, not one write over the other", async () => {
    /**
     * The in-run half of the collision: the same night's second batch slugs onto the first
     * batch's canonical, and before the claimed set the second write replaced the first fold's
     * output — every member of batch one archived behind a canonical that then vanished.
     * Both communities live in ONE directory so the placement rule sends both canonicals there.
     */
    const CACHE_QUEUE: ReadonlyArray<SeedFile> = ["one", "two", "three"].map((name, offset) => ({
      path: `areas/cache/queue-${name}.html`,
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
            href: `/areas/cache/queue-${other}.html`
          }))
      })
    }))
    const model = scriptedModel((_request, offset) =>
      value({
        title: "One shared canonical title",
        claim:
          offset === 0
            ? "The canonical of the first community."
            : "The canonical of the second community.",
        paragraphs: ["Folded."],
        absorbedKeys: ["m1", "m2", "m3"]
      })
    )

    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const outcome = yield* compress(envFor(fixture))
          expect(outcome.counts.canonicals).toBe(2)
          expect(outcome.counts.archived).toBe(6)

          // The first batch's canonical still carries the FIRST claim.
          const first = yield* atHead(fixture, "areas/cache/one-shared-canonical-title.html")
          expect(first).toContain("The canonical of the first community.")
          // The second landed beside it at the next ordinal.
          const second = yield* atHead(fixture, "areas/cache/one-shared-canonical-title-2.html")
          expect(second).toContain("The canonical of the second community.")
        }),
      { seed: [...COMMUNITY, ...CACHE_QUEUE], model }
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

          /**
           * The counter reads TWO detections and `promoted = 0`, because the flag is a merge-time write:
           * it asserts the corpus carries the rename, and the rename is on a branch until `merge` lands
           * it. What the night earned is the LEDGER line, asserted here so this case cannot go green
           * against a phase that reached the gate and recorded nothing. `tests/entity-abort.test.ts`
           * owns the two ends of that: the discard, and the merge that applies it.
           */
          const promoted = yield* entityCorroborations(fixture)
          expect(promoted[0]?.promoted).toBe(0)
          expect(promoted[0]?.detections).toBe(2)
          expect(yield* pendingMarks(fixture, `sleep/2026-08-03`)).toEqual([
            {
              kind: "entity-promoted",
              entityType: "person",
              aliasName: PERSON_ALIAS,
              canonicalName: PERSON_CANONICAL,
              at: instantFor("2026-08-03").at
            }
          ])
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

  it("keeps a declaration's force after the person file is ARCHIVED", async () => {
    /**
     * Archiving a person file records that the corpus moved on from the person, not that two of their
     * names stopped being the same name. So the alias oracle's file list has to reach the archived form
     * — and it does not reach it for free, because eviction is the `git mv` into
     * `archive/<YYYY>/<original-path>`: an archived person file's path is
     * `archive/2026/resources/people/…` and stops matching `resources/people/%` entirely. A single
     * prefix pattern would say "archived files are included" while excluding every one of them, and the
     * silent consequence is the re-split this test exists to catch — a person the phase merged last
     * night comes apart the night after the declaration is archived.
     *
     * The file is seeded AT the archive path rather than moved there, because what is under test is the
     * READ, and seeding it directly is the same row `archiveFile` would produce with none of another
     * phase's behavior in the way. `archivePathFor` mints the path, so the test cannot disagree with the
     * mapping the archive actually uses.
     *
     * No model is bound, so the declaration is the ONLY thing that can produce this merge — the same
     * closure the night-one test above states.
     */
    const declaration = personFile({ canonical: PERSON_CANONICAL, aliases: [PERSON_ALIAS] })
    const archived: SeedFile = {
      path: archivePathFor(declaration.path, 2026),
      html: declaration.html
    }
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // Non-vacuous: the live path really holds nothing, so only the archived read can find this.
          expect(yield* atHead(fixture, declaration.path)).toBeUndefined()
          expect(yield* atHead(fixture, archived.path)).toContain(PERSON_ALIAS)

          const outcome = yield* entityResolution(envFor(fixture))
          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.aliasMerges).toBe(1)
          expect(outcome.counts.pendingCorroboration).toBe(0)

          const after = yield* atHead(fixture, SHORT_FORM)
          expect(after).toContain(personMeta(PERSON_CANONICAL))
          expect(after).not.toContain(personMeta(PERSON_ALIAS))
          expect(yield* entityCorroborations(fixture)).toEqual([])
        }),
      { seed: [...ENTITY_CORPUS, archived] }
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
     *
     * `aliasMerges: 0` here is a statement about THIS CORPUS, which seeds no person file — not about
     * what a no-model night can do. It used to be a pin on the phase's old behavior, where the
     * declarations were read only inside the model core; the test below is the one that pins the
     * corrected behavior, and the contrast between the two is what makes the declared-alias pass
     * visible. There is nothing here for it to merge, so the count is honest either way.
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

  it("applies a DECLARED alias on night one with NO MODEL BOUND at all", async () => {
    /**
     * The oracle's headline property, and the one the phase used not to have: issue #43 says entity
     * resolution consults declared aliases FIRST and that an alias-backed merge auto-commits regardless
     * of string distance. Reading the declarations only inside the model core delivered neither half —
     * a credential-free night left `laith` and `laith al-saadoon` split with a person file sitting in
     * the corpus saying they are one person, and a night WITH credentials applied the declaration only
     * if the model happened to propose that exact pair.
     *
     * Every other route to this merge is CLOSED here, which is what makes the assertion about the
     * declaration and nothing else:
     *
     * - No model is bound, so `llmCalls` is 0 and the clustering core never runs.
     * - Character overlap between the two forms is 0.476 (measured, `fixture.ts`), below even the 0.75
     *   review band, so the character pass neither merges them nor counts them.
     * - The corroboration table stays EMPTY, so this is night one and not a counter that was already
     *   part-way there.
     *
     * `sanju kumar` is the negative control the corpus already carries: a declaration naming two names
     * must not collapse a third person, so a phase that merged every person on any declaration is a
     * visible failure rather than a pass.
     */
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          expect(yield* atHead(fixture, SHORT_FORM)).toContain(personMeta(PERSON_ALIAS))

          const outcome = yield* entityResolution(envFor(fixture))

          expect(outcome.llmCalls).toBe(0)
          expect(outcome.counts.aliasMerges).toBe(1)
          expect(outcome.counts.llmMerges).toBe(0)
          expect(outcome.counts.pendingCorroboration).toBe(0)
          expect(outcome.commitSha).not.toBeNull()

          // The merge is FILE-BORNE on night one, which is what survives `rm index.db`.
          const after = yield* atHead(fixture, SHORT_FORM)
          expect(after).toContain(personMeta(PERSON_CANONICAL))
          expect(after).not.toContain(personMeta(PERSON_ALIAS))
          expect(yield* personNames(fixture)).not.toContain(PERSON_ALIAS)
          // And a third person the declaration says nothing about is untouched.
          expect(yield* atHead(fixture, SANJU)).toContain(personMeta("sanju kumar"))

          // No counter row: a declaration is evidence enough, so nothing is left waiting on a night two.
          expect(yield* entityCorroborations(fixture)).toEqual([])
        }),
      {
        seed: [
          ...ENTITY_CORPUS,
          personFile({ canonical: PERSON_CANONICAL, aliases: [PERSON_ALIAS] })
        ]
      }
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

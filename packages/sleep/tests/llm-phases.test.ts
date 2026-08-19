import { archivePathFor } from "@memhtml/contracts/paths"
import { parseMemory } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { PhaseEnv } from "../src/env.js"
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
import { instantFor } from "../src/run.js"
import { minedPairs, sharedEntityPairs } from "../src/sql.js"
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
          // No promotion and no typed edge means no commit at all — the counter lives in state.
          expect(outcome.counts.typed).toBe(0)
          expect(outcome.commitSha).toBeNull()
          expect(yield* atHead(fixture, SAFE)).not.toContain("memhtml-contradicts")
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

import {
  CONFIDENCE_COMMIT_DELTA,
  DEFAULT_CONFIDENCE_DECAY_ALPHA,
  DEFAULT_CONFIDENCE_FLOOR,
  decayConfidence
} from "@memhtml/domain"
import { contentHash, readMeta } from "@memhtml/html"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { confidenceOf, renderConfidence } from "../src/edits.js"
import type { PhaseEnv } from "../src/env.js"
import { confidenceDecay } from "../src/phases/confidence-decay.js"
import { instantFor } from "../src/run.js"
import { type Fixture, memoryHtml, seedAccess, withFixture } from "./fixture.js"

/**
 * The confidence-decay phase: which files it rewrites, and which it provably does not touch.
 *
 * Three exemptions have to hold at once, and the corpus below makes each observable:
 * a REINFORCED file is skipped whatever its confidence; a file whose delta falls under the commit gate
 * is skipped; and every other file is rewritten with its ARTICLE HASH UNCHANGED, because the decay is a
 * head edit and the hash is the dedup key.
 */

const DATE = "2026-08-02"

const REINFORCED = "areas/team/reinforced-fact.html"
const AT_FLOOR = "areas/team/already-at-the-floor.html"
const DECAYS = "areas/team/decays-normally.html"

/**
 * A confidence whose one decay step is under the 0.005 commit gate AND whose RENDERED value would
 * change if the gate were removed.
 *
 * Both conditions are required for this file to be a probe of the gate itself.
 *
 * - A delta of zero is no probe: at exactly the floor the decay is an exact fixed point, so a phase
 *   with no gate would still write nothing and a fixture seeded there would pass against a missing gate.
 * - A delta under half of `renderConfidence`'s last place is no probe either: `setMeta` writing the
 *   same three-decimal string is a no-op regardless of the gate, so the RENDERER would be doing the
 *   gate's job and the assertion would hold either way.
 *
 * The value found below therefore fails the test the moment the gate is weakened — verified by
 * reverting the gate to `before === after` and watching this test go red.
 */
const belowGateConfidence = (() => {
  for (let value = 2001; value <= 2400; value += 1) {
    const confidence = value / 10_000
    const after = decayConfidence(
      confidence,
      DEFAULT_CONFIDENCE_DECAY_ALPHA,
      DEFAULT_CONFIDENCE_FLOOR
    )
    const delta = Math.abs(confidence - after)
    const rendersDifferently = renderConfidence(confidence) !== renderConfidence(after)
    if (delta > 0 && delta < CONFIDENCE_COMMIT_DELTA && rendersDifferently) return confidence
  }
  throw new Error("no confidence found with a renderable sub-gate delta")
})()

const CORPUS = [
  {
    path: REINFORCED,
    html: memoryHtml({
      title: "A reinforced fact",
      claim: "The oncall rotation hands over at 09:00 UTC.",
      body: "Confirmed by the last three handovers, each of which reinforced this memory.",
      confidence: "0.90",
      createdAt: "2026-05-01T00:00:00Z"
    })
  },
  {
    path: AT_FLOOR,
    html: memoryHtml({
      title: "A claim already at the confidence floor",
      claim: "The legacy bastion may still be reachable from the office network.",
      body: "Never confirmed, and it has been eroding for many cycles without reinforcement.",
      confidence: renderConfidence(belowGateConfidence),
      createdAt: "2026-05-02T00:00:00Z"
    })
  },
  {
    path: DECAYS,
    html: memoryHtml({
      title: "A confident claim nobody has reinforced",
      claim: "The build cache lives on the shared volume mounted at slash scratch.",
      body: "Asserted once with high confidence and never confirmed since it was written down.",
      confidence: "0.95",
      createdAt: "2026-05-03T00:00:00Z"
    })
  }
]

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

const atHead = (fixture: Fixture, path: string): Effect.Effect<string> =>
  fixture.deps.git.run(["show", `HEAD:${path}`]).pipe(Effect.orDie)

describe("confidence-decay", () => {
  it("skips the reinforced file, skips the sub-gate file, and rewrites the rest", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          // The reinforcement lives in the state plane, which is the only writer of that fact.
          yield* seedAccess(fixture.db, {
            path: REINFORCED,
            accessCount: 4,
            reinforcementCount: 3,
            outcomeScore: 0.6,
            lastAccessedAt: "2026-08-01T00:00:00Z"
          })

          const beforeReinforced = yield* atHead(fixture, REINFORCED)
          const beforeAtFloor = yield* atHead(fixture, AT_FLOOR)
          const beforeDecays = yield* atHead(fixture, DECAYS)

          const outcome = yield* confidenceDecay(envFor(fixture))

          expect(outcome.counts.reinforced).toBe(1)
          expect(outcome.counts.belowGate).toBe(1)
          expect(outcome.counts.decayed).toBe(1)
          expect(outcome.commitSha).not.toBeNull()

          // The REINFORCED file is byte-identical. Not "unchanged confidence" — byte-identical, so
          // even the `memhtml-updated` stamp did not move.
          expect(yield* atHead(fixture, REINFORCED)).toBe(beforeReinforced)

          // The SUB-GATE file is byte-identical too: a change under 0.005 carries no
          // decision-relevant information and costs a reviewer a line of diff.
          expect(yield* atHead(fixture, AT_FLOOR)).toBe(beforeAtFloor)

          // The third file's confidence moved, downward, to the value the domain function computes.
          const afterDecays = yield* atHead(fixture, DECAYS)
          expect(afterDecays).not.toBe(beforeDecays)
          const before = confidenceOf(beforeDecays)
          const after = confidenceOf(afterDecays)
          expect(after).toBeLessThan(before)
          expect(readMeta(afterDecays, "memhtml-confidence")).toBe(
            renderConfidence(
              decayConfidence(before, DEFAULT_CONFIDENCE_DECAY_ALPHA, DEFAULT_CONFIDENCE_FLOOR)
            )
          )
          expect(readMeta(afterDecays, "memhtml-updated")).toBe(`${DATE}T00:00:00Z`)

          /**
           * THE LOAD-BEARING ONE. The rewritten file's ARTICLE hash is unchanged, so the decay cannot
           * move the dedup key — the phase touches the widest set of files in a sleep run, and a decay
           * that shifted content hashes would make every night's run collide files against each other.
           */
          expect(contentHash(afterDecays)).toBe(contentHash(beforeDecays))
        }),
      { seed: CORPUS }
    )
  })

  it("counts on a dry run and writes nothing", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const outcome = yield* confidenceDecay(envFor(fixture, true))
          expect(outcome.counts.decayed).toBeGreaterThan(0)
          expect(outcome.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)
          expect(yield* fixture.deps.store.dirtyPaths().pipe(Effect.orDie)).toEqual([])
        }),
      { seed: CORPUS }
    )
  })

  it("reaches a fixed point: repeated runs stop committing once every delta is sub-gate", async () => {
    await withFixture(
      (fixture) =>
        Effect.gen(function* () {
          /**
           * Decay is unconditionally non-increasing and stops AT the floor, so the deltas shrink every
           * cycle and eventually fall under the gate. The phase then commits nothing at all — which is
           * what keeps a corpus that has finished decaying from producing a commit every night forever.
           */
          let committed = 0
          for (let cycle = 0; cycle < 40; cycle += 1) {
            const outcome = yield* confidenceDecay(envFor(fixture))
            if (outcome.commitSha !== null) committed += 1
            yield* fixture.reindex()
          }
          expect(committed).toBeGreaterThan(0)

          const head = (yield* fixture.raw("rev-parse", "HEAD")).trim()
          const settled = yield* confidenceDecay(envFor(fixture))
          expect(settled.counts.decayed).toBe(0)
          expect(settled.commitSha).toBeNull()
          expect((yield* fixture.raw("rev-parse", "HEAD")).trim()).toBe(head)

          // And nothing decayed below the floor.
          const final = confidenceOf(yield* atHead(fixture, DECAYS))
          expect(final).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_FLOOR - 0.001)
        }),
      { seed: CORPUS }
    )
  })
})

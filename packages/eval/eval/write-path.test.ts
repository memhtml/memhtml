import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { KNOWN_GAP_CLASSES, WRITE_PATH_CORPUS } from "../src/write-path-corpus.js"
import { agrees, summarizeWritePath } from "../src/write-path-metrics.js"
import {
  corpusSha256,
  readManifest,
  replayDrift,
  runWritePathDiscrimination,
  transcriptsSha256,
  WRITE_PATH_BASELINE_F1,
  WRITE_PATH_F1_FLOOR
} from "../src/write-path-run.js"

/**
 * The write-path discrimination arm, end to end, against the production gate.
 *
 * Nothing here fakes the gate: the decode is the consolidator's schema, the grounding and quote
 * checks are the door's own functions re-reading real JSONL from disk, and the refusal is the sleep
 * phase's. The only thing substituted is the SOURCE of the candidates, which is the labeled corpus
 * instead of a model, and that substitution is the whole point: the model is what the corpus stands
 * in for, so the gate is measured on candidates whose right answer is known.
 *
 * Three gates, from coarse to fine: F1 at or above the floor; the known-gap set exactly as stated;
 * every per-item decision identical to the frozen manifest.
 */

const run = () => Effect.runPromise(runWritePathDiscrimination())

describe("the write-path gate on the labeled corpus", () => {
  it("clears the F1 floor, which is the measured baseline minus five points", async () => {
    const report = await run()
    expect(report.items).toBe(WRITE_PATH_CORPUS.length)
    expect(report.good).toBe(report.bad)
    expect(report.f1Floor).toBe(WRITE_PATH_F1_FLOOR)
    // The derivation, pinned: floor = baseline − 0.05, floored to two decimals.
    expect(report.f1Floor).toBe(Math.floor((WRITE_PATH_BASELINE_F1 - 0.05) * 100) / 100)
    expect(report.f1).toBeGreaterThanOrEqual(report.f1Floor)
    expect(report.passed).toBe(true)
  })

  it("reaches every stage of the gate at least once, so no stage is measured vacuously", async () => {
    /**
     * A corpus that never reached `door:quote` would report a perfect quote check it never ran. Each
     * refusal stage has to own at least one decision, and `accepted` has to own at least one too.
     */
    const report = await run()
    const stages = new Set(report.decisions.map((decision) => decision.stage))
    expect([...stages].sort()).toEqual(
      ["accepted", "door:grounding", "door:quote", "door:schema", "phase:refusal"].sort()
    )
  })

  it("disagrees with a label ONLY in the classes stated as known gaps", async () => {
    /**
     * Both directions. A disagreement outside `KNOWN_GAP_CLASSES` is a regression (the gate stopped
     * catching something it caught, or started refusing something it accepted). A known-gap class with
     * NO disagreement means the gate now covers it, and the corpus's statement of the gap is stale —
     * update `KNOWN_GAP_CLASSES` and refreeze, so the record of what is uncovered stays true.
     */
    const report = await run()
    const disagreeing = report.perClass.filter((entry) => entry.disagreed.length > 0)
    expect(disagreeing.map((entry) => entry.class).sort()).toEqual([...KNOWN_GAP_CLASSES].sort())
    for (const entry of disagreeing) {
      // A gap class is uncovered for EVERY one of its items, not for some: a half-caught class would
      // mean the gate is discriminating on something other than the class definition.
      expect(entry.agreed).toBe(0)
    }
  })

  it("replays the frozen manifest decision for decision", async () => {
    /**
     * The fine alarm. F1 can hold while one decision flips and another flips back; this cannot. A
     * drift here is not automatically a defect (a fixed gap is a drift too), but it is always a
     * change the manifest has to record, which is why the message names the freeze command.
     */
    const [report, frozen] = await Promise.all([run(), Effect.runPromise(readManifest())])
    expect(frozen.corpusSha256).toBe(corpusSha256())
    expect(frozen.transcriptsSha256).toBe(transcriptsSha256())
    expect(frozen.f1Floor).toBe(report.f1Floor)
    const drift = replayDrift(frozen, report)
    expect(
      drift,
      `decisions drifted from fixtures/write-path-discrimination.manifest.json; if the change is intended, run pnpm freeze:write-path and review the diff: ${JSON.stringify(drift)}`
    ).toEqual([])
    expect(frozen.metrics.f1).toBe(report.f1)
    expect(frozen.metrics.confusion).toEqual(report.confusion)
  })

  it("is deterministic: two runs agree exactly", async () => {
    const [first, second] = await Promise.all([run(), run()])
    expect(second.decisions).toEqual(first.decisions)
    expect(second.f1).toBe(first.f1)
  })

  it("names the disagreements, so a reader can go to the item", async () => {
    const report = await run()
    const disagreements = report.decisions.filter((decision) => !agrees(decision))
    // The frozen gap set is four items: three bad ones accepted, one good one refused.
    expect(disagreements.map((d) => d.id).sort()).toEqual(["b10", "b11", "b31", "g29"])
    expect(disagreements.find((d) => d.id === "g29")?.stage).toBe("door:grounding")
  })
})

describe("the floor fires", () => {
  it("fails the same decisions against a floor above the measured F1", async () => {
    const report = await run()
    const strict = summarizeWritePath(report.decisions, report.f1 + 0.0001)
    expect(strict.passed).toBe(false)
    expect(strict.f1).toBe(report.f1)
  })
})

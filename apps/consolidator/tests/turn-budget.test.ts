import { describe, expect, it } from "vitest"

import { turnBudgetMsFor } from "../src/client.js"

/**
 * The turn budget as a function of the batch (issue #99).
 *
 * The values asserted are the CONTRACT, not incidentals: ten minutes of base plus three per
 * transcript is what the constants say, and a drifted constant should fail here rather than
 * resurface as a run killed mid-read. The override arm is the sharper one — an operator's stated
 * ceiling must not be scaled, or setting it would mean something other than what was set.
 */
describe("turnBudgetMsFor", () => {
  it("charges the base alone for an empty batch", () => {
    expect(turnBudgetMsFor({ transcriptCount: 0 })).toBe(10 * 60_000)
  })

  it("scales with the batch: a default batch of ten gets forty minutes", () => {
    expect(turnBudgetMsFor({ transcriptCount: 10 })).toBe(40 * 60_000)
  })

  it("a single transcript gets more than the old flat-per-ten share", () => {
    // Ten transcripts under the pre-#99 flat budget shared 600000ms — one minute each. One
    // transcript now has thirteen minutes to itself, and the assertion pins the direction rather
    // than re-deriving the arithmetic above.
    expect(turnBudgetMsFor({ transcriptCount: 1 })).toBeGreaterThan(600_000 / 10)
  })

  it("an override replaces the computation outright, never scaled by the batch", () => {
    expect(turnBudgetMsFor({ transcriptCount: 10, override: 5_000 })).toBe(5_000)
    expect(turnBudgetMsFor({ transcriptCount: 0, override: 5_000 })).toBe(5_000)
  })

  it("an absent override is the scaling default, not zero", () => {
    expect(turnBudgetMsFor({ transcriptCount: 3, override: undefined })).toBe(
      10 * 60_000 + 3 * 3 * 60_000
    )
  })
})

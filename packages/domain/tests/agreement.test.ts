import * as fc from "fast-check"
import { describe, expect, it } from "vitest"

import { type ClaimedRecord, frameGroupAgrees, normalizeClaim } from "../src/agreement.js"

/**
 * The agreement rule the curator's planner and a session commit share. The planner's own cases
 * (`packages/curator/tests/planner.test.ts`, "the pieces") drive it through real records; these pin
 * it at the domain boundary, with no parser in between.
 */

const semantic = (claim: string, title = "A fact"): ClaimedRecord => ({
  memoryType: "semantic",
  title,
  claim
})

const verdict = (title: string): ClaimedRecord => ({
  memoryType: "verdict",
  title,
  claim: "Review verdict for objective: retries stay bounded in the widget."
})

describe("frameGroupAgrees", () => {
  it("agrees on one value whatever its case, spacing, or final period", () => {
    expect(
      frameGroupAgrees([
        semantic("The capital of India is New Delhi."),
        semantic("the capital of  INDIA is new delhi")
      ])
    ).toBe(true)
  })

  it("disagrees on two values in one frame", () => {
    expect(
      frameGroupAgrees([
        semantic("The capital of India is New Delhi."),
        semantic("The capital of India is Mumbai.")
      ])
    ).toBe(false)
  })

  it("holds two verdicts on one objective apart unless they carry one ruling", () => {
    expect(frameGroupAgrees([verdict("verdict: approved"), verdict("verdict: rejected")])).toBe(
      false
    )
    expect(frameGroupAgrees([verdict("verdict: approved"), verdict("Verdict: approved.")])).toBe(
      true
    )
  })

  it("a record always agrees with itself", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.constantFrom("semantic", "verdict", "task"),
        (claim, title, memoryType) => {
          const record = { memoryType, title, claim }
          expect(frameGroupAgrees([record, record])).toBe(true)
        }
      )
    )
  })
})

describe("normalizeClaim", () => {
  it("collapses spacing, lowercases, and drops one final period", () => {
    expect(normalizeClaim("  The Capital  of India is New Delhi.. ")).toBe(
      "the capital of india is new delhi."
    )
  })
})

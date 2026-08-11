import {
  negationDivergent,
  numericTokenDivergent,
  variantQualifierDivergent
} from "@memhtml/domain"
import { describe, expect, it } from "vitest"

import {
  DIVERGENCE_FAMILIES,
  deriveControl,
  familyPredicate,
  negationFlip,
  numericFlip,
  variantFlip,
  wholeText
} from "../src/controls.js"

/**
 * The control generator's contract: every control it emits is adversarial under its OWN family's
 * predicate, and a pair that is not is REFUSED rather than shipped.
 *
 * This is the direct lock on binding finding #33. The corpus generator currently produces
 * marker-free bodies, so a corpus-level assertion would pass with the guard removed — it would be
 * vacuous. These tests hand `deriveControl` the masking input directly, which is the only way to
 * prove the refusal exists.
 */

describe("the negation family and the masking window (finding #33)", () => {
  it("refuses a flip on a target whose body already carries a negation marker", () => {
    /**
     * The load-bearing case. `negationDivergent` is a marker-PRESENCE check over the whole text, so a
     * body already saying `no` puts a marker on BOTH sides of the pair and the predicate returns
     * false — the flip is invisible to the very guard that defines the family. A generator that
     * shipped this pair would produce a "control" the retrieval stack is RIGHT to rank alongside its
     * target, and a gate built on it would pass no matter how badly discrimination worked.
     */
    const masked = {
      claim: "The drain step is safe to run during business hours.",
      body: ["No request is dropped while the old fleet is retired."]
    }
    expect(
      negationDivergent(
        wholeText(masked),
        wholeText({ ...masked, claim: negationFlip(masked.claim) })
      )
    ).toBe(false)
    expect(deriveControl(masked, "negation")).toBeUndefined()
  })

  it("accepts a flip on a clean target, and the predicate fires on the pair", () => {
    const clean = {
      claim: "The drain step is safe to run during business hours.",
      body: ["Connection draining completes before the old fleet is retired."]
    }
    const control = deriveControl(clean, "negation")
    expect(control).toBeDefined()
    expect(control?.claim).toContain("is not safe")
    expect(
      negationDivergent(
        wholeText(clean),
        wholeText(control as { claim: string; body: ReadonlyArray<string> })
      )
    ).toBe(true)
  })

  it("refuses when the marker sits in the CLAIM rather than the body", () => {
    // Same masking, one field over: the predicate reads claim and body as one text.
    const masked = { claim: "A rollback cannot proceed while the VIP is draining.", body: [] }
    expect(deriveControl(masked, "negation")).toBeUndefined()
  })

  it("negates through a verb anchor rather than prefixing the sentence", () => {
    // A flip that reads as a claim, not as commentary about one: an embedding of "It is not true
    // that X" is dominated by the meta-framing, so the pair would be far apart and the control
    // would not be a high-cosine adversary at all.
    expect(negationFlip("The shard rebuild is idempotent.")).toBe(
      "The shard rebuild is not idempotent."
    )
    expect(negationFlip("Operators must drain the VIP first.")).toBe(
      "Operators must not drain the VIP first."
    )
  })

  it("is total: a claim with no verb anchor still yields a flipped claim", () => {
    // Never the input unchanged. An identical control is a content-hash duplicate the partial unique
    // index refuses at INDEX time, which surfaces as a corpus that cannot be built rather than as a
    // weak probe.
    const flipped = negationFlip("Rollback ordering: VIP drain, then revert.")
    expect(flipped).not.toBe("Rollback ordering: VIP drain, then revert.")
    expect(flipped.toLowerCase()).toContain("not")
  })
})

describe("the numeric family", () => {
  it("replaces the first quantity and the predicate fires", () => {
    const target = { claim: "Retry the capture step 3 times before failing over.", body: [] }
    const control = deriveControl(target, "numeric")
    expect(control?.claim).toBe("Retry the capture step 13 times before failing over.")
    expect(numericTokenDivergent(wholeText(target), wholeText(control as never))).toBe(true)
  })

  it("refuses when the claim carries no quantity at all", () => {
    // The family does not APPLY. Inventing a number would make the control differ by an added fact
    // rather than by a contradicted one, which is a different test wearing this family's name.
    expect(
      deriveControl({ claim: "The shard rebuild is idempotent.", body: [] }, "numeric")
    ).toBeUndefined()
  })

  it("keeps a replaced quantity in a plausible range", () => {
    // +10 on a small integer, doubling above 100: a retry budget of 13 is a believable
    // misremembering of 3 and 3000 is not, so the control stays a plausible wrong answer.
    expect(numericFlip("retry 3 times")).toBe("retry 13 times")
    expect(numericFlip("a 500 ms budget")).toBe("a 1000 ms budget")
  })
})

describe("the variant family", () => {
  it("inserts a qualifier the domain's vocabulary knows", () => {
    const target = { claim: "The settlement lane is drained before cutover.", body: [] }
    const control = deriveControl(target, "variant", {
      anchor: "settlement lane",
      qualifier: "beta"
    })
    expect(control?.claim).toContain("settlement lane beta")
    expect(variantQualifierDivergent(wholeText(target), wholeText(control as never))).toBe(true)
  })

  it("refuses a qualifier outside the domain's vocabulary", () => {
    /**
     * `VARIANT_QUALIFIERS` is a closed set in `@memhtml/domain`. A word outside it produces a pair the
     * predicate cannot see, so the control is refused — which is what keeps this family bound to the
     * SAME vocabulary the sleep cycle's merge veto uses rather than to a list that drifted.
     */
    const target = { claim: "The settlement lane is drained before cutover.", body: [] }
    expect(
      deriveControl(target, "variant", { anchor: "settlement lane", qualifier: "turquoise" })
    ).toBeUndefined()
  })

  it("is total when the anchor is absent", () => {
    // A trailing scope sentence rather than the input unchanged, for the same content-hash reason the
    // negation flip is total.
    const flipped = variantFlip("The capture step retries once.", "no such anchor", "legacy")
    expect(flipped).toContain("legacy")
    expect(flipped).not.toBe("The capture step retries once.")
  })
})

describe("every family checks its OWN predicate, never the disjunction", () => {
  it.each(DIVERGENCE_FAMILIES)("%s validates through its own predicate", (family) => {
    /**
     * Why this matters: the numeric predicate fires on ANY numeric-token difference, so validating a
     * negation control against the disjunction would let an incidental digit certify a pair whose
     * polarity flip did nothing. `familyPredicate` is what keeps each family honest, and this asserts
     * the mapping rather than trusting it.
     */
    const predicate = familyPredicate(family)
    const affirmative = { claim: "The migration ledger is locked for 5 minutes.", body: [] }
    const control = deriveControl(affirmative, family, {
      anchor: "migration ledger",
      qualifier: "legacy"
    })
    expect(control).toBeDefined()
    expect(predicate(wholeText(affirmative), wholeText(control as never))).toBe(true)
  })

  it("does not let a numeric difference certify a masked negation pair", () => {
    // The exact confusion the per-family check prevents: this pair IS numerically divergent under the
    // disjunction, and its polarity flip is still invisible.
    const masked = { claim: "No retry is issued after 3 attempts.", body: [] }
    expect(numericTokenDivergent(wholeText(masked), "No retry is issued after 13 attempts.")).toBe(
      true
    )
    expect(deriveControl(masked, "negation")).toBeUndefined()
  })
})

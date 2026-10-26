import { frameValueOf } from "./frame.js"

/**
 * Whether records that share a frame key say the same thing: the one rule the curator's planner
 * reads before it folds a frame-key group and a session commit reads before it links a
 * `memhtml-contradicts` edge, so the two never disagree about what a disagreement is.
 */

/** What the rule reads of a record: its memory type, its title, and its claim. */
export interface ClaimedRecord {
  readonly memoryType: string
  readonly title: string
  readonly claim: string
}

/** A claim (or a title) as two restatements are compared: one space, lowercase, no final period. */
export const normalizeClaim = (claim: string): string =>
  claim.replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "")

/**
 * True when a frame-key group states one value or one claim, so no member says what another does
 * not.
 *
 * A `verdict` record carries its judgment in the title (`verdict: suppressed_failure`) over a claim
 * that is the objective judged, so two verdicts with one claim and two titles disagree the way two
 * values do; measured on the 2026-09-22 store, one of the eleven shared frame keys was exactly that
 * pair (`unsupported_claim` beside `unverifiable-citation`), and the other ten were byte-identical
 * re-mints.
 */
export const frameGroupAgrees = (records: ReadonlyArray<ClaimedRecord>): boolean => {
  if (
    records.every((record) => record.memoryType === "verdict") &&
    new Set(records.map((record) => normalizeClaim(record.title))).size > 1
  ) {
    return false
  }
  const values = new Set(
    records.map((record) => frameValueOf(record.claim) ?? normalizeClaim(record.claim))
  )
  if (values.size === 1) return true
  return new Set(records.map((record) => normalizeClaim(record.claim))).size === 1
}

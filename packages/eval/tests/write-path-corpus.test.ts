import { transcriptQuoteChecker } from "@memhtml/consolidator"
import { describe, expect, it } from "vitest"

import {
  B_LONG,
  BATCH_SESSION_IDS,
  CEILINGS,
  KNOWN_GAP_CLASSES,
  type LabeledCandidate,
  MANY_SPANS,
  padTo,
  TRANSCRIPTS,
  WRITE_PATH_CORPUS
} from "../src/write-path-corpus.js"
import {
  breakdownByClass,
  confusionOf,
  describeWritePath,
  type LabeledDecision,
  summarizeWritePath
} from "../src/write-path-metrics.js"

/**
 * The fast tier: the corpus's own invariants and the metrics arithmetic, with no gate run.
 *
 * The corpus is the oracle, so its labels have to be checkable without trusting the gate. A `good`
 * item's quotes are verified against the transcript here with the door's OWN containment predicate
 * (`transcriptQuoteChecker`), which is a label check and not a gate check: the label says "these
 * quotes are verbatim", and this is the sentence that makes the label a fact.
 */

const checkers = new Map(
  TRANSCRIPTS.map((one) => [one.sessionId, transcriptQuoteChecker(one.jsonl)] as const)
)

const evidenceOf = (item: LabeledCandidate) =>
  (item.candidate as { evidence?: ReadonlyArray<{ sessionId: string; quote: string }> }).evidence ??
  []

describe("the labeled corpus", () => {
  it("holds at least 60 items, balanced, with unique ids and a provenance on every label", () => {
    expect(WRITE_PATH_CORPUS.length).toBeGreaterThanOrEqual(60)
    const good = WRITE_PATH_CORPUS.filter((item) => item.label === "good")
    const bad = WRITE_PATH_CORPUS.filter((item) => item.label === "bad")
    expect(good.length).toBe(bad.length)
    expect(new Set(WRITE_PATH_CORPUS.map((item) => item.id)).size).toBe(WRITE_PATH_CORPUS.length)
    for (const item of WRITE_PATH_CORPUS) {
      expect(item.provenance.length, item.id).toBeGreaterThan(20)
      // Every provenance names the file or plan clause that decides the label.
      expect(item.provenance, item.id).toMatch(/\.ts|TRACE-2/)
    }
  })

  it("every good item's quotes are verbatim in the session they cite", () => {
    for (const item of WRITE_PATH_CORPUS.filter((one) => one.label === "good")) {
      for (const quote of evidenceOf(item)) {
        const checker = checkers.get(quote.sessionId.trim())
        expect(checker, `${item.id} cites ${quote.sessionId}`).toBeDefined()
        expect(checker?.contains(quote.quote), `${item.id}: ${quote.quote.slice(0, 60)}`).toBe(true)
      }
    }
  })

  it("every fabricated-quote item carries at least one quote that is NOT in its cited session", () => {
    for (const item of WRITE_PATH_CORPUS.filter((one) =>
      one.class.startsWith("fabricated-quote")
    )) {
      const invented = evidenceOf(item).filter(
        (quote) => !(checkers.get(quote.sessionId)?.contains(quote.quote) ?? false)
      )
      expect(invented.length, item.id).toBeGreaterThan(0)
    }
  })

  it("every ungrounded-session item cites a session outside the batch", () => {
    for (const item of WRITE_PATH_CORPUS.filter((one) =>
      one.class.startsWith("ungrounded-session")
    )) {
      const outside = evidenceOf(item).filter(
        (quote) => !BATCH_SESSION_IDS.includes(quote.sessionId)
      )
      expect(outside.length, item.id).toBeGreaterThan(0)
    }
  })

  it("the ceiling cases sit exactly at and one past the contract's bounds", () => {
    const by = (id: string) =>
      WRITE_PATH_CORPUS.find((item) => item.id === id)?.candidate as Record<string, unknown>
    expect((by("g18").claim as string).length).toBe(CEILINGS.claim)
    expect((by("b20").claim as string).length).toBe(CEILINGS.claim + 1)
    expect((by("g19").gist as string).length).toBe(CEILINGS.gist)
    expect((by("b21").gist as string).length).toBe(CEILINGS.gist + 1)
    expect((by("g21").evidence as unknown[]).length).toBe(CEILINGS.evidence)
    expect((by("b23").evidence as unknown[]).length).toBe(CEILINGS.evidence + 1)
    expect((by("g22").entities as unknown[]).length).toBe(CEILINGS.entities)
    expect((by("b24").entities as unknown[]).length).toBe(CEILINGS.entities + 1)
    const longQuote = (by("g20").evidence as Array<{ quote: string }>)[0]?.quote ?? ""
    expect(longQuote.length).toBe(CEILINGS.quote)
    expect(B_LONG.length).toBeGreaterThan(CEILINGS.quote + 100)
  })

  it("the many-span pool is distinct and verbatim, wide enough for the evidence ceiling", () => {
    expect(MANY_SPANS.length).toBeGreaterThan(CEILINGS.evidence)
    expect(new Set(MANY_SPANS.map((span) => span.quote)).size).toBe(MANY_SPANS.length)
    for (const span of MANY_SPANS) {
      expect(checkers.get(span.sessionId)?.contains(span.quote), span.quote.slice(0, 40)).toBe(true)
    }
  })

  it("padTo lands exactly on the length and never ends in a space", () => {
    for (const length of [10, 300, 301, 1500, 1501]) {
      const padded = padTo("A short claim.", length)
      expect(padded.length).toBe(length)
      expect(padded.endsWith(" ")).toBe(false)
    }
  })

  it("names its known gaps as classes that exist in the corpus", () => {
    const classes = new Set(WRITE_PATH_CORPUS.map((item) => item.class))
    for (const gap of KNOWN_GAP_CLASSES) expect(classes.has(gap), gap).toBe(true)
  })
})

const decision = (
  id: string,
  label: "good" | "bad",
  cls: string,
  accepted: boolean
): LabeledDecision => ({
  id,
  label,
  class: cls,
  accepted,
  stage: accepted ? "accepted" : "door:schema",
  reason: accepted ? null : "scripted"
})

describe("the discrimination metrics", () => {
  it("computes the four cells with bad-rejected as the positive", () => {
    const decisions = [
      decision("b1", "bad", "x", false),
      decision("b2", "bad", "x", false),
      decision("b3", "bad", "y", true),
      decision("g1", "good", "p", true),
      decision("g2", "good", "q", false)
    ]
    expect(confusionOf(decisions)).toEqual({
      badRejected: 2,
      goodRejected: 1,
      badAccepted: 1,
      goodAccepted: 1
    })
    const report = summarizeWritePath(decisions, 0.5)
    // precision 2/3, recall 2/3, F1 2/3.
    expect(report.precision).toBe(0.6667)
    expect(report.recall).toBe(0.6667)
    expect(report.f1).toBe(0.6667)
    expect(report.accuracy).toBe(0.6)
    expect(report.passed).toBe(true)
    expect(summarizeWritePath(decisions, 0.7).passed).toBe(false)
  })

  it("breaks the decisions down by class and names the disagreeing ids", () => {
    const breakdown = breakdownByClass([
      decision("b1", "bad", "x", false),
      decision("b2", "bad", "x", true),
      decision("g1", "good", "p", true)
    ])
    expect(breakdown).toEqual([
      { class: "x", label: "bad", items: 2, agreed: 1, disagreed: ["b2"] },
      { class: "p", label: "good", items: 1, agreed: 1, disagreed: [] }
    ])
  })

  it("refuses an empty corpus and a single-label corpus rather than passing vacuously", () => {
    expect(summarizeWritePath([], 0).passed).toBe(false)
    const onlyBad = [decision("b1", "bad", "x", false), decision("b2", "bad", "x", false)]
    const report = summarizeWritePath(onlyBad, 0)
    // Perfect precision and recall on a corpus that cannot have discriminated anything.
    expect(report.f1).toBe(1)
    expect(report.passed).toBe(false)
  })

  it("describes a failure by naming the first disagreement", () => {
    const report = summarizeWritePath(
      [decision("g1", "good", "p", false), decision("b1", "bad", "x", false)],
      0.99
    )
    const line = describeWritePath(report)
    expect(line).toContain("FAILED")
    expect(line).toContain("g1 (p, labeled good) was refused at door:schema")
  })
})

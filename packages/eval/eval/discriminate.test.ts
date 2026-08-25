import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import { discriminate, MRR_FLOOR, runFloor, summarize } from "../src/discriminate.js"
import { failingEmbedder, withStack } from "../src/harness.js"
import { DiscriminationFailed, discriminationGate, runDiscrimination } from "../src/run.js"

/**
 * The gate, end to end, against the real ranking stack over a generated corpus.
 *
 * Nothing here fakes retrieval, the indexer, the migrations, or git. The only substituted edge is the
 * embedder — which is the whole reason the gate can run in CI: the deterministic embedder's cosine
 * relations are a pure function of the text, so the numbers are reproducible on any machine with no
 * credentials, while `live` mode measures the same probes against Bedrock's own vector space.
 */

describe("the gate on the fixture corpus", () => {
  it("passes with zero inversions and MRR at the floor", async () => {
    const report = await Effect.runPromise(
      withStack((stack) =>
        discriminate(stack.retrieval, stack.fixture.spec.probes, { mode: "fake" }).pipe(
          Effect.orDie
        )
      )
    )

    expect(report.probes).toBeGreaterThanOrEqual(30)
    expect(report.inversions).toEqual([])
    expect(report.discriminated).toBe(report.probes)
    expect(report.mrr).toBeGreaterThanOrEqual(MRR_FLOOR)
    expect(report.passed).toBe(true)
    // Every probe was ranked with the vector arm firing: a degraded probe here would mean the fake
    // embedder failed and the run silently measured the lexical floor instead.
    expect(report.degradedProbes).toBe(0)
  })

  it("indexes the whole generated corpus with nothing skipped", async () => {
    // A file the indexer refused is a file no probe can reach, which reads as an inversion rather
    // than as an unparseable fixture.
    const indexed = await Effect.runPromise(
      withStack((stack) =>
        Effect.succeed({ indexed: stack.indexed, written: stack.fixture.written })
      )
    )
    expect(indexed.indexed).toBe(indexed.written)
    expect(indexed.indexed).toBeGreaterThan(200)
  })

  it("reports the two MRR readings in their own coordinate spaces", async () => {
    /**
     * The semantic-contracts rule applied to this report: `mrr` and `corpusMrr` are the same
     * arithmetic over DIFFERENT sets, and only the first is gated. `corpusMrr` is dominated by corpus
     * size — the arm limit is 40, which is 13% of this fixture and under 1% of a real corpus — so a
     * gate on it would be a gate on how big the fixture is.
     *
     * The relation is `mrr >= corpusMrr`, and it is STRUCTURAL rather than empirical: a target's
     * discrimination rank is its rank among itself plus its OWN controls, which is a subset of the
     * corpus, so it can never be worse than its rank across the whole corpus. That inequality is
     * what pins the two readings as non-interchangeable.
     *
     * Both currently read exactly `1` on this fixture — every target outranks its controls AND every
     * other memory in the corpus — so this assertion has no numeric headroom here. It can only break
     * on a regression that makes a subset rank worse than a corpus rank, which would mean the ranks
     * are being computed over the wrong sets. The inversion count and the MRR floor are what catch a
     * quality regression; this catches a coordinate-space one.
     */
    const report = await Effect.runPromise(
      withStack((stack) =>
        discriminate(stack.retrieval, stack.fixture.spec.probes, { mode: "fake" }).pipe(
          Effect.orDie
        )
      )
    )
    expect(report.mrr).toBeGreaterThanOrEqual(report.corpusMrr)
    for (const result of report.results) {
      // The discrimination rank can never exceed one plus the number of impostors.
      expect(result.discriminationRank).toBeLessThanOrEqual(result.controlRanks.length + 1)
      expect(result.discriminationRank).toBeGreaterThanOrEqual(1)
    }
  })

  it("is deterministic: two runs over one seed agree exactly", async () => {
    const run = () =>
      Effect.runPromise(
        withStack((stack) =>
          discriminate(stack.retrieval, stack.fixture.spec.probes, { mode: "fake" }).pipe(
            Effect.orDie
          )
        )
      )
    const [first, second] = await Promise.all([run(), run()])
    expect(second.mrr).toBe(first.mrr)
    expect(second.corpusMrr).toBe(first.corpusMrr)
    expect(second.results.map((result) => result.discriminationRank)).toEqual(
      first.results.map((result) => result.discriminationRank)
    )
  })
})

describe("the lexical floor", () => {
  it("answers without error when the embedder is down, and says every probe was degraded", async () => {
    /**
     * Design §5's second scenario, half (a). Retrieval never ERRORS because Bedrock is down; it gets
     * narrower. A failure travelling through the error channel here would mean the floor does not
     * exist — a Bedrock outage would take the whole retrieval surface with it.
     */
    const report = await Effect.runPromise(
      withStack(
        (stack) => runFloor(stack.retrieval, stack.fixture.spec.probes).pipe(Effect.orDie),
        { embedder: failingEmbedder() }
      )
    )
    expect(report.probes).toBeGreaterThanOrEqual(30)
    expect(report.allDegraded).toBe(true)
  })

  it("still beats the controls on the probes that carry lexical signal", async () => {
    /**
     * Half (b), and it is deliberately a SUBSET claim rather than the full gate. A numeric-family
     * control differs from its target by one token, which the FTS arm cannot order — so demanding the
     * whole gate without vectors would be demanding that the vector arm be unnecessary. What the floor
     * must show is that lexical signal alone still discriminates a real share of the suite.
     */
    const report = await Effect.runPromise(
      withStack(
        (stack) => runFloor(stack.retrieval, stack.fixture.spec.probes).pipe(Effect.orDie),
        { embedder: failingEmbedder() }
      )
    )
    expect(report.lexicallyDiscriminated).toBeGreaterThan(0)
  })
})

describe("summarize", () => {
  it("refuses an empty suite rather than reporting a vacuous pass", () => {
    /**
     * "No probes ran" is the purest form of a skipped gate, and a mean over zero terms is 0 — which is
     * below any floor. A `passed: true` here would be a green report over no measurement at all.
     */
    const empty = summarize("fake", [])
    expect(empty.probes).toBe(0)
    expect(empty.passed).toBe(false)
    expect(empty.mrr).toBe(0)
  })

  it("fails on an inversion even when MRR clears the floor", () => {
    // The strict per-probe check is the gate; MRR is the aggregate. An aggregate alone can be bought
    // by thirty easy probes covering one broken one, which is exactly what this pins.
    const results = [
      {
        query: "a",
        targetPath: "a.html",
        targetRank: 5,
        discriminationRank: 2,
        controlRanks: [{ path: "c.html", family: "negation" as const, rank: 3 }],
        discriminated: false,
        reciprocalRank: 0.5,
        corpusReciprocalRank: 0.2,
        degraded: false
      },
      ...Array.from({ length: 20 }, (_, at) => ({
        query: `q${at}`,
        targetPath: `t${at}.html`,
        targetRank: 1,
        discriminationRank: 1,
        controlRanks: [{ path: `c${at}.html`, family: "numeric" as const, rank: 2 }],
        discriminated: true,
        reciprocalRank: 1,
        corpusReciprocalRank: 1,
        degraded: false
      }))
    ]
    const report = summarize("fake", results)
    expect(report.mrr).toBeGreaterThan(MRR_FLOOR)
    expect(report.inversions).toHaveLength(1)
    expect(report.passed).toBe(false)
  })

  it("fails when MRR misses the floor even with zero inversions", () => {
    // Both halves of the gate are required. A suite where every target barely beats its controls is
    // still a suite the floor is meant to refuse.
    const results = Array.from({ length: 10 }, (_, at) => ({
      query: `q${at}`,
      targetPath: `t${at}.html`,
      targetRank: 1,
      discriminationRank: 1,
      controlRanks: [],
      discriminated: true,
      reciprocalRank: 1,
      corpusReciprocalRank: 1,
      degraded: false
    }))
    expect(summarize("fake", results, 0.85).passed).toBe(true)
    expect(summarize("fake", results, 1.5).passed).toBe(false)
  })
})

describe("mode selection and the loud-skip rule", () => {
  it("runs fake mode with no credentials at all", async () => {
    // The mode CI measures. A pass here is a real pass, credentials or not.
    const outcome = await Effect.runPromise(runDiscrimination({ mode: "fake", env: {} }))
    expect(outcome.mode).toBe("fake")
    expect(outcome.skipped).toBe(false)
    expect(outcome.passed).toBe(true)
  })

  it("refuses live mode without credentials, reporting a FAILURE rather than a pass", async () => {
    /**
     * The plan's rule: a skipped quality gate must never look like a passing one. A caller asking for
     * live and getting a silent fake would be told the real vector space discriminates when nothing
     * measured it — so the outcome carries `skipped: true`, `passed: false`, zero probes, and a reason.
     */
    const outcome = await Effect.runPromise(runDiscrimination({ mode: "live", env: {} }))
    expect(outcome.requested).toBe("live")
    expect(outcome.skipped).toBe(true)
    expect(outcome.passed).toBe(false)
    expect(outcome.probes).toBe(0)
    expect(outcome.skipReason).toContain("AWS_BEARER_TOKEN_BEDROCK")
    expect(outcome.skipReason).toContain("did NOT run")
  })

  it("treats a blank token as absent", async () => {
    // An exported-but-empty variable authenticates nothing, so it must not count as credentials.
    const outcome = await Effect.runPromise(
      runDiscrimination({ mode: "live", env: { AWS_BEARER_TOKEN_BEDROCK: "   " } })
    )
    expect(outcome.skipped).toBe(true)
    expect(outcome.passed).toBe(false)
  })
})

describe("the pre-merge gate", () => {
  it("succeeds when the gate passes", async () => {
    const result = await Effect.runPromise(Effect.result(discriminationGate({ env: {} })))
    expect(Result.isSuccess(result)).toBe(true)
  })

  it("fails with a TAGGED error, so the envelope reaches ERR_DISCRIMINATION_FAILED", async () => {
    /**
     * The failure has to be tagged: the CLI's `codeFor` switches on `_tag`, and
     * `ERR_DISCRIMINATION_FAILED` — the one code design §8 named for exactly this refusal — would
     * otherwise have no producer and degrade to `ERR_UNKNOWN`. An impossible floor is the cheapest way
     * to drive a failure without breaking retrieval.
     */
    const result = await Effect.runPromise(
      Effect.result(discriminationGate({ env: {}, mrrFloor: 2 }))
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DiscriminationFailed)
      expect(result.failure._tag).toBe("DiscriminationFailed")
      expect(result.failure.reason).toContain("discrimination FAILED")
      // The outcome rides along, because a refusal an operator cannot reproduce is one they override.
      expect(result.failure.outcome.seed).toBeGreaterThan(0)
    }
  })

  it("fails when live mode was requested and skipped", async () => {
    // A cron whose gate silently skipped because a token expired is the failure this refuses to have.
    const result = await Effect.runPromise(
      Effect.result(discriminationGate({ mode: "live", env: {} }))
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toContain("did NOT run")
    }
  })
})

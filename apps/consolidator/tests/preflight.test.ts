import { Effect, Logger, Result } from "effect"
import { describe, expect, it } from "vitest"

import { makeConsolidator } from "../src/client.js"
import {
  ConsolidatorCredentialsMissing,
  credentialsMissingReason,
  hasConsolidatorCredentials,
  MAX_TRANSCRIPTS_PER_RUN
} from "../src/contract.js"

/**
 * The preflight tier. INV-3 groundwork: the CALLER must be able to skip rather than fail, which
 * requires knowing before any work happens that no call is possible.
 *
 * Every case passes an explicit env object rather than mutating `process.env`. The ambient
 * environment on this devbox HAS `AWS_BEARER_TOKEN_BEDROCK` set, so a test that read the real
 * environment would assert the opposite of what it does in CI — and would pass for the wrong
 * reason in one of the two places.
 */

const EMPTY: Record<string, string | undefined> = {}

describe("hasConsolidatorCredentials", () => {
  it("is false with nothing set", () => {
    expect(hasConsolidatorCredentials(EMPTY)).toBe(false)
  })

  /** The success criterion, stated as the packet asks: both cleared, expect false. */
  it("is false when AWS_BEARER_TOKEN_BEDROCK and AWS_ACCESS_KEY_ID are unset", () => {
    expect(
      hasConsolidatorCredentials({
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_REGION: "us-east-1"
      })
    ).toBe(false)
  })

  it("is true with a bearer token", () => {
    expect(hasConsolidatorCredentials({ AWS_BEARER_TOKEN_BEDROCK: "abc123" })).toBe(true)
  })

  it("is true with a complete sigv4 pair", () => {
    expect(
      hasConsolidatorCredentials({ AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "secret" })
    ).toBe(true)
  })

  it("is false with HALF a sigv4 pair", () => {
    expect(hasConsolidatorCredentials({ AWS_ACCESS_KEY_ID: "AKIA..." })).toBe(false)
    expect(hasConsolidatorCredentials({ AWS_SECRET_ACCESS_KEY: "secret" })).toBe(false)
  })

  /** A blank export is how a credential goes missing in practice; `""` authenticates nothing. */
  it("treats an empty or whitespace value as absent", () => {
    expect(hasConsolidatorCredentials({ AWS_BEARER_TOKEN_BEDROCK: "" })).toBe(false)
    expect(hasConsolidatorCredentials({ AWS_BEARER_TOKEN_BEDROCK: "   " })).toBe(false)
    expect(
      hasConsolidatorCredentials({ AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "  " })
    ).toBe(false)
  })

  /**
   * The provider has NO default AWS credential chain — env vars only, verified live in the probe.
   * So a profile that only the AWS CLI can see must NOT read as usable credentials, or the
   * preflight would wave through a run that cannot authenticate.
   */
  it("ignores AWS_PROFILE and AWS_REGION, which the provider does not read as credentials", () => {
    expect(hasConsolidatorCredentials({ AWS_PROFILE: "default", AWS_REGION: "us-east-1" })).toBe(
      false
    )
  })

  it("names both accepted mechanisms in its reason, so the message is actionable", () => {
    const reason = credentialsMissingReason()
    expect(reason).toContain("AWS_BEARER_TOKEN_BEDROCK")
    expect(reason).toContain("AWS_ACCESS_KEY_ID")
    expect(reason).toContain("AWS_SECRET_ACCESS_KEY")
  })
})

describe("consolidate() preflight ordering", () => {
  /**
   * The load-bearing test in this file. It proves the credential check happens BEFORE any file
   * read or process spawn — the INV-3 groundwork, since the whole point is that a caller with no
   * credentials pays nothing and can skip.
   *
   * Ordering is asserted from an OBSERVABLE, not from the failure tag. See the comment at the
   * assertion: the tag alone passes under either order.
   */
  it("fails with ConsolidatorCredentialsMissing before touching the filesystem or spawning", async () => {
    const consolidator = makeConsolidator({
      env: EMPTY,
      appRoot: "/nonexistent/app/root",
      traceRoot: "/nonexistent/trace/root"
    })

    /**
     * `partitionReachable` logs a warning naming any session it could not reach, so captured logs are
     * a direct record of whether the filesystem was consulted at all. (This observable used to be
     * `prepareTranscripts`'s "could not read"; the read path is gone and the mount probe replaced it,
     * so the ordering claim is now about the same boundary through a different message.)
     */
    const readAttempts: string[] = []
    const captureReads = Logger.make(({ message }: { message: unknown }) => {
      const rendered = Array.isArray(message) ? message.join(" ") : String(message)
      if (rendered.includes("cannot reach session")) readAttempts.push(rendered)
    })

    const result = await Effect.runPromise(
      Effect.result(
        consolidator.consolidate({
          transcripts: [{ sessionId: "session-a", filePath: "/nonexistent/session-a.jsonl" }]
        })
      ).pipe(Effect.provide(Logger.layer([captureReads])))
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ConsolidatorCredentialsMissing)
      expect(result.failure._tag).toBe("ConsolidatorCredentialsMissing")
      expect(result.failure.reason).toContain("AWS_BEARER_TOKEN_BEDROCK")
    }

    /**
     * The tag alone does NOT prove ordering, and this was found by breaking it: moving the
     * credential check to AFTER the reachability probe kept every assertion above passing, because
     * an unreachable transcript is skipped rather than fatal, so the run still reached the
     * credential check and still failed with the same tag.
     *
     * The observable that DOES distinguish the two orders is the warning the probe logs for a session
     * it could not reach. No warning means the filesystem was never consulted, which is the actual
     * claim: nothing was probed, mounted, or spawned before the credential check.
     */
    expect(readAttempts).toEqual([])
  })

  /**
   * An empty batch answers itself. Note the env here HAS credentials and the app root is still
   * bogus: if this spawned a server it would fail, so succeeding proves the short-circuit.
   */
  it("returns an empty result for an empty batch without spawning a server", async () => {
    const consolidator = makeConsolidator({
      env: { AWS_BEARER_TOKEN_BEDROCK: "test" },
      appRoot: "/nonexistent/app/root",
      traceRoot: "/nonexistent/trace/root"
    })
    const result = await Effect.runPromise(consolidator.consolidate({ transcripts: [] }))
    expect(result.candidates).toEqual([])
    expect(result.llmCalls).toBe(0)
    /**
     * And `analyzedSessionIds` is `[]` rather than absent. A caller watermarks from this field, so an
     * empty batch has to produce an empty set explicitly — the field is required precisely so there is
     * no shape in which a caller falls back to the batch.
     */
    expect(result.analyzedSessionIds).toEqual([])
  })
})

describe("the batch ceiling exists and is bounded", () => {
  it("caps transcripts per run", () => {
    expect(MAX_TRANSCRIPTS_PER_RUN).toBeGreaterThan(0)
    expect(MAX_TRANSCRIPTS_PER_RUN).toBeLessThanOrEqual(64)
  })
})

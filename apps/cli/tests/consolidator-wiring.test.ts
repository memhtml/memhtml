import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { ConsolidatorPortService, layerConsolidatorPort, Roots } from "../src/api-layer.js"

/**
 * The composition-root gate that decides whether trace consolidation runs at all.
 *
 * This is the only place the decision is made, and getting it wrong is not a small bug in either
 * direction. Bound when it should not be spawns an eve server and spends Opus tokens on a night an
 * operator turned the models off; unbound when it should not be makes the phase permanently report
 * `no consolidator bound` on a machine that has credentials, and an unattended run that never distills
 * anything looks exactly like one that found nothing worth distilling.
 *
 * ── Two environments, and why they are threaded rather than mutated ──────────────────────────────
 *
 * `MEMHTML_LLM` arrives through effect's `Config`, and the credential preflight reads a plain
 * `Record<string, string | undefined>`. Both are substituted here, from one call, and neither is set
 * by mutating `process.env` — because effect's default `ConfigProvider` SNAPSHOTS `process.env` at
 * MODULE LOAD.
 *
 * That was probed, not assumed (2026-08-08): setting `process.env.MEMHTML_LLM = "off"` after importing
 * `effect` leaves `Config.string("MEMHTML_LLM")` returning `"on"` forever, while setting it BEFORE the
 * import works and then cannot be changed back. A first attempt at this coverage mutated
 * `process.env` between cases and reported `MEMHTML_LLM=off` as BOUND — a false defect, caused entirely
 * by the probe reading a stale snapshot for one gate and a live object for the other. Re-probed with
 * the environment preset by a parent process, all eight cases were already correct.
 *
 * The lesson is the reason this file exists as a test rather than as a one-off script: a gate over
 * two different configuration mechanisms needs both injected from one place, or the test is
 * measuring a disagreement it introduced itself.
 */

/**
 * The roots the port now requires, as a fixed layer.
 *
 * `layerConsolidatorPort` reads `RootsShape.traceRoot` because the consolidator MOUNTS the trace root
 * read-only — that is how transcripts reach the agent rather than as a model message. Supplied as a
 * literal rather than through `layerRoots` on purpose: `layerRoots` resolves `MEMHTML_TRACE_ROOT` through
 * effect's `Config`, and this file's whole subject is the two gates over two different configuration
 * mechanisms, so pulling a third `Config` read into the graph would give the substituted
 * `ConfigProvider` a say in a value none of these cases vary.
 */
const ROOTS = Layer.succeed(Roots)({
  memhtmlRoot: "/nonexistent/memhtml-root",
  traceRoot: "/nonexistent/trace-root"
})

/** Resolve the port under an explicit `MEMHTML_LLM` and an explicit credential environment. */
const boundUnder = (input: {
  readonly config?: Record<string, string> | undefined
  readonly env?: Record<string, string | undefined> | undefined
}): Promise<boolean> =>
  Effect.runPromise(
    Effect.provideService(
      Effect.gen(function* () {
        const port = yield* ConsolidatorPortService
        return port.consolidator !== undefined
      }).pipe(Effect.provide(layerConsolidatorPort(input.env ?? {}).pipe(Layer.provide(ROOTS)))),
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: input.config ?? {} })
    ) as Effect.Effect<boolean, never, never>
  )

const BEARER = { AWS_BEARER_TOKEN_BEDROCK: "not-a-real-token" }
const SIGV4 = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" }

describe("layerConsolidatorPort", () => {
  it("binds nothing with no credentials, which is the CI shape", async () => {
    /**
     * The case that must hold forever: CI has no credentials, and the phase has to read as skipped.
     * A bound port here would make every CI run either spawn an agent or report a degradation, and
     * `pnpm check` would stop being a green signal.
     */
    expect(await boundUnder({})).toBe(false)
  })

  it("binds on a bearer token, and on the SigV4 pair", async () => {
    /**
     * Both mechanisms, because the provider accepts both and a gate that knew only one would silently
     * disable consolidation on half of the environments that could run it.
     */
    expect(await boundUnder({ env: BEARER })).toBe(true)
    expect(await boundUnder({ env: SIGV4 })).toBe(true)
  })

  it("refuses HALF the SigV4 pair rather than binding on an id alone", async () => {
    /**
     * An access key id with no secret authenticates nothing. Binding here would spawn a server and
     * fail at the first request, turning a misconfiguration into a degradation instead of a skip.
     */
    expect(await boundUnder({ env: { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" } })).toBe(false)
    expect(await boundUnder({ env: { AWS_SECRET_ACCESS_KEY: "secret" } })).toBe(false)
  })

  it("treats a blank credential as absent, because that is how one goes missing", async () => {
    // `export AWS_BEARER_TOKEN_BEDROCK=` is the real-world shape. It would authenticate nothing while
    // reading as present to any check that only asked whether the key exists.
    expect(await boundUnder({ env: { AWS_BEARER_TOKEN_BEDROCK: "" } })).toBe(false)
    expect(await boundUnder({ env: { AWS_BEARER_TOKEN_BEDROCK: "   " } })).toBe(false)
  })

  it("unbinds on MEMHTML_LLM=off EVEN WITH credentials, case-insensitively", async () => {
    /**
     * The explicit opt-out beats the credential check, and it covers the consolidator as well as the
     * three model phases — an operator who turned the models off did not mean "except the expensive
     * agent". Case-insensitive to match `layerModelPort` and `layerEmbedder`, which is what the
     * manifest documents.
     *
     * (Mutation: dropping the `MEMHTML_LLM` read binds under all three of these and fails the case.)
     */
    expect(await boundUnder({ config: { MEMHTML_LLM: "off" }, env: BEARER })).toBe(false)
    expect(await boundUnder({ config: { MEMHTML_LLM: "OFF" }, env: BEARER })).toBe(false)
    expect(await boundUnder({ config: { MEMHTML_LLM: " off " }, env: SIGV4 })).toBe(false)
  })

  it("binds under any other MEMHTML_LLM value, so only `off` is the opt-out", async () => {
    // The non-vacuity control for the case above: `off` is a specific value, not "anything set".
    expect(await boundUnder({ config: { MEMHTML_LLM: "on" }, env: BEARER })).toBe(true)
    expect(await boundUnder({ config: { MEMHTML_LLM: "true" }, env: BEARER })).toBe(true)
  })

  it("hands the SAME credential environment to the client it built", async () => {
    /**
     * The gate and the client must agree about which environment they are in. The client runs its OWN
     * preflight (`apps/consolidator/src/client.ts:457-461`), so a client built over ambient
     * `process.env` while the gate read an injected one would pass the gate and then fail at the first
     * call — the degradation-instead-of-skip outcome this whole file exists to prevent.
     *
     * ── Making the two environments DISAGREE is the whole difficulty ─────────────────────────────
     *
     * The gate and the client apply the SAME predicate to whatever env each was given, so credential
     * presence alone cannot tell them apart: an injected env rich enough to pass the gate also passes
     * the client's check, whichever env the client got. The FIRST version of this case asserted only
     * `port.consolidator` being defined and undefined — and it SURVIVED the mutation that swaps
     * `makeConsolidator({ env })` for `makeConsolidator()`, because this box happens to carry an
     * ambient `AWS_BEARER_TOKEN_BEDROCK` and the ambient client passed too. A vacuous lock, caught by
     * running the mutation.
     *
     * So the divergence is manufactured: the AMBIENT credentials are cleared for the duration, while
     * the INJECTED ones are present. `hasConsolidatorCredentials` reads its argument live (it is not a
     * `Config` snapshot), so an ambient-env client now refuses while an injected-env client proceeds —
     * and that difference is observable in the client's own behavior.
     *
     * The call is made with an EMPTY transcript list, which is what keeps this cheap and hermetic: the
     * client short-circuits an empty batch immediately after its preflight
     * (`apps/consolidator/src/client.ts:465`), so nothing is spawned, nothing is read, and the only
     * thing the outcome can be reporting is which environment the preflight saw.
     */
    const CREDENTIAL_VARS = [
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY"
    ] as const
    const saved = new Map(CREDENTIAL_VARS.map((name) => [name, process.env[name]]))
    for (const name of CREDENTIAL_VARS) delete process.env[name]

    try {
      // Sanity: the ambient environment really is credential-free now, or the divergence below is not
      // a divergence and this case would be vacuous again for a new reason.
      expect(CREDENTIAL_VARS.some((name) => process.env[name] !== undefined)).toBe(false)

      const port = await Effect.runPromise(
        Effect.provideService(
          Effect.gen(function* () {
            return yield* ConsolidatorPortService
          }).pipe(Effect.provide(layerConsolidatorPort(BEARER).pipe(Layer.provide(ROOTS)))),
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: {} })
        ) as Effect.Effect<
          {
            readonly consolidator:
              | {
                  readonly consolidate: (input: {
                    readonly transcripts: []
                  }) => Effect.Effect<{ readonly llmCalls: number }, { readonly _tag: string }>
                }
              | undefined
          },
          never,
          never
        >
      )
      // The gate passed on the injected credentials.
      expect(port.consolidator).toBeDefined()

      /**
       * And the CLIENT agrees, which is the assertion. Built over the injected env it gets past its own
       * preflight and answers the empty batch; built over the (now empty) ambient env it would fail
       * `ConsolidatorCredentialsMissing` here instead.
       */
      const outcome = await Effect.runPromise(
        Effect.result(port.consolidator?.consolidate({ transcripts: [] }) ?? Effect.void)
      )
      expect(outcome._tag, JSON.stringify(outcome)).toBe("Success")
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("builds the client over Roots.traceRoot, which is how transcripts reach the agent", async () => {
    /**
     * The mount root has to come from the SAME `Roots` service `memhtml trace index` scans with, or the
     * agent mounts a tree whose paths no `traces` row names — and the failure mode is quiet: every
     * transcript in every batch reads as unreachable, so the phase reports `consolidated: 0` forever
     * and an unattended run that never distills anything looks exactly like one that found nothing.
     *
     * ── The observable, and why the obvious one is vacuous ────────────────────────────────────────
     *
     * `makeConsolidator` exposes no getter for its root, so "which root did it get" is not directly
     * readable. What IS readable is a CONSEQUENCE of it: `consolidate` refuses a transcript that is not
     * under the mounted root, naming the root in the failure. So the injected root is set to a
     * recognizable path and a transcript is handed over from a DIFFERENT one — the failure message then
     * names whichever root the client was actually built with.
     *
     * A presence-only assertion (the port is defined) would survive a port that ignored `Roots` and
     * defaulted its root, which is exactly the vacuous shape the case above this one was rewritten to
     * escape. The failure TEXT is the discriminating observable.
     *
     * (Mutation: replacing `roots.traceRoot` with a literal in `layerConsolidatorPort` fails this case,
     * because the message then names that literal instead of the injected marker path.)
     */
    const MARKER_ROOT = "/nonexistent/marker-trace-root"
    const port = await Effect.runPromise(
      Effect.provideService(
        Effect.gen(function* () {
          return yield* ConsolidatorPortService
        }).pipe(
          Effect.provide(
            layerConsolidatorPort(BEARER).pipe(
              Layer.provide(
                Layer.succeed(Roots)({
                  memhtmlRoot: "/nonexistent/memhtml-root",
                  traceRoot: MARKER_ROOT
                })
              )
            )
          )
        ),
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: {} })
      ) as Effect.Effect<
        {
          readonly consolidator:
            | {
                readonly consolidate: (input: {
                  readonly transcripts: ReadonlyArray<{
                    readonly sessionId: string
                    readonly filePath: string
                  }>
                }) => Effect.Effect<unknown, { readonly _tag: string; readonly reason: string }>
              }
            | undefined
        },
        never,
        never
      >
    )
    expect(port.consolidator).toBeDefined()

    const outcome = await Effect.runPromise(
      Effect.result(
        port.consolidator?.consolidate({
          transcripts: [{ sessionId: "s1", filePath: "/somewhere/else/s1.jsonl" }]
        }) ?? Effect.void
      )
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag === "Failure") {
      expect(outcome.failure._tag).toBe("ConsolidatorUnavailable")
      // The INJECTED root, named back — which it can only be if the client was built with it.
      expect(outcome.failure.reason).toContain(MARKER_ROOT)
    }
  })
})

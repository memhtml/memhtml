import { Effect } from "effect"

import {
  type DiscriminationReport,
  describeFailure,
  discriminate,
  type EvalMode,
  MRR_FLOOR
} from "./discriminate.js"
import { type EvalEmbedder, fakeEmbedder, liveEmbedder, withStack } from "./harness.js"

/**
 * `memhtml eval discriminate`'s own body: pick a mode, build the stack, run the probes, report.
 *
 * **A skipped quality gate must never look like a passing one.** That is the plan's rule and it is
 * what shapes this module. Three distinct outcomes, and no two of them are reported the same way:
 *
 * 1. `fake` mode — the deterministic embedder. Runs everywhere, credentials or not, and the numbers
 *    are reproducible. This is what `pnpm check` measures, and a pass here is a real pass.
 * 2. `live` mode with credentials — the same probes against Bedrock's vector space.
 * 3. `live` mode WITHOUT credentials — `mode: "live"`, `requested: "live"`, `skipped: true`, a LOUD
 *    stderr line, and `passed: false`. Never a green report: a caller asking for live and getting a
 *    silent fake would be told the real vector space discriminates when nothing measured it.
 *
 * The environment variable is read here rather than through `effect/Config` on purpose:
 * `AWS_BEARER_TOKEN_BEDROCK` is consumed by the AWS SDK itself, so this is a PRESENCE probe on a
 * variable this code never passes anywhere — declaring it as config would imply this module supplies
 * it to the client, which it does not.
 */

/** The variable whose presence decides whether live mode can run. */
export const BEDROCK_TOKEN_VAR = "AWS_BEARER_TOKEN_BEDROCK"

/** What `memhtml eval discriminate` emits: the report plus which mode was asked for. */
export interface EvalOutcome extends DiscriminationReport {
  /** The mode the caller asked for, which differs from `mode` only on a refused live run. */
  readonly requested: EvalMode
  /**
   * True when live mode was requested with no credentials present. A skipped run is `passed: false`
   * and carries zero probes — it is a refusal, not a result.
   */
  readonly skipped: boolean
  /** Why it was skipped, absent otherwise. */
  readonly skipReason?: string | undefined
  /** The seed the corpus was generated at, so a failing run is reproducible. */
  readonly seed: number
  readonly corpusSize: number
}

/** True when the rotated Bedrock bearer token is present in the environment. */
export const hasBedrockCredentials = (
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean => {
  const token = env[BEDROCK_TOKEN_VAR]
  return token !== undefined && token.trim() !== ""
}

/** What {@link runDiscrimination} takes. */
export interface EvalOptions {
  /** `fake` by default: the mode that works in CI and whose numbers are reproducible. */
  readonly mode?: EvalMode | undefined
  readonly seed?: number | undefined
  readonly size?: number | undefined
  readonly probes?: number | undefined
  readonly mrrFloor?: number | undefined
  /** Injected for tests, so the credential branch is drivable without touching the environment. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

/**
 * Run the gate.
 *
 * Never fails: the report IS the answer, and a caller maps `passed` to an exit code. An eval whose
 * error channel could fire would hand a caller a run that both happened and errored, with no way to
 * say whether the corpus, the index, or the ranking was at fault.
 */
export const runDiscrimination = (
  options: EvalOptions = {}
): Effect.Effect<EvalOutcome, never, never> =>
  Effect.gen(function* () {
    const requested = options.mode ?? "fake"
    const mrrFloor = options.mrrFloor ?? MRR_FLOOR
    const seed = options.seed ?? 20_260_802

    if (requested === "live" && !hasBedrockCredentials(options.env)) {
      const reason =
        `${BEDROCK_TOKEN_VAR} is absent, so live-mode discrimination did NOT run. ` +
        "This is a SKIPPED quality gate, reported as a failure on purpose — re-run with " +
        "credentials, or run the deterministic `fake` mode, which is the one CI measures."
      /**
       * `logError`, not `logWarning`, and the text says "did NOT run". The failure mode this guards
       * against is a green pipeline over an unmeasured gate, and a warning is the level operators
       * filter out.
       */
      yield* Effect.logError(`eval discriminate: ${reason}`)
      return {
        mode: "live" as const,
        requested,
        skipped: true,
        skipReason: reason,
        probes: 0,
        discriminated: 0,
        inversions: [],
        mrr: 0,
        corpusMrr: 0,
        mrrFloor,
        passed: false,
        degradedProbes: 0,
        results: [],
        seed,
        corpusSize: 0
      }
    }

    const embedder: EvalEmbedder = requested === "live" ? yield* liveEmbedder() : fakeEmbedder()

    return yield* withStack(
      (stack) =>
        Effect.gen(function* () {
          const report = yield* discriminate(stack.retrieval, stack.fixture.spec.probes, {
            mode: requested,
            mrrFloor
          }).pipe(Effect.orDie)

          if (!report.passed)
            yield* Effect.logError(`eval discriminate: ${describeFailure(report)}`)

          return {
            ...report,
            requested,
            skipped: false,
            seed: stack.fixture.spec.seed,
            corpusSize: stack.indexed
          }
        }),
      {
        embedder,
        seed,
        ...(options.size === undefined ? {} : { size: options.size }),
        ...(options.probes === undefined ? {} : { probes: options.probes })
      }
    )
  })

/**
 * A failed gate, as a tagged error.
 *
 * Tagged so it is a failure like every other in the system rather than a bare value: the CLI's
 * `codeFor` switches on `_tag`, and `ERR_DISCRIMINATION_FAILED` — the one error code design §8 named
 * for exactly this refusal — would otherwise have no producer at all and degrade to `ERR_UNKNOWN`.
 *
 * The whole outcome rides along, because a refusal an operator cannot reproduce is a refusal they will
 * override: `seed` is what regenerates the corpus that failed, and `inversions` says which probes.
 */
export class DiscriminationFailed {
  readonly _tag = "DiscriminationFailed"
  constructor(readonly outcome: EvalOutcome) {}
  /** The one-line summary, for the envelope's human message. */
  get reason(): string {
    return this.outcome.skipped
      ? (this.outcome.skipReason ?? "the gate did not run")
      : describeFailure(this.outcome)
  }
}

/**
 * The gate, for `MergeOptions.preMergeGate`.
 *
 * A failing gate FAILS this effect, which is what `@memhtml/sleep`'s `merge` reads to refuse: it wraps the
 * gate in `Effect.result` and turns a failure into `refusal: "gate-failed"` with `main` never moving.
 * So the shape is not cosmetic — a version returning a boolean would let a caller forget to check it,
 * and the one thing a refusable gate must not be is optional at its call site.
 */
export const discriminationGate = (
  options: EvalOptions = {}
): Effect.Effect<EvalOutcome, DiscriminationFailed, never> =>
  runDiscrimination(options).pipe(
    Effect.flatMap((outcome) =>
      outcome.passed ? Effect.succeed(outcome) : Effect.fail(new DiscriminationFailed(outcome))
    )
  )

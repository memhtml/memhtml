import { Context, Effect, Layer } from "effect"

import type { MergeReport, ReviewReport, RunReport } from "./contract.js"
import type { SleepDeps } from "./env.js"
import type { SleepPlan } from "./plan.js"
import { plan } from "./plan.js"
import type { MergeOptions } from "./review.js"
import { merge, review } from "./review.js"
import { type RunOptions, resume, run } from "./run.js"

/**
 * The sleep service: the five operations the CLI and MCP surfaces call.
 *
 * Every method's error channel is `never`. A sleep run's failures are its own DATA, and a failed phase
 * is a normal terminal state with a row and a report line. A run whose error channel could fire would
 * hand a caller a run that both happened and errored, with no way to say which phases landed. The two
 * refusals `merge` can make are likewise values on `MergeReport`, so a caller reads the reason instead
 * of catching an error.
 */
export interface SleepShape {
  readonly run: (options: RunOptions) => Effect.Effect<RunReport>
  readonly resume: (
    runId: string,
    options?: { readonly date?: string | undefined }
  ) => Effect.Effect<RunReport>
  readonly review: (runId?: string) => Effect.Effect<ReviewReport>
  readonly merge: (runId: string | undefined, options?: MergeOptions) => Effect.Effect<MergeReport>
  /**
   * What a run WOULD find, from index counts alone, running no phase.
   *
   * `atMillis` is a parameter for the same reason every phase's instant is: the settled-transcript
   * cutoff is derived from it, so a test pins a date rather than racing a clock. It is the only clock
   * reading anywhere near sleep that is not a stamp, and it is the CALLER's.
   *
   * The tree's `HEAD` is resolved HERE rather than by the caller, because a plan whose freshness the
   * caller supplied could be handed a commit from a different repository than the database it reads.
   * This service already holds both ports.
   */
  readonly plan: (atMillis: number) => Effect.Effect<SleepPlan>
}

export const Sleep = Context.Service<SleepShape>("memhtml/Sleep")

/** The service over supplied dependencies. Nothing is constructed here; every port is the caller's. */
export const makeSleep = (deps: SleepDeps): SleepShape => ({
  run: (options) => run(deps, options),
  resume: (runId, options = {}) => resume(deps, runId, options),
  review: (runId) => review(deps, runId),
  merge: (runId, options = {}) => merge(deps, runId, options),
  plan: (atMillis) =>
    Effect.gen(function* () {
      /*
       * An unresolvable `HEAD` reads as null, which is never fresh, so a git failure makes the plan
       * cautious instead of denying the answer — the same policy every count in it follows.
       */
      const headSha = yield* deps.git.revParseHead().pipe(Effect.orElseSucceed(() => null))
      return yield* plan(deps.db, atMillis, headSha)
    })
})

/**
 * A layer over already-built dependencies.
 *
 * There is deliberately no `SleepLive` that resolves its own git, database, and model. The composition
 * root is the CLI, which builds one `AppLive` bottom-up and hands the same services to sleep, to the
 * indexer, and to retrieval. A layer here that built its own would open a second database connection to
 * the same file and a second git wrapper on the same root.
 */
export const layerSleep = (deps: SleepDeps): Layer.Layer<SleepShape> =>
  Layer.succeed(Sleep)(makeSleep(deps))

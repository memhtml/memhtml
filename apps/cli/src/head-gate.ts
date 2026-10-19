import type { InvalidMemory, StorageFailure } from "@memhtml/contracts/errors"
import type { DiscriminationFailed, EvalOutcome } from "@memhtml/eval"
import { gateHeads, HeadGateFailed, type HeadGateOptions, type HeadGateReport } from "@memhtml/head"
import type { GitFailure } from "@memhtml/store"
import { Effect } from "effect"

import type { LoadedHead } from "./v2.js"

/**
 * The gate `curate merge` runs by default: the head gate (`@memhtml/head` `gateHeads`) over the two
 * versions the landing moves between, the target's tip and the curator branch's tip.
 *
 * The eval package's discrimination gate measures the v1 ranking stack against its own generated
 * fixture corpus, so at a merge it would answer the same numbers whatever the branch held: a gate
 * over the wrong subject. This one loads the version at `from` and the version at `to` (each from a
 * snapshot when one applies, see `head-cache.ts`), samples probes from the records active in both,
 * and refuses the landing when the landed version finds them worse than the base did. Deterministic
 * and credential-free, so a merge never waits on a network call.
 *
 * The loader is a parameter rather than an import so this module does not import `v2.ts` at run
 * time while `v2.ts` imports it; the type of the loaded head is all it needs from there.
 */

/** What a gate injected into `curateMerge` may answer: the eval report shape or the head gate's. */
export type GateOutcome = EvalOutcome | HeadGateReport

/** What a gate injected into `curateMerge` may fail with; both map to `ERR_DISCRIMINATION_FAILED`. */
export type GateFailure = DiscriminationFailed | HeadGateFailed

/** What `curate merge` reports about the gate it ran, or did not. */
export interface GateReport {
  /** False under `--skip-gate`; then `passed` is `null` and there is no `mrr`. */
  readonly ran: boolean
  /** True when it ran (a failing gate fails the command instead), `null` when it did not. */
  readonly passed: boolean | null
  /** `head` for the default gate; `fake` or `live` when an eval-package gate was injected. */
  readonly mode?: GateOutcome["mode"]
  readonly mrr?: number
  /** Head gate only: the same probes scored at the base version. */
  readonly mrrBefore?: number
  /** The MRR the landed version had to reach: the eval gate's fixed floor, or the head gate's. */
  readonly mrrFloor?: number
  /** Head gate only: `mrrBefore` minus the tolerance, the same number as `mrrFloor`. */
  readonly floor?: number
  readonly probes?: number
  readonly inversions?: number
  /** Head gate only: inversions at the base version; the landed count may not exceed it. */
  readonly inversionsBefore?: number
  /** Head gate only: the two commits it compared. */
  readonly base?: string | null
  readonly landed?: string | null
}

export const isHeadGateReport = (outcome: GateOutcome): outcome is HeadGateReport =>
  outcome.mode === "head"

/** The payload's view of a gate that ran and passed. */
export const gateReportOf = (outcome: GateOutcome): GateReport =>
  isHeadGateReport(outcome)
    ? {
        ran: true,
        passed: outcome.passed,
        mode: outcome.mode,
        mrr: outcome.mrr,
        mrrBefore: outcome.mrrBefore,
        mrrFloor: outcome.floor,
        floor: outcome.floor,
        probes: outcome.probes,
        inversions: outcome.inversions.length,
        inversionsBefore: outcome.inversionsBefore,
        base: outcome.base,
        landed: outcome.landed
      }
    : {
        ran: true,
        passed: outcome.passed,
        mode: outcome.mode,
        mrr: outcome.mrr,
        mrrFloor: outcome.mrrFloor,
        probes: outcome.probes,
        inversions: outcome.inversions.length
      }

export type HeadLoader = (
  root: string,
  sha: string
) => Effect.Effect<LoadedHead, GitFailure | InvalidMemory | StorageFailure>

/**
 * Load both versions and run the head gate. A failing report FAILS the effect with `HeadGateFailed`
 * carrying the whole report, which is what `curateMerge` reads to refuse; a passing one is returned.
 */
export const headGate = (input: {
  readonly root: string
  readonly from: string
  readonly to: string
  readonly load: HeadLoader
  readonly options?: HeadGateOptions | undefined
}): Effect.Effect<HeadGateReport, HeadGateFailed | GitFailure | InvalidMemory | StorageFailure> =>
  Effect.gen(function* () {
    const base = yield* input.load(input.root, input.from)
    const landed = yield* input.load(input.root, input.to)
    const report = gateHeads(base.view, landed.view, input.options ?? {})
    if (!report.passed) {
      yield* Effect.logError(`curate merge: ${new HeadGateFailed(report).reason}`)
      return yield* Effect.fail(new HeadGateFailed(report))
    }
    return report
  }).pipe(Effect.withSpan("head.gate"))
